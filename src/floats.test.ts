import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmpDecimal, judge, lamportsToSol, microToDecimal, report } from './floats.ts';

test('decimal strings compare exactly at any scale', () => {
  assert.equal(cmpDecimal('1', '1.0'), 0);
  assert.equal(cmpDecimal('0.9999999', '1'), -1);
  assert.equal(cmpDecimal('1.255312', '1.5'), -1);
  assert.equal(cmpDecimal('0.000000000000000001', '0'), 1);
  assert.equal(cmpDecimal('719', '30'), 1);
  assert.equal(cmpDecimal('-0.5', '0'), -1);
});

test('a row is ok at the threshold and low under it', () => {
  const base = { name: 'walrus-float', role: 'pays Lighthouse', chain: 'base', asset: 'USDC', address: '0x0', low: '1', fund: 'send USDC' };
  assert.equal(judge({ ...base, balance: '1' }).ok, true);
  assert.equal(judge({ ...base, balance: '0.999999' }).ok, false);
  const r = report([judge({ ...base, balance: '5' }), judge({ ...base, name: 'name-key', balance: '0.001', low: '0.008' })], 1);
  assert.equal(r.ok, false);
  assert.deepEqual(r.low, ['name-key']);
  assert.equal(r.at, 1);
  assert.equal(report([]).ok, true);
});

test('unit renderings are exact strings, never floats', () => {
  assert.equal(lamportsToSol(47_200_000n), '0.0472');
  assert.equal(lamportsToSol(1_000_000_000n), '1');
  assert.equal(lamportsToSol(0n), '0');
  assert.equal(microToDecimal(3_500_000n), '3.500000');
  assert.equal(microToDecimal(134_330n), '0.134330');
});
