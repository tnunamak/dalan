#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const root=process.env.DOT_BRIDGE_TEST_TMP||path.join(os.homedir(),'.tmp');fs.mkdirSync(root,{recursive:true});
const home=fs.mkdtempSync(path.join(root,'quiesce-admission-'));
const env={...fixtureEnv(home),HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_RESUME_IDLE_MS:'0'};
const server=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe']});
let output='',errors='',exited=false,port;
const closed=new Promise(resolve=>server.once('exit',()=>{exited=true;resolve();}));
server.stdout.on('data',b=>{output+=b;const m=/^MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\r?\n/m.exec(output);if(m)port=Number(m[1]);});
server.stderr.on('data',b=>errors+=b);
function admin(route,body,headers={},method='POST') {
  return new Promise((resolve,reject)=>{
    const q=http.request({socketPath:path.join(home,'.local/share/dalan/admin.sock'),path:route,method,headers:{'content-type':'application/json',...headers}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(b)}));});q.on('error',reject);q.end(method==='GET'?undefined:JSON.stringify(body));
  });
}
let call=0,secret;
async function rpc(name,args={}) {
  const r=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++call,method:'tools/call',params:{name,arguments:args}})});
  const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b.result;
}
const parse=r=>{assert.equal(r.isError,false,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const ids=['req_quiesce_1','req_quiesce_2'];
const assignment=request_id=>({schema_version:1,request_id,brief:'Synthetic fixture',inputs:[],expected_output:'One line',execution_scope:'read-only'});
// Contract (build step 1 of a faster deploy restart): POST /quiesce {on:true} on the admin socket makes the MCP front door refuse
// effectful tool calls with a retryable "paused for a restart" error, without touching leases; read-only calls still answer.
// GET /quiesce reports {on, admitted_in_flight, delivery_in_flight, host_checks_unverified, live_leases}. {on:false} reopens it.
try {
  const deadline=Date.now()+10000;
  while(!port&&!exited&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  assert.ok(port,'isolated server did not become ready: '+errors);
  secret=fs.readFileSync(path.join(home,'.config/dalan/env'),'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const op={'x-operator-key':fs.readFileSync(path.join(home,'.config/dalan/operator.key'),'utf8').trim()};
  for(const id of ids)assert.equal((await admin('/submit',{delivery:'none',owner_token:'synthetic-owner-capability',assignment:assignment(id)})).status,200);
  const claim=parse(await rpc('claim',{request_id:ids[0],claimant:'fixture-worker'}));
  assert.ok(claim.claim_id);
  const idle=await admin('/quiesce',undefined,op,'GET');
  assert.equal(idle.status,200,JSON.stringify(idle.body));
  assert.deepEqual(Object.keys(idle.body).sort(),['admitted_in_flight','delivery_in_flight','host_checks_unverified','live_leases','on']);
  assert.equal(idle.body.on,false);assert.equal(idle.body.admitted_in_flight,0);assert.equal(idle.body.live_leases,1);
  const before=await admin('/claims',undefined,op,'GET');
  // on: an effectful call is refused with a retryable message; the lease row is unchanged
  assert.equal((await admin('/quiesce',{on:true},op)).status,200);
  const refused=await rpc('progress',{request_id:ids[0],claim_id:claim.claim_id,note:'still working'});
  assert.equal(refused.isError,true,'progress must be refused while quiesced');
  assert.match(refused.content[0].text,/paused for a restart/);assert.match(refused.content[0].text,/retry/i);
  const during=await admin('/quiesce',undefined,op,'GET');
  assert.equal(during.body.on,true);assert.equal(during.body.admitted_in_flight,0);assert.equal(during.body.live_leases,1);
  assert.deepEqual((await admin('/claims',undefined,op,'GET')).body,before.body,'quiesce must not change any lease');
  // read-only calls still answer
  assert.equal(parse(await rpc('list_pending')).free_lanes>=0,true);
  assert.ok(parse(await rpc('get',{request_id:ids[0]})));
  // a new claim is refused too
  const refusedClaim=await rpc('claim',{request_id:ids[1],claimant:'fixture-worker'});
  assert.equal(refusedClaim.isError,true);
  // off: the same progress call now goes through, and a claim works
  assert.equal((await admin('/quiesce',{on:false},op)).status,200);
  parse(await rpc('progress',{request_id:ids[0],claim_id:claim.claim_id,note:'resumed'}));
  assert.ok(parse(await rpc('claim',{request_id:ids[1],claimant:'fixture-worker'})).claim_id);
  console.log('PASS quiesce refuses effectful calls with a retryable error, keeps leases and read-only calls, and reopens');
} finally {
  if(!exited){try{process.kill(-server.pid,'SIGTERM');}catch{}await closed;}
  if(process.env.KEEP_TEST_FIXTURES!=='1') fs.rmSync(home,{recursive:true,force:true});
}
