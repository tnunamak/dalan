// Node24, isolated native Store only. No HTTP/catalog/conformance claim.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
const dir=mkdtempSync(join(tmpdir(),'native-protocol-')),file=join(dir,'isolated.sqlite'),base=Date.UTC(2026,0,1);
let store,now=base;
const protocol={profile:'job-v0',source:'git:BASE',scope:'read:fixture',policy:'P0',destination:'owner-inbox',retain_until_ms:base+100000};
const payload=id=>({schema_version:1,request_id:id,brief:'Native command test',inputs:[],execution_scope:'read-only',expected_output:'fixture',protocol:{...protocol}});
const subject='subject',worker='dot',owner='owner-capability';
try{
 const open=()=>new Store(file,{now:()=>now});
 store=open();
 assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,65);
 const submit=p=>store.submit(p,{mode:'none'},null,owner,false,null,'normal',null,p,null,worker,'worker');
 const claim=(id,key,revision,acquisition='acquisition',lease=100,who=subject,w=worker)=>store.claim(id,'fixture',who,10,null,w,acquisition,lease,{key,revision});
 const row=id=>store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
 const snapshot=id=>JSON.stringify({
   claim:row(id),events:store.protocolFacts(id),revision:store.protocolRevision(id),
   receipts:store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=? ORDER BY command_key').all(id),
   progress:store.db.prepare('SELECT * FROM progress WHERE request_id=? ORDER BY id').all(id),
   lifecycle:store.db.prepare('SELECT * FROM lifecycle_events WHERE request_id=? ORDER BY id').all(id)});
 // A submitted protocol identity must share rollback with registration and keyed receipt.
 const failing=payload('submit-rollback'),originalEvent=store.protocolEventInTransaction;
 store.protocolEventInTransaction=function(...args){const seq=originalEvent.apply(this,args);throw Error('submit-rollback');};
 assert.throws(()=>submit(failing),/submit-rollback/);
 store.protocolEventInTransaction=originalEvent;
 assert.equal(store.hasAssignment(failing.request_id),false);assert.equal(store.isProtocolJob(failing.request_id),false);
 const rollbackPayload=payload('claim-rollback');submit(rollbackPayload);
 const beforeClaim=snapshot(rollbackPayload.request_id);
 store.protocolEventInTransaction=function(...args){const seq=originalEvent.apply(this,args);throw Error('claim-rollback');};
 assert.throws(()=>claim(rollbackPayload.request_id,'claim-rollback',1),/claim-rollback/);
 store.protocolEventInTransaction=originalEvent;
 assert.equal(snapshot(rollbackPayload.request_id),beforeClaim);
 const p=payload('strict');submit(p);
 assert.equal(store.isProtocolJob(p.request_id),true);assert.deepEqual(store.getProtocol(p.request_id),protocol);
 assert.equal(store.protocolRevision(p.request_id),1);
 assert.deepEqual(store.protocolFacts(p.request_id).map(e=>[e.seq,e.type,e.epoch]),[[1,'submitted',0]]);
 for(const bad of [{...protocol,extra:true},{...protocol,retain_until_ms:-1},{...protocol,source:''},{...protocol,profile:'other'}]){
   const invalid={...payload('invalid'),protocol:bad};assert.throws(()=>submit(invalid),/invalid_protocol/);
   assert.equal(store.hasAssignment('invalid'),false);assert.equal(store.isProtocolJob('invalid'),false);
 }
 assert.throws(()=>store.claim(p.request_id,'fixture',subject,10,null,worker,'a',100),/command_context_required/);
 assert.throws(()=>claim(p.request_id,'stale-first',0),/revision_conflict/);
 assert.equal(row(p.request_id),undefined);
 const first=claim(p.request_id,'first',1);
 assert.equal(first.revision,2);assert.equal(first.epoch,1);
 assert.equal(Date.parse(row(p.request_id).lease_deadline_at),base+100);
 const firstState=snapshot(p.request_id);
 assert.deepEqual(claim(p.request_id,'first',1),first);assert.equal(snapshot(p.request_id),firstState);
 assert.throws(()=>claim(p.request_id,'first',1,'different'),/command_conflict/);
 assert.throws(()=>claim(p.request_id,'first',1,'acquisition',100,'other'),/stale_authority/);
 assert.throws(()=>claim(p.request_id,'first',1,'acquisition',100,subject,'other'),/assignment not found/);
 assert.throws(()=>claim(p.request_id,'stale-busy',1,'different'),/revision_conflict/);
 assert.throws(()=>claim(p.request_id,'current-busy',2,'different'),/claim_busy/);
 assert.equal(snapshot(p.request_id),firstState);
 now=base+20;
 const renewCtx={key:'renew',revision:2,epoch:first.epoch};
 const renewed=store.renewClaim(p.request_id,first.claim_id,100,renewCtx,subject,worker);
 assert.equal(renewed.leaseUntil,base+120);assert.equal(renewed.revision,3);
 assert.equal(Date.parse(store.leaseExpiresAt(row(p.request_id))),base+120);
 now=base+50;
 const before=snapshot(p.request_id);
 assert.deepEqual(store.renewClaim(p.request_id,first.claim_id,100,renewCtx,subject,worker),renewed);
 assert.equal(snapshot(p.request_id),before);
 for(const [c,who,w]of [[{...renewCtx,epoch:99},subject,worker],[renewCtx,'wrong',worker],[renewCtx,subject,'other']]){
   assert.throws(()=>store.renewClaim(p.request_id,first.claim_id,100,c,who,w));assert.equal(snapshot(p.request_id),before);
 }
 assert.throws(()=>store.renewClaim(p.request_id,'wrong',100,renewCtx,subject,worker));
 assert.throws(()=>store.renewClaim(p.request_id,first.claim_id,99,renewCtx,subject,worker),/command_conflict/);
 assert.throws(()=>store.renewClaim(p.request_id,first.claim_id,100,{key:'bad-cas',revision:2},subject,worker),/revision_conflict/);
 assert.equal(snapshot(p.request_id),before);
 const progressCtx={key:'progress',revision:3,epoch:first.epoch};
 const progress=store.progress(p.request_id,first.claim_id,'Working',subject,false,worker,null,progressCtx);
 assert.equal(progress.revision,4);assert.equal(Date.parse(store.leaseExpiresAt(row(p.request_id))),base+120);
 const afterProgress=snapshot(p.request_id);
 assert.deepEqual(store.progress(p.request_id,first.claim_id,'Working',subject,false,worker,null,progressCtx),progress);
 assert.equal(snapshot(p.request_id),afterProgress);
 assert.throws(()=>store.transaction(()=>store.protocolMutationInTransaction(p.request_id,first.claim_id,subject,worker,
   {key:'rollback',revision:4,operation:'progress',args:{note:'rollback'}},()=>{
     store.progressInTransaction(p.request_id,first.claim_id,'rollback',subject,false,worker);
     store.protocolEventInTransaction(p.request_id,'progressed',{note:'rollback'},first.epoch);
     throw Error('injected-rollback');
   })),/injected-rollback/);
 assert.equal(snapshot(p.request_id),afterProgress);
 const factsBefore=store.protocolFacts(p.request_id).length;
 store.transaction(()=>store.protocolEventInTransaction(p.request_id,'observed',{fixture:true},first.epoch));
 assert.equal(store.protocolRevision(p.request_id),4,'facts do not imply command revisions');
 assert.equal(store.protocolFacts(p.request_id).length,factsBefore+1);
 const q=store.askQuestion(p.request_id,first.claim_id,'q','Which fixture?',subject,worker,{key:'ask',revision:4});
 assert.equal(q.revision,5);assert.equal(store.protocolFacts(p.request_id).at(-1).type,'questioned');
 assert.equal(Date.parse(store.leaseExpiresAt(row(p.request_id))),base+120);
 store.db.close();store=open();
 assert.deepEqual(store.renewClaim(p.request_id,first.claim_id,100,renewCtx,subject,worker),renewed);
 now=base+120;
 const expired=snapshot(p.request_id);
 assert.throws(()=>store.renewClaim(p.request_id,first.claim_id,100,renewCtx,subject,worker),/lease_expired/);
 assert.equal(snapshot(p.request_id),expired);
 const successor=claim(p.request_id,'successor',5,'successor',100);
 assert.equal(successor.epoch,2);assert.equal(Date.parse(row(p.request_id).lease_deadline_at),base+220);
 assert.throws(()=>claim(p.request_id,'first',1),/stale_authority/);
 // Abandon cannot shorten fixed deadline; explicit resume still needs cessation/expiry.
 store.abandon(p.request_id);
 assert.equal(store.protocolRevision(p.request_id),7);
 assert.equal(store.protocolFacts(p.request_id).at(-1).type,'abandoned');
 assert.equal(Date.parse(row(p.request_id).lease_deadline_at),base+220);
 assert.throws(()=>claim(p.request_id,'too-early',7,'third'),/claim_busy/);
 now=base+220;const third=claim(p.request_id,'third',7,'third',100);
 assert.equal(third.epoch,3);assert.equal(Date.parse(row(p.request_id).lease_deadline_at),base+320);
 now=base+320;store.resume(p.request_id,subject);
 assert.equal(Date.parse(row(p.request_id).lease_deadline_at),base+420);
 // Existing arbitrary payload metadata must never silently become strict registration.
 const historical=payload('historical');delete historical.protocol;submit(historical);
 store.db.prepare('UPDATE assignments SET payload=? WHERE request_id=?').run(JSON.stringify({...historical,protocol}),historical.request_id);
 store.db.close();store=open();
 assert.equal(store.isProtocolJob(historical.request_id),false);
 assert.equal(store.protocolRevision(historical.request_id),null);
 // Legacy stays unregistered and sliding, including across reopen.
 const legacy=payload('legacy');delete legacy.protocol;submit(legacy);
 const c=store.claim('legacy','fixture',subject,10,null,worker,'legacy',100);
 assert.equal(Date.parse(row('legacy').lease_deadline_at),now+100);assert.equal(store.isProtocolJob('legacy'),false);
 now+=20;store.touchClaim('legacy',c.claim_id,subject,worker);
 assert.equal(Date.parse(store.leaseExpiresAt(row('legacy'))),now+100);
 assert.equal(store.protocolRevision('legacy'),null);assert.deepEqual(store.protocolFacts('legacy'),[]);
 console.log('Native strict command assertions passed; HTTP and full comparator pending');
}finally{store?.db.close();rmSync(dir,{recursive:true,force:true});}
