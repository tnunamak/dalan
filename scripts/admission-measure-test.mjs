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
  const {spawn}=await import('node:child_process'),{request}=await import('node:http'),{once}=await import('node:events');
  const childHome=path.join(home,'admission-http');
  fs.mkdirSync(path.join(childHome,'.config','dalan'),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(childHome,'.config','dalan','workers.json'),JSON.stringify({workers:{local:{connections:[{issuer:'https://fixture.invalid',subject:'local',client_id:'fixture'}],repos:['tnunamak/dalan']}}}),{mode:0o600});
  const child=spawn(process.execPath,['--input-type=module','-e',"import {main} from './src/server.mjs'; await main({loopbackOnly:true});"],{
    env:{...process.env,HOME:childHome,DALAN_PORT:'0',DALAN_BIND_HOST:'127.0.0.1',DALAN_LOOPBACK_PROBE_MS:'0',DALAN_DEV_ALLOW_UNAUTHENTICATED:'1',DALAN_TRUST_PROXY:''},
    stdio:['ignore','pipe','pipe'],
  });
  const closed=once(child,'close');
  let output='', diagnostics='';
  child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-2000);});
  try {
    const socketPath=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('fixture admin socket did not start: '+diagnostics)),10000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('close',code=>{clearTimeout(timeout);reject(new Error('fixture server exited '+code+': '+diagnostics));});
      child.stdout.on('data',chunk=>{
        output=(output+chunk).slice(-4000);
        const line=/^admin socket (.+)\r?$/m.exec(output);
        if(line){clearTimeout(timeout);resolve(line[1]);}
      });
    });
    const requestAssignment=(raw,route='/submit-preview')=>new Promise((resolve,reject)=>{
      const body=typeof raw==='string'?raw:JSON.stringify(raw);
      const req=request({socketPath,path:route,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
        const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('error',reject);
        res.on('end',()=>{try{resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(parts).toString())});}catch(error){reject(error);}});
      });
      req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('fixture request timed out')));req.end(body);
    });
    const preview=raw=>requestAssignment(raw);
    const fixture={owner_token:'fixture-owner',delivery:'none',assignment:{schema_version:1,request_id:'preview-fixture',brief:'Check fixture',inputs:[],execution_scope:'read-only',expected_output:'review report'}};
    const bad=await preview({...fixture,assignment:{...fixture.assignment,request_id:'preview-head-mismatch',execution_scope:'implementation',
      inputs:[{github_repo:'tnunamak/dalan',base_sha:'a'.repeat(40),head_sha:'b'.repeat(40)}]}});
    assert.equal(bad.status,200);
    assert.equal(bad.value.verdict,'reject');assert.equal(bad.value.stored,false);
    assert.ok(bad.value.reasons.some(reason=>reason.code==='head_sha_unsupported'),JSON.stringify(bad.value.reasons));
    assert.ok(bad.value.admission&&typeof bad.value.admission==='object','early refusal includes advisory admission');
    const malformed=await preview('{');
    assert.equal(malformed.status,400);assert.equal('admission' in malformed.value,false);
    const good=await preview(fixture);
    assert.equal(good.status,200);assert.equal(good.value.verdict,'admissible');
    assert.ok(good.value.admission);assert.equal(good.value.stored,false);
    const protectedRepo={...fixture,worker:'local',assignment:{...fixture.assignment,
      request_id:'preview-private-repo',inputs:[{github_repo:'example-owner/absent',base_sha:'a'.repeat(40)}]}};
    const blocked=await preview(protectedRepo);
    assert.equal(blocked.status,200);
    assert.notEqual(blocked.value.verdict,'admissible');
    assert.equal(blocked.value.stored,false);
    assert.ok(blocked.value.reasons.length>0);
    assert.equal('admission' in blocked.value,false,'repo authorization precedes advisory access');

    const realRefusal=await requestAssignment(protectedRepo,'/submit');
    assert.ok(realRefusal.status>=400);
    assert.equal('admission' in realRefusal.value,false,'real refusal never returns advisory data');

    const withId=request_id=>({...fixture,worker:'local',assignment:{...fixture.assignment,request_id}});
    const missing=await preview({...withId('preview-missing-supersedes'),
      supersedes:{target_id:'missing-fixture-row',target_token:fixture.owner_token}});
    assert.equal(missing.status,200);
    assert.notEqual(missing.value.verdict,'admissible');
    assert.equal(missing.value.stored,false);
    assert.match(JSON.stringify(missing.value.reasons),/supersed|not found/i);

    for(const id of ['preview-replacement-target','preview-unrelated-job']){
      const seeded=await requestAssignment(withId(id),'/submit');
      assert.equal(seeded.status,200,JSON.stringify(seeded.value));
      assert.equal(seeded.value.status,'queued');
    }
    const proposed=withId('preview-replacement');
    const ordinary=await preview(proposed);
    const replacement=await preview({...proposed,
      supersedes:{target_id:'preview-replacement-target',target_token:fixture.owner_token}});
    assert.equal(replacement.value.stored,false);
    assert.equal(replacement.value.admission.ahead.count,ordinary.value.admission.ahead.count-1);
    const unchanged=await preview(proposed);
    assert.equal(unchanged.value.admission.ahead.count,ordinary.value.admission.ahead.count,'neither preview stores or replaces a job');
  } finally {
    child.kill();
    await closed;
  }
  console.log('PASS measurement: retry proxy, explicit intent cohort, missingness, policy denials, defer/unknown, byte overflow, response latency, old log guesses');
  console.log('PASS terminal facts: expiry separate from owner cancel; worker report remains report-only');
} finally {fs.rmSync(home,{recursive:true,force:true});}
console.log('admission-measure-test: PASS');
