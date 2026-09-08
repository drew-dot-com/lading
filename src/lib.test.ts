import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateSecretKey } from 'nostr-tools/pure';
import { Lading, optionsFromEnv, sha256 } from './lib.ts';
import { buildManifest } from './manifest.ts';

/** A home holding one saved put for `bytes`, as lib.save() writes it. */
function homeWith(bytes: Uint8Array, o: { manifestTxId?: string; named?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'lading-test-'));
  const sha = sha256(bytes);
  const manifest = buildManifest(
    {
      sha256: sha,
      size: bytes.length,
      legs: [
        { network: 'arweave', id: 'A'.repeat(43), sha256: sha, size: bytes.length, retention: 'permanent', provider: 'toon-store', at: 1 },
        { network: 'walrus', id: 'W'.repeat(43), sha256: sha, size: bytes.length, retention: 'P365D', provider: 'lighthouse-x402', at: 2 },
      ],
      created: 1_757_000_000,
    },
    generateSecretKey(),
  );
  mkdirSync(join(home, 'manifests'), { recursive: true });
  writeFileSync(
    join(home, 'manifests', `${sha}.json`),
    JSON.stringify({
      manifest,
      ...(o.manifestTxId ? { manifestTxId: o.manifestTxId } : {}),
      ...(o.named ? { name: { name: `l-${sha.slice(0, 12)}_test`, url: `https://l-${sha.slice(0, 12)}_test.permagate.io/` } } : {}),
      paid: [
        { leg: 'arweave', route: 'g.drew.ario', price: '1030' },
        { leg: 'walrus', route: 'g.drew.lading.walrus', price: '40000' },
        { leg: 'relay', route: 'g.drew.relay', price: null },
      ],
    }),
  );
  return { home, sha };
}

// The edge is never reached in these tests: a wrong URL makes any accidental network call fail fast,
// and a throwaway payer key keeps the developer's own keypair and channel store out of it.
const isolated = (home: string, log: (s: string) => void = () => undefined) =>
  optionsFromEnv({ home, edge: 'http://127.0.0.1:9', solanaSecret: new Uint8Array(randomBytes(64)), channelStore: join(home, 'channels.json'), nostrKey: randomBytes(32).toString('hex'), log });
const lading = (home: string) => new Lading(isolated(home));

test('a saved put whose manifest reached Arweave reads back as a reused result', () => {
  const bytes = new Uint8Array(randomBytes(64));
  const { home, sha } = homeWith(bytes, { manifestTxId: 'M'.repeat(43), named: true });
  try {
    const r = lading(home).archived(sha)!;
    assert.equal(r.reused, true);
    assert.equal(r.sha256, sha);
    assert.equal(r.size, 64);
    assert.equal(r.parts, 1);
    assert.deepEqual(r.legs.map((l) => l.network), ['arweave', 'walrus']);
    assert.equal(r.manifestTxId, 'M'.repeat(43));
    assert.equal(r.manifestUrl, `https://permagate.io/${'M'.repeat(43)}`);
    assert.equal(r.name?.name, `l-${sha.slice(0, 12)}_test`);
    assert.equal(r.total, 41_030n);
    assert.equal(r.paid[2]!.price, null);
    assert.equal(r.archivedAt, 1_757_000_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a put that died before its manifest is not reused, and an unknown hash is not either', () => {
  const bytes = new Uint8Array(randomBytes(64));
  const { home, sha } = homeWith(bytes, {});
  try {
    const l = lading(home);
    assert.equal(l.archived(sha), undefined);
    assert.equal(l.archived('f'.repeat(64)), undefined);
    assert.equal(l.archived('not a sha'), undefined);
    assert.equal(l.savedPut(sha)?.saved.manifestTxId, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('put on already-archived bytes returns the record and opens no channel', async () => {
  const bytes = new Uint8Array(randomBytes(64));
  const { home, sha } = homeWith(bytes, { manifestTxId: 'M'.repeat(43), named: true });
  try {
    const lines: string[] = [];
    const l = new Lading(isolated(home, (s) => lines.push(s)));
    const r = await l.put(bytes, { name: 'again.bin' });
    assert.equal(r.reused, true);
    assert.equal(r.sha256, sha);
    assert.equal(r.total, 41_030n);
    assert.ok(lines.some((s) => s.includes('already archived') && s.includes('nothing re-bought')), lines.join('\n'));
    // force goes to the edge, which is unreachable here: proof the reuse branch is the only thing that skipped it.
    await assert.rejects(l.put(bytes, { name: 'again.bin', force: true, quote: false }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
