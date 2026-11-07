#!/usr/bin/env node
// A sensitive-path exclusion must hold on case-insensitive and Unicode-normalizing filesystems (macOS APFS), where
// docs/PRIVATE-NOTE.TXT opens docs/private-note.txt. This suite runs on case-sensitive Linux, so it proves the matcher
// and the fail-closed cap directly, and a read of a case alias of an excluded path.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateSubmission } from '../src/submission-policy.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-case-'));process.env.HOME=home;process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
const {Store}=await import('../src/store.mjs'),{Workspace,canonicalPath,isExcludedPath}=await import('../src/workspace.mjs');
const run=(cmd,args,cwd)=>{const x=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(x.status!==0)throw new Error(x.stderr||x.stdout);return x.stdout.trim();};

// 1. the matcher compares NFC, lower-cased, per path component
const composed='café', decomposed='café';
assert.equal(canonicalPath('docs/PRIVATE-NOTE.TXT'),'docs/private-note.txt');
assert.equal(canonicalPath(`docs/${decomposed}.txt`),canonicalPath(`docs/${composed}.txt`));
const excluded=new Set(['docs/private-note.txt',`docs/${composed}.md`].map(canonicalPath));
for(const alias of ['docs/private-note.txt','docs/PRIVATE-NOTE.TXT','docs/Private-Note.txt','DOCS/private-note.txt',`docs/${composed}.md`,`docs/${decomposed}.md`,`docs/${decomposed.toUpperCase()}.md`])
  assert(isExcludedPath(alias,excluded),`alias not excluded: ${alias}`);
for(const other of ['docs/private-note.txt.bak','docs/other.txt','docs/private/note.txt']) assert(!isExcludedPath(other,excluded),`wrongly excluded: ${other}`);

// 2. when narrowing around an exclusion would pass the cap, the submission is refused, never kept broad
const siblings=Array.from({length:201},(_,i)=>`docs/n${i}.md`), files=['docs/auth-token.json',...siblings];
const task={schema_version:1,request_id:'req_case_0001',brief:'Read the docs.',expected_output:'A summary',execution_scope:'read-only',scope_paths:['docs'],inputs:[{github_repo:'example-owner/fixture',base_sha:'a'.repeat(40)}]};
assert.throws(()=>validateSubmission(task,{scanInput:()=>({files,diffFiles:[],diff:'',symlinks:[]}),excludeSensitive:true}),/too many files to exclude from "docs".*submit a narrower scope/s);

// 3. read_file of a case alias of an excluded path is refused (and is not served from a differently-cased file)
try {
  const repo=path.join(home,'repo');fs.mkdirSync(path.join(repo,'docs'),{recursive:true});run('git',['init','-q'],repo);run('git',['config','user.email','test@example.com'],repo);run('git',['config','user.name','Test'],repo);
  fs.writeFileSync(path.join(repo,'docs/private-note.txt'),'secret\n');fs.writeFileSync(path.join(repo,'docs/public.txt'),'ok\n');fs.writeFileSync(path.join(repo,'docs/Private-Note.txt'),'alias\n');
  run('git',['add','.'],repo);run('git',['commit','-qm','base'],repo);const base=run('git',['rev-parse','HEAD'],repo);
  process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
  const store=new Store(path.join(home,'db.sqlite')),ws=new Workspace(store),id=`req_${randomUUID()}`;
  store.submit({schema_version:1,request_id:id,brief:'fixture',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'findings',execution_scope:'read-only',scope_paths:['docs'],scope_excluded:[{path:'docs/private-note.txt',reason:'test'}]},'thread','environment','owner');
  const claim=store.claim(id,'dot','subject',10).claim_id;
  assert.equal(ws.read(id,claim,'subject','docs/public.txt').text,'ok\n');
  for(const alias of ['docs/private-note.txt','docs/PRIVATE-NOTE.TXT','docs/Private-Note.txt'])
    assert.throws(()=>ws.read(id,claim,'subject',alias),/outside scope_paths/,alias);
  const listed=ws.list(id,claim,'subject','docs').files;
  assert.deepEqual(listed,['docs/public.txt']);
} finally { fs.rmSync(home,{recursive:true,force:true}); }
console.log('PASS case and Unicode aliases of an excluded path stay excluded; an over-cap narrowing is refused');
