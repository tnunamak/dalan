#!/usr/bin/env node
// Opt-in claim throttle per worker (limits.json worker_claim_min_gap_ms): a token that claimed a job less than the gap ago cannot take
// another yet. A session that grabs several claims in a burst and then ends leaves the later ones dead, so the refusal tells the worker to
// work one claim and report it before claiming another. Default: no throttle.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, loadRedeliveryLimits } from '../src/store.mjs';
import { parseWorkers } from '../src/workers.mjs';

const MIN=60000, GAP=20000, CAP=8, dir=mkdtempSync(join(tmpdir(),'dalan-claim-throttle-'));
let now=Date.parse('2026-11-25T00:00:00.000Z');
const base={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:60*MIN};
const open=(name,limits)=>{
  const s=new Store(join(dir,`${name}.db`),{now:()=>now,random:()=>0.5,capacity:CAP,limits:{...base,...limits}});
  const connections=subject=>[{issuer:'issuer',subject,client_id:'client'}];
  s.workers=parseWorkers({workers:{dot:{connections:connections('subject_d')},muse:{connections:[...connections('subject_m'),...connections('subject_n')]}}});
  return s;
};
const payload=id=>({schema_version:1,request_id:id,brief:`throttle ${id}`,inputs:[],expected_output:'one result',execution_scope:'read-only'});
const submit=(s,...ids)=>{for(const id of ids){s.submit(payload(id),'thread_fake','env_fake','owner',false,null,'normal',null,payload(id),null,id.startsWith('d')?'dot':'muse');s.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id=?").run(id);}};
const pass=message=>console.log(`PASS ${message}`);

try {
  {
    const s=open('gap',{workerClaimMinGapMs:{muse:GAP}});
    submit(s,'m1','m2','m3','d1','d2');
    const m1=s.claim('m1','muse-run','subject_m',CAP,null,'muse');
    assert.match(m1.guidance,/report it before (?:you )?claim(?:ing)? another/i,'a throttled worker is told to work one claim at a time');
    assert.throws(()=>s.claim('m2','muse-run','subject_m',CAP,null,'muse'),error=>/claim_throttled/.test(error.message)&&/report it before (?:you )?claim(?:ing)? another/i.test(error.message)&&/retry/i.test(error.message));
    assert.equal(s.db.prepare("SELECT status FROM assignments WHERE request_id='m2'").get().status,'queued','a throttled claim leaves the job queued');
    assert.equal(s.db.prepare("SELECT count(*) n FROM claims WHERE request_id='m2'").get().n,0,'a throttled claim writes no claim row');
    assert.equal(s.claim('m1','muse-run','subject_m',CAP,null,'muse').claim_id,m1.claim_id,'a retry of the held claim is idempotent, not throttled');
    now+=GAP-1;
    assert.throws(()=>s.claim('m2','muse-run','subject_m',CAP,null,'muse'),/claim_throttled/,'still inside the gap');
    now+=1;
    assert.equal(s.claim('m2','muse-run','subject_m',CAP,null,'muse').duplicate,false,'allowed once the gap has passed');
    assert.throws(()=>s.claim('m3','muse-run','subject_m',CAP,null,'muse'),/claim_throttled/,'the gap restarts from the newest claim');
    pass('a throttled token gets claim_throttled with the one-at-a-time text, no row, and is let through after the gap');

    const other=s.claim('m3','muse-run','subject_n',CAP,null,'muse');
    assert.ok(other.claim_id,'another token is not throttled by the first one');
    s.claim('d1','dot-run','subject_d',CAP,null,'dot');s.claim('d2','dot-run','subject_d',CAP,null,'dot');
    pass('another token, and a worker with no gap set, are not throttled');
    s.db.close();
  }
  {
    const s=open('finished',{workerClaimMinGapMs:{muse:GAP}});
    submit(s,'f1','f2');
    const f1=s.claim('f1','muse-run','subject_m',CAP,null,'muse');
    s.finish('f1',f1.claim_id,'completed','done','done','subject_m',null,'muse');
    assert.ok(s.claim('f2','muse-run','subject_m',CAP,null,'muse').claim_id,'a finished claim no longer holds the token back');
    s.db.close();
    pass('reporting the claim lets the token claim again at once');
  }
  {
    const s=open('default',{});
    submit(s,'x1','x2','x3');
    for(const id of ['x1','x2','x3'])assert.ok(s.claim(id,'muse-run','subject_m',CAP,null,'muse').claim_id);
    assert.doesNotMatch(s.claim('x1','muse-run','subject_m',CAP,null,'muse').guidance,/report it before/i,'no throttle, no extra guidance');
    s.db.close();
    pass('without the limits field nothing changes');
  }
  {
    const file=join(dir,'limits.json');
    const load=value=>{writeFileSync(file,JSON.stringify(value),{mode:0o600});return loadRedeliveryLimits(file);};
    assert.deepEqual(load({}).workerClaimMinGapMs,{},'default: no throttle');
    assert.equal(load({worker_claim_min_gap_ms:{muse:20000}}).workerClaimMinGapMs.muse,20000);
    for(const bad of [{muse:999},{muse:600001},{muse:'20000'},{Muse:20000},null,[20000]])assert.throws(()=>load({worker_claim_min_gap_ms:bad}),/invalid worker_claim_min_gap_ms/,JSON.stringify(bad));
    pass('limits.json worker_claim_min_gap_ms is validated: 1000..600000 ms per lower-case worker name');
  }
} finally { rmSync(dir,{recursive:true,force:true}); }
