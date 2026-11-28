import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HANDOFF_ACQUISITION_PREFIX,Store,loadRedeliveryLimits} from '../src/store.mjs';
const root=process.env.DOT_BRIDGE_TEST_TMP??path.join(os.homedir(),'.tmp');
fs.mkdirSync(root,{recursive:true});
const dir=fs.mkdtempSync(path.join(root,'claim-guidance-'));
let now=100000;
const store=new Store(path.join(dir,'state.db'),{now:()=>now,limits:{leaseMs:100}});
const make=id=>{
  store.submit({schema_version:1,request_id:id,brief:'guidance',inputs:[],expected_output:'one',execution_scope:'read-only'},{mode:'none'},null,'owner');
  return store.claim(id,'worker','subject',10);
};
function refusal(fn) {
  let error;try{fn();}catch(caught){error=caught;}
  assert(error,'expected refusal');
  try{return JSON.parse(error.message);}catch{return {error:error.code,message:error.message};}
}
try {
  const a=make('expired-question');
  store.askQuestion('expired-question',a.claim_id,'Q','Which?','subject');
  now+=100;
  const before=JSON.stringify(store.questions('expired-question'));
  const answer=refusal(()=>store.answerQuestion('expired-question','Q','too late'));
  assert.equal(answer.error,'lease_expired');
  assert.match(answer.message,/Ask the worker to reclaim.*new question with a new ID/);
  assert.equal(JSON.stringify(store.questions('expired-question')),before);
  store.sweepStaleLeases();
  const swept=refusal(()=>store.answerQuestion('expired-question','Q','still late'));
  assert.equal(swept.error,'STALE_EPOCH');assert.match(swept.message,/new question with a new ID/);
  store.claim('expired-question','worker','subject',10);
  assert.match(refusal(()=>store.answerQuestion('expired-question','Q','old epoch')).message,/new question with a new ID/);
  assert.equal(JSON.stringify(store.questions('expired-question')),before);
  const cancelled=make('cancelled-and-expired');store.cancel('cancelled-and-expired');now+=100;
  const result=refusal(()=>store.finish('cancelled-and-expired',cancelled.claim_id,'completed','late','late','subject'));
  assert.equal(result.error,'assignment_cancelled');
  assert.equal(store.db.prepare("SELECT count(*) n FROM late_evidence WHERE request_id='cancelled-and-expired'").get().n,0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM reports WHERE request_id='cancelled-and-expired'").get().n,0);
  const live=make('cancelled-live-lease');store.cancel('cancelled-live-lease');
  assert.equal(refusal(()=>store.finish('cancelled-live-lease',live.claim_id,'completed','audit','audit','subject')).error,'assignment_cancelled');
  assert.equal(store.db.prepare("SELECT count(*) n FROM late_evidence WHERE request_id='cancelled-live-lease'").get().n,1,'inside-lease cancellation audit is preserved');
  assert.equal(Object.hasOwn(a,'progress_due_at'),false,'unconfigured claim keeps its original shape');
  assert.doesNotMatch(a.guidance,/short note at least every/);
  const limitsFile=path.join(dir,'limits.json');
  for(const invalid of [null,[],false,5,{dot:'120000'},{dot:0},{dot:604800001},{'invalid worker':120000}]){
    fs.writeFileSync(limitsFile,JSON.stringify({worker_heartbeat_ms:invalid}),{mode:0o600});
    assert.throws(()=>loadRedeliveryLimits(limitsFile),/invalid worker_heartbeat_ms/,JSON.stringify(invalid));
  }
  const valid={dot:60000,configured_worker:604800000};
  fs.writeFileSync(limitsFile,JSON.stringify({worker_heartbeat_ms:valid}),{mode:0o600});
  assert.deepEqual(loadRedeliveryLimits(limitsFile).workerHeartbeatMs,valid);
  const configured=new Store(path.join(dir,'heartbeat.db'),{now:()=>now,limits:{leaseMs:480000,workerHeartbeatMs:{dot:120000}}});
  try {
    configured.submit({schema_version:1,request_id:'heartbeat',brief:'guidance',inputs:[],expected_output:'one',execution_scope:'read-only'},{mode:'none'},null,'owner');
    const first=configured.claim('heartbeat','worker','subject',10);
    assert.equal(first.progress_due_at,new Date(now+120000).toISOString());
    assert.match(first.guidance,/short note at least every 120 seconds/);
    assert.equal(configured.status().by_worker.dot.heartbeat_ms,120000);
    assert.deepEqual(configured.workerHeartbeatFields('other'),{});
    assert.doesNotMatch(configured.guidanceFor('other'),/short note at least every/);
    const initialLease=configured.get('heartbeat').claim.lease_expires_at;
    now+=5000;
    assert.equal(configured.workerGetHeartbeat(configured.get('heartbeat'),'dot','subject',first.claim_id).progress_due_at,first.progress_due_at);
    assert.deepEqual(configured.workerGetHeartbeat(configured.get('heartbeat'),'dot','other-subject'),{});
    assert.equal(configured.get('heartbeat').claim.lease_expires_at,initialLease,'advisory get does not renew a claim');
    const progressed=configured.progress('heartbeat',first.claim_id,'still working','subject');
    assert.equal(progressed.progress_due_at,new Date(now+120000).toISOString());
    configured.finish('heartbeat',first.claim_id,'completed','fixture done','fixture done','subject');
    const next='heartbeat-handoff';
    configured.submit({schema_version:1,request_id:next,brief:'handoff guidance',inputs:[],expected_output:'one',execution_scope:'read-only'},{mode:'none'},null,'owner');
    const acquisition=HANDOFF_ACQUISITION_PREFIX+first.claim_id;
    const handed=configured.claim(next,'worker','subject',10,null,'dot',acquisition,90000);
    assert.equal(handed.progress_due_at,new Date(now+90000).toISOString());
    const saved=configured.get(next),deadline=saved.claim.lease_expires_at;
    assert.deepEqual(configured.workerGetHeartbeat(saved,'dot','other-subject'),{});
    assert.equal(configured.workerGetHeartbeat(saved,'dot','subject').progress_due_at,handed.progress_due_at);
    assert.equal(configured.get(next).claim.lease_expires_at,deadline);
    const retry=configured.claim(next,'worker','subject',10,null,'dot',acquisition,90000);
    assert.equal(retry.claim_id,handed.claim_id);
    assert.equal(retry.progress_due_at,new Date(now+120000).toISOString(),'working handoff retry refreshes activity and lease');
    now=Date.parse(configured.get(next).claim.lease_expires_at)+1;
    configured.sweepStaleLeases();
    const fresh=configured.claim(next,'worker','subject',10,null,'dot','fresh-heartbeat',90000);
    const current=configured.get(next);
    assert.notEqual(fresh.claim_id,handed.claim_id);
    assert.deepEqual(configured.workerGetHeartbeat(current,'dot','subject',handed.claim_id),{});
    assert.equal(configured.workerGetHeartbeat(current,'dot','subject',fresh.claim_id).progress_due_at,fresh.progress_due_at);
    assert.equal(configured.db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get(next).n,1);
  } finally {configured.db.close();}
  console.log('PASS actionable expired question, cancelled-after-expiry reason and unchanged late-output fences');
} finally {store.db.close();fs.rmSync(dir,{recursive:true,force:true});}
