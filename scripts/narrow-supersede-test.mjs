#!/usr/bin/env node
// Groups 1-9: public operations only; the real Store constructor owns the schema.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { competingWrites } from './store-competing-writers.mjs';

const ownerR='synthetic-owner-R', ownerT='synthetic-owner-T', ownerU='synthetic-owner-U';
const R='req_sup_source', T='req_sup_target', U='req_sup_control', X='req_sup_existing';
const payload=id=>({schema_version:1,request_id:id,brief:'narrow supersede fixture',inputs:[],expected_output:'one report',execution_scope:'read-only'});
const args=(id,owner,option=null,key=null,p=payload(id),{priority='normal',maxQueued=null,targetWorker=undefined}={})=>[p,{mode:'none'},null,owner,false,null,priority,{source:'agent'},p,maxQueued,targetWorker,null,'host',null,null,key,option];
const submit=(s,id,owner,options)=>s.submit(...args(id,owner,null,null,payload(id),options));
const replace=(s,id,owner,target,token,key=null,p=payload(id),options)=>s.submit(...args(id,owner,{target_id:target,target_token:token},key,p,options));
const snapshot=(s,id)=>structuredClone(s.get(id));
const absent=(s,id)=>assert.equal(s.hasAssignment(id),false,'refused source must remain absent');
const same=(s,id,before)=>assert.deepEqual(snapshot(s,id),before);
async function fixture(run,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'dalan-narrow-supersede-'));
  let now=Date.parse('2026-11-02T09:00:00Z');
  const db=join(dir,'bridge.db');
  const c={db,s:new Store(db,{...options,now:()=>now}),advance:()=>{now+=1000;},
    reopen(){this.s.db.close();this.s=new Store(db,{...options,now:()=>now});},
    native:()=>({profile:'job-v0',source:'test-source',scope:'test-scope',policy:'test-policy',destination:'test-destination',retain_until_ms:now+86400000}),
    subscribe(){this.s.subscribe('synthetic-sub','http://127.0.0.1:9/never-delivered','synthetic-signing-key',new Date(now+86400000).toISOString());}};
  try {await run(c);} finally {c.s.db.close();rmSync(dir,{recursive:true,force:true});}
}
function refuses(s,id,invoke,error,ids=[T,U]) {
  const before=ids.filter(x=>s.hasAssignment(x)).map(x=>[x,snapshot(s,x)]);
  assert.throws(invoke,error);
  absent(s,id);
  for(const [x,row] of before)same(s,x,row);
}

async function group1() {await fixture(async c=>{
  const s=c.s;submit(s,T,ownerT);submit(s,U,ownerU);
  for(const token of [undefined,'wrong-target',ownerU])
    refuses(s,R,()=>replace(s,R,ownerR,T,token),/^Error: invalid owner capability$/);
  const receipt=replace(s,R,ownerR,T,ownerT);assert.equal(receipt.duplicate,false);
  const rows=[R,T,U].map(id=>[id,snapshot(s,id)]);
  for(const token of ['', 'wrong-source'])
    assert.throws(()=>replace(s,R,token,T,ownerT),/^Error: invalid owner capability$/);
  for(const token of [undefined,'wrong-target',ownerU])
    assert.throws(()=>replace(s,R,ownerR,T,token),/^Error: invalid owner capability$/);
  for(const [id,row] of rows)same(s,id,row);
  submit(s,X,ownerU);const x=snapshot(s,X);
  assert.throws(()=>replace(s,X,ownerR,U,ownerU),/^Error: invalid owner capability$/);
  same(s,X,x);for(const [id,row] of rows)same(s,id,row);
});}

async function group2() {for(const key of [null,'replacement-command'])await fixture(async c=>{
  c.subscribe();let s=c.s;submit(s,T,ownerT);submit(s,U,ownerU);
  const beforeT=snapshot(s,T),beforeU=snapshot(s,U);
  assert.ok(beforeT.delivery.some(n=>n.state==='pending'));
  let calls=0;const cancel=s.cancelInTransaction;
  s.cancelInTransaction=function(...a){calls++;return cancel.apply(this,a);};
  const receipt=replace(s,R,ownerR,T,ownerT,key);
  assert.deepEqual([receipt.status,receipt.duplicate],['queued',false]);
  const target=snapshot(s,T),source=snapshot(s,R);
  assert.equal(target.status,'cancelled');assert.ok(target.cancelled_at);
  assert.equal(target.cancellation_requested,true);assert.equal(target.authority_revoked,true);
  assert.deepEqual(target.assignment,beforeT.assignment);
  assert.deepEqual(source.supersedes,{request_id:T,created_at:target.superseded_by.created_at});
  assert.deepEqual(target.superseded_by,{request_id:R,created_at:source.supersedes.created_at});
  assert.equal(source.superseded_by,null);assert.equal(target.supersedes,null);
  assert.ok(source.supersedes.created_at);
  assert.equal(source.status,'queued');
  for(const ref of [source.supersedes,target.superseded_by])
    for(const token of [ownerR,ownerT,ownerU])assert.ok(!JSON.stringify(ref).includes(token));
  assert.deepEqual(target.delivery.map(n=>n.id),beforeT.delivery.map(n=>n.id));
  assert.ok(target.delivery.every(n=>n.state==='suppressed'));same(s,U,beforeU);
  c.advance();assert.deepEqual(replace(s,R,ownerR,T,ownerT,key),{...receipt,duplicate:true});
  assert.equal(calls,1);same(s,T,target);same(s,R,source);
  c.reopen();s=c.s;
  assert.deepEqual(replace(s,R,ownerR,T,ownerT,key),{...receipt,duplicate:true});
  same(s,T,target);same(s,R,source);same(s,U,beforeU);
  const conflict=key?/KEY_CONFLICT: command intent changed/:/request_id conflict/;
  for(const invoke of [
    ()=>replace(s,R,ownerR,U,ownerU,key),
    ()=>s.submit(...args(R,ownerR,null,key)),
    ()=>replace(s,R,ownerR,T,ownerT,key,{...payload(R),brief:'changed source'})
  ]){assert.throws(invoke,conflict);same(s,T,target);same(s,R,source);same(s,U,beforeU);}
  if(key) {
    assert.throws(()=>replace(s,R,ownerR,T,ownerT,'different-key'),/EXISTS:/);
    assert.throws(()=>replace(s,R,ownerR,T,ownerT),/EXISTS:/);
  }
  assert.throws(()=>s.claim(T,'supersede-worker'),/assignment cancelled/);
  assert.ok(!s.get(T).claim);
  assert.ok(!s.listPending().some(row=>row.request_id===T));
  assert.ok(s.claim(R,'supersede-worker').claim_id);
});}

async function group3() {for(const key of [null,'rollback-command'])await fixture(async c=>{
  c.subscribe();let s=c.s;submit(s,T,ownerT);submit(s,U,ownerU);
  const target=snapshot(s,T),control=snapshot(s,U);
  const original=s.cancelInTransaction;let calls=0;
  s.cancelInTransaction=function(id,reason){
    const result=original.call(this,id,reason);
    if(id===T){calls++;throw new Error('injected_after_real_cancel');}
    return result;
  };
  try {assert.throws(()=>replace(s,R,ownerR,T,ownerT,key),/^Error: injected_after_real_cancel$/);}
  finally {s.cancelInTransaction=original;}
  assert.equal(calls,1);absent(s,R);same(s,T,target);same(s,U,control);
  c.reopen();s=c.s;absent(s,R);same(s,T,target);same(s,U,control);
  assert.equal(replace(s,R,ownerR,T,ownerT,key).duplicate,false);
  assert.equal(s.get(T).status,'cancelled');
});}

async function group4() {
  for(const state of ['queued','claimed','progress','finished','cancelled','missing','native-target','native-source','abandoned'])
    await fixture(async c=>{
      const s=c.s;submit(s,U,ownerU);let claim;
      if(state!=='missing') {
        const p=state==='native-target'?{...payload(T),protocol:c.native()}:payload(T);
        s.submit(...args(T,ownerT,null,null,p));
      }
      if(['claimed','progress','finished','abandoned'].includes(state)){
        claim=s.claim(T,'supersede-worker');assert.equal(s.get(T).status,'claimed');
        assert.equal(s.get(T).claim.state,'active');assert.equal(s.get(T).compute_stopped,false);
      }
      if(state==='progress')s.progress(T,claim.claim_id,'still working');
      if(state==='finished')s.finish(T,claim.claim_id,'completed','original report','original result');
      if(state==='cancelled')s.cancel(T);
      if(state==='abandoned'){s.abandon(T);assert.equal(s.get(T).status,'queued');assert.equal(s.get(T).compute_stopped,false);}
      const p=state==='native-source'?{...payload(R),protocol:c.native()}:payload(R);
      if(state==='queued'){assert.equal(replace(s,R,ownerR,T,ownerT).duplicate,false);return;}
      const native=state==='native-target'||state==='native-source';
      const error=native?/^Error: supersede_native_unsupported$/:state==='missing'?/^Error: supersede_target_not_found$/:/^Error: supersede_target_not_queued$/;
      const revision=state==='native-target'?s.protocolRevision(T):null;
      const facts=state==='native-target'?s.protocolFacts(T):null;
      if(state==='native-target')assert.equal(s.isProtocolJob(T),true);
      refuses(s,R,()=>replace(s,R,ownerR,T,ownerT,null,p),error);
      if(state==='native-target'){assert.equal(s.protocolRevision(T),revision);assert.deepEqual(s.protocolFacts(T),facts);}
      if(['claimed','progress'].includes(state)){
        s.progress(T,claim.claim_id,'original claim remains usable');
        assert.ok(s.finish(T,claim.claim_id,'completed','legitimate finish','original authority').receipt_id);
      }
    });
  for(const claimFirst of [true,false])await fixture(async c=>{
    const s=c.s;submit(s,T,ownerT);submit(s,U,ownerU);const control=snapshot(s,U);
    const claim={method:'claim',args:[T,'race-worker']};
    const replacement={method:'submit',args:args(R,ownerR,{target_id:T,target_token:ownerT})};
    const operations=claimFirst?[claim,replacement]:[replacement,claim];
    operations[0].holdMs=250;
    const results=await competingWrites(c.db,operations,{firstHoldsLock:true});
    if(claimFirst){
      assert.ok(results[0].result?.claim_id);assert.match(results[1].error,/supersede_target_not_queued/);
      absent(s,R);assert.equal(s.get(T).status,'claimed');assert.equal(s.get(T).cancelled_at,null);
      s.progress(T,results[0].result.claim_id,'race winner retains authority');
    }else{
      assert.equal(results[0].result?.duplicate,false);assert.match(results[1].error,/assignment cancelled/);
      assert.equal(s.get(T).status,'cancelled');assert.ok(!s.get(T).claim);
    }
    same(s,U,control);
  });
}

async function group5() {await fixture(async c=>{
  const s=c.s;submit(s,U,ownerU);
  refuses(s,R,()=>replace(s,R,ownerR,R,ownerR),/^Error: supersede_cycle$/,[U]);
  const A='req_sup_cycle_a',B='req_sup_cycle_b',C='req_sup_cycle_c';
  submit(s,A,ownerT);replace(s,B,ownerR,A,ownerT);
  const a=snapshot(s,A),b=snapshot(s,B),u=snapshot(s,U);
  assert.throws(()=>replace(s,A,ownerT,B,ownerR),/request_id conflict/);
  same(s,A,a);same(s,B,b);same(s,U,u);
  replace(s,C,ownerU,B,ownerR);
  const rows=[A,B,C,U].map(id=>[id,snapshot(s,id)]);
  assert.throws(()=>replace(s,A,ownerT,C,ownerU),/request_id conflict/);
  for(const [id,row] of rows)same(s,id,row);
});}

const capOptions=cap=>({priority:cap==='background'?'background':'normal',maxQueued:cap==='queued'?2:null});
const capError=cap=>cap==='background'?/^Error: background_capacity_full$/:/^Error: worker queue is full \(2 queued, in-flight cap 2\)$/;
const queued=s=>s.listPending().filter(row=>row.kind==='assignment').map(row=>row.request_id).sort();

// At each exact cap a replacement keeps the counted population unchanged; a new submit cannot.
async function group6() {for(const cap of ['queued','background'])for(const claimControl of cap==='background'?[false,true]:[false])
  await fixture(async c=>{
    const s=c.s,options=capOptions(cap);submit(s,T,ownerT,options);submit(s,U,ownerU,options);
    if(claimControl)s.claim(U,'supersede-worker');
    const counts=s.status().priority_counts,control=snapshot(s,U),before=queued(s);
    assert.deepEqual(counts[options.priority],{queued:claimControl?1:2,claimed:claimControl?1:0});
    refuses(s,X,()=>submit(s,X,ownerR,options),capError(cap));
    const receipt=replace(s,R,ownerR,T,ownerT,null,payload(R),options);
    assert.deepEqual([receipt.status,receipt.duplicate],['queued',false]);
    assert.equal(s.get(T).status,'cancelled');assert.equal(s.get(R).status,'queued');same(s,U,control);
    assert.deepEqual(queued(s),before.map(id=>id===T?R:id).sort());
    assert.deepEqual(s.status().priority_counts,counts,'replacement must not change either capacity population');
    refuses(s,X,()=>submit(s,X,ownerR,options),capError(cap),[R,T,U]);
  },{backgroundMaxInFlight:2});
}

// Validation must win over either capacity error and leave all original state intact.
async function group7() {for(const cap of ['queued','background'])for(const state of ['wrong-token','claimed'])
  await fixture(async c=>{
    const s=c.s,options=capOptions(cap);submit(s,T,ownerT,options);
    if(state==='claimed')s.claim(T,'supersede-worker');
    submit(s,U,ownerU,options);
    if(state==='claimed'&&cap==='queued')submit(s,X,ownerU,options);
    const counts=s.status().priority_counts,before=queued(s);
    assert.equal(cap==='queued'?before.length:counts.background.queued+counts.background.claimed,2);
    const token=state==='wrong-token'?'wrong-target':ownerT;
    const error=state==='wrong-token'?/^Error: invalid owner capability$/:/^Error: supersede_target_not_queued$/;
    refuses(s,R,()=>replace(s,R,ownerR,T,token,null,payload(R),options),error,[T,U,X]);
    assert.deepEqual(queued(s),before);assert.deepEqual(s.status().priority_counts,counts);
  },{backgroundMaxInFlight:2});
}

// A valid target grants no room in a count it does not belong to.
async function group8() {for(const cap of ['queued','background'])
  for(const outside of cap==='queued'?['other-worker','expired']:['other-worker','expired','normal-priority'])
    await fixture(async c=>{
      const s=c.s,options=capOptions(cap),targetOptions={...options};
      if(outside==='other-worker')targetOptions.targetWorker='other-worker';
      if(outside==='normal-priority')targetOptions.priority='normal';
      const targetPayload=outside==='expired'?{...payload(T),valid_until:'2026-11-02T08:59:59Z'}:payload(T);
      s.submit(...args(T,ownerT,null,null,targetPayload,targetOptions));
      submit(s,U,ownerU,options);submit(s,X,ownerU,options);
      assert.deepEqual(queued(s).filter(id=>id!==T),[U,X].sort());
      const counts=s.status().priority_counts,before=queued(s);
      refuses(s,R,()=>replace(s,R,ownerR,T,ownerT,null,payload(R),options),capError(cap),[T,U,X]);
      assert.deepEqual(queued(s),before);assert.deepEqual(s.status().priority_counts,counts);
    },{backgroundMaxInFlight:2});
}

// The total queue cap spans priorities: a background target still frees its normal replacement's slot.
async function group9() {await fixture(async c=>{
  const s=c.s,options=capOptions('queued');submit(s,T,ownerT,{...options,priority:'background'});submit(s,U,ownerU,options);
  const control=snapshot(s,U);assert.equal(queued(s).length,2);
  assert.equal(replace(s,R,ownerR,T,ownerT,null,payload(R),options).duplicate,false);
  assert.deepEqual(queued(s),[R,U].sort());assert.equal(s.get(T).status,'cancelled');same(s,U,control);
  assert.deepEqual(s.status().priority_counts,{normal:{queued:2,claimed:0},background:{queued:0,claimed:0}});
});}

let failed=0;
for(const group of [group1,group2,group3,group4,group5,group6,group7,group8,group9]){
  try {await group();console.log('PASS '+group.name);}
  catch(error){failed++;console.error('FAIL '+group.name,error);}
}
if(failed)process.exitCode=1;
