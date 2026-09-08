import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  BLOSSOM_AUTH_KIND,
  BlossomError,
  CreditLedger,
  blossomRouter,
  describe,
  extensionFor,
  mimeFor,
  parseAuthHeader,
  requireHash,
  requireVerb,
  type BlobRecord,
} from './blossom.js';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const now = Math.floor(Date.now() / 1000);

function authHeader(o: { verb?: string; x?: string[]; exp?: number; created?: number; kind?: number; key?: Uint8Array } = {}): string {
  const tags: string[][] = [['t', o.verb ?? 'upload'], ['expiration', String(o.exp ?? now + 300)]];
  for (const x of o.x ?? []) tags.push(['x', x]);
  const ev = finalizeEvent({ kind: o.kind ?? BLOSSOM_AUTH_KIND, created_at: o.created ?? now - 5, tags, content: 'lading test' }, o.key ?? sk);
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`;
}

test('parseAuthHeader accepts a good event and reports verb, hashes and pubkey', () => {
  const a = parseAuthHeader(authHeader({ x: ['ab'.repeat(32)] }), now);
  assert.equal(a.pubkey, pk);
  assert.deepEqual(a.verbs, ['upload']);
  assert.deepEqual(a.hashes, ['ab'.repeat(32)]);
  requireVerb(a, 'upload');
  requireHash(a, 'ab'.repeat(32));
  assert.throws(() => requireVerb(a, 'delete'), (e: BlossomError) => e.status === 403);
  assert.throws(() => requireHash(a, 'cd'.repeat(32)), (e: BlossomError) => e.status === 403);
});

test('parseAuthHeader refuses what BUD-01 says to refuse', () => {
  const status = (h: string | undefined) => {
    try {
      parseAuthHeader(h, now);
      return 200;
    } catch (e) {
      return (e as BlossomError).status;
    }
  };
  assert.equal(status(undefined), 401);
  assert.equal(status('Bearer abc'), 401);
  assert.equal(status('Nostr ' + Buffer.from('nope').toString('base64')), 401);
  assert.equal(status(authHeader({ kind: 1 })), 401);
  assert.equal(status(authHeader({ exp: now - 1 })), 401);
  assert.equal(status(authHeader({ created: now + 3600 })), 401);
  const tampered = authHeader().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal(status(tampered), 401);
});

test('parseAuthHeader accepts the url-safe base64 alphabet', () => {
  const h = authHeader();
  const urlSafe = 'Nostr ' + h.slice(6).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(parseAuthHeader(urlSafe, now).pubkey, pk);
});

test('CreditLedger tops up, debits, refunds, refuses with a 402 that names the fund door, and replays its file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lading-credit-'));
  const path = join(dir, 'credit.jsonl');
  const l = new CreditLedger(path);
  assert.equal(l.balance(pk), 0n);
  assert.throws(() => l.debit(pk, 1n, 'x', 'https://g/v1/credit'), (e: BlossomError) => e.status === 402 && /0\.000000 USDC credit; this upload costs 0\.000001 USDC\. Fund it at https:\/\/g\/v1\/credit/.test(e.message));
  l.topUp(pk, 500_000n, 'tx1');
  assert.equal(l.debit(pk, 150_000n, 'blob', 'https://g/v1/credit'), 350_000n);
  assert.equal(l.refund(pk, 150_000n, 'blob'), 500_000n);
  assert.equal(l.debit(pk, 500_000n, 'blob2', 'https://g/v1/credit'), 0n);
  assert.throws(() => l.topUp(pk, 0n, 'x'), (e: BlossomError) => e.status === 400);
  const again = new CreditLedger(path);
  assert.equal(again.balance(pk), 0n);
  assert.equal(again.history(pk).length, 4);
});

test('describe builds the BUD-02 descriptor with an extension from the type', () => {
  const rec: BlobRecord = { sha256: 'ab'.repeat(32), size: 3, mime: 'image/png', archivedAt: 1_700_000_000, legs: [{ network: 'arweave', id: 'tx' }, { network: 'ipfs', id: 'cid' }], manifestUrl: 'https://permagate.io/m', name: 'l-x' };
  const d = describe('https://gate/', rec);
  assert.equal(d.url, `https://gate/${'ab'.repeat(32)}.png`);
  assert.equal(d.type, 'image/png');
  assert.deepEqual(d.legs, { arweave: 'tx', ipfs: 'cid' });
  assert.deepEqual(d.nip94[1], ['x', 'ab'.repeat(32)]);
  assert.equal(extensionFor(undefined), 'bin');
  assert.equal(extensionFor('video/mp4; codecs=avc1'), 'mp4');
  assert.equal(mimeFor('IMAGE/JPEG; charset=x'), 'image/jpeg');
  assert.equal(mimeFor(undefined), 'application/octet-stream');
});

async function harness(o: { price?: bigint; fail?: boolean } = {}) {
  const credit = new CreditLedger();
  const archive = new Map<string, BlobRecord>();
  const puts: { name: string; mime?: string; pubkey: string }[] = [];
  const app = express();
  app.use(
    blossomRouter({
      baseUrl: 'https://gate',
      maxBytes: 1024,
      credit,
      price: async () => o.price ?? 100_000n,
      archived: (sha) => archive.get(sha),
      put: async (bytes, po) => {
        if (o.fail) throw new Error('edge down');
        puts.push(po);
        const rec: BlobRecord = { sha256: sha256(bytes), size: bytes.length, mime: po.mime, archivedAt: now, legs: [{ network: 'arweave', id: 'tx' }, { network: 'ipfs', id: 'cid' }], manifestUrl: 'https://permagate.io/m', name: 'l-test' };
        archive.set(rec.sha256, rec);
        return rec;
      },
      readUrls: (leg) => [`https://read/${leg.network}/${leg.id}`],
      readFirst: async (urls) => {
        const rec = [...archive.values()][0];
        return { bytes: rec ? new TextEncoder().encode('hello') : undefined, status: 200, url: urls[0] };
      },
      sha256,
      log: () => undefined,
    }),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, ...init });
  return { credit, archive, puts, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('HEAD /upload: 402 without credit, 200 with it, 200 for a known blob', async () => {
  const h = await harness();
  try {
    const bytes = new TextEncoder().encode('hello');
    const sha = sha256(bytes);
    const headers = { authorization: authHeader({ x: [sha] }), 'x-sha-256': sha, 'x-content-length': '5', 'x-content-type': 'text/plain' };
    let r = await h.call('HEAD', '/upload', { headers });
    assert.equal(r.status, 402);
    assert.match(r.headers.get('x-reason') ?? '', /has 0\.000000 USDC credit; this upload costs 0\.100000 USDC/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    h.credit.topUp(pk, 100_000n, 'tx');
    r = await h.call('HEAD', '/upload', { headers });
    assert.equal(r.status, 200);
    r = await h.call('HEAD', '/upload', { headers: { ...headers, 'x-content-length': '2048' } });
    assert.equal(r.status, 413);
    r = await h.call('HEAD', '/upload', { headers: { ...headers, authorization: authHeader({ verb: 'get' }) } });
    assert.equal(r.status, 403);
  } finally {
    await h.close();
  }
});

test('PUT /upload: debits, archives, describes; a repeat is free; a failed put refunds', async () => {
  const h = await harness();
  try {
    const bytes = new TextEncoder().encode('hello');
    const sha = sha256(bytes);
    const headers = { authorization: authHeader({ x: [sha] }), 'content-type': 'text/plain' };
    let r = await h.call('PUT', '/upload', { headers, body: bytes });
    assert.equal(r.status, 402);
    assert.equal(h.puts.length, 0);
    h.credit.topUp(pk, 250_000n, 'tx');
    r = await h.call('PUT', '/upload', { headers, body: bytes });
    assert.equal(r.status, 201);
    const d = (await r.json()) as { url: string; sha256: string; type: string; size: number; legs: Record<string, string> };
    assert.equal(d.url, `https://gate/${sha}.txt`);
    assert.equal(d.sha256, sha);
    assert.equal(d.type, 'text/plain');
    assert.equal(d.size, 5);
    assert.equal(h.credit.balance(pk), 150_000n);
    assert.deepEqual(h.puts[0], { name: `${sha.slice(0, 12)}.txt`, mime: 'text/plain', pubkey: pk });
    r = await h.call('PUT', '/upload', { headers, body: bytes });
    assert.equal(r.status, 200);
    assert.equal(h.credit.balance(pk), 150_000n);
    r = await h.call('PUT', '/upload', { headers: { ...headers, authorization: authHeader({ x: ['00'.repeat(32)] }) }, body: new TextEncoder().encode('other') });
    assert.equal(r.status, 403);
    r = await h.call('PUT', '/upload', { headers: { ...headers, 'x-sha-256': '00'.repeat(32) }, body: bytes });
    assert.equal(r.status, 409);
  } finally {
    await h.close();
  }
  const f = await harness({ fail: true });
  try {
    const bytes = new TextEncoder().encode('bye');
    f.credit.topUp(pk, 100_000n, 'tx');
    const r = await f.call('PUT', '/upload', { headers: { authorization: authHeader({ x: [sha256(bytes)] }) }, body: bytes });
    assert.equal(r.status, 502);
    assert.equal(f.credit.balance(pk), 100_000n);
  } finally {
    await f.close();
  }
});

test('GET and HEAD by hash serve the archived blob with its type; DELETE is refused; unknown is 404', async () => {
  const h = await harness();
  try {
    const bytes = new TextEncoder().encode('hello');
    const sha = sha256(bytes);
    h.credit.topUp(pk, 100_000n, 'tx');
    await h.call('PUT', '/upload', { headers: { authorization: authHeader({ x: [sha] }), 'content-type': 'text/plain' }, body: bytes });
    let r = await h.call('GET', `/${sha}.txt`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/plain');
    assert.equal(await r.text(), 'hello');
    r = await h.call('HEAD', `/${sha}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '5');
    r = await h.call('DELETE', `/${sha}`, { headers: { authorization: authHeader({ verb: 'delete', x: [sha] }) } });
    assert.equal(r.status, 403);
    r = await h.call('GET', `/${'00'.repeat(32)}`);
    assert.equal(r.status, 404);
    r = await h.call('OPTIONS', '/upload');
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-methods'), 'GET, HEAD, PUT, DELETE');
  } finally {
    await h.close();
  }
});
