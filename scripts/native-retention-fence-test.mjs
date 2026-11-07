// Node24. Native Store data retained; logical guard integration only, no T38/physical-stop claim.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.mjs';
import {migrateJobRetention,createJobRetention} from '../src/job-retention.mjs';
const dir=mkdtempSync(join(tmpdir(),'native-retention-')),file=join(dir,'isolated.sqlite');
let store,now=Date.UTC(2026,0,1),purges=0,failFence=false;
const token='test-owner-capability',owner=createHash('sha256').update(token).digest('hex'),worker='dot',job='retained-job';
const who={job,owner,worker},payload={schema_version:1,request_id:job,brief:'retained native payload',inputs:[],execution_scope:'read-only',expected_output:'fixture'};
try{
 const open=()=>new Store(file,{now:()=>now});
 store=open();
 store.submit(payload,{mode:'none'},null,token,false,null,'normal',null,payload,null,worker,'worker');
 const claim=store.claim(job,'fixture','subject',10,null,worker,'acquisition',10000);
 const schema=store.db.prepare('PRAGMA user_version').get().user_version;
 store.transaction(()=>migrateJobRetention(store.db));
 assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,schema);
 const create=()=>createJobRetention({db:store.db,clock:()=>now,
   authorize:c=>c.owner===owner&&c.worker===worker&&store.db.prepare('SELECT owner_hash FROM assignments WHERE request_id=?').get(c.job)?.owner_hash===owner,
   readState:id=>{const native=store.get(id);return {status:native.status,compute_stopped:native.compute_stopped};},
   fence:c=>{
     assert.equal(store.db.isTransaction,true);
     const row=store.db.prepare('SELECT * FROM job_retention_tombstones WHERE job=?').get(c.job);
     if(failFence)throw Error('injected-fence-failure');
     return row?.owner===c.owner&&row?.worker===c.worker;
   },
   purge:()=>{purges++;throw Error('physical purge must never be attempted');}});
 let retention=create();
 store.transaction(()=>retention.define({...who,retainUntil:now+100}));
 // Production must put this guard before native lookup AND submit idempotency, after authenticating caller.
 const lookup=()=>{store.owner(job,token);retention.assertAvailable(who);return store.get(job);};
 const resubmit=()=>{store.owner(job,token);retention.assertAvailable(who);return store.submit(payload,{mode:'none'},null,token,false,null,'normal',null,payload,null,worker,'worker');};
 const before=store.get(job),raw=store.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get(job).payload;
 now+=99;assert.equal(lookup().status,'claimed');
 assert.deepEqual(store.transaction(()=>retention.expire(who)),{deleted:false});
 now++;
 assert.throws(lookup,/TOMBSTONE/);assert.throws(resubmit,/TOMBSTONE/);
 failFence=true;assert.throws(()=>store.transaction(()=>retention.expire(who)),/injected-fence-failure/);failFence=false;
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM job_retention_tombstones').get().n,0);
 assert.throws(()=>store.transaction(()=>{retention.expire(who);throw Error('outer-rollback');}),/outer-rollback/);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM job_retention_tombstones').get().n,0);
 const tomb=store.transaction(()=>retention.expire(who));
 assert.equal(tomb.purge_pending,1);
 assert.equal(store.get(job).compute_stopped,false,'logical fence does not assert physical stop');
 assert.equal(store.get(job).status,before.status);
 assert.equal(store.get(job).claim.claim_id,claim.claim_id);
 assert.equal(store.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get(job).payload,raw);
 assert.equal(store.transaction(()=>retention.completePurge(who)).purged,false);assert.equal(purges,0);
 assert.throws(()=>retention.assertAvailable({...who,owner:'other-owner-hash'}),/unauthorized/);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM job_retention_tombstones WHERE owner=?').get(token).n,0);
 store.db.close();store=open();retention=create();
 assert.throws(lookup,/TOMBSTONE/);assert.throws(resubmit,/TOMBSTONE/);
 assert.deepEqual(store.transaction(()=>retention.expire(who)),tomb);
 assert.equal(store.get(job).report,null);
 assert.equal(store.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get(job).payload,raw);
 assert.equal(store.transaction(()=>retention.completePurge(who)).purged,false);
 assert.equal(purges,0);
 console.log('Native logical retention fence assertions passed; parent entrypoint wiring/T38 pending');
}finally{store?.db.close();rmSync(dir,{recursive:true,force:true});}
