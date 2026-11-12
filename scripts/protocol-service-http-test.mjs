import assert from 'node:assert/strict';
import http from 'node:http';
import {DotBridgeAdapter} from './conformance/adapter-dot-bridge.mjs';
import {createInertProtocolFixtures} from '../src/test-support/protocol-service-fixtures.mjs';
import {createProtocolServices,protocolServiceCapability} from '../src/protocol-services.mjs';
import {Store} from '../src/store.mjs';
import {createProtocolOwnerWaiters} from '../src/protocol-owner-waiters.mjs';
const a=new DotBridgeAdapter();
const ok=r=>{assert.equal(r.error,undefined,JSON.stringify(r));return r.value;};
const refuse=(r,re)=>assert.match(r.error??'',re);
let n=0;
const command=(job,op,body,extra={})=>({v:0,job,op,key:'http-'+(++n),body,...extra});
async function create(job,{finish=false}={}) {
  ok(await a.op_submit({job,requestId:a.requestId(job),command:command(job,'submit',{source:'git:BASE',scope:'read:fixture',policy:'P0',destination:'owner-inbox',retainUntil:10000})}));
  const claim=ok(await a.op_claim({job,requestId:a.requestId(job),principal:'W1',command:command(job,'claim',{leaseMs:1000},{revision:1})}));
  if(finish) {
    ok(await a.op_wait({job,requestId:a.requestId(job),command:command(job,'wait',{waiter:'W',predicate:'terminal',afterSeq:0,expiresAt:9000},{revision:2})}));
    ok(await a.op_finish({job,requestId:a.requestId(job),principal:'W1',command:command(job,'finish',{outcome:'completed',summary:'done',artifacts:[],source:'git:BASE',policy:'P0'},{revision:3,epoch:claim.epoch,claim:claim.claim})},()=>{}));
  }
  return claim;
}
function state(job) {
  const id=a.requestId(job);
  return JSON.stringify({assignment:a.q1('SELECT * FROM assignments WHERE request_id=?',id),claim:a.q1('SELECT * FROM claims WHERE request_id=?',id),
    events:a.q('SELECT * FROM protocol_events WHERE request_id=? ORDER BY seq',id),
    deliveries:a.q('SELECT * FROM durable_waiter_deliveries WHERE job=?',id),attempts:a.q('SELECT * FROM protocol_delivery_attempts'),
    receipts:a.q('SELECT * FROM protocol_delivery_receipts'),observations:a.q('SELECT * FROM protocol_stop_observations'),stopReceipts:a.q('SELECT * FROM protocol_stop_receipts')});
}
async function unchanged(job,fn,re) {const before=state(job),ledger=JSON.stringify(createInertProtocolFixtures(a.home).inspect());refuse(await fn(),re);assert.equal(state(job),before);assert.equal(JSON.stringify(createInertProtocolFixtures(a.home).inspect()),ledger);}
try {
  await a.init();await a.reset();await create('delivery-http',{finish:true});
  const job='delivery-http',id=a.requestId(job),owner=a.ownerToken(job),delivery=a.q1('SELECT delivery_id FROM durable_waiter_deliveries WHERE job=?',id).delivery_id;
  const body={id,key:'dispatch',delivery};
  await unchanged(job,()=>a.admin('POST','/protocol/service/dispatch',body),/unauthorized/);
  await unchanged(job,()=>a.admin('POST','/protocol/service/dispatch',body,undefined,{serviceRole:'observer'}),/unauthorized/);
  await unchanged(job,()=>a.admin('POST','/protocol/service/dispatch',{...body,destination:'elsewhere'},undefined,{serviceRole:'dispatcher'}),/invalid_input/);
  const publicStatus=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:a.port,path:'/protocol/service/dispatch',method:'POST',headers:{host:'dot-bridge.example.test'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end('{}');});
  assert.equal(publicStatus,404);
  const first=ok(await a.admin('POST','/protocol/service/dispatch',body,undefined,{serviceRole:'dispatcher'}));
  assert.deepEqual(first,{delivery,state:'sending'});
  assert.deepEqual(ok(await a.admin('POST','/protocol/service/dispatch',body,undefined,{serviceRole:'dispatcher'})),first);
  assert.equal(createInertProtocolFixtures(a.home).inspect().begins,1);
  const facts=a.q('SELECT * FROM protocol_events WHERE request_id=?',id);
  createInertProtocolFixtures(a.home).injectDelivery(delivery,'accepted-before-crash','acknowledged');
  assert.equal(createInertProtocolFixtures(a.home).inspect().accepts,1);
  assert.equal(a.q1('SELECT state FROM protocol_delivery_attempts WHERE delivery_id=?',delivery).state,'sending','receiver acceptance has no native outcome acknowledgement yet');
  await a.control({op:'restart'});
  await unchanged(job,()=>a.admin('POST','/protocol/service/dispatch',{...body,key:'again'},undefined,{serviceRole:'dispatcher'}),/DELIVERY_UNKNOWN/);
  await unchanged(job,()=>a.admin('POST','/protocol/service/reconcile',{id,key:'forged',delivery,outcome:'found',receipt:'caller says found'},undefined,{serviceRole:'dispatcher'}),/delivery_evidence_invalid/);
  createInertProtocolFixtures(a.home).injectDelivery(delivery,'bound-receiver','found');
  const reconcile={id,key:'found',delivery,outcome:'found',receipt:'bound-receiver'};
  assert.equal(ok(await a.admin('POST','/protocol/service/reconcile',reconcile,undefined,{serviceRole:'dispatcher'})).state,'acknowledged');
  assert.deepEqual(ok(await a.admin('POST','/protocol/inbox',{id,waiter:'W'},owner)).deliveries,[]);
  assert.equal(createInertProtocolFixtures(a.home).inspect().accepts,1);
  assert.equal(createInertProtocolFixtures(a.home).inspect().begins,1);
  assert.deepEqual(a.q('SELECT * FROM protocol_events WHERE request_id=?',id),facts);
  await unchanged(job,()=>a.mcp('W1','observe_stop',{request_id:id,evidence:'fake'}),/unknown|invalid|not found/i);

  const stopJob='stop-http',stopId=a.requestId(stopJob);await create(stopJob);
  ok(await a.admin('POST','/cancel',{id:stopId,reason:'cancel',command_key:'cancel',expected_revision:2},a.ownerToken(stopJob)));
  await a.control({op:'restart'});
  const get=async()=>ok(await a.admin('GET','/get?id='+stopId+'&peek=1',undefined,a.ownerToken(stopJob)));
  assert.equal((await get()).protocol_stop,null);
  const observation={id:stopId,key:'stop',revision:3,stop:'confirmed',evidence:'trusted-stop'};
  await unchanged(stopJob,()=>a.admin('POST','/protocol/service/observe-stop',observation,undefined,{serviceRole:'dispatcher'}),/unauthorized/);
  await unchanged(stopJob,()=>a.admin('POST','/protocol/service/observe-stop',observation,undefined,{serviceRole:'observer'}),/stop_evidence_invalid/);
  const binding=JSON.parse(a.q1('SELECT binding FROM protocol_stop_enrollments WHERE job=?',stopId).binding);
  createInertProtocolFixtures(a.home).stop(binding,'trusted-stop');
  const observed=ok(await a.admin('POST','/protocol/service/observe-stop',observation,undefined,{serviceRole:'observer'}));
  assert.deepEqual(observed,{revision:4,stop:'confirmed'});
  const after=state(stopJob);
  assert.deepEqual(ok(await a.admin('POST','/protocol/service/observe-stop',observation,undefined,{serviceRole:'observer'})),observed);
  assert.equal(state(stopJob),after);
  const got=await get();assert.equal(got.status,'cancelled');assert.equal(got.report,null);assert.equal(got.compute_stopped,false);
  assert.equal(got.protocol_stop.scope,'inert-test-execution');assert.equal(got.protocol_stop.stop,'confirmed');
  await a.control({op:'restart'});assert.equal((await get()).protocol_stop.stop,'confirmed');

  // An old question is an epoch-bound outbound effect. An unresolved send
  // holds regrant; proven non-send releases it, but cannot authorize old sends.
  const qJob='question-http',qid=a.requestId(qJob),qOwner=a.ownerToken(qJob),qClaim=await create(qJob);
  ok(await a.mcp('W1','ask_question',{request_id:qid,claim_id:a.nativeClaim(qClaim.claim),question_id:'Q',text:'input?',command_key:'ask',expected_revision:2,epoch:1}));
  ok(await a.admin('POST','/protocol/wait',{id:qid,waiter:'input',predicate:'input',after_seq:0,expires_at:a.baseMs+9000,command_key:'wait',expected_revision:3},qOwner));
  const qDelivery=a.q1('SELECT delivery_id FROM durable_waiter_deliveries WHERE job=?',qid).delivery_id;
  const qDispatch={id:qid,key:'dispatch',delivery:qDelivery};
  ok(await a.admin('POST','/protocol/service/dispatch',qDispatch,undefined,{serviceRole:'dispatcher'}));
  await a.control({op:'advance',to:1000});await a.tick();
  const revision=a.q1('SELECT revision FROM claim_command_revisions WHERE job=?',qid).revision;
  const regrant={request_id:qid,claimant:'W2',acquisition_id:'new-holder',lease_ms:1000,command_key:'regrant',expected_revision:revision};
  refuse(await a.mcp('W2','claim',regrant),/uncertain_delivery/);
  createInertProtocolFixtures(a.home).injectDelivery(qDelivery,'never-sent','not_sent');
  ok(await a.admin('POST','/protocol/service/delivery-result',{id:qid,key:'not-sent',delivery:qDelivery,outcome:'not_sent',receipt:'never-sent'},undefined,{serviceRole:'dispatcher'}));
  assert.equal(ok(await a.mcp('W2','claim',regrant)).epoch,2);
  assert.deepEqual(ok(await a.admin('POST','/protocol/inbox',{id:qid,waiter:'input'},qOwner)).deliveries,[]);
  await unchanged(qJob,()=>a.admin('POST','/protocol/service/dispatch',{...qDispatch,key:'stale-send'},undefined,{serviceRole:'dispatcher'}),/stale_delivery_epoch/);
  const begins=createInertProtocolFixtures(a.home).inspect().begins;
  assert.equal(ok(await a.admin('POST','/protocol/service/dispatch',qDispatch,undefined,{serviceRole:'dispatcher'})).state,'sending');
  assert.equal(createInertProtocolFixtures(a.home).inspect().begins,begins,'historical dispatch receipt is not send authority');

  // Normal product construction rejects inert evidence even with an authentic
  // private observer capability. No fixture file can enable that resolver.
  const store=new Store(':memory:',{now:()=>1800000000000});
  try {
    const p={schema_version:1,request_id:'production-resolver',brief:'inert refusal',inputs:[],execution_scope:'read-only',expected_output:'none',protocol:{profile:'job-v0',source:'s',scope:'scope',policy:'p',destination:'owner-inbox',retain_until_ms:1800000010000}};
    store.submit(p,{mode:'none'},null,'owner',false,null,'normal',null,p,null,'dot','worker');
    const c=store.claim(p.request_id,'W1','subject',10,null,'dot','a',1000,{key:'claim',revision:1,epoch:0});
    const services=createProtocolServices(store,{operatorKey:'isolated operator'}),cap=protocolServiceCapability('isolated operator','observer');
    await services.invoke('enroll',cap,{id:p.request_id,execution:{claim:c.claim_id,epoch:c.epoch,invocation:'inert',scope:'inert-test-execution'}});
    const waiters=createProtocolOwnerWaiters(store);
    waiters.register(p.request_id,'owner',{key:'wait',revision:2,waiter:'local-owner',predicate:'terminal',afterSeq:0,expiresAt:1800000009000});
    store.cancel(p.request_id,'cancel',{key:'cancel',revision:3},'owner');
    await assert.rejects(()=>services.invoke('observe-stop',cap,{id:p.request_id,key:'stop',revision:4,stop:'confirmed',evidence:'trusted-stop'}),/stop_evidence_invalid/);
    assert.equal(services.observation(p.request_id),null);
    const local=waiters.inbox(p.request_id,'owner','local-owner').deliveries[0].delivery;
    const dispatcher=protocolServiceCapability('isolated operator','dispatcher');
    assert.equal((await services.invoke('dispatch',dispatcher,{id:p.request_id,key:'dispatch',delivery:local})).state,'sending');
    assert.equal((await services.invoke('delivery-result',dispatcher,{id:p.request_id,key:'no-ack',delivery:local,outcome:'unknown',receipt:'owner has not acked'})).state,'unknown');
    waiters.ack(p.request_id,'owner','local-owner',local);
    assert.equal((await services.invoke('reconcile',dispatcher,{id:p.request_id,key:'owner-ack',delivery:local,outcome:'found',receipt:'persisted owner ack'})).state,'acknowledged');
    assert.deepEqual(waiters.inbox(p.request_id,'owner','local-owner').deliveries,[]);
  } finally {store.db.close();}
  console.log('PASS private HTTP service roles, native outbox, restart uncertainty, receiver evidence and scoped stop observation; inert protocol proof only');
} finally {await a.close();}
