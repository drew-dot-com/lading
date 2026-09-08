import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideWalrusNative } from './quote.js';
import { epochEndsAt, nineDec, ownerAddress } from './walrus-native.js';

const cost = 153_807_545n; // 1 MiB for 26 epochs, read live 2026-09-08 (0.153807545 WAL)

test('native walrus: deliverable only with WAL at the reserve and SUI for one write', () => {
  const base = { size: 1024 * 1024, maxBytes: 3 * 1024 * 1024, costFrost: cost, suiPerWriteMist: 30_000_000n };
  const ok = decideWalrusNative({ ...base, walFrost: 400_000_000n, suiMist: 50_000_000n });
  assert.equal(ok.deliverable, true);
  assert.equal(ok.reserveWal, '0.307615090');
  const lowWal = decideWalrusNative({ ...base, walFrost: 300_000_000n, suiMist: 50_000_000n });
  assert.equal(lowWal.deliverable, false);
  assert.match(lowWal.reason!, /^walrus WAL float 0.300000000 on Sui is under the 0.307615090 WAL reserve for a 0.153807545 WAL write/);
  const lowSui = decideWalrusNative({ ...base, walFrost: 400_000_000n, suiMist: 10_000_000n });
  assert.equal(lowSui.deliverable, false);
  assert.match(lowSui.reason!, /^walrus SUI float 0.010000000 is under the 0.030000000 SUI/);
  assert.equal(decideWalrusNative({ ...base, size: 0, walFrost: 1n, suiMist: 1n }).reason, 'object is empty');
  assert.match(decideWalrusNative({ ...base, size: base.maxBytes + 1, walFrost: 10n ** 12n, suiMist: 10n ** 12n }).reason!, /over the .*-byte cap/);
});

test('nineDec renders FROST and MIST exactly', () => {
  assert.equal(nineDec(0n), '0.000000000');
  assert.equal(nineDec(cost), '0.153807545');
  assert.equal(nineDec(3_321_257_162n), '3.321257162');
});

test('epochEndsAt: a period ending at epoch e runs out when epoch e begins; ownerAddress reads every owner shape', () => {
  const first = 1_742_000_000_000;
  const dur = 14 * 86_400_000;
  assert.equal(epochEndsAt(1, first, dur), first);
  assert.equal(epochEndsAt(65, first, dur), first + 64 * dur);
  assert.equal(ownerAddress({ AddressOwner: '0xab' }), '0xab');
  assert.equal(ownerAddress({ $kind: 'AddressOwner', address: '0xcd' }), '0xcd');
  assert.equal(ownerAddress('0xef'), '0xef');
  assert.equal(ownerAddress({ Shared: { initial_shared_version: 1 } }), undefined);
});
