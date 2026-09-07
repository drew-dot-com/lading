import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cached, decideFilecoin, decideName, decideWalrus, decideWalrusRenew } from './quote.js';

test('walrus quote: deliverable only with the reserve on the Base key', () => {
  const base = { size: 5535, maxBytes: 3 * 1024 * 1024, priceUsdc: '0.032500' };
  assert.equal(decideWalrus({ ...base, balanceUsdc: '4.9675' }).deliverable, true);
  assert.equal(decideWalrus({ ...base, balanceUsdc: '0.065' }).deliverable, true);
  const short = decideWalrus({ ...base, balanceUsdc: '0.0649' });
  assert.equal(short.deliverable, false);
  assert.match(short.reason ?? '', /under the 0.065000 USDC reserve/);
  assert.equal(decideWalrus({ ...base, balanceUsdc: '0.04', reserveMultiple: 1 }).deliverable, true);
});

test('walrus quote: size limits', () => {
  const base = { maxBytes: 100, priceUsdc: '0.0325', balanceUsdc: '5' };
  assert.equal(decideWalrus({ ...base, size: 0 }).deliverable, false);
  assert.equal(decideWalrus({ ...base, size: 101 }).deliverable, false);
  assert.equal(decideWalrus({ ...base, size: 100 }).deliverable, true);
});

test('name quote: authority, shape, then lamports', () => {
  const ok = { undernameOk: true, txidOk: true, authorized: true, lamports: 9_182_825n, needLamports: 6_000_000n };
  assert.equal(decideName(ok).deliverable, true);
  assert.equal(decideName({ ...ok, lamports: 1_991_000n }).deliverable, false);
  assert.match(decideName({ ...ok, lamports: 1_991_000n }).reason ?? '', /1991000 lamports is under the 6000000/);
  assert.equal(decideName({ ...ok, authorized: false }).deliverable, false);
  assert.equal(decideName({ ...ok, undernameOk: false }).deliverable, false);
  assert.equal(decideName({ ...ok, txidOk: false }).deliverable, false);
});

test('cached: one load per ttl, shared while in flight', async () => {
  let loads = 0;
  const read = cached(50, async () => ++loads);
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(await read(), 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await read(), 2);
});

test('filecoin quote: piece bounds, then a funded account, then runway', () => {
  const ok = { size: 5535, minBytes: 127, maxBytes: 3 * 1024 * 1024, ready: true, depositNeededUsdfc: '0', runwayDays: 40n, minRunwayDays: 7n };
  assert.equal(decideFilecoin(ok).deliverable, true);
  assert.equal(decideFilecoin({ ...ok, size: 0 }).deliverable, false);
  assert.match(decideFilecoin({ ...ok, size: 64 }).reason ?? '', /under the 127-byte/);
  assert.match(decideFilecoin({ ...ok, size: ok.maxBytes + 1 }).reason ?? '', /over the/);
  assert.match(decideFilecoin({ ...ok, ready: false, depositNeededUsdfc: '1.234' }).reason ?? '', /1.234 USDFC deposit/);
  assert.match(decideFilecoin({ ...ok, runwayDays: 3n }).reason ?? '', /3 days, under the 7-day/);
  assert.equal(decideFilecoin({ ...ok, runwayDays: 7n }).deliverable, true);
});

test('walrus renew quote: the record must exist, then the same reserve rule as an upload', () => {
  const base = { priceUsdc: '0.034500', balanceUsdc: '4.8375' };
  assert.equal(decideWalrusRenew({ ...base, found: true }).deliverable, true);
  const gone = decideWalrusRenew({ ...base, found: false });
  assert.equal(gone.deliverable, false);
  assert.match(gone.reason ?? '', /no record/);
  const short = decideWalrusRenew({ found: true, priceUsdc: '0.034500', balanceUsdc: '0.068' });
  assert.equal(short.deliverable, false);
  assert.match(short.reason ?? '', /under the 0.069000 USDC reserve for a 0.034500 USDC renewal/);
  assert.equal(decideWalrusRenew({ found: true, priceUsdc: '0.034500', balanceUsdc: '0.069' }).deliverable, true);
});
