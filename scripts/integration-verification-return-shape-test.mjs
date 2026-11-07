#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';

const store=new Store(':memory:');
const patch=Buffer.from('verification result shape');
const candidate=store.putIntegrationCandidate({candidate_id:'cand_abcdefabcdefabcdefabcdefabcdefab',request_id:'request-shape',kind:'patch',linked_from:null,
  patch,patch_digest:createHash('sha256').update(patch).digest('hex'),patch_base_sha:'b'.repeat(40),target_sha:'c'.repeat(40),github_repo:'example/repo'});
const checks=[{id:'unit',issuer:'assignment',status:'passed'}];
const returned=store.recordIntegrationVerification({candidate_id:candidate.candidate_id,patch_digest:candidate.patch_digest,patch_base_sha:candidate.patch_base_sha,
  target_sha:candidate.target_sha,target_ref:'main',status:'verified',checks});

assert.deepEqual(returned.checks,checks,'the record method returns parsed checks like integrationVerifications()');
assert.equal(Object.hasOwn(returned,'checks_json'),false,'callers should not receive the storage-only JSON column');
assert.deepEqual(returned,store.integrationVerifications(candidate.candidate_id)[0]);
store.db.close();
console.log('integration-verification-return-shape-test: record and list return the same parsed shape');
