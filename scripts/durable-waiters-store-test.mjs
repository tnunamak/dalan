// Node24. Real Store lifecycle facts; no synthesized protocol events.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {migrateDurableWaiters,createDurableWaiters} from '../src/durable-waiters.mjs';
const dir=mkdtempSync(join(tmpdir(),'waiter-native-')),file=join(dir,'store.sqlite');
let now=Date.UTC(2026,0,1),store;
try {
  const open=()=>new Store(file,{now:()=>now});
  store=open();
  const payload={schema_version:1,request_id:'native-waiters',brief:'Offline waiter regression',
    inputs:[],execution_scope:'read-only',expected_output:'fixture'};
  const owner='fixture-owner',subject='fixture-subject',job=payload.request_id;
  store.submit(payload,{mode:'none'},null,owner,false,null,'normal',null,payload,null,'dot','worker');
  const claim=store.claim(job,'fixture',subject,10,null,'dot','waiter-acquisition',10000);
  const schema=store.db.prepare('PRAGMA user_version').get().user_version;
  store.transaction(()=>migrateDurableWaiters(store.db));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,schema);
  const events=()=>store.db.prepare('SELECT rowid AS native_seq,* FROM lifecycle_events WHERE request_id=? ORDER BY rowid').all(job);
  // Identity and sequence derive only from durable native rows, never timestamps.
  // Keep native type/reason; do not rename notes into answers or ACK into consumed.
  const readEvents=({job,afterSeq})=>store.db.prepare('SELECT rowid AS native_seq,* FROM lifecycle_events WHERE request_id=? AND rowid>? ORDER BY rowid')
    .all(job,afterSeq).map(row=>({id:'native-lifecycle:'+row.native_seq,job:row.request_id,seq:row.native_seq,native:{...row}}));
  const create=()=>createDurableWaiters({db:store.db,clock:()=>now,
    authorize:c=>{try{store.owner(c.job,c.owner);return true;}catch{return false;}},
    readEvents,predicates:{
      terminal:e=>e.native.type==='completed'||e.native.type==='cancelled',
      question:e=>e.native.type==='waiting'&&e.native.reason?.startsWith('question:ask:')===true,
      answer:e=>e.native.type==='waiting'&&e.native.reason?.startsWith('question:answer:')===true
    }});
  let waiters=create();
  const cursor=events().at(-1).native_seq,deadline=now+500;
  const a={job,owner,waiter:'A',key:'register-A',predicate:'terminal',afterSeq:cursor,expiresAt:deadline};
  const b={...a,waiter:'B',key:'register-B'};
  const q={...a,waiter:'Q',key:'register-Q',predicate:'question'};
  const answer={...a,waiter:'ANSWER',key:'register-answer',predicate:'answer'};
  for(const w of [a,b,q,answer])store.transaction(()=>waiters.register(w));
  assert.deepEqual(store.transaction(()=>waiters.register(a)),a);
  assert.throws(()=>store.transaction(()=>waiters.register({...a,afterSeq:0})),/registration_conflict/);
  store.progress(job,claim.claim_id,'Working on fixture',subject,false,'dot');
  store.askQuestion(job,claim.claim_id,'q1','Which fixture?',subject,'dot');
  store.transaction(()=>{waiters.materialize(a);waiters.materialize(q);});
  assert.equal(waiters.inbox(a).length,0);
  assert.equal(waiters.inbox(q).length,1);
  const beforeNote=events();
  store.owner(job,owner);store.note(job,'Ordinary owner note, not a structured answer.');
  assert.deepEqual(events(),beforeNote,'ordinary note must not be invented as answer lifecycle');
  store.transaction(()=>waiters.materialize(answer));
  assert.deepEqual(waiters.inbox(answer),[]);
  store.owner(job,owner);store.answerQuestion(job,'q1','Fixture A');
  store.transaction(()=>waiters.materialize(answer));
  assert.equal(waiters.inbox(answer).length,1);
  store.consumeAnswer(job,claim.claim_id,'q1',subject,'dot');
  const beforeFinish=events();
  assert.throws(()=>store.transaction(()=>{
    store.finishOnce(job,claim.claim_id,'completed','fixture','native result',subject,null,'dot');
    waiters.materialize(a);waiters.materialize(b);
    throw Error('rollback-finish-and-inboxes');
  }),/rollback-finish-and-inboxes/);
  assert.deepEqual(events(),beforeFinish);
  assert.equal(store.get(job).report,null);
  assert.deepEqual(waiters.inbox(a),[]);
  const result=store.transaction(()=>{
    const done=store.finishOnce(job,claim.claim_id,'completed','fixture','native result',subject,null,'dot');
    assert.equal(waiters.materialize(a).added,1);
    assert.equal(waiters.materialize(b).added,1);
    return done;
  });
  const [da]=waiters.inbox(a),[db]=waiters.inbox(b);
  assert.equal(da.eventId,db.eventId);assert.notEqual(da.delivery,db.delivery);
  const nativeCompleted=events().find(e=>e.type==='completed');
  assert.equal(da.eventSeq,nativeCompleted.native_seq);
  assert.deepEqual(da.fact.native,{...nativeCompleted});
  assert.equal(store.get(job).report.receipt_id,result.receipt_id);
  const nativeBeforeAck=JSON.stringify({events:events(),report:store.get(job).report,delivery:store.get(job).delivery});
  assert.throws(()=>store.transaction(()=>waiters.ack({...a,delivery:db.delivery})),/delivery_not_found/);
  const ack=store.transaction(()=>waiters.ack({...a,delivery:da.delivery}));
  assert.deepEqual(store.transaction(()=>waiters.ack({...a,delivery:da.delivery})),ack);
  assert.equal(waiters.inbox(a).length,0);assert.equal(waiters.inbox(b).length,1);
  assert.equal(JSON.stringify({events:events(),report:store.get(job).report,delivery:store.get(job).delivery}),nativeBeforeAck);
  assert.equal(events().some(e=>e.type==='consumed'),false,'waiter ACK is not native job consumption');
  store.db.close();store=open();waiters=create();
  assert.equal(waiters.inbox(a).length,0);assert.equal(waiters.inbox(b).length,1);
  assert.throws(()=>waiters.inbox({...b,owner:'wrong-owner'}),/unauthorized/);
  const atEnd={...a,waiter:'AFTER',key:'after-result',afterSeq:nativeCompleted.native_seq};
  store.transaction(()=>waiters.register(atEnd));
  assert.equal(store.transaction(()=>waiters.materialize(atEnd)).added,0);
  now=deadline;
  assert.throws(()=>store.transaction(()=>waiters.register({...a,waiter:'EXPIRED',key:'expired'})),/waiter_expired/);
  assert.deepEqual(store.transaction(()=>waiters.materialize(b)),{expired:true,added:0});
  assert.equal(waiters.inbox(b).length,1,'expiry preserves committed pending delivery');
  assert.throws(()=>store.transaction(()=>{
    waiters.ack({...b,delivery:db.delivery});throw Error('rollback-ack');
  }),/rollback-ack/);
  assert.equal(waiters.inbox(b).length,1);
  console.log('real Store durable waiter component integration passed; HTTP/T36 unqualified');
} finally {store?.db.close();rmSync(dir,{recursive:true,force:true});}

await import('./protocol-delivery-driver-test.mjs');
