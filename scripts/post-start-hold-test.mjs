#!/usr/bin/env node
// After a bridge start the sweep holds a claim that was idle before the start for its whole lease, unless limits.json
// worker_post_start_hold_ms names a shorter hold for its worker. A worker with an 8 minute lease (muse) kept every lane
// held for up to 8 minutes after a restart, although the claims had run out and nobody was working them.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

const dir=mkdtempSync(join(tmpdir(),'dalan-post-start-hold-'));
const START=Date.parse('2026-11-26T14:00:00.000Z'), LEASE=480000;
const minute=60000;
let now=START;
const stores=new Set();
const HOLD=2*minute;
let holds={};
const open=name=>{
  const s=new Store(join(dir,name+'.db'),{now:()=>now,capacity:1,resumeIdleMs:0,limits:{leaseMs:LEASE,laneCapacity:1,workerPostStartHoldMs:holds}});
  stores.add(s);return s;
};
const close=s=>{s.db.close();stores.delete(s);};
const payload=id=>({schema_version:1,request_id:id,brief:'post-start hold',inputs:[],expected_output:'one result',execution_scope:'read-only'});
const claimed=name=>{
  now=START;
  const s=open(name);
  s.submit(payload(name),{mode:'none'},null,'owner');
  s.claim(name,'holder','subject',1,null,'dot',null,LEASE,null);
  return s;
};
const lane=s=>s.freeLanes('subject','dot',1,1);

try {
  holds={dot:HOLD};
  { // The 14:34Z case: restart 5 minutes into the lease. The lease ends at +8; the old hold kept the lane until +13.
    const id='restart-before-deadline';
    let s=claimed(id);
    now=START+5*minute;close(s);s=open(id);
    now=START+8*minute-1;
    assert.deepEqual(s.sweepStaleLeases(),[],'a live lease is not swept');
    now=START+8*minute;
    assert.equal(lane(s),0);
    assert.deepEqual(s.sweepStaleLeases(),[id],'the lease ran out after the restart: the sweep frees the lane at the deadline');
    assert.equal(lane(s),1);
    close(s);
  }
  { // The lease ran out while the bridge was down: the worker gets the post-start hold, no more.
    const id='deadline-while-down';
    let s=claimed(id);
    now=START+9*minute;close(s);s=open(id);
    assert.deepEqual(s.sweepStaleLeases(),[],'held at the start');
    now=START+9*minute+HOLD-1;
    assert.deepEqual(s.sweepStaleLeases(),[],'held until the hold ends');
    now=START+9*minute+HOLD;
    assert.deepEqual(s.sweepStaleLeases(),[id],'freed when the hold ends, not a whole lease later');
    assert.equal(lane(s),1);
    close(s);
  }
  { // A claim the worker touched after the start has no hold at all.
    const id='touched-after-start';
    let s=claimed(id);
    now=START+5*minute;close(s);s=open(id);
    now=START+6*minute;
    const view=s.get(id);
    s.progress(id,view.claim.claim_id,'still working','subject');
    now=START+14*minute;
    assert.deepEqual(s.sweepStaleLeases(),[id],'the new deadline is 14:06+8 = 14:14');
    close(s);
  }
  { // No entry for the worker: the hold stays the whole lease.
    const id='no-entry';
    holds={};
    let s=claimed(id);
    now=START+9*minute;close(s);s=open(id);
    now=START+9*minute+HOLD;
    assert.deepEqual(s.sweepStaleLeases(),[],'an unconfigured worker is still held for its whole lease');
    now=START+9*minute+LEASE;
    assert.deepEqual(s.sweepStaleLeases(),[id]);
    close(s);
  }
  console.log('PASS post-start hold: per-worker cap, whole lease otherwise');
} finally {
  for(const s of stores) s.db.close();
}
