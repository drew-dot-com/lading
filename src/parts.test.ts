import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assembleParts, partName, planParts, sha256Hex, splitParts, MIN_TAIL_BYTES } from './parts.js';
import { buildManifest, parseManifest } from './manifest.js';

test('an object that fits is one part', () => {
  assert.deepEqual(planParts(10, 1000), [{ index: 0, offset: 0, size: 10 }]);
  assert.deepEqual(planParts(1000, 1000), [{ index: 0, offset: 0, size: 1000 }]);
  assert.throws(() => planParts(10, MIN_TAIL_BYTES), /part size/);
});

test('parts tile the object and a short tail folds into the last part', () => {
  const plans = planParts(2500, 1000);
  assert.deepEqual(plans.map((p) => [p.offset, p.size]), [[0, 1000], [1000, 1000], [2000, 500]]);
  const folded = planParts(2000 + MIN_TAIL_BYTES - 1, 1000);
  assert.equal(folded.length, 2);
  assert.equal(folded[1]!.size, 1000 + MIN_TAIL_BYTES - 1);
  const kept = planParts(2000 + MIN_TAIL_BYTES, 1000);
  assert.equal(kept.length, 3);
  assert.equal(kept[2]!.size, MIN_TAIL_BYTES);
});

test('split then assemble is the identity and each part hash is checked', () => {
  const bytes = new Uint8Array(randomBytes(1000));
  const parts = splitParts(bytes, 250);
  assert.equal(parts.length, 4);
  assert.equal(sha256Hex(assembleParts(parts)), sha256Hex(bytes));
  const shuffled = [parts[2]!, parts[0]!, parts[3]!, parts[1]!];
  assert.equal(sha256Hex(assembleParts(shuffled)), sha256Hex(bytes));
  const corrupt = parts.map((p, i) => (i === 1 ? { ...p, bytes: new Uint8Array(randomBytes(250)) } : p));
  assert.throws(() => assembleParts(corrupt), /part 1 sha256/);
  assert.throws(() => assembleParts(parts.slice(1)), /part 0 missing/);
});

test('part names read as one object in pieces', () => {
  assert.equal(partName('report.pdf', 0, 1), 'report.pdf');
  assert.equal(partName('report.pdf', 2, 12), 'report.pdf.part03of12');
});

test('a chunked leg carries its part count in the leg tag and round-trips', () => {
  const sha = 'b'.repeat(64);
  const content = {
    sha256: sha,
    size: 3_000_000,
    legs: [
      {
        network: 'walrus' as const,
        id: 'blob0',
        sha256: sha,
        size: 3_000_000,
        retention: 'P365D',
        provider: 'lighthouse-x402',
        at: 1,
        parts: [
          { index: 0, id: 'blob0', sha256: 'c'.repeat(64), size: 1_500_000 },
          { index: 1, id: 'blob1', sha256: 'd'.repeat(64), size: 1_500_000 },
        ],
      },
    ],
    created: 1,
  };
  const ev = buildManifest(content, new Uint8Array(randomBytes(32)));
  assert.deepEqual(ev.tags.find((t) => t[0] === 'leg'), ['leg', 'walrus', 'blob0', 'P365D', '2']);
  assert.deepEqual(parseManifest(ev), content);
});
