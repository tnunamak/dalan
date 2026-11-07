import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {createDurableWaiters} from '../src/durable-waiters.mjs';
import {migrateProtocolDelivery,createProtocolDeliveryDriver} from '../src/protocol-delivery-driver.mjs';
const dir=mkdtempSync(join(tmpdir(),'native-delivery-')),file=join(dir,'store.sqlite');
let now=1800000000000,store,driver,waiters;
const authority={},ledger=new Map(),begins=[];
let heldResolve=null;
const open=()=>new Store(file,{now:()=>now});
const transport={
  ledger,
  begin:async e=>{begins.push({...e});},
  async result(e,label){return this.ledger.get(label)??null;},
  async reconcile(e,label){return label==='held'?new Promise(resolve=>{heldResolve=resolve;}):this.ledger.get(label)??null;}
};
function bind() {
  driver=createProtocolDeliveryDriver(store,{authorize:({authority:a})=>a===authority?'dispatcher':null,transport});
  waiters=createDurableWaiters({db:store.db,clock:()=>now,
    authorize:({job,owner})=>store.db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(job)?.owner_hash===owner,
    readEvents:({job,afterSeq})=>store.protocolFacts(job).filter(x=>x.seq>afterSeq).map(x=>({...x,id:job+':'+x.seq,job})),
    predicates:{terminal:e=>e.state==='cancelled'||e.state==='finished'}});
}
function make(id) {
  const p={schema_version:1,request_id:id,brief:'Native delivery test',inputs:[],execution_scope:'read-only',
    expected_output:'result',protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',
      destination:'owner-inbox',retain_until_ms:now+100000}};
  store.submit(p,{mode:'none'},null,'owner',false,null,'normal',null,p,null,'dot','worker');
  store.claim(id,'fixture','subject',20,null,'dot','acq-'+id,1000,
    {key:'claim',revision:store.protocolRevision(id),epoch:0});
  const waiter={job:id,owner:store.db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(id).owner_hash,waiter:'wait-'+id,key:'wait',predicate:'terminal',afterSeq:0,expiresAt:now+90000};
  store.transaction(()=>waiters.register(waiter));
  store.cancel(id,'stop',{key:'cancel',revision:store.protocolRevision(id)},'owner');
  store.transaction(()=>waiters.materialize(waiter));
  const delivery=waiters.inbox(waiter)[0].delivery;
  return {id,waiter,delivery};
}
function snap(id) {
  return JSON.stringify({
    revision:store.protocolRevision(id),facts:store.protocolFacts(id),
    rows:store.db.prepare('SELECT * FROM durable_waiter_deliveries WHERE job=? ORDER BY delivery_id').all(id),
    attempts:store.db.prepare('SELECT * FROM protocol_delivery_attempts WHERE delivery_id IN (SELECT delivery_id FROM durable_waiter_deliveries WHERE job=?)').all(id),
    receipts:store.db.prepare('SELECT * FROM protocol_delivery_receipts WHERE job=? ORDER BY command_key').all(id)});
}
async function nochange(id,fn,re) {const before=snap(id),calls=begins.length;await assert.rejects(fn,re);assert.equal(snap(id),before);assert.equal(begins.length,calls);}
const proof=(envelope,outcome,receipt)=>({envelope:{...envelope},outcome,receipt,authoritative:true});
try {
  store=open();const version=store.db.prepare('PRAGMA user_version').get().user_version;
  store.transaction(()=>migrateProtocolDelivery(store.db));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,version);bind();
  const a=make('delivery-a'),cmd={key:'dispatch-1',delivery:a.delivery};
  await nochange(a.id,()=>driver.dispatch(a.id,{},cmd),/unauthorized/);
  await nochange(a.id,()=>driver.dispatch(a.id,authority,{...cmd,destination:'elsewhere'}),/invalid_input/);
  const domain=JSON.stringify({revision:store.protocolRevision(a.id),facts:store.protocolFacts(a.id)});
  const first=await driver.dispatch(a.id,authority,cmd);
  assert.equal(first.state,'sending');assert.equal(begins.length,1);
  assert.deepEqual(await driver.dispatch(a.id,authority,cmd),first);assert.equal(begins.length,1);
  ledger.set('not-sent',proof(begins[0],'not_sent','not-sent'));
  const retry={key:'result-1',delivery:a.delivery,outcome:'not_sent',receipt:'not-sent'};
  assert.equal((await driver.deliveryResult(a.id,authority,retry)).state,'pending');
  assert.deepEqual(await driver.deliveryResult(a.id,authority,retry),{delivery:a.delivery,state:'pending'});
  await driver.dispatch(a.id,authority,{key:'dispatch-2',delivery:a.delivery});
  assert.equal(begins.length,2);assert.equal(begins[0].delivery,begins[1].delivery);assert.notEqual(begins[0].attempt,begins[1].attempt);
  await nochange(a.id,()=>driver.deliveryResult(a.id,authority,{...retry,key:'delayed'}),/delivery_evidence_invalid/);
  store.db.close();store=open();bind();assert.equal(driver.recover(),1);
  assert.equal(driver.deliveryState(a.delivery).state,'unknown');
  await nochange(a.id,()=>driver.dispatch(a.id,authority,{key:'dispatch-3',delivery:a.delivery}),/DELIVERY_UNKNOWN/);
  ledger.set('unknown',proof(begins[1],'unknown','unknown'));
  assert.equal((await driver.reconcile(a.id,authority,{key:'unknown',delivery:a.delivery,outcome:'unknown',receipt:'unknown'})).state,'unknown');
  store.db.close();store=open();bind();driver.recover();
  await nochange(a.id,()=>driver.dispatch(a.id,authority,{key:'dispatch-4',delivery:a.delivery}),/DELIVERY_UNKNOWN/);
  for(const field of ['job','delivery','destination','bodyDigest','attempt']) {
    ledger.set('bad',{...proof(begins[1],'found','bad'),envelope:{...begins[1],[field]:'wrong'}});
    await nochange(a.id,()=>driver.reconcile(a.id,authority,{key:'bad-'+field,delivery:a.delivery,outcome:'found',receipt:'bad'}),/delivery_evidence_invalid/);
  }
  await nochange(a.id,()=>driver.reconcile(a.id,authority,{key:'bare',delivery:a.delivery,outcome:'found',receipt:'bare'}),/delivery_evidence_invalid/);
  ledger.set('partial',{...proof(begins[1],'not_found','partial'),authoritative:false});
  await nochange(a.id,()=>driver.reconcile(a.id,authority,{key:'partial',delivery:a.delivery,outcome:'not_found',receipt:'partial'}),/delivery_evidence_invalid/);
  ledger.set('found',proof(begins[1],'found','found'));
  const nativeTransaction=store.transaction;
  store.transaction=function(fn){return nativeTransaction.call(this,()=>{const value=fn();if(store.db.prepare('SELECT acknowledged_at FROM durable_waiter_deliveries WHERE delivery_id=?').get(a.delivery).acknowledged_at!==null)throw Error('injected-db-failure');return value;});};
  await nochange(a.id,()=>driver.reconcile(a.id,authority,{key:'rollback',delivery:a.delivery,outcome:'found',receipt:'found'}),/injected-db-failure/);
  store.transaction=nativeTransaction;
  const foundCmd={key:'found',delivery:a.delivery,outcome:'found',receipt:'found'};
  assert.equal((await driver.reconcile(a.id,authority,foundCmd)).state,'acknowledged');
  assert.deepEqual(waiters.inbox(a.waiter),[]);
  assert.deepEqual(await driver.reconcile(a.id,authority,foundCmd),{delivery:a.delivery,state:'acknowledged'});
  assert.equal(JSON.stringify({revision:store.protocolRevision(a.id),facts:store.protocolFacts(a.id)}),domain);
  await nochange(a.id,()=>driver.reconcile(a.id,{},foundCmd),/unauthorized/);
  await nochange(a.id,()=>driver.reconcile(a.id,authority,{...foundCmd,outcome:'unknown'}),/command_conflict/);
  const b=make('delivery-b');
  await driver.dispatch(b.id,authority,{key:'start',delivery:b.delivery});driver.recover();
  const pending=driver.reconcile(b.id,authority,{key:'owner-race',delivery:b.delivery,outcome:'not_found',receipt:'held'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(heldResolve);
  store.transaction(()=>waiters.ack({...b.waiter,delivery:b.delivery}));
  heldResolve(proof(begins.at(-1),'not_found','held'));
  assert.equal((await pending).state,'acknowledged');assert.deepEqual(waiters.inbox(b.waiter),[]);
  now+=100001;
  await assert.rejects(()=>driver.dispatch(a.id,authority,cmd),/tombstone|retention|expired/i);
  console.log('PASS native delivery component retries, uncertainty, evidence, inbox ACK, rollback, retention; integration unqualified');
} finally {store?.db.close();rmSync(dir,{recursive:true,force:true});}
