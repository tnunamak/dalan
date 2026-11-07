// Node24. Real protocol-v0 HTTP/SQLite. Missing native integration must fail, never be mocked.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';
const adapter=new DotBridgeAdapter({serverEnv:{DOT_BRIDGE_CATALOG_PROFILE:'protocol-v0'}});
const ok=r=>{assert.equal(r.error,undefined,JSON.stringify(r));assert.ok(r.value);return r.value;};
const refused=(r,re)=>assert.match(r.error??'',re,JSON.stringify(r));
try {
 await adapter.init();await adapter.reset();
 const job='owner-waiters',id=adapter.requestId(job),token=adapter.ownerToken(job);
 const ownerHash=createHash('sha256').update(token).digest('hex'),deadline=adapter.baseMs+10000;
 const assignment={schema_version:1,request_id:id,brief:'Real owner waiter HTTP fixture',inputs:[],
   execution_scope:'read-only',expected_output:'fixture',protocol:{profile:'job-v0',source:'git:BASE',
   scope:'read:fixture',policy:'P0',destination:'owner-inbox',retain_until_ms:adapter.baseMs+100000}};
 ok(await adapter.admin('POST','/submit',{assignment,delivery:'none',owner_token:token,command_key:'submit'}));
 const revision=()=>adapter.q1('SELECT revision FROM claim_command_revisions WHERE job=?',id).revision;
 const facts=()=>adapter.q('SELECT * FROM protocol_events WHERE request_id=? ORDER BY seq',id);
 const snapshot=()=>JSON.stringify({revision:revision(),facts:facts(),
   registrations:adapter.q('SELECT * FROM durable_waiters WHERE job=? ORDER BY waiter',id),
   receipts:adapter.q('SELECT * FROM claim_command_receipts WHERE job=? ORDER BY command_key',id),
   deliveries:adapter.q('SELECT * FROM durable_waiter_deliveries WHERE job=? ORDER BY delivery_id',id)});
 assert.equal(revision(),1);assert.equal(facts()[0].event_type,'submitted');
 const grant=ok(await adapter.mcp('W1','claim',{request_id:id,claimant:'W1',acquisition_id:'waiter-fixture',
   lease_ms:60000,command_key:'claim',expected_revision:1}));
 assert.equal(grant.epoch,1);assert.equal(revision(),2);
 const terminal={id,waiter:'terminal-A',predicate:'terminal',after_seq:0,expires_at:deadline,
   command_key:'wait-A',expected_revision:revision()};
 const terminalReply=ok(await adapter.admin('POST','/protocol/wait',terminal,token));
 const input={...terminal,waiter:'input-B',predicate:'input',command_key:'wait-B',expected_revision:revision()};
 const inputReply=ok(await adapter.admin('POST','/protocol/wait',input,token));
 assert.equal(terminalReply.waiter,'terminal-A');assert.equal(inputReply.waiter,'input-B');
 const afterRegistration=snapshot();
 refused(await adapter.admin('POST','/protocol/wait',{...terminal,waiter:'bad-cas',command_key:'bad-cas',expected_revision:0},token),/revision_conflict/);
 assert.equal(snapshot(),afterRegistration);
 const inbox=async waiter=>ok(await adapter.admin('POST','/protocol/inbox',{id,waiter},token)).deliveries;
 assert.deepEqual(await inbox(terminal.waiter),[]);assert.deepEqual(await inbox(input.waiter),[]);
 const note='Which fixture?';
 ok(await adapter.mcp('W1','ask_question',{request_id:id,claim_id:grant.claim_id,question_id:'Q',
   text:note,command_key:'ask',expected_revision:revision(),epoch:grant.epoch}));
 assert.equal(facts().at(-1).event_type,'questioned');
 const questions=await inbox(input.waiter);assert.equal(questions.length,1);
 assert.deepEqual(await inbox(terminal.waiter),[]);
 const queried=questions[0];
 const sameFact=adapter.q1('SELECT fact FROM durable_waiter_deliveries WHERE delivery_id=?',queried.delivery);
 assert.equal(JSON.parse(sameFact.fact).type,'questioned');
 const secondInput={...input,waiter:'input-C',command_key:'wait-C',expected_revision:revision()};
 ok(await adapter.admin('POST','/protocol/wait',secondInput,token));
 const second=(await inbox(secondInput.waiter))[0];assert.equal(second.event,queried.event);assert.notEqual(second.delivery,queried.delivery);
 const nativeBeforeInbox=adapter.q("SELECT * FROM lifecycle_events WHERE request_id=? AND type='consumed'",id);
 const revisionBeforeAck=revision(),factsBeforeAck=facts();
 ok(await adapter.admin('POST','/protocol/ack',{id,waiter:input.waiter,delivery:queried.delivery},token));
 assert.deepEqual(await inbox(input.waiter),[]);assert.equal((await inbox(secondInput.waiter)).length,1);
 assert.equal(revision(),revisionBeforeAck);assert.deepEqual(facts(),factsBeforeAck);
 assert.deepEqual(adapter.q("SELECT * FROM lifecycle_events WHERE request_id=? AND type='consumed'",id),nativeBeforeInbox);
 const stateBeforeWrong=snapshot();
 refused(await adapter.admin('POST','/protocol/inbox',{id,waiter:terminal.waiter},'wrong-owner'),/owner capability/);
 refused(await adapter.admin('POST','/protocol/ack',{id,waiter:secondInput.waiter,delivery:second.delivery},'wrong-owner'),/owner capability/);
 assert.equal(snapshot(),stateBeforeWrong);
 // Exact registration replays its original flat receipt, even after scan and ACK.
 assert.deepEqual(ok(await adapter.admin('POST','/protocol/wait',input,token)),inputReply);
 assert.deepEqual(ok(await adapter.admin('POST','/protocol/wait',terminal,token)),terminalReply);
 await adapter.control({op:'restart'});
 assert.deepEqual(ok(await adapter.admin('POST','/protocol/wait',input,token)),inputReply);
 assert.equal((await inbox(secondInput.waiter)).length,1);
 const stored=adapter.q('SELECT owner FROM durable_waiters WHERE job=?',id);
 assert(stored.every(r=>r.owner===ownerHash));
 assert.equal(adapter.q1('SELECT count(*) AS n FROM durable_waiter_deliveries WHERE job=? AND owner=?',id,token).n,0);
 const allStored=JSON.stringify({registrations:adapter.q('SELECT * FROM durable_waiters WHERE job=?',id),
   receipts:adapter.q('SELECT * FROM claim_command_receipts WHERE job=?',id),deliveries:adapter.q('SELECT * FROM durable_waiter_deliveries WHERE job=?',id)});
 assert(!allStored.includes(token),'raw capability must not be persisted');
 // Preserve native claim/answer epoch fences, not just waiter authentication.
 const beforeStale=snapshot();
 refused(await adapter.mcp('W2','consume_answer',{request_id:id,claim_id:grant.claim_id,question_id:'Q',
   command_key:'wrong-consume',expected_revision:revision(),epoch:grant.epoch}),/invalid claim|stale_authority|claim_/);
 refused(await adapter.mcp('W1','progress',{request_id:id,claim_id:grant.claim_id,note:'wrong epoch',
   command_key:'wrong-epoch',expected_revision:revision(),epoch:grant.epoch+1}),/stale_authority|STALE_EPOCH/);
 assert.equal(snapshot(),beforeStale);
 ok(await adapter.admin('POST','/answer',{id,question_id:'Q',text:'fixture A',command_key:'answer',expected_revision:revision()},token));
 ok(await adapter.mcp('W1','consume_answer',{request_id:id,claim_id:grant.claim_id,question_id:'Q',
   command_key:'consume',expected_revision:revision(),epoch:grant.epoch}));
 const expired={...terminal,waiter:'expired',command_key:'expired',expires_at:adapter.baseMs+100,expected_revision:revision()};
 ok(await adapter.admin('POST','/protocol/wait',expired,token));
 await adapter.control({op:'advance',to:100});
 const finish=ok(await adapter.mcp('W1','finish',{request_id:id,claim_id:grant.claim_id,outcome:'completed',
   summary:'fixture done',result:JSON.stringify({source:'git:BASE',policy:'P0'}),artifact_ids:[],
   command_key:'finish',expected_revision:revision(),epoch:grant.epoch}));
 assert.ok(finish.receipt_id);assert.equal(facts().at(-1).event_type,'finished');
 assert.equal((await inbox(terminal.waiter)).length,1);
 assert.deepEqual(await inbox(expired.waiter),[],'exact waiter deadline excludes later result');
 assert.deepEqual(await inbox(input.waiter),[],'result must not satisfy input predicate');
 assert.equal((await inbox(secondInput.waiter)).length,1,'unacked question remains independent of result');
 assert.deepEqual(ok(await adapter.admin('POST','/protocol/wait',terminal,token)),terminalReply);
 assert.equal(adapter.q("SELECT * FROM lifecycle_events WHERE request_id=? AND type='consumed'",id).length,nativeBeforeInbox.length);
 console.log('PASS real HTTP owner waiter assertions; no broader conformance claim');
} finally {await adapter.close();}

await import('./protocol-service-http-test.mjs');
