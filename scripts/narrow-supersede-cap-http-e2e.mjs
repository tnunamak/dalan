#!/usr/bin/env node
// H2: the HTTP admission check must agree with Store.submit on supersede cap room.
import assert from 'node:assert/strict';
import { harness } from './fault-cancel-finish-e2e.mjs';

const h=await harness('narrow-supersede-cap');
try {
  await h.start();
  const A=h.fixture(),P=h.fixture(),R=h.fixture(),R1=h.fixture(),R2=h.fixture();
  const submit=(f,extra={})=>h.admin('/submit',{delivery:'none',owner_token:f.owner,assignment:f.assignment,max_queued:1,...extra});
  const replace=(f,t,extra={})=>submit(f,{supersedes:{target_id:t.id,target_token:t.owner},...extra});
  const queued=()=>h.inspect(s=>s.db.prepare("SELECT count(*) n FROM assignments WHERE status='queued'").get().n);
  assert.equal((await submit(A)).status,200);assert.equal(queued(),1);
  // A plain submit at the cap is still deferred (refuse_defer) or refused by the store (default).
  const deferred=await submit(P,{refuse_defer:true});
  assert.equal(deferred.status,409,JSON.stringify(deferred.body));assert.equal(deferred.body.verdict,'defer');
  const full=await submit(P);assert.notEqual(full.status,200);assert.match(full.body.error,/queue is full/);
  h.inspect(s=>assert.equal(s.hasAssignment(P.id),false));
  // A replacement leaves the queued count unchanged, so the advisory check must not defer it.
  const preview=await h.admin('/submit-preview',{delivery:'none',owner_token:R.owner,assignment:R.assignment,max_queued:1,supersedes:{target_id:A.id,target_token:A.owner}});
  assert.equal(preview.status,200);assert.ok(!(preview.body.reasons??[]).some(r=>r.code==='queue_full'),JSON.stringify(preview.body));
  // A wrong target token at the cap is refused before any queue verdict; the queue_depth threshold also skips a valid target.
  const forged=await h.admin('/submit-preview',{delivery:'none',owner_token:R.owner,assignment:R.assignment,max_queued:1,supersedes:{target_id:A.id,target_token:'wrong-target'}});
  assert.equal(forged.body.verdict,'reject',JSON.stringify(forged.body));assert.deepEqual(forged.body.reasons.map(r=>r.message),['invalid owner capability']);
  const depth=await h.admin('/submit-preview',{delivery:'none',owner_token:R.owner,assignment:R.assignment,defer_queued:1,supersedes:{target_id:A.id,target_token:A.owner}});
  assert.equal(depth.status,200);assert.ok(!(depth.body.reasons??[]).some(r=>r.code==='queue_depth'),JSON.stringify(depth.body));
  const accepted=await replace(R,A,{refuse_defer:true});
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.duplicate,false);
  h.inspect(s=>{assert.equal(s.get(A.id).status,'cancelled');assert.equal(s.get(R.id).status,'queued');});
  assert.equal(queued(),1);
  // Two concurrent replacements of one target: exactly one wins and the queue never grows.
  const replies=await Promise.all([replace(R1,R),replace(R2,R)]);
  assert.equal(replies.filter(r=>r.status===200&&r.body.duplicate===false).length,1,JSON.stringify(replies.map(r=>r.body)));
  const loser=replies.find(r=>r.status!==200);assert.ok(loser,'one replacement must be refused');
  assert.match(loser.body.error,/supersede_target_not_queued/);
  assert.equal(queued(),1);
  h.inspect(s=>assert.equal(s.get(R.id).status,'cancelled'));
  console.log('PASS H2 at-cap replacement over HTTP (refuse_defer, preview, defer_queued), forged target token, plain at-cap refusal, two concurrent replacements');
} finally { await h.close(); }
