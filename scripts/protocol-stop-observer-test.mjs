import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {migrateProtocolStopObserver,createProtocolStopObserver} from '../src/protocol-stop-observer.mjs';

const dir=mkdtempSync(join(tmpdir(),'protocol-observer-')),file=join(dir,'store.sqlite');
let now=1800000000000,store,observer;
const authority=Object.freeze({observer:true}),evidence=new Map();
const open=()=>new Store(file,{now:()=>now});
const create=()=>createProtocolStopObserver(store,{
  authorize:({authority:a})=>a===authority?'observer-1':null,
  resolveEvidence:async(b,label)=>evidence.get(label)??null
});
function job(id,retention=100000) {
  const p={schema_version:1,request_id:id,brief:'Inert observation fixture',inputs:[],
    execution_scope:'read-only',expected_output:'evidence',
    protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:now+retention}};
  store.submit(p,{mode:'none'},null,'owner',false,null,'normal',null,p,null,'dot','worker');
  const c=store.claim(id,'fixture','subject',20,null,'dot','acq-'+id,1000,
    {key:'claim',revision:store.protocolRevision(id),epoch:0});
  const b=observer.enroll(id,authority,{claim:c.claim_id,epoch:c.epoch,invocation:'invocation-'+id,scope:'inert-test-execution'});
  return {id,c,b};
}
const input=(id,key,stop='confirmed',label='E1')=>({key,revision:store.protocolRevision(id),stop,evidence:label});
function snapshot(id) {
  return JSON.stringify({
    assignment:store.db.prepare('SELECT * FROM assignments WHERE request_id=?').get(id),
    claim:store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),
    revision:store.protocolRevision(id),events:store.protocolFacts(id),
    observations:store.db.prepare('SELECT * FROM protocol_stop_observations WHERE job=?').all(id),
    receipts:store.db.prepare('SELECT * FROM protocol_stop_receipts WHERE job=? ORDER BY command_key').all(id),
    reports:store.db.prepare('SELECT * FROM reports WHERE request_id=?').all(id)});
}
async function refused(id,fn,pattern) {const before=snapshot(id);await assert.rejects(fn,pattern);assert.equal(snapshot(id),before);}
const valid=b=>({binding:{...b},verified:true,stopped:true,remaining_pids:[]});
try {
  store=open();const version=store.db.prepare('PRAGMA user_version').get().user_version;
  store.transaction(()=>migrateProtocolStopObserver(store.db));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,version);
  observer=create();
  const {id,c,b}=job('stop-observation');
  assert.equal(observer.getObservation(id),null);
  store.cancel(id,'cancel',{key:'cancel',revision:store.protocolRevision(id)},'owner');
  const terminal=store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id);
  const originalClaim=store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
  store.db.close();store=open();observer=create();
  assert.equal(observer.getObservation(id),null);
  await refused(id,()=>observer.observeStop(id,'W1',input(id,'forged')),/unauthorized/);
  await refused(id,()=>observer.observeStop(id,authority,{...input(id,'extra'),principal:'service'}),/invalid_input/);
  await refused(id,()=>observer.observeStop(id,authority,input(id,'bare')),/stop_evidence_invalid/);
  evidence.set('E1',valid(b));
  for(const [key,value] of [['job','wrong'],['claim','wrong'],['epoch',c.epoch+1],
      ['invocation','wrong'],['scope','wrong'],['observer','wrong']]) {
    evidence.set('bad',{...valid(b),binding:{...b,[key]:value}});
    await refused(id,()=>observer.observeStop(id,authority,input(id,'wrong-'+key,'confirmed','bad')),/stop_evidence_invalid/);
  }
  evidence.set('bad',{...valid(b),verified:false});
  await refused(id,()=>observer.observeStop(id,authority,input(id,'unverified-proof','confirmed','bad')),/stop_evidence_invalid/);
  evidence.set('bad',{...valid(b),remaining_pids:[42]});
  await refused(id,()=>observer.observeStop(id,authority,input(id,'survivor','confirmed','bad')),/stop_evidence_invalid/);
  await refused(id,()=>observer.observeStop(id,authority,{...input(id,'stale'),revision:0}),/revision_conflict/);
  const realEvent=store.protocolEventInTransaction;
  store.protocolEventInTransaction=function(...args){realEvent.apply(this,args);throw Error('injected-commit-failure');};
  await refused(id,()=>observer.observeStop(id,authority,input(id,'rollback')),/injected-commit-failure/);
  store.protocolEventInTransaction=realEvent;
  now+=1001; // A terminal enrolled observation does not revive or require a live lease.
  const cmd=input(id,'confirmed'),beforeRevision=store.protocolRevision(id),beforeEvents=store.protocolFacts(id).length;
  const reply=await observer.observeStop(id,authority,cmd);
  assert.equal(reply.revision,beforeRevision+1);assert.equal(reply.stop,'confirmed');
  assert.equal(store.protocolFacts(id).length,beforeEvents+1);
  assert.equal(store.protocolFacts(id).at(-1).type,'stop_observed');
  assert.equal(store.protocolFacts(id).at(-1).state,'cancelled');
  assert.equal(observer.getObservation(id).scope,'inert-test-execution');
  assert.deepEqual(store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id),terminal);
  assert.deepEqual(store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),originalClaim);
  assert.equal(store.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(id).n,0);
  const after=snapshot(id);
  assert.deepEqual(await observer.observeStop(id,authority,cmd),reply);assert.equal(snapshot(id),after);
  await refused(id,()=>observer.observeStop(id,authority,{...cmd,evidence:'other'}),/command_conflict/);
  evidence.set('running',{binding:b,verified:true,stopped:false,remaining_pids:[42]});
  await refused(id,()=>observer.observeStop(id,authority,input(id,'regress','unverified','running')),/stop_regression/);
  store.db.close();store=open();observer=create();
  assert.equal(observer.getObservation(id).stop,'confirmed');
  assert.deepEqual(await observer.observeStop(id,authority,cmd),reply);
  await refused(id,()=>observer.observeStop(id,{},cmd),/unauthorized/);
  const next=job('new-epoch');
  now+=1001;
  const c2=store.claim(next.id,'next','subject',20,null,'dot','next-acq',1000,
    {key:'next',revision:store.protocolRevision(next.id),epoch:next.c.epoch});
  evidence.set('old',valid(next.b));
  await refused(next.id,()=>observer.observeStop(next.id,authority,input(next.id,'old','confirmed','old')),/stale_observer/);
  assert.equal(observer.getObservation(next.id),null);
  observer.enroll(next.id,authority,{claim:c2.claim_id,epoch:c2.epoch,invocation:'new-invocation',scope:'inert-test-execution'});
  assert.equal(observer.getObservation(next.id),null);
  now+=100001;
  await assert.rejects(()=>observer.observeStop(id,authority,cmd),/tombstone|retention|expired/i);
  console.log('PASS inert native stop observer authority, evidence, CAS, restart, rollback and retention; no physical cessation claim');
} finally {store?.db.close();rmSync(dir,{recursive:true,force:true});}
