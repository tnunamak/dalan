#!/usr/bin/env node
// Restart without waiting for leases, end to end: a worker holds a live claim; `upgrade-drain.mjs --until-quiescent` (through the real
// `dalan quiesce` CLI) closes admission and returns without waiting for that lease; the service is stopped and started again on the same
// database; the same claim_id then still works (progress and finish), and the gate is open again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const root=process.env.DOT_BRIDGE_TEST_TMP||path.join(os.homedir(),'.tmp');fs.mkdirSync(root,{recursive:true});
const home=fs.mkdtempSync(path.join(root,'quiesce-restart-'));
const env={...fixtureEnv(home),HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_RESUME_IDLE_MS:'0'};
let server,output,errors,exited,port,closed;
function start() {
  output='';errors='';exited=false;port=undefined;
  server=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe']});
  closed=new Promise(resolve=>server.once('exit',()=>{exited=true;resolve();}));
  server.stdout.on('data',b=>{output+=b;const m=/^MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\r?\n/m.exec(output);if(m)port=Number(m[1]);});
  server.stderr.on('data',b=>errors+=b);
}
async function until(predicate,label) {
  const limit=Date.now()+10000;
  while(!predicate()&&!exited&&Date.now()<limit)await new Promise(r=>setTimeout(r,20));
  assert.ok(predicate(),label+': '+errors);
}
async function stop() { if(server&&!exited){try{process.kill(-server.pid,'SIGTERM');}catch{}await closed;} }
const admin=(route,method='GET',body)=>new Promise((resolve,reject)=>{
  const q=http.request({socketPath:path.join(home,'.local/share/dalan/admin.sock'),path:route,method,headers:{'content-type':'application/json','x-operator-key':fs.readFileSync(path.join(home,'.config/dalan/operator.key'),'utf8').trim()}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve(JSON.parse(b)));});
  q.on('error',reject);q.end(method==='GET'?undefined:JSON.stringify(body??{}));
});
let call=0,secret;
async function rpc(name,args={}) {
  const r=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++call,method:'tools/call',params:{name,arguments:args}})});
  const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b.result;
}
const parse=r=>{assert.equal(r.isError,false,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const assignment=request_id=>({schema_version:1,request_id,brief:'Synthetic fixture',inputs:[],expected_output:'One line',execution_scope:'read-only'});
try {
  start();
  await until(()=>port,'isolated server did not become ready');
  secret=fs.readFileSync(path.join(home,'.config/dalan/env'),'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  assert.equal((await admin('/submit','POST',{delivery:'none',owner_token:'synthetic-owner-capability',assignment:assignment('req_restart_1')})).error,undefined);
  const claim=parse(await rpc('claim',{request_id:'req_restart_1',claimant:'fixture-worker'}));
  assert.ok(claim.claim_id);
  const lease=(await admin('/claims')).claims.find(c=>c.request_id==='req_restart_1');
  assert.ok(lease,'the claim is live before the drain');

  // the real drain through the real CLI: must return while the lease is still live
  const drain=spawnSync(process.execPath,['scripts/upgrade-drain.mjs','--until-quiescent'],{cwd:repo,env:{...env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'20000'},encoding:'utf8',timeout:30000});
  assert.equal(drain.status,0,drain.stdout+drain.stderr);
  assert.match(drain.stdout,/Live leases survive/);
  assert.equal((await admin('/quiesce')).on,true,'the drain leaves the gate closed for the restart');
  assert.equal((await admin('/quiesce')).live_leases,1,'the live lease was not waited on');
  assert.equal(parse(await rpc('get',{request_id:'req_restart_1'})).request_id,'req_restart_1','reads still answer while closed');

  await stop();
  start();
  await until(()=>port,'restarted server did not become ready');
  assert.equal((await admin('/quiesce')).on,false,'a restart reopens the gate');
  const after=(await admin('/claims')).claims.find(c=>c.request_id==='req_restart_1');
  assert.ok(after,'the lease survived the restart');
  parse(await rpc('progress',{request_id:'req_restart_1',claim_id:claim.claim_id,note:'still mine after the restart'}));
  parse(await rpc('finish',{request_id:'req_restart_1',claim_id:claim.claim_id,outcome:'completed',result:'finished under the old claim after a restart'}));
  console.log('PASS a live claim survives a quiesce restart: drain returns without waiting, same claim_id progresses and finishes, the gate reopens');
} finally {
  await stop();
  if(process.env.KEEP_TEST_FIXTURES!=='1')fs.rmSync(home,{recursive:true,force:true});
}
