import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ARNS_GATEWAYS, arnsReadUrls, arweaveReadUrls, readFirst, readGateways, viaNote } from './read.js';

const TX = 'Flbk3ZhKYpMY8Fiwu63FPJqteSRjFYux1fpeLFvIszY';

test('read gateways: ArNS gateway first, defaults after, no duplicates', () => {
  assert.deepEqual(readGateways('permagate.io', undefined), ['permagate.io', 'arweave.net', 'ardrive.net']);
  assert.deepEqual(readGateways('ardrive.net', undefined), ['ardrive.net', 'permagate.io', 'arweave.net']);
  assert.deepEqual(readGateways('permagate.io', ' https://arweave.net/ ,, permagate.io'), ['permagate.io', 'arweave.net']);
  assert.deepEqual(readGateways('permagate.io', ''), ['permagate.io']);
  assert.deepEqual(arweaveReadUrls(TX, ['a.io', 'b.net']), [`https://a.io/${TX}`, `https://b.net/${TX}`]);
});

test('arns gateways: same-registry fallbacks only, primary first, arweave.net never by default', () => {
  const g = readGateways('permagate.io', undefined, DEFAULT_ARNS_GATEWAYS);
  assert.deepEqual(g, ['permagate.io', 'ardrive.net', 'vilenarios.com']);
  assert.ok(!g.includes('arweave.net'));
  assert.deepEqual(arnsReadUrls('l-abc_name', ['permagate.io', 'ardrive.net']), ['https://l-abc_name.permagate.io/', 'https://l-abc_name.ardrive.net/']);
  assert.deepEqual(readGateways('permagate.io', '', DEFAULT_ARNS_GATEWAYS), ['permagate.io']);
});

const answer = (status: number, body = 'x') => async () => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer });

test('readFirst: the first gateway that answers 2xx wins', async () => {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    if (url.startsWith('https://permagate.io/')) return answer(503)();
    if (url.startsWith('https://arweave.net/')) return answer(200, 'hello')();
    throw new Error('should not reach ardrive.net');
  };
  const r = await readFirst(arweaveReadUrls(TX, ['permagate.io', 'arweave.net', 'ardrive.net']), f, 0);
  assert.equal(r.status, 200);
  assert.equal(new TextDecoder().decode(r.bytes), 'hello');
  assert.equal(r.url, `https://arweave.net/${TX}`);
  assert.equal(calls.length, 2);
  assert.equal(viaNote(r), ' via arweave.net (permagate.io 503)');
});

test('readFirst: a thrown fetch is status 0 and does not abort the read', async () => {
  const f = async (url: string) => {
    if (url.startsWith('https://permagate.io/')) throw new Error('fetch failed');
    return answer(200)();
  };
  const r = await readFirst(arweaveReadUrls(TX, ['permagate.io', 'arweave.net']), f);
  assert.equal(r.status, 200);
  assert.deepEqual(r.tried, ['permagate.io fetch failed', 'arweave.net 200']);
});

test('readFirst: every gateway down reports the last status and all attempts', async () => {
  const r = await readFirst(arweaveReadUrls(TX, ['permagate.io', 'arweave.net']), answer(502), 0);
  assert.equal(r.status, 502);
  assert.equal(r.bytes, undefined);
  assert.deepEqual(r.tried, ['permagate.io 502', 'arweave.net 502']);
});

test('readFirst: no via note when the first gateway answered', async () => {
  const r = await readFirst(arweaveReadUrls(TX, ['permagate.io', 'arweave.net']), answer(200));
  assert.equal(viaNote(r), '');
  assert.deepEqual(r.tried, ['permagate.io 200']);
});

test('readFirst: a 429 gets another try on the same gateway after a pause, a 404 does not', async () => {
  let n = 0;
  const limited = async (url: string) => (url.startsWith('https://permagate.io/') && n++ === 0 ? answer(429)() : answer(200, 'ok')());
  const r = await readFirst(arweaveReadUrls(TX, ['permagate.io', 'arweave.net']), limited, 1, 0);
  assert.equal(r.url, `https://permagate.io/${TX}`);
  assert.deepEqual(r.tried, ['permagate.io 429', 'permagate.io 200']);
  const missing = await readFirst(arweaveReadUrls(TX, ['permagate.io', 'arweave.net']), async (url) => (url.startsWith('https://permagate.io/') ? answer(404)() : answer(200)()), 2, 0);
  assert.deepEqual(missing.tried, ['permagate.io 404', 'arweave.net 200']);
});
