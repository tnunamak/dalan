#!/usr/bin/env node
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
// Lifecycle events at store level with a fake clock: one event per transition in the same transaction, append-only
// triggers, backfill of a pre-v21 database, metrics math on a hand-built timeline, and the retention roll-up.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { lifecycleMetrics, retainLifecycle, backfillLifecycle, explainMetrics } from '../src/lifecycle.mjs';

const MIN=60000, HOUR=60*MIN, DAY=24*HOUR, LEASE=HOUR, dir=mkdtempSync(join(tmpdir(),'dalan-bridge-lifecycle-'));
let now=Date.parse('2026-10-08T00:00:00.000Z');
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:LEASE,laneCapacity:2};
const open=name=>new Store(join(dir,`${name}.db`),{now:()=>now,random:()=>0.5,capacity:2,limits});
const payload=(id,extra={})=>({schema_version:1,request_id:id,brief:`lifecycle ${id}`,inputs:[],expected_output:'one result',execution_scope:'read-only',...extra});
const events=(s,id)=>s.db.prepare('SELECT type,actor,source,reason,claim_id,epoch FROM lifecycle_events WHERE request_id=? ORDER BY id').all(id).map(e=>({...e}));
const types=(s,id)=>events(s,id).map(e=>e.type);
const last=(s,id)=>events(s,id).at(-1);
const total=s=>s.db.prepare('SELECT count(*) n FROM lifecycle_events').get().n;
const deliveryFence=(s,id)=>{const n=s.db.prepare('SELECT * FROM notifications WHERE id=?').get(id),a=s.db.prepare('SELECT status,delivery delivery_mode,thread_id,environment_id,target_worker FROM assignments WHERE request_id=?').get(n.request_id),r=s.db.prepare('SELECT outcome,summary,result FROM reports WHERE request_id=?').get(n.request_id)??null;return {attemptId:n.attempt_id,attemptStartedAt:n.attempt_started_at,body:n.body,argv:n.argv,threadId:a.thread_id,environmentId:a.environment_id,targetWorker:a.target_worker,assignmentStatus:a.status,deliveryMode:a.delivery_mode,reportSnapshot:JSON.stringify(r)};};
const pass=message=>console.log(`PASS ${message}`);

try {
  // ---- each transition writes exactly the expected event, with actor and the claim in force
  {
    const s=open('transitions');
    s.submit(payload('req_a'),{mode:'none'},null,'owner');
    assert.deepEqual(events(s,'req_a'),[{type:'queued',actor:'owner',source:'live',reason:null,claim_id:null,epoch:null}]);
    const c1=s.claim('req_a','dot','subject_a',6,null,'dot','req-a-run');
    assert.deepEqual(last(s,'req_a'),{type:'claimed',actor:'worker:subject_a',source:'live',reason:'new',claim_id:c1.claim_id,epoch:1});
    s.claim('req_a','dot','subject_a',6,null,'dot','req-a-run');
    assert.equal(types(s,'req_a').length,2,'an idempotent claim retry wrote an event');
    s.progress('req_a',c1.claim_id,'reading the code','subject_a');
    s.progress('req_a',c1.claim_id,'BLOCKED: need a token','subject_a');
    s.progress('req_a',c1.claim_id,'QUESTION: which branch?','subject_a');
    s.progress('req_a',c1.claim_id,'flagged','subject_a',true);
    assert.deepEqual(types(s,'req_a').slice(2),['working','blocked','waiting','blocked']);
    assert.deepEqual([last(s,'req_a').claim_id,last(s,'req_a').epoch,last(s,'req_a').actor],[c1.claim_id,1,'worker:subject_a']);
    const prior=s.db.prepare('SELECT * FROM claims WHERE request_id=?').get('req_a');
    assert.throws(()=>s.resume('req_a','subject_a'),/claim_busy: prior lease has not expired/,'idle resume ignored the active lease');
    assert.equal(s.db.prepare('SELECT claim_id FROM claims WHERE request_id=?').get('req_a').claim_id,c1.claim_id,'early resume changed the active grant');
    now=Date.parse(prior.last_claim_activity_at)+LEASE+1;
    const r=s.resume('req_a','subject_a');
    assert.deepEqual(last(s,'req_a'),{type:'claimed',actor:'worker:subject_a',source:'live',reason:'resume',claim_id:r.claim_id,epoch:2});
    s.abandon('req_a',{actor:'operator',reason:'stuck'});
    assert.deepEqual(events(s,'req_a').slice(-2),[{type:'abandoned',actor:'operator',source:'live',reason:'stuck',claim_id:r.claim_id,epoch:2},{type:'queued',actor:'operator',source:'live',reason:'requeued',claim_id:null,epoch:null}]);
    const abandoned=s.db.prepare('SELECT * FROM claims WHERE request_id=?').get('req_a');
    assert.throws(()=>s.claim('req_a','dot','subject_b',6),/claim_busy: prior lease has not expired/,'abandon allowed a new epoch before the prior lease expired');
    assert.equal(s.db.prepare('SELECT claim_id,last_claim_activity_at FROM claims WHERE request_id=?').get('req_a').claim_id,r.claim_id,'early reclaim changed the abandoned grant');
    now=Date.parse(abandoned.last_claim_activity_at)+LEASE+1;
    const c3=s.claim('req_a','dot','subject_b',6);
    assert.deepEqual(last(s,'req_a'),{type:'claimed',actor:'worker:subject_b',source:'live',reason:'reclaim',claim_id:c3.claim_id,epoch:3});
    now+=LEASE+MIN;
    const c4=s.claim('req_a','rival','subject_c',6);
    assert.deepEqual(events(s,'req_a').slice(-2),[{type:'abandoned',actor:'system',source:'live',reason:'lease_expired: 0 calls, no workspace tool',claim_id:c3.claim_id,epoch:3},{type:'claimed',actor:'worker:subject_c',source:'live',reason:'takeover',claim_id:c4.claim_id,epoch:4}]);
    s.finish('req_a',c4.claim_id,'blocked','could not finish','details','subject_c');
    assert.deepEqual(events(s,'req_a').slice(-2).map(e=>[e.type,e.reason,e.epoch]),[['completed','outcome=blocked',4],['blocked',null,4]]);
    const before=total(s);
    s.finish('req_a',c4.claim_id,'blocked','could not finish','details','subject_c');
    assert.equal(total(s),before,'a duplicate finish wrote an event');

    // cancel, then a late report
    s.submit(payload('req_late'),{mode:'none'},null,'owner');
    const cl=s.claim('req_late','dot','subject_a',6);
    s.cancel('req_late'); s.cancel('req_late');
    assert.deepEqual(events(s,'req_late').slice(-1).map(e=>[e.type,e.actor,e.claim_id]),[['cancelled','owner',cl.claim_id]]);
    assert.equal(types(s,'req_late').filter(t=>t==='cancelled').length,1,'a repeated cancel wrote a second event');
    const lateTypes=types(s,'req_late');
    assert.throws(()=>s.finish('req_late',cl.claim_id,'completed','late','late result','subject_a'),/assignment_cancelled/);
    assert.deepEqual(types(s,'req_late'),lateTypes,'late evidence writes no lifecycle event');
    s.submit(payload('req_cancel_queued'),{mode:'none'},null,'owner'); s.cancel('req_cancel_queued');
    assert.deepEqual(last(s,'req_cancel_queued'),{type:'cancelled',actor:'owner',source:'live',reason:null,claim_id:null,epoch:null});
    pass('submit, claim (new/reclaim/resume/takeover), progress classes, abandon, finish, cancel and late finish each write their event');

    // owner consumption: the first wait delivery of a result, then never again; get after finish counts the same way
    s.submit(payload('req_wait'),{mode:'none'},null,'owner');
    const cw=s.claim('req_wait','dot','subject_a',6);
    s.progress('req_wait',cw.claim_id,'QUESTION: ok?','subject_a');
    const question=s.claimWaiterDelivery('req_wait',0); s.settleWaiterDelivery(question.id);
    assert.ok(!types(s,'req_wait').includes('consumed'),'a delivered question counted as consumption');
    assert.equal(s.recordConsumed('req_wait','get'),false,'get before finish counted as consumption');
    s.finish('req_wait',cw.claim_id,'completed','done','result','subject_a');
    const result=s.claimWaiterDelivery('req_wait',0); s.settleWaiterDelivery(result.id);
    assert.deepEqual([last(s,'req_wait').type,last(s,'req_wait').actor,last(s,'req_wait').reason],['consumed','owner','wait']);
    assert.equal(s.recordConsumed('req_wait','get'),false);
    assert.equal(types(s,'req_wait').filter(t=>t==='consumed').length,1,'consumed is first-time only');
    // verdicts: only on finished work; reject is a consumed event with reason rejected
    assert.throws(()=>s.verdict('req_cancel_queued',true),/only a finished assignment/);
    s.verdict('req_wait',false,'wrong file');
    assert.deepEqual([last(s,'req_wait').type,last(s,'req_wait').reason],['consumed','rejected: wrong file']);
    s.verdict('req_wait',true,'fixed by hand');
    assert.deepEqual([last(s,'req_wait').type,last(s,'req_wait').actor,last(s,'req_wait').reason],['accepted','owner','fixed by hand']);
    assert.deepEqual(s.integrated('req_wait','merged pr 1').duplicate,false);
    assert.deepEqual(s.integrated('req_wait','merged pr 1').duplicate,true);
    assert.deepEqual(types(s,'req_wait').filter(t=>t==='integrated').length,1,'integrated is idempotent per request');
    assert.equal(events(s,'req_wait').find(e=>e.type==='integrated').actor,'fix-loop');
    assert.throws(()=>s.integrated('req_unknown_1'),/assignment not found/);
    pass('consumed once per request (wait result or get after finish), accept/reject only on finished work, integrated idempotent');

    // delivery: t3 sends, uncertain sends, reconcile, interrupted sends; webhook events write nothing
    s.submit(payload('req_t3'),{mode:'t3',threadId:'thread_lifecycle_1'},'env','owner');
    const ct=s.claim('req_t3','dot','subject_a',6);
    s.progress('req_t3',ct.claim_id,'BLOCKED: one','subject_a');
    // Questions are deliverable only while the assignment remains active.
    const blocker=s.db.prepare("SELECT id FROM notifications WHERE request_id='req_t3' AND kind='blocker'").get();
    let attempt=s.startAttempt(blocker.id,null); s.finishAttempt(blocker.id,attempt.attempt_id,'delivered');
    assert.deepEqual([last(s,'req_t3').type,last(s,'req_t3').actor,last(s,'req_t3').reason,last(s,'req_t3').claim_id],['delivery_sent','system','blocker',ct.claim_id]);
    s.finish('req_t3',ct.claim_id,'completed','done','result','subject_a');
    const res=s.db.prepare("SELECT id FROM notifications WHERE request_id='req_t3' AND kind='t3'").get();
    attempt=s.startAttempt(res.id,null); s.finishAttempt(res.id,attempt.attempt_id,'uncertain','socket closed');
    assert.deepEqual([last(s,'req_t3').type,last(s,'req_t3').reason],['delivery_uncertain','t3']);
    s.finishAttempt(res.id,attempt.attempt_id,'delivered');
    assert.equal(last(s,'req_t3').type,'delivery_uncertain','a no-op finishAttempt wrote an event');
    s.reconciled(res.id,'uncertain','still unknown',deliveryFence(s,res.id));
    assert.equal(last(s,'req_t3').type,'delivery_uncertain','an unresolved reconcile wrote an event');
    s.reconciled(res.id,'delivered','marker found',deliveryFence(s,res.id));
    assert.deepEqual([last(s,'req_t3').type,last(s,'req_t3').reason],['reconciled','t3']);
    s.db.prepare("INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES('evt_watch_send','watch','req_t3','sending',?)").run(s.stamp());
    s.recoverSends();
    assert.deepEqual([last(s,'req_t3').type,last(s,'req_t3').reason],['delivery_uncertain','watch: interrupted send']);
    s.subscribe('sub_x','http://x','s','2099-01-01T00:00:00Z','p','dot');
    s.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,body,created_at) VALUES('evt_webhook','event','req_t3','sub_x','{}',?)").run(s.stamp());
    const n=total(s); attempt=s.startAttempt('evt_webhook',null); s.finishAttempt('evt_webhook',attempt.attempt_id,'delivered');
    assert.equal(total(s),n,'a webhook event wrote a lifecycle event');
    pass('delivery_sent, delivery_uncertain, reconciled and interrupted sends recorded for t3/blocker/watch only');

    // check events, as the workspace writes them: started, passed, failed, skipped, interrupted
    s.lifecycle('req_t3','check_started','worker:subject_a','check_id=test;check_run_id=check_1',{claim_id:ct.claim_id});
    assert.equal(last(s,'req_t3').epoch,1,'a claim_id without epoch did not resolve its epoch');
    s.lifecycle('req_t3','check_passed','system','x',{claim_id:'claim_never_seen'});
    assert.deepEqual([last(s,'req_t3').claim_id,last(s,'req_t3').epoch],['claim_never_seen',null]);
    s.db.close();
  }

  // ---- the event and its state change commit together or not at all
  {
    const s=open('atomic');
    const original=s.lifecycle;
    const failing=fn=>{ s.lifecycle=function(...args){ original.apply(this,args); throw new Error('boom after the state change'); }; try { assert.throws(fn,/boom/); } finally { s.lifecycle=original; } };
    const snapshot=()=>JSON.stringify(['assignments','claims','progress','reports','notifications','lifecycle_events'].map(t=>s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    let before=snapshot();
    failing(()=>s.submit(payload('req_atomic'),{mode:'t3',threadId:'thread_lifecycle_2'},'env','owner'));
    assert.equal(snapshot(),before,'submit persisted without its event'); assert.equal(s.hasAssignment('req_atomic'),false);
    s.submit(payload('req_atomic'),{mode:'t3',threadId:'thread_lifecycle_2'},'env','owner');
    before=snapshot(); failing(()=>s.claim('req_atomic','dot','subject_a',6)); assert.equal(snapshot(),before,'claim persisted without its event');
    let c=s.claim('req_atomic','dot','subject_a',6);
    before=snapshot(); failing(()=>s.progress('req_atomic',c.claim_id,'BLOCKED: x','subject_a')); assert.equal(snapshot(),before,'progress persisted without its event');
    const preResume=s.db.prepare('SELECT * FROM claims WHERE request_id=?').get('req_atomic');
    now=Date.parse(preResume.last_claim_activity_at)+LEASE+1;
    before=snapshot(); failing(()=>s.resume('req_atomic','subject_a')); assert.equal(snapshot(),before,'resume persisted without its event');
    c=s.resume('req_atomic','subject_a');
    before=snapshot(); failing(()=>s.abandon('req_atomic',{reason:'x'})); assert.equal(snapshot(),before,'abandon persisted without its event');
    before=snapshot(); failing(()=>s.finish('req_atomic',c.claim_id,'completed','done','r','subject_a')); assert.equal(snapshot(),before,'finish persisted without its event');
    s.finish('req_atomic',c.claim_id,'completed','done','r','subject_a');
    const note=s.db.prepare("SELECT id FROM notifications WHERE request_id='req_atomic' AND kind='t3'").get().id, attempt=s.startAttempt(note,null);
    before=snapshot(); failing(()=>s.finishAttempt(note,attempt.attempt_id,'uncertain','x')); assert.equal(snapshot(),before,'finishAttempt persisted without its event');
    s.finishAttempt(note,attempt.attempt_id,'uncertain','x');
    before=snapshot(); failing(()=>s.reconciled(note,'delivered','marker',deliveryFence(s,note))); assert.equal(snapshot(),before,'reconcile persisted without its event');
    before=snapshot(); failing(()=>s.verdict('req_atomic',true)); assert.equal(snapshot(),before,'accept persisted half');
    before=snapshot(); failing(()=>s.recordConsumed('req_atomic','get')); assert.equal(snapshot(),before,'consumed persisted half');
    s.submit(payload('req_atomic_cancel'),{mode:'none'},null,'owner');
    before=snapshot(); failing(()=>s.cancel('req_atomic_cancel')); assert.equal(snapshot(),before,'cancel persisted without its event');
    s.db.close();
  }
  pass('a throw after the state change rolls back both the change and its event (submit, claim, progress, resume, abandon, finish, delivery, reconcile, verdict, consumed, cancel)');

  // ---- append-only, with deletion only through the retention cutoff
  {
    const s=open('append');
    s.submit(payload('req_append'),{mode:'none'},null,'owner');
    assert.throws(()=>s.db.exec("UPDATE lifecycle_events SET type='claimed'"),/lifecycle events are append-only/);
    assert.throws(()=>s.db.exec('DELETE FROM lifecycle_events'),/lifecycle events are append-only/);
    s.db.prepare('UPDATE lifecycle_retention SET cutoff=? WHERE id=1').run('2000-01-01T00:00:00.000Z');
    assert.throws(()=>s.db.exec('DELETE FROM lifecycle_events'),/lifecycle events are append-only/,'the cutoff admitted a newer row');
    s.db.prepare('UPDATE lifecycle_retention SET cutoff=NULL WHERE id=1').run();
    assert.throws(()=>s.db.exec("INSERT INTO lifecycle_events(request_id,type,at,actor,source) VALUES('x','finished','t','a','live')"),/CHECK constraint failed/);
    assert.throws(()=>s.db.exec("INSERT INTO lifecycle_events(request_id,type,at,actor,source) VALUES('x','queued','t','a','guess')"),/CHECK constraint failed/);
    assert.equal(total(s),1);
    s.db.close();
  }
  pass('lifecycle_events rejects UPDATE and DELETE outside retention, and unknown types or sources');

  // ---- backfill of a pre-v21 database: only what the rows prove, marked backfill, once
  {
    let s=open('backfill');
    s.submit(payload('req_b1'),{mode:'t3',threadId:'thread_lifecycle_3'},'env','owner');
    const c1=s.claim('req_b1','dot','subject_a',6);
    now+=MIN; s.progress('req_b1',c1.claim_id,'working on it','subject_a');
    now+=MIN; s.progress('req_b1',c1.claim_id,'QUESTION: which?','subject_a');
    now+=MIN;
    const blocker=s.db.prepare("SELECT id FROM notifications WHERE request_id='req_b1' AND kind='blocker'").get().id;
    const inFlight=s.startAttempt(blocker,null);
    s.finish('req_b1',c1.claim_id,'blocked','stuck','r','subject_a');
    const result=s.db.prepare("SELECT id FROM notifications WHERE request_id='req_b1' AND kind='t3'").get().id;
    s.finishAttempt(blocker,inFlight.attempt_id,'uncertain','x'); s.reconciled(blocker,'delivered','marker',deliveryFence(s,blocker));
    s.finishAttempt(result,s.startAttempt(result,null).attempt_id,'delivered');
    s.submit(payload('req_b2'),{mode:'none'},null,'owner');
    const c2=s.claim('req_b2','dot','subject_a',6);
    const job=(id,status,run)=>{ s.db.prepare('INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,finished_at,error) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'req_b2',c2.claim_id,'test','d',status,s.stamp(),status==='running'?null:s.stamp(),status==='failed'?'secret-free error':null);
      if(run) s.db.prepare("INSERT INTO check_runs(id,request_id,claim_id,check_id,exit_code,timed_out,output_artifact_id,output_sha256,duration_ms,created_at,phase) VALUES(?,?,?,?,?,?,'art','sha',1,?,?)").run(id,'req_b2',c2.claim_id,'test',run.exit,run.timedOut?1:0,s.stamp(),run.phase); };
    job('check_pass','completed',{exit:0,phase:'check'}); job('check_install','completed',{exit:1,phase:'install'}); job('check_timeout','completed',{exit:0,phase:'check',timedOut:true}); job('check_err','failed'); job('check_int','interrupted'); job('check_run','running');
    s.submit(payload('req_b3'),{mode:'none'},null,'owner'); s.cancel('req_b3');
    s.verdict('req_b1',true);
    preWorkerFixture(s);
    s.db.exec(`DROP TABLE lifecycle_events; DROP TABLE lifecycle_daily; DROP TABLE lifecycle_retention; PRAGMA user_version=20;`);
    s.db.close();
    now+=HOUR;
    s=open('backfill');
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,66);
    const rows=s.db.prepare('SELECT * FROM lifecycle_events ORDER BY id').all();
    assert.ok(rows.every(e=>e.source==='backfill'&&e.actor==='system'),'backfilled rows not marked');
    assert.deepEqual(types(s,'req_b1'),['queued','claimed','working','waiting','completed','blocked','delivery_uncertain','reconciled','delivery_sent']);
    assert.deepEqual(events(s,'req_b1').map(e=>e.reason),[null,null,null,null,'outcome=blocked',null,'blocker','blocker','t3']);
    assert.ok(events(s,'req_b1').slice(1).every(e=>e.claim_id===c1.claim_id&&e.epoch===1));
    assert.deepEqual(events(s,'req_b2').map(e=>e.type==='check_started'||e.type.startsWith('check_')?`${e.type}:${e.reason.replace(/check_id=test;check_run_id=/,'')}`:e.type),
      ['queued','claimed','check_started:check_pass','check_passed:check_pass','check_started:check_install','check_failed:check_install;phase=install;exit=1','check_started:check_timeout','check_failed:check_timeout;phase=check;exit=0;timed_out',
       'check_started:check_err','check_failed:check_err;error','check_started:check_int','check_failed:check_int;interrupted','check_started:check_run']);
    assert.deepEqual(types(s,'req_b3'),['queued','cancelled']);
    for(const type of ['consumed','accepted','integrated','abandoned','check_skipped']) assert.equal(rows.filter(e=>e.type===type).length,0,`backfill invented ${type}`);
    assert.ok(rows.every((e,i)=>i===0||rows[i-1].at<=e.at),'backfill not in time order');
    const count=rows.length;
    s.db.close(); s=open('backfill');
    assert.equal(total(s),count,'reopening backfilled again');
    assert.equal(backfillLifecycle(s.db),0,'backfill is not idempotent');
    s.submit(payload('req_b4'),{mode:'none'},null,'owner');
    assert.deepEqual(last(s,'req_b4').source,'live');
    s.db.close();
  }
  pass('pre-v21 backfill: queued/claimed/progress/completed/cancelled/delivery/check from rows, marked backfill, nothing invented, idempotent');

  // ---- metrics on a hand-built timeline
  {
    const T0=Date.parse('2026-10-08T00:00:00.000Z'); now=T0+10*HOUR;
    const s=open('metrics');
    const assignment=(id,status,extra={},review=0,priority='normal',created=T0)=>s.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,owner_hash,review,delivery,priority) VALUES(?,?,'h','','',?,?,'o',?,'none',?)").run(id,JSON.stringify(payload(id,extra)),status,new Date(created).toISOString(),review,priority);
    const at=(id,type,offset,reason=null,source='live',epoch=1)=>s.db.prepare("INSERT INTO lifecycle_events(request_id,claim_id,epoch,type,at,actor,source,reason) VALUES(?,?,?,?,?,'system',?,?)").run(id,`claim_${id}_${epoch}`,epoch,type,new Date(T0+offset).toISOString(),source,reason);
    assignment('req_m_a','finished',{execution_scope:'implementation'});
    assignment('req_m_b','claimed',{},0,'background');
    assignment('req_m_c','queued');
    assignment('req_m_d','finished',{task_kind:'audit-review'},1,'background');
    assignment('req_m_e','finished',{},1); assignment('req_m_f','finished');
    // A: queued, 10m wait, steady work, an hour blocked, an hour-long check, finished, consumed, accepted
    at('req_m_a','queued',0); at('req_m_a','claimed',10*MIN,'new'); at('req_m_a','working',15*MIN); at('req_m_a','working',25*MIN); at('req_m_a','blocked',30*MIN); at('req_m_a','working',90*MIN);
    at('req_m_a','check_started',95*MIN); at('req_m_a','check_passed',155*MIN); at('req_m_a','completed',160*MIN,'outcome=completed'); at('req_m_a','consumed',3*HOUR,'wait'); at('req_m_a','accepted',3*HOUR+5*MIN);
    // B: two hours in queue, a 110m silence (idle), then waiting on the owner until now
    at('req_m_b','queued',HOUR); at('req_m_b','claimed',3*HOUR,'new'); at('req_m_b','working',3*HOUR+10*MIN); at('req_m_b','working',5*HOUR); at('req_m_b','waiting',5*HOUR+5*MIN);
    at('req_m_c','queued',2*HOUR);
    // D: claim lost to lease expiry, taken over, a skipped check, failed report
    at('req_m_d','queued',30*MIN); at('req_m_d','claimed',40*MIN,'new'); at('req_m_d','abandoned',50*MIN,'lease_expired'); at('req_m_d','claimed',50*MIN,'takeover','live',2);
    at('req_m_d','check_skipped',55*MIN,null,'live',2); at('req_m_d','completed',HOUR,'outcome=failed','live',2);
    at('req_m_e','completed',6*HOUR,'outcome=completed'); at('req_m_e','consumed',7*HOUR,'rejected: wrong');
    at('req_m_f','completed',6*HOUR,'outcome=completed'); at('req_m_f','consumed',7*HOUR,'get');
    for(const [id,key,rev,offset] of [['req_m_g','k1','r1',HOUR],['req_m_h','k1','r2',2*HOUR],['req_m_i','k1','r1',3*HOUR]]) assignment(id,'queued',{objective_key:key,revision:rev},0,'normal',T0+offset);
    const m=lifecycleMetrics(s,{since:new Date(T0).toISOString()});
    const ms=x=>({value:x,unit:'ms'}), n=x=>({value:x,unit:'count'});
    assert.deepEqual(m.window,{since:'2026-10-08T00:00:00.000Z',until:'2026-10-08T10:00:00.000Z',wall_ms:10*HOUR,rolled_up:false});
    assert.deepEqual(m.queue_latency,{n:n(3),p50:ms(10*MIN),p90:ms(2*HOUR),still_queued:n(1),earlier_epoch_unknown:n(0)});
    assert.deepEqual(m.claim_to_first_activity,{n:n(2),p50:ms(5*MIN),p90:ms(10*MIN),closed_without_activity:n(2),awaiting_activity:n(0)});
    assert.deepEqual(m.time,{claimed:ms(590*MIN),working:ms(125*MIN),blocked:ms(60*MIN),waiting:ms(295*MIN),idle:ms(110*MIN),open_claims:n(1)});
    assert.deepEqual(m.utilization,{working_over_claimed:{value:0.212,unit:'ratio'}}); assert.equal(m.lane_utilization.lanes.value,2); assert.ok(!JSON.stringify(m).includes('working_over_wall'));
    assert.deepEqual(m.throughput,{completed:n(4),per_day:{value:4,unit:'count/day'},by_kind:{'audit-review/background':n(1),'implementation/normal':n(1),'read-only/normal':n(1),'review/normal':n(1)},
      by_day:[{day:'2026-10-08',kind:'audit-review/background',completed:1},{day:'2026-10-08',kind:'implementation/normal',completed:1},{day:'2026-10-08',kind:'read-only/normal',completed:1},{day:'2026-10-08',kind:'review/normal',completed:1}]});
    assert.deepEqual(m.rework,{value:2,unit:'count',n:3,by_source:{unknown:2}}); assert.deepEqual(m.duplicates,{value:1,unit:'count',n:3,by_source:{unknown:1}});
    assert.deepEqual(m.objective_coverage,{value:0.333,unit:'ratio',keyed:3,total:9,by_source:{unknown:{keyed:3,total:9}}});
    assert.deepEqual(m.orphaned_claims,{current:n(0),lease_expired_takeovers:n(1),abandoned:n(1)});
    assert.deepEqual(m.checks,{passed:n(1),failed:n(0),skipped:n(1),pass_rate:{value:0.5,unit:'ratio'},started:n(1)});
    assert.deepEqual(m.acceptance,{finished:n(4),accepted:n(1),rejected:n(1),consumed_only:n(1),unknown:n(1),accept_rate:{value:0.5,unit:'ratio'},integrated:n(0)});
    assert.match(explainMetrics(m),/queue_latency=p50:10m,p90:120m,n=3 claim_to_activity=p50:5m working\/claimed=21\.2% util24h=10\.4%\(of 2 lanes,covered 41\.7%\) idle_while_queued24h=93\.3% iwq_waiting24h=91\.8%\(break:0%,worker_inactive:91\.8%,worker_active:0%\) idle_no_queue24h=[\d.]+% util7d=10\.4%\(of 2 lanes,covered 6%\) idle_while_queued7d=93\.3% iwq_waiting7d=91\.8%\(break:0%,worker_inactive:91\.8%,worker_active:0%\) idle_no_queue7d=[\d.]+% completed=4\(4\/day\)/);
    // An empty window reports unknown with a reason, never zero.
    now=T0+20*DAY;
    const empty=lifecycleMetrics(s,{since:new Date(T0+19*DAY).toISOString()});
    assert.equal(empty.queue_latency.p50.value,null); assert.match(empty.queue_latency.p50.unknown_reason,/no queued event/);
    assert.equal(empty.utilization.working_over_claimed.value,null); assert.match(empty.utilization.working_over_claimed.unknown_reason,/no claimed time/);
    assert.equal(empty.checks.pass_rate.value,null); assert.equal(empty.acceptance.accept_rate.value,null);
    assert.equal(empty.rework.value,null); assert.match(empty.rework.unknown_reason,/no assignment was submitted in the window/); assert.equal(empty.objective_coverage.value,null);
    assert.throws(()=>lifecycleMetrics(s,{since:'yesterday'}),/RFC 3339/);
    assert.throws(()=>lifecycleMetrics(s,{since:new Date(now+DAY).toISOString()}),/in the past/);
    s.db.close();
  }
  pass('metrics: queue latency, claim-to-activity, working/blocked/waiting/idle vs claimed, utilization, throughput by kind, rework, duplicates, orphans, checks, acceptance, unknowns');

  // ---- lane utilization: fixed 24h / 7d windows, explicit denominator, sweep over interval endpoints
  {
    const N=Date.parse('2026-10-20T00:00:00.000Z'); now=N;
    const s=open('lanes');
    const row=(id,status)=>s.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,owner_hash,review,delivery,priority) VALUES(?,?,'h','','',?,?,'o',0,'none','normal')").run(id,JSON.stringify(payload(id)),status,new Date(N-30*HOUR).toISOString());
    const at=(id,type,offset,epoch=1)=>s.db.prepare("INSERT INTO lifecycle_events(request_id,claim_id,epoch,type,at,actor,source,reason) VALUES(?,?,?,?,?,'system','live',NULL)").run(id,`claim_${id}_${epoch}`,epoch,type,new Date(N+offset).toISOString());
    for(const [id,status] of [['A','finished'],['B','finished'],['C','finished'],['D','finished'],['E','finished'],['F','queued'],['G','claimed']]) row(`req_l_${id}`,status);
    const ev=(id,...list)=>list.forEach(([type,offset,epoch])=>at(`req_l_${id}`,type,offset,epoch));
    // Lanes = 2, hours relative to now. The first event is at -30h, so the 7d window is covered for 30h only.
    ev('A',['queued',-30*HOUR],['claimed',-29*HOUR],['working',-29*HOUR+10*MIN],['completed',-29*HOUR+20*MIN]);
    ev('B',['queued',-25*HOUR],['claimed',-24*HOUR-10*MIN],['working',-24*HOUR],['working',-24*HOUR+10*MIN],['completed',-24*HOUR+20*MIN]);
    ev('C',['queued',-23*HOUR],['claimed',-22*HOUR],['working',-22*HOUR+10*MIN],['working',-22*HOUR+20*MIN],['completed',-22*HOUR+30*MIN]);
    ev('D',['queued',-23*HOUR],['claimed',-22*HOUR+15*MIN],['working',-22*HOUR+25*MIN],['completed',-22*HOUR+30*MIN]);
    // E: claimed, abandoned (requeued), claimed again in epoch 2
    ev('E',['queued',-22*HOUR+20*MIN],['claimed',-22*HOUR+40*MIN],['abandoned',-22*HOUR+50*MIN],['queued',-22*HOUR+50*MIN],['claimed',-21*HOUR+10*MIN,2],['completed',-21*HOUR+20*MIN]);
    ev('F',['queued',-HOUR]);
    ev('G',['queued',-31*MIN],['claimed',-30*MIN],['working',-25*MIN]);
    const lu=lifecycleMetrics(s,{since:new Date(N-HOUR).toISOString()}).lane_utilization;
    const share=ms=>({unit:'ratio',ms}), pct=(ms,of)=>({value:Math.round(ms/of*1000)/1000,unit:'ratio',ms,of_ms:of});
    assert.equal(lu.lanes.value,2);
    const d=lu.last_24h;
    assert.deepEqual(d.window,{since:new Date(N-DAY).toISOString(),wall_ms:DAY,covered_ms:DAY,covered_fraction:1});
    assert.deepEqual(d.utilization,{value:0.031,unit:'ratio',numerator_ms:90*MIN,denominator_ms:2*DAY,lanes:2});
    assert.deepEqual([d.idle_while_queued,d.queue_empty,d.all_lanes_busy],[pct(165*MIN,DAY),pct(1265*MIN,DAY),pct(10*MIN,DAY)]);
    const w=lu.last_7d;
    assert.deepEqual(w.window,{since:new Date(N-7*DAY).toISOString(),wall_ms:7*DAY,covered_ms:30*HOUR,covered_fraction:0.179});
    assert.deepEqual(w.utilization,{value:0.033,unit:'ratio',numerator_ms:120*MIN,denominator_ms:2*30*HOUR,lanes:2});
    assert.deepEqual([w.idle_while_queued,w.queue_empty,w.all_lanes_busy],[pct(275*MIN,30*HOUR),pct(1515*MIN,30*HOUR),pct(10*MIN,30*HOUR)]);
    assert.equal(275*MIN+1515*MIN+10*MIN,30*HOUR,'shares must add up');
    assert.match(explainMetrics(lifecycleMetrics(s,{since:new Date(N-HOUR).toISOString()})),/util24h=3\.1%\(of 2 lanes\) idle_while_queued24h=11\.5% iwq_waiting24h=10\.8%\(break:0%,worker_inactive:10\.8%,worker_active:0%\) idle_no_queue24h=[\d.]+% util7d=3\.3%\(of 2 lanes,covered 17\.9%\) idle_while_queued7d=15\.3% iwq_waiting7d=14\.4%\(break:0%,worker_inactive:14\.4%,worker_active:0%\) idle_no_queue7d=[\d.]+% /);
    // The lane count is the denominator: the same timeline with 1 lane is saturated more often and halves the denominator.
    const one=lifecycleMetrics(s,{laneCapacity:1}).lane_utilization.last_24h;
    assert.equal(one.utilization.denominator_ms,DAY); assert.equal(one.utilization.lanes,1);
    // Scales near-linearly with history. Wall time on a loaded host says nothing, so compare two sizes measured in the
    // same run (best of 3 each): 4x the jobs may cost at most 6x (linear is 4x and measures near 3x, quadratic 16x), plus 25 ms of jitter.
    const bulk=(from,to)=>{ s.db.exec('BEGIN'); for(let i=from;i<to;i++) { const id=`req_l_bulk${i}`; row(id,'finished'); ev(`bulk${i}`,['queued',-(i%160)*HOUR/2],['claimed',-(i%160)*HOUR/2+MIN],['working',-(i%160)*HOUR/2+2*MIN],['completed',-(i%160)*HOUR/2+3*MIN]); } s.db.exec('COMMIT'); };
    const best=()=>Math.min(...[0,1,2].map(()=>{ const t0=performance.now(); lifecycleMetrics(s); return performance.now()-t0; }));
    bulk(0,1000); const small=best(); bulk(1000,4000); const large=best();
    assert.ok(large<6*small+25,`metrics grow faster than linearly: ${large.toFixed(1)} ms for 4000 jobs vs ${small.toFixed(1)} ms for 1000`);
    s.db.close();
    // No events at all: unknown with a reason, never zero or idle.
    const empty=open('lanes-empty'), e=lifecycleMetrics(empty).lane_utilization.last_7d; empty.db.close();
    assert.equal(e.utilization.value,null); assert.match(e.utilization.unknown_reason,/no covered time/); assert.equal(e.idle_while_queued.value,null);
    assert.equal(e.window.covered_ms,0);
  }
  pass('lane utilization: overlapping claims, requeue, window clipping, uncovered history is unknown, shares add up, denominator is worker_lane_capacity');

  // ---- idle-while-queued split, pickup wait and throughput by concurrency on a hand-built timeline (2 lanes, 3 h of history, minutes after -3h)
  {
    const N=Date.parse('2026-10-20T00:00:00.000Z'); now=N;
    const s=open('lanes-split'), T0=-3*HOUR;
    const row=id=>s.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,owner_hash,review,delivery,priority) VALUES(?,?,'h','','','finished',?,'o',0,'none','normal')").run(id,JSON.stringify(payload(id)),new Date(N+T0).toISOString());
    const ev=(id,...list)=>{ row(`req_s_${id}`); for(const [type,min] of list) s.db.prepare("INSERT INTO lifecycle_events(request_id,claim_id,epoch,type,at,actor,source,reason) VALUES(?,?,1,?,?,'system','live',NULL)").run(`req_s_${id}`,`claim_s_${id}`,type,new Date(N+T0+min*MIN).toISOString()); };
    ev('P',['queued',0],['claimed',2],['working',3],['completed',30]);
    ev('Q',['queued',10],['claimed',20],['completed',50]);   // waited 10 min: stale from minute 13
    ev('R',['queued',25],['claimed',26],['completed',40]);
    ev('S',['queued',59],['claimed',60],['completed',65]);   // alone: a second completion at 1 claim held
    // claims held: 0 for 0-2, 1 for 2-20, 2 for 20-26, 3 for 26-30, 2 for 30-40, 1 for 40-50, 0 for 50-60, 1 for 60-65, 0 after
    const lu=lifecycleMetrics(s).lane_utilization;
    for(const key of ['last_24h','last_7d']) {
      const x=lu[key];
      assert.equal(x.window.covered_ms,3*HOUR);
      assert.deepEqual([x.idle_while_fresh_queued.ms,x.idle_while_waiting_queued.ms,x.all_lanes_busy.ms,x.queue_empty.ms],[6*MIN,7*MIN,MIN,166*MIN]);
      assert.equal(x.idle_while_queued.ms,13*MIN,'idle_while_queued stays the sum of the split');
      assert.equal(x.pickup_budget_ms,180000);
      assert.deepEqual([x.pickup_wait.n.value,x.pickup_wait.p50.value,x.pickup_wait.p90.value],[4,MIN,10*MIN]);
      assert.equal(x.max_concurrent_claims.value,3);
      // 0 held (127 min) and 3 held (4 min) are omitted: under 10 min or no claim
      assert.deepEqual(x.throughput_by_concurrency.map(l=>[l.claims_held,l.time_ms,l.completions]),[[1,33*MIN,2],[2,16*MIN,1]]);
      assert.deepEqual(x.throughput_by_concurrency.map(l=>[l.completions_per_hour,l.per_claim_per_hour]),[[3.64,3.64],[3.75,1.88]]);
    }
    const text=explainMetrics(lifecycleMetrics(s));
    assert.match(text,/idle_while_queued24h=7\.2% iwq_waiting24h=3\.9%\(break:0%,worker_inactive:3\.9%,worker_active:0%\) idle_no_queue24h=[\d.]+% util7d=/);
    // A claim that ends the window outside it does not count: pickups before the window leave pickup_wait.
    now=N+30*HOUR; const later=lifecycleMetrics(s).lane_utilization.last_24h; now=N;
    assert.equal(later.pickup_wait.n.value,0); assert.equal(later.pickup_wait.p50.value,null); assert.match(later.pickup_wait.p50.unknown_reason,/no assignment was claimed/);
    assert.deepEqual(later.throughput_by_concurrency,[]);
    s.db.close();
  }
  pass('lane metrics split: fresh vs waiting idle-while-queued, pickup wait p50/p90, max concurrent claims, throughput by concurrency (levels under 10 min omitted)');

  // ---- retention: events older than 90 days roll up to daily counts and leave; old windows report durations unknown
  {
    now=Date.parse('2026-01-01T12:00:00.000Z');
    const s=open('retention');
    s.submit(payload('req_r_old'),{mode:'none'},null,'owner');
    const c=s.claim('req_r_old','dot','subject_a',6);
    now+=10*MIN; s.progress('req_r_old',c.claim_id,'working','subject_a');
    now+=10*MIN; s.finish('req_r_old',c.claim_id,'completed','done','r','subject_a');
    now+=100*DAY;
    s.submit(payload('req_r_new'),{mode:'none'},null,'owner');
    assert.throws(()=>s.db.exec("DELETE FROM lifecycle_events WHERE request_id='req_r_old'"),/append-only/,'an old row was deletable outside retention');
    const r=retainLifecycle(s);
    assert.equal(r.rolled_up,4);
    assert.deepEqual(s.db.prepare('SELECT day,type,kind,count FROM lifecycle_daily ORDER BY type').all().map(x=>({...x})),
      ['claimed','completed','queued','working'].map(type=>({day:'2026-01-01',type,kind:'read-only/normal',count:1})));
    assert.deepEqual(types(s,'req_r_old'),[]); assert.deepEqual(types(s,'req_r_new'),['queued']);
    assert.equal(s.db.prepare('SELECT cutoff FROM lifecycle_retention').get().cutoff,null,'retention left the delete gate open');
    assert.throws(()=>s.db.exec('DELETE FROM lifecycle_events'),/append-only/);
    assert.equal(retainLifecycle(s).rolled_up,0);
    assert.equal(s.db.prepare('SELECT sum(count) n FROM lifecycle_daily').get().n,4,'a second run double-counted');
    const old=lifecycleMetrics(s,{since:'2025-12-31T00:00:00Z'});
    assert.equal(old.window.rolled_up,true);
    assert.deepEqual(old.time.working,{value:null,unknown_reason:'rolled up'}); assert.deepEqual(old.queue_latency.p50,{value:null,unknown_reason:'rolled up'});
    assert.deepEqual(old.utilization.working_over_claimed,{value:null,unknown_reason:'rolled up'});
    assert.deepEqual(old.throughput.completed,{value:1,unit:'count'},'roll-ups missing from throughput');
    const recent=lifecycleMetrics(s,{since:new Date(now-DAY).toISOString()});
    assert.equal(recent.window.rolled_up,false); assert.equal(recent.throughput.completed.value,0);
    s.db.close();
  }
  pass('retention rolls events older than 90 days into lifecycle_daily, deletes only through the cutoff gate, and old windows report durations as rolled up');
  console.log('PASS lifecycle events test');
} catch(error) { console.error('FAIL',error); process.exitCode=1; }
finally { rmSync(dir,{recursive:true,force:true}); }
