#!/usr/bin/env node
// limits.json worker_claim_hint tells a worker to hold a few claims, not every free lane. It is guidance: the bridge's own
// next_queued suggestion shrinks to the hint minus the claims the worker touched in the last 3 minutes; free_lanes and every
// claim check stay as they were. A worker with no entry keeps the old suggestion (every free lane).
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

const dir=mkdtempSync(join(tmpdir(),'dalan-claim-hint-'));
const START=Date.parse('2026-11-26T16:00:00.000Z'), LEASE=480000, minute=60000, CAP=8;
let now=START;
const stores=[];
const open=(name,hint)=>{
  const s=new Store(join(dir,name+'.db'),{now:()=>now,capacity:CAP,resumeIdleMs:0,limits:{leaseMs:LEASE,laneCapacity:CAP,workerClaimHint:hint}});
  stores.push(s);
  for(let i=0;i<6;i++){ s.submit({schema_version:1,request_id:`${name}-${i}`,brief:'claim hint',inputs:[],expected_output:'one result',execution_scope:'read-only'},{mode:'none'},null,'owner'); now+=1000; }
  now=START;
  return s;
};
const claim=(s,id)=>s.claim(id,'holder','subject',CAP,null,'dot',null,LEASE,null);
const suggested=s=>s.nextQueued(s.freeLanes('subject','dot',CAP,CAP),null,'dot').next_queued?.length??0;

try {
  const hinted=open('hinted',{dot:3});
  assert.equal(hinted.claimHint('dot'),3);
  assert.equal(hinted.claimHint('muse'),null);
  assert.equal(suggested(hinted),3,'a worker holding nothing is told to take 3, not the 6 queued or the 8 free lanes');
  assert.match(hinted.nextQueued(8,null,'dot').next_action,/8 lanes free, 3 suggested: claim hinted-0, hinted-1, hinted-2 now/,'free lanes keep their real count; the smaller number is labelled as the suggestion');
  assert.match(hinted.nextQueued(8,null,'dot').next_action,/^6 queued and 8 lanes free, 3 suggested:/,'the count in the text is the count of listed rows');
  assert.equal(hinted.nextQueued(64,null,'dot',{applyHint:false}).next_queued.length,6,'a bridge pick that sets applyHint false sees every queued row');
  claim(hinted,'hinted-0');
  assert.equal(suggested(hinted),2,'it holds one, so two more');
  claim(hinted,'hinted-1');claim(hinted,'hinted-2');
  assert.equal(suggested(hinted),0,'it holds three: no suggestion');
  assert.deepEqual(hinted.nextQueued(5,null,'dot'),{},'no next_action either');
  assert.equal(hinted.nextQueued(64,null,'dot',{applyHint:false}).next_queued.length,3,'holding the hint number of claims, a bridge pick still sees every queued row');
  assert.equal(hinted.freeLanes('subject','dot',CAP,CAP),CAP-3,'free_lanes is unchanged');
  claim(hinted,'hinted-3'); // the hint refuses nothing
  now=START+4*minute;
  assert.equal(hinted.recentClaimCount('dot'),0,'claims untouched for 3 minutes no longer count: a new run resumes them');
  assert.equal(suggested(hinted),2,'nothing recent, so the hint allows 3, but only 2 of the 6 jobs are still queued');
  assert.match(hinted.nextQueued(hinted.freeLanes('subject','dot',CAP,CAP),null,'dot').next_action,/^2 queued and 4 lanes free, 2 suggested: claim hinted-4, hinted-5 now/,'the hint allows 3 but 2 rows are listed, so the text says 2 suggested');
  hinted.progress('hinted-0',hinted.get('hinted-0').claim.claim_id,'working','subject');
  assert.equal(hinted.recentClaimCount('dot'),1,'progress makes a claim recent again');

  now=START;
  const plain=open('plain',{});
  assert.equal(plain.claimHint('dot'),null);
  assert.equal(suggested(plain),6,'no entry: every queued job up to the free lanes, as before');
  console.log('PASS claim hint: suggestion shrinks to the hint, nothing is refused, no entry keeps every lane');
} finally {
  for(const s of stores) s.db.close();
}
