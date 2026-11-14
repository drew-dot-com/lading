import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceAlreadyTerminatedError } from '@filoz/synapse-core/errors';
import { isTerminatedDataSet, retryOnTerminatedDataSet } from './filecoin.js';

test('a terminated data set is recognised by class, by name, and through a cause', () => {
  assert.equal(isTerminatedDataSet(new ServiceAlreadyTerminatedError(6628510n)), true);
  assert.equal(isTerminatedDataSet(Object.assign(new Error('x'), { name: 'ServiceAlreadyTerminatedError' })), true);
  assert.equal(isTerminatedDataSet(new Error('upload failed', { cause: new ServiceAlreadyTerminatedError(1n) })), true);
  assert.equal(isTerminatedDataSet(new Error('InsufficientLockupFunds')), false);
  assert.equal(isTerminatedDataSet(undefined), false);
});

test('a terminated data set drops the cached client and runs once more', async () => {
  let calls = 0;
  let resets = 0;
  const out = await retryOnTerminatedDataSet(
    async () => {
      calls++;
      if (calls === 1) throw new ServiceAlreadyTerminatedError(6628510n);
      return 'fresh';
    },
    () => {
      resets++;
    },
  );
  assert.equal(out, 'fresh');
  assert.equal(calls, 2);
  assert.equal(resets, 1);
});

test('any other failure is thrown as is, with no reset and no retry', async () => {
  let calls = 0;
  let resets = 0;
  await assert.rejects(
    retryOnTerminatedDataSet(
      async () => {
        calls++;
        throw new Error('InsufficientLockupFunds');
      },
      () => {
        resets++;
      },
    ),
    /InsufficientLockupFunds/,
  );
  assert.equal(calls, 1);
  assert.equal(resets, 0);
});

test('a second terminated failure after the reset is thrown, never looped', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnTerminatedDataSet(
      async () => {
        calls++;
        throw new ServiceAlreadyTerminatedError(6628510n);
      },
      () => {},
    ),
    /already terminated/,
  );
  assert.equal(calls, 2);
});
