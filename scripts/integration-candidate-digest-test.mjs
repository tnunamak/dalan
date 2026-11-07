#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';

const store=new Store(':memory:');
const patch=Buffer.from('candidate bytes');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const candidate={candidate_id:'cand_abcdef0123456789abcdef0123456789',request_id:'request-digest',kind:'patch',linked_from:null,patch,
  patch_digest:digest(patch),patch_base_sha:'b'.repeat(40),target_sha:'c'.repeat(40),github_repo:'example/repo'};
const mismatched={...candidate,candidate_id:'cand_0123456789abcdef0123456789abcdef',patch_digest:digest(Buffer.from('different bytes'))};

assert.throws(()=>store.putIntegrationCandidate(mismatched),/patch digest.*bytes|digest.*patch bytes/i,
  'the Store must not persist a caller-supplied digest that does not describe the patch bytes');
assert.equal(store.getIntegrationCandidate(mismatched.candidate_id),null,'a digest mismatch creates no candidate row');
assert.equal(store.putIntegrationCandidate(candidate).patch_digest,digest(patch));
store.db.close();
console.log('integration-candidate-digest-test: stored patch bytes match the immutable digest');
