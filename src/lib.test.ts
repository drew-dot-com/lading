import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
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

test('parts: status, partKnown, a finish with gaps, plan validation, and the progress sweep', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lading-test-'));
  try {
    const l = lading(home);
    const sha = 'a'.repeat(64);
    const size = 2_500_000; // 3 parts of 1 MiB: 1048576, 1048576, 402848
    mkdirSync(join(home, 'progress'), { recursive: true });
    const row = (index: number, s: number) => ({ index, id: `id${index}`, sha256: `p${index}`.padEnd(64, '0'), size: s, proof: { retention: 'permanent', provider: 'toon-store' }, paid: '1000' });
    writeFileSync(
      join(home, 'progress', `${sha}.json`),
      JSON.stringify({ legs: {}, parts: { arweave: [row(0, 1048576), row(1, 1048576), row(2, 402848)], walrus: [row(0, 1048576), row(2, 402848)] }, paid: [{ leg: 'arweave#1', route: 'g.drew.ario', price: '1000' }] }),
    );
    const st = l.partsStatus(sha);
    assert.equal(st.archived, false);
    assert.deepEqual(st.networks.arweave, { indexes: [0, 1, 2], sealed: false });
    assert.deepEqual(st.networks.walrus, { indexes: [0, 2], sealed: false });
    assert.equal(st.networks.filecoin, undefined);
    assert.equal(st.paidUnits, '1000');
    assert.equal(l.partKnown(sha, 0, 'p0'.padEnd(64, '0')), true);
    assert.equal(l.partKnown(sha, 1, 'p1'.padEnd(64, '0')), false); // walrus lacks it
    assert.equal(l.partKnown(sha, 0, 'x'.repeat(64)), false); // a different slice
    // Walrus lacks index 1: the finish refuses before any network call and names the gap.
    await assert.rejects(l.finish({ sha256: sha, size, count: 3, name: 'big.bin' }), (e: Error) => e.name === 'Error' && /walrus 1/.test(e.message) && !/arweave/.test(e.message));
    // Plan disagreements are refused before anything is bought.
    await assert.rejects(l.finish({ sha256: sha, size, count: 2, name: 'big.bin' }), /splits into 3 parts/);
    await assert.rejects(l.putPart(new Uint8Array(10), { sha256: sha, size, index: 0, count: 3, name: 'big.bin' }), /is 1048576 bytes, got 10/);
    await assert.rejects(l.putPart(new Uint8Array(10), { sha256: sha, size, index: 5, count: 3, name: 'big.bin' }), /out of range/);
    await assert.rejects(l.putPart(new Uint8Array(402848), { sha256: sha, size, index: 2, count: 3, name: 'big.bin', partSha256: 'f'.repeat(64) }), /does not match the bytes/);
    // Nothing bought at all: finish says so.
    await assert.rejects(l.finish({ sha256: 'b'.repeat(64), size: 10, count: 1, name: 'x' }), /no parts bought/);
    // The sweep drops only old progress files: fresh stays, a file backdated ten days goes.
    assert.deepEqual(l.sweepProgress(60_000), []);
    const old = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(join(home, 'progress', `${sha}.json`), old, old);
    assert.deepEqual(l.sweepProgress(7 * 86_400_000), [`${sha}.json`]);
    assert.deepEqual(l.partsStatus(sha).networks, {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
