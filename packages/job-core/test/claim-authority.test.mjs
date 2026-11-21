import assert from 'node:assert/strict';
import test from 'node:test';
import {assertClaimAuthority} from '../transitions.mjs';

const command = Object.freeze({
  job:'fixture-job', subject:'fixture-subject', worker:'fixture-worker',
  claim:'fixture-claim', epoch:1,
});
const authority = Object.freeze({...command, active:true, leaseUntil:100});

test('claim authority requires every binding and the active flag', () => {
  for (const [field, value] of Object.entries({
    job:'different-job', subject:'different-subject', worker:'different-worker',
    claim:'different-claim', epoch:2, active:false,
  })) {
    assert.throws(() => assertClaimAuthority(command, {...authority, [field]:value}, 99),
      {code:'stale_authority'}, field);
  }
  assert.throws(() => assertClaimAuthority(command, null, 99), {code:'stale_authority'});
});

test('claim authority treats the lease deadline as exclusive', () => {
  assert.doesNotThrow(() => assertClaimAuthority(command, authority, 99));
  assert.throws(() => assertClaimAuthority(command, authority, 100), {code:'lease_expired'});
  for (const leaseUntil of [undefined, NaN, Infinity, -1, 100.5, '100']) {
    assert.throws(() => assertClaimAuthority(command, {...authority, leaseUntil}, 99),
      {code:'lease_expired'}, String(leaseUntil));
  }
});
