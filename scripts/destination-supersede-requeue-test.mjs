#!/usr/bin/env node
// Combined Store contracts: destination approval, supersede, and learned expiry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import * as workerConfig from '../src/workers.mjs';

const MIN=60000;
const declaration=(provider='Provider A')=>({operator:'Fixture operator',provider,
  data_categories:['assignment','results'],retention:'30 days',training:'not used',terms:'Terms v1'});
const profile=(provider='Provider A')=>workerConfig.parseWorkers({
  default_execution:'worker',workers:{alpha:{connections:[],repos:['acme/project'],
    guidance:'resume',destination:declaration(provider)}},
},{builtin:true,builtinConnectionIds:()=>['fixture-connection']});
const assignment=id=>({schema_version:1,request_id:id,brief:'combined destination fixture',
  inputs:[],expected_output:'fixture',execution_scope:'read-only'});
const disclose=(f,id)=>workerConfig.destinationDisclosure(f.current,'alpha','worker',assignment(id));
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'destination-supersede-requeue-'));
  let current=profile(),now=Date.parse('2026-11-02T09:00:00.000Z');
  const file=path.join(dir,'bridge.db');
  const options={workers:current,destinationProfile:()=>current,now:()=>now};
  let store=new Store(file,options);
  t.after(()=>{store.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},get current(){return current;},get now(){return now;},
    set:p=>{current=p;},clock:ms=>{now+=ms;},
    reopen(){store.db.close();store=new Store(file,options);}};
}
function submit(f,id,{revision=disclose(f,id).revision,key=null,target=null,deadline=null,extra={}}={}) {
  const a={...assignment(id),...extra};
  return f.store.submit(a,{mode:'none'},'','owner',false,null,'normal',{source:'agent'},
    a,null,'alpha','worker','worker',null,deadline,key,
    target===null?null:{target_id:target,target_token:'owner'},revision);
}
const claim=(f,id)=>f.store.claim(id,'run-'+id,'subject',100,null,'alpha','acq-'+id,10);
const snapshot=(f,id)=>structuredClone(f.store.get(id));
function refusal(fn,code) {
  let error;try {fn();} catch(e) {error=e;}
  assert.ok(error,'expected destination refusal');
  assert.equal(error.destination?.error,code,error.message);
  return error.destination;
}

test('supersede command retry retains target and approval, including after reopen and drift',t=>{
  const f=fixture(t),target='req_combined_old',id='req_combined_retry',other='req_combined_other';
  submit(f,target);submit(f,other);
  const revision=disclose(f,id).revision;
  const options={revision,key:'combined-command',target};
  const first=submit(f,id,options),old=snapshot(f,target),source=snapshot(f,id),control=snapshot(f,other);
  assert.equal(first.duplicate,false);
  assert.equal(first.destination_approval.revision,revision);
  assert.equal(old.status,'cancelled');
  assert.equal(source.supersedes.request_id,target);
  assert.equal(old.superseded_by.request_id,id);
  assert.equal(source.supersedes.created_at,old.superseded_by.created_at);
  f.clock(1000);f.set(profile('Provider B'));
  for(const reopen of [false,true]) {
    if(reopen)f.reopen();
    assert.deepEqual(submit(f,id,options),{...first,duplicate:true});
    for(const changed of [disclose(f,id).revision,null]) {
      assert.throws(()=>submit(f,id,{...options,revision:changed}),/destination approval conflict/);
    }
    // The key binds the target as well as the destination approval.
    for(const changedTarget of [other,null]) {
      assert.throws(()=>submit(f,id,{...options,target:changedTarget}),/KEY_CONFLICT: command intent changed/);
    }
    assert.deepEqual(snapshot(f,target),old);
    assert.deepEqual(snapshot(f,id),source);
    assert.deepEqual(snapshot(f,other),control);
  }
});

for(const changed of [false,true]) test('learned expiry requeue preserves approval with destination '+(changed?'changed':'unchanged'),t=>{
  const f=fixture(t),id='req_combined_requeue';
  // Five zero-wait claims for alpha/read-only yield the same 15-minute floor as the expiry fixture.
  for(let i=0;i<5;i++) {
    const seed='req_combined_seed_'+i;
    submit(f,seed,{extra:{valid_until:new Date(f.now+60*MIN).toISOString()}});
    assert.ok(claim(f,seed).claim_id);
  }
  const learned=f.store.defaultValidUntil('alpha','read-only');
  assert.equal(learned.source,'queue_p90');
  assert.equal(learned.window_ms,15*MIN);
  const first=submit(f,id,{deadline:learned.valid_until}),before=snapshot(f,id);
  assert.equal(before.valid_until_source,'queue_p90');
  assert.equal(before.expiry_requeues,0);
  assert.ok(!before.claim);
  if(changed)f.set(profile('Provider B'));
  f.clock(16*MIN);
  const swept=f.store.sweepExpired(),after=snapshot(f,id);
  assert.ok(swept.requeued.includes(id));
  assert.ok(!swept.includes(id));
  assert.equal(after.status,'queued');
  assert.equal(after.cancelled_reason,null);
  assert.equal(after.expiry_requeues,1);
  assert.equal(after.valid_until,new Date(f.now+15*MIN).toISOString());
  assert.ok(after.lifecycle_events.some(e=>e.type==='queued'&&e.actor==='system'&&e.reason==='expired_requeued'));
  assert.deepEqual(after.destination_approval,first.destination_approval);
  assert.ok(!after.claim);
  f.reopen();
  assert.deepEqual(snapshot(f,id).destination_approval,first.destination_approval);
  if(changed) {
    const denied=refusal(()=>claim(f,id),'destination_changed');
    assert.equal(denied.approved_revision,first.destination_approval.revision);
    assert.equal(denied.current_revision,disclose(f,id).revision);
    assert.notEqual(denied.current_revision,denied.approved_revision);
    assert.equal(snapshot(f,id).status,'queued');
    assert.ok(!snapshot(f,id).claim,'drift must grant no first epoch after requeue');
    assert.deepEqual(snapshot(f,id).destination_approval,first.destination_approval);
    // Restoring R proves the refreshed job itself remains claimable.
    f.set(profile());
  }
  const granted=claim(f,id);
  assert.ok(granted.claim_id);
  assert.equal(granted.destination_revision,first.destination_approval.revision);
  assert.equal(snapshot(f,id).claim.destination_revision,first.destination_approval.revision);
  assert.equal(snapshot(f,id).expiry_requeues,1);
});

test('successor requires its own approval and cannot inherit the cancelled target revision',t=>{
  const f=fixture(t),target='req_combined_parent',id='req_combined_child';
  const parent=submit(f,target),before=snapshot(f,target);
  f.clock(1000);f.set(profile('Provider B'));
  const own=disclose(f,id);
  assert.notEqual(own.revision,parent.destination_approval.revision);
  for(const [revision,code] of [[null,'destination_approval_required'],
    [parent.destination_approval.revision,'destination_changed']]) {
    refusal(()=>submit(f,id,{target,revision}),code);
    assert.equal(f.store.hasAssignment(id),false);
    assert.deepEqual(snapshot(f,target),before,'failed successor approval must not cancel its target');
  }
  const child=submit(f,id,{target,revision:own.revision});
  assert.equal(snapshot(f,target).status,'cancelled');
  assert.deepEqual(snapshot(f,target).destination_approval,parent.destination_approval);
  assert.equal(child.destination_approval.revision,own.revision);
  assert.deepEqual(child.destination_approval.snapshot,own);
  assert.notEqual(child.destination_approval.approved_at,parent.destination_approval.approved_at);
  f.reopen();
  // R matches the old target, but is wrong for its R2-approved successor.
  f.set(profile());
  const denied=refusal(()=>claim(f,id),'destination_changed');
  assert.equal(denied.approved_revision,own.revision);
  assert.equal(denied.current_revision,parent.destination_approval.revision);
  assert.ok(!snapshot(f,id).claim);
  f.set(profile('Provider B'));
  const granted=claim(f,id);
  assert.ok(granted.claim_id);
  assert.equal(granted.destination_revision,own.revision);
  assert.deepEqual(snapshot(f,id).destination_approval,child.destination_approval);
  assert.deepEqual(snapshot(f,target).destination_approval,parent.destination_approval);
});
