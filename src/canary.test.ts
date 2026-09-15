import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_BYTES, canaryBytes, canaryNotification, canaryRow, readLastCanary, runCanary, writeLastCanary, type CanaryLading, type CanaryReport } from './canary.ts';

const NOW = Date.UTC(2026, 8, 15, 12);
const HOUR = 3_600_000;

/** A lib that records what it was asked and answers as told. */
function lib(o: { put?: 'ok' | 'throw' | 'reused' | 'nomanifest'; verify?: 'ok' | 'fail' | 'throw' } = {}) {
  const calls: Array<{ what: string; bytes?: Uint8Array; opts?: unknown; ref?: string }> = [];
  let n = 0;
  const l: CanaryLading = {
    async put(bytes, opts) {
      calls.push({ what: 'put', bytes, opts });
      n += 1;
      if (o.put === 'throw') throw new Error('edge refused: F02');
      const sha = 'ab'.repeat(32);
      if (o.put === 'reused') return { sha256: sha, size: bytes.length, legs: [{ network: 'arweave', id: 'TX' }], manifestTxId: 'MANIFEST-old', total: 3000n, reused: true };
      if (o.put === 'nomanifest') return { sha256: sha, size: bytes.length, legs: [], total: 0n };
      return { sha256: sha, size: bytes.length, legs: [{ network: 'arweave', id: `TX${n}` }], manifestTxId: `MANIFEST${n}`, total: 3120n };
    },
    async verify(ref) {
      calls.push({ what: 'verify', ref });
      if (o.verify === 'throw') throw new Error('every gateway 404');
      if (o.verify === 'fail') return { ok: false, rows: [{ label: 'arweave', ok: false, detail: 'sha mismatch' }] };
      return { ok: true, rows: [{ label: 'arweave', ok: true }] };
    },
  };
  return { l, calls };
}

test('the object is new bytes every run, at least MIN_BYTES, and says what it is', () => {
  const a = canaryBytes({ at: NOW, seq: 1, gate: 'https://g', networks: ['arweave'] });
  const b = canaryBytes({ at: NOW, seq: 2, gate: 'https://g', networks: ['arweave'] });
  assert.ok(a.length >= MIN_BYTES);
  assert.notDeepEqual(a, b);
  const parsed = JSON.parse(new TextDecoder().decode(a)) as Record<string, unknown>;
  assert.equal(parsed.lading, 'canary');
  assert.equal(parsed.seq, 1);
  assert.equal(parsed.gate, 'https://g');
  assert.equal(parsed.at, new Date(NOW).toISOString());
});

test('a first run puts through the serializer with the chosen networks skipped out and no name, and reads nothing back', async () => {
  const { l, calls } = lib();
  let serialized = 0;
  const lines: string[] = [];
  const r = await runCanary(l, { seq: 1, networks: ['arweave'], gate: 'https://g', log: (x) => lines.push(x), run: async (fn) => (serialized += 1, fn()), now: () => NOW });
  assert.equal(serialized, 1);
  assert.equal(calls.length, 1);
  const opts = calls[0].opts as { name: string; skip: Record<string, boolean>; via: { door: string } };
  assert.equal(opts.name, 'canary-1.json');
  assert.deepEqual(opts.skip, { walrus: true, filecoin: true, ipfs: true, page: true, name: true });
  assert.equal(opts.via.door, 'canary');
  assert.equal(r.ok, true);
  assert.equal(r.put?.manifestTxId, 'MANIFEST1');
  assert.equal(r.put?.units, '3120');
  assert.equal(r.readBack, undefined);
  assert.equal(r.error, undefined);
  assert.match(lines[0], /canary #1: put abababababab \d+ B on arweave manifest=MANIFEST1 paid=3120/);
});

test('a later run reads the previous manifest back before it puts', async () => {
  const { l, calls } = lib();
  const previous: CanaryReport = { at: NOW - HOUR, ms: 1, seq: 1, networks: ['arweave'], ok: true, put: { sha256: 'x', size: 1, legs: ['arweave'], manifestTxId: 'MANIFEST-prev', units: '1', ms: 1 } };
  const r = await runCanary(l, { seq: 2, networks: ['arweave'], gate: 'https://g', previous, now: () => NOW });
  assert.deepEqual(calls.map((c) => c.what), ['verify', 'put']);
  assert.equal(calls[0].ref, 'MANIFEST-prev');
  assert.equal(r.readBack?.ok, true);
  assert.equal(r.ok, true);
});

test('a put that throws is a failed report with the error, never a throw', async () => {
  const { l } = lib({ put: 'throw' });
  const r = await runCanary(l, { seq: 3, networks: ['arweave'], gate: 'https://g', now: () => NOW });
  assert.equal(r.ok, false);
  assert.equal(r.put, undefined);
  assert.match(r.error!, /edge refused/);
});

test('a put answered from a saved record, or without a manifest, is not ok', async () => {
  const reused = await runCanary(lib({ put: 'reused' }).l, { seq: 4, networks: ['arweave'], gate: 'https://g', now: () => NOW });
  assert.equal(reused.ok, false);
  assert.equal(reused.put?.units, '0');
  assert.match(reused.error!, /not new/);
  const none = await runCanary(lib({ put: 'nomanifest' }).l, { seq: 5, networks: ['arweave'], gate: 'https://g', now: () => NOW });
  assert.equal(none.ok, false);
  assert.match(none.error!, /without a manifest/);
});

test('a previous run that does not read back fails the run even when the put went through', async () => {
  const previous: CanaryReport = { at: NOW - HOUR, ms: 1, seq: 1, networks: ['arweave'], ok: true, put: { sha256: 'x', size: 1, legs: ['arweave'], manifestTxId: 'M', units: '1', ms: 1 } };
  const failed = await runCanary(lib({ verify: 'fail' }).l, { seq: 2, networks: ['arweave'], gate: 'https://g', previous, now: () => NOW });
  assert.equal(failed.ok, false);
  assert.equal(failed.put?.manifestTxId, 'MANIFEST1');
  assert.deepEqual(failed.readBack?.failed, ['arweave: sha mismatch']);
  assert.match(failed.error!, /did not read back/);
  const threw = await runCanary(lib({ verify: 'throw' }).l, { seq: 2, networks: ['arweave'], gate: 'https://g', previous, now: () => NOW });
  assert.equal(threw.ok, false);
  assert.match(threw.readBack?.error!, /404/);
});

test('the float row: pending before a run, ok after a good one, not ok after a failure or when the timer went quiet', () => {
  const o = { everyMs: HOUR, networks: ['arweave'] as const, home: '/data/gate' };
  assert.equal(canaryRow(undefined, { ...o, networks: ['arweave'] }).ok, true);
  const good: CanaryReport = { at: NOW - 10 * 60_000, ms: 5, seq: 7, networks: ['arweave'], ok: true, put: { sha256: 'x', size: 1, legs: ['arweave'], manifestTxId: 'M', units: '3120', ms: 4 } };
  const row = canaryRow(good, { ...o, networks: ['arweave'], now: NOW });
  assert.equal(row.ok, true);
  assert.equal(row.balance, '1');
  assert.equal(row.name, 'canary');
  assert.match(row.fund, /next in 50 min/);
  assert.equal(row.extra?.paidUnits, '3120');
  const bad = canaryRow({ ...good, ok: false, error: 'edge refused' }, { ...o, networks: ['arweave'], now: NOW });
  assert.equal(bad.ok, false);
  assert.match(bad.fund, /edge refused/);
  const quiet = canaryRow(good, { ...o, networks: ['arweave'], now: NOW + 3 * HOUR });
  assert.equal(quiet.ok, false);
  assert.match(quiet.fund, /no run for/);
});

test('a push on failure, one on recovery, none on a plain success', () => {
  const ok: CanaryReport = { at: NOW, ms: 5, seq: 2, networks: ['arweave'], ok: true, put: { sha256: 'abcdef'.repeat(11), size: 1, legs: ['arweave'], manifestTxId: 'M2', units: '1', ms: 4 } };
  const bad: CanaryReport = { at: NOW - HOUR, ms: 5, seq: 1, networks: ['arweave'], ok: false, error: 'edge refused' };
  assert.equal(canaryNotification(ok, ok), null);
  assert.equal(canaryNotification(ok, undefined), null);
  const n = canaryNotification(bad, ok);
  assert.equal(n?.priority, 'high');
  assert.match(n!.title, /canary #1 failed/);
  assert.match(n!.body, /edge refused/);
  const back = canaryNotification(ok, bad);
  assert.equal(back?.priority, 'low');
  assert.match(back!.title, /back: #2 ok/);
});

test('the last report survives a restart on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-'));
  try {
    const p = join(dir, 'gate', 'canary-last.json');
    assert.equal(readLastCanary(p), undefined);
    const r: CanaryReport = { at: NOW, ms: 5, seq: 9, networks: ['arweave'], ok: true };
    writeLastCanary(p, r);
    assert.deepEqual(readLastCanary(p), r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
