import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refusal, retryExpiredAssignment } from '../src/acp-bridge.mjs';

test('cancelled rows without verified expiry are refused', () => {
  const rows = [
    { status: 'cancelled', cancelled_reason: 'owner' },
    { status: 'cancelled' },
  ];
  for (const row of rows) {
    assert.throws(() => retryExpiredAssignment(row), Refusal);
  }
});
