#!/usr/bin/env node
// Per-claimant claim capacity: each subject counts only its own active claims; status keeps the global count.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseWorkers } from '../src/workers.mjs';

const MIN=60000, LEASE=60*MIN, CAP=2, dir=mkdtempSync(join(tmpdir(),'dalan-bridge-claim-capacity-'));
let now=Date.parse('2026-10-08T00:00:00.000Z');
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:LEASE};
const open=name=>new Store(join(dir,`${name}.db`),{now:()=>now,random:()=>0.5,capacity:CAP,limits});
const payload=id=>({schema_version:1,request_id:id,brief:`capacity ${id}`,inputs:[],expected_output:'one result',execution_scope:'read-only'});
const submit=(s,...ids)=>{for(const id of ids){s.submit(payload(id),'thread_fake','env_fake','owner');s.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id=?").run(id);}};
const klass=(s,id)=>s.liveness().items.find(i=>i.request_id===id)?.class;
const pass=message=>console.log(`PASS ${message}`);

try {
  {
    const s=open('subjects');
    submit(s,'a1','a2','a3','b1','b2','b3');
    const a1=s.claim('a1','dot','subject_a',CAP,null,'dot','subject-a-run');s.claim('a2','dot','subject_a',CAP,null,'dot','subject-a-run');
    assert.throws(()=>s.claim('a3','dot','subject_a',CAP),/^Error: capacity_full$/,'same subject beyond its cap');
    s.claim('b1','other','subject_b',CAP);s.claim('b2','other','subject_b',CAP);
    assert.throws(()=>s.claim('b3','other','subject_b',CAP),/^Error: capacity_full$/);
    assert.equal(s.claim('a1','dot','subject_a',CAP,null,'dot','subject-a-run').claim_id,a1.claim_id,'retry at capacity must stay idempotent');
    const st=s.status();
    assert.equal(st.claimed_outer_count,4,'claimed_outer_count must stay the global total');
    assert.equal(st.max_claimed_outer_assignments,CAP);
    assert.deepEqual(st.priority_counts.normal,{queued:2,claimed:4});
    assert.equal(s.activeClaims('subject_a','dot').length,2);assert.equal(s.activeClaims('subject_b','dot').length,2);assert.equal(s.activeClaims('subject_c','dot').length,0);
    s.finish('a1',a1.claim_id,'completed','done','done','subject_a');
    assert.equal(s.claim('a3','dot','subject_a',CAP).duplicate,false,'a finished claim frees the subject slot');
    s.db.close();
  }
  pass('two subjects each hold up to the cap; the same subject beyond it gets capacity_full; status keeps the global count');

  {
    const s=open('takeover');
    submit(s,'t_a','t_b1','t_b2');
    const held=s.claim('t_a','dot','subject_a',CAP);now+=1; // the taker's own claims outlive t_a's lease by 1 ms
    const b1=s.claim('t_b1','other','subject_b',CAP);s.claim('t_b2','other','subject_b',CAP);
    now+=LEASE-1;
    const before=JSON.stringify(s.db.prepare('SELECT * FROM claims WHERE request_id=?').get('t_a'));
    assert.throws(()=>s.claim('t_a','other','subject_b',CAP),/^Error: capacity_full$/,'takeover must respect the taker cap');
    assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM claims WHERE request_id=?').get('t_a')),before,'refused takeover changed the claim');
    s.finish('t_b1',b1.claim_id,'completed','done','done','subject_b');
    const taken=s.claim('t_a','other','subject_b',CAP);
    assert.equal(taken.epoch,2);assert.notEqual(taken.claim_id,held.claim_id);
    assert.equal(s.activeClaims('subject_a','dot').length,0);assert.equal(s.activeClaims('subject_b','dot').length,2);
    s.db.close();
  }
  pass('takeover counts against the taker, not the previous holder');

  // at_capacity_healthy uses the subscribed subjects' own claims; one live subject behaves as before
  {
    const s=open('liveness');
    s.subscribe('sub_dot','http://127.0.0.1/hook','whsec_test',new Date(now+48*3600000).toISOString(),'subject_a');
    submit(s,'l_a1','l_a2','l_b1','l_b2','l_q');
    s.claim('l_a1','dot','subject_a',CAP);s.claim('l_b1','other','subject_b',CAP);s.claim('l_b2','other','subject_b',CAP);
    s.recordWorkerCall('subject_a','list_pending');
    now+=25*MIN;s.recordWorkerCall('subject_a','get');
    assert.equal(s.status().claimed_outer_count,3);
    assert.equal(klass(s,'l_q'),'alive_not_claiming','another subject filling slots must not hide a worker with a free slot');
    s.claim('l_a2','dot','subject_a',CAP);
    assert.equal(klass(s,'l_q'),'at_capacity_healthy','one live subject at its cap is at capacity');
    assert.equal(s.reannounceQueued().announced,0,'re-announce while the worker is at capacity');
    s.subscribe('sub_other','http://127.0.0.1/hook2','whsec_test',new Date(now+48*3600000).toISOString(),'subject_c');
    assert.notEqual(klass(s,'l_q'),'at_capacity_healthy','a second live subject with free slots is not at capacity');
    s.db.close();
  }
  pass('at_capacity_healthy counts each subscribed subject against its own cap; one live subject behaves as before');

  // A finished legacy claim cannot select the old subject lane after new claims use worker lanes.
  {
    const s=open('profile-change');submit(s,'old','new','queued');
    const old=s.claim('old','dot','subject_a',CAP);s.finish('old',old.claim_id,'completed','done','done','subject_a');
    now+=MIN;
    s.workers=parseWorkers({workers:{dot:{connections:[{issuer:'issuer',subject:'subject_a',client_id:'client'}]}}});
    s.claim('new','dot','subject_a',1);
    assert.equal(s.db.prepare("SELECT lane_key FROM claims WHERE request_id='old'").get().lane_key,'subject_a');
    assert.equal(s.activeClaims('subject_a','dot').length,1);
    assert.equal(s.laneState('subject_a','dot',6,1).free_lanes,0);
    s.db.close();
  }
  pass('finished subject lanes keep their attribution and do not override current worker lane hints');

  console.log('PASS claim capacity test');
} catch(error) { console.error(`FAIL ${error.stack||error}`); process.exitCode=1; }
finally { rmSync(dir,{recursive:true,force:true}); }
