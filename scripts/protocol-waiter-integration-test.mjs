// Node24, actual immutable Store lifecycle rows. HTTP wiring remains the parent's task.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {DatabaseSync} from 'node:sqlite';
import {migrateDurableWaiters,createDurableWaiters} from '../src/durable-waiters.mjs';
const directory=mkdtempSync(join(tmpdir(),'native-waiter-cursor-')),file=join(directory,'isolated.sqlite');
let now=Date.UTC(2026,0,1),store;
const token='only-in-test-owner-capability',owner=createHash('sha256').update(token).digest('hex'),job='cursor-job';
const payload={schema_version:1,request_id:job,brief:'Native waiter cursor test',inputs:[],execution_scope:'read-only',expected_output:'fixture'};
try {
  const open=()=>new Store(file,{now:()=>now});
  store=open();store.submit(payload,{mode:'none'},null,token,false,null,'normal',null,payload,null,'dot','worker');
  const claim=store.claim(job,'fixture','subject',10,null,'dot','acquisition',10000);
  // Upgrade a genuine old component table separately from the current Store.
  const oldDb=new DatabaseSync(':memory:');
  try {
    oldDb.exec(`BEGIN; CREATE TABLE durable_waiters(
      job TEXT NOT NULL,owner TEXT NOT NULL,waiter TEXT NOT NULL,command_key TEXT NOT NULL,
      predicate TEXT NOT NULL,after_seq INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      PRIMARY KEY(job,owner,waiter),UNIQUE(job,owner,command_key));`);
    oldDb.prepare('INSERT INTO durable_waiters VALUES(?,?,?,?,?,?,?)').run(job,owner,'old','old','terminal',1,now+1000);
    migrateDurableWaiters(oldDb);migrateDurableWaiters(oldDb);oldDb.exec('COMMIT');
    assert.equal(oldDb.prepare("SELECT scan_seq FROM durable_waiters WHERE waiter='old'").get().scan_seq,1);
  } finally {oldDb.close();}
  const schema=store.db.prepare('PRAGMA user_version').get().user_version;
  store.transaction(()=>{migrateDurableWaiters(store.db);migrateDurableWaiters(store.db);});
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,schema);
  const cursor=w=>store.db.prepare('SELECT scan_seq FROM durable_waiters WHERE job=? AND owner=? AND waiter=?').get(job,owner,w).scan_seq;
  const native=({job,afterSeq})=>store.db.prepare('SELECT rowid AS native_seq,* FROM lifecycle_events WHERE request_id=? AND rowid>? ORDER BY rowid')
    .all(job,afterSeq).map(row=>({id:'lifecycle:'+row.native_seq,job:row.request_id,seq:row.native_seq,native:{...row}}));
  const requested=[];let invalid=false;
  const create=()=>createDurableWaiters({db:store.db,clock:()=>now,
    authorize:c=>c.owner===owner&&store.db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(c.job)?.owner_hash===owner,
    readEvents:q=>{requested.push(q.afterSeq);const rows=native(q);return invalid?[...rows,{id:'invalid-fixture',job,seq:(rows.at(-1)?.seq??q.afterSeq)+1,bad:undefined}]:rows;},
    predicates:{terminal:e=>['completed','cancelled'].includes(e.native?.type),all:()=>true}});
  let waiters=create();
  const a={job,owner,waiter:'A',key:'A',predicate:'terminal',afterSeq:0,expiresAt:now+1000},b={...a,waiter:'B',key:'B'};
  for(const w of [a,b])store.transaction(()=>waiters.register(w));
  store.progress(job,claim.claim_id,'Working on real fixture','subject',false,'dot');
  store.transaction(()=>waiters.materialize(a));
  assert.equal(waiters.inbox(a).length,0);
  const before=cursor('A');assert.ok(before>0);
  assert.deepEqual(store.transaction(()=>waiters.register(a)),a,'scan does not change registration identity');
  store.transaction(()=>waiters.materialize(a));assert.equal(requested.at(-1),before);
  assert.throws(()=>store.transaction(()=>{
    store.finishOnce(job,claim.claim_id,'completed','done','native result','subject',null,'dot');
    invalid=true;
    try{waiters.materialize(a);}finally{invalid=false;}
  }),/invalid_native_event/);
  assert.equal(cursor('A'),before);assert.deepEqual(waiters.inbox(a),[]);assert.equal(store.get(job).report,null);
  const receipt=store.transaction(()=>{
    const result=store.finishOnce(job,claim.claim_id,'completed','done','native result','subject',null,'dot');
    waiters.materialize(a);waiters.materialize(b);return result;
  });
  const [da]=waiters.inbox(a),[db]=waiters.inbox(b);
  assert.equal(da.eventId,db.eventId);assert.notEqual(da.delivery,db.delivery);
  assert.equal(da.fact.native.type,'completed');assert.equal(store.get(job).report.receipt_id,receipt.receipt_id);
  const end=cursor('A');assert.equal(end,cursor('B'));
  store.transaction(()=>waiters.ack({...a,delivery:da.delivery}));
  assert.equal(waiters.inbox(a).length,0);assert.equal(waiters.inbox(b).length,1);
  store.db.close();store=open();waiters=create();
  assert.deepEqual(store.transaction(()=>waiters.register(a)),a);
  store.transaction(()=>waiters.materialize(a));assert.equal(requested.at(-1),end);
  assert.equal(cursor('A'),end);assert.equal(waiters.inbox(b).length,1);
  assert.throws(()=>waiters.inbox({...b,owner:'wrong-hash'}),/unauthorized/);
  assert.throws(()=>store.transaction(()=>waiters.ack({...a,delivery:db.delivery})),/delivery_not_found/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM durable_waiters WHERE owner=?').get(token).n,0);
  now=a.expiresAt;
  assert.deepEqual(store.transaction(()=>waiters.materialize(b)),{expired:true,added:0});
  assert.equal(waiters.inbox(b).length,1);assert.equal(cursor('B'),end);
  console.log('Native waiter cursor assertions passed; no HTTP/T36 claim');
} finally {store?.db.close();rmSync(directory,{recursive:true,force:true});}
