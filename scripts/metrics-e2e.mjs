#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('dot-bridge.example.test');
// Lifecycle metrics through the real server: submit -> claim -> progress -> run_check (refused) -> wait (consumed) ->
// finish -> accept -> integrate, then dot-worker metrics --json and status --explain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const repoRoot=path.resolve(new URL('..',import.meta.url).pathname);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-metrics-')), fixture=path.join(home,'repo'), config=path.join(home,'.config/dot-bridge');
const port=Number(process.env.METRICS_E2E_PORT||18851), jwksPort=port+1, issuer=`http://127.0.0.1:${jwksPort}/realm`, aud='https://dot-bridge.example.test';
const pass=message=>console.log(`PASS ${message}`);
const git=(args,cwd)=>{ const r=spawnSync('git',args,{cwd,encoding:'utf8'}); if(r.status!==0) throw new Error(r.stderr); return r.stdout.trim(); };
fs.mkdirSync(fixture); fs.mkdirSync(config,{recursive:true});
git(['init','-q'],fixture); git(['config','user.email','test@example.com'],fixture); git(['config','user.name','Test'],fixture);
fs.writeFileSync(path.join(fixture,'hello.txt'),'before\n');
fs.writeFileSync(path.join(fixture,'.dot-bridge.json'),JSON.stringify({checks:{default:{argv:['/runtime/node','--check','hello.txt'],timeout_ms:5000,output_bytes:16384}}}));
git(['add','.'],fixture); git(['commit','-qm','base'],fixture);
const base=git(['rev-parse','HEAD'],fixture);
fs.writeFileSync(path.join(config,'oauth.env'),`OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${aud}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n`,{mode:0o600});
fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer,subject:'dot',client_id:'fixture-client'}],repos:['example-owner/fixture']}}}),{mode:0o600});
fs.writeFileSync(path.join(config,'limits.json'),JSON.stringify({worker_lane_capacity:3,max_claimed_outer_assignments:5}),{mode:0o600});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}), jwk={...publicKey.export({format:'jwk'}),kid:'test',use:'sig'};
const jwks=http.createServer((req,res)=>res.end(JSON.stringify({keys:[jwk]})));
await new Promise(r=>jwks.listen(jwksPort,'127.0.0.1',r));
const env={...process.env,HOME:home,DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_WORKSPACE_ROOT:path.join(home,'work'),DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE:fixture};
const token=()=>{ const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url'), p=Buffer.from(JSON.stringify({iss:issuer,aud,exp:Math.floor(Date.now()/1000)+300,sub:'dot',azp:'fixture-client',scope:'dot-bridge.read dot-bridge.work'})).toString('base64url'); return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`; };
const cli=(...args)=>new Promise(done=>{ const c=spawn(process.execPath,['bin/dalan.mjs',...args],{cwd:repoRoot,env,stdio:['ignore','pipe','pipe']}); let out='',err=''; c.stdout.on('data',b=>out+=b); c.stderr.on('data',b=>err+=b); c.on('close',code=>{ let value=null; try { value=JSON.parse(out); } catch {} done({code,out,err,value}); }); });
const admin=(route,method='GET',body=null,headers={})=>new Promise((done,fail)=>{ const bytes=body?JSON.stringify(body):''; const req=http.request({socketPath:path.join(home,'.local/share/dot-bridge/admin.sock'),path:route,method,headers:{'content-type':'application/json','content-length':Buffer.byteLength(bytes),...headers}},res=>{ let t=''; res.on('data',b=>t+=b); res.on('end',()=>done({status:res.statusCode,value:JSON.parse(t)})); }); req.on('error',fail); req.end(bytes); });
const service=spawn(process.execPath,['src/server.mjs'],{cwd:repoRoot,env,stdio:['ignore','pipe','pipe']});
let out=''; service.stdout.on('data',b=>out+=b); service.stderr.on('data',b=>process.stderr.write(b));
try {
  for(let i=0;i<100&&!(out.includes('MCP listening')&&out.includes('admin socket'));i++) await new Promise(r=>setTimeout(r,50));
  assert.ok(out.includes('MCP listening')&&out.includes('admin socket'),'server did not start');
  const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1], auth=token();
  const tool=async(name,args)=>{ const r=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}); const j=await r.json(); if(j.result.isError) throw new Error(j.result.content[0].text); return JSON.parse(j.result.content[0].text); };
  const db=new DatabaseSync(path.join(home,'.local/share/dot-bridge/bridge.db'),{readOnly:true});
  const events=id=>db.prepare('SELECT type,actor,source,reason,epoch FROM lifecycle_events WHERE request_id=? ORDER BY id').all(id).map(e=>({...e}));

  const id=`req_${randomUUID()}`, file=path.join(home,'assignment.json');
  fs.writeFileSync(file,JSON.stringify({schema_version:1,request_id:id,brief:'metrics e2e: change hello.txt',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],scope_paths:['hello.txt'],expected_output:'a patch',execution_scope:'implementation'}));
  const submitted=await cli('submit','--file',file,'--execution','none','--json');
  assert.equal(submitted.code,0,submitted.err); assert.equal(submitted.value.status,'queued');
  const claim=await tool('claim',{request_id:id,claimant:'dot'});
  await tool('progress',{request_id:id,claim_id:claim.claim_id,note:'reading hello.txt'});
  const refused=await tool('run_check',{request_id:id,claim_id:claim.claim_id,check_id:'missing'});
  assert.equal(refused.status,'capability_not_available'); assert.match(refused.reason,/execution=none/);
  assert.equal(db.prepare('SELECT count(*) n FROM check_jobs WHERE request_id=?').get(id).n,0);
  assert.equal((await cli('accept',id,'--json')).value,null,'accept before finish succeeded');
  assert.match((await cli('accept',id,'--json')).err,/only a finished assignment/);
  const waiting=cli('wait',id,'--timeout','30','--json');
  await new Promise(r=>setTimeout(r,300));
  await tool('finish',{request_id:id,claim_id:claim.claim_id,outcome:'completed',summary:'changed hello.txt',result:'patch attached'});
  const waited=await waiting;
  assert.equal(waited.code,0,waited.err); assert.equal(waited.value.status,'finished');
  for(let i=0;i<50&&!events(id).some(e=>e.type==='consumed');i++) await new Promise(r=>setTimeout(r,50));
  const gotJson=await cli('get',id,'--json');
  assert.equal(gotJson.code,0);
  assert.match(gotJson.value.claim.activity.last_tool,/^\w+$/); assert(gotJson.value.claim.activity.tool_calls>=2);
  assert.doesNotMatch(gotJson.err,/worker activity/,'--json adds no human line');
  const gotHuman=await cli('get',id);
  assert.match(gotHuman.err,/^worker activity: \d+ calls?, last \w+ at \d\d:\d\d:\d\dZ \(\d+[smh] ago\)/m,gotHuman.err);
  const accepted=await cli('accept',id,'--note','looks right','--json');
  assert.equal(accepted.code,0,accepted.err); assert.equal(accepted.value.verdict,'accepted');
  const integrated=await cli('integrate',id,'--reason','merged https://github.com/example-owner/fixture/pull/1','--json');
  assert.equal(integrated.code,0,integrated.err); assert.equal(integrated.value.duplicate,false);
  assert.equal((await cli('integrate',id,'--json')).value.duplicate,true);
  const key=fs.readFileSync(path.join(config,'operator.key'),'utf8').trim();
  assert.equal((await admin('/lifecycle','POST',{id,type:'accepted'},{'x-operator-key':key})).value.error,'only type integrated is accepted');
  assert.equal((await admin('/lifecycle','POST',{id,type:'integrated'})).value.error,'invalid operator key');
  assert.equal((await admin('/accept','POST',{id})).value.error,'invalid owner capability');
  assert.deepEqual(events(id).map(e=>[e.type,e.actor,e.reason]),[
    ['queued','owner',null],['claimed','worker:dot','new'],['working','worker:dot',null],
    ['check_skipped','worker:dot','check_id=missing;this job has execution=none; run_check needs execution=host'],
    ['completed','worker:dot','outcome=completed'],['consumed','owner','wait'],['accepted','owner','looks right'],['integrated','fix-loop','merged https://github.com/example-owner/fixture/pull/1']]);
  assert.ok(events(id).every(e=>e.source==='live'));
  pass('refused check writes a skipped event; submit, claim, progress, finish, wait, get, accept and integrate retain their live events');

  const metrics=await cli('metrics','--json');
  assert.equal(metrics.code,0,metrics.err);
  const m=metrics.value, n=x=>({value:x,unit:'count'});
  assert.deepEqual(Object.keys(m).sort(),['acceptance','checks','claim_to_first_activity','duplicates','lane_utilization','late_evidence','notes','objective_coverage','orphaned_claims','queue_latency','resume_wake','rework','throughput','time','utilization','window']);
  assert.equal(m.queue_latency.n.value,1); assert.equal(m.queue_latency.p50.unit,'ms'); assert.ok(m.queue_latency.p50.value>=0);
  assert.equal(m.claim_to_first_activity.n.value,1); assert.ok(m.claim_to_first_activity.p50.value>=0);
  assert.ok(m.time.claimed.value>0&&m.time.working.value===m.time.claimed.value,'a short claim with steady activity should be all working time');
  assert.equal(m.utilization.working_over_claimed.value,1); assert.deepEqual(Object.keys(m.utilization),['working_over_claimed']);
  const lu=m.lane_utilization; assert.equal(lu.lanes.value,3,'worker_lane_capacity from limits.json is the denominator'); assert.equal(lu.last_24h.utilization.lanes,3); assert.equal(lu.last_24h.utilization.denominator_ms,3*lu.last_24h.window.covered_ms); assert.ok(lu.last_7d.window.covered_fraction<1);
  assert.deepEqual(m.throughput.by_kind,{'implementation/normal':n(1)}); assert.deepEqual(m.throughput.completed,n(1));
  assert.deepEqual(m.checks,{passed:n(0),failed:n(0),skipped:n(1),pass_rate:{value:0,unit:'ratio'},started:n(0)});
  assert.deepEqual(m.acceptance,{finished:n(1),accepted:n(1),rejected:n(0),consumed_only:n(0),unknown:n(0),accept_rate:{value:1,unit:'ratio'},integrated:n(1)});
  assert.equal(m.rework.value,null); assert.match(m.rework.unknown_reason,/objective_key/);
  assert.deepEqual(m.orphaned_claims,{current:n(0),lease_expired_takeovers:n(0),abandoned:n(0)});
  assert.equal(m.window.rolled_up,false);
  const since=await cli('metrics','--since',new Date(Date.now()-60000).toISOString(),'--json');
  assert.equal(since.code,0,since.err); assert.equal(since.value.throughput.completed.value,1);
  assert.match((await cli('metrics','--since','yesterday','--json')).err,/RFC 3339/);
  assert.equal((await cli('metrics','--bogus')).code,1);
  const plain=await cli('metrics');
  assert.equal(plain.code,0,plain.err); assert.match(plain.out,/^metrics\(since=.*\n  queue_latency=p50:/);
  console.log(plain.out.trim());
  pass('dot-worker metrics --json reports the timeline with units, n and unknown reasons; --since narrows the window');

  const explained=await cli('status','--explain');
  assert.match(explained.out,/ util24h=[\d.]+%\(of 3 lanes,covered [\d.]+%\) idle_while_queued24h=[\d.]+% iwq_waiting24h=[\d.]+%\(break:[\d.]+%,worker_inactive:[\d.]+%,worker_active:[\d.]+%\) idle_no_queue24h=[\d.]+% util7d=[\d.]+%\(of 3 lanes,covered [\d.]+%\) idle_while_queued7d=[\d.]+% iwq_waiting7d=[\d.]+%\(break:[\d.]+%,worker_inactive:[\d.]+%,worker_active:[\d.]+%\) idle_no_queue7d=[\d.]+% /);
  const st=await cli('status','--json'); assert.equal(st.value.worker_lane_capacity,3); assert.equal(st.value.max_claimed_outer_assignments,5);
  assert.equal(explained.code,0,explained.err); assert.match(explained.out,/^observed=.*\nmetrics\(since=.* acceptance=accepted:1,rejected:0,consumed_only:0,unknown:0 /m);
  const explainedJson=await cli('status','--explain','--json');
  assert.equal(explainedJson.value.metrics.acceptance.accepted.value,1); assert.match(explainedJson.value.explanation,/\nmetrics\(since=/);
  pass('status --explain carries a short metrics section');
  db.close();
} catch(error) { console.error('FAIL',error); process.exitCode=1; }
finally { service.kill('SIGTERM'); await new Promise(r=>service.once('exit',r)); await new Promise(r=>jwks.close(r)); fs.rmSync(home,{recursive:true,force:true}); }
