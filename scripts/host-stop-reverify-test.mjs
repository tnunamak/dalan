#!/usr/bin/env node
// A stop recorded as unverified must not block a job for ever, and must never be released without fresh proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareHostReceipts,writeHostStart,writeHostStop,readVerifiedHostStop} from '../src/host-budget-receipts.mjs';
import {readCgroupProcesses} from '../src/host-cgroup.mjs';

const temp=fs.mkdtempSync(path.join(os.homedir(),'.tmp','host-reverify-'));
process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(temp,'workspace-root');
const {Store}=await import('../src/store.mjs');
const {Workspace}=await import('../src/workspace.mjs');
const receiptDir=path.join(process.env.DOT_BRIDGE_WORKSPACE_ROOT,'host-receipts');
const invocationId='a'.repeat(32),BOOT='11111111-2222-3333-4444-555555555555',OTHER_BOOT='99999999-2222-3333-4444-555555555555';
const CGROUP='/user.slice/user-1000.slice/user@1000.service/app.slice/dot-bridge-host-check.service';
let now=100000;
const db=path.join(temp,'db.sqlite');
let store;
const assignment=id=>({schema_version:1,request_id:id,brief:'reverify fixture',inputs:[],expected_output:'one report',execution_scope:'read-only'});
const enroll=(id,{start={bootId:BOOT,cgroup:CGROUP},stop='survivor'}={})=>{
  store.submit(assignment(id),{mode:'none'},null,'owner');
  const claim=store.claim(id,'first','subject',10);
  store.db.prepare('INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,stop_evidence) VALUES(?,?,?,?,?,?,?,?)').run('check_'+id,id,claim.claim_id,'default','x','running',new Date(now).toISOString(),JSON.stringify({host:{verified:false,receipt_protocol:1,reason:'durable_host_admission_pending'}}));
  const options={...prepareHostReceipts({receiptDir,checkRunId:'check_'+id}),invocationId};
  writeHostStart({...options,...start});
  if(stop==='survivor') writeHostStop({...options,verified:false,remaining_pids:[4242]});
  return options;
};
const files=()=>fs.readdirSync(receiptDir).filter(n=>n.endsWith('.json')).sort();
const bytesOf=kind=>fs.readFileSync(path.join(receiptDir,files().find(n=>n.endsWith('.'+kind+'.json'))));
// Reopen the store: the previous process is gone, only durable receipts remain.
const restart=(deps)=>{store.db.close();store=new Store(db,{now:()=>now,limits:{leaseMs:1000}});return new Workspace(store,true,{stopReverify:deps});};
const claimsAgain=id=>{now+=1;return store.claim(id,'second','subject',10).epoch;};
const refused=id=>assert.throws(()=>store.claim(id,'second','subject',10),/claim_effects_unverified/,id);
try {
  store=new Store(db,{now:()=>now,limits:{leaseMs:1000}});
  new Workspace(store);

  // Survivor that later exits: refused while it lives, released once a fresh scan is empty. Original verdict is kept.
  const later=enroll('req_later');
  let procs=[4242];const scanned=[];
  const deps={bootId:()=>BOOT,unitInactive:()=>true,scan:dir=>{scanned.push(dir);return procs;}};
  let ws=restart(deps);now+=1000;
  refused('req_later');
  await ws.quiesce('req_later');refused('req_later');
  assert.equal(readVerifiedHostStop(later),null,'a live survivor stays unverified');
  assert.deepEqual(scanned.at(-1),'/sys/fs/cgroup'+CGROUP,'the scan reads the recorded cgroup');
  const original=bytesOf('stop');
  procs=[];
  await ws.quiesce('req_later');
  assert.equal(store.claim('req_later','second','subject',10).epoch,2,'survivor exited: the claim proceeds');
  assert.deepEqual(bytesOf('stop'),original,'the stop receipt is never overwritten');
  assert.equal(JSON.parse(bytesOf('reverify')).basis,'cgroup_empty');
  assert.equal(JSON.parse(store.db.prepare('SELECT stop_evidence FROM check_jobs WHERE id=?').get('check_req_later').stop_evidence).host.reason,'durable_systemd_control_group_reverified');

  // Unit still active: an empty scan is not enough.
  enroll('req_active');
  ws=restart({bootId:()=>BOOT,unitInactive:()=>false,scan:()=>[]});now+=1000;
  await ws.quiesce('req_active');refused('req_active');

  // Changed boot id: a reboot proves every process is gone, with no scan.
  enroll('req_reboot');
  ws=restart({bootId:()=>OTHER_BOOT,unitInactive:()=>{throw new Error('not needed');},scan:()=>{throw new Error('not needed');}});now+=1000;
  await ws.quiesce('req_reboot');
  assert.equal(claimsAgain('req_reboot'),2);

  // Read errors and missing evidence keep the stop unverified.
  enroll('req_scan_error');
  ws=restart({bootId:()=>BOOT,unitInactive:()=>true,scan:()=>{throw Object.assign(new Error('EACCES'),{code:'EACCES'});}});now+=1000;
  await ws.quiesce('req_scan_error');refused('req_scan_error');
  ws=restart({bootId:()=>{throw new Error('no boot id');},unitInactive:()=>true,scan:()=>[]});now+=1000;
  await ws.quiesce('req_scan_error');refused('req_scan_error');
  ws=restart({bootId:()=>'not-a-boot-id',unitInactive:()=>true,scan:()=>[]});now+=1000;
  await ws.quiesce('req_scan_error');refused('req_scan_error');
  enroll('req_no_boot_id',{start:{cgroup:CGROUP}});
  ws=restart({bootId:()=>OTHER_BOOT,unitInactive:()=>true,scan:()=>[]});now+=1000;
  await ws.quiesce('req_no_boot_id');refused('req_no_boot_id');
  enroll('req_no_cgroup',{start:{bootId:BOOT}});
  ws=restart({bootId:()=>BOOT,unitInactive:()=>true,scan:()=>[]});now+=1000;
  await ws.quiesce('req_no_cgroup');refused('req_no_cgroup');

  // A recorder that crashed before writing any stop is recovered the same way, never by a flag.
  enroll('req_no_stop',{stop:null});
  ws=restart({bootId:()=>BOOT,unitInactive:()=>true,scan:()=>[]});now+=1000;
  await ws.quiesce('req_no_stop');
  assert.equal(claimsAgain('req_no_stop'),2);

  // cgroup.procs: a line that is not a positive integer is unreadable evidence, not an absent process.
  const cg=path.join(temp,'cg');fs.mkdirSync(path.join(cg,'child'),{recursive:true});
  fs.writeFileSync(path.join(cg,'cgroup.procs'),'');fs.writeFileSync(path.join(cg,'child','cgroup.procs'),'77\n');
  assert.deepEqual(readCgroupProcesses(cg,1),[77]);
  for(const bad of ['abc\n','0\n','-5\n','12x\n','1.5\n','12\n\nabc\n']) {
    fs.writeFileSync(path.join(cg,'cgroup.procs'),bad);
    assert.throws(()=>readCgroupProcesses(cg,1),/unreadable cgroup\.procs/,JSON.stringify(bad));
  }
  console.log('PASS stop re-verification: survivor exits, live survivor, active unit, changed boot id, read errors, missing evidence, no overwrite, strict cgroup.procs');
} finally {try{store.db.close();}catch{}fs.rmSync(temp,{recursive:true,force:true});}
