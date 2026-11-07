#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { stopChild } from '../src/test-support/process.mjs';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const home=fs.mkdtempSync(path.join(process.env.TMPDIR??os.tmpdir(),'dalan-key-http-'));
const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DALAN_HOST_CHECKS:'0'};
const socket=path.join(home,'.local/share/dalan/admin.sock');
const assignment=request_id=>({schema_version:1,request_id,brief:'HTTP durable submit identity',inputs:[],expected_output:'one result',execution_scope:'read-only'});
const body=id=>({assignment:assignment(id),owner_token:'fixture-http-owner',delivery:'none',command_key:'fixture-http-key',execution:'none'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let service,side,logs='';
async function start() {
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let output='',errors='';service.stdout.on('data',b=>{output+=b;logs+=b;});service.stderr.on('data',b=>{errors+=b;logs+=b;});
  for(let i=0;i<400&&!output.includes('MCP listening')&&service.exitCode===null;i++) await sleep(25);
  assert.equal(service.exitCode,null,errors);
  assert(output.includes('MCP listening')&&output.includes('admin socket'),'server did not become ready');
}
async function stop(signal='SIGTERM') {
  await stopChild(service,{signal});
}
function admin(payload,route='/submit') {
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath:socket,path:route,method:'POST',headers:{'content-type':'application/json'}},res=>{
      let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });req.on('error',reject);req.end(JSON.stringify(payload));
  });
}
try {
  await start();side=new Store(path.join(home,'.local/share/dalan/bridge.db'));
  const snapshot=id=>({assignments:side.db.prepare('SELECT count(*) n FROM assignments WHERE request_id=?').get(id).n,commands:side.db.prepare('SELECT count(*) n FROM owner_submit_commands WHERE request_id=?').get(id).n,events:side.db.prepare('SELECT count(*) n FROM lifecycle_events WHERE request_id=?').get(id).n});
  const id=`req_${randomUUID()}`,request=body(id);
  const first=await admin(request);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.duplicate,false);
  const other=await admin({...request,command_key:'another-key'});assert.equal(other.status,400);assert.match(other.body.error,/^EXISTS:/);
  const changed=await admin({...request,assignment:{...request.assignment,brief:'changed intent'}});assert.equal(changed.status,400);assert.match(changed.body.error,/^KEY_CONFLICT:/);
  const foreign=await admin({...request,owner_token:'foreign-owner',command_key:'another-key'});assert.equal(foreign.status,400);assert.match(foreign.body.error,/invalid owner capability/);assert.doesNotMatch(foreign.body.error,/EXISTS|KEY_CONFLICT/);
  assert.deepEqual(snapshot(id),{assignments:1,commands:1,events:1});
  const c=side.claim(id,'holder');side.finish(id,c.claim_id,'completed','finished after original submission','result');
  await stop('SIGKILL');await start();
  const replay=await admin(request);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.status,'queued','replay returned current status instead of original decision');assert.equal(replay.body.duplicate,true);assert.equal(side.get(id).status,'finished');

  const legacyId=`req_${randomUUID()}`,legacy=body(legacyId);delete legacy.command_key;
  assert.equal((await admin(legacy)).status,200);assert.equal((await admin(legacy)).body.duplicate,true);
  assert.match((await admin({...legacy,command_key:'adopt-key'})).body.error,/^EXISTS:/);
  for(const command_key of [null,'',false,{},'x'.repeat(129)]) {
    const invalidId=`req_${randomUUID()}`;const result=await admin({...body(invalidId),command_key});
    assert.equal(result.status,400);assert.match(result.body.error,/invalid command_key/);assert.deepEqual(snapshot(invalidId),{assignments:0,commands:0,events:0});
  }
  const previewId=`req_${randomUUID()}`;assert.equal((await admin(body(previewId),'/submit-preview')).status,200);assert.deepEqual(snapshot(previewId),{assignments:0,commands:0,events:0});
  const rejectedId=`req_${randomUUID()}`;assert.equal((await admin({...body(rejectedId),assignment:{...assignment(rejectedId),brief:''}})).status,400);assert.deepEqual(snapshot(rejectedId),{assignments:0,commands:0,events:0});
  const deferredId=`req_${randomUUID()}`,deferred=await admin({...body(deferredId),defer_queued:1,refuse_defer:true});
  assert.equal(deferred.status,409,JSON.stringify(deferred));assert.deepEqual(snapshot(deferredId),{assignments:0,commands:0,events:0});

  for(const distinct of [false,true]) {
    const raceId=`req_${randomUUID()}`;
    const replies=await Promise.all(Array.from({length:8},(_,index)=>admin({...body(raceId),command_key:distinct?`race-${index}`:'race'})));
    assert.equal(replies.filter(reply=>reply.status===200&&reply.body.duplicate===false).length,1);
    assert.equal(replies.filter(reply=>reply.status===200&&reply.body.duplicate===true).length,distinct?0:7);
    assert.equal(replies.filter(reply=>reply.status===400&&reply.body.error.startsWith('EXISTS:')).length,distinct?7:0);
    assert.deepEqual(snapshot(raceId),{assignments:1,commands:1,events:1});
  }
  assert(!logs.includes('fixture-http-key'),'raw command key reached service logs');
  assert(!logs.includes('fixture-http-owner'),'owner credential reached service logs');
  console.log('submit-command-key-http-e2e ok: owner/intent/key fences, SIGKILL replay, no binding on preview/refusal, 16 concurrent HTTP submissions, redacted logs');
} finally { side?.db.close();await stop();fs.rmSync(home,{recursive:true,force:true}); }
