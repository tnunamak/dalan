#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store, loadRedeliveryLimits } from '../src/store.mjs';
import { stopChild } from '../src/test-support/process.mjs';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const home=fs.mkdtempSync(path.join(process.env.TMPDIR??os.tmpdir(),'dalan-bridge-grant-lease-http-'));
const config=path.join(home,'.config/dot-bridge');
fs.mkdirSync(config,{recursive:true});
fs.writeFileSync(path.join(config,'limits.json'),JSON.stringify({claim_lease_ms:60000,max_claimed_outer_assignments:6}),{mode:0o600});
const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1'};
let service,side,endpoint;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await sleep(25);}assert.fail('server startup timed out');};
const payload=id=>({schema_version:1,request_id:id,brief:'grant lease HTTP test',inputs:[],expected_output:'lease boundary',execution_scope:'read-only'});
try {
  service=spawn(process.execPath,['src/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let out='',errors='';
  service.stdout.on('data',chunk=>out+=chunk);
  service.stderr.on('data',chunk=>errors+=chunk);
  await waitFor(()=>out.includes('MCP listening')||service.exitCode!==null);
  assert.equal(service.exitCode,null,errors);
  const port=Number(/MCP listening on [^:]+:(\d+)/.exec(out)?.[1]);
  const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)?.[1];
  endpoint=`http://127.0.0.1:${port}/${secret}/mcp`;
  const rpc=async(name,args)=>{
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
    const envelope=await response.json();
    return envelope.result.isError?{error:envelope.result.content[0].text}:JSON.parse(envelope.result.content[0].text);
  };
  const tool=(name,args)=>rpc(name,args);
  side=new Store(path.join(home,'.local/share/dot-bridge/bridge.db'),{limits:loadRedeliveryLimits()});

  const shortId=`req_${randomUUID()}`;
  side.submit(payload(shortId),{mode:'none'},null,'owner');
  const short=await tool('claim',{request_id:shortId,claimant:'short-holder',lease_ms:120});
  assert.equal(short.epoch,1);
  const grant=()=>side.db.prepare('SELECT * FROM claims WHERE request_id=?').get(shortId);
  const original=grant();
  assert.equal(original.lease_ms,120);
  const deadline=Date.parse(side.get(shortId).claim.lease_expires_at);
  assert.equal(short.lease_expires_at,new Date(deadline).toISOString(),'claim response used a different lease deadline');
  await sleep(Math.max(0,deadline-Date.now()+3));
  const refused=await tool('progress',{request_id:shortId,claim_id:short.claim_id,note:'must be expired'});
  assert.match(refused.error,/lease_expired/,'old grant remained authoritative at its deadline');
  const successor=await tool('claim',{request_id:shortId,claimant:'successor',lease_ms:100});
  assert.equal(successor.epoch,2,'claim after expiry did not create the next epoch');
  assert.equal(grant().lease_ms,100,'new grant did not persist its requested duration');

  const longId=`req_${randomUUID()}`;
  side.submit(payload(longId),{mode:'none'},null,'owner');
  const long=await tool('claim',{request_id:longId,claimant:'long-holder',lease_ms:900});
  assert.equal(long.epoch,1,JSON.stringify(long));
  const before=side.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get(longId);
  const invalid=[];
  for(const lease_ms of [0,60001,1.5]) invalid.push(await tool('claim',{request_id:longId,claimant:'invalid',lease_ms}));
  assert(invalid.every(item=>item.error),`invalid lease values were accepted: ${JSON.stringify(invalid)}`);
  assert.deepEqual(side.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get(longId),before,'invalid input mutated the grant');
  const omittedRetry=await tool('claim',{request_id:longId,claimant:'long-holder'});
  assert.equal(omittedRetry.claim_id,long.claim_id);
  assert.equal(side.db.prepare('SELECT lease_ms FROM claims WHERE request_id=?').get(longId).lease_ms,900,'omitted live retry changed stored duration');
  const retry=await tool('claim',{request_id:longId,claimant:'long-holder',lease_ms:100});
  assert.equal(retry.claim_id,long.claim_id);
  assert.equal(side.db.prepare('SELECT lease_ms FROM claims WHERE request_id=?').get(longId).lease_ms,900,'matching retry changed stored duration');
  const refreshed=side.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get(longId);
  const rival=await tool('claim',{request_id:longId,claimant:'short-rival',lease_ms:100});
  assert.match(rival.error,/claim_busy|already claimed by another claimant/,'shorter rival took the active long grant');
  assert.deepEqual(side.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get(longId),refreshed,'refused rival changed stored duration or deadline');

  const defaultId=`req_${randomUUID()}`;
  side.submit(payload(defaultId),{mode:'none'},null,'owner');
  await tool('claim',{request_id:defaultId,claimant:'default-holder'});
  assert.equal(side.db.prepare('SELECT lease_ms FROM claims WHERE request_id=?').get(defaultId).lease_ms,60000,'omitted duration did not use configured default');
  assert.equal(side.db.prepare('PRAGMA user_version').get().user_version,65);
  console.log('grant-lease-http-e2e ok: real HTTP expiry, invalid requests, shorter rival, retry retention, default and cap');
} finally {
  try { side?.db.close(); } catch {}
  await stopChild(service);
  fs.rmSync(home,{recursive:true,force:true});
}
