import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from 'nostr-tools/pure';
import { buildManifest } from './manifest.js';
import { dueWithin, walrusRecords, type SavedPut } from './renewals.js';

const DAY = 86_400_000;
const sk = generateSecretKey();
const sha = 'cd'.repeat(32);

function saved(legs: Parameters<typeof buildManifest>[0]['legs'], renewals?: SavedPut['renewals']): SavedPut {
  const manifest = buildManifest({ sha256: sha, size: 20, legs, created: 1_700_000_000 }, sk);
  return { manifest, paid: [], ...(renewals ? { renewals } : {}), name: { name: 'l-cdcdcdcdcdcd_base', url: 'https://x' } };
}

test('walrusRecords: one row per whole-object walrus leg, none for other networks or legs without a record id', () => {
  const now = 1_800_000_000_000;
  const rows = walrusRecords(
    saved([
      { network: 'arweave', id: 'tx', sha256: sha, size: 20, retention: 'permanent', provider: 'toon-store', at: 1 },
      { network: 'walrus', id: 'blobA', sha256: sha, size: 20, retention: 'P365D', provider: 'lighthouse-x402', proof: { blobId: 'blobA', readUrl: 'u', lighthouseId: 'rec-a', expiresAt: now + 10 * DAY }, at: 1 },
      { network: 'walrus', id: 'blobB', sha256: sha, size: 20, retention: 'P365D', provider: 'walrus-native', proof: { blobId: 'blobB', readUrl: 'u' }, at: 1 },
    ]),
    now,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.lighthouseId, 'rec-a');
  assert.equal(rows[0]!.part, -1);
  assert.equal(rows[0]!.daysLeft, 10);
  assert.equal(rows[0]!.name, 'l-cdcdcdcdcdcd_base');
});

test('walrusRecords: a chunked leg yields one row per part, and a saved renewal moves the date', () => {
  const now = 1_800_000_000_000;
  const rows = walrusRecords(
    saved(
      [
        {
          network: 'walrus', id: 'p0', sha256: sha, size: 20, retention: 'P365D', provider: 'lighthouse-x402', at: 1,
          parts: [
            { index: 0, id: 'p0', sha256: 'aa'.repeat(32), size: 10, proof: { lighthouseId: 'rec-0', expiresAt: now + 30 * DAY } },
            { index: 1, id: 'p1', sha256: 'bb'.repeat(32), size: 10, proof: { lighthouseId: 'rec-1', expiresAt: now + 30 * DAY } },
          ],
        },
      ],
      [{ network: 'walrus', lighthouseId: 'rec-1', blobId: 'p1', previousExpiresAt: now + 30 * DAY, expiresAt: now + 395 * DAY, route: 'r', price: '40000', at: 2 }],
    ),
    now,
  );
  assert.deepEqual(rows.map((r) => [r.part, r.parts, r.lighthouseId, r.daysLeft, r.renewals]), [[0, 2, 'rec-0', 30, 0], [1, 2, 'rec-1', 395, 1]]);
  assert.deepEqual(dueWithin(rows, 60).map((r) => r.lighthouseId), ['rec-0']);
  assert.deepEqual(dueWithin(rows, 400).map((r) => r.lighthouseId), ['rec-0', 'rec-1']);
});
