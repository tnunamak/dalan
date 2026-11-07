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
const home=fs.mkdtempSync(path.join(root,'pause-claim-hint-'));
const env={...fixtureEnv(home),HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_RESUME_IDLE_MS:'0'};
const server=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe']});
let output='',errors='',exited=false,port;
const closed=new Promise(resolve=>server.once('exit',()=>{exited=true;resolve();}));
server.stdout.on('data',b=>{output+=b;const m=/^MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\r?\n/m.exec(output);if(m)port=Number(m[1]);});
server.stderr.on('data',b=>errors+=b);
function admin(route,body,headers={}) {
  return new Promise((resolve,reject)=>{
    const q=http.request({socketPath:path.join(home,'.local/share/dalan/admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json',...headers}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(b)}));});q.on('error',reject);q.end(JSON.stringify(body));
  });
}
let call=0,secret;
async function rpc(name,args={}) {
  const r=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++call,method:'tools/call',params:{name,arguments:args}})});
  const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b.result;
}
const parse=r=>{assert.equal(r.isError,false,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const ids=['req_pause_hint_1','req_pause_hint_2'];
const assignment=request_id=>({schema_version:1,request_id,brief:'Synthetic fixture',inputs:[],expected_output:'One line',execution_scope:'read-only'});
try {
  const deadline=Date.now()+10000;
  while(!port&&!exited&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  assert.ok(port,'isolated server did not become ready: '+errors);
  secret=fs.readFileSync(path.join(home,'.config/dalan/env'),'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const op={'x-operator-key':fs.readFileSync(path.join(home,'.config/dalan/operator.key'),'utf8').trim()};
  for(const id of ids)assert.equal((await admin('/submit',{delivery:'none',owner_token:'synthetic-owner-capability',assignment:assignment(id)})).status,200);
  // queued work and free lanes: list_pending says claims are accepted and names the oldest queued job
  const open=parse(await rpc('list_pending'));
  assert.equal(open.claims_accepted,true);
  assert.ok(open.free_lanes>0);
  assert.match(open.next_action,new RegExp(`claim ${ids[0]}.* now \\(oldest first\\)`),open.next_action);
  assert.equal(open.next_queued[0].request_id,ids[0]);
  // paused: the claim error is marked temporary and says to retry; list_pending says not to claim yet
  assert.equal((await admin('/pause',{reason:'synthetic maintenance'},op)).status,200);
  const refused=await rpc('claim',{request_id:ids[0],claimant:'fixture-worker'});
  assert.equal(refused.isError,true);
  const text=refused.content[0].text;
  assert.match(text,/^bridge paused/);assert.match(text,/temporary/);assert.match(text,/list_pending/);assert.match(text,/claim again later/);
  const paused=parse(await rpc('list_pending'));
  assert.equal(paused.claims_accepted,false);
  assert.match(paused.next_action,/paused \(temporary\)/);
  assert.equal('next_queued' in paused,false);
  // resume: the same list says claim now, and the claim works with its unchanged input
  assert.equal((await admin('/resume',{},op)).status,200);
  const resumed=parse(await rpc('list_pending'));
  assert.equal(resumed.claims_accepted,true);assert.match(resumed.next_action,new RegExp(`claim ${ids[0]}`));
  const claim=parse(await rpc('claim',{request_id:ids[0],claimant:'fixture-worker'}));
  assert.ok(claim.claim_id);
  console.log('PASS paused claim error is temporary with a retry hint; list_pending reports claims_accepted and names the oldest queued job');
} finally {
  if(!exited){try{process.kill(-server.pid,'SIGTERM');}catch{}await closed;}
  if(process.env.KEEP_TEST_FIXTURES!=='1') fs.rmSync(home,{recursive:true,force:true});
}
