import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatePriceMicro, gatePriceUsdc, microToUsdc, pricingFromEnv, usdcToMicro, walrusDurationSurcharge } from './gate-price.ts';

test('usdc strings round-trip through micro-units', () => {
  assert.equal(usdcToMicro('0.05'), 50_000n);
  assert.equal(usdcToMicro('1'), 1_000_000n);
  assert.equal(usdcToMicro('0.1221305'), 122_130n); // truncated to six places
  assert.equal(microToUsdc(122_130n), '0.122130');
  assert.equal(microToUsdc(0n), '0.000000');
  assert.throws(() => usdcToMicro('-1'));
  assert.throws(() => usdcToMicro('1e3'));
});

test('the 1 MiB put of 2026-09-07 (122,130 units) prices at bill × 1.2, rounded up', () => {
  assert.equal(gatePriceMicro(122_130n), 146_556n);
  assert.equal(gatePriceUsdc(122_130n), '0.146556');
});

test('a small put sits on the floor', () => {
  // A ~5 KB put ran to about 81,180 units on 09-06; × 1.2 = 97,416 > floor. A
  // tiny one at 30,000 units × 1.2 = 36,000 is under the 50,000 floor.
  assert.equal(gatePriceUsdc(30_000n), '0.050000');
  assert.equal(gatePriceUsdc(0n), '0.050000');
  assert.equal(gatePriceUsdc(81_180n), '0.097416');
});

test('margin and floor are configurable and a margin under 1 is refused', () => {
  assert.equal(gatePriceUsdc(100_000n, { margin: 1.5, floorUsdc: '0.01' }), '0.150000');
  assert.equal(gatePriceUsdc(100_000n, { margin: 1, floorUsdc: '0.20' }), '0.200000');
  assert.throws(() => gatePriceMicro(1n, { margin: 0.9, floorUsdc: '0' }), /below cost/);
  assert.throws(() => gatePriceMicro(-1n), /negative/);
});

test('pricing from env: defaults, overrides, rejects', () => {
  assert.deepEqual(pricingFromEnv({}), { margin: 1.2, floorUsdc: '0.05' });
  assert.deepEqual(pricingFromEnv({ LADING_GATE_MARGIN: '1.35', LADING_GATE_FLOOR_USDC: '0.10' }), { margin: 1.35, floorUsdc: '0.10' });
  assert.throws(() => pricingFromEnv({ LADING_GATE_MARGIN: '0.5' }));
  assert.throws(() => pricingFromEnv({ LADING_GATE_FLOOR_USDC: 'free' }));
});

test('a longer walrus period adds the walrus leg pro rata per epoch past the default, rounded up; shorter adds nothing', () => {
  assert.equal(walrusDurationSurcharge(40_000n, undefined), 0n);
  assert.equal(walrusDurationSurcharge(40_000n, 26), 0n);
  assert.equal(walrusDurationSurcharge(40_000n, 1), 0n);
  assert.equal(walrusDurationSurcharge(40_000n, 52), 40_000n);
  assert.equal(walrusDurationSurcharge(40_000n, 53), 41_539n);
  assert.equal(walrusDurationSurcharge(40_000n, 27), 1_539n);
  // four parts: the surcharge scales with the units, not the count
  assert.equal(walrusDurationSurcharge(160_000n, 39), 80_000n);
});
