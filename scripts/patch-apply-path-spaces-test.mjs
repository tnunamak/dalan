#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPatch } from '../src/patch-apply.mjs';
import { gitEnv } from '../src/git-env.mjs';

const scratch=path.join(os.homedir(),'.tmp','dalan-integrator');
fs.mkdirSync(scratch,{recursive:true,mode:0o700});
const fixture=fs.mkdtempSync(path.join(scratch,'patch-apply-path-spaces-'));
const repo=path.join(fixture,'repo');
fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',['-C',repo,'-c','user.name=path test','-c','user.email=path@example.invalid',...args],{encoding:'utf8'}).trim();
git('init','--quiet','-b','main');
fs.writeFileSync(path.join(repo,'file with spaces.txt'),'before\n');
git('add','-A');git('commit','-m','base','--quiet');
const baseSha=git('rev-parse','HEAD');
fs.writeFileSync(path.join(repo,'file with spaces.txt'),'after\n');
const patch=Buffer.from(execFileSync('git',['-C',repo,'diff','--binary'],{encoding:'utf8'}));
fs.writeFileSync(path.join(repo,'file with spaces.txt'),'before\n');
const files=applyPatch({dir:repo,patch,sha256:createHash('sha256').update(patch).digest('hex'),baseSha,env:gitEnv({PATH:'/usr/bin:/bin',HOME:fixture})});
assert.deepEqual(files,['file with spaces.txt'],'the reported path must preserve Git-quoted spaces');
assert.equal(fs.readFileSync(path.join(repo,'file with spaces.txt'),'utf8'),'after\n');
console.log('patch-apply-path-spaces-test: touched paths preserve spaces');
