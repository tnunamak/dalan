// Legacy native Store/component fixture. Strict protocol publication is tested by its coordinator.
// Node24. Actual Store result transaction. Protocol registration/HTTP validation remain parent integration.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {migrateResultBindings,createResultBindings} from '../src/result-binding.mjs';
const dir=mkdtempSync(join(tmpdir(),'native-result-')),file=join(dir,'isolated.sqlite');
let store,now=Date.UTC(2026,0,1),publishes=0;
const owner='fixture-owner',subject='fixture-subject',worker='dot';
const makePayload=id=>({schema_version:1,request_id:id,brief:'Native immutable result integration',
 inputs:[],execution_scope:'implementation',expected_output:'fixture',result_intent:{source:'git:BASE',policy:'P0'}});
try {
 const open=()=>new Store(file,{now:()=>now});
 store=open();
 const submit=id=>{const p=makePayload(id);store.submit(p,{mode:'none'},null,owner,false,null,'normal',null,p,null,worker,'worker');};
 submit('result-job');
 const first=store.claim('result-job','fixture',subject,10,null,worker,'first',100);
 const data=Buffer.from('sealed native artifact fixture'),digest=createHash('sha256').update(data).digest('hex'),artifactPath=join(dir,'artifact.bin');
 writeFileSync(artifactPath,data);
 // Native sealed-upload metadata fixture, not a competing artifact table.
 // Upload/fsync mechanics are outside this slice; real bytes and digest back the native row.
 store.db.prepare(`INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sha256,sealed,created_at,client_artifact_id,origin_claim_id,origin_epoch)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('artifact-internal','result-job',first.claim_id,'upload',artifactPath,data.length,digest,1,new Date(now).toISOString(),'artifact-public',first.claim_id,first.epoch);
 now+=101;
 const current=store.claim('result-job','fixture',subject,10,null,worker,'second',100);
 assert.notEqual(current.claim_id,first.claim_id);
 const schema=store.db.prepare('PRAGMA user_version').get().user_version;
 store.transaction(()=>migrateResultBindings(store.db));
 assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,schema);
 const create=()=>createResultBindings({db:store.db,
 authorize:a=>{try{
   const c=a.mode==='receipt'?store.assertFinishClaim(a.job,a.claim,a.subject,a.worker):store.assertClaim(a.job,a.claim,a.subject,a.worker);
   if(c.epoch!==a.epoch)return false;
   return a.mode==='receipt'||store.get(a.job).status==='claimed';
 }catch{return false;}},
 readIntent:job=>JSON.parse(store.db.prepare('SELECT payload FROM assignments WHERE request_id=?').get(job).payload).result_intent,
 readArtifact:({job,id})=>{
   const a=store.db.prepare('SELECT * FROM artifacts WHERE request_id=? AND client_artifact_id=?').get(job,id);
   if(!a)return null;
   return {job:a.request_id,id:a.client_artifact_id,sealed:a.sealed===1,sha256:a.sha256,size:a.size,origin_claim:a.origin_claim_id,origin_epoch:a.origin_epoch};
 },
 readTerminal:job=>store.get(job)});
 let bindings=create();
 const ref={id:'artifact-public',origin_claim:first.claim_id,origin_epoch:first.epoch,sha256:digest,size:data.length};
 const input={job:'result-job',subject,worker,claim:current.claim_id,epoch:current.epoch,source:'git:BASE',policy:'P0',
 outcome:'completed',summary:'native result',result:'exact result',artifacts:[ref],evidence:[{trust:'worker_attested',statement:'authored fixture evidence'}]};
 const snapshot=job=>JSON.stringify({
   assignment:store.db.prepare('SELECT * FROM assignments WHERE request_id=?').get(job),
   report:store.db.prepare('SELECT * FROM reports WHERE request_id=?').get(job)??null,
   lifecycle:store.db.prepare('SELECT * FROM lifecycle_events WHERE request_id=? ORDER BY id').all(job),
   binding:store.db.prepare('SELECT * FROM immutable_result_bindings WHERE job=?').get(job)??null
 });
 const publish=r=>{
   publishes++;store.assertSealedArtifacts(r.job,r.claim,r.artifacts.map(a=>a.id));
   return store.finishOnce(r.job,r.claim,r.outcome,r.summary,r.result,r.subject,{artifact_ids:r.artifacts.map(a=>a.id),evidence:r.evidence},r.worker);
 };
 const baseline=snapshot(input.job);
 for(const changed of [{source:'git:OTHER'},{policy:'P1'}]){
   assert.throws(()=>store.transaction(()=>bindings.bind({...input,...changed},publish)),/binding_mismatch/);
   assert.equal(snapshot(input.job),baseline);assert.equal(publishes,0);
 }
 for(const changed of [{origin_claim:current.claim_id},{origin_epoch:current.epoch},{sha256:'0'.repeat(64)},{size:data.length+1}]){
   assert.throws(()=>store.transaction(()=>bindings.bind({...input,artifacts:[{...ref,...changed}]},publish)),/artifact_binding_mismatch/);
   assert.equal(snapshot(input.job),baseline);
 }
 assert.throws(()=>store.transaction(()=>bindings.bind({...input,evidence:[{trust:'bridge_verified',statement:'unsupported'}]},publish)),/worker_evidence_cannot_be_verified/);
 assert.throws(()=>store.transaction(()=>bindings.bind(input,r=>{publish(r);throw Error('publish-rollback');})),/publish-rollback/);
 assert.equal(snapshot(input.job),baseline);
 assert.throws(()=>store.transaction(()=>{bindings.bind(input,publish);throw Error('outer-rollback');}),/outer-rollback/);
 assert.equal(snapshot(input.job),baseline);
 const done=store.transaction(()=>bindings.bind(input,publish));
 assert.equal(done.authority.compute_stopped,false);
 assert.equal(done.receipt_id,store.get(input.job).report.receipt_id);
 assert.equal(store.get(input.job).report.trust,'worker_attested');
 assert.equal(store.db.prepare('SELECT origin_claim_id FROM artifacts WHERE id=?').get('artifact-internal').origin_claim_id,first.claim_id);
 assert.equal(createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),ref.sha256);
 const finished=snapshot(input.job),count=publishes;
 now+=1000;store.db.close();store=open();bindings=create();
 const duplicate=store.transaction(()=>bindings.bind(input,publish));
 assert.equal(duplicate.duplicate,true);assert.equal(duplicate.receipt_id,done.receipt_id);
 assert.equal(publishes,count);assert.equal(snapshot(input.job),finished);
 assert.throws(()=>store.transaction(()=>bindings.bind({...input,artifacts:[]},publish)),/result_conflict/);
 assert.throws(()=>store.transaction(()=>bindings.bind({...input,subject:'other'},publish)),/unauthorized/);
 submit('cancelled-job');
 const cancelClaim=store.claim('cancelled-job','fixture',subject,10,null,worker,'cancel',1000);
 store.cancel('cancelled-job','owner cancelled');
 const late={...input,job:'cancelled-job',claim:cancelClaim.claim_id,epoch:cancelClaim.epoch,artifacts:[]};
 assert.throws(()=>store.transaction(()=>bindings.bind(late,publish)),/unauthorized/);
 // Existing wrapper deliberately commits audit evidence before throwing; never bind this path.
 assert.throws(()=>store.finish(late.job,late.claim,late.outcome,late.summary,late.result,subject,null,worker),/assignment_cancelled/);
 assert.equal(store.get(late.job).status,'cancelled');assert.equal(store.get(late.job).report,null);
 assert.ok(store.get(late.job).late_evidence);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM immutable_result_bindings WHERE job=?').get(late.job).n,0);
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM lifecycle_events WHERE request_id=? AND type='completed'").get(late.job).n,0);
 console.log('Native result transaction assertions passed; strict registration/HTTP/comparator pending');
}finally{store?.db.close();rmSync(dir,{recursive:true,force:true});}
