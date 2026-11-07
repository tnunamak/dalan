#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';

const store = new Store(':memory:');
const candidate = {
  candidate_id: 'cand_replace_guard',
  request_id: 'req_replace_guard',
  kind: 'patch',
  linked_from: null,
  patch: Buffer.from('original patch'),
  patch_digest: createHash('sha256').update('original patch').digest('hex'),
  patch_base_sha: 'b'.repeat(40),
  target_sha: 'c'.repeat(40),
  github_repo: 'example/repo',
};

try {
  store.putIntegrationCandidate(candidate);
  const verification = store.recordIntegrationVerification({
    candidate_id: candidate.candidate_id,
    patch_digest: candidate.patch_digest,
    patch_base_sha: candidate.patch_base_sha,
    target_sha: candidate.target_sha,
    target_ref: 'main',
    status: 'verified',
    checks: [],
  });

  let insertOrReplaceRejected = false;
  try {
    store.db.prepare(`INSERT OR REPLACE INTO integration_candidates
      (candidate_id,request_id,kind,linked_from,patch,patch_digest,patch_base_sha,target_sha,github_repo,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(candidate.candidate_id,'req_replaced','patch',null,Buffer.from('replacement patch'),'d'.repeat(64),candidate.patch_base_sha,candidate.target_sha,'example/repo','later');
  } catch { insertOrReplaceRejected = true; }

  let replaceIntoRejected = false;
  try {
    store.db.prepare(`REPLACE INTO integration_verifications
      (verification_id,candidate_id,patch_digest,patch_base_sha,target_sha,target_ref,status,checks_json,error,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(verification.verification_id,candidate.candidate_id,'e'.repeat(64),candidate.patch_base_sha,candidate.target_sha,'other','failed','[]',null,'later');
  } catch { replaceIntoRejected = true; }

  assert.deepEqual({ insertOrReplaceRejected, replaceIntoRejected }, { insertOrReplaceRejected: true, replaceIntoRejected: true },
    'both REPLACE forms must be rejected for immutable candidate and verification rows');
  assert.deepEqual(store.getIntegrationCandidate(candidate.candidate_id).patch, candidate.patch);
  const saved = store.integrationVerifications(candidate.candidate_id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'verified');
  assert.equal(saved[0].patch_digest, candidate.patch_digest);
  console.log('integration-store-immutability-test: REPLACE cannot alter candidates or verification history');
} finally {
  store.db.close();
}
