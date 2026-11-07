import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {answerProtocolQuestion,cancelProtocolJob} from '../src/protocol-owner-mutations.mjs';

const directory=mkdtempSync(join(tmpdir(),'protocol-owner-'));
const file=join(directory,'isolated.sqlite');
let now=1800000000000,store;
const token='offline-owner-capability',subject='offline-subject';
const open=()=>new Store(file,{now:()=>now});
const context=(id,key)=>({key,revision:store.protocolRevision(id)});
function submit(id) {
  const payload={schema_version:1,request_id:id,brief:'Offline native regression',
    inputs:[],scope_paths:[],execution_scope:'analysis',expected_output:'test evidence',
    protocol:{profile:'job-v0',source:'offline-source',scope:'offline-scope',
      policy:'offline-policy',destination:'offline-owner',retain_until_ms:now+86400000}};
  store.submit(payload,{mode:'none'},null,token,false,null,'normal',null,payload,null,'dot','worker');
  return store.claim(id,'offline-claimant',subject,10,null,'dot','acquisition-'+id,1000,context(id,'claim-'+id));
}
function ask(id,claim,q) {
  return store.askQuestion(id,claim.claim_id,q,'Please answer',subject,'dot',
    {...context(id,'ask-'+q),epoch:claim.epoch});
}
function snapshot(id) {
  return JSON.stringify({
    revision:store.protocolRevision(id),questions:store.questions(id),facts:store.protocolFacts(id),
    notifications:store.db.prepare('SELECT * FROM notifications WHERE request_id=? ORDER BY id').all(id),
    receipts:store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=? ORDER BY command_key').all(id),
    assignment:store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id),
  });
}
function unchanged(id,fn,pattern) {
  const before=snapshot(id);assert.throws(fn,pattern);assert.equal(snapshot(id),before);
}
try {
  store=open();
  store.subscribe('offline-subscription','https://example.invalid/events','offline-secret',
    new Date(now+86400000).toISOString(),subject,'dot');
  const id='answer-case',claim=submit(id);
  ask(id,claim,'question');
  const command=context(id,'answer-key');
  unchanged(id,()=>answerProtocolQuestion(store,id,'question','yes','wrong',command),/owner/);
  unchanged(id,()=>answerProtocolQuestion(store,id,'question','yes',token,{...command,revision:0}),/revision_conflict/);
  const receipt=answerProtocolQuestion(store,id,'question','yes',token,command);
  assert.deepEqual(receipt,{request_id:id,question_id:'question',answered:true,revision:command.revision+1});
  assert.equal(store.questions(id)[0].answer,'yes');
  assert.equal(store.protocolFacts(id).filter(x=>x.type==='answered').length,1);
  const answered=store.protocolFacts(id).at(-1);
  assert.equal(answered.revision,receipt.revision);assert.equal(answered.epoch,claim.epoch);
  assert.equal(answered.state,'awaiting_input');
  unchanged(id,()=>answerProtocolQuestion(store,id,'question','different',token,command),/command_conflict/);
  unchanged(id,()=>answerProtocolQuestion(store,id,'question','yes',token,context(id,'new-answer-key')),/ALREADY_ANSWERED/);
  // Test setup only: parent integrates the public consume route separately.
  store.transaction(()=>store.protocolMutationInTransaction(id,claim.claim_id,subject,'dot',
    {...context(id,'consume-key'),epoch:claim.epoch,operation:'consume',args:{questionId:'question'}},()=>{
      const value=store.consumeAnswerInTransaction(id,claim.claim_id,'question',subject,'dot');
      store.protocolEventInTransaction(id,'consumed',{question_id:'question'},claim.epoch);
      return value;
    }));
  const afterConsume=snapshot(id);
  assert.deepEqual(answerProtocolQuestion(store,id,'question','yes',token,command),receipt);
  assert.equal(snapshot(id),afterConsume);
  unchanged(id,()=>answerProtocolQuestion(store,id,'question','yes','wrong',command),/owner/);
  store.db.close();store=open();
  assert.deepEqual(answerProtocolQuestion(store,id,'question','yes',token,command),receipt);
  assert.equal(snapshot(id),afterConsume);
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM claim_command_receipts').all()).includes(token));
  const cancelId='cancel-case',cancelClaim=submit(cancelId);ask(cancelId,cancelClaim,'open-question');
  const cancelCommand=context(cancelId,'cancel-key');
  unchanged(cancelId,()=>cancelProtocolJob(store,cancelId,'stop','wrong',cancelCommand),/owner/);
  unchanged(cancelId,()=>cancelProtocolJob(store,cancelId,'stop',token,{...cancelCommand,revision:0}),/revision_conflict/);
  const cancelled=cancelProtocolJob(store,cancelId,'stop',token,cancelCommand);
  assert.equal(cancelled.compute_stopped,false);assert.equal(cancelled.authority_revoked,true);
  assert.equal(store.protocolFacts(cancelId).filter(x=>x.type==='cancelled').length,1);
  assert.equal(store.protocolFacts(cancelId).at(-1).state,'cancelled');
  assert.equal(store.questions(cancelId)[0].consumed_at,null);
  assert.equal(store.questions(cancelId)[0].answered_at,null);
  const afterCancel=snapshot(cancelId);
  assert.deepEqual(cancelProtocolJob(store,cancelId,'stop',token,cancelCommand),cancelled);
  assert.equal(snapshot(cancelId),afterCancel);
  unchanged(cancelId,()=>cancelProtocolJob(store,cancelId,'stop',token,context(cancelId,'cancel-again')),/TERMINAL/);
  unchanged(cancelId,()=>answerProtocolQuestion(store,cancelId,'open-question','yes',token,context(cancelId,'answer-after-cancel')),/TERMINAL/);
  assert.throws(()=>store.finish(cancelId,cancelClaim.claim_id,'blocked','Late evidence','Audit only',subject,null,'dot'),/assignment_cancelled/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM late_evidence WHERE request_id=?').get(cancelId).n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(cancelId).n,0);
  assert.equal(snapshot(cancelId),afterCancel);
  store.db.close();store=open();
  assert.deepEqual(cancelProtocolJob(store,cancelId,'stop',token,cancelCommand),cancelled);
  assert.equal(snapshot(cancelId),afterCancel);
  const oldId='epoch-case',old=submit(oldId);ask(oldId,old,'old-question');
  now+=1001;
  unchanged(oldId,()=>answerProtocolQuestion(store,oldId,'old-question','yes',token,context(oldId,'expired-answer')),/expired|lease/i);
  const fresh=store.claim(oldId,'offline-next',subject,10,null,'dot','next-acquisition',1000,context(oldId,'next-claim'));
  assert.equal(fresh.epoch,old.epoch+1);
  unchanged(oldId,()=>answerProtocolQuestion(store,oldId,'old-question','yes',token,context(oldId,'old-answer')),/STALE_EPOCH/);
  unchanged(oldId,()=>store.consumeAnswer(oldId,fresh.claim_id,'old-question',subject,'dot',context(oldId,'old-consume')),/STALE_EPOCH/);
  assert.equal(store.questions(oldId)[0].consumed_at,null);
  const finished='finished-case',finishedClaim=submit(finished);
  store.finish(finished,finishedClaim.claim_id,'completed','Native finish',JSON.stringify({source:'offline-source',policy:'offline-policy'}),subject,null,'dot',{...context(finished,'finish'),epoch:finishedClaim.epoch,args:{artifact_ids:[]}});
  unchanged(finished,()=>answerProtocolQuestion(store,finished,'missing','yes',token,context(finished,'answer-terminal')),/TERMINAL/);
  console.log('PASS: native owner answer/cancel transactions, receipts, replay and authority');
} finally {
  store?.db.close();rmSync(directory,{recursive:true,force:true});
}
