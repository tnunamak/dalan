#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareHostReceipts,writeHostStart,writeHostStop,readVerifiedHostStop,sealHostNotStarted,assertHostReceiptIsolation} from '../src/host-budget-receipts.mjs';

const temp=fs.mkdtempSync(path.join(os.homedir(),'.tmp','host-recovery-'));
process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(temp,'workspace-root');
const {Store}=await import('../src/store.mjs');
const {Workspace}=await import('../src/workspace.mjs');
const receiptDir=path.join(process.env.DOT_BRIDGE_WORKSPACE_ROOT,'host-receipts');
const invocationId='a'.repeat(32);
let now=100000;
const db=path.join(temp,'db.sqlite');
let store;
const assignment=id=>({schema_version:1,request_id:id,brief:'recovery fixture',inputs:[],expected_output:'one report',execution_scope:'read-only'});
const enroll=(id,{legacy=false}={})=>{
  store.submit(assignment(id),{mode:'none'},null,'owner');
  const claim=store.claim(id,'first','subject',10);
  store.db.prepare('INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,stop_evidence) VALUES(?,?,?,?,?,?,?,?)').run('check_'+id,id,claim.claim_id,'default','x','running',new Date(now).toISOString(),legacy?null:JSON.stringify({host:{verified:false,receipt_protocol:1,reason:'durable_host_admission_pending'}}));
  return {...prepareHostReceipts({receiptDir,checkRunId:'check_'+id}),invocationId};
};
try {
  store=new Store(db,{now:()=>now,limits:{leaseMs:1000}});
  new Workspace(store);
  const stopped=enroll('req_stopped');
  writeHostStart(stopped);
  writeHostStop({...stopped,verified:true,remaining_pids:[]});
  const running=enroll('req_running');writeHostStart(running);
  const rejected=enroll('req_admission_rejected');
  const legacy=enroll('req_legacy',{legacy:true});
  const surviving=enroll('req_survivors');writeHostStart(surviving);writeHostStop({...surviving,verified:false,remaining_pids:[123]});
  const corrupt=enroll('req_corrupt');writeHostStart(corrupt);
  const startFile=fs.readdirSync(receiptDir).find(name=>{const value=JSON.parse(fs.readFileSync(path.join(receiptDir,name)));return value.checkRunId===corrupt.checkRunId;});
  fs.writeFileSync(path.join(receiptDir,startFile),'{broken');
  store.db.close();
  store=new Store(db,{now:()=>now,limits:{leaseMs:1000}});
  const recovered=new Workspace(store); // genuine connection restart, no old promise Map
  now+=1000;
  assert.equal(store.claim('req_stopped','second','subject',10).epoch,2);
  assert.equal(store.claim('req_admission_rejected','second','subject',10).epoch,2);
  assert.throws(()=>writeHostStart(rejected),/EEXIST/,'a delayed service cannot start after the admission seal');
  for(const id of ['req_running','req_legacy','req_survivors','req_corrupt']) assert.throws(()=>store.claim(id,'second','subject',10),/claim_effects_unverified/,id);
  assert.equal(readVerifiedHostStop(running),null,'no stop receipt means unknown');
  writeHostStop({...running,verified:true,remaining_pids:[]});
  await recovered.quiesce('req_running');
  assert.equal(store.claim('req_running','second','subject',10).epoch,2,'positive stop arriving after restart releases only its own job');
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts').get().n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM check_runs').get().n,0,'recovery never publishes old output');
  assert.equal(readVerifiedHostStop(legacy),null,'legacy absence remains unknown');
  const seal={...prepareHostReceipts({receiptDir,checkRunId:'check_seal_race'}),invocationId};
  assert.equal(sealHostNotStarted(seal).notStarted,true);
  assert.throws(()=>writeHostStart(seal),/EEXIST/);
  assertHostReceiptIsolation(receiptDir,[path.join(temp,'absent')]);
  assert.throws(()=>assertHostReceiptIsolation(receiptDir,[temp]),/overlaps/);
  const alias=path.join(temp,'receipt-alias');fs.symlinkSync(receiptDir,alias);
  assert.throws(()=>assertHostReceiptIsolation(receiptDir,[alias]),/overlaps/);
  assert.throws(()=>assertHostReceiptIsolation(receiptDir,[path.join(receiptDir,startFile)]),/overlaps/);
  console.log('PASS restart recovery, delayed stop, admission sealing, legacy/unknown refusal, survivor/corrupt refusal, no stale output and mount aliases');
} finally {
  store?.db.close();
  fs.rmSync(temp,{recursive:true,force:true});
}

await import('./protocol-stop-observer-test.mjs');
