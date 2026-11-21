import test from 'node:test';
import assert from 'node:assert/strict';
import {assertClaimAuthority} from '../transitions.mjs';

const command = {job:'fixture-job',subject:'fixture-subject',worker:'fixture-worker',claim:'fixture-claim',epoch:1};
const authority = {...command,active:true,leaseUntil:10};

test('the final tick before the deadline is valid and the deadline is exclusive', () => {
  assert.doesNotThrow(() => assertClaimAuthority(command, authority, 9));
  assert.throws(() => assertClaimAuthority(command, authority, 10), {code:'lease_expired'});
});

test('identity mismatch retains precedence over the deadline check', () => {
  assert.throws(() => assertClaimAuthority(command, {...authority,epoch:2}, 10), {code:'stale_authority'});
});
