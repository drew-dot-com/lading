import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THIRD_PARTY_DOORS, TrafficLog, entryFromSaved, windowStats, type TrafficEntry } from './traffic.ts';
import type { SavedPut } from './renewals.ts';

const NOW = Date.UTC(2026, 8, 15, 12);
const HOUR = 3_600_000;

const job = (p: Partial<TrafficEntry> & { at: number }): TrafficEntry => ({ door: 'x402', kind: 'put', ok: true, units: '1000', size: 100, ...p });

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'traffic-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a window counts the jobs inside it, sums units, and keeps the operator apart from strangers', () => {
  const entries = [
    job({ at: NOW - 10 * 60_000, door: 'x402', units: '5000', payer: '0xabc' }),
    job({ at: NOW - 30 * 60_000, door: 'canary', kind: 'canary', units: '3120', size: 200 }),
    job({ at: NOW - 2 * HOUR, door: 'blossom', units: '2000', ok: false, error: 'boom' }),
    job({ at: NOW - 3 * HOUR, door: 'renewals', kind: 'renew', units: '41000', size: undefined }),
    job({ at: NOW - 25 * HOUR, door: 'x402', units: '7000', reused: true }),
    job({ at: NOW + 1, door: 'x402', units: '9' }),
  ];
  const h = windowStats(entries, HOUR, NOW);
  assert.equal(h.jobs, 2);
  assert.equal(h.thirdParty, 1);
  assert.equal(h.units, '8120');
  assert.equal(h.usdc, '0.008120');
  assert.equal(h.bytes, 300);
  assert.deepEqual(h.byDoor, { x402: { jobs: 1, units: '5000' }, canary: { jobs: 1, units: '3120' } });
  assert.deepEqual(h.byKind, { put: 1, canary: 1 });
  const d = windowStats(entries, 24 * HOUR, NOW);
  assert.equal(d.jobs, 4);
  assert.equal(d.failed, 1);
  assert.equal(d.thirdParty, 2);
  assert.equal(d.units, '51120');
  const w = windowStats(entries, 7 * 24 * HOUR, NOW);
  assert.equal(w.jobs, 5);
  assert.equal(w.reused, 1);
  assert.equal(w.bytes, 300, 'a reused record and a failed job add no bytes');
  assert.ok(THIRD_PARTY_DOORS.has('x402') && THIRD_PARTY_DOORS.has('blossom') && !THIRD_PARTY_DOORS.has('canary') && !THIRD_PARTY_DOORS.has('renewals'));
});

test('the log appends a line per job, reads itself back, skips a torn line, and reports windows and the last jobs', () => {
  withDir((dir) => {
    const p = join(dir, 'gate', 'traffic.jsonl');
    const a = new TrafficLog(p);
    assert.equal(a.empty, true);
    a.record(job({ at: NOW - HOUR }));
    a.record(job({ at: NOW - 60_000, door: 'canary', kind: 'canary', units: '3120' }));
    assert.equal(readFileSync(p, 'utf8').split('\n').filter(Boolean).length, 2);
    writeFileSync(p, `${readFileSync(p, 'utf8')}{"at": 1, "door":`);
    const b = new TrafficLog(p);
    assert.equal(b.empty, false);
    assert.equal(b.entries().length, 2);
    const s = b.stats(NOW, 1);
    assert.equal(s.windows['1h'].jobs, 1);
    assert.equal(s.windows['24h'].jobs, 2);
    assert.equal(s.total.jobs, 2);
    assert.equal(s.total.units, '4120');
    assert.equal(s.total.thirdParty, 1);
    assert.equal(s.total.first, new Date(NOW - HOUR).toISOString());
    assert.equal(s.last.length, 1);
    assert.equal(s.last[0].door, 'canary');
    assert.equal(s.last[0].at, new Date(NOW - 60_000).toISOString());
  });
});

test('a saved manifest seeds one entry: the door from via, the units from paid, the legs and size from the tags', () => {
  const saved: SavedPut = {
    manifest: { id: 'i', pubkey: 'p', sig: 's', kind: 30320, created_at: Math.floor((NOW - 2 * HOUR) / 1000), tags: [['d', 'ab'.repeat(32)], ['size', '4096'], ['leg', 'arweave', 'TX', 'permanent'], ['leg', 'walrus', 'B', 'P364D']], content: JSON.stringify({ via: { door: 'x402', payer: '0xpayer' } }) },
    manifestTxId: 'MANIFEST',
    name: { name: 'l-abababababab_x', url: 'https://x' },
    paid: [{ leg: 'arweave', route: 'g.a', price: '1030' }, { leg: 'walrus', route: 'g.w', price: '50000' }, { leg: 'quote', route: 'g.q', price: null }],
  };
  const e = entryFromSaved('ab'.repeat(32), saved);
  assert.equal(e.at, NOW - 2 * HOUR);
  assert.equal(e.door, 'x402');
  assert.equal(e.payer, '0xpayer');
  assert.equal(e.units, '51030');
  assert.deepEqual(e.legs, ['arweave', 'walrus']);
  assert.equal(e.size, 4096);
  assert.equal(e.manifestTxId, 'MANIFEST');
  assert.equal(e.name, 'l-abababababab_x');
  assert.equal(e.seeded, true);
  assert.equal(e.ok, true);
  const cli = entryFromSaved('cd'.repeat(32), { ...saved, manifest: { ...saved.manifest, content: '{}' }, manifestTxId: undefined });
  assert.equal(cli.door, 'cli');
  assert.equal(cli.ok, false, 'a record whose manifest never reached Arweave is a put that died');
});

test('seeding fills only an empty log, oldest first, and a later boot does not seed again', () => {
  withDir((dir) => {
    const p = join(dir, 'traffic.jsonl');
    const a = new TrafficLog(p);
    assert.equal(a.seed([job({ at: NOW - HOUR, seeded: true }), job({ at: NOW - 3 * HOUR, seeded: true })]), 2);
    assert.equal(a.entries()[0].at, NOW - 3 * HOUR);
    const b = new TrafficLog(p);
    assert.equal(b.empty, false);
    assert.equal(b.seed([job({ at: NOW })]), 0);
    assert.equal(b.entries().length, 2);
    assert.equal(b.stats(NOW).total.seeded, 2);
  });
});
