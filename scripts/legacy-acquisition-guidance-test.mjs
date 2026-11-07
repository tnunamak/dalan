#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const root=process.env.DOT_BRIDGE_TEST_TMP||path.join(os.homedir(),'.tmp');fs.mkdirSync(root,{recursive:true});
const home=fs.mkdtempSync(path.join(root,'acquisition-guidance-'));
const env={...fixtureEnv(home),HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_RESUME_IDLE_MS:'0'};
const server=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe']});
let output='',errors='',exited=false,port;
const closed=new Promise(resolve=>server.once('exit',()=>{exited=true;resolve();}));
server.stdout.on('data',b=>{output+=b;const m=/^MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\r?\n/m.exec(output);if(m)port=Number(m[1]);});
server.stderr.on('data',b=>errors+=b);
const requestId='req_legacy_acquisition_guidance',owner='synthetic-owner-capability',acquisition='synthetic-saved-acquisition';
function admin(route,body,headers={}) {
  return new Promise((resolve,reject)=>{
    const q=http.request({socketPath:path.join(home,'.local/share/dalan/admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json',...headers}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(b)}));});q.on('error',reject);q.end(JSON.stringify(body));
  });
}
let call=0,secret,db;
async function rpc(name,args={}) {
  const r=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++call,method:'tools/call',params:{name,arguments:args}})});
  const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));assert.equal(b.result?.isError,false,JSON.stringify(b));return JSON.parse(b.result.content[0].text);
}
const identityHint=guidance=>{
  assert.match(guidance,/Generate one random acquisition_id/);
  assert.match(guidance,/Keep that acquisition_id, claimant and returned claim_id in your own saved run state/);
  assert.match(guidance,/QUESTION\/answer/);
  assert.doesNotMatch(guidance,/synthetic-saved-acquisition/,'the acquisition value must not appear in guidance');
};
try {
  const deadline=Date.now()+10000;
  while(!port&&!exited&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  assert.ok(port,'isolated server did not become ready: '+errors);
  secret=fs.readFileSync(path.join(home,'.config/dalan/env'),'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const submitted=await admin('/submit',{delivery:'none',owner_token:owner,assignment:{schema_version:1,request_id:requestId,brief:'Synthetic protocol fixture',inputs:[],expected_output:'One line',execution_scope:'read-only'}});
  assert.equal(submitted.status,200,JSON.stringify(submitted));
  identityHint((await rpc('list_pending')).guidance);
  const claim=await rpc('claim',{request_id:requestId,claimant:'fixture-worker',acquisition_id:acquisition});identityHint(claim.guidance);
  await rpc('progress',{request_id:requestId,claim_id:claim.claim_id,note:'QUESTION: Continue this synthetic fixture?'});
  assert.equal((await admin('/note',{id:requestId,text:'Continue this same logical run.'},{'x-owner-capability':owner})).status,200);
  const retry=await rpc('claim',{request_id:requestId,claimant:'fixture-worker',acquisition_id:acquisition});
  assert.equal(retry.duplicate,true);assert.equal(retry.claim_id,claim.claim_id);assert.equal(retry.epoch,claim.epoch);
  const read=await rpc('get',{request_id:requestId});identityHint(read.guidance);
  await rpc('finish',{request_id:requestId,claim_id:retry.claim_id,outcome:'completed',summary:'Synthetic continuation',result:'Same acquisition retained.'});
  db=new DatabaseSync(path.join(home,'.local/share/dalan/bridge.db'),{readOnly:true});
  assert.equal(db.prepare('SELECT acquisition_id FROM claims WHERE request_id=?').get(requestId).acquisition_id,acquisition);
  assert.equal(db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(requestId).n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(requestId).n,1);
  assert.equal(fs.existsSync(path.join(home,'.config/dalan/workers.json')),false,'guidance must not create an authentication profile');
  assert.equal(db.prepare('SELECT count(*) n FROM subscriptions').get().n,0);
  assert.doesNotMatch(output+errors,/synthetic-saved-acquisition/,'the acquisition value must not appear in process output');
  const pullGuide=fs.readFileSync(path.join(repo,'docs/pull-workers.md'),'utf8');
  // An exact claim retry with the same claimant and acquisition_id receives the live grant, and the bridge hides the ID from
  // worker-visible metadata, so the guide must tell a run to keep the ID private and never print it.
  const acquisitionGuide=pullGuide.split('\n').filter(line=>/acquisition_id|acquisition ID/.test(line)).join('\n');
  assert.match(acquisitionGuide,/private saved run state/i,'pull-workers.md tells a run to keep its acquisition ID in private saved run state');
  assert.match(acquisitionGuide,/never print it in diagnostics or examples/i,'pull-workers.md tells a run never to print its acquisition ID');
  assert.doesNotMatch(pullGuide,/synthetic-saved-acquisition/,'the acquisition value must not appear in documentation examples');
  console.log('PASS legacy acquisition hints before claim and across saved question continuation; no profile or authority change');
} finally {
  db?.close();if(!exited){try{process.kill(-server.pid,'SIGTERM');}catch{}await closed;}
  if(process.env.KEEP_TEST_FIXTURES!=='1') fs.rmSync(home,{recursive:true,force:true});
}
