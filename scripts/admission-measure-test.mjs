#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp','dalan-move2-measure-'));
process.env.HOME=home;
const {measureRefusals,measureTerminalFacts}=await import('./admission-measure.mjs');
const {Store}=await import('../src/store.mjs');
try {
  const at='2026-10-24T12:00:00.000Z',line=e=>JSON.stringify({at,kind:'submit_rejected',status:400,...e});
  const rows=[line({request_id:'retry-a',reason_codes:['unknown_scope_path'],source:'agent',task_kind:'review',objective_key:'o1',revision:'r1',attempt_latency_ms:8,bytes:{over_by:{brief:0,instructions:0}}}),
    line({request_id:'retry-a',reason_codes:['unknown_scope_path'],source:'agent',task_kind:'review',objective_key:'o1',revision:'r1',attempt_latency_ms:14}),
    line({request_id:'policy',reason_codes:['sensitive_path_hard'],attempt_latency_ms:9}),
    line({request_id:'defer',verdict:'defer',reason_codes:['worker_paused'],attempt_latency_ms:10}),
    line({request_id:'unknown',reason_codes:['refused'],attempt_latency_ms:11}),
    line({request_id:'legacy',reason:'unknown scope path: src/a.ts'}),
    line({request_id:'overflow',reason_codes:['brief_too_large'],bytes:{over_by:{brief:123,instructions:0}}}),
    line({request_id:'transport',status:503,reason:'unavailable'}),
    JSON.stringify({at,kind:'submit_dry_run',request_id:'preview',verdict:'admissible'})];
  rows.push(JSON.stringify({at:'not-a-time',kind:'submit_rejected',status:400,request_id:'bad-time',reason_codes:['unknown_scope_path']}));
  const m=measureRefusals(rows,{sinceMs:0,untilMs:Date.parse(at)+1,storedIds:new Set(['retry-a'])});
  assert.equal(m.refusal_events,7); assert.equal(m.request_id_retry_groups,6); assert.equal(m.request_id_proxy_preventable_groups,3);
  assert.equal(m.declared_objective_cohorts.groups,1); assert.equal(m.declared_objective_cohorts.preventable_events,2); assert.equal(m.declared_objective_cohorts.missing_objective_tuple_events,5);
  assert.deepEqual(m.deduplicated_intent_denominator,{value:null,status:'unknown',missing_binding_events:7,reason:'no authenticated binding establishes that separate requests share one user intent; source and producer labels are not identity'});
  assert.equal(m.explicit_typed_policy_denial_events,1); assert.equal(m.deferred_events,1); assert.equal(m.unknown_or_unmapped_events,1);
  assert.equal(m.post_expansion_overflow.reasons,1); assert.equal(m.post_expansion_overflow.events_with_expanded_byte_counts,0); assert.equal(m.transport_events,1); assert.equal(m.dry_run_events,1); assert.equal(m.per_attempt_submit_response_latency_ms.samples,5); assert.equal(m.per_attempt_submit_response_latency_ms.missing,2);
  assert.equal(m.request_id_proxy_later_stored,1); assert.ok(m.legacy_keyword_guesses.unknown_scope_path>=1); assert.equal(m.missing_timestamp_events,1);
  const digest=s=>createHash('sha256').update(s).digest('hex');
  const mixed=measureRefusals([rows[0],line({request_id:'hashed-labels',reason_codes:['unknown_scope_path'],task_kind:'review',objective_key_sha256:digest('o1'),revision_sha256:digest('r1')})]);
  assert.equal(mixed.declared_objective_cohorts.groups,1,'digest logs and legacy labels preserve the same declared cohort');
  assert.equal(mixed.deduplicated_intent_denominator.value,null,'hashed labels do not prove intent identity');
  let now=Date.parse(at),seq=0;const s=new Store(path.join(home,'facts.db'),{now:()=>now,capacity:20,backgroundMaxInFlight:20});
  const put=()=>{const id=`measure_${++seq}`,p={schema_version:1,request_id:id,brief:'x',inputs:[],expected_output:'x',execution_scope:'read-only'};s.submit(p,{mode:'none'},'',`owner-${id}`);return id;};
  const expired=put();s.db.prepare("UPDATE assignments SET status='cancelled',cancelled_at=?,cancelled_reason='expired' WHERE request_id=?").run(at,expired);s.lifecycle(expired,'cancelled','system','expired',null);
  const cancelled=put();s.cancel(cancelled,'expired');assert.equal(s.get(cancelled).failure_type,'owner_cancelled');assert.equal(s.get(cancelled).expired,undefined);
  const leaseThenCancel=put(),claim=s.claim(leaseThenCancel,'fixture','local-principal',20);s.abandon(leaseThenCancel,{actor:'system',reason:'lease_expired'});s.cancel(leaseThenCancel,'owner stopped after requeue');
  const blocked=put(),c=s.claim(blocked,'fixture','local-principal',20);s.lifecycle(blocked,'check_failed','system','prior independent check failure',{claim_id:c.claim_id,epoch:1,worker:'dot'});s.finish(blocked,c.claim_id,'blocked','BLOCKED: opaque explanation','');
  const failure=s.get(blocked);assert.equal(failure.failure_type,'worker_blocked');assert.equal(failure.check_failed_observed,true);
  const recoveredLease=put(),first=s.claim(recoveredLease,'fixture','local-principal',20);s.abandon(recoveredLease,{actor:'system',reason:'lease_expired'});
  const firstRow=s.db.prepare('SELECT * FROM claims WHERE request_id=?').get(recoveredLease);
  assert.throws(()=>s.claim(recoveredLease,'fixture','local-principal',20),/claim_busy: prior lease has not expired/,'reclaim ignored the active lease');
  assert.equal(s.db.prepare('SELECT claim_id,last_claim_activity_at FROM claims WHERE request_id=?').get(recoveredLease).claim_id,first.claim_id,'early reclaim changed the grant');
  now=Date.parse(firstRow.last_claim_activity_at)+s.limits.leaseMs+1;
  const second=s.claim(recoveredLease,'fixture','local-principal',20);s.finish(recoveredLease,second.claim_id,'completed','later recovered','result');
  const facts=measureTerminalFacts(s.db,Date.parse(at)-1,Date.parse(at)+1);assert.equal(facts.total,4);assert.equal(facts.expired,1);assert.equal(facts.owner_cancelled,2);assert.equal(facts.lease_expired_operational_events,2,'observed lease events remain counted after later recovery');assert.equal(facts.worker_reported_noncompleted,1);assert.equal(facts.unknown_other,1,'a generic BLOCKED outcome does not establish its cause');assert.equal(facts.expired_share,25,'terminal shares use percent units');assert.match(facts.provenance.worker_reported_noncompleted,/inference, not cause/);
  s.db.close();
  const missingLog=spawnSync(process.execPath,['scripts/admission-measure.mjs','--db',path.join(home,'facts.db'),'--log',path.join(home,'absent.jsonl'),'--since','2026-10-23T00:00:00Z','--until','2026-10-25T00:00:00Z'],{encoding:'utf8'});
  assert.equal(missingLog.status,0,missingLog.stderr);
  const missingReport=JSON.parse(missingLog.stdout);assert.equal(missingReport.source.request_log_state,'missing');assert.equal(missingReport.report.refusals,null,'a missing log does not prove zero refusals');
  console.log('PASS measurement: retry proxy, explicit intent cohort, missingness, policy denials, defer/unknown, byte overflow, response latency, old log guesses');
  console.log('PASS terminal facts: expiry separate from owner cancel; worker report remains report-only');
} finally {fs.rmSync(home,{recursive:true,force:true});}
console.log('admission-measure-test: PASS');
