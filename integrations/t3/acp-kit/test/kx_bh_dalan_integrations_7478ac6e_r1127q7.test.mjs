import assert from 'node:assert/strict';
import test from 'node:test';
import { CANCEL_BUDGET_MS, CANCEL_CLEANUP_MS, T3_CANCEL_WINDOW_MS, cancelBudgetMs } from '../src/errors.mjs';

test('an environment override cannot consume the cancellation cleanup window', () => {
  const latestSafeReply = T3_CANCEL_WINDOW_MS - CANCEL_CLEANUP_MS;
  assert.equal(cancelBudgetMs(String(latestSafeReply)), latestSafeReply);
  assert.equal(cancelBudgetMs(String(latestSafeReply + 1)), CANCEL_BUDGET_MS);
  assert.equal(cancelBudgetMs('12000'), CANCEL_BUDGET_MS);
});
