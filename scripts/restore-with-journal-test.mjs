#!/usr/bin/env node
// Source contracts: src/store.mjs#submit/#claim/#askQuestion/#answerQuestion;
// src/answer-journal.mjs#prepare/#send/#reconcile; src/restore-check.mjs#inspectAnswerJournal.
// Snapshot: scripts/fault-restore-replay-e2e.mjs uses VACUUM INTO, closes, then restores.
// No network or server. These callbacks invoke the real Store, not a stand-in server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';
import {answerThroughJournal, prepare, reconcile, journalPath} from '../src/answer-journal.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP??os.tmpdir(),'restore-journal-'));
const data=path.join(root,'data'),config=path.join(root,'config'),receiptsDir=path.join(data,'receipts');
fs.mkdirSync(receiptsDir,{recursive:true,mode:0o700});fs.mkdirSync(config,{mode:0o700});
const file=path.join(data,'bridge.db'),snapshot=path.join(root,'before.db');
const job='restore-journal-fixture',text='Keep the original answer α';
const options={connectionIsLive:()=>true,destinationProfile:()=>({legacy:true})};
let store;
try {
  store=new Store(file,options);
  store.submit({schema_version:1,request_id:job,brief:'offline restore fixture',inputs:[],
    expected_output:'one answer',execution_scope:'read-only'},{mode:'none'},null,'synthetic-fixture-owner');
  const grant=store.claim(job,'restore-fixture','local-principal',6,null,'dot','restore-acquisition');
  assert.ok(grant.claim_id);
  // Distinct questions share one actual live grant.
  for(const q of ['committed','unknown','prepared'])store.askQuestion(job,grant.claim_id,q,'Which option?');
  // Setup: quiesce the Store, then snapshot through a fresh connection.
  store.db.close();store=null;
  const backupDb=new DatabaseSync(file);
  try { backupDb.prepare('VACUUM INTO ?').run(snapshot); } finally { backupDb.close(); }
  store=new Store(file,options);
  const envelopes=[];
  const deps=q=>({receiptsDir,readRevision:async()=>q==='committed'?17:null,
    readQuestion:async()=>store.questions(job).find(row=>row.question_id===q),
    post:async envelope=>{
      envelopes.push(structuredClone(envelope));
      return store.answerQuestion(envelope.id,envelope.question_id,envelope.text);
    }});
  await answerThroughJournal({job,questionId:'committed',text,...deps('committed')});
  // A real answer is applied, but authority loss makes its journal outcome unknown.
  await assert.rejects(answerThroughJournal({job,questionId:'unknown',text,...deps('unknown'),
    post:async envelope=>{
      envelopes.push(structuredClone(envelope));
      store.answerQuestion(envelope.id,envelope.question_id,envelope.text);
      throw Object.assign(new Error('owner capability unavailable'),{local_code:'unknown_request'});
    }}),{code:'answer_state_unknown'});
  await prepare(job,'prepared',text,{receiptsDir,readRevision:async()=>null});
  const journal=q=>JSON.parse(fs.readFileSync(journalPath(receiptsDir,job,q),'utf8'));
  // Setup checks of the saved journal, not restore-detector coverage.
  assert.equal(journal('committed').state,'committed');assert.equal(journal('unknown').state,'unknown');
  const savedUnknown=journal('unknown');
  store.db.close();store=null;
  fs.rmSync(file+'-wal',{force:true});fs.rmSync(file+'-shm',{force:true});
  fs.copyFileSync(snapshot,file);
  const beforeDb=fs.readFileSync(file);
  const beforeJournals=new Map(['committed','unknown','prepared'].map(q=>[q,fs.readFileSync(journalPath(receiptsDir,job,q))]));
  const check=(...args)=>spawnSync(process.execPath,[path.join(repo,'src/restore-check.mjs'),data,config,...args],
    {encoding:'utf8'});
  const refused=check();
  assert.equal(refused.status,1,refused.stderr);assert.match(refused.stderr,/journal is ahead/);
  const report=JSON.parse(refused.stdout.trim());
  assert.deepEqual(report.answer_journal,{entries:3,divergent:[],ahead_of_db:[
    {job,question_id:'committed',state:'committed'},{job,question_id:'unknown',state:'unknown'}]});
  // Read-only/override checks below are not independent detector coverage.
  const allowed=check('--allow-journal-ahead');
  assert.equal(allowed.status,0,allowed.stderr);
  assert.deepEqual(JSON.parse(allowed.stdout).answer_journal,report.answer_journal);
  assert.deepEqual(fs.readFileSync(file),beforeDb,'check cannot change DB bytes');
  for(const [q,bytes] of beforeJournals)assert.deepEqual(fs.readFileSync(journalPath(receiptsDir,job,q)),bytes);
  assert.equal(refused.stdout.includes(text),false,'report does not disclose answer text');
  store=new Store(file,options);
  const restored=q=>store.questions(job).find(row=>row.question_id===q);
  // Detector coverage: answered rows with different text, in both saved states.
  store.db.prepare('UPDATE job_questions SET answer=?,answered_at=? WHERE request_id=? AND question_id IN (?,?)')
    .run('different restored answer',new Date().toISOString(),job,'committed','unknown');
  store.db.close();store=null;
  const divergent=check();
  assert.equal(divergent.status,1,divergent.stderr);
  assert.deepEqual(JSON.parse(divergent.stdout).answer_journal,{entries:3,ahead_of_db:[],divergent:[
    {job,question_id:'committed',state:'committed'},{job,question_id:'unknown',state:'unknown'}]});
  // Read-only/no-disclosure check, not a substitute for divergence detection.
  assert.equal((divergent.stdout+divergent.stderr).includes('different restored answer'),false);
  assert.equal((divergent.stdout+divergent.stderr).includes(text),false);
  store=new Store(file,options);
  store.db.prepare('UPDATE job_questions SET answer=NULL,answered_at=NULL WHERE request_id=?').run(job);
  // Setup/readback checks below exercise replay, not the restore detector.
  assert.equal(restored('unknown').answer,null);
  assert.equal((await reconcile(job,'unknown',deps('unknown'))).state,'pending');
  let revisionReads=0;
  await answerThroughJournal({job,questionId:'unknown',text,...deps('unknown'),
    readRevision:async()=>{revisionReads++;throw new Error('must not prepare a new envelope');}});
  assert.equal(revisionReads,0);
  assert.deepEqual(envelopes.at(-1),{id:job,question_id:'unknown',text:savedUnknown.text,command_key:savedUnknown.key});
  assert.equal(envelopes.at(-1).command_key,'answer:unknown');
  assert.equal(restored('unknown').answer,text);assert.equal(journal('unknown').state,'committed');
  // C7c: committed journals read back the restored question before replay.
  // Setup: inspect the envelope that replay must preserve.
  const savedCommitted=journal('committed');
  const committedBytes=fs.readFileSync(journalPath(receiptsDir,job,'committed'));
  let posts=0,reads=0;
  const committedDeps={...deps('committed'),
    readRevision:async()=>{revisionReads++;throw new Error('must reuse saved revision');},
    readQuestion:async()=>{reads++;return restored('committed');},
    post:async envelope=>{posts++;return deps('committed').post(envelope);}};
  assert.equal(restored('committed').answer,null);
  assert.equal((await reconcile(job,'committed',committedDeps)).state,'pending');
  assert.equal(posts,0,'reconcile never posts');
  assert.deepEqual(fs.readFileSync(journalPath(receiptsDir,job,'committed')),committedBytes);
  await answerThroughJournal({job,questionId:'committed',text,...committedDeps});
  assert.equal(posts,1);assert.equal(revisionReads,0);
  assert.deepEqual(envelopes.at(-1),{id:job,question_id:'committed',text:savedCommitted.text,command_key:savedCommitted.key,expected_revision:17});
  assert.equal(savedCommitted.key,'answer:committed');
  assert.equal(savedCommitted.expected_revision,17);
  assert.equal(restored('committed').answer,text);
  assert.equal(journal('committed').state,'committed');
  assert.deepEqual(fs.readFileSync(journalPath(receiptsDir,job,'committed')),committedBytes);
  const local=await answerThroughJournal({job,questionId:'committed',text,...committedDeps});
  assert.equal(local.journal,'committed');assert.equal(posts,1);assert.equal(reads,3);
  store.db.prepare("UPDATE job_questions SET answer='different remote answer' WHERE request_id=? AND question_id='committed'").run(job);
  assert.equal((await reconcile(job,'committed',committedDeps)).state,'conflict');
  await assert.rejects(answerThroughJournal({job,questionId:'committed',text,...committedDeps}),{code:'answer_conflict'});
  assert.equal(posts,1);assert.equal(revisionReads,0);
  assert.deepEqual(fs.readFileSync(journalPath(receiptsDir,job,'committed')),committedBytes);
  // Reconcile is read-only even for a prepared envelope after restore.
  const preparedBytes=fs.readFileSync(journalPath(receiptsDir,job,'prepared'));
  let preparedPosts=0;
  assert.equal((await reconcile(job,'prepared',{...deps('prepared'),post:async()=>{preparedPosts++;throw new Error('must not send');}})).state,'pending');
  assert.equal(preparedPosts,0);
  assert.equal(restored('prepared').answer,null);
  assert.deepEqual(fs.readFileSync(journalPath(receiptsDir,job,'prepared')),preparedBytes);
  // Missing DB question is ahead too; prepared remains report-only.
  store.db.prepare("DELETE FROM job_questions WHERE request_id=? AND question_id='unknown'").run(job);
  store.db.close();store=null;
  const missing=check(job,'--allow-journal-ahead');
  assert.equal(missing.status,0,missing.stderr);
  assert.ok(JSON.parse(missing.stdout).answer_journal.ahead_of_db.some(row=>row.question_id==='unknown'));
  console.log('PASS restore journal guard, unknown and committed saved-envelope replay, duplicate suppression and conflict refusal');
} finally {
  store?.db.close();
  fs.rmSync(root,{recursive:true,force:true});
}
