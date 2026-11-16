import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGetSummary } from '../src/get-summary.mjs';

const options = { id: 'j1', cli: 'dalan' };
const nextLines = job => formatGetSummary(job, options).split('\n').filter(line => line.startsWith('Next:'));

test('finished done or missing reports retain the accepted suggestion', () => {
  for (const job of [
    { status: 'finished', report: { outcome: 'done' } },
    { status: 'finished' },
    { status: 'finished', report: {} },
  ]) {
    assert.deepEqual(nextLines(job), ['Next: dalan decide j1 accepted']);
  }
});

test('finished non-done outcomes ask the owner to read and classify the report', () => {
  for (const outcome of ['failed', 'blocked', 'unexpected']) {
    const job = { status: 'finished', report: { outcome } };
    assert.ok(!formatGetSummary(job, options).includes('decide j1 accepted'), outcome);
    assert.deepEqual(nextLines(job), [
      'Next: read the report, then dalan decide j1 useful_negative (or not_useful)',
    ], outcome);
  }
});

test('cancelled and running jobs keep their existing next lines', () => {
  assert.deepEqual(nextLines({ status: 'cancelled', report: { outcome: 'failed' } }), []);
  assert.deepEqual(nextLines({ status: 'running', report: { outcome: 'failed' } }), [
    'Next: dalan wait j1 --timeout 3600, then dalan get j1',
  ]);
});
