import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';

// A claim advertises one wall deadline and enforces a monotonic one. Both must come from the same instant:
// if the process stalls between the two clock reads, the enforced deadline lands after the advertised one and
// the old grant stays authoritative past the deadline the worker was told.
const scratch=path.join(process.env.HOME||os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'lease-clock-origin-'));
const lease=120,start=Date.parse('2026-11-19T12:00:00Z');
// Every clock read advances time by `step` ms, like a process that is descheduled between reads. `step` is 0 while we inspect.
let elapsed=1000,step=0;
const tick=()=>{elapsed+=step;return elapsed;};
const payload=id=>({schema_version:1,request_id:id,brief:'lease clock origin',inputs:[],expected_output:'result',execution_scope:'read-only'});
let store;
try {
  store=new Store(path.join(root,'bridge.db'),{now:()=>start,elapsedNow:tick,bootId:'test-boot',limits:{leaseMs:60000}});
  const row=id=>store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
  const assertBoundary=(id,label)=>{
    const grant=row(id);
    assert.equal(store.get(id).claim.lease_expires_at,grant.lease_deadline_at);
    const delta=Date.parse(grant.lease_deadline_at)-store.nowMs();
    assert.ok(delta>1,`${label}: setup must leave a live lease`);
    elapsed+=delta-0.25;
    assert.equal(store.leaseExpired(grant),false,`${label}: expired before advertised deadline`);
    elapsed+=0.25;
    assert.equal(store.leaseExpired(grant),true,`${label}: remained live at advertised deadline`);
    elapsed+=0.25;
    assert.equal(store.leaseExpired(grant),true,`${label}: remained live after advertised deadline`);
    // Each later fixture starts on an integer clock tick.
    elapsed+=0.75;
  };

  store.submit(payload('claim-stall'),{mode:'none'},null,'owner');
  step=3;
  store.claim('claim-stall','worker','s1',1,null,'dot',null,lease);
  step=0;
  assertBoundary('claim-stall','short grant with stalled clock');

  store.submit(payload('activity-stall'),{mode:'none'},null,'owner');
  step=0;
  store.claim('activity-stall','worker','s2',1,null,'dot',null,lease);
  step=3;
  store.touchClaim('activity-stall',row('activity-stall').claim_id,'s2','dot');
  step=0;
  assertBoundary('activity-stall','legacy touch with stalled clock');

  const renewId='renew-stall', subject='s-renew';
  store.submit({...payload(renewId),protocol:{profile:'job-v0',source:'fixture',scope:'fixture',
    policy:'fixture',destination:'fixture',retain_until_ms:start+60000}},{mode:'none'},null,'owner');
  const original=store.claim(renewId,'worker',subject,1,null,'dot','renew-acq',lease,{key:'grant',revision:1});
  step=3;
  const renewed=store.renewClaim(renewId,original.claim_id,240,{key:'renew',revision:original.revision},subject,'dot');
  step=0;
  assert.notEqual(renewed.lease_expires_at,original.lease_expires_at);
  assert.equal(renewed.lease_expires_at,row(renewId).lease_deadline_at);
  assertBoundary(renewId,'explicit protocol renewal with stalled clock');

  // Without a stall the two deadlines still agree, and one tick before the deadline the grant is live.
  store.submit(payload('no-stall'),{mode:'none'},null,'owner');
  store.claim('no-stall','worker','s3',1,null,'dot',null,lease);
  assertBoundary('no-stall','short grant without stall');
  console.log('lease-deadline-clock-origin ok');
} finally {
  try{store?.db.close();}catch{}
  fs.rmSync(root,{recursive:true,force:true});
}
