import assert from 'node:assert/strict';
import test from 'node:test';
import { decide } from '../transitions.mjs';

const renew = (context, leaseMs = 1) => decide({ revision: 7 },
  { expectedRevision: 7, operation: 'renew', args: { leaseMs } }, context);

test('renew requires a positive safe-integer maximum lease', () => {
  for (const maximum of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => renew({ now: 50, maxLeaseMs: maximum }), { code: 'invalid_lease' }, String(maximum));
  }
  assert.throws(() => renew({ now: 50 }), { code: 'invalid_lease' });
});

test('renew requires a nonnegative safe-integer clock and deadline', () => {
  for (const now of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => renew({ now, maxLeaseMs: 10 }), { code: 'invalid_lease' }, String(now));
  }
  assert.throws(() => renew({ maxLeaseMs: 10 }), { code: 'invalid_lease' });
  assert.throws(() => renew({ now: Number.MAX_SAFE_INTEGER, maxLeaseMs: 1 }), { code: 'invalid_lease' });
});

test('renew preserves exact boundary deadlines and accepted effects', () => {
  const accepted = leaseUntil => ({ events: [], effects: [{ type: 'advance_revision', expectedRevision: 7 }], leaseUntil });
  const context = { now: 0, maxLeaseMs: 10 };
  assert.deepEqual(renew(context), accepted(1));
  assert.deepEqual(renew(context, 10), accepted(10));
  assert.throws(() => renew(context, 11), { code: 'invalid_lease' });
  assert.deepEqual(renew({ now: Number.MAX_SAFE_INTEGER - 1, maxLeaseMs: 1 }), accepted(Number.MAX_SAFE_INTEGER));
});
