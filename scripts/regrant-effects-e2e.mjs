#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';

if(!process.argv.includes('--store-only')) await import('./require-host-checks.mjs');
const temp=fs.mkdtempSync(path.join(os.homedir(),'.tmp','regrant-'));
const assignment=id=>({schema_version:1,request_id:id,brief:'effect fencing fixture',inputs:[],expected_output:'one report',execution_scope:'read-only'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const git=(args,cwd)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const marker=`J3OLD_${randomUUID().slice(0,8)}`;
const pids=()=>fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).filter(n=>{
  try{return fs.readFileSync(`/proc/${n}/cmdline`,'utf8').split('\0')[0]===marker;}catch{return false;}
}).map(Number);
async function until(test,label){for(let i=0;i<300;i++){if(await test())return;await sleep(50);}throw new Error(`timeout: ${label}`);}
let adapter;
try {
  for(const route of ['idle','resume','abandon']) {
    let now=100000;const store=new Store(path.join(temp,`${route}.db`),{now:()=>now,resumeIdleMs:10,limits:{leaseMs:1000}});
    try {
      const id=`req_${route}`;store.submit(assignment(id),{mode:'none'},null,'owner');
      const old=store.claim(id,'first','subject',6);now+=999;
      assert.equal(store.claim(id,'first','subject',6).claim_id,old.claim_id,'exact retry retains authority');
      const deadline=Date.parse(store.leaseExpiresAt(store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id)));
      const next=()=>route==='resume'?store.resume(id,'subject'):store.claim(id,'second','subject',6);
      if(route==='abandon')store.abandon(id);
      assert.throws(next,/claim_busy|already claimed/,'no early regrant');
      now=deadline;
      const grant=next();assert.equal(grant.epoch,2);assert.notEqual(grant.claim_id,old.claim_id);
      assert.throws(()=>store.progress(id,old.claim_id,'stale','subject'),/claim_superseded|invalid claim/);
      console.log(`PASS expiry-only ${route}, exact retry and stale progress`);
    }finally{store.db.close();}
  }
  {
    let now=100000;const store=new Store(path.join(temp,'ancestor.db'),{now:()=>now,limits:{leaseMs:1000}});
    try {
      const id='req_ancestor';store.submit(assignment(id),{mode:'none'},null,'owner');
      const first=store.claim(id,'first','subject',6);now+=1000;
      store.claim(id,'second','subject',6);
      store.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES('legacy-check',?,?,'default','x','interrupted',?)").run(id,first.claim_id,new Date(now).toISOString());
      now+=1000;
      assert.throws(()=>store.claim(id,'third','subject',6),/claim_effects_unverified/,'older epochs must also have stopped');
      store.recordSandboxStop('legacy-check','host',{verified:true,reason:'fixture_observed_stop'});
      assert.equal(store.claim(id,'third','subject',6).epoch,3);
      console.log('PASS unverified ancestor host work blocks regrant');
    }finally{store.db.close();}
  }
  {
    process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(temp,'recovered-work');
    const {Workspace}=await import('../src/workspace.mjs');
    let now=100000;const store=new Store(path.join(temp,'recovery.db'),{now:()=>now,limits:{leaseMs:1000}});
    try {
      const id='req_recovered';store.submit(assignment(id),{mode:'none'},null,'owner');
      const first=store.claim(id,'first','subject',6);
      store.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,stop_verified) VALUES('crashed-check',?,?,'default','x','running',?,1)").run(id,first.claim_id,new Date(now).toISOString());
      new Workspace(store);
      assert.equal(store.db.prepare("SELECT stop_verified FROM check_jobs WHERE id='crashed-check'").get().stop_verified,null,'a prior phase stop cannot prove the crashed job stopped');
      now+=1000;
      assert.throws(()=>store.claim(id,'second','subject',6),/claim_effects_unverified/);
      console.log('PASS recovery refuses regrant without a complete host-stop receipt');
    }finally{store.db.close();}
  }
  {
    process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(temp,'publication-race-work');
    const {Workspace}=await import('../src/workspace.mjs');
    let now=100000;const db=path.join(temp,'publication-race.db');
    const a=new Store(db,{now:()=>now,limits:{leaseMs:1000}}),b=new Store(db,{now:()=>now,limits:{leaseMs:1000}});
    try {
      const id='req_publication_race';a.submit(assignment(id),{mode:'none'},null,'owner');
      const old=a.claim(id,'first','subject',6);
      a.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES('live-old-check',?,?,'default','x','running',?)").run(id,old.claim_id,new Date(now).toISOString());
      const ws=Object.create(Workspace.prototype);ws.store=a;
      const original=ws.saveArtifact(id,old.claim_id,'check-output',Buffer.from('preserve-existing'),'art_collision123');
      assert.throws(()=>ws.saveArtifact(id,old.claim_id,'check-output',Buffer.from('overwrite'),'art_collision123'),/EEXIST/);
      assert.deepEqual(ws.artifact(original.artifact_id,id).bytes,Buffer.from('preserve-existing'),'artifact collision cleanup deleted or changed the pre-existing file');
      new Workspace(b); // recovery through connection B must not let connection A publish after B's regrant
      a.recordSandboxStop('live-old-check','host',{verified:true,reason:'fixture_positive_stop'});
      now+=1000;const successor=b.claim(id,'second','subject',6);assert.equal(successor.epoch,2);
      assert.throws(()=>ws.saveArtifact(id,old.claim_id,'check-output',Buffer.from('stale')),/claim_superseded|invalid claim/);
      assert.throws(()=>ws.recordCheckResult({id:'live-old-check',request_id:id,claim_id:old.claim_id,check_id:'default',status:'completed',exit_code:0,timed_out:false,output_artifact_id:'missing',output_sha256:'x',duration_ms:1,phase:'check',evidence:{}},Buffer.from('stale')),/claim_superseded|invalid claim/);
      const oldAssert=a.assertClaim.bind(a),staleStore=Object.assign(Object.create(Object.getPrototypeOf(a)),a);let assertions=0;
      staleStore.assertClaim=(...args)=>++assertions===1?{}:oldAssert(...args); // first check models an operation paused just before filesystem mutation
      const staleChunk=Object.create(Workspace.prototype);staleChunk.store=staleStore;
      assert.throws(()=>staleChunk.chunk(id,old.claim_id,'subject','art_stale_upload',0,'c3RhbGU='),/claim_superseded|invalid claim/);
      assert.equal(a.db.prepare("SELECT count(*) n FROM artifacts WHERE request_id=? AND kind='upload'").get(id).n,0,'stale chunk left an upload row');
      const repo=path.join(temp,'stale-apply');fs.mkdirSync(repo);git(['init','-q'],repo);git(['config','user.email','fixture@example.invalid'],repo);git(['config','user.name','Fixture'],repo);fs.writeFileSync(path.join(repo,'hello.txt'),'base\n');git(['add','.'],repo);git(['commit','-qm','base'],repo);const base=git(['rev-parse','HEAD'],repo);
      const applyWs=Object.create(Workspace.prototype),impl={...a.get(id),assignment:{...a.get(id).assignment,execution_scope:'implementation'},review:false};applyWs.store=staleStore;applyWs.context=()=>({a:impl});applyWs.ensure=()=>({a:impl,dir:repo,input:{base_sha:base}});applyWs.noteIgnoredWritten=()=>{};
      const patch='diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-base\n+stale\n';
      assert.throws(()=>applyWs.apply(id,old.claim_id,'subject',patch),/claim_superseded|invalid claim/);
      assert.equal(fs.readFileSync(path.join(repo,'hello.txt'),'utf8'),'base\n','stale patch changed the worktree');
      const snapshotWs=Object.create(Workspace.prototype);snapshotWs.store=a;snapshotWs.activeChecks=new Set();snapshotWs.result=()=>({base_sha:base});snapshotWs.diff=()=>({patch:'stale snapshot'});snapshotWs.diffFilter=()=>null;snapshotWs.diffScope=()=>null;
      a.db.prepare('INSERT INTO workspaces(request_id,claim_id,base_sha,path,created_at) VALUES(?,?,?,?,?)').run(id,old.claim_id,base,repo,new Date(now).toISOString());
      assert.throws(()=>snapshotWs.snapshot(id,old.claim_id,'subject'),/claim_superseded|invalid claim/);
      assert.equal(a.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(id).n,1,'only the pre-existing artifact remains');
      assert.equal(a.db.prepare('SELECT count(*) n FROM check_runs WHERE request_id=?').get(id).n,0);
      const cancelledId='req_cancel_publication';a.submit(assignment(cancelledId),{mode:'none'},null,'owner');
      const cancelledClaim=a.claim(cancelledId,'first','subject',6);a.cancel(cancelledId,'fixture cancellation');
      assert.throws(()=>ws.saveArtifact(cancelledId,cancelledClaim.claim_id,'check-output',Buffer.from('cancelled')),/cancelled|closed/);
      assert.throws(()=>ws.recordCheckResult({id:'cancelled-check',request_id:cancelledId,claim_id:cancelledClaim.claim_id,check_id:'default',status:'completed',exit_code:0,timed_out:false,output_artifact_id:'missing',output_sha256:'x',duration_ms:1,phase:'check',evidence:{}},Buffer.from('cancelled')),/cancelled|closed/);
      assert.equal(a.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(cancelledId).n,0);
      console.log('PASS two-connection recovery/regrant fences stale artifact, receipt, patch, chunk and snapshot writes; collision preserves bytes; cancellation fences publication');
    }finally{a.db.close();b.db.close();}
  }
  if(!process.argv.includes('--store-only')) {
  const repo=path.join(temp,'fixture');fs.mkdirSync(repo);
  git(['init','-q'],repo);git(['config','user.email','fixture@example.invalid'],repo);git(['config','user.name','Fixture'],repo);
  const budget={cpu_ms:3000,wall_ms:30000,memory_bytes:192*1024**2,processes:32,disk_write_bytes:8*1024**2,output_bytes:8192};
  const slow=`process.title=${JSON.stringify(marker)};require('node:child_process').spawn('/usr/bin/sleep',['25']);setInterval(()=>process.stdout.write('OLD_OUTPUT'),100);`;
  fs.writeFileSync(path.join(repo,'hello.txt'),'base\n');
  fs.writeFileSync(path.join(repo,'.dot-bridge.json'),JSON.stringify({checks:{default:{argv:['/runtime/node','-e',slow],timeout_ms:30000,output_bytes:8192,host_budget:budget},positive:{argv:['/usr/bin/true'],timeout_ms:5000,output_bytes:8192,host_budget:budget}}}));
  git(['add','.'],repo);git(['commit','-qm','fixture'],repo);const base=git(['rev-parse','HEAD'],repo);
  adapter=new DotBridgeAdapter({serverEnv:{DALAN_HOST_CHECKS:'1',XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR??`/run/user/${process.getuid()}`,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS??`unix:path=/run/user/${process.getuid()}/bus`,DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE:repo}});
  await adapter.init();await adapter.reset();
  const job='effect-job',id=adapter.requestId(job),cap=adapter.ownerToken(job);
  const payload={...assignment(id),execution_scope:'implementation',scope_paths:['.'],inputs:[{github_repo:'example-owner/fixture',base_sha:base}]};
  const submitted=await adapter.admin('POST','/submit',{assignment:payload,delivery:'none',execution:'host',owner_token:cap});assert.ok(!submitted.error,submitted.error);
  const first=await adapter.mcp('W1','claim',{request_id:id,claimant:'first',acquisition_id:'first'});assert.ok(first.value,first.error);
  const old=first.value.claim_id;
  const check=adapter.mcp('W1','run_check',{request_id:id,claim_id:old,check_id:'default'});
  try { await until(()=>pids().length>0,'actual host payload start'); } catch(error) {
    const response=await check; console.error('HOST_START_DIAGNOSTIC',JSON.stringify({error:response.error,status:response.value?.status,reason:response.value?.reason,checkError:response.value?.error})); throw error;
  }
  const oldPids=pids();assert.ok(oldPids.length);
  await adapter.control({op:'advance',to:60000});
  const next=await adapter.mcp('W2','claim',{request_id:id,claimant:'second',acquisition_id:'second'});assert.ok(next.value,next.error);
  assert.equal(next.value.epoch,2);assert.notEqual(next.value.claim_id,old);
  const stopped=await check;assert.ok(stopped.value?.status==='failed'||stopped.error,'old check must not succeed');
  for(const pid of oldPids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'host process still alive when new grant returned');
  const rows=adapter.q('SELECT status,stop_verified FROM check_jobs WHERE request_id=?',id);
  assert.equal(rows.length,1);assert.equal(rows[0].stop_verified,1);assert.equal(rows[0].status,'failed');
  assert.equal(adapter.q('SELECT * FROM check_runs WHERE request_id=?',id).length,0,'old output receipt landed');
  assert.equal(adapter.q('SELECT * FROM artifacts WHERE request_id=?',id).length,0,'old output artifact landed');
  console.log('PASS real HTTP regrant waits for stopped host work and discards output');
  const patch='*** Begin Patch\n*** Update File: hello.txt\n@@\n-base\n+stale\n*** End Patch';
  const tools=[['progress',{note:'stale'}],['finish',{outcome:'completed',summary:'stale',result:'stale'}],['apply_patch',{patch}],['artifact_chunk',{artifact_id:`art_${randomUUID()}`,offset:0,data_base64:'c3RhbGU='}],['run_check',{check_id:'positive'}],['list_files',{}],['read_file',{path:'hello.txt'}],['workspace_result',{}]];
  for(const [name,args] of tools){const result=await adapter.mcp('W1',name,{request_id:id,claim_id:old,...args});assert.match(result.error??'',/claim_superseded|invalid claim/,`${name} must fence authority before an effect`);console.log(`PASS old epoch HTTP ${name} rejected`);}
  assert.equal(adapter.q('SELECT * FROM check_jobs WHERE request_id=?',id).length,1);
  assert.equal(adapter.q('SELECT * FROM artifacts WHERE request_id=?',id).length,0);
  const positive=await adapter.mcp('W2','run_check',{request_id:id,claim_id:next.value.claim_id,check_id:'positive'});assert.equal(positive.value?.exit_code,0,JSON.stringify(positive));
  console.log('PASS current epoch executes real host positive control');
  }
}finally{if(adapter)await adapter.close();fs.rmSync(temp,{recursive:true,force:true});}
