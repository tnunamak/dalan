#!/usr/bin/env node
// workspace_result and the check path call diff(), which reads every untracked file. A check can leave a symlink in the workspace
// (sample-repo's tests write lock symlinks into a scratch dir under the repo root). That used to throw 'symlink traversal denied'
// and fail workspace_result, and a check whose post-run diff threw lost its output. Untracked symlinks are now left out of the diff,
// while every path a worker names (read, list, apply_patch) still refuses symlinks.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-symlink-'));process.env.HOME=home;process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
const {Store}=await import('../src/store.mjs'),{Workspace}=await import('../src/workspace.mjs');
const run=(cmd,args,cwd)=>{const x=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(x.status!==0)throw new Error(x.stderr||x.stdout);return x.stdout.trim();};
const assert=(x,m)=>{if(!x)throw new Error(m);};
const refused=(fn,pattern,m)=>{try{fn();}catch(e){if(pattern.test(e.message)) return;throw new Error(`${m}: wrong error ${e.message}`);}throw new Error(`${m}: accepted`);};
try {
  const repo=path.join(home,'repo');fs.mkdirSync(repo);run('git',['init','-q'],repo);run('git',['config','user.email','t@example.com'],repo);run('git',['config','user.name','T'],repo);
  fs.writeFileSync(path.join(repo,'hello.txt'),'before\n');run('git',['add','.'],repo);run('git',['commit','-qm','base'],repo);
  const base=run('git',['rev-parse','HEAD'],repo);process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
  const store=new Store(path.join(home,'db.sqlite')),ws=new Workspace(store);
  const id=`req_${randomUUID()}`;
  store.submit({schema_version:1,request_id:id,brief:'review',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'findings',execution_scope:'implementation'},'thread','env','owner');
  const claim=store.claim(id,'dot','subject',2).claim_id,dir=path.join(home,'work/worktrees',id);
  assert(ws.read(id,claim,'subject','hello.txt').text==='before\n','workspace is created');

  // What a running sample-repo check leaves: a scratch dir holding lock symlinks whose target is JSON text, not a path.
  const lockDir=path.join(dir,'.review-enrollment-abc/state/app.lock.owners-v1');fs.mkdirSync(lockDir,{recursive:true});
  fs.symlinkSync('{"token":"t","pid":1}',path.join(lockDir,'t.choosing'));fs.symlinkSync('/etc/passwd',path.join(dir,'top-level-link'));
  fs.writeFileSync(path.join(dir,'.review-enrollment-abc/state/note.txt'),'scratch\n');
  const result=ws.result(id,claim,'subject');
  assert(result.diff_preview.includes('note.txt'),'regular untracked files still enter the diff');
  assert(!result.diff_preview.includes('choosing')&&!result.diff_preview.includes('top-level-link')&&!result.diff_preview.includes('/etc/passwd'),'untracked symlinks must stay out of the diff');
  assert(!ws.diff(dir,base).patch.includes('lock.owners'),'diff() leaves symlinks out');

  // A file that vanishes between the listing and the read (a temp file of a running check) is skipped, not fatal.
  const temp=path.join(dir,'.review-enrollment-abc/tmp.txt');fs.writeFileSync(temp,'x\n');
  const realLstat=fs.lstatSync;let removed=false;fs.lstatSync=(p,...rest)=>{if(!removed&&String(p)===temp){removed=true;fs.unlinkSync(temp);}return realLstat(p,...rest);};
  try{assert(!ws.diff(dir,base).patch.includes('tmp.txt'),'vanished file skipped');}finally{fs.lstatSync=realLstat;}
  assert(removed,'the race hook ran');

  // The security property: a symlink inside a path the worker names is still refused.
  refused(()=>ws.read(id,claim,'subject','top-level-link'),/symlink traversal denied/,'read of a symlink');
  refused(()=>ws.read(id,claim,'subject','.review-enrollment-abc/state/app.lock.owners-v1/t.choosing'),/symlink traversal denied/,'read of a nested symlink');
  refused(()=>ws.list(id,claim,'subject','top-level-link'),/symlink traversal denied/,'list of a symlink');
  fs.symlinkSync('/etc',path.join(dir,'linkdir'));
  refused(()=>ws.read(id,claim,'subject','linkdir/passwd'),/symlink traversal denied/,'read through a symlinked directory');
  const through='diff --git a/linkdir/x.txt b/linkdir/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/linkdir/x.txt\n@@ -0,0 +1 @@\n+x\n';
  refused(()=>ws.apply(id,claim,'subject',through),/symlink traversal denied/,'patch through a symlinked directory');
  const mode='diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+/etc/passwd\n';
  refused(()=>ws.apply(id,claim,'subject',mode),/symlink, submodule or rename denied/,'patch that adds a symlink');
  console.log('PASS untracked symlinks and vanished files no longer fail workspace_result; named paths still refuse symlinks');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
