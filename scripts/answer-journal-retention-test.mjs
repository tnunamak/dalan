import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {prepare,journalPath} from '../src/answer-journal.mjs';
import {assertJournalAllowed,pruneExpiredAnswerJournals} from '../src/answer-journal-retention.mjs';

const root=fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP??os.tmpdir(),'answer-retention-'));
const receiptsDir=path.join(root,'receipts');fs.mkdirSync(receiptsDir,{mode:0o700});
let now=1800000000000;
const store=new Store(path.join(root,'state.sqlite'),{now:()=>now});
const payload=(id,deadline)=>({schema_version:1,request_id:id,brief:'Offline journal retention',
  inputs:[],scope_paths:[],execution_scope:'analysis',expected_output:'evidence',
  protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:deadline}});
const submit=(id,deadline)=>{
  const p=payload(id,deadline);
  store.submit(p,{mode:'none'},null,'offline-retention-owner',false,null,'normal',null,p,null,'dot','worker');
};
const save=(job,questionId='Q')=>prepare(job,questionId,'synthetic answer only',
  {receiptsDir,readRevision:async()=>store.protocolRevision(job)});
const expire=job=>assert.throws(()=>store.assertProtocolAvailable(job),error=>error.code==='TOMBSTONE'&&error.message==='TOMBSTONE');
try {
  // Native submit/clock expiry pattern: scripts/protocol-retention-test.mjs#submit.
  const live='live-job-001',expired='expired-job-001',linked='linked-job-001';
  for(const id of [live,expired,linked])submit(id,now+(id===live?10000:100));
  await save(live);await save(expired,'Q.:one');
  const outside=path.join(root,'outside');fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'Q.json'),'outside sentinel');
  fs.symlinkSync(outside,path.join(receiptsDir,linked+'.answers'),'dir');
  now+=100;expire(expired);expire(linked);
  // Same awaited callback gate as the CLI; real Store, no server/network.
  const refused='refused-job-001';submit(refused,now+1);now+=1;expire(refused);
  let revisionReads=0;
  await assert.rejects(async()=>{
    await assertJournalAllowed(async job=>store.assertProtocolAvailable(job),refused);
    await prepare(refused,'Q','synthetic answer only',{receiptsDir,
      readRevision:async()=>{revisionReads++;return store.protocolRevision(refused);}});
  },{code:'TOMBSTONE'});
  assert.equal(revisionReads,0);
  assert.equal(fs.existsSync(path.join(receiptsDir,refused+'.answers')),false);
  assert.equal(assertJournalAllowed(store,live),true);
  assert.throws(()=>assertJournalAllowed(store,expired),error=>error.code==='TOMBSTONE'&&error.message==='TOMBSTONE');
  assert.equal(assertJournalAllowed(store,'unknown-job-001'),true,'native legacy/unknown policy remains unchanged');
  const result=pruneExpiredAnswerJournals({store,receiptsDir});
  assert.deepEqual(result.pruned,[expired]);
  assert.deepEqual(result.skipped,[{job:linked,reason:'unsafe_answers_directory'},
    {job:refused,reason:'journal_missing'}]);
  assert.equal(fs.existsSync(journalPath(receiptsDir,live,'Q')),true);
  assert.equal(fs.existsSync(path.join(receiptsDir,expired+'.answers')),false);
  assert.equal(fs.lstatSync(path.join(receiptsDir,linked+'.answers')).isSymbolicLink(),true);
  assert.equal(fs.readFileSync(path.join(outside,'Q.json'),'utf8'),'outside sentinel');
  // Repeated cleanup neither reopens the logical fence nor invents a journal.
  assert.ok(pruneExpiredAnswerJournals({store,receiptsDir}).skipped.some(row=>row.job===expired&&row.reason==='journal_missing'));
  assert.throws(()=>assertJournalAllowed(store,expired),{code:'TOMBSTONE'});

  const bad='bad-entry-001',odd='odd-entry-001';
  for(const id of [bad,odd]){submit(id,now+100);await save(id);}
  fs.symlinkSync(path.join(outside,'Q.json'),path.join(receiptsDir,bad+'.answers','Z.json'));
  fs.writeFileSync(path.join(receiptsDir,odd+'.answers','unexpected.tmp'),'keep');
  now+=100;expire(bad);expire(odd);
  const refused=pruneExpiredAnswerJournals({store,receiptsDir});
  assert.ok(refused.skipped.some(row=>row.job===bad&&row.reason==='unsafe_journal_entry'));
  assert.ok(refused.skipped.some(row=>row.job===odd&&row.reason==='unexpected_journal_name'));
  for(const id of [bad,odd])assert.equal(fs.existsSync(journalPath(receiptsDir,id,'Q')),true,'full preflight prevents partial deletion on unsafe entries');
  assert.equal(fs.readFileSync(path.join(outside,'Q.json'),'utf8'),'outside sentinel');
  const alias=path.join(root,'receipts-alias');fs.symlinkSync(receiptsDir,alias,'dir');
  assert.ok(pruneExpiredAnswerJournals({store,receiptsDir:alias}).skipped.every(row=>row.reason==='unsafe_receipts_directory'));
  assert.equal(fs.existsSync(journalPath(receiptsDir,live,'Q')),true);
  console.log('PASS real Store retention fence, live preservation, expired pruning, encoded names, symlink and unexpected-entry refusal');
} finally {
  store.db.close();
  fs.rmSync(root,{recursive:true,force:true});
}
