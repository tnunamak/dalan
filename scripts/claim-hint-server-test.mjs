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
const home=fs.mkdtempSync(path.join(root,'claim-hint-server-'));
const env={...fixtureEnv(home),HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_RESUME_IDLE_MS:'0'};
fs.mkdirSync(path.join(home,'.config/dalan'),{recursive:true,mode:0o700});
fs.writeFileSync(path.join(home,'.config/dalan/limits.json'),JSON.stringify({max_claimed_outer_assignments:4,worker_claim_hint:{dot:1}}),{mode:0o600});
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
const ids=['req_claim_hint_1','req_claim_hint_2','req_claim_hint_3'];
const assignment=request_id=>({schema_version:1,request_id,brief:'Synthetic fixture',inputs:[],expected_output:'One line',execution_scope:'read-only'});
try {
  const deadline=Date.now()+10000;
  while(!port&&!exited&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  assert.ok(port,'isolated server did not become ready: '+errors);
  secret=fs.readFileSync(path.join(home,'.config/dalan/env'),'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  for(const id of ids)assert.equal((await admin('/submit',{delivery:'none',owner_token:'synthetic-owner-capability',assignment:assignment(id)})).status,200);
  // worker_claim_hint {dot:1}: three jobs queued and several lanes free, yet the bridge suggests one claim and says so.
  const listed=parse(await rpc('list_pending'));
  assert.ok(listed.free_lanes>1,'free_lanes stays the bridge limit: '+listed.free_lanes);
  assert.match(listed.guidance,/Hold at most 1 claims at once/);
  assert.match(listed.guidance,/touched in the last 3 minutes/);
  assert.match(listed.guidance,/older or near-expiry/);
  assert.match(listed.guidance,/progress at least every 3 minutes/);
  assert.doesNotMatch(listed.guidance,/up to free_lanes/);
  assert.equal(listed.next_queued.length,1);
  assert.equal(listed.next_queued[0].request_id,ids[0]);
  // the claim itself is never refused by the hint, and its guidance changes
  const first=parse(await rpc('claim',{request_id:ids[0],claimant:'fixture-worker'}));
  assert.match(first.guidance,/at 1, finish one first/);
  assert.doesNotMatch(first.guidance,/claim more now\.$/);
  assert.equal('next_queued' in first,false,'holding the hinted number of claims: no next suggestion');
  const second=parse(await rpc('claim',{request_id:ids[1],claimant:'fixture-worker'}));
  assert.ok(second.claim_id,'the hint refuses nothing');
  console.log('PASS claim hint: list_pending and claim tell the worker to hold the hinted number of claims; nothing is refused');
} finally {
  if(!exited){try{process.kill(-server.pid,'SIGTERM');}catch{}await closed;}
  if(process.env.KEEP_TEST_FIXTURES!=='1') fs.rmSync(home,{recursive:true,force:true});
}
