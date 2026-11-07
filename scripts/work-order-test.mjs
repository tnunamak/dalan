#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.homedir(),'.tmp','dalan-move2-unit-'));
process.env.HOME=home;
const {compileWorkOrder,VERDICT_EXIT,formatVerdict}=await import('../src/work-order.mjs');
const {validateSubmission,renderAssignment,submissionLimits}=await import('../src/submission-policy.mjs');
const {Store,QUEUE_WINDOW}=await import('../src/store.mjs');
const {dropEmptyPost54FixtureState}=await import('../src/test-support/pre-worker-fixture.mjs');
const {observeTransition}=await import('../src/failure-type.mjs');
const log=m=>console.log(`PASS ${m}`);
const files=['safe.txt','src/a.ts','src/dup.txt','docs/dup.txt'];
const scan=()=>({files,diff:'',diffFiles:[],symlinks:[]});
const assignment=(extra={})=>({schema_version:1,request_id:`req_${Math.random().toString(36).slice(2,12)}`,brief:'Inspect safe.txt',inputs:[{github_repo:'test/fixture',base_sha:'a'.repeat(40)}],scope_paths:['safe.txt'],expected_output:'findings',execution_scope:'read-only',...extra});
const state=(extra={})=>({paused:false,pause_reason:null,worker_break:null,queued:0,...extra});
const compile=(a,request={},deps={})=>compileWorkOrder({assignment:a,review:false,meta:{},target:'dot',jobExecution:'host',requiredCapabilities:null,...request},{render:renderAssignment,admitExecution:()=>{},validate:(p,{warnings})=>Promise.resolve().then(()=>validateSubmission(p,{scanInput:scan,warnings})),admitReadiness:()=>null,preflight:()=>null,state:()=>state(),kind:(r,p)=>r.meta?.task_kind??p.execution_scope,defaultValidity:()=>null,retryAfterSeconds:()=>120,...deps});
try {
  let order=await compile(assignment()); assert.equal(order.verdict,'admissible'); assert.deepEqual(order.reasons,[]); assert.equal(VERDICT_EXIT.defer,4);
  order=await compile(assignment({scope_paths:['.env']})); assert.equal(order.verdict,'reject'); assert.equal(order.reasons[0].code,'sensitive_path_hard');
  order=await compile(assignment({scope_paths:['src/aa.ts']})); assert.equal(order.verdict,'clarify'); assert.deepEqual(order.reasons[0].candidates,['src/a.ts']); assert.match(formatVerdict(order),/fix:/);
  order=await compile(assignment(),{}, {state:()=>state({paused:true,pause_reason:'owner pause'})}); assert.equal(order.verdict,'defer'); assert.equal(order.reasons[0].code,'worker_paused');
  order=await compile(assignment(),{}, {admitExecution:()=>{throw new Error('capability_not_available: run_check (missing executor)');}}); assert.equal(order.verdict,'defer'); assert.equal(order.blocking,true);
  order=await compile(assignment({execution_scope:'implementation',inputs:[{github_repo:'test/fixture',base_sha:'a'.repeat(40),head_sha:'b'.repeat(40)}]}),{}, {admitExecution:()=>{throw new Error('head_sha_unsupported: implementation scope cannot check a moving head');}}); assert.equal(order.verdict,'reject'); assert.equal(order.reasons[0].code,'head_sha_unsupported');
  order=await compile(assignment({scope_paths:['.env']}),{}, {state:()=>state({paused:true})}); assert.equal(order.verdict,'reject','scope rejection outranks defer');
  order=await compile(assignment({brief:'x'.repeat(submissionLimits.brief+41)})); assert.equal(order.bytes.over_by.brief,41); assert.equal(order.bytes.after_expansion,null);
  const adapterBrief='Repository note:\n'+'n'.repeat(400)+'\n\nInspect safe.txt';
  order=await compile(assignment({brief:adapterBrief})); assert.equal(order.bytes.brief,Buffer.byteLength(adapterBrief)); assert.ok(order.bytes.instructions>=order.bytes.brief);
  order=await compile(assignment({brief:'x'.repeat(submissionLimits.brief-20),output_paths:['new.md']})); assert.equal(order.verdict,'reject'); assert.ok(order.bytes.after_expansion.brief>submissionLimits.brief); assert.ok(order.bytes.over_by.brief>0);
  const requested='2026-10-30T00:00:00.000Z', sized={valid_until:'2026-10-25T00:00:00.000Z',window_ms:900000,p90_ms:300000,samples:5};
  let deadlineCalls=0; order=await compile(assignment({valid_until:requested}),{}, {defaultValidity:()=>{deadlineCalls++;return sized;}}); assert.deepEqual([order.valid_until.source,order.valid_until.value],['requester',requested]); assert.equal(deadlineCalls,0,'explicit caller deadline avoids queue history');
  let defaultCalls=0; order=await compile(assignment(),{}, {defaultValidity:()=>{defaultCalls++;return sized;}}); assert.deepEqual([order.valid_until.source,order.valid_until.value],['queue_p90',sized.valid_until]); assert.equal(defaultCalls,1,'normal default reads queue history once');
  let retryCalls=0; const spy={defaultValidity:()=>sized,retryAfterSeconds:()=>{retryCalls++;return 120;}};
  for(const a of [assignment(),assignment({scope_paths:['.env']}),assignment({scope_paths:['src/aa.ts']})]) { const before=retryCalls; const out=await compile(a,{},spy); assert.notEqual(out.verdict,'defer'); assert.equal(retryCalls,before); }
  const beforeMalformed=retryCalls; const malformedPaused=await compile(assignment({brief:123}),{}, {...spy,validate:p=>p,state:()=>state({paused:true})}); assert.equal(malformedPaused.verdict,'reject'); assert.equal(retryCalls,beforeMalformed,'an invalid paused order must not request a defer retry hint');
  order=await compile(assignment(),{priority:'background'},spy); assert.equal(order.valid_until.value,null); assert.equal(order.valid_until.source,'suppressed_background');
  order=await compile(assignment(),{}, {...spy,state:()=>state({paused:true})}); assert.equal(order.valid_until.value,null); assert.equal(order.valid_until.source,'suppressed_paused');
  order=await compile(assignment(),{}, {...spy,state:()=>state({worker_break:{since:'now'}})}); assert.equal(order.valid_until.value,null); assert.equal(order.valid_until.source,'suppressed_usage_break');
  const beforeDeferred=retryCalls; order=await compile(assignment(),{}, {...spy,state:()=>state({paused:true}),retryAfterSeconds:()=>{retryCalls++;return 120;}}); assert.equal(order.verdict,'defer'); assert.equal(retryCalls,beforeDeferred+1);
  let invalidHistoryCalls=0; order=await compile(assignment({inputs:'bad'}),{}, {...spy,defaultValidity:()=>{invalidHistoryCalls++;return sized;}}); assert.equal(order.reasons.some(r=>r.field==='inputs'&&r.code==='invalid_field'),true); assert.equal(order.normalized_scope.inputs.count,0); assert.equal(invalidHistoryCalls,0,'malformed order skips queue history');
  assert.match(formatVerdict({verdict:'reject',reasons:[],bytes:{brief:null,instructions:null,limits:{brief:10,instructions:10}}}),/brief unknown[\s\S]*instructions unknown/);
  order=await compile(assignment({valid_until:'yesterday-ish'})); assert.equal(order.verdict,'reject'); assert.equal(order.reasons[0].code,'invalid_valid_until');
  order=await compile(assignment({valid_until:'2020-01-01T00:00:00.000Z'})); assert.equal(order.verdict,'reject'); assert.equal(order.reasons[0].code,'validity_expired');
  log('compiler: admissible, clarify, reject, defer, precedence, bytes, pinned head rejection, caller deadline');

  let now=Date.parse('2026-10-20T00:00:00Z'); const iso=ms=>new Date(ms).toISOString();
  const store=new Store(path.join(home,'queue.db'),{now:()=>now,capacity:50,backgroundMaxInFlight:50}); let seq=0;
  const put=(worker='dot',kind='review',extra={},defaultDeadline=null)=>{const p=assignment({request_id:`unit_${++seq}_${Math.random().toString(36).slice(2,6)}`,...extra}); store.submit(p,{mode:'none'},'',`owner_${seq}`,false,null,'normal',{task_kind:kind},p,null,worker,null,'host',null,defaultDeadline); return p.request_id;};
  const claim=(id,worker='dot')=>store.claim(id,'fixture','local-principal',50,null,worker);
  const emptyHistory=store.defaultValidUntil('dot','review'); assert.deepEqual([emptyHistory.source,emptyHistory.samples],['insufficient_history',0]);
  for(let i=0;i<4;i++){const id=put(); now+=2*60000; claim(id);}
  const thinHistory=store.defaultValidUntil('dot','review'); assert.equal(thinHistory.valid_until,null,'fewer than minimum samples retain no default'); assert.deepEqual([thinHistory.source,thinHistory.samples,thinHistory.min_samples],['insufficient_history',4,5]);
  const fifth=put(); now+=2*60000; claim(fifth);
  const evidence=store.queueWaitEvidence('dot','review'); assert.equal(evidence.samples,5); assert.equal(evidence.waits_ms[0],2*60000);
  const sizedWindow=store.defaultValidUntil('dot','review'); assert.equal(sizedWindow.p90_ms,2*60000); assert.equal(sizedWindow.window_ms,QUEUE_WINDOW.minMs);
  assert.equal(store.defaultValidUntil('lark','review').source,'insufficient_history','worker evidence is isolated'); assert.equal(store.defaultValidUntil('dot','implementation').source,'insufficient_history','kind evidence is isolated');
  const direct=(id,priority='normal',deadline=sizedWindow.valid_until,worker='dot')=>{const p=assignment({request_id:id});store.submit(p,{mode:'none'},'',`owner_${id}`,false,null,priority,{task_kind:'review'},p,null,worker,null,'host',null,deadline);return store.get(id);};
  store.db.prepare("UPDATE operator_state SET paused_at=?,reason='preview race'").run(iso(now));
  const pauseRace=direct('store_pause_race'); assert.deepEqual([pauseRace.valid_until,pauseRace.valid_until_source],[null,null],'transaction suppresses default and provenance after pause races preview');
  const pausedExplicit='2026-10-30T00:00:00.000Z',explicitPayload=assignment({request_id:'store_pause_explicit',valid_until:pausedExplicit}); store.submit(explicitPayload,{mode:'none'},'','owner_explicit',false,null,'normal',{task_kind:'review'},explicitPayload,null,'dot',null,'host',null,sizedWindow.valid_until); assert.equal(store.get('store_pause_explicit').valid_until,pausedExplicit,'explicit deadlines survive pause');
  store.db.prepare('UPDATE operator_state SET paused_at=NULL,reason=NULL').run();
  store.db.prepare("INSERT INTO worker_breaks(since,reason,source,usage,created_at) VALUES(?,?,'owner','{}',?)").run(iso(now),'fixture',iso(now));
  const breakDefault=direct('store_break_default'); assert.deepEqual([breakDefault.valid_until,breakDefault.valid_until_source],[null,null],'transaction suppresses default and provenance during owner usage break');
  for(const priority of ['normal','background']) { const p=assignment({request_id:`store_break_explicit_${priority}`,valid_until:pausedExplicit});store.submit(p,{mode:'none'},'','owner_'+priority,false,null,priority,{task_kind:'review'},p,null,'dot',null,'host',null,sizedWindow.valid_until);assert.deepEqual([store.get(p.request_id).valid_until,store.get(p.request_id).valid_until_source],[pausedExplicit,'requester'],'an explicit deadline survives break and background guards'); }
  store.db.prepare("UPDATE worker_breaks SET until=?,end_source='owner' WHERE until IS NULL").run(iso(now));
  const backgroundDefault=direct('store_background','background'); assert.deepEqual([backgroundDefault.valid_until,backgroundDefault.valid_until_source],[null,null],'background never receives a queue default or provenance');
  const defaultId=put('dot','review',{},sizedWindow.valid_until); assert.equal(store.get(defaultId).valid_until_source,'queue_p90'); assert.equal(store.get(defaultId).valid_until,sizedWindow.valid_until); assert.equal(JSON.parse(store.get(defaultId).assignment&&store.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get(defaultId).payload).valid_until,undefined,'default deadline stays outside request identity');
  // Add a second claim epoch. The first persisted claim remains the measurement endpoint.
  const claimRow=store.db.prepare('SELECT claim_id,epoch FROM claims WHERE request_id=?').get(fifth); now+=10*60000; store.lifecycle(fifth,'claimed','system','resume',{...claimRow,worker:'dot'}); assert.equal(store.queueWaitEvidence('dot','review').waits_ms[4],2*60000);
  for(let i=0;i<5;i++){const id=put('dot','review',{valid_until:iso(now+60000)}); now+=2*60000; store.sweepExpired(); assert.equal(store.get(id).cancelled_reason,'expired'); assert.equal(store.get(id).failure_type,'expired'); assert.equal(store.get(id).failure_type_source,'bridge_observed_transition');}
  const censored=store.queueWaitEvidence('dot','review'); assert.equal(censored.expired_lower_bounds,6); assert.ok(store.defaultValidUntil('dot','review').expired_lower_bounds===6);
  const ownerExpired=put('lark','review');now+=60000;store.cancel(ownerExpired,'expired');
  assert.equal(store.queueWaitEvidence('lark','review').samples,0,'owner reason text must not fabricate a system-expiry queue sample');
  const caller=iso(now+60000), id=put('dot','review',{valid_until:caller});
  assert.equal(store.get(id).valid_until,caller);
  assert.equal(store.get(id).valid_until_source,'requester');
  const ownerEnded=put();store.cancel(ownerEnded,'owner stopped');assert.deepEqual([store.get(ownerEnded).failure_type,store.get(ownerEnded).failure_type_source],['owner_cancelled','bridge_observed_transition']);
  const leaseEnded=put(),leaseClaim=claim(leaseEnded);store.abandon(leaseEnded,{actor:'system',reason:'lease_expired'});store.cancel(leaseEnded,'owner stopped later');assert.deepEqual([store.get(leaseEnded).failure_type,store.get(leaseEnded).failure_type_source],['owner_cancelled','bridge_observed_transition']);
  assert.deepEqual(observeTransition({leaseExpired:true}),{type:'lease_expired',source:'bridge_observed_transition'});
  const reportEnded=put(),reportClaim=claim(reportEnded);store.finish(reportEnded,reportClaim.claim_id,'blocked','BLOCKED: opaque vendor text','');assert.deepEqual([store.get(reportEnded).failure_type,store.get(reportEnded).failure_type_source],['worker_blocked','worker_text_inference']);
  const recovered=put(),recoveredClaim=claim(recovered);
  store.lifecycle(recovered,'check_failed','system','earlier failed check',{claim_id:recoveredClaim.claim_id,epoch:1,worker:'dot'});
  store.finish(recovered,recoveredClaim.claim_id,'completed','fixed and verified','result');
  assert.equal(store.get(recovered).failure_type,null,'an earlier check failure is not the cause of a successful result');
  assert.equal(store.get(recovered).check_failed_observed,true,'the earlier check fact remains visible after recovery');
  log('queue sizing: worker and kind, first claim, censored expiry lower bounds, immutable caller deadline');
  log('failure provenance: expiry vs owner cancel vs observed lease expiry vs worker text inference');

  // Construct an honest v44 fixture by removing only the additive v45 column, then upgrade twice.
  dropEmptyPost54FixtureState(store.db);
  store.db.exec('ALTER TABLE assignments DROP COLUMN valid_until_source; PRAGMA user_version=44;'); store.db.close();
  const upgraded=new Store(path.join(home,'queue.db'),{now:()=>now,capacity:50,backgroundMaxInFlight:50});
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,65); upgraded.migrate(); assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,65);
  assert.equal(upgraded.db.prepare("SELECT name FROM pragma_table_info('assignments') WHERE name='valid_until_source'").get().name,'valid_until_source');
  assert.ok(upgraded.db.prepare('SELECT request_id,valid_until FROM assignments LIMIT 1').get());
  assert.equal(upgraded.db.prepare('SELECT valid_until_source FROM assignments WHERE valid_until IS NOT NULL LIMIT 1').get().valid_until_source,null,'historical deadline provenance remains NULL');
  upgraded.db.close(); log('migration: baseline v44 upgrade, idempotence, old-column read compatibility');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
console.log('work-order-test: PASS');
