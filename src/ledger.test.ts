import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daysLeft, foldLedger, openLedger, sortByExpiry, type LedgerRow } from './ledger.js';

const row = (id: string, expiresAt: number, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  lighthouseId: id,
  blobId: `blob-${id}`,
  cid: `cid-${id}`,
  sha256: 'ab'.repeat(32),
  size: 10,
  expiresAt,
  paidAt: 1_700_000_000,
  renewals: 0,
  last: 'upload',
  lastAt: 1_700_000_000,
  ...extra,
});

test('foldLedger: later lines win, bad lines are skipped', () => {
  const text = [JSON.stringify(row('a', 100)), 'not json', JSON.stringify(row('b', 50)), JSON.stringify(row('a', 200, { renewals: 1, last: 'renew' }))].join('\n') + '\n';
  const m = foldLedger(text);
  assert.equal(m.size, 2);
  assert.equal(m.get('a')?.expiresAt, 200);
  assert.equal(m.get('a')?.renewals, 1);
  assert.deepEqual(sortByExpiry(m.values()).map((r) => r.lighthouseId), ['b', 'a']);
});

test('openLedger: persists as JSONL and reloads the folded state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lading-ledger-'));
  try {
    const l = openLedger(dir);
    l.upsert(row('a', 100));
    l.upsert(row('b', 50));
    l.upsert(row('a', 200, { renewals: 1, last: 'renew' }));
    assert.equal(readFileSync(l.path!, 'utf8').trim().split('\n').length, 3);
    const again = openLedger(dir);
    assert.deepEqual(again.list().map((r) => [r.lighthouseId, r.expiresAt]), [['b', 50], ['a', 200]]);
    assert.equal(again.byBlobId('blob-a')?.lighthouseId, 'a');
    assert.equal(again.get('zzz'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openLedger without a dir keeps rows in memory only', () => {
  const l = openLedger(undefined);
  l.upsert(row('a', 1));
  assert.equal(l.path, undefined);
  assert.equal(l.list().length, 1);
});

test('daysLeft floors toward the past', () => {
  const now = 1_000 * 86_400_000;
  assert.equal(daysLeft(now + 365 * 86_400_000, now), 365);
  assert.equal(daysLeft(now + 86_400_000 - 1, now), 0);
  assert.equal(daysLeft(now - 1, now), -1);
});
