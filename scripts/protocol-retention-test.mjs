import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {defineProtocolRetentionInTransaction as define,assertProtocolAvailable as guard,
  expireProtocolRetentionInTransaction as expire} from '../src/protocol-retention.mjs';
import {createJobRetention} from '../src/job-retention.mjs';
const dir=mkdtempSync(join(tmpdir(),'protocol-retention-')),file=join(dir,'isolated.sqlite');
let now=1800000000000,store;
const owner='offline-retention-owner',subject='offline-subject';
const open=()=>new Store(file,{now:()=>now});
function payload(id,deadline) {
  return {schema_version:1,request_id:id,brief:'Offline retention regression',inputs:[],scope_paths:[],
    execution_scope:'analysis',expected_output:'evidence',
    protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:deadline}};
}
function submit(p) {
  return store.submit(p,{mode:'none'},null,owner,false,null,'normal',null,p,null,'dot','worker');
}
function claim(id) {
  return store.claim(id,'offline-claimant',subject,20,null,'dot','acquisition-'+id,10000,
    {key:'claim-'+id,revision:store.protocolRevision(id)});
}
const tomb=id=>store.db.prepare('SELECT * FROM job_retention_tombstones WHERE job=?').get(id);
const audit=id=>JSON.stringify({
  assignment:store.db.prepare('SELECT * FROM assignments WHERE request_id=?').get(id),
  claim:store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),
  lifecycle:store.db.prepare('SELECT * FROM lifecycle_events WHERE request_id=? ORDER BY rowid').all(id),
  facts:store.protocolFacts(id),revision:store.protocolRevision(id)});
try {
  store=open();
  const id='deadline',deadline=now+100,original=payload(id,deadline);
  submit(original);const c=claim(id);
  assert.equal(guard(store,id),true,'submit installs its immutable retention policy atomically');
  assert.throws(()=>define(store,id),/transaction_required/);
  // Repeated definition retains the policy installed by native submit.
  store.transaction(()=>define(store,id));
  const policy=store.db.prepare('SELECT * FROM job_retention_policy WHERE job=?').get(id);
  assert.notEqual(policy.owner,owner);
  assert.equal(policy.owner,store.db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(id).owner_hash);
  assert.equal(policy.worker,'dot');assert.equal(policy.retain_until,deadline);
  assert.deepEqual(store.transaction(()=>define(store,id)),{...policy});
  const before=audit(id);
  now=deadline-1;assert.equal(guard(store,id),true);
  assert.deepEqual(store.transaction(()=>expire(store,id)),{deleted:false});
  assert.equal(audit(id),before);
  now=deadline;
  assert.ok(Date.parse(store.leaseExpiresAt(store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id)))>now);
  assert.throws(()=>store.transaction(()=>guard(store,id)),/TOMBSTONE/);
  assert.equal(tomb(id),undefined,'outer rollback removes attempted tombstone');
  assert.equal(audit(id),before,'retention does not invent native lifecycle or stop facts');
  assert.throws(()=>store.transaction(()=>guard(store,id)),/TOMBSTONE/);
  assert.throws(()=>guard(store,id),/TOMBSTONE/);
  assert.equal(tomb(id).native_status,'claimed');assert.equal(tomb(id).purge_pending,1);
  assert.throws(()=>store.note(id,'must not land'),/TOMBSTONE/);
  assert.throws(()=>store.cancelIfQueued(id),/TOMBSTONE/);
  assert.equal(store.ownerNotes(id).length,0);
  assert.equal(audit(id),before,'claim, payload, audit and revision retained');
  store.db.close();store=open();
  assert.throws(()=>guard(store,id),/TOMBSTONE/);
  const saved=JSON.stringify(tomb(id));
  assert.throws(()=>store.transaction(()=>{guard(store,id);submit(original);}),/TOMBSTONE/);
  assert.throws(()=>submit(payload(id,deadline+100000)),/TOMBSTONE/);
  assert.throws(()=>store.transaction(()=>define(store,id)),/TOMBSTONE/);
  assert.equal(JSON.stringify(tomb(id)),saved);assert.equal(audit(id),before);
  const missing='missing-policy';submit(payload(missing,now+1000));claim(missing);
  store.db.prepare('DELETE FROM job_retention_policy WHERE job=?').run(missing);
  assert.throws(()=>guard(store,missing),/retention_not_found/);
  assert.throws(()=>store.transaction(()=>expire(store,missing)),/retention_not_found/);
  // Real component API creates a deliberately mismatched registered policy,
  // modeling integration corruption without fake tables or patched Store methods.
  const wrong='wrong-policy';submit(payload(wrong,now+1000));claim(wrong);
  const row=store.db.prepare('SELECT owner_hash,target_worker FROM assignments WHERE request_id=?').get(wrong);
  store.db.prepare('DELETE FROM job_retention_policy WHERE job=?').run(wrong);
  const component=createJobRetention({db:store.db,clock:()=>now,authorize:()=>true,
    readState:()=>{throw new Error('not used');},fence:()=>false,purge:()=>false});
  store.transaction(()=>component.define({job:wrong,owner:row.owner_hash,worker:row.target_worker,retainUntil:now+2000}));
  assert.throws(()=>guard(store,wrong),/retention_conflict/);
  assert.throws(()=>store.transaction(()=>define(store,wrong)),/retention_conflict/);
  const terminal='terminal';submit(payload(terminal,now+100));const tc=claim(terminal);
  store.transaction(()=>define(store,terminal));
  store.finish(terminal,tc.claim_id,'completed','Finished',JSON.stringify({source:'source',policy:'policy'}),subject,null,'dot',{key:'finish',revision:store.protocolRevision(terminal),epoch:tc.epoch,args:{artifact_ids:[]}});
  const terminalAudit=audit(terminal);now+=100;
  assert.throws(()=>guard(store,terminal),/TOMBSTONE/);
  assert.equal(tomb(terminal).purge_pending,1);
  assert.equal(audit(terminal),terminalAudit);
  assert.equal(store.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(terminal).n,1);
  const legacy={...payload('legacy',now+100)};delete legacy.protocol;submit(legacy);
  assert.equal(guard(store,'legacy'),true);
  assert.equal(store.transaction(()=>define(store,'legacy')),null);
  assert.deepEqual(store.transaction(()=>expire(store,'legacy')),{deleted:false});
  assert.equal(tomb('legacy'),undefined);
  console.log('PASS: native logical retention; native lookup/claim/submit guards and persistent policy');
} finally {store?.db.close();rmSync(dir,{recursive:true,force:true});}
