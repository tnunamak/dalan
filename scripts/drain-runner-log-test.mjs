import assert from 'node:assert/strict';
import test from 'node:test';
import { checkResponse } from '../src/check-response.mjs';
import { createDrainRunner } from '../src/drain-runner.mjs';

test('invalid budgets and asynchronous log failures leave no unhandled rejection', async () => {
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    for (const responseMs of [NaN, Infinity, -1]) {
      const work = Promise.reject(new Error('work'));
      // Leave work unobserved here so only checkResponse can handle it.
      await assert.rejects(checkResponse(work, 'running', { responseMs }), {
        name: 'TypeError',
        message: 'responseMs must be a non-negative finite number',
      });
    }
    const logs = [];
    await createDrainRunner(
      () => Promise.reject(new Error('drain')),
      async entry => { logs.push(entry); throw new Error('logger'); },
    )();
    assert.deepEqual(logs, [{ kind: 'delivery_drain_error', reason: 'drain' }]);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('synchronous drain failure, throwing logger and non-promise drain resolve', async () => {
  const logs = [];
  assert.equal(await createDrainRunner(
    () => { throw new Error('sync drain'); },
    entry => logs.push(entry),
  )(), undefined);
  assert.deepEqual(logs, [{ kind: 'delivery_drain_error', reason: 'sync drain' }]);
  assert.equal(await createDrainRunner(
    () => { throw new Error('sync drain'); },
    () => { throw new Error('sync logger'); },
  )(), undefined);
  assert.equal(await createDrainRunner(() => 42, () => assert.fail('unexpected log'))(), 42);
});

test('observing invalid-budget work does not consume rejection for other callers', async () => {
  const error = new Error('caller still sees work');
  const work = Promise.reject(error);
  await assert.rejects(checkResponse(work, 'running', { responseMs: NaN }), TypeError);
  await assert.rejects(work, value => value === error);
});
