import assert from 'node:assert/strict';
import test from 'node:test';
import { createDestinations } from './destinations/index.mjs';

test('an invalid destination is rejected without quoting its raw address', async () => {
  const destinations = createDestinations({});
  await assert.rejects(destinations.for('fixture:ordinary-note'), {
    code: 'INVALID_DELIVERY_MODE',
    message: 'invalid delivery mode',
  });
});
