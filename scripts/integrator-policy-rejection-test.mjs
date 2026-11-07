#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { verifySealedResult } from '../src/integrator.mjs';

const scratch=path.join(os.homedir(),'.tmp','dalan-integrator');
fs.mkdirSync(scratch,{recursive:true,mode:0o700});
const fixture=fs.mkdtempSync(path.join(scratch,'integrator-policy-rejection-'));
const repo=path.join(fixture,'repo');
fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',['-C',repo,'-c','user.name=integrator policy test','-c','user.email=policy@example.invalid',...args],{encoding:'utf8'}).trim();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

git('init','--quiet','-b','main');
fs.writeFileSync(path.join(repo,'note.txt'),'before\n');
git('add','-A');
git('commit','-m','base','--quiet');
const baseSha=git('rev-parse','HEAD');
git('config','apply.whitespace','error');
fs.writeFileSync(path.join(repo,'note.txt'),'after \n');
const patch=Buffer.from(execFileSync('git',['-C',repo,'diff','--binary'],{encoding:'utf8'}));
fs.writeFileSync(path.join(repo,'note.txt'),'before\n');
const store=new Store(':memory:');

try {
  const result=await verifySealedResult({store,sealedResult:{request_id:'req_policy_0001',review:false,github_repo:'example/repo',
    assignment:{execution_scope:'implementation',inputs:[{github_repo:'example/repo',base_sha:baseSha}],
      evidence_plan:{schema_version:1,checks:[{id:'unit',argv:['/runtime/node','-e','process.exitCode=0'],issuer:'assignment',trust_profile:'bridge_verified'}]}},
    patch,patch_sha256:digest(patch),patch_base_sha:baseSha},repoDir:repo,targetBaseRef:'main',scratchRoot:path.join(fixture,'scratch')});
  assert.equal(result.status,'failed','a host Git whitespace policy rejection is not a target conflict');
  assert.match(result.verification.error,/whitespace/i,'the record should preserve the policy reason');
  assert.equal(store.integrationVerifications(result.candidate.candidate_id).at(-1).status,'failed');
  console.log('integrator-policy-rejection-test: host whitespace policy failures are recorded as failed');
} finally {
  store.db.close();
}
