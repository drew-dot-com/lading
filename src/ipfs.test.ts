import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microToUsdc, priceFromPaymentRequired } from './ipfs.js';
import { decideWalrus } from './quote.js';
import { ipfsReadUrls, readGateways, DEFAULT_IPFS_GATEWAYS } from './read.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

// The live shape of Pinata's 402 on 2026-09-08 for fileSize=1048576.
const live = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://402.pinata.cloud/v1/pin/public', description: 'Pay to pin a public file to Pinata', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '1200', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0xc900f41481B4F7C612AF9Ce3B1d16A7A1B6bd96E', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }],
};

test('pinata 402: the exact amount for the asked network is the price', () => {
  const p = priceFromPaymentRequired(b64(live));
  assert.equal(p.amountMicro, 1200n);
  assert.equal(p.payTo, '0xc900f41481B4F7C612AF9Ce3B1d16A7A1B6bd96E');
  assert.equal(microToUsdc(p.amountMicro), '0.001200');
  const two = { ...live, accepts: [{ ...live.accepts[0], network: 'eip155:84532', amount: '5' }, live.accepts[0]] };
  assert.equal(priceFromPaymentRequired(b64(two)).amountMicro, 1200n);
});

test('pinata 402: a missing header, junk, or an offer with no amount is refused', () => {
  assert.throws(() => priceFromPaymentRequired(null), /without a payment-required/);
  assert.throws(() => priceFromPaymentRequired('not base64 json'), /not base64 JSON/);
  assert.throws(() => priceFromPaymentRequired(b64({ accepts: [{ scheme: 'exact', network: 'eip155:8453' }] })), /no exact amount/);
});

test('ipfs quote: same reserve rule as walrus, reason names the ipfs float', () => {
  const d = decideWalrus({ size: 10, maxBytes: 100, priceUsdc: '0.001000', balanceUsdc: '0.001500', label: 'ipfs' });
  assert.equal(d.deliverable, false);
  assert.match(d.reason!, /^ipfs float 0.001500 USDC on Base is under the 0.002000 USDC reserve/);
  assert.equal(decideWalrus({ size: 10, maxBytes: 100, priceUsdc: '0.001000', balanceUsdc: '5', label: 'ipfs' }).deliverable, true);
});

test('ipfs read urls: the pinner first, then the configured order, no duplicates', () => {
  const gws = readGateways('ipfs.167-233-221-236.sslip.io', undefined, DEFAULT_IPFS_GATEWAYS);
  assert.deepEqual(gws, ['ipfs.167-233-221-236.sslip.io', 'gateway.pinata.cloud', 'ipfs.filebase.io', 'ipfs.io']);
  assert.equal(ipfsReadUrls('bafyabc', gws)[2], 'https://ipfs.filebase.io/ipfs/bafyabc');
  assert.deepEqual(readGateways('gateway.pinata.cloud', 'https://ipfs.io/, gateway.pinata.cloud', DEFAULT_IPFS_GATEWAYS), ['gateway.pinata.cloud', 'ipfs.io']);
});
