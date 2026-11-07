import assert from 'node:assert/strict';
import { Store, UNCERTAIN_DELIVERY_MAX_AGE_MS } from '../src/store.mjs';

const payload=id=>({schema_version:1,request_id:id,brief:'delivery fence fixture',inputs:[],expected_output:'result',execution_scope:'read-only'});
function fixture() {
  let now=Date.parse('2026-10-27T12:00:00Z');
  const store=new Store(':memory:',{now:()=>now,capacity:2});
  return {store,advance:ms=>{now+=ms;},submit:id=>store.submit(payload(id),{mode:'none'},null,'fixture-owner')};
}
function unknown(store,id) {
  const at=new Date(store.nowMs()-UNCERTAIN_DELIVERY_MAX_AGE_MS).toISOString(),notice=`notice_${id}`;
  store.db.prepare("INSERT INTO notifications(id,kind,request_id,state,created_at,attempt_started_at,attempt_id) VALUES(?,'blocker',?,'uncertain',?,?,'fixture-attempt')").run(notice,id,at,at);
  return notice;
}
function release(store,id) {
  const notice=unknown(store,id);
  assert.equal(store.uncertainDeliveries(id),1);
  assert.equal(store.releaseAgedUncertain([notice]).length,1);
  assert.equal(store.uncertainDeliveries(id),1,'terminal unknown still holds new claim epochs');
  assert.equal(store.get(id).delivery.find(n=>n.id===notice).state,'uncertain_terminal');
}
function capture(store,notice) {
  const n=store.db.prepare('SELECT * FROM notifications WHERE id=?').get(notice),a=store.get(n.request_id);
  return {attemptId:n.attempt_id,attemptStartedAt:n.attempt_started_at,body:n.body,argv:n.argv,threadId:a.thread_id,environmentId:a.environment_id,targetWorker:a.target_worker,assignmentStatus:a.status,deliveryMode:a.delivery_mode,reportSnapshot:JSON.stringify(a.report?{outcome:a.report.outcome,summary:a.report.summary,result:a.report.result}:null)};
}

{
  const {store:s,submit}=fixture();
  try {
    submit('null_fences');const notice=unknown(s,'null_fences');
    const before=capture(s,notice);
    assert.equal(s.reconciled(notice,'uncertain','matching quiet binding',before),true,'unchanged quiet delivery binding must reconcile');
    for(const [table,column,absent,value] of [
      ['notifications','attempt_id',null,'new-attempt'],
      ['assignments','thread_id','','new-thread'],
      ['assignments','environment_id','','new-environment']
    ]) {
      const key=table==='assignments'?'request_id':'id',id=table==='assignments'?'null_fences':notice;
      const original=s.db.prepare(`SELECT ${column} value FROM ${table} WHERE ${key}=?`).get(id).value;
      for(const [initial,next] of [[absent,value],[value,absent]]) {
        s.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(initial,id);
        const fence=capture(s,notice);
        s.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(next,id);
        const state=s.db.prepare('SELECT state,last_reconciled_at,next_at FROM notifications WHERE id=?').get(notice);
        assert.equal(s.reconciled(notice,'delivered','stale observation',fence),false,`${column} NULL/value transition must fence the old result`);
        assert.deepEqual(s.db.prepare('SELECT state,last_reconciled_at,next_at FROM notifications WHERE id=?').get(notice),state,'stale result changed state or observation clocks');
      }
      s.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(original,id);
    }
    assert.equal(s.reconciled(notice,'delivered','invalid captured worker',{...before,targetWorker:null}),false,'NULL captured worker cannot bypass the required worker binding');
    console.log('PASS matching quiet NULL binding and actual NULL/value transition fences leave state and clocks unchanged');
  } finally {s.db.close();}
}
{
  const {store:s,submit}=fixture();
  try {
    submit('cancel_uncertain');
    unknown(s,'cancel_uncertain');
    assert.throws(()=>s.cancel('cancel_uncertain','owner cancelled'),/uncertain_delivery/,
      'cancellation must not race a result whose delivery may already have reached its receiver');
    assert.equal(s.get('cancel_uncertain').status,'queued');
  } finally {s.db.close();}
}
{
  const {store:s,submit,advance}=fixture();
  try {
    submit('live_fences');const claim=s.claim('live_fences','holder','owner',2,null,'dot','original-run');
    release(s,'live_fences');
    assert.throws(()=>s.claim('live_fences','rival','owner',2,null,'dot','other-run'),/claim_busy/,'release bypassed the active acquisition fence');
    assert.throws(()=>s.claim('live_fences','rival','owner',2,null,'other-worker','other-run'),/assignment not found|invalid claim/,'release bypassed the worker fence');
    assert.throws(()=>s.finish('live_fences',claim.claim_id,'completed','x','x','foreign',null,'dot'),/invalid claim/,'release bypassed the subject fence');
    assert.throws(()=>s.progress('live_fences','claim_old','x','owner',false,'dot'),/claim_superseded|invalid claim/,'release bypassed the claim ID fence');
    s.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES('check_fixture','live_fences',?,'default','','running',?)").run(claim.claim_id,s.stamp());
    advance(120000);
    assert.throws(()=>s.claim('live_fences','rival','owner',2,null,'dot','other-run'),/claim_busy/,'release bypassed the running-check idle exclusion');
    assert.equal(s.claim('live_fences','holder','owner',2,null,'dot','original-run').claim_id,claim.claim_id);
    assert.equal(s.get('live_fences').claim.epoch,1);
    assert.equal(s.get('live_fences').status,'claimed');
    console.log('PASS terminal delivery release retains active acquisition, worker, subject, claim ID and running-check fences');
  } finally {s.db.close();}
}
{
  const {store:s,submit}=fixture();
  try {
    for(const id of ['capacity_a','capacity_b','capacity_c'])submit(id);
    const first=s.claim('capacity_a','holder','owner',2,null,'dot','run-a');s.claim('capacity_b','holder','owner',2,null,'dot','run-b');
    release(s,'capacity_a');
    assert.equal(s.activeClaims('owner','dot').length,2);
    assert.throws(()=>s.claim('capacity_c','holder','owner',2,null,'dot','run-c'),/capacity_full/,'delivery release freed a capacity slot');
    assert.equal(s.progress('capacity_a',first.claim_id,'still valid','owner',false,'dot').recorded,true);
    console.log('PASS terminal delivery release neither frees capacity nor cancels healthy work');
  } finally {s.db.close();}
}
{
  const {store:s,submit,advance}=fixture();
  try {
    submit('lease_fences');const old=s.claim('lease_fences','holder','owner',2,null,'dot','run-old');
    release(s,'lease_fences');advance(s.limits.leaseMs);
    assert.throws(()=>s.progress('lease_fences',old.claim_id,'late','owner',false,'dot'),/lease_expired/,'delivery release extended the old lease');
    assert.throws(()=>s.claim('lease_fences','new-holder','new-owner',2,null,'dot','run-new'),/uncertain_delivery/);
    const notice=s.uncertainOne('lease_fences');
    assert.equal(s.reconciled(notice.id,'delivered','matching positive fixture receipt',capture(s,notice.id)),true);
    const next=s.claim('lease_fences','new-holder','new-owner',2,null,'dot','run-new');
    assert.equal(next.epoch,2);assert.notEqual(next.claim_id,old.claim_id);
    assert.throws(()=>s.finish('lease_fences',old.claim_id,'completed','stale','stale','owner',null,'dot'),/claim_superseded|invalid claim/,'delivery release revived an old epoch');
    const receipt=s.finish('lease_fences',next.claim_id,'completed','done','done','new-owner',null,'dot');
    assert.equal(s.finish('lease_fences',next.claim_id,'completed','done','done','new-owner',null,'dot').receipt_id,receipt.receipt_id);
    assert.equal(s.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id='lease_fences' AND type='completed'").get().n,1);
    console.log('PASS terminal delivery release retains lease expiry, takeover epoch fencing and completion idempotency');
  } finally {s.db.close();}
}
