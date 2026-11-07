#!/usr/bin/env node
// Late output after cancel is bounded audit evidence, kept apart from results. finish answers a structured assignment_cancelled error.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-late-'));
const sha=text=>createHash('sha256').update(text).digest('hex');
const payload=id=>({schema_version:1,request_id:id,brief:'late evidence',inputs:[],expected_output:'one',execution_scope:'read-only'});
const refusal=fn=>{try{fn();}catch(e){return JSON.parse(e.message);}assert.fail('finish must refuse');};
try {
  const s=new Store(path.join(home,'bridge.db'));
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,65);
  const count=(table,id)=>s.db.prepare(`SELECT count(*) n FROM ${table} WHERE request_id=?`).get(id).n;
  s.submit(payload('req_a'),{mode:'none'},null,'owner');
  const c=s.claim('req_a','dot','sub',6);
  s.cancel('req_a','owner changed their mind');
  const before=s.db.prepare("SELECT status FROM assignments WHERE request_id='req_a'").get();
  const err=refusal(()=>s.finish('req_a',c.claim_id,'completed','my summary','my result','sub'));
  assert.equal(err.error,'assignment_cancelled');
  assert.equal(err.message,'req_a was cancelled (reason: owner changed their mind) before this finish. Your output was kept as audit evidence only (not a result); nothing more is needed for req_a; your other assignments are unaffected.');
  assert.equal(count('reports','req_a'),0,'no report row');
  assert.equal(count('late_evidence','req_a'),1,'one bounded late evidence row');
  assert.equal(s.db.prepare("SELECT status FROM assignments WHERE request_id='req_a'").get().status,before.status);
  assert.equal(s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id='req_a' AND kind='t3'").get().n,0,'nothing delivered');
  const row=s.db.prepare('SELECT * FROM late_evidence WHERE request_id=?').get('req_a');
  assert.deepEqual([row.claim_id,row.epoch,row.worker,row.outcome,row.summary,row.result,row.truncated,row.full_sha256],[c.claim_id,1,'dot','completed','my summary','my result',0,sha('my summary'+'my result')]);
  // An identical retry is the same TERMINAL error and writes nothing.
  assert.equal(refusal(()=>s.finish('req_a',c.claim_id,'completed','my summary','my result','sub')).error,'assignment_cancelled');
  assert.equal(count('late_evidence','req_a'),1);
  // A different payload is refused, still TERMINAL, and the first row stays.
  assert.equal(refusal(()=>s.finish('req_a',c.claim_id,'completed','other','other','sub')).error,'assignment_cancelled');
  assert.equal(count('late_evidence','req_a'),1);
  assert.equal(s.db.prepare('SELECT summary FROM late_evidence WHERE request_id=?').get('req_a').summary,'my summary');
  const got=s.get('req_a');
  assert.equal(got.report,null);
  assert.deepEqual(Object.keys(got.late_evidence).sort(),['created_at','full_sha256','summary','truncated'].sort());
  assert.equal(got.late_evidence.summary,'my summary');assert.equal(got.late_evidence.truncated,false);
  assert.equal(got.status,'cancelled');
  // Oversize output is truncated; the hash covers the whole original.
  s.submit(payload('req_b'),{mode:'none'},null,'owner');
  const cb=s.claim('req_b','dot','sub',6);s.cancel('req_b');
  const summary='s'.repeat(4096),result='r'.repeat(200*1024);
  refusal(()=>s.finish('req_b',cb.claim_id,'failed',summary,result,'sub'));
  const big=s.db.prepare('SELECT * FROM late_evidence WHERE request_id=?').get('req_b');
  assert.equal(Buffer.byteLength(big.summary),4096);assert.equal(Buffer.byteLength(big.result),64*1024);
  assert.equal(big.truncated,1);assert.equal(big.full_sha256,sha(summary+result));
  assert.equal(s.get('req_b').late_evidence.truncated,true);
  // Cancel without a reason still reads calmly.
  assert.match(refusal(()=>s.finish('req_b',cb.claim_id,'failed',summary,result,'sub')).message,/^req_b was cancelled before this finish\./);
  // Other jobs: a normal finish is unchanged, and the cancelled one's late evidence is no unread result.
  s.submit(payload('req_c'),{mode:'none'},null,'owner');
  const cc=s.claim('req_c','dot','sub',6);
  const ok=s.finish('req_c',cc.claim_id,'completed','done','done','sub');
  assert.equal(ok.result_authority,true);assert.equal(count('reports','req_c'),1);assert.equal(count('late_evidence','req_c'),0);
  assert.equal(s.ownerInbox('req_a').finished_at,null,'late evidence is not a finished result');
  const types=s.db.prepare("SELECT type FROM lifecycle_events WHERE request_id='req_a'").all().map(r=>r.type);
  assert.ok(!types.includes('completed'),'late evidence is not a completion');
  console.log('PASS late finish after cancel: structured TERMINAL error, bounded late_evidence, no report, retry and contradiction rules');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
