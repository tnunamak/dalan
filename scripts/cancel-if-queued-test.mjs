#!/usr/bin/env node
// Store-level proof for the ACP adapter's two bridge needs: atomic cancel-if-queued and a stable HMAC-derived owner token.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { competingWrites } from './store-competing-writers.mjs';

const dir=mkdtempSync(join(tmpdir(),'dalan-bridge-cancel-if-queued-'));
const payload=id=>({schema_version:1,request_id:id,brief:'cancel if queued test',inputs:[],expected_output:'test',execution_scope:'read-only'});
const none={mode:'none'}, meta={source:'agent'};
try {
  const store=new Store(join(dir,'bridge.db'));
  // queued -> cancelled, once; the second call reports the state without changing it
  store.submit(payload('req_ciq_queued'),none,'env','owner',false,null,'normal',meta);
  assert.deepEqual(store.cancelIfQueued('req_ciq_queued'),{request_id:'req_ciq_queued',status:'cancelled',cancelled:true});
  assert.deepEqual(store.cancelIfQueued('req_ciq_queued'),{request_id:'req_ciq_queued',status:'cancelled',cancelled:false});
  assert.equal(store.get('req_ciq_queued').status,'cancelled');
  // claimed -> untouched, keeps running and can still finish
  store.submit(payload('req_ciq_claimed'),none,'env','owner',false,null,'normal',meta);
  const claim=store.claim('req_ciq_claimed','dot');
  assert.deepEqual(store.cancelIfQueued('req_ciq_claimed'),{request_id:'req_ciq_claimed',status:'claimed',cancelled:false});
  assert.equal(store.get('req_ciq_claimed').status,'claimed');
  assert.equal(store.get('req_ciq_claimed').cancelled_at,null);
  store.finish('req_ciq_claimed',claim.claim_id,'completed','done','done');
  // finished -> untouched
  assert.deepEqual(store.cancelIfQueued('req_ciq_claimed'),{request_id:'req_ciq_claimed',status:'finished',cancelled:false});
  assert.throws(()=>store.cancelIfQueued('req_ciq_missing'),/assignment not found/);
  // A separate connection holds an uncommitted claim while a cancel connection competes for the write lock.
  store.submit(payload('req_ciq_race'),none,'env','owner',false,null,'normal',meta);
  const claimWins=await competingWrites(join(dir,'bridge.db'),[
    {method:'claim',args:['req_ciq_race','dot'],holdMs:250},
    {method:'cancelIfQueued',args:['req_ciq_race']},
  ],{firstHoldsLock:true});
  assert.ok(claimWins[0].result?.claim_id);
  assert.deepEqual(claimWins[1].result,{request_id:'req_ciq_race',status:'claimed',cancelled:false});
  assert.equal(store.get('req_ciq_race').cancelled_at,null);
  // Reverse the lock winner: the claimant must observe committed cancellation and get no authority.
  store.submit(payload('req_ciq_cancel_wins'),none,'env','owner',false,null,'normal',meta);
  const cancelWins=await competingWrites(join(dir,'bridge.db'),[
    {method:'cancelIfQueued',args:['req_ciq_cancel_wins'],holdMs:250},
    {method:'claim',args:['req_ciq_cancel_wins','dot']},
  ],{firstHoldsLock:true});
  assert.equal(cancelWins[0].result?.cancelled,true);
  assert.match(cancelWins[1].error,/assignment cancelled/);
  assert.ok(!store.get('req_ciq_cancel_wins').claim);

  // stable owner token: HMAC(secret, request_id) re-derives the same capability after any process restart
  const secret='adapter-secret', token=id=>createHmac('sha256',secret).update(id).digest('hex');
  const first=store.submit(payload('req_ciq_stable'),none,'env',token('req_ciq_stable'),false,null,'normal',meta);
  assert.deepEqual([first.status,first.duplicate],['queued',false]);
  store.db.close();
  const reopened=new Store(join(dir,'bridge.db'));
  const again=reopened.submit(payload('req_ciq_stable'),none,'env',token('req_ciq_stable'),false,null,'normal',meta);
  assert.deepEqual([again.status,again.duplicate],['queued',true],'same token and payload is idempotent');
  reopened.owner('req_ciq_stable',token('req_ciq_stable')); // the re-derived token reads it
  assert.throws(()=>reopened.owner('req_ciq_stable',token('another_request')),/invalid owner capability/);
  assert.throws(()=>reopened.submit({...payload('req_ciq_stable'),brief:'a different brief'},none,'env',token('req_ciq_stable'),false,null,'normal',meta),/request_id conflict/);
  assert.throws(()=>reopened.submit(payload('req_ciq_stable'),none,'env',token('wrong_secret_id'),false,null,'normal',meta),/request_id conflict/,'a different owner token conflicts');
  reopened.db.close();
  console.log('PASS cancel-if-queued with competing writers is atomic and returns state; HMAC owner token is idempotent, and a changed payload conflicts');
} finally { rmSync(dir,{recursive:true,force:true}); }
