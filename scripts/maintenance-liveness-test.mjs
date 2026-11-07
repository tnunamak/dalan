#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { defaultPath } from '../src/paths.mjs';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=path.join(os.homedir(),'.tmp');
fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'dalan-maintenance-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const outcomes=[];

async function waitFor(fn,label,timeout=2500) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { if(fn()) return; await sleep(25); }
  throw new Error(`timed out waiting for ${label}`);
}

function seed(home,{paused=false,webhookUrl=null,expireQueued=true,expireLease=true}) {
  fs.mkdirSync(home,{recursive:true});
  const dbPath=defaultPath(home,'.local/share/dot-bridge/bridge.db');
  fs.mkdirSync(path.dirname(dbPath),{recursive:true});
  const store=new Store(dbPath,{allowDefaultHomeMigration:true});
  const payload=id=>({schema_version:1,request_id:id,brief:'maintenance fixture',inputs:[],expected_output:'result',execution_scope:'read-only',valid_until:new Date(Date.now()+3600000).toISOString()});
  if(webhookUrl) store.subscribe('sub_maintenance',webhookUrl,'whsec_fixture',new Date(Date.now()+3600000).toISOString());
  store.submit(payload('queued_expiry'),{mode:'none'},'','owner');
  store.submit(payload('claimed_lease'),{mode:'none'},'','owner');
  store.claim('claimed_lease','worker');
  if(paused) store.setPause('maintenance test');
  if(expireQueued) store.db.prepare("UPDATE assignments SET valid_until=? WHERE request_id='queued_expiry'").run(new Date(Date.now()-1000).toISOString());
  if(expireLease) {
    // Clear the same-boot monotonic deadline too; otherwise it, not the wall-clock deadline, decides expiry.
    store.db.prepare("UPDATE claims SET lease_deadline_at=?,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id='claimed_lease'").run(new Date(Date.now()-1000).toISOString());
  }
  store.db.close();
  return {dbPath};
}

async function start(home) {
  const env={...process.env,HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'0',DOT_BRIDGE_T3_DRY_RUN:'0'};
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let output='',port=null;
  child.stdout.on('data',chunk=>{
    output+=String(chunk);
    const match=output.match(/^MCP listening on [^\r\n]+:(\d+)/m);
    if(match) port=Number(match[1]);
  });
  child.stderr.on('data',chunk=>{output+=String(chunk);});
  await waitFor(()=>{
    if(child.exitCode!==null) throw new Error(`server exited: ${output}`);
    return port!==null;
  },'server startup',10000);
  return {child,port,output:()=>output,stop:async()=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    const exited=new Promise(resolve=>child.once('exit',resolve));
    child.kill('SIGTERM');
    await exited;
  }};
}

async function pausedMaintenance() {
  const home=path.join(root,'paused-home'),fixture=seed(home,{paused:true});
  const service=await start(home);
  try {
    const db=new DatabaseSync(fixture.dbPath);
    try {
      // A claim idle since before the bridge started is held for one poll interval. Touch it after the start, as a live
      // worker would, so the expired lease deadline decides.
      db.prepare("UPDATE claims SET last_claim_activity_at=? WHERE request_id='claimed_lease'").run(new Date().toISOString());
      await waitFor(()=>{
        const queued=db.prepare('SELECT status,cancelled_reason FROM assignments WHERE request_id=?').get('queued_expiry');
        const claimed=db.prepare('SELECT status FROM assignments WHERE request_id=?').get('claimed_lease');
        const lease=db.prepare('SELECT state FROM claims WHERE request_id=?').get('claimed_lease');
        return queued.status==='cancelled'&&queued.cancelled_reason==='expired'&&claimed.status==='queued'&&lease.state==='abandoned';
      },'paused service maintenance to expire preparation and lease');
    } finally { db.close(); }
    outcomes.push('PASS paused service expires preparations and leases');
  } finally { await service.stop(); }
}

async function deliveryDoesNotBlockMaintenance() {
  let announce;
  const requestSeen=new Promise(resolve=>{announce=resolve;});
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  const receiver=http.createServer(async(req,res)=>{
    for await(const _chunk of req) {}
    announce();
    await held;
    res.writeHead(204).end();
  });
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  const home=path.join(root,'delivery-home');
  const fixture=seed(home,{expireQueued:false,expireLease:false,webhookUrl:`http://127.0.0.1:${receiver.address().port}/event`});
  const service=await start(home);
  try {
    await Promise.race([requestSeen,sleep(5000).then(()=>{throw new Error('webhook did not start');})]);
    const db=new DatabaseSync(fixture.dbPath);
    try {
      db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?').run(new Date(Date.now()-1000).toISOString(),'queued_expiry');
      db.prepare('UPDATE claims SET lease_deadline_at=?,last_claim_activity_at=?,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?').run(new Date(Date.now()-1000).toISOString(),new Date().toISOString(),'claimed_lease');
      await waitFor(()=>{
        const queued=db.prepare('SELECT status FROM assignments WHERE request_id=?').get('queued_expiry');
        const claimed=db.prepare('SELECT status FROM assignments WHERE request_id=?').get('claimed_lease');
        const lease=db.prepare('SELECT state FROM claims WHERE request_id=?').get('claimed_lease');
        return queued.status==='cancelled'&&claimed.status==='queued'&&lease.state==='abandoned';
      },'maintenance during held webhook');
    } finally { db.close(); }
    outcomes.push('PASS maintenance runs while webhook delivery is pending');
  } finally {
    release();
    receiver.closeAllConnections();
    await service.stop();
    await new Promise(resolve=>receiver.close(resolve));
  }
}

try {
  for(const [name,run] of [['pause',pausedMaintenance],['slow-webhook',deliveryDoesNotBlockMaintenance]]) {
    try { await run(); }
    catch(error) { outcomes.push(`FAIL ${name}: ${error.message}`); }
  }
  for(const outcome of outcomes) console.log(outcome);
  if(outcomes.some(outcome=>outcome.startsWith('FAIL'))) process.exitCode=1;
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}
