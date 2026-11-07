#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';

const store=new Store(':memory:');
const patch=Buffer.from('candidate patch');
const candidate={candidate_id:'cand_0123456789abcdef0123456789abcdef',request_id:'request-race',kind:'patch',linked_from:null,patch,
  patch_digest:createHash('sha256').update(patch).digest('hex'),patch_base_sha:'b'.repeat(40),target_sha:'c'.repeat(40),github_repo:'example/repo'};
const prepare=store.db.prepare.bind(store.db);
let competingInsert=false;

// Model another verifier committing in the gap around this caller's insert attempt.
const injectCandidate=()=>{
  competingInsert=true;
  prepare('INSERT INTO integration_candidates(candidate_id,request_id,kind,linked_from,patch,patch_digest,patch_base_sha,target_sha,github_repo,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(candidate.candidate_id,candidate.request_id,candidate.kind,candidate.linked_from,candidate.patch,candidate.patch_digest,
      candidate.patch_base_sha,candidate.target_sha,candidate.github_repo,new Date().toISOString());
};
store.db.prepare=sql=>{
  const statement=prepare(sql);
  if(sql==='SELECT * FROM integration_candidates WHERE candidate_id=?') return {
    get(...parameters) {
      const row=statement.get(...parameters);
      if(!row&&!competingInsert) injectCandidate();
      return row;
    },
  };
  if(sql.startsWith('INSERT INTO integration_candidates(')&&sql.includes('ON CONFLICT(candidate_id) DO NOTHING')) return {
    run(...parameters) {
      if(!competingInsert) injectCandidate();
      return statement.run(...parameters);
    },
  };
  return statement;
};

const returned=store.putIntegrationCandidate(candidate);
assert.equal(competingInsert,true,'the test interleaved a competing candidate insert');
assert.equal(returned.candidate_id,candidate.candidate_id);
assert.equal(Buffer.from(returned.patch).equals(patch),true);
assert.deepEqual(store.getIntegrationCandidate(candidate.candidate_id),returned);
store.db.close();
console.log('integration-candidate-upsert-race-test: concurrent identical insert returns the existing candidate');
