import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertClaimAuthority, canonicalJson, decide } from '../index.mjs';

test('canonical JSON sorts nested keys and preserves array order', () => {
  assert.equal(canonicalJson({ z: [3, { b: 2, a: 1 }], a: true }), '{"a":true,"z":[3,{"a":1,"b":2}]}');
  assert.throws(() => canonicalJson({ bad: Infinity }, 'bad_value'), { code: 'bad_value' });
});

test('canonical JSON rejects an undefined array cell instead of serializing it as null', () => {
  assert.throws(() => canonicalJson({ values: [1, undefined] }), {
    name: 'Error', code: 'invalid_json', message: 'invalid_json',
  });
});

test('canonical JSON rejects a Date rather than silently converting it to text', () => {
  assert.throws(() => canonicalJson({ created: new Date(0) }, 'unsupported_value'), {
    name: 'Error', code: 'unsupported_value', message: 'unsupported_value',
  });
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

test('claim authority is tied to each exact command identity and active status', () => {
  const command = { job: 'job-a', subject: 'subject-a', worker: 'worker-a', claim: 'claim-a', epoch: 2 };
  const authority = { ...command, active: true, leaseUntil: 20 };
  for (const [field, different] of [['job', 'job-b'], ['subject', 'subject-b'], ['worker', 'worker-b'], ['claim', 'claim-b'], ['active', false]]) {
    assert.throws(() => assertClaimAuthority(command, { ...authority, [field]: different }, 19),
      { code: 'stale_authority' }, field);
  }
  assert.throws(() => assertClaimAuthority(command, { ...authority, leaseUntil: 20.5 }, 19), { code: 'lease_expired' });
});

test('renew accepts the exact maximum and rejects invalid duration shape or overflow', () => {
  const snapshot = { revision: 4 };
  const command = { expectedRevision: 4, operation: 'renew' };
  const context = { now: 10, maxLeaseMs: 8 };
  assert.equal(decide(snapshot, { ...command, args: { leaseMs: 8 } }, context).leaseUntil, 18);
  for (const args of [{}, { leaseMs: 0 }, { leaseMs: 0.5 }, { leaseMs: 2, extra: true }]) {
    assert.throws(() => decide(snapshot, { ...command, args }, context), { code: 'invalid_lease' });
  }
  assert.throws(() => decide(snapshot, { ...command, args: { leaseMs: 2 } },
    { ...context, now: Number.MAX_SAFE_INTEGER - 1 }), { code: 'invalid_lease' });
});

test('canonical JSON rejects unsupported leaves while keeping the caller-specific error code', () => {
  for (const unsupported of [undefined, new Date(0), 1n]) {
    assert.throws(() => canonicalJson({ nested: [unsupported] }, 'bad_argument'), { code: 'bad_argument' });
  }
  assert.equal(canonicalJson({ nested: [null, false, 0, ''] }), '{"nested":[null,false,0,""]}');
});

test('canonical JSON permits a shared object to appear in sibling branches', () => {
  const shared = { z: 'last', a: 'first' };
  assert.equal(
    canonicalJson({ right: [shared], left: shared }),
    '{"left":{"a":"first","z":"last"},"right":[{"a":"first","z":"last"}]}'
  );
});

test('canonical JSON treats shared branches like independently allocated equal branches', () => {
  const shared = { values: ['second', 'first'] };
  assert.equal(
    canonicalJson([shared, shared]),
    canonicalJson([{ values: ['second', 'first'] }, { values: ['second', 'first'] }])
  );
  assert.deepEqual(shared, { values: ['second', 'first'] });
});
