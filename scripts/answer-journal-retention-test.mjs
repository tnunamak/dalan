import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
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
  const unsafePrune=pruneExpiredAnswerJournals({store,receiptsDir});
  assert.ok(unsafePrune.skipped.some(row=>row.job===bad&&row.reason==='unsafe_journal_entry'));
  assert.ok(unsafePrune.skipped.some(row=>row.job===odd&&row.reason==='unexpected_journal_name'));
  for(const id of [bad,odd])assert.equal(fs.existsSync(journalPath(receiptsDir,id,'Q')),true,'full preflight prevents partial deletion on unsafe entries');
  assert.equal(fs.readFileSync(path.join(outside,'Q.json'),'utf8'),'outside sentinel');
  const alias=path.join(root,'receipts-alias');fs.symlinkSync(receiptsDir,alias,'dir');
  assert.ok(pruneExpiredAnswerJournals({store,receiptsDir:alias}).skipped.every(row=>row.reason==='unsafe_receipts_directory'));
  assert.equal(fs.existsSync(journalPath(receiptsDir,live,'Q')),true);

  // Run the actual command, replacing only HTTP transport in an isolated child.
  // No listening socket or live bridge: every unexpected route fails closed.
  const cliHome=path.join(root,'cli-home');
  const cliReceipts=path.join(cliHome,'.local/share/dalan/receipts');
  fs.mkdirSync(cliReceipts,{recursive:true,mode:0o700});
  const fakeBridge=path.join(root,'fake-bridge.mjs'),callsFile=path.join(root,'calls.jsonl');
  const cliExpired='cli-expired-001',cliLive='cli-live-001';
  for(const id of [cliExpired,cliLive])fs.writeFileSync(
    path.join(cliReceipts,createHash('sha256').update(id).digest('hex')+'.json'),
    JSON.stringify({request_id:id,token:'synthetic-offline-owner'}),{mode:0o600});
  fs.writeFileSync(fakeBridge,`
import http from 'node:http';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import assert from 'node:assert/strict';
http.request=(options,callback)=>{
  const req=new EventEmitter();
  req.setTimeout=()=>req;
  req.end=bytes=>queueMicrotask(()=>{
    assert.equal(options.headers['x-owner-capability'],'synthetic-offline-owner');
    const body=bytes?JSON.parse(bytes):null;
    fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify({method:options.method,path:options.path,body})+'\\n');
    let status=200,value;
    if(options.method==='GET'&&options.path.startsWith('/get?id=')){
      const id=new URL(options.path,'http://offline.invalid').searchParams.get('id');
      assert.ok(['cli-expired-001','cli-live-001'].includes(id));
      if(id==='cli-expired-001'){status=410;value={error:'TOMBSTONE'};}
      else value={protocol_revision:7};
    }else if(options.method==='POST'&&options.path==='/answer'){
      // Check write-before-send in the real command, not merely after exit.
      const saved=JSON.parse(fs.readFileSync(process.env.FAKE_RECEIPTS+'/'+body.id+'.answers/Q.json','utf8'));
      assert.equal(saved.state,'prepared');
      assert.equal(saved.text,body.text);
      assert.equal(saved.key,body.command_key);
      assert.equal(saved.expected_revision,body.expected_revision);
      value={answered:true};
    }else throw new Error('unexpected fake bridge route '+options.method+' '+options.path);
    const res=new EventEmitter();res.statusCode=status;callback(res);
    res.emit('data',JSON.stringify(value));res.emit('end');
  });
  return req;
};
`);
  function answerCommand(id){
    fs.writeFileSync(callsFile,'');
    const child=spawnSync(process.execPath,['--import',pathToFileURL(fakeBridge).href,
      fileURLToPath(new URL('../bin/dot-worker.mjs',import.meta.url)),
      'answer',id,'Q','synthetic answer only','--json'],
      {encoding:'utf8',timeout:10000,env:{HOME:cliHome,USERPROFILE:cliHome,
        PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1',FAKE_CALLS:callsFile,FAKE_RECEIPTS:cliReceipts}});
    assert.ifError(child.error);assert.equal(child.signal,null);
    return {...child,calls:fs.readFileSync(callsFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))};
  }
  const expiredCommand=answerCommand(cliExpired);
  assert.equal(expiredCommand.status,1);
  assert.equal(JSON.parse(expiredCommand.stderr.trim()).error,'TOMBSTONE');
  assert.equal(fs.existsSync(path.join(cliReceipts,cliExpired+'.answers')),false);
  assert.equal(expiredCommand.calls.length,1);
  assert.equal(expiredCommand.calls[0].method,'GET');
  const liveCommand=answerCommand(cliLive);
  assert.equal(liveCommand.status,0,liveCommand.stderr);
  assert.equal(JSON.parse(liveCommand.stdout).answered,true);
  assert.deepEqual(liveCommand.calls.map(call=>call.method),['GET','GET','POST']);
  assert.equal(JSON.parse(fs.readFileSync(journalPath(cliReceipts,cliLive,'Q'),'utf8')).state,'committed');
  // Deleting the CLI gate must fail this case: prepare resumes without a GET.
  await prepare(cliExpired,'Q','synthetic answer only',{receiptsDir:cliReceipts,readRevision:async()=>7});
  const before=fs.readFileSync(journalPath(cliReceipts,cliExpired,'Q'),'utf8');
  const resumedExpired=answerCommand(cliExpired);
  assert.equal(resumedExpired.status,1);
  assert.equal(JSON.parse(resumedExpired.stderr.trim()).error,'TOMBSTONE');
  assert.deepEqual(resumedExpired.calls.map(call=>call.method),['GET']);
  assert.equal(fs.readFileSync(journalPath(cliReceipts,cliExpired,'Q'),'utf8'),before);

  console.log('PASS real Store retention fence, live preservation, expired pruning, encoded names, symlink and unexpected-entry refusal');
} finally {
  store.db.close();
  fs.rmSync(root,{recursive:true,force:true});
}
