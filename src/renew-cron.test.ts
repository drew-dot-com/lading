import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notification, readLastRun, renewDue, renewalsRow, runOk, writeLastRun, type Renewer, type RenewRunReport } from './renew-cron.ts';
import type { RenewalRow } from './renewals.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 9);

function row(p: Partial<RenewalRow> & { handle: string; daysLeft: number }): RenewalRow {
  return { sha256: 'ab'.repeat(32), part: -1, parts: 1, blobId: 'blob', provider: p.handle.startsWith('0x') ? 'native' : 'lighthouse', lighthouseId: '', size: 1, expiresAt: NOW + p.daysLeft * DAY, renewals: 0, name: 'l-abababababab_x', ...p };
}

/** A payer with three records: one due, one comfortably out, one undated until the live pass. */
function payer(o: { live?: 'ok' | 'throw'; renew?: (ref: string) => Promise<Awaited<ReturnType<Renewer['renew']>>> } = {}) {
  const calls: Array<{ what: string; ref?: string; live?: boolean; epochs?: number }> = [];
  const rows = [row({ handle: '0x' + '1'.repeat(64), daysLeft: 12 }), row({ handle: '11111111-2222-3333-4444-555555555555', daysLeft: 300 }), row({ handle: '0x' + '2'.repeat(64), daysLeft: Number.NaN, expiresAt: 0 })];
  const r: Renewer = {
    async renewals(q) {
      calls.push({ what: 'renewals', live: q.live });
      if (q.live && o.live === 'throw') throw new Error('lighthouse renew price for x: 500');
      const dated = q.live ? rows.map((x) => (Number.isNaN(x.daysLeft) ? { ...x, daysLeft: 20, expiresAt: NOW + 20 * DAY } : x)) : rows;
      const within = q.within ?? 60;
      return { rows: dated, due: dated.filter((x) => !Number.isNaN(x.daysLeft) && x.daysLeft <= within), within };
    },
    async renew(ref, q) {
      calls.push({ what: 'renew', ref, epochs: q?.epochs });
      if (o.renew) return o.renew(ref);
      return { rows: [{ handle: ref, expiresAt: NOW + 376 * DAY, endEpoch: 91, digest: 'D' + ref.slice(2, 8) }], bought: 1, total: 41_000n };
    },
  };
  return { r, calls };
}

test('a run dates every record live, renews what is due through renew, and reports the soonest record after', async () => {
  const { r, calls } = payer();
  const lines: string[] = [];
  const rep = await renewDue(r, { within: 30, log: (l) => lines.push(l), now: () => NOW });
  assert.deepEqual(calls.filter((c) => c.what === 'renew').map((c) => c.ref), ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)]);
  assert.equal(calls[0].live, true);
  assert.equal(rep.records, 3);
  assert.equal(rep.dated, 3);
  assert.equal(rep.due, 2);
  assert.equal(rep.bought.length, 2);
  assert.equal(rep.bought[0].tx, 'D111111');
  assert.equal(rep.total, '82000');
  assert.deepEqual(rep.skipped, []);
  assert.deepEqual(rep.failed, []);
  // The Lighthouse record at 300 days is now the soonest.
  assert.equal(rep.soonestDays, 300);
  assert.equal(rep.soonestHandle, '11111111-2222-3333-4444-555555555555');
  assert.ok(runOk(rep));
  assert.ok(lines.some((l) => l.includes('2 due within 30 days')));
  // the live pass dated the undated record and the purchases moved two dates
  assert.equal(Object.keys(rep.dates ?? {}).length, 3);
  assert.deepEqual(rep.dates?.['0x' + '2'.repeat(64)], { expiresAt: NOW + 376 * DAY, endEpoch: 91 });
  assert.deepEqual(rep.dates?.['11111111-2222-3333-4444-555555555555'], { expiresAt: NOW + 300 * DAY });
});

test('epochs pass through to every native renewal', async () => {
  const { r, calls } = payer();
  await renewDue(r, { within: 30, epochs: 4, now: () => NOW });
  assert.deepEqual(calls.filter((c) => c.what === 'renew').map((c) => c.epochs), [4, 4]);
});

test('paid calls go through the caller\'s serializer', async () => {
  const { r } = payer();
  let wrapped = 0;
  await renewDue(r, { within: 30, now: () => NOW, run: (fn) => (wrapped++, fn()) });
  // the live listing (it pays quote doors) and two renewals
  assert.equal(wrapped, 3);
});

test('a skipped quote and a thrown renewal are reported, not thrown, and the run goes on', async () => {
  const { r } = payer({
    renew: async (ref) => {
      if (ref.startsWith('0x1')) return { rows: [{ handle: ref, skipped: 'WAL float short: 0.1 < 0.135' }], bought: 0, total: 1_000n };
      throw new Error('edge refused the claim');
    },
  });
  const rep = await renewDue(r, { within: 30, now: () => NOW });
  assert.equal(rep.bought.length, 0);
  assert.deepEqual(rep.skipped.map((s) => s.reason), ['WAL float short: 0.1 < 0.135']);
  assert.deepEqual(rep.failed.map((f) => f.error), ['edge refused the claim']);
  assert.equal(rep.total, '1000');
  assert.equal(rep.soonestDays, 12);
  assert.ok(!runOk(rep));
});

test('when the live pass fails the run uses the saved dates and says so', async () => {
  const { r, calls } = payer({ live: 'throw' });
  const rep = await renewDue(r, { within: 30, now: () => NOW });
  assert.deepEqual(calls.map((c) => c.what), ['renewals', 'renewals', 'renew']);
  assert.equal(calls[1].live, false);
  assert.match(rep.liveFailed ?? '', /500/);
  // the undated record stays undated and is not due
  assert.equal(rep.dated, 2);
  assert.equal(rep.due, 1);
  assert.equal(rep.bought.length, 1);
  assert.ok(!runOk(rep));
});

test('a record bought short by choice is left alone; once renewed by hand it is kept like any other', async () => {
  const calls: string[] = [];
  const rows = [row({ handle: '0x' + 'a'.repeat(64), daysLeft: 10, chosenDays: 28 }), row({ handle: '0x' + 'b'.repeat(64), daysLeft: 10, chosenDays: 28, renewals: 1 }), row({ handle: '0x' + 'c'.repeat(64), daysLeft: 10, chosenDays: 364 })];
  const r: Renewer = {
    async renewals(q) {
      return { rows, due: rows.filter((x) => x.daysLeft <= (q.within ?? 60)), within: q.within ?? 60 };
    },
    async renew(ref) {
      calls.push(ref);
      return { rows: [{ handle: ref, expiresAt: NOW + 374 * DAY, endEpoch: 70 }], bought: 1, total: 41_000n };
    },
  };
  const rep = await renewDue(r, { within: 30, now: () => NOW });
  assert.deepEqual(calls, ['0x' + 'b'.repeat(64), '0x' + 'c'.repeat(64)]);
  assert.deepEqual(rep.leftShort, [{ handle: '0x' + 'a'.repeat(64), label: 'abababababab native', chosenDays: 28 }]);
  assert.equal(rep.bought.length, 2);
  assert.ok(runOk(rep));
  // the short record does not set the soonest date: the two renewed ones do
  assert.equal(rep.soonestDays, 374);
  assert.equal(notification(rep)?.priority, 'low');
});

test('nothing due is a quiet run', async () => {
  const { r, calls } = payer();
  const rep = await renewDue(r, { within: 5, now: () => NOW });
  assert.equal(rep.due, 0);
  assert.equal(calls.filter((c) => c.what === 'renew').length, 0);
  assert.equal(rep.soonestDays, 12);
  assert.equal(notification(rep), null);
});

test('the float row: ok only when the last run left nothing due; balance is the soonest record\'s days', async () => {
  const opts = { within: 30, everyMs: 24 * 3_600_000, home: '/data/gate' };
  const fresh = renewalsRow(undefined, opts);
  assert.equal(fresh.name, 'renewals');
  assert.equal(fresh.ok, true);
  assert.equal(fresh.balance, '?');
  const { r } = payer();
  const good = renewalsRow(await renewDue(r, { within: 30, now: () => NOW }), opts);
  assert.equal(good.ok, true);
  assert.equal(good.balance, '300');
  assert.equal(good.low, '30');
  assert.equal(good.extra?.bought, 2);
  assert.match(good.fund, /nothing due/);
  const { r: broken } = payer({ renew: async () => { throw new Error('boom'); } });
  const bad = renewalsRow(await renewDue(broken, { within: 30, now: () => NOW }), opts);
  assert.equal(bad.ok, false);
  assert.equal(bad.balance, '12');
  assert.match(bad.fund, /failed: boom/);
  assert.match(bad.fund, /lading renew <handle>/);
});

test('the notification: low priority when records were bought, high when a human is needed', async () => {
  const { r } = payer();
  const n = notification(await renewDue(r, { within: 30, now: () => NOW }));
  assert.ok(n);
  assert.equal(n.priority, 'low');
  assert.match(n.title, /renewed 2 records/);
  assert.match(n.body, /-> 2027-09-20/);
  assert.match(n.body, /paid 82000 units/);
  const { r: broken } = payer({ renew: async () => ({ rows: [{ handle: 'x', skipped: 'not owned' }], bought: 0, total: 0n }) });
  const m = notification(await renewDue(broken, { within: 30, now: () => NOW }));
  assert.ok(m);
  assert.equal(m.priority, 'high');
  assert.match(m.title, /need a look \(0 failed, 2 skipped\)/);
  assert.match(m.body, /NOT DELIVERABLE .* not owned/);
});

test('the last run survives on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lading-cron-'));
  try {
    const p = join(dir, 'gate', 'renew-cron.json');
    assert.equal(readLastRun(p), undefined);
    const rep: RenewRunReport = { at: NOW, ms: 5, within: 30, records: 1, dated: 1, due: 0, bought: [], skipped: [], failed: [], total: '0', soonestDays: 100 };
    writeLastRun(p, rep);
    assert.deepEqual(readLastRun(p), rep);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
