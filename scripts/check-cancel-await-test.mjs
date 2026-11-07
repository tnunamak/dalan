#!/usr/bin/env node
import './require-host-checks.mjs';
// Cancellation and claim rotation during awaited check preparation must prevent the next sandbox spawn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-check-cancel-await-'));
process.env.HOME=home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
delete process.env.DOT_BRIDGE_ALLOW_SHARED_NET_INSTALL;
const originalSpawn=childProcess.spawn;
let hook=null;
const wrappedSpawn=function(command,args=[],options={}) {
  const child=originalSpawn(command,args,options);
  const argv=Array.isArray(args)?args:[];
  if(hook?.kind==='digest'&&command==='git'&&argv.includes('ls-files')&&argv.includes('-v')) {
    const current=hook;hook=null;queueMicrotask(current.action);
  }
  const sandbox=argv.includes('/usr/bin/bwrap');
  if(hook&&sandbox) {
    hook.spawns++;
    if(argv[3]==='/usr/bin/pasta'&&hook.kind==='install-close') {
      const current=hook;
      child.once('close',()=>queueMicrotask(current.action));
    }
  }
  return child;
};
childProcess.spawn=wrappedSpawn;
syncBuiltinESMExports();
const {Store}=await import('../src/store.mjs');
const {Workspace}=await import('../src/workspace.mjs');
const run=(cmd,args,cwd)=>{const r=childProcess.spawnSync(cmd,args,{cwd,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr||r.stdout);return r.stdout.trim();};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  const repo=path.join(home,'repo');fs.mkdirSync(repo);run('git',['init','-q'],repo);run('git',['config','user.email','test@example.com'],repo);run('git',['config','user.name','Test'],repo);
  fs.writeFileSync(path.join(repo,'hello.txt'),'base\n');
  fs.writeFileSync(path.join(repo,'.dot-bridge.json'),JSON.stringify({checks:{default:{argv:['/runtime/node','-e','0'],timeout_ms:10000,output_bytes:4096}}}));
  run('git',['add','.'],repo);run('git',['commit','-qm','base'],repo);const base=run('git',['rev-parse','HEAD'],repo);
  process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE=repo;
  const store=new Store(path.join(home,'db.sqlite')),ws=new Workspace(store);
  function assignment({install=false}={}) {
    const id=`req_${randomUUID()}`,payload={schema_version:1,request_id:id,brief:'cancel during awaited preparation',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'patch',execution_scope:'implementation'};
    store.submit(payload,'thread','environment','owner');
    const claim=store.claim(id,'dot','subject',99).claim_id;
    ws.ensure(id,claim,'subject');
    const marker=`check-marker-${id}`;
    fs.writeFileSync(path.join(home,'work/worktrees',id,'.dot-bridge.json'),JSON.stringify({checks:{default:{...(install?{install_argv:['/runtime/node','-e','process.stdout.write("INSTALL")']}:{}),argv:['/runtime/node','-e',`require('node:fs').writeFileSync('${marker}','ran')`],timeout_ms:10000,output_bytes:4096}}}));
    return {id,claim,marker,dir:path.join(home,'work/worktrees',id)};
  }
  const failures=[];
  async function awaitDigestRace({install=false,rotate=false}={}) {
    const item=assignment({install});let spawns=0,rotated=null;
    hook={kind:'digest',spawns:0,action:()=>{if(rotate)rotated=store.resume(item.id,'subject');else store.cancel(item.id,'cancelled during tree digest');}};
    const pending=ws.check(item.id,item.claim,'subject','default');
    const started=await pending;
    spawns=hook?.spawns??0;
    // The digest hook clears itself before its action. Count actual bubblewrap/pasta launches independently below by run records.
    await sleep(50);
    if(!rotate&&store.get(item.id).status!=='cancelled') failures.push('tree-digest cancellation did not leave a cancelled assignment');
    if(rotate&&(!rotated||rotated.claim_id===item.claim||store.get(item.id).status!=='claimed')) failures.push('resume did not rotate the active claim while keeping the assignment claimed');
    if(ws.activeChecks.has(item.id)) failures.push('activeChecks stayed set after the interrupted check');
    if(fs.existsSync(path.join(item.dir,item.marker))) failures.push('check marker was written after tree-digest authority changed');
    // `started` may be a running response for unusually slow hosts; the check job is still fenced by its check-run row.
    if(started.check_run_id&&store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(started.check_run_id)?.status==='running') failures.push('cancelled check job stayed running');
    // Actual sandbox spawn count is tracked by a separate per-run counter around the spawn boundary below.
    if(raceSpawnCounts.at(-1)!==0) failures.push(`tree-digest race launched ${raceSpawnCounts.at(-1)} sandbox process(es)`);
  }
  const raceSpawnCounts=[];
  // Count only real sandbox launcher processes. `hook.spawns` is local to the moment of a digest hook and is not enough once cleared.
  const spawnWithCount=wrappedSpawn;
  childProcess.spawn=function(command,args=[],options={}) {
    const argv=Array.isArray(args)?args:[];
    if(command==='/usr/bin/pasta'||argv.includes('/usr/bin/bwrap')) raceSpawnCounts[raceSpawnCounts.length-1]=(raceSpawnCounts.at(-1)??0)+1;
    return spawnWithCount(command,args,options);
  };
  syncBuiltinESMExports();
  for(const scenario of [{},{install:true},{rotate:true}]) {
    raceSpawnCounts.push(0);
    await awaitDigestRace(scenario);
  }

  const gap=assignment({install:true});raceSpawnCounts.push(0);
  hook={kind:'install-close',spawns:0,action:()=>store.cancel(gap.id,'cancelled after install stop')};
  const gapResult=await ws.check(gap.id,gap.claim,'subject','default');
  await sleep(50);
  const gapSpawns=raceSpawnCounts.at(-1);
  if(gapSpawns!==1) failures.push(`install/check gap launched ${gapSpawns} sandbox process(es), expected install only`);
  if(fs.existsSync(path.join(gap.dir,gap.marker))) failures.push('check marker was written after install/check gap cancellation');
  if(store.get(gap.id).status!=='cancelled') failures.push('install/check gap cancellation did not leave a cancelled assignment');
  if(ws.activeChecks.has(gap.id)) failures.push('activeChecks stayed set after install/check cancellation');
  if(gapResult.check_run_id&&store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(gapResult.check_run_id)?.status==='running') failures.push('install/check gap job stayed running');

  assert.deepEqual(failures,[],`await-boundary authority failures: ${failures.join('; ')}`);
  console.log('check-cancel-await-test: PASS');
  store.db.close();
} finally {
  childProcess.spawn=originalSpawn;syncBuiltinESMExports();
  fs.rmSync(home,{recursive:true,force:true});
}
