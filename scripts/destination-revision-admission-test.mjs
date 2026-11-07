#!/usr/bin/env node
// Test-first contract; no remote/model APIs. See the HTTP companion for transport boundaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { AsStore } from '../src/as-store.mjs';
import { Store } from '../src/store.mjs';
import * as workerConfig from '../src/workers.mjs';
import {fullSnapshot,changedColumns} from '../src/test-support/full-snapshot.mjs';
import {finishProtocol} from '../src/protocol-finish.mjs';

const declaration=(provider='Provider A')=>({operator:'Fixture operator',provider,
  data_categories:['assignment','results'],retention:'30 days',training:'not used',terms:'Terms v1'});
const profile=(destination=declaration(),repos=['acme/project'],builtinConnectionIds=()=>['fixture-connection'])=>workerConfig.parseWorkers({
  default_execution:'worker',workers:{alpha:{connections:[],repos,guidance:'resume',
    ...(destination===null?{}:{destination})}},
},{builtin:true,builtinConnectionIds});
const assignment=id=>({schema_version:1,request_id:id,brief:'CANARY destination fixture',
  inputs:[],expected_output:'fixture',execution_scope:'read-only'});
const disclose=(p,a=assignment('req_disclose'))=>workerConfig.destinationDisclosure(p,'alpha','worker',a);
function fixture(t,{declared=true}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'destination-admission-'));
  let current=profile(declared?declaration():null),now=Date.now();
  const file=path.join(dir,'bridge.db');
  const store=new Store(file,{workers:current,destinationProfile:()=>current,now:()=>now,resumeIdleMs:1});
  t.after(()=>{if(store.db.isOpen)store.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,file,store,set:p=>{current=p;},clock:ms=>{now+=ms;},get current(){return current;}};
}
function submit(f,id,revision=disclose(f.current)?.revision,extra={}) {
  const a={...assignment(id),...extra};
  return f.store.submit(a,{mode:'none'},'','owner',false,null,'normal',{source:'agent'},
    a,null,'alpha','worker','worker',null,null,null,null,revision??null);
}
const claim=(f,id,who='run',acquisition='acq')=>f.store.claim(id,who,'subject',100,null,'alpha',acquisition,10);
function refusal(fn,code) {
  let thrown;try {fn();} catch(error) {thrown=error;}
  assert.ok(thrown,'expected refusal');assert.equal(thrown.destination?.error,code,thrown.message);
  return thrown.destination;
}

test('versioned disclosure labels assurance; canonical key order does not change identity',()=>{
  const a=declaration(),b=Object.fromEntries(Object.entries(a).reverse());
  const A=disclose(profile(a)),B=disclose(profile(b));
  assert.match(A.revision,/^sha256:[a-f0-9]{64}$/);assert.equal(A.revision,B.revision);
  assert.equal(A.declaration.provider,'Provider A');assert.equal(A.assurance.provider,'declared');
  assert.equal(A.assurance.worker,'checked');assert.equal(A.assurance.execution,'checked');
  assert.equal(disclose(profile({...a,retention:null})).assurance.retention,'unknown');
  assert.notEqual(A.revision,disclose(profile({...a,terms:'Terms v2'})).revision);
  assert.notEqual(A.revision,disclose(profile(declaration('Provider B'))).revision);
  assert.throws(()=>profile({...a,training:42}),/destination/);
});

test('resolver failure refuses submission even with an undeclared startup profile',t=>{
  const legacy=fixture(t,{declared:false});
  legacy.store.destinationProfile=()=>{throw new Error('fixture resolver unavailable');};
  refusal(()=>submit(legacy,'req_resolver_legacy',null),'destination_configuration_invalid');
  assert.equal(legacy.store.hasAssignment('req_resolver_legacy'),false);
  assert.equal(legacy.store.db.prepare('SELECT count(*) n FROM notifications WHERE request_id=?').get('req_resolver_legacy').n,0);
  const declared=fixture(t);
  declared.store.destinationProfile=()=>{throw new Error('fixture resolver unavailable');};
  const details=refusal(()=>submit(declared,'req_resolver_declared'),'destination_configuration_invalid');
  assert.equal(details.message,'Current destination configuration is unavailable or invalid; restore it before a new admission. Cause: configuration could not be loaded');
  const explicit=refusal(()=>submit(legacy,'req_resolver_explicit','sha256:'+'a'.repeat(64)),'destination_configuration_invalid');
  assert.equal(explicit.message,details.message);
  declared.store.destinationProfile=()=>{throw new SyntaxError('Unexpected token in {"synthetic_private_config":"CANARY"}');};
  const malformed=refusal(()=>submit(declared,'req_resolver_malformed'),'destination_configuration_invalid');
  assert.match(malformed.message,/invalid JSON configuration/);
  assert.doesNotMatch(malformed.message,/synthetic_private_config|CANARY/);
});

test('committed submit retry replays without consulting an unavailable resolver',t=>{
  const f=fixture(t),id='req_resolver_retry',revision=disclose(f.current).revision;
  const first=submit(f,id,revision);
  assert.equal(first.duplicate,false);
  assert.equal(first.destination_approval.revision,revision);
  let resolverCalls=0;
  f.store.destinationProfile=()=>{
    resolverCalls++;
    throw new Error('fixture resolver unavailable after committed submit');
  };
  const retry=submit(f,id,revision);
  assert.equal(resolverCalls,0,'committed retry must not consult the destination resolver');
  assert.deepEqual(retry,{...first,duplicate:true});
});

test('submit config read failures use a fixed code and message without host paths',t=>{
  const f=fixture(t),privatePath=path.join(f.dir,'PRIVATE_CONFIG_CANARY.json');
  const cases=[
    ['missing',()=>fs.readFileSync(privatePath,'utf8')],
    ['directory',()=>fs.readFileSync(f.dir,'utf8')],
    // Deterministic even under a privileged test runner that can read mode-000 files.
    ['unreadable',()=>{throw Object.assign(new Error(`EACCES: permission denied, open '${privatePath}'`),{code:'EACCES',path:privatePath});}],
  ];
  for(const [kind,load] of cases) {
    f.store.destinationProfile=load;
    const id='req_config_read_'+kind;
    let thrown;try {submit(f,id);} catch(error) {thrown=error;}
    assert.ok(thrown,'config read failure must refuse submit');
    assert.equal(thrown.destination?.error,'destination_configuration_invalid');
    assert.equal(thrown.destination.message,'Current destination configuration is unavailable or invalid; restore it before a new admission. Cause: configuration could not be loaded');
    assert.ok(!String(thrown.message).includes(f.dir));
    assert.ok(!JSON.stringify(thrown.destination).includes(f.dir));
    assert.doesNotMatch(String(thrown.message),/PRIVATE_CONFIG_CANARY|ENOENT|EISDIR|EACCES/);
    assert.equal(f.store.hasAssignment(id),false);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM notifications WHERE request_id=?').get(id).n,0);
  }
});

test('connection identity changes revision and claim gate; connection order does not',t=>{
  const connection=(client_id,subject='owner')=>({issuer:'https://issuer.example',subject,client_id});
  const external=connections=>workerConfig.parseWorkers({default_execution:'worker',workers:{
    alpha:{connections,repos:['acme/project'],destination:declaration()}}});
  const a=connection('client-a'),b=connection('client-b');
  const f=fixture(t);f.set(external([a,b]));
  const first=disclose(f.current);submit(f,'req_connections_changed');
  assert.equal(disclose(external([b,a])).revision,first.revision);
  for(const field of ['issuer','subject','client_id','connection_id']) {
    f.set(external([{...a,[field]:a[field]+'-changed'},b]));
    assert.notEqual(disclose(f.current).revision,first.revision);
    refusal(()=>claim(f,'req_connections_changed'),'destination_changed');
  }
});

test('destination approval direct deletion is refused while assignment deletion cascades',t=>{
  const f=fixture(t),id='req_delete_approval';
  f.store.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,created_at) VALUES(?,?,?,'','',?)")
    .run(id,JSON.stringify(assignment(id)),'fixture',new Date().toISOString());
  f.store.db.prepare('INSERT INTO destination_approvals VALUES(?,?,?,?,?)')
    .run(id,'fixture','{}','{}',new Date().toISOString());
  assert.throws(()=>f.store.db.prepare('DELETE FROM destination_approvals WHERE request_id=?').run(id),/immutable/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM destination_approvals WHERE request_id=?').get(id).n,1);
  f.store.db.prepare('DELETE FROM assignments WHERE request_id=?').run(id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM destination_approvals WHERE request_id=?').get(id).n,0);
});

test('approved A is immutable, owner-bound and recorded on successful claim',t=>{
  const f=fixture(t),A=disclose(f.current),id='req_destination_positive',first=submit(f,id);
  assert.equal(first.destination_approval.revision,A.revision);
  assert.deepEqual(first.destination_approval.snapshot,A);
  assert.equal(first.destination_approval.actor.kind,'owner_capability');
  assert.match(first.destination_approval.actor.id,/^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(first.destination_approval.approved_at)));
  assert.equal(claim(f,id).destination_revision,A.revision);
  assert.deepEqual(f.store.get(id).destination_approval,first.destination_approval);
  assert.equal(f.store.get(id).claim.destination_revision,A.revision);
  assert.throws(()=>f.store.db.prepare('UPDATE destination_approvals SET revision=? WHERE request_id=?').run('forged',id),/immutable/);
});

test('stale/missing approval stores no assignment or wake; notices are not approval',t=>{
  const f=fixture(t),A=disclose(f.current),id='req_destination_stale';
  f.set(profile(declaration('Provider B')));
  const changed=refusal(()=>submit(f,id,A.revision),'destination_changed');
  assert.equal(changed.approved_revision,A.revision);
  assert.equal(changed.current.declaration.provider,'Provider B');
  assert.equal(f.store.hasAssignment(id),false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM notifications WHERE request_id=?').get(id).n,0);
  refusal(()=>submit(f,'req_destination_missing',null),'destination_approval_required');
  const a={...assignment('req_destination_notice'),notice_recorded:true,acknowledged:true};
  refusal(()=>f.store.submit(a,{mode:'none'},'','owner',false,null,'normal',{source:'agent'},
    a,null,'alpha','worker','worker',null,null,null,null,null),'destination_approval_required');
});

test('compatible A to B refuses durably with old/new difference; no epoch is granted',t=>{
  const f=fixture(t),id='req_destination_drift',A=disclose(f.current);submit(f,id);
  f.set(profile(declaration('Provider B')));
  const result=refusal(()=>claim(f,id),'destination_changed'),got=f.store.get(id);
  assert.equal(result.approved.revision,A.revision);
  assert.equal(result.current.declaration.provider,'Provider B');
  assert.ok(result.differences.some(d=>d.field==='provider'&&d.approved==='Provider A'&&d.current==='Provider B'));
  assert.equal(got.status,'queued');assert.ok(!got.claim);
  assert.deepEqual(got.destination_changed,result);
  const notice=f.store.db.prepare("SELECT body FROM notifications WHERE request_id=? AND kind='wait'").get(id);
  assert.match(JSON.parse(notice.body).note,/Provider A/);assert.match(JSON.parse(notice.body).note,/Provider B/);
  const other=new Store(f.file);
  try {assert.deepEqual(other.get(id).destination_changed,result);} finally {other.db.close();}
});

test('current policy denies unchanged destination independently',t=>{
  const f=fixture(t),id='req_destination_policy';
  const inputs=[{github_repo:'acme/project',base_sha:'a'.repeat(40)}],a={...assignment(id),inputs};
  const A=disclose(f.current,a);submit(f,id,A.revision,{inputs});f.set(profile(declaration(),[]));
  assert.equal(disclose(f.current,a).revision,A.revision);
  refusal(()=>claim(f,id),'destination_policy_denied');assert.ok(!f.store.get(id).claim);
});

test('a restored matching destination stays blocked in listing while repository policy denies the job',t=>{
  const f=fixture(t),id='req_destination_policy_listing';
  const inputs=[{github_repo:'acme/project',base_sha:'a'.repeat(40)}],a={...assignment(id),inputs};
  const A=disclose(f.current,a);submit(f,id,A.revision,{inputs});
  f.set(profile(declaration(),[]));
  refusal(()=>claim(f,id),'destination_policy_denied');
  assert.equal(f.store.listPending('alpha').find(x=>x.request_id===id).blocked,true);
  // The destination revision still matches; only the policy decides.
  assert.equal(disclose(f.current,a).revision,A.revision);
  f.set(profile());
  assert.notEqual(f.store.listPending('alpha').find(x=>x.request_id===id).blocked,true);
});

test('lost submit reply replays original approval; changed/omitted revision and owner conflict',t=>{
  const f=fixture(t),id='req_destination_retry',A=disclose(f.current),first=submit(f,id);
  f.clock(1000);f.set(profile(declaration('Provider B')));
  const retry=submit(f,id,A.revision);assert.equal(retry.duplicate,true);
  assert.deepEqual(retry.destination_approval,first.destination_approval);
  assert.throws(()=>submit(f,id,disclose(f.current).revision),/destination approval conflict/);
  assert.throws(()=>submit(f,id,null),/destination approval conflict/);
  const a=assignment(id);
  assert.throws(()=>f.store.submit(a,{mode:'none'},'','wrong-owner',false,null,'normal',{source:'agent'},
    a,null,'alpha','worker','worker',null,null,null,null,A.revision),/owner|conflict/);
  assert.deepEqual(f.store.get(id).destination_approval,first.destination_approval);
});

test('live duplicate after drift retains grant; an expired duplicate does not',t=>{
  const f=fixture(t),id='req_destination_duplicate';submit(f,id);const first=claim(f,id);
  f.set(profile(declaration('Provider B')));const again=claim(f,id);
  assert.equal(again.duplicate,true);assert.equal(again.claim_id,first.claim_id);
  assert.equal(again.epoch,first.epoch);assert.equal(again.destination_revision,first.destination_revision);
  f.clock(11);refusal(()=>claim(f,id),'destination_changed');assert.equal(f.store.get(id).claim.epoch,first.epoch);
});

for(const mode of ['takeover','reclaim','idle-rotation','resume']) test('fresh epoch gate: '+mode,t=>{
  const f=fixture(t),id='req_destination_'+mode.replaceAll('-','_');submit(f,id);const first=claim(f,id);
  if(mode==='reclaim')f.store.abandon(id);
  f.clock(11);f.set(profile(declaration('Provider B')));
  const action=mode==='resume'?()=>f.store.resume(id,'subject'):
    mode==='takeover'?()=>f.store.claim(id,'other','rival',100,null,'alpha','other',10):
    ()=>claim(f,id,'second','second');
  refusal(action,'destination_changed');
  assert.equal(f.store.get(id).claim.epoch,first.epoch);assert.equal(f.store.get(id).claim.claim_id,first.claim_id);
});

test('bound job fails closed without current declaration/resolver after restart',t=>{
  const f=fixture(t),id='req_destination_restart';submit(f,id);
  const restarted=new Store(f.file,{workers:profile(null)});
  try {refusal(()=>restarted.claim(id,'run','subject',100,null,'alpha','acq',10),'destination_configuration_invalid');}
  finally {restarted.db.close();}
  f.set(profile(null));refusal(()=>claim(f,id),'destination_changed');
  f.set(null);refusal(()=>claim(f,id),'destination_configuration_invalid');
});

test('stale refusal observation cannot overwrite a successful successor',t=>{
  const f=fixture(t),id='req_destination_stale_block';submit(f,id);
  const observed=f.store.destinationGeneration(id);f.set(profile(declaration('Provider B')));
  const refused=refusal(()=>claim(f,id),'destination_changed');f.set(profile());const success=claim(f,id);
  assert.equal(f.store.transaction(()=>f.store.recordDestinationRefusalInTransaction(id,observed,refused)),false);
  assert.equal(f.store.get(id).claim.claim_id,success.claim_id);
  assert.equal(f.store.get(id).destination_changed,undefined);
});

test('publication after synchronous snapshot linearizes after that A admission',async t=>{
  const f=fixture(t),id='req_destination_publish',second='req_destination_after_publish';
  submit(f,id);submit(f,second);const file=path.join(f.dir,'workers.json');
  const raw=p=>({default_execution:'worker',workers:{alpha:{repos:['acme/project'],destination:declaration(p)}}});
  fs.writeFileSync(file,JSON.stringify(raw('Provider A')),{mode:0o600});
  const control=new SharedArrayBuffer(8),state=new Int32Array(control);
  const source="const {workerData,parentPort}=require('node:worker_threads'),fs=require('node:fs');"+
    "const s=new Int32Array(workerData.control);parentPort.postMessage('ready');Atomics.wait(s,0,0);"+
    "fs.writeFileSync(workerData.file+'.tmp',workerData.body,{mode:384});fs.renameSync(workerData.file+'.tmp',workerData.file);"+
    "Atomics.store(s,1,1);Atomics.notify(s,1);";
  const writer=new Worker(source,{eval:true,workerData:{control,file,body:JSON.stringify(raw('Provider B'))}});
  await once(writer,'message');const exited=once(writer,'exit');t.after(()=>writer.terminate());
  let firstRead=true;
  f.store.destinationProfile=()=>{
    const snapshot=workerConfig.loadWorkers(file,{builtin:true,builtinConnectionIds:()=>['fixture-connection']});
    if(firstRead){firstRead=false;Atomics.store(state,0,1);Atomics.notify(state,0);
      assert.notEqual(Atomics.wait(state,1,0,5000),'timed-out');}
    return snapshot;
  };
  assert.equal(claim(f,id).destination_revision,f.store.get(id).destination_approval.revision);
  await exited;refusal(()=>claim(f,second),'destination_changed');
});

test('undeclared jobs/workers preserve legacy behavior without fabricated approval',t=>{
  const f=fixture(t,{declared:false}),id='req_destination_legacy',first=submit(f,id,null);
  assert.equal(first.destination_approval,undefined);assert.equal(f.store.get(id).destination_approval,undefined);
  assert.equal(submit(f,id,null).duplicate,true);const c=claim(f,id);
  assert.equal(c.destination_revision,undefined);assert.equal(claim(f,id).claim_id,c.claim_id);
  f.clock(11);assert.equal(claim(f,id,'new','new').epoch,c.epoch+1);
  assert.equal(f.store.get(id).destination_approval,undefined);
});

test('unbound queued job requires approval when the current worker declares a destination',t=>{
  const f=fixture(t,{declared:false}),id='req_destination_unbound';submit(f,id,null);
  f.set(profile());
  const details=refusal(()=>claim(f,id),'destination_approval_required');
  assert.match(details.message,/Ask the owner to cancel and resubmit/);
  assert.equal(details.approved_revision,null);assert.equal(details.approved,null);
  assert.equal(details.current_revision,disclose(f.current).revision);
  assert.equal(details.current.declaration.provider,'Provider A');
  assert.equal(f.store.get(id).status,'queued');assert.ok(!f.store.get(id).claim);
  assert.equal(f.store.get(id).destination_approval,undefined);
  refusal(()=>claim(f,id),'destination_approval_required');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get(id).n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM destination_blocks WHERE request_id=?').get(id).n,1);
  const notices=f.store.db.prepare("SELECT body FROM notifications WHERE request_id=? AND kind='wait'").all(id);
  assert.equal(notices.length,1);assert.match(JSON.parse(notices[0].body).note,/destination_approval_required/);
  const other=new Store(f.file);
  try {assert.deepEqual(other.get(id).destination_changed,details);} finally {other.db.close();}
  f.store.cancel(id,'owner cancelled after refusal');
  const replacement='req_destination_unbound_replacement';
  const revision=disclose(f.current).revision;
  submit(f,replacement,revision);
  assert.equal(f.store.get(replacement).destination_approval.revision,revision);
  assert.equal(claim(f,replacement).destination_revision,revision);
});

test('60 destination-blocked jobs cannot hide or recommend ahead of fresh approved work',t=>{
  const f=fixture(t,{declared:false}),blocked=[];
  for(let i=0;i<60;i++) { const id='req_queue_block_'+i;blocked.push(id);submit(f,id,null);f.clock(1); }
  f.set(profile());
  for(const id of blocked)refusal(()=>claim(f,id),'destination_approval_required');
  assert.deepEqual(f.store.nextQueued(6,null,'alpha'),{});
  assert.equal(f.store.laneState('subject','alpha').queued,0);
  const fresh='req_queue_fresh';submit(f,fresh);
  const listed=f.store.listPending('alpha');
  assert.equal(listed.length,50);
  assert.equal(listed[0].request_id,fresh);assert.notEqual(listed[0].blocked,true);
  assert.ok(listed.slice(1).every(x=>blocked.includes(x.request_id)&&x.blocked===true));
  assert.deepEqual(f.store.nextQueued(6,null,'alpha').next_queued.map(x=>x.request_id),[fresh]);
  assert.equal(f.store.laneState('subject','alpha').queued,1);
  // Approval is immutable: owner recovery for an unbound job is cancel/resubmit.
  f.store.cancel(blocked[0],'owner replaces unapproved job');f.clock(1);
  const replacement='req_queue_approved_replacement';submit(f,replacement);
  assert.deepEqual(f.store.listPending('alpha').slice(0,2).map(x=>x.request_id),[fresh,replacement]);
  assert.equal(f.store.laneState('subject','alpha').queued,2);
});

test('restored approval is discoverable without an explicit claim and keeps refusal evidence',t=>{
  const f=fixture(t),ids=['req_restore_discovery_a','req_restore_discovery_b'];
  for(const id of ids){submit(f,id);f.clock(1);}
  const approvals=ids.map(id=>f.store.get(id).destination_approval);
  f.set(profile(declaration('Provider B')));
  for(const id of ids)refusal(()=>claim(f,id),'destination_changed');
  const evidence=ids.map(id=>f.store.get(id).destination_changed);
  f.set(profile());
  let reads=0;
  f.store.destinationProfile=()=>{reads++;return f.current;};
  const listed=f.store.listPending('alpha');
  assert.deepEqual(listed.map(x=>x.request_id),ids);
  assert.ok(listed.every(x=>x.blocked!==true));
  assert.equal(reads,1);
  reads=0;
  assert.deepEqual(f.store.nextQueued(2,null,'alpha').next_queued.map(x=>x.request_id),ids);
  assert.equal(reads,1);
  assert.equal(f.store.laneState('subject','alpha').queued,2);
  for(const [i,id] of ids.entries()){
    assert.deepEqual(f.store.get(id).destination_changed,evidence[i]);
    assert.deepEqual(f.store.get(id).destination_approval,approvals[i]);
    assert.ok(!f.store.get(id).claim);
  }
  reads=0;
  f.store.destinationProfile=()=>{reads++;throw new Error('unavailable');};
  assert.ok(f.store.listPending('alpha').every(x=>x.blocked===true));
  assert.equal(reads,1);
});

for(const [name,resolver] of [
  ['an Error throw',()=>{throw new Error('unavailable');}],
  ['a falsy throw',()=>{throw undefined;}],
  ['a rejected promise',()=>Promise.reject(new Error('unavailable'))],
  ['a resolved promise',()=>Promise.resolve(null)],
]) test(`a resolver failure (${name}) is reported once per listing and keeps blocked rows blocked`,async t=>{
  const f=fixture(t),ids=['req_diag_a','req_diag_b','req_diag_c'];
  for(const id of ids){submit(f,id);f.clock(1);}
  f.set(profile(declaration('Provider B')));
  for(const id of ids)refusal(()=>claim(f,id),'destination_changed');
  const unhandled=[],onUnhandled=error=>unhandled.push(error);
  process.on('unhandledRejection',onUnhandled);
  t.after(()=>process.off('unhandledRejection',onUnhandled));
  const seen=[];
  f.store.onConfigError=error=>{seen.push(error);};
  f.store.destinationProfile=resolver;
  const listed=f.store.listPending('alpha');
  assert.deepEqual(listed.map(x=>x.request_id),ids);
  assert.ok(listed.every(x=>x.blocked===true));
  assert.equal(seen.length,1,'one diagnostic per listing, not one per blocked row');
  // The next listing is a new listing and reports again.
  f.store.listPending('alpha');
  assert.equal(seen.length,2);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(unhandled,[]);
});

test('successful admission clears a destination block and requeued work regains normal ordering',t=>{
  const f=fixture(t),older='req_queue_restore_old',newer='req_queue_restore_new';
  submit(f,older);f.clock(1);submit(f,newer);
  f.set(profile(declaration('Provider B')));refusal(()=>claim(f,older),'destination_changed');
  assert.deepEqual(f.store.listPending('alpha').map(x=>x.request_id),[newer,older]);
  assert.equal(f.store.listPending('alpha')[1].blocked,true);
  // Restore the already owner-approved destination, not a fabricated in-place approval.
  f.set(profile());claim(f,older);
  assert.equal(f.store.get(older).destination_changed,undefined);
  f.store.abandon(older);
  const listed=f.store.listPending('alpha');
  assert.deepEqual(listed.map(x=>x.request_id),[older,newer]);
  assert.ok(listed.every(x=>x.blocked!==true));
  assert.equal(f.store.nextQueued(1,null,'alpha').next_queued[0].request_id,older);
  assert.equal(f.store.laneState('subject','alpha').queued,2);
});

test('blocked idle claims remain visible but are never recommended or counted',t=>{
  const f=fixture(t),id='req_queue_blocked_idle';submit(f,id);claim(f,id);f.clock(11);
  f.set(profile(declaration('Provider B')));refusal(()=>claim(f,id,'new','new'),'destination_changed');
  const item=f.store.listPending('alpha').find(x=>x.request_id===id);
  assert.equal(item.resume,true);assert.equal(item.blocked,true);
  assert.deepEqual(f.store.nextQueued(6,null,'alpha'),{});
  assert.equal(f.store.laneState('subject','alpha').queued,0);
});

test('pass-over accounting follows the capped runnable list',t=>{
  const f=fixture(t,{declared:false}),blocked=[];
  for(let i=0;i<50;i++){const id='req_pass_block_'+i;blocked.push(id);submit(f,id,null);f.clock(1);}
  f.set(profile());for(const id of blocked)refusal(()=>claim(f,id),'destination_approval_required');
  const jobs=['req_pass_a','req_pass_b','req_pass_c','req_pass_d'];
  for(const id of jobs){submit(f,id);f.clock(1);}
  for(const id of jobs.slice(1)){f.store.recordListed(f.store.listPending('alpha'),6,'alpha');claim(f,id);f.clock(1);}
  assert.equal(f.store.get(jobs[0]).skipped_by_worker.passed_over,3);
  const row=f.store.db.prepare('SELECT passed_over,eligible_since FROM assignments WHERE request_id=?').get(blocked[0]);
  assert.equal(row.passed_over,0);assert.equal(row.eligible_since,null);
});

test('runnable idle claims and messages precede blocked work at the list cap',t=>{
  const f=fixture(t),blockedIdle='req_mixed_blocked_idle';submit(f,blockedIdle);claim(f,blockedIdle);f.clock(11);
  f.set(profile(declaration('Provider B')));refusal(()=>claim(f,blockedIdle,'new','new'),'destination_changed');
  const blocked=[];
  for(let i=0;i<50;i++){
    const id='req_mixed_blocked_'+i;f.set(profile());submit(f,id);f.set(profile(declaration('Provider B')));refusal(()=>claim(f,id),'destination_changed');blocked.push(id);
  }
  const idle='req_mixed_idle',queued='req_mixed_queued';submit(f,idle);claim(f,idle);f.clock(11);
  const message=f.store.tell('fixture message','alpha').message_id;submit(f,queued);
  const items=f.store.listPending('alpha');
  assert.equal(items.length,50);
  assert.deepEqual(items.slice(0,3).map(x=>x.request_id),[idle,message,queued]);
  assert.ok(items.slice(3).every(x=>x.blocked));
  assert.ok(items.some(x=>x.request_id===blockedIdle));
});

test('unbound existing grant retains live duplicate but cannot gain a fresh epoch after declaration',t=>{
  const f=fixture(t,{declared:false}),id='req_destination_unbound_epoch';submit(f,id,null);
  const first=claim(f,id);f.set(profile());
  assert.equal(claim(f,id).claim_id,first.claim_id);
  f.clock(11);refusal(()=>claim(f,id,'new','new'),'destination_approval_required');
  assert.equal(f.store.get(id).claim.epoch,first.epoch);
});

test('unreadable config at submit never falls back to the undeclared startup profile',t=>{
  const f=fixture(t,{declared:false}),id='req_destination_unreadable';
  const file=path.join(f.dir,'workers.json');fs.mkdirSync(file,{mode:0o600});
  f.store.destinationProfile=()=>workerConfig.loadWorkers(file,{builtin:true});
  refusal(()=>submit(f,id,null),'destination_configuration_invalid');
  assert.equal(f.store.hasAssignment(id),false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM notifications WHERE request_id=?').get(id).n,0);
});

test('pre-claim list/get disclosure is not an egress guarantee',t=>{
  const f=fixture(t),id='req_destination_canary';
  f.store.connectionIsLive=()=>true;
  f.store.subscribe('fixture-event','https://fixture.invalid/webhook','synthetic-fixture-secret',
    new Date(Date.now()+3600000).toISOString(),'subject','alpha',
    {builtin:true,connection_id:'fixture-connection',connection:{worker:'alpha'}});
  submit(f,id);f.set(profile(declaration('Provider B')));
  const event=f.store.db.prepare("SELECT body FROM notifications WHERE request_id=? AND kind='event'").get(id);
  assert.match(JSON.parse(event.body).data.title,/CANARY/);
  assert.match(f.store.listPending('alpha').find(x=>x.request_id===id).title,/CANARY/);
  assert.match(f.store.get(id).assignment.brief,/CANARY/);
  refusal(()=>claimWithConnection(f,id,'fixture-connection'),'destination_changed');assert.match(f.store.get(id).assignment.brief,/CANARY/);
});

test('keyed owner submit replays approval and rejects changed revision intent',t=>{
  const f=fixture(t),id='req_destination_keyed',a=assignment(id),A=disclose(f.current).revision;
  const send=revision=>f.store.submit(a,{mode:'none'},'','owner',false,null,'normal',{source:'agent'},
    a,null,'alpha','worker','worker',null,null,'submit-key',null,revision);
  const first=send(A);f.set(profile(declaration('Provider B')));
  assert.deepEqual(send(A).destination_approval,first.destination_approval);
  assert.throws(()=>send(disclose(f.current).revision),/destination approval conflict/);
  assert.throws(()=>send(null),/destination approval conflict/);
});

test('protocol replay keeps its native receipt; refused fresh epoch creates no receipt or event',t=>{
  const f=fixture(t),id='req_destination_protocol',A=disclose(f.current).revision;
  submit(f,id,A,{protocol:{profile:'job-v0',source:'fixture',scope:'fixture',policy:'fixture',
    destination:'fixture',retain_until_ms:Date.now()+3600000}});
  const ctx={key:'claim-one',revision:1};
  const first=f.store.claim(id,'run','subject',100,null,'alpha','acq',10,ctx);
  f.set(profile(declaration('Provider B')));
  const replay=f.store.claim(id,'run','subject',100,null,'alpha','acq',10,ctx);
  assert.equal(replay.claim_id,first.claim_id);assert.equal(replay.epoch,first.epoch);
  assert.equal(replay.destination_revision,A);
  f.clock(11);
  const revision=f.store.protocolRevision(id),events=f.store.protocolFacts(id).length;
  refusal(()=>f.store.claim(id,'new','subject',100,null,'alpha','new',10,{key:'claim-two',revision}),'destination_changed');
  assert.equal(f.store.protocolRevision(id),revision);assert.equal(f.store.protocolFacts(id).length,events);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM claim_command_receipts WHERE job=? AND command_key=?').get(id,'claim-two').n,0);
  assert.equal(f.store.get(id).destination_changed.error,'destination_changed');
});

function builtinFixture(t) {
  const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'destination-auth-'));
  const auth=new AsStore(path.join(dir,'auth.db'));
  t.after(()=>{if(auth.db.isOpen)auth.close();fs.rmSync(dir,{recursive:true,force:true});});
  // Resolve on every admission, as server.currentRepoPolicy does, not from a startup ID snapshot.
  f.set(profile(declaration(),['acme/project'],worker=>auth.liveConnectionIds(worker)));
  const approve=(name,worker='alpha',replace=false)=>{
    auth.closeWindow();
    const window=auth.openWindow(worker,10),client_id='client-'+name,grantId='grant-'+name;
    auth.admission.run(window.generation,()=>auth.upsert('Client',client_id,{client_id}));
    auth.upsert('Grant',grantId,{clientId:client_id},3600);
    const snapshot={client_id,client_name:name,redirect_uri:'https://fixture.invalid/callback',
      resource:'https://fixture.invalid/mcp',scopes:'dot-bridge.work',interaction_expires_at:Date.now()+600000};
    const pairing=auth.pairingFor('interaction-'+name,snapshot,window);
    assert.equal(auth.reserve(pairing.code),true);
    return {...auth.commitApproval({code:pairing.code,worker,grantId,snapshot,replace}),grantId,client_id};
  };
  return {f,auth,approve};
}

test('built-in replacement changes revision and refuses an approved Store claim',t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('a'),id='req_builtin_replace';
  const before=disclose(f.current);submit(f,id);
  const b=approve('b','alpha',true);
  assert.equal(b.replaced.connection_id,a.connection_id);
  assert.deepEqual(auth.liveConnectionIds('alpha'),[b.connection_id]);
  assert.notEqual(disclose(f.current).connections_digest,before.connections_digest);
  refusal(()=>claim(f,id),'destination_changed');
  assert.ok(!f.store.get(id).claim);
});

test('built-in token refresh preserves revision and approved Store claim',t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('refresh'),id='req_builtin_refresh';
  const before=disclose(f.current);submit(f,id);
  auth.upsert('RefreshToken','old-token',{clientId:a.client_id,grantId:a.grantId},3600);
  auth.commitRefresh({reads:[],writes:[
    ['consume','RefreshToken','old-token'],
    ['upsert','RefreshToken','new-token',{clientId:a.client_id,grantId:a.grantId},3600],
    ['upsert','AccessToken','new-access',{clientId:a.client_id,grantId:a.grantId},3600],
  ]},a.grantId,a.client_id,'old-token',{}, {access_token:'new-access'},Date.now()+60000);
  assert.equal(auth.connectionIsLive(a.connection_id),true);
  assert.equal(disclose(f.current).revision,before.revision);
  assert.equal(claim(f,id).destination_revision,before.revision);
});

for(const ending of ['revoked','expired','missing-grant']) test('built-in '+ending+' connection changes revision',t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve(ending),id='req_builtin_'+ending.replaceAll('-','_');
  const before=disclose(f.current);submit(f,id);
  if(ending==='revoked')auth.revokeGrant(a.grantId,'fixture');
  else if(ending==='expired')auth.db.prepare("UPDATE oidc SET expires_at=0 WHERE model='Grant' AND id=?").run(a.grantId);
  else auth.db.prepare("DELETE FROM oidc WHERE model='Grant' AND id=?").run(a.grantId);
  assert.deepEqual(auth.liveConnectionIds('alpha'),[]);
  assert.notEqual(disclose(f.current).revision,before.revision);
  refusal(()=>claim(f,id),'destination_changed');
});

test('built-in connection IDs are worker-scoped and canonical; external OAuth ignores the injection',t=>{
  const {f,approve}=builtinFixture(t);approve('alpha');const before=disclose(f.current);
  approve('beta','beta');
  assert.equal(disclose(f.current).revision,before.revision);
  const ids=['b','a'];
  const p=profile(declaration(),[],()=>ids);
  assert.equal(disclose(p).revision,disclose(profile(declaration(),[],()=>['a','b','a'])).revision);
  const config={workers:{alpha:{destination:declaration(),connections:[{issuer:'https://issuer.example',subject:'owner',connection_id:'external'}]}}};
  const external=workerConfig.parseWorkers(config);
  assert.equal(disclose(workerConfig.parseWorkers(config,{builtinConnectionIds:()=>{throw new Error('must not query built-in store');}})).revision,
    disclose(external).revision);
});

// A claim in built-in mode carries the claimant's connection_id (the server
// passes principal.connection_id); the Store refuses when that connection is
// not in the worker's live set, so tests below pass it positionally.
const claimWithConnection=(f,id,connectionId,who='run',subject='subject',acquisition='acq')=>
  f.store.claim(id,who,subject,100,null,'alpha',acquisition,10,null,connectionId);

test('built-in approval at an empty live set is refused',t=>{
  const f=fixture(t);f.set(profile(declaration(),['acme/project'],()=>[]));
  const details=refusal(()=>submit(f,'req_empty_live_approval'),'destination_connection_required');
  assert.equal(details.request_id,'req_empty_live_approval');
  assert.equal(f.store.hasAssignment('req_empty_live_approval'),false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM destination_approvals WHERE request_id=?').get('req_empty_live_approval').n,0);
});

test('empty disclosure remains refused if a connection appears before approval',t=>{
  const f=fixture(t), id='req_empty_snapshot_race';
  const revision=disclose(profile(declaration(),['acme/project'],()=>[])).revision;
  let reads=0;
  f.set(profile(declaration(),['acme/project'],()=>++reads===1?[]:['new-connection']));
  refusal(()=>submit(f,id,revision),'destination_connection_required');
  assert.equal(f.store.hasAssignment(id),false);
});

test('approval is refused if the live set empties after disclosure',t=>{
  const f=fixture(t), id='req_connection_lost_before_approval';
  const revision=disclose(profile()).revision;
  let reads=0;
  f.set(profile(declaration(),['acme/project'],()=>++reads===1?['fixture-connection']:[]));
  refusal(()=>submit(f,id,revision),'destination_connection_required');
  assert.equal(f.store.hasAssignment(id),false);
});

test('built-in claim binds the claimant connection even when the revision would match',t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('c1');
  // Legacy state: an approval recorded while no connection was live binds the
  // digest of the empty set. New code refuses to record such approvals (see
  // the test above), so the row is seeded directly, as a pre-fix record.
  const empty=disclose(profile(declaration(),['acme/project'],()=>[]));
  const id='req_builtin_revoked_match';
  f.store.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,created_at,target_worker,execution) VALUES(?,?,?,?,?,?,?,?)")
    .run(id,JSON.stringify(assignment(id)),'fixture','','',new Date().toISOString(),'alpha','worker');
  f.store.db.prepare('INSERT INTO destination_approvals(request_id,revision,snapshot,actor,approved_at) VALUES(?,?,?,?,?)')
    .run(id,empty.revision,JSON.stringify(empty),JSON.stringify({kind:'owner_capability',id:'fixture'}),new Date().toISOString());
  auth.revokeGrant(a.grantId,'fixture');
  assert.deepEqual(auth.liveConnectionIds('alpha'),[]);
  assert.equal(disclose(f.current).revision,empty.revision);
  refusal(()=>claimWithConnection(f,id,a.connection_id),'connection_not_live');
  assert.equal(f.store.get(id).status,'queued');
  assert.ok(!f.store.get(id).claim);
});

test('built-in revoked connection is refused on takeover, resume and idle rotation',t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('paths');
  const id='req_builtin_revoked_paths';submit(f,id);
  const granted=claimWithConnection(f,id,a.connection_id);
  assert.equal(granted.destination_revision,disclose(f.current).revision);
  auth.revokeGrant(a.grantId,'fixture');
  assert.deepEqual(auth.liveConnectionIds('alpha'),[]);
  f.clock(11);
  refusal(()=>claimWithConnection(f,id,a.connection_id,'other','rival','other'),'connection_not_live');
  refusal(()=>f.store.resume(id,'subject',a.connection_id),'connection_not_live');
  refusal(()=>claimWithConnection(f,id,a.connection_id,'second','subject','second'),'connection_not_live');
  assert.equal(f.store.get(id).claim.claim_id,granted.claim_id);
  assert.equal(f.store.get(id).claim.epoch,granted.epoch);
});

test('built-in claim by a live connection still succeeds',t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('live');
  const id='req_builtin_live_claim';submit(f,id);
  const granted=claimWithConnection(f,id,a.connection_id);
  assert.equal(granted.destination_revision,disclose(f.current).revision);
  assert.equal(f.store.get(id).claim.claim_id,granted.claim_id);
});

test('built-in token refresh on the same connection still claims',t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('refresh2');
  const id='req_builtin_refresh_claim';submit(f,id);
  const before=disclose(f.current);
  auth.upsert('RefreshToken','old-token',{clientId:a.client_id,grantId:a.grantId},3600);
  auth.commitRefresh({reads:[],writes:[
    ['consume','RefreshToken','old-token'],
    ['upsert','RefreshToken','new-token',{clientId:a.client_id,grantId:a.grantId},3600],
    ['upsert','AccessToken','new-access',{clientId:a.client_id,grantId:a.grantId},3600],
  ]},a.grantId,a.client_id,'old-token',{},{access_token:'fixture-new-access'},Date.now()+60000);
  assert.equal(auth.connectionIsLive(a.connection_id),true);
  assert.equal(disclose(f.current).revision,before.revision);
  const granted=claimWithConnection(f,id,a.connection_id);
  assert.equal(granted.destination_revision,before.revision);
});

test('built-in disclosure without a live-connection callback throws instead of binding the empty set',t=>{
  const missing=workerConfig.parseWorkers({default_execution:'worker',workers:{alpha:{connections:[],repos:['acme/project'],destination:declaration()}}},{builtin:true});
  assert.throws(()=>disclose(missing),/live-connection/);
  const external=workerConfig.parseWorkers({default_execution:'worker',workers:{alpha:{connections:[{issuer:'https://issuer.example',subject:'owner',client_id:'ext'}],repos:['acme/project'],destination:declaration()}}});
  assert.match(disclose(external).revision,/^sha256:[a-f0-9]{64}$/);
});

for(const native of [false,true]) test('replacement connection cannot replay '+(native?'native receipt':'live duplicate'),t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('replay-a'),id='req_replace_replay_'+native;
  const revision=disclose(f.current).revision;
  submit(f,id,revision,native?{protocol:{profile:'job-v0',source:'fixture',scope:'fixture',policy:'fixture',
    destination:'fixture',retain_until_ms:Date.now()+3600000}}:{});
  const ctx=native?{key:'original-claim',revision:1}:null;
  const send=connection=>f.store.claim(id,'same-run','same-subject',100,null,'alpha','same-acquisition',10,ctx,connection);
  const first=send(a.connection_id);
  // Refresh keeps the connection identity and the original receipt recoverable.
  auth.upsert('RefreshToken','replay-old',{clientId:a.client_id,grantId:a.grantId},3600);
  auth.commitRefresh({reads:[],writes:[
    ['consume','RefreshToken','replay-old'],
    ['upsert','RefreshToken','replay-new',{clientId:a.client_id,grantId:a.grantId},3600],
    ['upsert','AccessToken','replay-access',{clientId:a.client_id,grantId:a.grantId},3600],
  ]},a.grantId,a.client_id,'replay-old',{}, {access_token:'fixture-replay-access'},Date.now()+60000);
  assert.equal(send(a.connection_id).claim_id,first.claim_id);
  const before=f.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
  const receipts=native?f.store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id):null;
  const b=approve('replay-b','alpha',true);
  assert.equal(auth.connectionIsLive(b.connection_id),true);
  assert.equal(auth.connectionIsLive(a.connection_id),false);
  f.clock(1);
  refusal(()=>send(b.connection_id),'destination_changed');
  refusal(()=>send(a.connection_id),'connection_not_live');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),before);
  if(native)assert.deepEqual(f.store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id),receipts);
});

test('claim and second submit resolver failures do not disclose host paths',t=>{
  const f=fixture(t),id='req_claim_config_private';submit(f,id);
  const bad=()=>{throw Object.assign(new Error("EACCES: open '/private/CONFIG_CANARY.json'"),{code:'EACCES'});};
  const expected='Current destination configuration is unavailable or invalid; restore it before a new admission. Cause: configuration could not be loaded';
  f.store.destinationProfile=bad;
  const claimError=refusal(()=>claimWithConnection(f,id,'fixture-connection'),'destination_configuration_invalid');
  assert.equal(claimError.message,expected);
  assert.doesNotMatch(JSON.stringify(claimError),/\/private\/|CONFIG_CANARY|EACCES/);
  assert.ok(!f.store.get(id).claim);
  const revision=disclose(f.current).revision;
  let reads=0;
  f.store.destinationProfile=()=>++reads===1?f.current:bad();
  const submitError=refusal(()=>submit(f,'req_submit_second_read',revision),'destination_configuration_invalid');
  assert.equal(reads,2);
  assert.equal(submitError.message,expected);
  assert.doesNotMatch(JSON.stringify(submitError),/\/private\/|CONFIG_CANARY|EACCES/);
  assert.equal(f.store.hasAssignment('req_submit_second_read'),false);
});

test('configured built-in liveness requires an explicit nonempty connection ID',t=>{
  const f=fixture(t),id='req_missing_connection';submit(f,id);
  f.store.connectionIsLive=()=>true;
  for(const connectionId of [null,undefined,'',' ',42]) {
    refusal(()=>claimWithConnection(f,id,connectionId),'connection_not_live');
    assert.ok(!f.store.get(id).claim);
  }
  const granted=claimWithConnection(f,id,'fixture-connection');
  assert.ok(granted.claim_id);
  const before=f.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
  refusal(()=>claimWithConnection(f,id,null),'connection_not_live');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),before);
});

function legacyBuiltinFixture(t) {
  const {f,auth,approve}=builtinFixture(t),connection=approve('legacy-dot','dot');
  const missing=path.join(f.dir,'absent-workers.json');
  const current=()=>workerConfig.loadWorkers(missing,{builtin:true,builtinConnectionIds:worker=>auth.liveConnectionIds(worker)});
  assert.equal(fs.existsSync(missing),false);
  assert.equal(current().legacy,true);
  assert.equal(current().builtinConnectionIds,undefined);
  const store=new Store(path.join(f.dir,'legacy-bridge.db'),{workers:current(),destinationProfile:current,
    connectionIsLive:id=>auth.connectionIsLive(id)});
  t.after(()=>store.db.close());
  const id='req_legacy_builtin',a=assignment(id);
  store.submit(a,{mode:'none'},'','owner',false,null,'normal',null,a,null,'dot','worker','worker');
  const claim=()=>store.claim(id,'run','subject',100,null,'dot','acq',10,null,connection.connection_id);
  return {store,auth,connection,id,claim};
}

// Run this positive case on the main base as well as the PR: the extra claim
// argument is ignored by the base, so the same fixture measures compatibility.
test('legacy built-in without workers.json can claim using its live authority',t=>{
  const f=legacyBuiltinFixture(t);
  assert.equal(f.auth.connectionIsLive(f.connection.connection_id),true);
  assert.ok(f.claim().claim_id);
});

test('legacy built-in fallback does not admit a revoked connection',t=>{
  const f=legacyBuiltinFixture(t);
  f.auth.revokeGrant(f.connection.grantId,'fixture');
  refusal(f.claim,'connection_not_live');
  assert.ok(!f.store.get(f.id).claim);
});

for(const native of [false,true]) test('revoked exact retry preserves '+(native?'native receipt and events':'legacy grant'),t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('retry-revoke'),id='req_revoked_retry_'+native;
  submit(f,id,disclose(f.current).revision,native?{protocol:{profile:'job-v0',source:'fixture',scope:'fixture',policy:'fixture',destination:'fixture',retain_until_ms:Date.now()+3600000}}:{});
  const ctx=native?{key:'claim',revision:1}:null;
  const send=()=>f.store.claim(id,'run','subject',100,null,'alpha','acq',10,ctx,a.connection_id);
  const first=send();assert.equal(send().claim_id,first.claim_id);
  const snapshot=()=>({claim:f.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),
    receipts:f.store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id),
    events:f.store.db.prepare('SELECT * FROM protocol_events WHERE request_id=?').all(id)});
  const before=snapshot();auth.revokeGrant(a.grantId,'fixture');f.clock(1);
  refusal(send,'connection_not_live');assert.deepEqual(snapshot(),before);
});

test('live connection membership is worker-specific at claim admission',t=>{
  const {f,approve}=builtinFixture(t),a=approve('alpha-member'),b=approve('beta-member','beta');
  f.set(workerConfig.parseWorkers({default_execution:'worker',workers:{alpha:{destination:declaration()},beta:{destination:declaration()}}},
    {builtin:true,builtinConnectionIds:worker=>worker==='alpha'?[a.connection_id]:[b.connection_id]}));
  f.store.workers=f.current;
  for(const [worker,own,other] of [['alpha',a,b],['beta',b,a]]) {
    const id='req_membership_'+worker,payload=assignment(id),revision=workerConfig.destinationDisclosure(f.current,worker,'worker',payload).revision;
    f.store.submit(payload,{mode:'none'},'','owner',false,null,'normal',null,payload,null,worker,'worker','worker',null,null,null,null,revision);
    const send=c=>f.store.claim(id,'run','subject',100,null,worker,'acq',10,null,c.connection_id);
    refusal(()=>send(other),'connection_not_live');assert.ok(!f.store.get(id).claim);
    assert.ok(send(own).claim_id);
  }
});

for(const change of ['live','revoked','missing-grant','expired','replacement']) test('durable auth and queued approval after restart: '+change,t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('restart-a'),id='req_restart_'+change;
  submit(f,id);
  let b;
  if(change==='revoked')auth.revokeGrant(a.grantId,'fixture');
  if(change==='missing-grant')auth.db.prepare("DELETE FROM oidc WHERE model='Grant' AND id=?").run(a.grantId);
  if(change==='expired')auth.db.prepare("UPDATE oidc SET expires_at=0 WHERE model='Grant' AND id=?").run(a.grantId);
  if(change==='replacement')b=approve('restart-b','alpha',true);
  const authFile=auth.db.location();
  auth.close();f.store.db.close();
  const reopened=new AsStore(authFile),current=profile(declaration(),['acme/project'],worker=>reopened.liveConnectionIds(worker));
  const store=new Store(f.file,{workers:current,destinationProfile:()=>current,connectionIsLive:id=>reopened.connectionIsLive(id)});
  t.after(()=>{store.db.close();reopened.close();});
  const send=c=>store.claim(id,'run','subject',100,null,'alpha','acq',10,null,c.connection_id);
  if(change==='live')assert.ok(send(a).claim_id);
  else {
    refusal(()=>send(a),'connection_not_live');
    if(b)refusal(()=>send(b),'destination_changed');
    assert.ok(!store.get(id).claim);
  }
});

for(const kind of ['throws','promise','null','missing-callback','nonarray','omits-id','callback-throws']) test('claim resolver fails closed: '+kind,t=>{
  const f=fixture(t),id='req_resolver_matrix_'+kind.replaceAll('-','_');submit(f,id);
  const bad=()=>{throw new Error("EACCES /private/CONFIG_CANARY.json");};
  const cases={throws:bad,promise:()=>Promise.resolve(f.current),null:()=>null,
    'missing-callback':()=>({...f.current,builtinConnectionIds:undefined}),
    nonarray:()=>({...f.current,builtinConnectionIds:()=>null}),
    'omits-id':()=>({...f.current,builtinConnectionIds:()=>['other']}),
    'callback-throws':()=>({...f.current,builtinConnectionIds:bad})};
  f.store.destinationProfile=cases[kind];
  const error=refusal(()=>claimWithConnection(f,id,'fixture-connection'),['throws','promise','callback-throws'].includes(kind)?'destination_configuration_invalid':'connection_not_live');
  assert.doesNotMatch(JSON.stringify(error),/private|CONFIG_CANARY|EACCES/);
  assert.ok(!f.store.get(id).claim);
});

test('second submit live-set failure does not disclose host paths or persist approval',t=>{
  const f=fixture(t),id='req_second_live_read',revision=disclose(f.current).revision;
  let reads=0;
  f.store.destinationProfile=()=>++reads===1?f.current:{...f.current,builtinConnectionIds:()=>{throw new Error('EACCES /private/CONFIG_CANARY.json');}};
  const error=refusal(()=>submit(f,id,revision),'destination_configuration_invalid');
  assert.equal(reads,2);assert.doesNotMatch(JSON.stringify(error),/private|CONFIG_CANARY|EACCES/);
  assert.equal(f.store.hasAssignment(id),false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM destination_approvals WHERE request_id=?').get(id).n,0);
});

// ---- Claim binding follow-ups -------------------------------------------------------------------------------------

const nativeJob={protocol:{profile:'job-v0',source:'fixture',scope:'fixture',policy:'fixture',destination:'fixture',retain_until_ms:Date.now()+3600000}};
const grantRows=(f,id)=>({claims:f.store.db.prepare('SELECT request_id,claimant,claim_id,claimed_at,subject,worker,epoch,state,acquisition_id,lease_ms,connection_id FROM claims WHERE request_id=?').all(id),
  blocks:f.store.db.prepare('SELECT * FROM destination_blocks WHERE request_id=?').all(id),
  notices:f.store.db.prepare('SELECT * FROM notifications WHERE request_id=?').all(id),
  receipts:f.store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id),
  events:f.store.db.prepare('SELECT * FROM protocol_events WHERE request_id=?').all(id)});

for(const native of [false,true]) test('worker with no destination: a replacement connection cannot recover '+(native?'a native receipt':'a duplicate grant'),t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('undeclared-a'),id='req_undeclared_replace_'+native;
  f.set(profile(null,['acme/project'],worker=>auth.liveConnectionIds(worker)));
  submit(f,id,null,native?nativeJob:{});
  const ctx=native?{key:'claim',revision:1}:null;
  const send=connection=>f.store.claim(id,'same','subject',100,null,'alpha','same',10,ctx,connection);
  const first=send(a.connection_id);
  assert.equal(f.store.db.prepare('SELECT connection_id FROM claims WHERE request_id=?').get(id).connection_id,a.connection_id);
  assert.equal(send(a.connection_id).claim_id,first.claim_id,'the granting connection still recovers its grant');
  const b=approve('undeclared-b','alpha',true);
  const before=grantRows(f,id);
  refusal(()=>send(b.connection_id),'destination_changed');
  assert.deepEqual(grantRows(f,id),before,'a refusal writes nothing');
  // The fence is durable: a reopened Store reads it from the database, not from a process cache.
  const reopened=new Store(f.file,{workers:f.current,destinationProfile:()=>f.current,now:()=>f.store.nowMs(),connectionIsLive:c=>auth.connectionIsLive(c)});
  try {
    refusal(()=>reopened.claim(id,'same','subject',100,null,'alpha','same',10,ctx,b.connection_id),'destination_changed');
    assert.equal(reopened.get(id).claim.claim_id,first.claim_id);
  } finally {reopened.db.close();}
});

for(const mode of ['new','takeover','reclaim','idle-rotation','resume']) test('every grant records its connection: '+mode,t=>{
  const {f,auth,approve}=builtinFixture(t),a=approve('record-a'),id='req_record_'+mode.replaceAll('-','_');
  f.set(profile(null,['acme/project'],worker=>auth.liveConnectionIds(worker)));
  submit(f,id,null);
  const recorded=()=>f.store.db.prepare('SELECT connection_id FROM claims WHERE request_id=?').get(id).connection_id;
  claimWithConnection(f,id,a.connection_id);assert.equal(recorded(),a.connection_id);
  if(mode==='new')return;
  const b=approve('record-b','alpha',true);
  if(mode==='reclaim')f.store.abandon(id);
  f.clock(11);
  if(mode==='resume')f.store.resume(id,'subject',b.connection_id);
  else if(mode==='takeover')claimWithConnection(f,id,b.connection_id,'other','rival','other');
  else if(mode==='reclaim')claimWithConnection(f,id,b.connection_id,'other','subject','other');
  else claimWithConnection(f,id,b.connection_id,'run','subject','second');
  assert.equal(recorded(),b.connection_id);
});

for(const native of [false,true]) for(const drift of ['policy','declaration','removed-declaration'])
test('same-connection retry ignores '+drift+' for '+(native?'a native receipt':'a duplicate grant'),t=>{
  const f=fixture(t),id='req_retry_drift_'+native+'_'+drift.replaceAll('-','_');
  const repoJob={inputs:[{github_repo:'acme/project',base_sha:'a'.repeat(40)}]},fresh=id+'_fresh';
  submit(f,id,disclose(f.current).revision,{...repoJob,...(native?nativeJob:{})});
  submit(f,fresh,disclose(f.current).revision,repoJob);
  const ctx=native?{key:'claim',revision:1}:null;
  const send=()=>f.store.claim(id,'run','subject',100,null,'alpha','acq',10,ctx,'fixture-connection');
  const first=send();
  const before=grantRows(f,id);
  f.set(profile(drift==='removed-declaration'?null:declaration(drift==='declaration'?'Provider B':'Provider A'),
    drift==='policy'?[]:['acme/project']));
  assert.equal(send().claim_id,first.claim_id);
  assert.deepEqual(grantRows(f,id).blocks,before.blocks,'an exact retry is not a new admission, so it records no refusal');
  assert.deepEqual(grantRows(f,id).notices,before.notices);
  assert.deepEqual(grantRows(f,id).receipts,before.receipts);
  assert.deepEqual(grantRows(f,id).events,before.events);
  // A fresh grant under the same edit is still refused: policy gates admission, not the holder's retry.
  refusal(()=>f.store.claim(fresh,'run','subject',100,null,'alpha','fresh',10,null,'fixture-connection'),drift==='policy'?'destination_policy_denied':'destination_changed');
});

for(const native of [false,true]) test('same-connection retry is refused, with no write, when the approved connection set changed ('+(native?'native receipt':'duplicate')+')',t=>{
  const f=fixture(t),id='req_retry_digest_'+native;
  submit(f,id,disclose(f.current).revision,native?nativeJob:{});
  const ctx=native?{key:'claim',revision:1}:null;
  const send=()=>f.store.claim(id,'run','subject',100,null,'alpha','acq',10,ctx,'fixture-connection');
  send();
  const before=grantRows(f,id);
  f.set(profile(declaration(),['acme/project'],()=>['fixture-connection','new-peer']));
  refusal(send,'destination_changed');
  assert.deepEqual(grantRows(f,id),before);
});

test('configuration hook receives the original exception but never controls the public failure',t=>{
  const f=fixture(t),id='req_diagnostic_hook';submit(f,id);
  const secret=new SyntaxError('PRIVATE_CONFIG_CONTENT /private/path');
  const seen=[];f.store.onConfigError=error=>{seen.push(error);throw new Error('PRIVATE_HOOK_FAILURE');};
  f.store.destinationProfile=()=>{throw secret;};
  const result=refusal(()=>claimWithConnection(f,id,'fixture-connection'),'destination_configuration_invalid');
  assert.ok(seen.length>0&&seen.every(error=>error===secret),'the hook gets the original exception');
  assert.match(result.message,/invalid JSON configuration/);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|\/private/);
});

test('external OAuth null connection keeps working across exact retries',t=>{
  const f=fixture(t,{declared:false}),id='req_external_null';submit(f,id,null);
  const first=claim(f,id);assert.equal(claim(f,id).claim_id,first.claim_id);
  assert.equal(f.store.db.prepare('SELECT connection_id FROM claims WHERE request_id=?').get(id).connection_id,null);
});


// ---- Commit-time mutation fence (no destination-policy readmission) --------------------------------------------
const nativeResult=JSON.stringify({source:'fixture',policy:'fixture'});
const mutationRows=(f,id)=>({
  claim:f.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),
  progress:f.store.db.prepare('SELECT * FROM progress WHERE request_id=?').all(id),
  reports:f.store.db.prepare('SELECT * FROM reports WHERE request_id=?').all(id),
  revision:f.store.db.prepare('SELECT * FROM claim_command_revisions WHERE job=?').all(id),
  receipts:f.store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id),
  events:f.store.db.prepare('SELECT * FROM protocol_events WHERE request_id=?').all(id),
});
for(const native of [false,true]) for(const mode of ['second-live','null-stored','revoked'])
test('commit fence refuses '+mode+' authority ('+(native?'native':'legacy')+')',t=>{
  const f=fixture(t,{declared:false}),id='req_commit_'+mode.replaceAll('-','_')+'_'+native;
  const live=new Set(['fixture-connection','second-connection']);
  f.set(profile(null,['acme/project'],()=>[...live]));
  f.store.connectionIsLive=c=>live.has(c);
  submit(f,id,null,native?nativeJob:{});
  const claim=f.store.claim(id,'same','subject',100,null,'alpha','same',10,native?{key:'claim',revision:1}:null,'fixture-connection');
  if(mode==='null-stored')f.store.db.prepare('UPDATE claims SET connection_id=NULL WHERE request_id=?').run(id);
  if(mode==='revoked')live.delete('fixture-connection');
  const caller=mode==='second-live'?'second-connection':'fixture-connection';
  const ctx=native?{key:'mutation',revision:claim.revision}:null;
  const finishCtx=native?{...ctx,key:'finish-mutation',args:{artifact_ids:[]}}:null,finishResult=native?nativeResult:'refused';
  const attempts=[
    ()=>f.store.progress(id,claim.claim_id,'refused','subject',false,'alpha',null,ctx,caller),
    ()=>f.store.finish(id,claim.claim_id,'completed','refused',finishResult,'subject',null,'alpha',finishCtx,null,caller),
    ()=>f.store.touchClaim(id,claim.claim_id,'subject','alpha',caller),
    ()=>f.store.recordToolActivity(id,'subject','alpha','get',{connectionId:caller}),
    ...(native?[()=>f.store.renewClaim(id,claim.claim_id,10,ctx,'subject','alpha',caller)]:[]),
  ];
  for(const attempt of attempts) {
    const before=mutationRows(f,id);refusal(attempt,'connection_not_live');
    assert.deepEqual(mutationRows(f,id),before);
  }
});

for(const native of [false,true]) test('stored-finish replay remains connection-bound ('+(native?'native':'legacy')+')',t=>{
  const f=fixture(t,{declared:false}),id='req_commit_replay_'+native;
  f.store.connectionIsLive=()=>true;
  submit(f,id,null,native?nativeJob:{});
  const claim=f.store.claim(id,'same','subject',100,null,'alpha','same',10,native?{key:'claim',revision:1}:null,'fixture-connection');
  const ctx=native?{key:'finish',revision:claim.revision,args:{artifact_ids:[]}}:null;
  const send=c=>f.store.finish(id,claim.claim_id,'completed','done',native?nativeResult:'result','subject',null,'alpha',ctx,null,c);
  send('fixture-connection');const before=mutationRows(f,id);
  refusal(()=>send('second-connection'),'connection_not_live');
  assert.deepEqual(mutationRows(f,id),before);
  f.store.connectionIsLive=()=>false;
  refusal(()=>send('fixture-connection'),'connection_not_live');
  assert.deepEqual(mutationRows(f,id),before);
});

test('NULL retry cannot recover a recorded built-in grant even without connectionIsLive',t=>{
  const f=fixture(t,{declared:false}),id='req_null_retry_recorded';submit(f,id,null);
  const first=claim(f,id);
  f.store.db.prepare('UPDATE claims SET connection_id=? WHERE request_id=?').run('recorded-connection',id);
  assert.equal(f.store.connectionIsLive,null,'exercise the early return in assertLiveConnection');
  const before=mutationRows(f,id);
  refusal(()=>claim(f,id),'destination_changed');
  assert.deepEqual(mutationRows(f,id),before);
  assert.equal(f.store.get(id).claim.claim_id,first.claim_id);
});

test('question ask and answer consumption are bound to the holding connection',t=>{
  const f=fixture(t,{declared:false}),id='req_commit_question';
  const live=new Set(['fixture-connection','second-connection']);
  f.set(profile(null,['acme/project'],()=>[...live]));
  f.store.connectionIsLive=c=>live.has(c);
  submit(f,id,null);
  const claim=f.store.claim(id,'same','subject',100,null,'alpha','same',10,null,'fixture-connection');
  refusal(()=>f.store.askQuestion(id,claim.claim_id,'Q1','why','subject','alpha',null,'second-connection'),'connection_not_live');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM job_questions WHERE request_id=?').get(id).n,0);
  f.store.askQuestion(id,claim.claim_id,'Q1','why','subject','alpha',null,'fixture-connection');
  f.store.answerQuestion(id,'Q1','because');
  const before=mutationRows(f,id),questions=f.store.db.prepare('SELECT * FROM job_questions WHERE request_id=?').all(id);
  refusal(()=>f.store.consumeAnswer(id,claim.claim_id,'Q1','subject','alpha',null,'second-connection'),'connection_not_live');
  assert.deepEqual(mutationRows(f,id),before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM job_questions WHERE request_id=?').all(id),questions);
  assert.equal(f.store.consumeAnswer(id,claim.claim_id,'Q1','subject','alpha',null,'fixture-connection').answer,'because');
});

test('NULL stored connection cannot be recovered by a built-in retry',t=>{
  const f=fixture(t,{declared:false}),id='req_null_retry_builtin';submit(f,id,null);
  f.store.connectionIsLive=c=>c==='fixture-connection';
  const first=claimWithConnection(f,id,'fixture-connection');
  f.store.db.prepare('UPDATE claims SET connection_id=NULL WHERE request_id=?').run(id);
  const before=mutationRows(f,id);
  refusal(()=>claimWithConnection(f,id,'fixture-connection'),'destination_changed');
  assert.deepEqual(mutationRows(f,id),before);
  assert.equal(f.store.get(id).claim.claim_id,first.claim_id);
});

test('connection mutation fence does not consult changed destination policy',t=>{
  const f=fixture(t,{declared:false}),id='req_commit_no_readmission';submit(f,id,null);
  f.store.connectionIsLive=c=>c==='fixture-connection';
  const claim=claimWithConnection(f,id,'fixture-connection');
  f.store.destinationProfile=()=>{throw new Error('must not reload policy');};
  assert.equal(f.store.progress(id,claim.claim_id,'ok','subject',false,'alpha',null,null,'fixture-connection').recorded,true);
  assert.ok(f.store.finish(id,claim.claim_id,'completed','ok','ok','subject',null,'alpha',null,null,'fixture-connection').receipt_id);
});

test('external OAuth mutations without a connection remain compatible',t=>{
  const f=fixture(t,{declared:false}),id='req_external_mutation';submit(f,id,null);
  const first=claim(f,id);
  assert.equal(f.store.progress(id,first.claim_id,'ok','subject',false,'alpha').recorded,true);
  assert.ok(f.store.finish(id,first.claim_id,'completed','ok','ok','subject',null,'alpha').receipt_id);
});


// ---- Complete fence, Store level: the choke point, the workspace pre-check, the note cursor, cancelled finish ------
// Every refusal compares every table row for the assignment (fullSnapshot), not only the error code.
const snapshotOf=(f,id)=>fullSnapshot(f.store.db,id);
function heldFixture(t,{native,id,mode='live'}) {
  const f=fixture(t,{declared:false}),live=new Set(['fixture-connection','second-connection']);
  f.set(profile(null,['acme/project'],()=>[...live]));
  f.store.connectionIsLive=c=>live.has(c);
  submit(f,id,null,native?nativeJob:{});
  const claim=f.store.claim(id,'same','subject',100,null,'alpha','same',10,native?{key:'claim',revision:1}:null,'fixture-connection');
  if(mode==='null-stored')f.store.db.prepare('UPDATE claims SET connection_id=NULL WHERE request_id=?').run(id);
  if(mode==='revoked')live.delete('fixture-connection');
  return {f,claim,live,caller:mode==='second-live'?'second-connection':'fixture-connection'};
}

for(const mode of ['second-live','null-stored','revoked','omitted']) test('protocolMutationInTransaction is the native choke point: '+mode+' is refused before the command runs',t=>{
  const id='req_choke_'+mode.replaceAll('-','_'),{f,claim,caller}=heldFixture(t,{native:true,id,mode:mode==='omitted'?'live':mode});
  let ran=0;
  const run=connection=>f.store.transaction(()=>f.store.protocolMutationInTransaction(id,claim.claim_id,'subject','alpha',
    {key:'choke-'+mode,revision:claim.revision,operation:'upload',args:{}},()=>{ran++;return {ok:true};},connection));
  const before=snapshotOf(f,id);
  refusal(()=>run(mode==='omitted'?undefined:caller),'connection_not_live');
  assert.equal(ran,0,'the mutation callback never ran');
  assert.deepEqual(snapshotOf(f,id),before);
});
test('protocolMutationInTransaction: the holding live connection runs the command once',t=>{
  const id='req_choke_control',{f,claim}=heldFixture(t,{native:true,id});
  let ran=0;
  const receipt=f.store.transaction(()=>f.store.protocolMutationInTransaction(id,claim.claim_id,'subject','alpha',
    {key:'choke-control',revision:claim.revision,operation:'upload',args:{}},()=>{ran++;return {ok:true};},'fixture-connection'));
  assert.equal(ran,1);assert.equal(receipt.revision,claim.revision+1);
});
test('protocolMutationInTransaction: an external-OAuth caller (no connection, no liveness callback) is unchanged',t=>{
  const f=fixture(t,{declared:false}),id='req_choke_external';submit(f,id,null,nativeJob);
  const claim=f.store.claim(id,'same','subject',100,null,'alpha','same',10,{key:'claim',revision:1});
  let ran=0;
  f.store.transaction(()=>f.store.protocolMutationInTransaction(id,claim.claim_id,'subject','alpha',
    {key:'choke-external',revision:claim.revision,operation:'upload',args:{}},()=>{ran++;return {ok:true};}));
  assert.equal(ran,1);
});

for(const native of [false,true]) for(const mode of ['second-live','null-stored','revoked'])
test('assertWorkerConnection (workspace tools) refuses '+mode+' and writes nothing ('+(native?'native':'legacy')+')',t=>{
  const id='req_ws_pre_'+mode.replaceAll('-','_')+'_'+native,{f,claim,caller}=heldFixture(t,{native,id,mode});
  const before=snapshotOf(f,id);
  refusal(()=>f.store.assertWorkerConnection(id,claim.claim_id,'subject','alpha',caller),'connection_not_live');
  assert.deepEqual(snapshotOf(f,id),before);
});
test('assertWorkerConnection: the live holder passes; an unknown or expired claim is left to the tool\'s own error',t=>{
  const id='req_ws_pre_control',{f,claim}=heldFixture(t,{native:true,id}),before=snapshotOf(f,id);
  f.store.assertWorkerConnection(id,claim.claim_id,'subject','alpha','fixture-connection');
  f.store.assertWorkerConnection(id,'not-a-claim','subject','alpha','second-connection');
  f.store.assertWorkerConnection(id,claim.claim_id,'other-subject','alpha','second-connection');
  f.clock(3600*1000);
  f.store.assertWorkerConnection(id,claim.claim_id,'subject','alpha','second-connection');
  assert.deepEqual(snapshotOf(f,id),before);
});

for(const native of [false,true]) {
  const mode=native?'native':'legacy';
  for(const bad of ['second-live','null-stored','revoked']) test('note cursor does not move for '+bad+' ('+mode+')',t=>{
    const id='req_cursor_'+bad.replaceAll('-','_')+'_'+mode,{f,caller}=heldFixture(t,{native,id,mode:bad});
    f.store.note(id,'owner note after the claim');
    const before=snapshotOf(f,id);
    assert.equal(f.store.markNotesSeenByHolder(id,'subject','alpha',caller),false);
    assert.deepEqual(snapshotOf(f,id),before);
    assert.equal(before.claims[0].last_seen_note_seq,0);
  });
  test('note cursor: only the live holding connection moves it, and only that column ('+mode+')',t=>{
    const id='req_cursor_control_'+mode,{f}=heldFixture(t,{native,id});
    f.store.note(id,'one');f.store.note(id,'two');
    const before=snapshotOf(f,id);
    assert.equal(f.store.markNotesSeenByHolder(id,'subject','alpha','fixture-connection'),true);
    const after=snapshotOf(f,id);
    assert.equal(after.claims[0].last_seen_note_seq,2);
    assert.deepEqual(changedColumns(before.claims[0],after.claims[0]),['last_seen_note_seq']);
    for(const table of Object.keys(before).filter(x=>x!=='claims'))assert.deepEqual(after[table],before[table],table);
  });
  test('note cursor: a rolled-back caller transaction takes the cursor back with it ('+mode+')',t=>{
    const id='req_cursor_tx_'+mode,{f}=heldFixture(t,{native,id});
    f.store.note(id,'one');
    assert.throws(()=>f.store.transaction(()=>{
      assert.equal(f.store.markNotesSeenByHolder(id,'subject','alpha','fixture-connection'),true);
      throw new Error('roll back');
    }),/roll back/);
    assert.equal(snapshotOf(f,id).claims[0].last_seen_note_seq,0);
  });
}
test('note cursor: external OAuth (no connection, no liveness callback) still advances',t=>{
  const f=fixture(t,{declared:false}),id='req_cursor_external';submit(f,id,null);claim(f,id);f.store.note(id,'one');
  assert.equal(f.store.markNotesSeenByHolder(id,'subject','alpha',null),true);
  assert.equal(snapshotOf(f,id).claims[0].last_seen_note_seq,1);
});
test('note cursor: no active claim moves nothing',t=>{
  const f=fixture(t,{declared:false}),id='req_cursor_noclaim';submit(f,id,null);f.store.note(id,'one');
  f.store.connectionIsLive=()=>true;
  const before=snapshotOf(f,id);
  assert.equal(f.store.markNotesSeenByHolder(id,'subject','alpha','fixture-connection'),false);
  assert.deepEqual(snapshotOf(f,id),before);assert.deepEqual(before.claims,[]);
});

for(const native of [false,true]) test('cancelled assignment: a late finish is fenced to the holding connection ('+(native?'native':'legacy')+')',t=>{
  const id='req_cancelled_late_'+native,{f,claim,live}=heldFixture(t,{native,id});
  if(native)f.store.db.prepare("UPDATE assignments SET status='cancelled',cancelled_reason='owner' WHERE request_id=?").run(id);
  else f.store.cancel(id,'owner');
  const ctx=native?{key:'late',revision:claim.revision,args:{artifact_ids:[]}}:null;
  const send=connection=>f.store.finish(id,claim.claim_id,'completed','late summary',native?nativeResult:'late result','subject',null,'alpha',ctx,null,connection);
  const late=()=>f.store.db.prepare('SELECT count(*) n FROM late_evidence WHERE request_id=?').get(id).n;
  const before=snapshotOf(f,id);
  refusal(()=>send('second-connection'),'connection_not_live');
  assert.deepEqual(snapshotOf(f,id),before);assert.equal(late(),0);
  live.delete('fixture-connection');
  refusal(()=>send('fixture-connection'),'connection_not_live');
  assert.deepEqual(snapshotOf(f,id),before);assert.equal(late(),0);
  live.add('fixture-connection');
  assert.throws(()=>send('fixture-connection'),error=>JSON.parse(error.message).error==='assignment_cancelled');
  assert.equal(late(),1,'the live holder\'s late evidence is kept');
});

// Store.finish never routes a cancelled native job into finishProtocol, but finishProtocol keeps its own cancelled branch.
test('finishProtocol called directly on a cancelled native job keeps the connection fence',t=>{
  const id='req_cancelled_direct',{f,claim,live}=heldFixture(t,{native:true,id});
  f.store.db.prepare("UPDATE assignments SET status='cancelled',cancelled_reason='owner' WHERE request_id=?").run(id);
  const send=connection=>finishProtocol(f.store,id,claim.claim_id,'completed','late summary',nativeResult,'subject',null,'alpha',
    {key:'late-direct',revision:claim.revision,args:{artifact_ids:[]}},null,connection);
  const late=()=>f.store.db.prepare('SELECT count(*) n FROM late_evidence WHERE request_id=?').get(id).n;
  const before=snapshotOf(f,id);
  refusal(()=>send('second-connection'),'connection_not_live');
  live.delete('fixture-connection');refusal(()=>send('fixture-connection'),'connection_not_live');
  assert.deepEqual(snapshotOf(f,id),before);assert.equal(late(),0);
  live.add('fixture-connection');
  assert.throws(()=>send('fixture-connection'),error=>JSON.parse(error.message).error==='assignment_cancelled');
  assert.equal(late(),1);
});
