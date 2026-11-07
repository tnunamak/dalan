#!/usr/bin/env node
// The bridge's own git calls (mirror fetch, worktree add, apply, diff, ls-files) run outside the check sandbox. They must not run
// code chosen by the host's git configuration or by repository content: hooks via core.hooksPath, filter/LFS smudge and clean drivers,
// fsmonitor, or an external diff. The host user's own <home>/.gitconfig (git-lfs installs a filter there) and the system config must not apply.
// Each hostile entry writes a marker file when git runs it; no marker may appear across the whole workspace lifecycle.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-gitiso-'));process.env.HOME=home;process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
const {Store}=await import('../src/store.mjs'),{Workspace}=await import('../src/workspace.mjs');
const run=(cmd,args,cwd,env=process.env)=>{const x=spawnSync(cmd,args,{cwd,encoding:'utf8',env});if(x.status!==0)throw new Error(x.stderr||x.stdout);return x.stdout.trim();};
const assert=(x,m)=>{if(!x)throw new Error(m);};
try {
  const markers=path.join(home,'markers');fs.mkdirSync(markers);
  const evil=name=>{const f=path.join(home,`evil-${name}.sh`);fs.writeFileSync(f,`#!/bin/sh\ntouch '${markers}/${name}'\ncat\n`,{mode:0o755});return f;};
  const hooks=path.join(home,'hooks');fs.mkdirSync(hooks);
  for(const hook of ['post-checkout','post-index-change','reference-transaction','pre-auto-gc']) fs.writeFileSync(path.join(hooks,hook),`#!/bin/sh\ntouch '${markers}/hook-${hook}'\n`,{mode:0o755});
  // Fixture repo built with a clean config, before the hostile global config exists.
  const clean={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  const repo=path.join(home,'repo');fs.mkdirSync(repo);run('git',['init','-q'],repo,clean);run('git',['config','user.email','t@example.com'],repo,clean);run('git',['config','user.name','T'],repo,clean);
  fs.writeFileSync(path.join(repo,'.gitattributes'),'* filter=evil diff=evil\n*.bin filter=lfs\n');
  fs.writeFileSync(path.join(repo,'hello.txt'),'before\n');fs.writeFileSync(path.join(repo,'data.bin'),'binary\n');
  run('git',['add','.'],repo,clean);run('git',['commit','-qm','base'],repo,clean);
  const base=run('git',['rev-parse','HEAD'],repo,clean);process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
  // The hostile host configuration, in the place git reads by default.
  fs.writeFileSync(path.join(home,'.gitconfig'),[
    '[core]',`\thooksPath = ${hooks}`,`\tfsmonitor = ${evil('fsmonitor')}`,
    '[filter "evil"]',`\tsmudge = ${evil('smudge')}`,`\tclean = ${evil('clean')}`,`\tprocess = ${evil('process')}`,
    '[filter "lfs"]',`\tsmudge = ${evil('lfs-smudge')}`,`\tclean = ${evil('lfs-clean')}`,'\trequired = true',
    '[diff "evil"]',`\ttextconv = ${evil('textconv')}`,`\tcommand = ${evil('diff-command')}`,
    '[diff]',`\texternal = ${evil('diff-external')}`,
    '[gc]','\tauto = 1',''].join('\n'));
  // Inherited environment: a parent `git -c` (GIT_CONFIG_PARAMETERS), an env-supplied config entry and an external diff program.
  process.env.GIT_CONFIG_PARAMETERS=`'filter.evil.smudge'='${evil('env-parameters')}'`;
  Object.assign(process.env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'filter.evil.clean',GIT_CONFIG_VALUE_0:evil('env-count'),GIT_EXTERNAL_DIFF:evil('env-external-diff')});
  // Git still reads $XDG_CONFIG_HOME/git/ignore (default <config>/git/ignore) and git/attributes without any global config file.
  // A host ignore pattern must not hide a worker-written file from the bridge's diff.
  fs.mkdirSync(path.join(home,'.config/git'),{recursive:true});fs.writeFileSync(path.join(home,'.config/git/ignore'),'CLAUDE.md\n**/hidden/\n');
  fs.writeFileSync(path.join(home,'.config/git/attributes'),'*.txt filter=evil\n');
  const store=new Store(path.join(home,'db.sqlite')),ws=new Workspace(store);
  const id=`req_${randomUUID()}`;
  store.submit({schema_version:1,request_id:id,brief:'edit',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'patch',execution_scope:'implementation'},'thread','env','owner');
  const claim=store.claim(id,'dot','subject',2).claim_id;
  const firedBy=step=>{const fired=fs.readdirSync(markers);if(fired.length) throw new Error(`host git configuration ran code during ${step}: ${fired.join(', ')}`);};
  try {assert(ws.read(id,claim,'subject','hello.txt').text==='before\n','workspace is created with the committed bytes');} catch(e) {firedBy('checkout');throw e;}
  firedBy('checkout');
  ws.apply(id,claim,'subject','diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n');
  fs.writeFileSync(path.join(home,'work/worktrees',id,'new.txt'),'untracked\n');
  fs.mkdirSync(path.join(home,'work/worktrees',id,'tests/hidden'),{recursive:true});
  fs.writeFileSync(path.join(home,'work/worktrees',id,'CLAUDE.md'),'worker\n');fs.writeFileSync(path.join(home,'work/worktrees',id,'tests/hidden/evil.test.cjs'),'x\n');
  const result=ws.result(id,claim,'subject');
  assert(result.diff_preview.includes('+after')&&result.diff_preview.includes('new.txt'),'diff still reports tracked and untracked changes');
  assert(result.diff_preview.includes('CLAUDE.md')&&result.diff_preview.includes('tests/hidden/evil.test.cjs'),'host ignore file must not hide worker-written files from the diff');
  const fired=fs.readdirSync(markers);
  assert(fired.length===0,`host git configuration ran code: ${fired.join(', ')}`);
  console.log('PASS bridge git calls ignore host hooks, filters, LFS, fsmonitor and external diff');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
