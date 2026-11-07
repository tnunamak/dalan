import assert from 'node:assert/strict';
import {Store,UNCERTAIN_DELIVERY_MAX_AGE_MS} from '../src/store.mjs';
for(const route of ['idle','resume','reclaim']) {
  let now=Date.parse('2026-10-29T00:00:00Z');
  const s=new Store(':memory:',{now:()=>now,resumeIdleMs:1,limits:{leaseMs:1000}}),id='req_unknown_'+route;
  const rotate=()=>{if(route==='resume')return s.resume(id,'owner');if(route==='reclaim')s.abandon(id);return s.claim(id,'second','owner',6,null,'dot','second');};
  try {
    s.submit({schema_version:1,request_id:id,brief:'unknown effect fence',inputs:[],expected_output:'one result',execution_scope:'read-only'},{mode:'t3',threadId:'fixture-thread'},'fixture-environment','owner');
    const old=s.claim(id,'first','owner',6,null,'dot','first');
    s.progress(id,old.claim_id,'QUESTION: durable effect','owner');
    const n=s.db.prepare("SELECT * FROM notifications WHERE request_id=? AND kind='blocker' ORDER BY rowid DESC LIMIT 1").get(id);
    const attempt=s.startAttempt(n.id,[]);assert(attempt);
    s.finishAttempt(n.id,attempt.attempt_id,'uncertain','fixture lost response');
    now+=UNCERTAIN_DELIVERY_MAX_AGE_MS+1000;
    assert.equal(s.releaseAgedUncertain().length,1);
    assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(n.id).state,'uncertain_terminal');
    assert.throws(rotate,/uncertain_delivery/,'age cannot establish that an old effect stopped');
    assert.equal(s.db.prepare('SELECT epoch FROM claims WHERE request_id=?').get(id).epoch,1);
    const current=s.db.prepare('SELECT * FROM notifications WHERE id=?').get(n.id),a=s.get(id);
    const fence={attemptId:current.attempt_id,attemptStartedAt:current.attempt_started_at,body:current.body,argv:current.argv,threadId:a.thread_id,environmentId:a.environment_id,targetWorker:a.target_worker,assignmentStatus:a.status,deliveryMode:a.delivery_mode,reportSnapshot:JSON.stringify(null)};
    assert.equal(s.reconciled(n.id,'delivered','wrong acknowledgment',{...fence,attemptId:'foreign'}),false);
    assert.throws(rotate,/uncertain_delivery/);
    assert.equal(s.reconciled(n.id,'uncertain','still unknown',fence),true);
    assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(n.id).state,'uncertain_terminal','negative observation cannot restart the age cycle');
    assert.equal(s.reconciled(n.id,'delivered','matching positive acknowledgment',fence),true);
    assert.equal(rotate().epoch,2);
    assert.equal(s.due().some(x=>x.id===n.id),false,'the old effect is never resent');
    console.log('PASS aged unknown holds '+route+' until a matching positive receipt');
  } finally {s.db.close();}
}
