#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readVerifiedHostStop} from '../src/host-budget-receipts.mjs';

const controllerMode=process.argv[2]==='controller';
if(!controllerMode) await import('./require-host-checks.mjs');
const temp=controllerMode?process.argv[3]:fs.mkdtempSync(path.join(os.homedir(),'.tmp','host-recovery-live-'));
const checkRunId=controllerMode?process.argv[4]:`live_${randomUUID().replaceAll('-','')}`;
const marker=controllerMode?process.argv[5]:`host-recovery-${randomUUID()}`;
const dir=path.join(temp,'guest'), workspaceRoot=path.join(temp,'work'), receiptDir=path.join(workspaceRoot,'host-receipts');
const budgets={cpu_ms:3000,wall_ms:15000,memory_bytes:192*1024**2,processes:32,disk_write_bytes:8*1024**2,output_bytes:8192};
if(controllerMode) {
  const {runHostBudget}=await import('../src/host-budget.mjs');
  try {
    const payload=`const fs=require('node:fs');const assert=require('node:assert/strict');
      assert.equal(process.env.INVOCATION_ID,undefined);
      assert.equal(JSON.parse(fs.readFileSync('/config.json','utf8')).receipts,undefined);
      assert.throws(()=>fs.readdirSync(${JSON.stringify(receiptDir)}));
      assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(receiptDir,'forged'))},'fake'));
      process.title=${JSON.stringify(marker)};
      const child=require('node:child_process').spawn('/usr/bin/sleep',['60'],{argv0:${JSON.stringify(marker+'_child')},detached:true,stdio:'ignore'});
      child.once('spawn',()=>{process.stdout.write('PRIVATE_LEDGER_REFUSED');setInterval(()=>{},1000);});`;
    await runHostBudget({dir,budgets,checkRunId,receiptDir,phases:[{name:'check',argv:['/runtime/node','-e',payload]}],onOutputStarted:event=>process.send({event:'output',...event})});
  } catch(error) {process.send({event:'error',message:error.message});}
  process.exit(0);
}
process.env.DOT_BRIDGE_WORKSPACE_ROOT=workspaceRoot;
const {Store}=await import('../src/store.mjs');
const {Workspace}=await import('../src/workspace.mjs');
const {runHostBudget}=await import('../src/host-budget.mjs');
const db=path.join(temp,'state.db'),requestId='req_host_recovery';
let now=100000,store,controller;
const matchingPids=()=>fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).filter(p=>{
  try {const first=fs.readFileSync(`/proc/${p}/cmdline`,'utf8').split('\0')[0];return first===marker||first===marker+'_child';}catch{return false;}
});
try {
  fs.mkdirSync(dir,{mode:0o700});
  store=new Store(db,{now:()=>now,limits:{leaseMs:1000}});
  new Workspace(store);
  store.submit({schema_version:1,request_id:requestId,brief:'real host restart fixture',inputs:[],expected_output:'one result',execution_scope:'read-only'},{mode:'none'},null,'owner');
  const claim=store.claim(requestId,'first','subject',6);
  store.db.prepare('INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,stop_evidence) VALUES(?,?,?,?,?,?,?,?)').run(checkRunId,requestId,claim.claim_id,'default','x','running',new Date(now).toISOString(),JSON.stringify({host:{verified:false,receipt_protocol:1,reason:'durable_host_admission_pending'}}));
  controller=fork(new URL(import.meta.url),['controller',temp,checkRunId,marker],{execPath:process.execPath,env:{...process.env,DALAN_HOST_CHECKS:'1'},stdio:['ignore','pipe','pipe','ipc']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('timed out awaiting real guest output')),20000);
    controller.on('message',message=>{clearTimeout(timer);message.event==='output'?resolve(message):reject(new Error(message.message));});
    controller.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error(`controller exited before output: ${code}/${signal}`));});
  });
  const startedPids=matchingPids();assert.equal(startedPids.length,2,'observe both actual guest and detached child');
  const startFile=path.join(receiptDir,fs.readdirSync(receiptDir).find(file=>file.endsWith('.start.json')));
  const start=JSON.parse(fs.readFileSync(startFile));
  assert.equal(start.checkRunId,checkRunId);
  assert.equal(fs.statSync(receiptDir).mode&0o777,0o700);
  assert.equal(fs.statSync(startFile).mode&0o777,0o600);
  store.db.close();store=null;
  const exited=new Promise(resolve=>controller.once('exit',resolve));controller.kill('SIGKILL');await exited;
  store=new Store(db,{now:()=>now,limits:{leaseMs:1000}});
  const recovered=new Workspace(store);now+=1000;
  const deadline=Date.now()+20000;let stop;
  while(!(stop=readVerifiedHostStop({receiptDir,checkRunId}))) {
    assert.throws(()=>store.claim(requestId,'second','subject',6),/claim_effects_unverified/);
    assert(Date.now()<deadline,'positive durable stop missing after controller death');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(stop.invocationId,start.invocationId);assert.deepEqual(stop.remaining_pids,[]);
  await recovered.quiesce(requestId);
  assert.equal(store.claim(requestId,'second','subject',6).epoch,2);
  assert.deepEqual(matchingPids(),[],'no marker process may survive regrant');
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifacts').get().n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM check_runs').get().n,0);
  const phases=[{name:'check',argv:['/usr/bin/true']}];
  await assert.rejects(runHostBudget({dir,budgets,phases,checkRunId:checkRunId+'_alias',receiptDir,sourceExemptions:[{hostPath:receiptDir,path:'alias'}],enabled:true}),/overlaps/);
  const positive=await runHostBudget({dir,budgets,phases,checkRunId:checkRunId+'_positive',receiptDir,enabled:true});
  assert.equal(positive.exit.code,0,JSON.stringify(positive));assert.equal(positive.stop.verified,true);
  console.log('PASS actual controller SIGKILL, durable invocation stop, Store restart/regrant, no stale outputs or descendants, private guest ledger, alias refusal and current host positive');
} finally {
  store?.db.close();
  if(controller&&controller.exitCode===null&&controller.signalCode===null)controller.kill('SIGKILL');
  fs.rmSync(temp,{recursive:true,force:true});
}
