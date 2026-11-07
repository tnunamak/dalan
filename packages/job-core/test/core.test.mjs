import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertClaimAuthority, canonicalJson, decide } from '../index.mjs';

test('canonical JSON sorts nested keys and preserves array order', () => {
  assert.equal(canonicalJson({ z: [3, { b: 2, a: 1 }], a: true }), '{"a":true,"z":[3,{"a":1,"b":2}]}');
  assert.throws(() => canonicalJson({ bad: Infinity }, 'bad_value'), { code: 'bad_value' });
});

test('claim authority requires matching epoch and an unexpired deadline', () => {
  const command = { job: 'j', subject: 's', worker: 'w', claim: 'c', epoch: 2 };
  const authority = { ...command, active: true, leaseUntil: 10 };
  assert.doesNotThrow(() => assertClaimAuthority(command, authority, 9));
  assert.throws(() => assertClaimAuthority(command, { ...authority, epoch: 1 }, 9), { code: 'stale_authority' });
  assert.throws(() => assertClaimAuthority(command, authority, 10), { code: 'lease_expired' });
});

test('revision and lease decisions use supplied time', () => {
  const command = { expectedRevision: 2, operation: 'renew', args: { leaseMs: 7 } };
  assert.deepEqual(decide({ revision: 2 }, command, { now: 10, maxLeaseMs: 9 }), {
    events: [], effects: [{ type: 'advance_revision', expectedRevision: 2 }], leaseUntil: 17,
  });
  assert.throws(() => decide({ revision: 3 }, command, { now: 10, maxLeaseMs: 9 }), { code: 'revision_conflict' });
  assert.throws(() => decide({ revision: 2 }, command, { now: 10, maxLeaseMs: 6 }), { code: 'invalid_lease' });
  assert.throws(() => decide({ revision: Number.MAX_SAFE_INTEGER }, { ...command, expectedRevision: Number.MAX_SAFE_INTEGER }, { now: 10, maxLeaseMs: 9 }), { code: 'invalid_revision' });
});
