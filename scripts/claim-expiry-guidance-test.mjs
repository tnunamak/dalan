import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
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
  console.log('PASS actionable expired question, cancelled-after-expiry reason and unchanged late-output fences');
} finally {store.db.close();fs.rmSync(dir,{recursive:true,force:true});}
