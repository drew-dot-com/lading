import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChoiceError, choiceHeaders, choiceQuery, choicesBlock, defaultChoices, isDefault, parseChoices, skipFor } from './choices.ts';

test('no choices is every network and the default period', () => {
  const c = parseChoices();
  assert.deepEqual(c, { networks: ['arweave', 'walrus', 'filecoin', 'ipfs'] });
  assert.ok(isDefault(c));
  assert.deepEqual(parseChoices({ networks: '', walrusEpochs: '' }), defaultChoices());
  assert.deepEqual(skipFor(c), {});
  assert.deepEqual(choiceHeaders(c), {});
  assert.equal(choiceQuery(c), '');
});

test('networks: comma list or array, any order, case, spaces; kept in canonical order without repeats', () => {
  assert.deepEqual(parseChoices({ networks: 'ipfs, Arweave' }).networks, ['arweave', 'ipfs']);
  assert.deepEqual(parseChoices({ networks: ['walrus', 'walrus', 'filecoin'] }).networks, ['walrus', 'filecoin']);
  assert.throws(() => parseChoices({ networks: 'arweave,storj' }), (e: Error) => e instanceof ChoiceError && /unknown network "storj"/.test(e.message));
  assert.throws(() => parseChoices({ networks: ',' }), /at least one network/);
  assert.throws(() => parseChoices({ networks: 7 }), /comma-separated list or an array/);
});

test('walrus epochs: 1..53 whole, only with walrus chosen', () => {
  assert.equal(parseChoices({ walrusEpochs: '53' }).walrusEpochs, 53);
  assert.equal(parseChoices({ walrusEpochs: 4 }).walrusEpochs, 4);
  assert.throws(() => parseChoices({ walrusEpochs: 54 }), /1\.\.53/);
  assert.throws(() => parseChoices({ walrusEpochs: 0 }), /1\.\.53/);
  assert.throws(() => parseChoices({ walrusEpochs: '2.5' }), /1\.\.53/);
  assert.throws(() => parseChoices({ networks: 'arweave', walrusEpochs: 10 }), /walrus is not among/);
});

test('the skip map keeps the manifest anchored on arweave whatever is chosen', () => {
  assert.deepEqual(skipFor(parseChoices({ networks: 'walrus' })), { arweaveObject: true, filecoin: true, ipfs: true });
  assert.deepEqual(skipFor(parseChoices({ networks: 'arweave,ipfs' })), { walrus: true, filecoin: true });
});

test('headers and query carry only what was chosen; the block echoes the retention', () => {
  const c = parseChoices({ networks: 'arweave,walrus', walrusEpochs: 53 });
  assert.deepEqual(choiceHeaders(c), { 'x-networks': 'arweave,walrus', 'x-walrus-epochs': '53' });
  assert.equal(choiceQuery(c), '&networks=arweave,walrus&walrus-epochs=53');
  assert.deepEqual(choicesBlock(c), { networks: ['arweave', 'walrus'], walrusEpochs: 53, walrusRetention: 'P742D' });
  assert.deepEqual(choicesBlock(defaultChoices()), { networks: ['arweave', 'walrus', 'filecoin', 'ipfs'], walrusEpochs: null, walrusRetention: 'P364D' });
  assert.deepEqual(choiceHeaders(parseChoices({ walrusEpochs: 2 })), { 'x-walrus-epochs': '2' });
});
