import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildManifest, parseManifest } from './manifest.js';
import { MANIFEST_KIND } from './kinds.js';
import { undernameFor, UNDERNAME_RE } from './arns.js';

const sha = 'a'.repeat(64);
const content = {
  sha256: sha,
  size: 3,
  legs: [
    { network: 'arweave' as const, id: 'x'.repeat(43), sha256: sha, size: 3, retention: 'permanent', provider: 'toon-store', at: 1 },
    { network: 'walrus' as const, id: 'blob', sha256: sha, size: 3, retention: 'P365D', provider: 'lighthouse-x402', at: 1 },
  ],
  created: 1,
};

test('manifest round-trips and is keyed by sha256', () => {
  const ev = buildManifest(content, new Uint8Array(randomBytes(32)));
  assert.equal(ev.kind, MANIFEST_KIND);
  assert.deepEqual(ev.tags.find((t) => t[0] === 'd'), ['d', sha]);
  assert.equal(ev.tags.filter((t) => t[0] === 'leg').length, 2);
  assert.deepEqual(parseManifest(ev), content);
});

test('a tampered manifest is refused', () => {
  const ev = buildManifest(content, new Uint8Array(randomBytes(32)));
  const bad = { ...ev, content: ev.content.replace('"size":3', '"size":4') };
  assert.throws(() => parseManifest(bad), /signature/);
});

test('undernames derive from the sha and pass the ArNS charset', () => {
  const u = undernameFor(sha);
  assert.equal(u, 'l-aaaaaaaaaaaa');
  assert.ok(UNDERNAME_RE.test(u));
  assert.ok(!UNDERNAME_RE.test('Bad_Name'));
});

test('a raw sha256 CID commits to the file hash', async () => {
  const { rawCidSha256 } = await import('./walrus.js');
  assert.equal(rawCidSha256('bafkreiemnnugc2h54sd62itmqjbzkshjmhb72gezmmee4bbr6rnrmwhcam'), '8c6b686168fde487ed226c82439548e961c3fd189963084e0431f45b1658e203');
  assert.equal(rawCidSha256('QmNotBase32'), undefined);
});
