#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as integrator from '../src/integrator.mjs';
import { Store } from '../src/store.mjs';
await import('./require-integrator-host-budget.mjs');

const scratch=path.join(os.homedir(),'.tmp','dalan-integrator');
fs.mkdirSync(scratch,{recursive:true,mode:0o700});
const fixture=fs.mkdtempSync(path.join(scratch,'integrator-filter-context-'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const failures=[];

function git(dir,...args) {
  return execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
}

function makeRepo(name) {
  const root=path.join(fixture,name);
  fs.mkdirSync(root,{recursive:true});
  git(root,'init','--quiet','-b','main');
  git(root,'config','user.name','filter context test');
  git(root,'config','user.email','filter-context@example.invalid');
  fs.writeFileSync(path.join(root,'.gitattributes'),'*.txt filter=outside\n');
  fs.writeFileSync(path.join(root,'payload.txt'),'before\n');
  fs.writeFileSync(path.join(root,'.dot-bridge.json'),JSON.stringify({checks:{'patched-content':{argv:['/runtime/node','-e','process.exitCode=0']}}}));
  git(root,'add','-A');
  git(root,'commit','-m','filtered base','--quiet');
  const baseSha=git(root,'rev-parse','HEAD');
  fs.writeFileSync(path.join(root,'payload.txt'),'after\n');
  const patch=Buffer.from(git(root,'diff','--binary')+'\n');
  fs.writeFileSync(path.join(root,'payload.txt'),'before\n');
  const marker=path.join(fixture,`${name}-outside.marker`);
  const filter=path.join(fixture,`${name}-filter.sh`);
  fs.writeFileSync(filter,`#!/bin/sh\nprintf marker > '${marker}'\ncat\n`,{mode:0o700});
  return {root,baseSha,patch,marker,filter};
}

async function verify(repo,name) {
  const store=new Store(':memory:');
  try {
    return await integrator.verifySealedResult({
      store,
      sealedResult:{
        request_id:`req_${name}`,
        review:false,
        github_repo:'example/repo',
        assignment:{execution_scope:'implementation',inputs:[{github_repo:'example/repo',base_sha:repo.baseSha}],
          evidence_plan:{schema_version:1,checks:[
            {id:'patched-content',argv:['/runtime/node','-e','process.exitCode=0'],issuer:'assignment',trust_profile:'bridge_verified'},
          ]}},
        patch:repo.patch,
        patch_sha256:digest(repo.patch),
        patch_base_sha:repo.baseSha,
      },
      repoDir:repo.root,
      targetBaseRef:'main',
      scratchRoot:path.join(fixture,`${name}-scratch`),
    });
  } finally {
    store.db.close();
  }
}

const included=makeRepo('includeif');
const includeFile=path.join(fixture,'includeif-filter.config');
fs.writeFileSync(includeFile,`[filter "outside"]\n smudge = ${included.filter}\n`);
git(included.root,'config','--local',`includeIf.gitdir:${included.root}/.git/worktrees/**.path`,includeFile);
try {
  const verification=await verify(included,'includeif');
  assert.equal(fs.readFileSync(path.join(verification.scratch_dir,'payload.txt'),'utf8'),'after\n');
  assert.equal(verification.status,'verified','includeIf worktree checkout must complete and pass its evidence check');
  assert.equal(verification.verification.checks[0].status,'passed','the patched file must be present in the includeIf worktree');
  assert.equal(fs.existsSync(included.marker),false,'includeIf gitdir filter ran during host worktree checkout');
} catch(error) {
  failures.push(`includeIf gitdir context: ${error.message}`);
}

const worktreeConfig=makeRepo('worktree-config');
git(worktreeConfig.root,'config','extensions.worktreeConfig','true');
const checkout=path.join(fixture,'preconfigured-worktree');
git(worktreeConfig.root,'worktree','add','--no-checkout','--detach',checkout,worktreeConfig.baseSha);
const privateGitDir=git(checkout,'rev-parse','--absolute-git-dir');
fs.writeFileSync(path.join(privateGitDir,'config.worktree'),`[filter "outside"]\n smudge = ${worktreeConfig.filter}\n`);
try {
  assert.equal(git(checkout,'config','--get','filter.outside.smudge'),worktreeConfig.filter,
    'the worktree-specific smudge driver is active in the new worktree config context');
  assert.equal(typeof integrator.checkoutWorktreeWithoutFilters,'function',
    'integrator must expose the same safe checkout boundary used after worktree add --no-checkout');
  const envWithoutConfigCount={PATH:'/usr/bin:/bin',HOME:fixture,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1'};
  integrator.checkoutWorktreeWithoutFilters(checkout,worktreeConfig.baseSha,envWithoutConfigCount);
  assert.equal(fs.readFileSync(path.join(checkout,'payload.txt'),'utf8'),'before\n',
    'the config.worktree case must complete an actual checkout rather than pass because checkout aborted');
  assert.equal(fs.existsSync(worktreeConfig.marker),false,'config.worktree filter ran during host worktree checkout');
} catch(error) {
  failures.push(`config.worktree context: ${error.message}`);
}

assert.deepEqual(failures,[],failures.join('\n'));
console.log('integrator-worktree-filter-context-test: includeIf and config.worktree filter drivers stayed disabled');
