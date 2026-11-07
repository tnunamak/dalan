import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {fixture,cleanup,workers,stateOf,assertDestinationRefusal,assertRefusal,assertAuthorized,refusalCode} from './claim-statechart-fixture.mjs';
after(cleanup);
const ID='req_statechart';
const live=f=>f.auth.liveConnectionIds('dot');
const db=f=>f.store.db;

// Setup that must succeed before any refusal is meaningful.
function queued(f,id=ID) {
  f.submit(id);
  const s=stateOf(db(f),id);
  assert.equal(s.assignment.status,'queued');assert.deepEqual(s.claims,[]);assert.deepEqual(s.reports,[]);
}
function claimed(f,id=ID) {
  queued(f,id);
  const a=f.claim(id);
  assert.match(a.claim_id,/^claim_/);assert.equal(a.epoch,1);
  const s=stateOf(db(f),id);
  assert.equal(s.assignment.status,'claimed');assert.equal(s.claims.length,1);
  assert.equal(s.claims[0].claim_id,a.claim_id);assert.equal(s.claims[0].state,'active');
  return a;
}
// Built-in mode: every claim-bound mutation carries the authenticated connection (the caller's, here always A's).
const finish=(f,a,id=ID)=>f.store.finish(id,a.claim_id,'completed','summary','result','owner',null,'dot',null,null,f.a.connection_id);

test('GrantAdmitted: replacement B cannot repeat A claimant/acquisition to renew A grant',t=>{
  const f=fixture(t);const a=claimed(f);
  const b=f.approve('B','dot',true);
  assert.deepEqual(live(f),[b.connection_id]); // A is replaced; only B is live
  assert.notEqual(b.connection_id,f.a.connection_id);
  f.clock(1);
  const before=stateOf(db(f),ID);
  assertDestinationRefusal(()=>f.claim(ID,'run','acq',b.connection_id),'destination_changed');
  assert.deepEqual(stateOf(db(f),ID),before); // claim row, activity, deadline, report and lifecycle are unchanged
  assert.equal(before.claims[0].claim_id,a.claim_id);assert.deepEqual(before.reports,[]);
  // Control: B itself is authorized for a job that was approved after B became live.
  queued(f,'req_statechart_b');
  assert.match(f.claim('req_statechart_b','run','acq',b.connection_id).claim_id,/^claim_/);
});

for(const change of ['revoke','replace']) test(`RevokedCannotCommit: ${change} between finish admission and commit fences result`,async t=>{
  const f=fixture(t);const a=claimed(f);
  assert.equal(f.store.assertFinishClaim(ID,a.claim_id,'owner','dot').claim_id,a.claim_id); // 3 BeginFinish (server, before await)
  if(change==='revoke')f.auth.revokeGrant(f.a.grantId,'owner');else f.approve('B','dot',true); // 4 Revoke or Replace
  assert.ok(!live(f).includes(f.a.connection_id),'A must no longer be live');
  const before=stateOf(db(f),ID);
  assert.deepEqual(before.reports,[]);assert.equal(before.assignment.status,'claimed');
  let refusal;
  try { finish(f,a); } catch(error) {
    // Unexpected Store errors fail the normal parent, not the desired-contract child.
    assertDestinationRefusal(()=>{throw error;},'connection_not_live');refusal=error;
  }
  const after=stateOf(db(f),ID);
  await t.test('desired contract',()=>{
    assert.ok(refusal,'finish must refuse connection_not_live');
    assert.deepEqual(after,before);
  });
});

test('RevokedCannotCommit control: a live connection commits one finish with these arguments',t=>{
  const f=fixture(t);const a=claimed(f);
  assert.equal(f.store.assertFinishClaim(ID,a.claim_id,'owner','dot').claim_id,a.claim_id);
  assert.ok(live(f).includes(f.a.connection_id));
  const result=finish(f,a);
  assert.equal(result.status,'finished');assert.equal(result.duplicate,false);
  const s=stateOf(db(f),ID);
  assert.equal(s.assignment.status,'finished');assert.equal(s.reports.length,1);assert.equal(s.reports[0].claim_id,a.claim_id);
});

// The exact transition a lease sweep must make for a dead holder: sweep returns the id, the job is queued again,
// the claim is abandoned for lease_expired and the log shows one abandoned event by actor system. Both tests below require this same transition.
function assertSweptAsLeaseExpired(a,swept,s) {
  assert.deepEqual(swept,[ID]);
  assert.equal(s.assignment.status,'queued');assert.equal(s.assignment.cancelled_reason,null);
  assert.equal(s.claims.length,1);assert.equal(s.claims[0].claim_id,a.claim_id);
  // The stored reason is `lease_expired` plus a diagnostic suffix, for example `lease_expired: 0 calls, no workspace tool`.
  const reason=/^lease_expired(: .+)?$/;
  assert.equal(s.claims[0].state,'abandoned');assert.match(s.claims[0].abandon_reason,reason);
  const abandoned=s.lifecycle.filter(e=>e.type==='abandoned');
  assert.equal(abandoned.length,1);
  assert.deepEqual({...abandoned[0],reason:undefined},{claim_id:a.claim_id,epoch:1,type:'abandoned',actor:'system',reason:undefined});
  assert.equal(abandoned[0].reason,s.claims[0].abandon_reason);assert.match(abandoned[0].reason,reason);
  assert.deepEqual(s.reports,[]);
}
function deadHolder(f,{withBreak}) {
  const a=claimed(f);
  if(withBreak){f.store.setBreak('owner break');assert.ok(f.store.activeBreak(),'the usage break must be open');} // 3 StartBreak after the last worker call
  f.clock(5); // 4 Clock: half the lease
  f.auth.revokeGrant(f.a.grantId,'owner'); // 5 Revoke; no live holder
  assert.deepEqual(live(f),[]);
  f.clock(6); // 6 Clock: expired
  const row=db(f).prepare('SELECT * FROM claims WHERE request_id=?').get(ID);
  assert.equal(f.store.leaseExpired(row),true);assert.equal(stateOf(db(f),ID).assignment.status,'claimed');
  return a;
}
test('NoStuck: expired dead holder is swept during a usage break',async t=>{
  const f=fixture(t);const a=deadHolder(f,{withBreak:true});
  const swept=f.store.sweepStaleLeases(); // an operation error fails the test
  const after=stateOf(db(f),ID);
  await t.test('desired contract',()=>assertSweptAsLeaseExpired(a,swept,after));
});
test('NoStuck control: the same dead holder is swept with no usage break',t=>{
  const f=fixture(t);const a=deadHolder(f,{withBreak:false});
  const swept=f.store.sweepStaleLeases();
  assertSweptAsLeaseExpired(a,swept,stateOf(db(f),ID));
});

// Known limit (SECURITY.md, "Known limits"): a queued job whose approved destination drifted and that has no deadline is not
// cancelled automatically. It cannot be claimed (destination_changed), it leaks nothing to the new connection through claim,
// and the owner recovers it by cancel and resubmit, or by restoring the approved destination. This test pins that behavior
// so a change to it is a deliberate decision, not drift. spec/tla/Queue.cfg expects the matching QueueProgress violation.
test('QueueProgress known limit: drifted undated job stays queued, refuses every claim, and the owner can cancel it',t=>{
  const f=fixture(t);queued(f); // ApproveSubmit
  assert.equal(db(f).prepare('SELECT valid_until FROM assignments WHERE request_id=?').get(ID).valid_until,null,'the job must be undated');
  const b=f.approve('B','dot',true); // Replace
  assert.deepEqual(live(f),[b.connection_id]);
  assertDestinationRefusal(()=>f.claim(ID,'new-run','new-acq',b.connection_id),'destination_changed');
  assert.equal(stateOf(db(f),ID).assignment.status,'queued');
  f.clock(365*24*3600000); // Repeat idle clock/sweep loop with B live
  f.store.sweepExpired();f.store.sweepStaleLeases();f.store.sweepSkipped();
  const s=stateOf(db(f),ID);
  assert.equal(s.assignment.status,'queued');assert.equal(s.assignment.cancelled_reason,null);
  assert.deepEqual(s.claims,[]);assert.deepEqual(s.reports,[]);
  assertDestinationRefusal(()=>f.claim(ID,'later-run','later-acq',b.connection_id),'destination_changed'); // still refused after a year
  assert.deepEqual(stateOf(db(f),ID).claims,[]);
  f.store.cancel(ID,'requester'); // the documented recovery
  assert.equal(stateOf(db(f),ID).assignment.status,'cancelled');
});

for(const lostAt of ['submit','finish']) test(`one lost ${lostAt} reply survives one restart without extra jobs or reports`,t=>{
  const f=fixture(t);f.submit(); // ApproveSubmit
  if(lostAt==='submit'){f.restart();f.submit();} // LoseReply, Restart, Retry
  const a=f.claim();
  const first=f.store.finish('req_statechart',a.claim_id,'completed','summary','result','owner',null,'dot',null,null,f.a.connection_id);
  if(lostAt==='finish')f.restart(); // LoseReply, Restart
  f.clock(100);
  const replay=f.store.finish('req_statechart',a.claim_id,'completed','summary','result','owner',null,'dot',null,null,f.a.connection_id); // Retry
  assert.equal(replay.receipt_id,first.receipt_id);assert.equal(replay.duplicate,true);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM assignments').get().n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM reports').get().n,1);
});

test('CancelWins: cancelled finish keeps audit evidence, no result',t=>{
  const f=fixture(t);f.submit();const a=f.claim();f.store.cancel('req_statechart','requester');
  assert.throws(()=>f.store.finish('req_statechart',a.claim_id,'completed','summary','result','owner',null,'dot',null,null,f.a.connection_id),/assignment_cancelled/);
  assert.equal(f.store.get('req_statechart').report,null);assert.equal(f.store.db.prepare('SELECT count(*) n FROM late_evidence').get().n,1);
});

test('fresh, idle rotation and takeover refuse drift; ordinary expiry frees dead claim',t=>{
  const f=fixture(t);f.submit();const a=f.claim();
  assert.equal(f.store.mayAct('other','req_statechart'),false);
  f.approve('B','dot',true);f.clock(11);
  const b=f.auth.liveConnectionIds('dot')[0];
  assertDestinationRefusal(()=>f.claim('req_statechart','idle-run','idle',b),'destination_changed');
  assertDestinationRefusal(()=>f.store.claim('req_statechart','takeover','different-subject',100,null,'dot','takeover',10,null,b),'destination_changed');
  f.store.sweepStaleLeases();assert.equal(f.store.get('req_statechart').status,'queued');
  assertDestinationRefusal(()=>f.claim('req_statechart','fresh','fresh',b),'destination_changed');
  assert.equal(f.store.get('req_statechart').claim.claim_id,a.claim_id);
});

test('PROTOCOL v5: fixed lease retry and renew receipt do not slide; expired grant cannot renew',t=>{
  const f=fixture(t),id='req_native_fixed',payload={schema_version:1,request_id:id,brief:'native lease',inputs:[],expected_output:'report',execution_scope:'read-only',protocol:{profile:'job-v0',source:'fixture',scope:'read',policy:'fixture',destination:'owner-inbox',retain_until_ms:Date.now()+86400000}};
  // Native policy labels grant no authority. Destination approval still binds A.
  // Use the same native submission surface as protocol-scheduler-test.mjs, with a current disclosure.
  {
    const approved=workers.destinationDisclosure(f.profile,'dot','worker',payload).revision;
    f.store.submit(payload,{mode:'none'},'','owner',false,null,'normal',null,payload,null,'dot','worker','worker',null,null,null,null,approved);
    const ctx={key:'claim',revision:1};
    const claim=()=>f.store.claim(id,'run','owner',100,null,'dot','acq',10,ctx,f.a.connection_id);
    const a=claim();f.clock(2);const duplicate=claim();assert.equal(duplicate.lease_expires_at,a.lease_expires_at);
    const renewCtx={key:'renew',revision:f.store.protocolRevision(id)};
    const renewal=f.store.renewClaim(id,a.claim_id,10,renewCtx,'owner','dot',f.a.connection_id);f.clock(1);
    assert.deepEqual(f.store.renewClaim(id,a.claim_id,10,renewCtx,'owner','dot',f.a.connection_id),renewal);
    f.clock(11);assert.throws(()=>f.store.renewClaim(id,a.claim_id,10,{key:'late',revision:f.store.protocolRevision(id)},'owner','dot',f.a.connection_id),/lease_expired/);
  }
});

// The assertion helpers must reject what the review named: an HTTP 500, an invalid token (401), a wrong claim ID
// (a different error code), a missing refusal and a refusal from a Store call that threw something else.
test('assertion guards: HTTP 500, invalid token, wrong claim ID and wrong code never pass as a refusal',()=>{
  const refusal=(code,extra={})=>({http:200,toolError:JSON.stringify({error:code}),code,...extra});
  assertRefusal(refusal('destination_changed'),'destination_changed','control'); // the one accepted shape
  const bad={
    'HTTP 500':{http:500,toolError:'HTTP 500',code:undefined},
    'invalid token (HTTP 401)':{http:401,toolError:'HTTP 401',code:undefined},
    'wrong claim ID (claim mismatch)':{http:200,toolError:'claim not found',code:refusalCode('claim not found')},
    'wrong code':refusal('assignment_cancelled'),
    'JSON-RPC error':{http:200,rpcError:{code:-32603},code:undefined},
    'success instead of refusal':{http:200,data:{claim_id:'claim_x'}}
  };
  for(const [name,res] of Object.entries(bad))assert.throws(()=>assertRefusal(res,'destination_changed',name),assert.AssertionError,name+' passed as a refusal');
  assert.throws(()=>assertAuthorized({http:401,toolError:'HTTP 401'},'x'),assert.AssertionError);
  assert.throws(()=>assertAuthorized({http:500,toolError:'HTTP 500'},'x'),assert.AssertionError);
  assert.throws(()=>assertAuthorized(refusal('destination_changed'),'x'),assert.AssertionError);
  assert.deepEqual(assertAuthorized({http:200,data:{ok:1}}),{ok:1});
  assert.throws(()=>assertDestinationRefusal(()=>{throw new Error('claim mismatch');},'destination_changed'),assert.AssertionError);
  assert.throws(()=>assertDestinationRefusal(()=>{},'destination_changed'),assert.AssertionError);
  assert.throws(()=>assertDestinationRefusal(()=>{throw Object.assign(new Error('x'),{destination:{error:'connection_not_live'}});},'destination_changed'),assert.AssertionError);
});
