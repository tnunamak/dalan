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
  // Move the clock to the instant the worker was told the grant ends, then ask whether the grant is still live.
  const atAdvertisedDeadline=id=>{const delta=Date.parse(row(id).lease_deadline_at)-store.nowMs();elapsed+=delta;return store.leaseExpired(row(id));};

  store.submit(payload('claim-stall'),{mode:'none'},null,'owner');
  step=3;
  store.claim('claim-stall','worker','s1',1,null,'dot',null,lease);
  step=0;
  assert.equal(atAdvertisedDeadline('claim-stall'),true,'a claim must stop being authoritative at the deadline it advertised, even if the process stalled while granting it');

  store.submit(payload('activity-stall'),{mode:'none'},null,'owner');
  step=0;
  store.claim('activity-stall','worker','s2',1,null,'dot',null,lease);
  step=3;
  store.touchClaim('activity-stall',row('activity-stall').claim_id,'s2','dot');
  step=0;
  assert.equal(atAdvertisedDeadline('activity-stall'),true,'activity that extends a lease must stop being authoritative at the deadline it advertised, even if the process stalled while renewing');

  // Without a stall the two deadlines still agree, and one tick before the deadline the grant is live.
  store.submit(payload('no-stall'),{mode:'none'},null,'owner');
  store.claim('no-stall','worker','s3',1,null,'dot',null,lease);
  elapsed+=Date.parse(row('no-stall').lease_deadline_at)-store.nowMs()-1;
  assert.equal(store.leaseExpired(row('no-stall')),false,'one millisecond before the advertised deadline the grant is still live');
  elapsed+=1;
  assert.equal(store.leaseExpired(row('no-stall')),true,'at the advertised deadline the grant is expired');
  console.log('lease-deadline-clock-origin ok');
} finally {
  try{store?.db.close();}catch{}
  fs.rmSync(root,{recursive:true,force:true});
}
