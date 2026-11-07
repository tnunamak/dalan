#!/usr/bin/env node
// Queue-wait evidence must stay cheap as lifecycle history grows. Each per-request lookup must use
// lifecycle_events_request; lifecycle_events_type_at rescans every event of one type for every assignment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp','dalan-queue-wait-perf-'));
process.env.HOME=home;
const {Store}=await import('../src/store.mjs');
// Generous margin for platform variance; this regression test checks query-plan selection and elapsed time.
const BUDGET_MS=1000;
try {
  const now=Date.parse('2026-10-26T12:00:00.000Z');
  const s=new Store(path.join(home,'facts.db'),{now:()=>now,capacity:20,backgroundMaxInFlight:20});
  const CLAIMED=3000, CLAIMS_EACH=3, EXPIRED=1000;
  const iso=ms=>new Date(ms).toISOString();
  const insA=s.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,owner_hash,review,delivery,priority,task_kind,source,target_worker,execution,cancelled_at,cancelled_reason) VALUES(?,?,?,?,?,?,?,?,0,'none','normal','review','agent','dot','host',?,?)");
  const insE=s.db.prepare("INSERT INTO lifecycle_events(request_id,claim_id,epoch,type,at,actor,source,reason,worker) VALUES(?,?,?,?,?,?,'backfill',?,?)");
  // One transaction keeps seeding fast; the rows are ordinary live history, not a special shape.
  s.db.exec('BEGIN');
  try {
    for (let i=0;i<CLAIMED+EXPIRED;i++) {
      const id=`perf_${i}`, created=now-(i%1000+1)*60000, expired=i>=CLAIMED;
      insA.run(id,'{}','h','','',expired?'cancelled':'finished',iso(created),`owner-${i}`,expired?iso(created+3600000):null,expired?'expired':null);
      if (expired) {
        insE.run(id,null,null,'cancelled',iso(created+3600000),'system','expired','dot');
        continue;
      }
      for (let k=0;k<CLAIMS_EACH;k++) insE.run(id,`claim_${i}_${k}`,k+1,'claimed',iso(created+(k+1)*1000),'owner',null,'dot');
    }
    s.db.exec('COMMIT');
  } catch (error) { s.db.exec('ROLLBACK'); throw error; }
  assert.equal(s.db.prepare('SELECT count(*) n FROM lifecycle_events').get().n,CLAIMED*CLAIMS_EACH+EXPIRED,'fixture seeds the intended lifecycle volume');

  // Capture the real prepared SQL of the queue-wait query instead of exporting a test-only API.
  const realPrepare=s.db.prepare.bind(s.db), captured=[];
  s.db.prepare=sql=>{ if(/FROM assignments a WHERE a\.created_at/.test(sql)) captured.push(sql); return realPrepare(sql); };
  const started=performance.now();
  const evidence=s.queueWaitEvidence('dot','review',7);
  const elapsed=performance.now()-started;
  s.db.prepare=realPrepare;

  assert.equal(captured.length,1,'queue-wait evidence runs one assignment query');
  // Claimed rows contribute one wait each; expired unclaimed rows are censored lower bounds that still count.
  assert.equal(evidence.samples,CLAIMED+EXPIRED,'every claimed and expired row contributes one sample');
  assert.equal(evidence.expired_lower_bounds,EXPIRED);
  assert.ok(elapsed<BUDGET_MS,`queue-wait evidence took ${Math.round(elapsed)}ms; budget ${BUDGET_MS}ms`);
  console.log(`timing: ${Math.round(elapsed)}ms for ${CLAIMED+EXPIRED} samples over ${CLAIMED*CLAIMS_EACH+EXPIRED} lifecycle events (budget ${BUDGET_MS}ms)`);

  // EXPLAIN: both per-request correlated lookups must use lifecycle_events_request and never the type_at index.
  const plan=realPrepare('EXPLAIN QUERY PLAN '+captured[0]).all('2026-10-19T12:00:00.000Z','dot','review').map(r=>r.detail).join('\n');
  console.log(`plan:\n${plan}`);
  assert.doesNotMatch(plan,/lifecycle_events_type_at/,'no per-request lookup may scan the type_at index');
  const requestIndexUses=plan.match(/lifecycle_events_request/g)?.length??0;
  assert.ok(requestIndexUses>=2,`both per-request lookups use lifecycle_events_request (found ${requestIndexUses})`);
  s.db.close();
  console.log('PASS queue-wait per-request lookups: request index only, within budget');
} finally {fs.rmSync(home,{recursive:true,force:true});}
console.log('queue-wait-perf-test: PASS');
