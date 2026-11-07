#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { verifySealedResult } from '../src/integrator.mjs';
await import('./require-integrator-host-budget.mjs');

const scratch=path.join(os.homedir(),'.tmp','dalan-integrator');
fs.mkdirSync(scratch,{recursive:true,mode:0o700});
const fixture=fs.mkdtempSync(path.join(scratch,'integrator-attempt-trace-'));
const repo=path.join(fixture,'repo');
fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',['-C',repo,'-c','user.name=attempt trace test','-c','user.email=attempt@example.invalid',...args],{encoding:'utf8'}).trim();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
git('init','--quiet','-b','main');
fs.writeFileSync(path.join(repo,'note.txt'),'before\n');
fs.writeFileSync(path.join(repo,'.dot-bridge.json'),JSON.stringify({checks:{unit:{argv:['/runtime/node','-e','process.exitCode=0']}}}));
git('add','-A');
git('commit','-m','base','--quiet');
const baseSha=git('rev-parse','HEAD');
fs.writeFileSync(path.join(repo,'note.txt'),'after\n');
const patch=Buffer.from(execFileSync('git',['-C',repo,'diff','--binary'],{encoding:'utf8'}));
fs.writeFileSync(path.join(repo,'note.txt'),'before\n');

function sealedResult(requestId) {
  return {request_id:requestId,review:false,github_repo:'example/repo',assignment:{execution_scope:'implementation',inputs:[{github_repo:'example/repo',base_sha:baseSha}],
    evidence_plan:{schema_version:1,checks:[{id:'unit',argv:['/runtime/node','-e','process.exitCode=0'],issuer:'assignment',trust_profile:'bridge_verified'}]}},
    patch,patch_sha256:digest(patch),patch_base_sha:baseSha};
}

const interruptedStore=new Store(':memory:');
let interruptedCandidateId=null;
if(typeof interruptedStore.beginIntegrationVerification==='function') {
  const begin=interruptedStore.beginIntegrationVerification.bind(interruptedStore);
  interruptedStore.beginIntegrationVerification=(candidates,verification)=>{
    interruptedCandidateId=verification.candidate_id;
    begin(candidates,verification);
    throw new Error('simulated interruption after verification attempt commit');
  };
} else {
  const put=interruptedStore.putIntegrationCandidate.bind(interruptedStore);
  interruptedStore.putIntegrationCandidate=candidate=>{
    const row=put(candidate);
    interruptedCandidateId=row.candidate_id;
    throw new Error('simulated interruption after candidate insert');
  };
}
await assert.rejects(()=>verifySealedResult({store:interruptedStore,sealedResult:sealedResult('req_crash_trace'),repoDir:repo,targetBaseRef:'main',
  scratchRoot:path.join(fixture,'crash-scratch')}));
const interrupted=interruptedStore.integrationVerifications(interruptedCandidateId);
assert.equal(interrupted.length,1,'the candidate insert and in-progress attempt must commit together');
assert.match(interrupted[0].error,/verification interrupted/i);
interruptedStore.db.close();

const failedWriteStore=new Store(':memory:');
const record=failedWriteStore.recordIntegrationVerification.bind(failedWriteStore);
failedWriteStore.recordIntegrationVerification=verification=>{
  if(verification.error==='verification interrupted before completion') return record(verification);
  throw new Error('simulated final verification record failure');
};
const inMemory=await verifySealedResult({store:failedWriteStore,sealedResult:sealedResult('req_record_failure'),repoDir:repo,targetBaseRef:'main',
  scratchRoot:path.join(fixture,'record-scratch')});
assert.equal(inMemory.status,'verified');
assert.equal(inMemory.verification_recorded,false,'final persistence failure must be explicit in the returned outcome');
assert.equal(inMemory.verification.checks[0].status,'passed','the in-memory checks must survive a final persistence failure');
assert.equal(failedWriteStore.integrationVerifications(inMemory.candidate.candidate_id).length,1,
  'the durable interrupted attempt must remain when the final record cannot be written');
assert.match(inMemory.verification.recording_error,/simulated final verification record failure/);
failedWriteStore.db.close();
console.log('integrator-attempt-trace-test: interrupted attempts persist and final write errors preserve results');
