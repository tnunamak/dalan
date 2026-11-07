// Node24, real Store: progress, revision and receipt share one transaction.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {migrateClaimCommands,createClaimCommands} from '../src/claim-command-ledger.mjs';
const dir=mkdtempSync(join(tmpdir(),'claim-native-'));
const file=join(dir,'store.sqlite'),base=Date.UTC(2026,0,1);
let now=base,store;
try {
  const open=()=>new Store(file,{now:()=>now});
  store=open();
  const payload={schema_version:1,request_id:'native-command',brief:'Offline regression',
    inputs:[],execution_scope:'read-only',expected_output:'fixture'};
  store.submit(payload,{mode:'none'},null,'offline-owner',false,null,'normal',null,payload,null,'dot','worker');
  const grant=store.claim(payload.request_id,'fixture','native-subject',10,null,'dot','native-acquisition',100);
  const schema=store.db.prepare('PRAGMA user_version').get().user_version;
  store.transaction(()=>migrateClaimCommands(store.db));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,schema);
  const native=()=>store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(payload.request_id);
  const create=()=>createClaimCommands({db:store.db,clock:()=>now,maxLeaseMs:100,
    authorize:c=>{
      const row=store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(c.job);
      if(!row)return null;
      return {job:row.request_id,subject:row.subject,worker:row.worker,claim:row.claim_id,
        epoch:row.epoch,active:row.state==='active'&&store.get(c.job).status==='claimed',
        leaseUntil:Date.parse(store.leaseExpiresAt(row))};
    }});
  let api=create();
  // Local component revision begins after a REAL native claim. No first-claim CAS claim.
  store.transaction(()=>api.initialize(payload.request_id,2));
  const c={job:payload.request_id,subject:native().subject,worker:native().worker,
    claim:grant.claim_id,epoch:grant.epoch,operation:'renew',key:'renew-once',expectedRevision:2,args:{leaseMs:100}};
  let calls=0;
  const renew=({command,leaseUntil})=>{
    // Existing in-transaction native touch uses this claim's fixed 100ms lease.
    // Variable lease changes need a distinct native hook, not SQL fabrication here.
    store.assertClaim(command.job,command.claim,command.subject,command.worker);
    assert.equal(native().lease_ms,command.args.leaseMs);
    store.touchClaim(command.job,command.claim,command.subject,command.worker);
    assert.equal(Date.parse(store.leaseExpiresAt(native())),leaseUntil);
    calls++;return {claim:command.claim,leaseUntil};
  };
  const snapshot=()=>JSON.stringify({
    claim:native(),receipts:store.db.prepare('SELECT * FROM claim_command_receipts ORDER BY job,command_key').all(),
    revisions:store.db.prepare('SELECT * FROM claim_command_revisions ORDER BY job').all(),
    progress:store.db.prepare('SELECT * FROM progress ORDER BY id').all(),
    events:store.db.prepare('SELECT * FROM lifecycle_events ORDER BY rowid').all(),
    reports:store.db.prepare('SELECT * FROM reports ORDER BY request_id').all()
  });
  assert.equal(Date.parse(store.leaseExpiresAt(native())),base+100);
  now=base+20;
  const first=store.transaction(()=>api.execute(c,renew));
  assert.equal(first.leaseUntil,base+120);assert.equal(first.revision,3);
  now=base+50;const beforeReplay=snapshot();
  assert.deepEqual(store.transaction(()=>api.execute({...c},renew)),first);
  assert.equal(snapshot(),beforeReplay);assert.equal(calls,1);
  for(const wrong of [{...c,worker:'other-worker'},{...c,epoch:c.epoch+1},
      {...c,subject:'other-subject'},{...c,claim:'other-claim'}]) {
    const before=snapshot();
    assert.throws(()=>store.transaction(()=>api.execute(wrong,renew)),/stale_authority/);
    assert.equal(snapshot(),before);
  }
  assert.throws(()=>store.transaction(()=>api.execute({...c,args:{leaseMs:99}},renew)),/command_conflict/);
  assert.throws(()=>store.transaction(()=>api.execute({...c,key:'stale-revision'},renew)),/revision_conflict/);
  let before=snapshot();
  assert.throws(()=>store.transaction(()=>{
    api.execute({...c,key:'rolled-back',expectedRevision:3},renew);throw Error('rollback-native');
  }),/rollback-native/);
  assert.equal(snapshot(),before);
  assert.equal(Date.parse(store.leaseExpiresAt(native())),base+120);
  store.db.close();store=open();api=create();
  assert.deepEqual(store.transaction(()=>api.execute(c,renew)),first);
  assert.equal(api.revision(c.job),3);
  now=base+120;before=snapshot();
  assert.throws(()=>store.transaction(()=>api.execute(c,renew)),/lease_expired/);
  assert.equal(snapshot(),before);
  // New independent job, so time stays monotone and no expired grant is revived.
  const other={...payload,request_id:'native-progress'};
  store.submit(other,{mode:'none'},null,'offline-owner',false,null,'normal',null,other,null,'dot','worker');
  const next=store.claim(other.request_id,'fixture','native-subject',10,null,'dot','progress-acquisition',100);
  store.transaction(()=>api.initialize(other.request_id,2));
  const progress={job:other.request_id,subject:'native-subject',worker:'dot',
    claim:next.claim_id,epoch:next.epoch,operation:'progress',key:'progress-once',expectedRevision:2,args:{note:'fixture progress'}};
  const beforeEvents=store.db.prepare('SELECT * FROM lifecycle_events ORDER BY rowid').all();
  assert.equal(typeof store.progressInTransaction,'function','native progress must support a caller-owned transaction');
  const mutateProgress=({command})=>store.progressInTransaction(command.job,command.claim,command.args.note,command.subject,false,command.worker);
  assert.throws(()=>mutateProgress({command:progress}),/caller-owned transaction/);
  const progressed=store.transaction(()=>api.execute(progress,mutateProgress));
  assert.equal(progressed.revision,3);
  assert.equal(api.revision(other.request_id),3);
  assert.equal(store.db.prepare('SELECT count(*) n FROM claim_command_receipts WHERE job=?').get(other.request_id).n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM progress WHERE request_id=?').get(other.request_id).n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM lifecycle_events').get().n,beforeEvents.length+1);
  const committed=snapshot();
  assert.deepEqual(store.transaction(()=>api.execute(progress,mutateProgress)),progressed);
  assert.equal(snapshot(),committed,'exact receipt retry cannot append progress or lifecycle facts');
  assert.throws(()=>store.transaction(()=>api.execute({...progress,key:'rollback-progress',expectedRevision:3},context=>{
    mutateProgress(context);throw Error('rollback-progress');
  })),/rollback-progress/);
  assert.equal(snapshot(),committed,'native mutation, event, revision and receipt roll back together');
  console.log('native claim-command integration passed');
} finally {store?.db.close();rmSync(dir,{recursive:true,force:true});}
