#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { verifySealedResult } from '../src/integrator.mjs';

const maxPatchBytes=262144;
const patch=Buffer.alloc(maxPatchBytes+1,0x70);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const store=new Store(':memory:');
const candidate={candidate_id:'cand_abcdef0123456789abcdef0123456789',request_id:'request-large',kind:'patch',linked_from:null,patch,
  patch_digest:digest(patch),patch_base_sha:'b'.repeat(40),target_sha:'c'.repeat(40),github_repo:'example/repo'};

assert.throws(()=>store.putIntegrationCandidate(candidate),/patch.*too large|patch.*262144/i,
  'the Store must reject oversized candidate blobs before writing them');
assert.equal(store.getIntegrationCandidate(candidate.candidate_id),null);
await assert.rejects(()=>verifySealedResult({store,sealedResult:{request_id:'request-large-verify',review:false,github_repo:'example/repo',
  assignment:{execution_scope:'implementation',inputs:[{github_repo:'example/repo',base_sha:'b'.repeat(40)}]},patch,patch_sha256:digest(patch),patch_base_sha:'b'.repeat(40)},
  repoDir:'/no-local-checkout-needed',targetBaseRef:'main',scratchRoot:path.join(os.homedir(),'.tmp','dalan-integrator','size-test')}),/patch.*too large|patch.*262144/i);
assert.equal(store.db.prepare('SELECT count(*) AS count FROM integration_candidates').get().count,0);
store.db.close();
console.log('integration-candidate-size-test: oversized patches are rejected before candidate storage');
