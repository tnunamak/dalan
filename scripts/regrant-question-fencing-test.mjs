import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';

// Run with Node 24: node scripts/regrant-question-fencing-test.mjs.
// The same assertions fail on the parent: the epoch-1 question stays pending.
// No network, host execution, external credentials, or real delivery.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'regrant-question-'));
const previousHome=process.env.HOME;
process.env.HOME=root;
let serial=0;
function fixture(mode, delivery='t3') {
  const home=path.join(root,String(++serial));fs.mkdirSync(home,{mode:0o700});
  let now=Date.parse('2026-01-01T00:00:00Z');
  const store=new Store(path.join(home,'bridge.sqlite'),{now:()=>now,resumeIdleMs:mode==='idle'?1:0});
  store.limits={...store.limits,leaseMs:60000};
  const id='question-'+serial;
  store.submit({schema_version:1,request_id:id,brief:'Synthetic question fence',
    inputs:[],scope_paths:[],execution_scope:'read-only',expected_output:'Synthetic result'},
    delivery==='t3'?{mode:'t3',threadId:'synthetic-thread'}:{mode:'none'},'synthetic-environment','synthetic-owner');
  const claim=()=>store.claim(id,'synthetic-worker','synthetic-subject',6,null,'dot','acquisition-one');
  const first=claim();
  const question=note=>{
    const c=store.db.prepare('SELECT claim_id FROM claims WHERE request_id=?').get(id);
    store.progress(id,c.claim_id,note,'synthetic-subject');
    return store.db.prepare('SELECT * FROM notifications WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(id);
  };
  const rotate=()=>{
    if(mode==='resume')return store.resume(id,'synthetic-subject');
    if(mode==='reclaim')store.abandon(id);
    return store.claim(id,'synthetic-worker','synthetic-subject',6,null,'dot','acquisition-two');
  };
  return {store,id,first,claim,question,rotate,expire:()=>{now+=60001;},
    row:key=>store.db.prepare('SELECT * FROM notifications WHERE id=?').get(key)};
}
try {
  for(const mode of ['idle','resume','reclaim'])for(const delivery of ['t3','none'])for(const state of ['pending','failed']) {
    const f=fixture(mode,delivery),{store,id}=f;
    try {
      const old=f.question('QUESTION: old worker question');
      assert.equal(JSON.parse(old.body).epoch,1);
      assert.equal(f.row(old.id).state,'pending');
      assert.ok(delivery==='none'||store.due().some(n=>n.id===old.id),'baseline question is eligible');
      const duplicate=f.claim();
      assert.equal(duplicate.claim_id,f.first.claim_id);
      assert.equal(duplicate.duplicate,true);
      assert.equal(f.row(old.id).state,'pending','exact acquisition retry preserves the question');
      store.db.prepare('UPDATE notifications SET state=? WHERE id=?').run(state,old.id);
      f.expire();
      // Give the old question the exact timestamp the new epoch will use.
      // This deliberately disproves any timestamp-only fence.
      store.db.prepare('UPDATE notifications SET created_at=? WHERE id=?').run(store.stamp(),old.id);
      const owner=store.note(id,'Synthetic owner answer remains in history');
      const controls=[
        ['owner-wait','wait',JSON.stringify({note:'owner-origin message'})],
        ['terminal-result','wait',null],
        ['watch-notice','watch',null],
        ['break-notice','break',JSON.stringify({note:'independent break'})],
        ['quiet-break','wait',JSON.stringify({note:'quieted break'})],
      ];
      for(const [suffix,kind,body]of controls)store.db.prepare(
        'INSERT INTO notifications(id,kind,request_id,body,created_at) VALUES(?,?,?,?,?)'
      ).run(id+'-'+suffix,kind,id,body,store.stamp());
      const second=f.rotate();
      assert.equal(second.epoch,2);
      assert.notEqual(second.claim_id,f.first.claim_id);
      assert.equal(f.row(old.id).state,'suppressed','old worker question must retire with the epoch');
      assert.equal(store.startAttempt(old.id,[]),null,'retired item cannot become sending');
      assert.equal(store.due().some(n=>n.id===old.id),false);
      assert.ok(store.ownerNotes(id).some(n=>n.text==='Synthetic owner answer remains in history'));
      for(const [suffix]of controls)assert.equal(f.row(id+'-'+suffix).state,'pending',suffix);
      // Remove only synthetic controls so the waiter positive control is unambiguous.
      for(const [suffix]of controls)store.db.prepare('DELETE FROM notifications WHERE id=?').run(id+'-'+suffix);
      const fresh=f.question('QUESTION: new worker question');
      assert.equal(fresh.created_at,f.row(old.id).created_at);
      assert.equal(JSON.parse(fresh.body).epoch,2);
      assert.equal(f.row(fresh.id).state,'pending');
      const selected=store.claimWaiterDelivery(id,0);
      assert.equal(selected?.id,fresh.id,'new question remains eligible for the owner waiter');
      store.releaseWaiterDelivery(fresh.id);
      assert.ok(store.startAttempt(fresh.id,[]),'new question remains eligible for delivery');
    } finally {store.db.close();}
  }

  for(const mode of ['idle','resume','reclaim'])for(const state of ['sending','uncertain']) {
    const f=fixture(mode);
    try {
      const old=f.question('BLOCKED: reconcile the in-flight question');
      const attempt=f.store.startAttempt(old.id,[]);
      assert.ok(attempt);
      if(state==='uncertain')f.store.finishAttempt(old.id,attempt.attempt_id,'uncertain','synthetic ambiguity');
      f.expire();
      assert.throws(()=>f.rotate(),/uncertain_delivery/);
      assert.equal(f.store.db.prepare('SELECT epoch FROM claims WHERE request_id=?').get(f.id).epoch,1);
      assert.equal(f.row(old.id).state,state,'do not silently discard in-flight effects');
    } finally {f.store.db.close();}
  }

  for(const mode of ['idle','resume','reclaim']) {
    const f=fixture(mode);
    try {
      const old=f.question('QUESTION: rollback must restore me');
      f.expire();
      if(mode==='reclaim')f.store.abandon(f.id);
      const lifecycle=f.store.lifecycle;
      f.store.lifecycle=function(id,type,...args) {
        if(type==='claimed')throw new Error('synthetic failure after rebind');
        return lifecycle.call(this,id,type,...args);
      };
      const rotate=mode==='resume'?()=>f.store.resume(f.id,'synthetic-subject'):
        ()=>f.store.claim(f.id,'synthetic-worker','synthetic-subject',6,null,'dot','acquisition-two');
      assert.throws(rotate,/synthetic failure after rebind/);
      assert.equal(f.store.db.prepare('SELECT epoch FROM claims WHERE request_id=?').get(f.id).epoch,1);
      assert.equal(f.row(old.id).state,'pending','epoch update and question retirement must roll back together');
      f.store.lifecycle=lifecycle;
      assert.equal(rotate().epoch,2);
      assert.equal(f.row(old.id).state,'suppressed');
    } finally {f.store.db.close();}
  }
  console.log('regrant question fencing: PASS');
} finally {
  if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
  fs.rmSync(root,{recursive:true,force:true});
}
