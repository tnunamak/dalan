#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { messageFor } from '../src/destinations/t3.mjs';

if(process.argv[2]==='--answer-racer') {
  const [file,id,text,clock]=process.argv.slice(3);
  const store=new Store(file,{now:()=>Number(clock),limits:{leaseMs:100}});
  try { store.answerQuestion(id,'Q',text);console.log(JSON.stringify({won:true})); }
  catch(error) { assert.equal(error.code,'ALREADY_ANSWERED');console.log(JSON.stringify({won:false})); }
  finally {store.db.close();}
} else {
  const root=fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP??os.tmpdir(),'ql-'));
  const file=path.join(root,'state.db');let now=1000000;
  const open=()=>new Store(file,{now:()=>now,limits:{leaseMs:100},resumeIdleMs:0});
  let store=open();
  const payload=id=>({schema_version:1,request_id:id,brief:'structured question fixture',inputs:[],expected_output:'one answer',execution_scope:'read-only'});
  const job=id=>{store.submit(payload(id),{mode:'none'},null,'owner');return store.claim(id,'W1','subject-1',100);};
  const ask=(id,grant,text='choose')=>store.askQuestion(id,grant.claim_id,'Q',text,'subject-1');
  const events=id=>store.db.prepare("SELECT type,reason FROM lifecycle_events WHERE request_id=? AND reason LIKE 'question:%' ORDER BY id").all(id).map(row=>({...row}));
  const snapshot=()=>JSON.stringify(['assignments','claims','job_questions','question_answer_wakes','progress','owner_notes','lifecycle_events','notifications'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const refused=(code,fn)=>{const before=snapshot();assert.throws(fn,error=>error.code===code);assert.equal(snapshot(),before,`${code} changed durable state`);};
  try {
    const grant=job('durable');ask('durable',grant);
    const questionNotice=store.db.prepare("SELECT * FROM notifications WHERE request_id='durable' AND body IS NOT NULL").get();
    assert.match(messageFor({...questionNotice,kind:'blocker'},store.get('durable')),/Reply with dalan answer durable Q/);
    const before=snapshot();assert.equal(ask('durable',grant).duplicate,true);assert.equal(snapshot(),before);
    refused('KEY_CONFLICT',()=>ask('durable',grant,'different'));
    store.note('durable','a generic note is not an answer');
    refused('NO_ANSWER',()=>store.consumeAnswer('durable',grant.claim_id,'Q','subject-1'));
    refused('QUESTION_OPEN',()=>store.finish('durable',grant.claim_id,'completed','done','result','subject-1'));
    store.answerQuestion('durable','Q','use supplied fixture');
    refused('ALREADY_ANSWERED',()=>store.answerQuestion('durable','Q','replacement'));
    refused('QUESTION_OPEN',()=>store.finish('durable',grant.claim_id,'completed','done','result','subject-1'));
    store.db.close();store=open();
    assert.deepEqual(store.consumeAnswer('durable',grant.claim_id,'Q','subject-1'),{question_id:'Q',answer:'use supplied fixture',duplicate:false});
    const consumed=snapshot();assert.equal(store.consumeAnswer('durable',grant.claim_id,'Q','subject-1').duplicate,true);assert.equal(snapshot(),consumed);
    assert.equal(store.assertQuestionsResolved('durable',grant.claim_id),true);
    const report=store.finish('durable',grant.claim_id,'completed','done','result','subject-1');assert.equal(report.duplicate,false);
    refused('TERMINAL',()=>store.consumeAnswer('durable',grant.claim_id,'Q','subject-1'));
    assert.deepEqual(events('durable'),[{type:'waiting',reason:'question:ask:Q'},{type:'waiting',reason:'question:answer:Q'},{type:'working',reason:'question:consume:Q'}]);
    now+=1000;assert.equal(store.finish('durable',grant.claim_id,'completed','done','result','subject-1').receipt_id,report.receipt_id);
    console.log('PASS durable identity, separate owner notes, one answer, restart consumption, finish guard and committed retry');

    const legacy=job('legacy');store.progress('legacy',legacy.claim_id,'QUESTION: choose','subject-1');ask('legacy',legacy);
    assert.equal(store.db.prepare("SELECT count(*) n FROM notifications WHERE request_id='legacy' AND body IS NOT NULL").get().n,2,'legacy text must not suppress an identified question');
    job('absent');refused('NO_QUESTION',()=>store.answerQuestion('absent','Q','early'));
    const cancelled=job('cancelled');ask('cancelled',cancelled);store.answerQuestion('cancelled','Q','answer before cancellation');store.cancel('cancelled');
    refused('TERMINAL',()=>store.consumeAnswer('cancelled',cancelled.claim_id,'Q','subject-1'));
    refused('TERMINAL',()=>store.answerQuestion('cancelled','Q','late'));
    assert.throws(()=>store.finish('cancelled',cancelled.claim_id,'blocked','stopped','audit','subject-1'),/assignment_cancelled/);
    assert.equal(store.db.prepare("SELECT count(*) n FROM late_evidence WHERE request_id='cancelled'").get().n,1);
    console.log('PASS absent and terminal answer refusals preserve state and cancelled late evidence');
    for(const outcome of ['blocked','failed']) {
      const id='unanswered_'+outcome,grant=job(id);ask(id,grant);
      const receipt=store.finish(id,grant.claim_id,outcome,'cannot proceed','question remains unanswered','subject-1');
      assert(receipt.receipt_id);const question=store.questions(id)[0];
      assert.equal(question.answer,null);assert.equal(question.answered_at,null);assert.equal(question.consumed_at,null);
      assert.equal(store.get(id).status,'finished');assert.equal(store.get(id).report.outcome,outcome);
      refused('TERMINAL',()=>store.consumeAnswer(id,grant.claim_id,'Q','subject-1'));
      refused('TERMINAL',()=>store.answerQuestion(id,'Q','late answer'));
      assert.throws(()=>store.claim(id,'new holder','subject-2',100),/finished|terminal/);
      assert.equal(store.finish(id,grant.claim_id,outcome,'cannot proceed','question remains unanswered','subject-1').receipt_id,receipt.receipt_id);
    }
    console.log('PASS blocked/failed finish preserves open owner audit question without consumption or further authority');

    const stale=job('stale');ask('stale',stale);now+=100;
    const successor=store.claim('stale','W2','subject-2',100);assert.equal(successor.epoch,2);
    refused('STALE_EPOCH',()=>store.answerQuestion('stale','Q','old'));
    refused('STALE_EPOCH',()=>store.consumeAnswer('stale',successor.claim_id,'Q','subject-2'));
    refused('STALE_EPOCH',()=>store.askQuestion('stale',successor.claim_id,'Q','reused','subject-2'));
    store.askQuestion('stale',successor.claim_id,'NEW','new question','subject-2');store.answerQuestion('stale','NEW','current answer');
    const unchanged=snapshot();assert.throws(()=>store.consumeAnswer('stale',stale.claim_id,'NEW','subject-1'),/claim_superseded|invalid claim/);assert.equal(snapshot(),unchanged);
    assert.equal(store.consumeAnswer('stale',successor.claim_id,'NEW','subject-2').answer,'current answer');
    store.finish('stale',successor.claim_id,'completed','done','result','subject-2');
    console.log('PASS exact expiry regrant, old question identity, old-holder consumption and stale question not blocking new grant');

    const expired=job('expired');ask('expired',expired);now+=100;
    const expiredBefore=snapshot();assert.throws(()=>store.answerQuestion('expired','Q','late'),/lease_expired/);assert.equal(snapshot(),expiredBefore);
    const invalid=job('invalid');
    for(const [qid,text] of [['','x'],['Q',''],['Q','x'.repeat(4097)],['bad/id','x']]) {const before=snapshot();assert.throws(()=>store.askQuestion('invalid',invalid.claim_id,qid,text,'subject-1'));assert.equal(snapshot(),before);}
    console.log('PASS expired answer and malformed question inputs cause no mutation');

    const rollback=job('rollback');const lifecycle=store.lifecycle;
    store.lifecycle=()=>{throw new Error('injected lifecycle failure');};let snap=snapshot();
    assert.throws(()=>ask('rollback',rollback),/injected lifecycle/);assert.equal(snapshot(),snap);store.lifecycle=lifecycle;
    ask('rollback',rollback);store.lifecycle=()=>{throw new Error('injected lifecycle failure');};snap=snapshot();
    assert.throws(()=>store.answerQuestion('rollback','Q','answer'),/injected lifecycle/);assert.equal(snapshot(),snap);store.lifecycle=lifecycle;
    store.answerQuestion('rollback','Q','answer');store.lifecycle=()=>{throw new Error('injected lifecycle failure');};snap=snapshot();
    assert.throws(()=>store.consumeAnswer('rollback',rollback.claim_id,'Q','subject-1'),/injected lifecycle/);assert.equal(snapshot(),snap);store.lifecycle=lifecycle;
    console.log('PASS question state and lifecycle publication roll back atomically for every transition');

    const wake=job('wake');ask('wake',wake);
    store.subscribe('subject-1','http://127.0.0.1/fixture','whsec_'+'x'.repeat(44),new Date(now+100000).toISOString());
    store.db.exec("CREATE TRIGGER fixture_refuse_answer_wake BEFORE INSERT ON notifications WHEN NEW.wake_kind='owner_note' BEGIN SELECT RAISE(ABORT,'wake enqueue failure'); END");snap=snapshot();
    assert.throws(()=>store.answerQuestion('wake','Q','answer'),/wake enqueue failure/);assert.equal(snapshot(),snap);store.db.exec('DROP TRIGGER fixture_refuse_answer_wake');
    store.answerQuestion('wake','Q','answer');
    const notification=store.db.prepare("SELECT * FROM notifications WHERE request_id='wake' AND wake_kind='owner_note'").get();assert(notification);
    assert.deepEqual(Object.keys(JSON.parse(notification.body).data).sort(),['request_id','title']);assert.equal(store.db.prepare('SELECT epoch FROM question_answer_wakes WHERE notification_id=?').get(notification.id).epoch,wake.epoch);const attempt=store.startAttempt(notification.id);assert(attempt);
    store.consumeAnswer('wake',wake.claim_id,'Q','subject-1');assert.equal(store.questionWakeCurrent(notification),false);
    const staleWake=job('wake_stale');ask('wake_stale',staleWake);store.answerQuestion('wake_stale','Q','answer');
    const oldWake=store.db.prepare("SELECT * FROM notifications WHERE request_id='wake_stale' AND wake_kind='owner_note'").get();
    now+=100;assert.equal(store.claim('wake_stale','W2','subject-2',100).epoch,2);
    assert.equal(store.startAttempt(oldWake.id),null);assert.equal(store.db.prepare('SELECT state FROM notifications WHERE id=?').get(oldWake.id).state,'suppressed');
    console.log('PASS frozen event payload, answer/wake atomicity and wake refusal after consumption or regrant');
    for(const outcome of ['blocked','failed']) for(const state of ['pending','failed']) {
      const id='terminal_wake_'+outcome+'_'+state,grant=job(id);ask(id,grant);store.answerQuestion(id,'Q','saved answer');
      const event=store.db.prepare("SELECT * FROM notifications WHERE request_id=? AND wake_kind='owner_note'").get(id);
      store.db.prepare('UPDATE notifications SET state=? WHERE id=?').run(state,event.id);
      const receipt=store.finish(id,grant.claim_id,outcome,'cannot continue','unconsumed answer retained','subject-1');
      const question=JSON.stringify(store.questions(id)),history=JSON.stringify(events(id));
      assert.equal(store.startAttempt(event.id),null,'terminal answer wake must not dispatch');
      assert.equal(store.db.prepare('SELECT state FROM notifications WHERE id=?').get(event.id).state,'suppressed');
      assert.equal(JSON.stringify(store.questions(id)),question);assert.equal(JSON.stringify(events(id)),history);
      assert.equal(store.questions(id)[0].answer,'saved answer');assert.equal(store.questions(id)[0].consumed_at,null);
      assert.equal(store.finish(id,grant.claim_id,outcome,'cannot continue','unconsumed answer retained','subject-1').receipt_id,receipt.receipt_id);
    }
    console.log('PASS pending/failed answer wakes suppressed after blocked/failed finish with audit facts and finish retry intact');

    const race=job('race');ask('race',race);
    const results=await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--answer-racer',file,'race','answer '+i,String(now)],{env:process.env,stdio:['ignore','pipe','pipe']});let output='',error='';
      child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);child.once('error',reject);child.once('exit',code=>{try{assert.equal(code,0,error);resolve(JSON.parse(output));}catch(e){reject(e);}});
    })));
    assert.equal(results.filter(result=>result.won).length,1);assert.equal(events('race').filter(event=>event.reason==='question:answer:Q').length,1);
    assert.match(store.questions('race')[0].answer,/^answer [0-7]$/);
    console.log('PASS eight-process answer race commits exactly one answer and one native event');
  } finally {store.db.close();fs.rmSync(root,{recursive:true,force:true});}
}
