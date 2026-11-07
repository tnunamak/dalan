// Node 24. Offline real Store/Workspace integration; no HTTP or host execution.
// The final assertion intentionally exposes the missing native journal hook.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateArtifactJournal,createArtifactJournal,artifactBytesDigest as sha} from '../src/artifact-journal.mjs';

const dir=fs.mkdtempSync(join(tmpdir(),'artifact-native-'));
const oldRoot=process.env.DOT_BRIDGE_WORKSPACE_ROOT;
process.env.DOT_BRIDGE_WORKSPACE_ROOT=join(dir,'workspace');
let store;
try {
  // Workspace captures its root at import time. Never import before isolation.
  const {Store}=await import('../src/store.mjs');
  const {Workspace}=await import('../src/workspace.mjs');
  let now=Date.UTC(2026,0,1);
  const file=join(dir,'native.sqlite'),subject='offline-subject',worker='dot';
  const open=()=>new Store(file,{now:()=>now});
  store=open();
  const version=store.db.prepare('PRAGMA user_version').get().user_version;
  store.transaction(()=>migrateArtifactJournal(store.db));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,version);
  let workspace=new Workspace(store,false);
  function job(id) {
    const payload={schema_version:1,request_id:id,brief:'Offline native artifact regression',
      inputs:[],execution_scope:'implementation',expected_output:'fixture only'};
    store.submit(payload,{mode:'none'},null,'offline-owner',false,null,'normal',null,payload,null,'dot','worker');
    return store.claim(id,'offline-claimant',subject,20,null,worker,'acq-'+id,1000);
  }
  const row=(job,alias)=>store.db.prepare("SELECT * FROM artifacts WHERE request_id=? AND COALESCE(client_artifact_id,id)=? AND kind='upload'").get(job,alias);
  function journal() {
    return createArtifactJournal({db:store.db,
      authorize:c=>{
        const grant=store.assertClaim(c.job,c.claim,c.subject,c.worker);
        const state=store.get(c.job);
        return grant.epoch===c.epoch && state.status==='claimed' && !state.cancelled_at;
      },
      inspect:c=>{
        const native=row(c.job,c.artifact);
        if(!native || native.id!==c.reference) return null;
        const bytes=fs.readFileSync(native.path);
        assert.equal(bytes.length,native.size,'native metadata/file extent');
        return {reference:native.id,size:bytes.length,sha256:sha(bytes),
          chunkSha256:c.offset===undefined?undefined:sha(bytes.subarray(c.offset,c.offset+c.chunkSize))};
      }});
  }
  const snapshot=()=>JSON.stringify({
    heads:store.db.prepare('SELECT * FROM artifact_journal_heads ORDER BY job,artifact').all(),
    journal:store.db.prepare('SELECT * FROM artifact_mutation_journal ORDER BY job,artifact,mutation_key').all(),
    events:store.db.prepare('SELECT * FROM lifecycle_events ORDER BY rowid').all(),
    reports:store.db.prepare('SELECT * FROM reports ORDER BY request_id').all(),
    artifacts:store.db.prepare('SELECT * FROM artifacts ORDER BY id').all()
  });
  const grant=job('native-artifact'),alias='art_native_example',bytes=Buffer.from('abc');
  const uploaded=workspace.chunk(grant.request_id,grant.claim_id,subject,alias,0,bytes.toString('base64'),false,undefined,worker);
  assert.equal(uploaded.sealed,false);
  const native=row(grant.request_id,alias);
  assert.equal(native.sealed,0);
  assert.deepEqual(fs.readFileSync(native.path),bytes);
  const command={job:grant.request_id,artifact:alias,key:'upload-1',subject,worker,
    claim:grant.claim_id,epoch:grant.epoch,operation:'upload',reference:native.id,
    offset:0,chunkSize:bytes.length,chunkSha256:sha(bytes),size:bytes.length,sha256:sha(bytes)};
  let j=journal();
  const first=store.transaction(()=>j.record(command));
  assert.deepEqual(store.transaction(()=>j.record({...command})),first);
  let before=snapshot();
  assert.throws(()=>store.transaction(()=>j.record({...command,size:4})),/mutation_conflict/);
  assert.equal(snapshot(),before);
  assert.throws(()=>store.transaction(()=>j.record({...command,key:'wrong-epoch',epoch:grant.epoch+1})),/stale_authority/);
  assert.equal(snapshot(),before);
  // Never wrap Workspace.chunk in another Store transaction: it owns one.
  workspace.chunk(grant.request_id,grant.claim_id,subject,alias,bytes.length,'',true,sha(bytes),worker);
  assert.equal(row(grant.request_id,alias).sealed,1);
  const seal={job:grant.request_id,artifact:alias,key:'seal-1',subject,worker,
    claim:grant.claim_id,epoch:grant.epoch,operation:'seal',reference:native.id,size:bytes.length,sha256:sha(bytes)};
  // Native report/event and component facts really share one SQL transaction.
  // This does NOT roll back the already committed upload bytes.
  before=snapshot();
  assert.throws(()=>store.transaction(()=>{
    j.record(seal);
    store.finishOnce(grant.request_id,grant.claim_id,'completed','fixture','fixture',subject,null,worker);
    throw Error('rollback-native');
  }),/rollback-native/);
  assert.equal(snapshot(),before);
  assert.equal(row(grant.request_id,alias).sealed,1);
  assert.deepEqual(fs.readFileSync(native.path),bytes);
  const sealed=store.transaction(()=>j.record(seal));
  assert.equal(sealed.origin_claim,grant.claim_id);
  assert.equal(sealed.origin_epoch,grant.epoch);
  assert.equal(native.origin_claim_id,grant.claim_id);
  assert.equal(native.origin_epoch,grant.epoch);
  store.db.close();store=open();workspace=new Workspace(store,false);j=journal();
  assert.deepEqual(store.transaction(()=>j.record(seal)),sealed);
  // Cancellation is real native state, not an adapter-local switch.
  store.owner(grant.request_id,'offline-owner');
  store.cancel(grant.request_id,'offline regression');
  before=snapshot();
  assert.throws(()=>store.transaction(()=>j.record(seal)),/stale_authority/);
  assert.equal(snapshot(),before);
  assert.deepEqual(fs.readFileSync(native.path),bytes);
  const expired=job('expired-artifact');
  now+=1000;
  before=snapshot();
  assert.throws(()=>workspace.chunk(expired.request_id,expired.claim_id,subject,'art_expired_example',0,'',false,undefined,worker),/lease_expired/);
  assert.equal(snapshot(),before);

  // The explicit native hook publishes journal facts before the chunk commits.
  // Ordinary legacy uploads are not silently adopted into the protocol journal.
  const boundary=job('native-hook');
  const hook=(key,operation='upload')=>observed=>j.record({
    job:boundary.request_id,artifact:'art_native_hook',key,subject,worker,claim:boundary.claim_id,epoch:boundary.epoch,operation,
    reference:observed.reference,size:observed.size,sha256:observed.sha256,
    ...(operation==='upload'?{offset:observed.offset,chunkSize:observed.chunkSize,chunkSha256:observed.chunkSha256}:{}),
  });
  assert.throws(()=>workspace.chunk(boundary.request_id,boundary.claim_id,subject,'art_native_hook',0,bytes.toString('base64'),false,undefined,worker,observed=>{
    assert(store.db.isTransaction);assert.equal(observed.row.size,3);
    hook('first')(observed);throw Error('injected callback failure');
  }),/injected callback failure/);
  assert.equal(row(boundary.request_id,'art_native_hook'),undefined);
  assert.equal(j.get(boundary.request_id,'art_native_hook'),null);
  workspace.chunk(boundary.request_id,boundary.claim_id,subject,'art_native_hook',0,bytes.toString('base64'),false,undefined,worker,hook('first'));
  assert.equal(row(boundary.request_id,'art_native_hook').size,3,'retry settles the fsynced tail without appending twice');
  const next=Buffer.from('def');
  workspace.chunk(boundary.request_id,boundary.claim_id,subject,'art_native_hook',3,next.toString('base64'),false,undefined,worker,hook('second'));
  assert.equal(j.get(boundary.request_id,'art_native_hook').sha256,sha(Buffer.from('abcdef')),'full-prefix digest is available before seal');
  workspace.chunk(boundary.request_id,boundary.claim_id,subject,'art_native_hook',6,'',true,sha(Buffer.from('abcdef')),worker,hook('seal','seal'));
  assert.equal(j.get(boundary.request_id,'art_native_hook').sealed,true);
  console.log('native artifact journal integration passed');
} finally {
  store?.db.close();
  if(oldRoot===undefined) delete process.env.DOT_BRIDGE_WORKSPACE_ROOT;
  else process.env.DOT_BRIDGE_WORKSPACE_ROOT=oldRoot;
  fs.rmSync(dir,{recursive:true,force:true});
}
