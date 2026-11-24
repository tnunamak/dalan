#!/usr/bin/env node
// worker_claim_capacity: a per-worker cap below the global claim cap, applied to claims and to the lanes a worker is told are free.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseWorkers } from '../src/workers.mjs';

const MIN=60000, CAP=8, dir=mkdtempSync(join(tmpdir(),'dalan-worker-claim-capacity-'));
let now=Date.parse('2026-11-24T00:00:00.000Z');
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:60*MIN,laneCapacity:6};
const payload=id=>({schema_version:1,request_id:id,brief:`capacity ${id}`,inputs:[],expected_output:'one result',execution_scope:'read-only'});
const workers=parseWorkers({workers:{dot:{connections:[{issuer:'issuer',subject:'dot',client_id:'dot'}]},muse:{connections:[{issuer:'issuer',subject:'muse',client_id:'muse'}]}}});
const open=(name,capacity,workerClaimCapacity)=>new Store(join(dir,`${name}.db`),{now:()=>now,random:()=>0.5,capacity,workers,limits:{...limits,workerClaimCapacity}});
const submit=(s,worker,...ids)=>{for(const id of ids)s.submit(payload(id),{mode:'none'},null,'owner',false,null,'normal',null,null,null,worker,'worker');};
const pass=message=>console.log(`PASS ${message}`);

try {
  const s=open('bridge',CAP,{muse:2});
  submit(s,'muse','m1','m2','m3');submit(s,'dot','d1','d2','d3');
  assert.equal(s.laneState('owner','muse').free_lanes,2,'muse is told at most its own cap');
  assert.equal(s.laneState('owner','dot').free_lanes,6,'other workers keep the lane capacity');
  const m1=s.claim('m1','muse','owner',CAP,null,'muse');s.claim('m2','muse','owner',CAP,null,'muse');
  assert.throws(()=>s.claim('m3','muse','owner',CAP,null,'muse'),/^Error: capacity_full$/,'muse beyond its cap');
  assert.equal(s.laneState('owner','muse').free_lanes,0);
  assert.equal(s.claim('m1','muse','owner',CAP,null,'muse').claim_id,m1.claim_id,'a retry at the cap stays idempotent');
  for(const id of ['d1','d2','d3'])s.claim(id,'dot','owner',CAP,null,'dot');
  assert.equal(s.laneState('owner','dot').free_lanes,3,'dot is not limited by the muse cap');
  s.finish('m1',m1.claim_id,'completed','done','done','owner',null,'muse');
  assert.equal(s.laneState('owner','muse').free_lanes,1,'a finished claim frees a muse lane');
  assert.equal(s.claim('m3','muse','owner',CAP,null,'muse').duplicate,false);
  s.db.close();
  pass('muse stops at its cap in claim and in free_lanes; dot keeps the global cap; a finish frees a lane');

  const g=open('global',1,{muse:5});
  submit(g,'muse','g1','g2');
  g.claim('g1','muse','owner',1,null,'muse');
  assert.throws(()=>g.claim('g2','muse','owner',1,null,'muse'),/^Error: capacity_full$/,'a worker cap above the global cap does not raise it');
  g.db.close();
  pass('a worker cap never raises the global claim cap');
} finally { rmSync(dir,{recursive:true,force:true}); }
