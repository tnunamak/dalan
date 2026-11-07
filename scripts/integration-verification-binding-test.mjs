#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';

const store = new Store(':memory:');
const candidate = {
  candidate_id: 'cand_verification_binding',
  request_id: 'req_verification_binding',
  kind: 'patch',
  linked_from: null,
  patch: Buffer.from('bound patch'),
  patch_digest: createHash('sha256').update('bound patch').digest('hex'),
  patch_base_sha: 'b'.repeat(40),
  target_sha: 'c'.repeat(40),
  github_repo: 'example/repo',
};

try {
  store.putIntegrationCandidate(candidate);
  const mismatches = [
    { patch_digest: 'd'.repeat(64) },
    { patch_base_sha: 'e'.repeat(40) },
    { target_sha: 'f'.repeat(40) },
  ];
  const accepted = mismatches.map(changes => {
    try {
      store.recordIntegrationVerification({
        candidate_id: candidate.candidate_id,
        patch_digest: candidate.patch_digest,
        patch_base_sha: candidate.patch_base_sha,
        target_sha: candidate.target_sha,
        target_ref: 'main',
        status: 'verified',
        checks: [],
        ...changes,
      });
      return true;
    } catch {
      return false;
    }
  });

  assert.deepEqual(accepted, [false, false, false], 'verification must reject digest, patch-base, and target mismatches');
  assert.deepEqual(store.integrationVerifications(candidate.candidate_id), [], 'rejected verification leaves no rows');
  console.log('integration-verification-binding-test: verification rows stay bound to candidate digest and SHAs');
} finally {
  store.db.close();
}
