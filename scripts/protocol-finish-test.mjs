import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {finishProtocol} from '../src/protocol-finish.mjs';
import {createHash} from 'node:crypto';
import {protocolArtifactChunk} from '../src/protocol-artifact-commands.mjs';

const dir=mkdtempSync(join(tmpdir(),'protocol-finish-')),file=join(dir,'isolated.sqlite');
const priorRoot=process.env.DOT_BRIDGE_WORKSPACE_ROOT;
process.env.DOT_BRIDGE_WORKSPACE_ROOT=join(dir,'workspace');
const {Workspace}=await import('../src/workspace.mjs');
let now=1800000000000,store;
const owner='offline-owner',subject='offline-subject';
const open=()=>new Store(file,{now:()=>now});
const body=JSON.stringify({source:'source',policy:'policy',deliverable:'offline result'});
const context=(id,key,epoch,ids=[])=>({key,revision:store.protocolRevision(id),epoch,args:{artifact_ids:ids}});
function submit(id) {
  const p={schema_version:1,request_id:id,brief:'Offline finish regression',inputs:[],scope_paths:[],
    execution_scope:'analysis',expected_output:'evidence',
    protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:now+86400000}};
  store.submit(p,{mode:'none'},null,owner,false,null,'normal',null,p,null,'dot','worker');
  return store.claim(id,'offline-claimant',subject,20,null,'dot','acquisition-'+id,1000,context(id,'claim',0));
}
function snapshot(id) {
  const q=(sql)=>store.db.prepare(sql).all(id);
  return JSON.stringify({revision:store.protocolRevision(id),facts:store.protocolFacts(id),
    reports:q('SELECT * FROM reports WHERE request_id=?'),
    bindings:q('SELECT * FROM immutable_result_bindings WHERE job=?'),
    receipts:q('SELECT * FROM claim_command_receipts WHERE job=? ORDER BY command_key'),
    lifecycle:q('SELECT * FROM lifecycle_events WHERE request_id=? ORDER BY rowid'),
    notifications:q('SELECT * FROM notifications WHERE request_id=? ORDER BY id'),
    assignment:q('SELECT status FROM assignments WHERE request_id=?')});
}
function unchanged(id,fn,pattern){const before=snapshot(id);assert.throws(fn,pattern);assert.equal(snapshot(id),before);}
function finish(id,c,ctx,result=body,outcome='completed',who=subject,worker='dot') {
  return finishProtocol(store,id,c.claim_id,outcome,'Summary',result,who,null,worker,ctx);
}
try {
  store=open();
  const id='finish-case',c=submit(id),ctx=context(id,'finish',c.epoch);
  unchanged(id,()=>finish(id,c,ctx,JSON.stringify({source:'wrong',policy:'policy'})),/binding_mismatch/);
  unchanged(id,()=>finish(id,c,ctx,JSON.stringify({source:'source',policy:'wrong'})),/binding_mismatch/);
  unchanged(id,()=>finish(id,c,{...ctx,revision:0}),/revision_conflict/);
  unchanged(id,()=>finish(id,c,{...ctx,epoch:c.epoch+1}),/stale_authority/);
  unchanged(id,()=>finish(id,c,ctx,body,'completed','foreign-subject'),/claim|authority/i);
  unchanged(id,()=>finish(id,c,ctx,body,'completed',subject,'foreign-worker'),/claim|authority|assignment/i);
  const receipt=finish(id,c,ctx);
  assert.equal(receipt.revision,ctx.revision+1);assert.equal(receipt.result_authority,true);
  assert.equal(receipt.authority.compute_stopped,false);
  assert.equal(store.db.prepare('SELECT receipt_id FROM reports WHERE request_id=?').get(id).receipt_id,receipt.receipt_id);
  assert.equal(JSON.parse(store.db.prepare('SELECT receipt FROM immutable_result_bindings WHERE job=?').get(id).receipt).receipt_id,receipt.receipt_id);
  assert.equal(store.protocolFacts(id).filter(x=>x.type==='finished').length,1);
  assert.equal(store.protocolFacts(id).at(-1).state,'finished');
  const after=snapshot(id);now+=1001;
  assert.deepEqual(finish(id,c,ctx),receipt);assert.equal(snapshot(id),after);
  store.db.close();store=open();
  assert.deepEqual(finish(id,c,ctx),receipt);assert.equal(snapshot(id),after);
  unchanged(id,()=>finish(id,c,ctx,body+' '),/command_conflict/);
  unchanged(id,()=>finish(id,c,{...ctx,args:{artifact_ids:['art_changed123']}}),/command_conflict/);
  unchanged(id,()=>finish(id,c,{...ctx,key:'new-finish'}),/original_finish_key_required/);
  unchanged(id,()=>finish(id,c,{...ctx,epoch:c.epoch+1}),/stale_authority/);
  unchanged(id,()=>finish(id,c,ctx,body,'completed',subject,'foreign-worker'),/claim|authority|assignment/i);
  const openId='publication-failure',oc=submit(openId);
  store.askQuestion(openId,oc.claim_id,'unanswered','Need input',subject,'dot',context(openId,'ask',oc.epoch));
  // Real native publication rejects unresolved questions after binding validation.
  unchanged(openId,()=>finish(openId,oc,context(openId,'finish',oc.epoch)),/QUESTION_OPEN/);
  const blocked=finish(openId,oc,context(openId,'blocked',oc.epoch),body,'blocked');
  assert.equal(blocked.result_authority,true);assert.equal(store.questions(openId)[0].consumed_at,null);
  const cancelled='cancelled',cc=submit(cancelled);
  store.cancel(cancelled,'owner cancelled',{key:'cancel',revision:store.protocolRevision(cancelled)},owner);
  const beforeLate=snapshot(cancelled);
  assert.throws(()=>finish(cancelled,cc,null,'unstructured late audit','failed'),/assignment_cancelled/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM late_evidence WHERE request_id=?').get(cancelled).n,1);
  assert.equal(snapshot(cancelled),beforeLate);
  const artifactJob='artifact-finish',first=submit(artifactJob),workspace=new Workspace(store,false);
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const upload=(id,bytes)=>protocolArtifactChunk(store,workspace,{requestId:artifactJob,claimId:first.claim_id,subject,worker:'dot',artifactId:id,offset:0,base64:Buffer.from(bytes).toString('base64'),final:true,expected:sha(bytes),expectedSize:Buffer.byteLength(bytes)},context(artifactJob,'upload-'+id,first.epoch));
  upload('art_finish_one01','abc');upload('art_finish_two02','def');
  now+=1001;
  const successor=store.claim(artifactJob,'successor',subject,20,null,'dot','next',1000,context(artifactJob,'regrant',first.epoch));
  const selected=store.db.prepare('SELECT * FROM artifacts WHERE request_id=? AND client_artifact_id=?').get(artifactJob,'art_finish_one01');
  assert.equal(selected.origin_claim_id,first.claim_id);assert.equal(selected.origin_epoch,first.epoch);assert.equal(selected.claim_id,successor.claim_id);
  assert.equal(store.protocolState(artifactJob),'leased');
  assert.equal(store.protocolFacts(artifactJob).at(-1).state,'leased');
  const originalRows=JSON.stringify(store.db.prepare('SELECT id,origin_claim_id,origin_epoch,path,size,sha256 FROM artifacts WHERE request_id=? ORDER BY id').all(artifactJob));
  const originalBytes=readFileSync(selected.path);
  const oldCtx=context(artifactJob,'old-finish',successor.epoch,['art_finish_one01']);
  unchanged(artifactJob,()=>finish(artifactJob,successor,oldCtx),/invalid_sealed_artifact/);
  assert.deepEqual(readFileSync(selected.path),originalBytes);
  assert.equal(JSON.stringify(store.db.prepare('SELECT id,origin_claim_id,origin_epoch,path,size,sha256 FROM artifacts WHERE request_id=? ORDER BY id').all(artifactJob)),originalRows);
  unchanged(artifactJob,()=>finish(artifactJob,first,context(artifactJob,'stale',first.epoch)),/claim|authority|epoch/i);
  store.db.close();store=open();
  unchanged(artifactJob,()=>finish(artifactJob,successor,oldCtx),/invalid_sealed_artifact/);
  const nextWorkspace=new Workspace(store,false);
  const fresh=(id,final=true)=>protocolArtifactChunk(store,nextWorkspace,{requestId:artifactJob,claimId:successor.claim_id,subject,worker:'dot',artifactId:id,offset:0,base64:Buffer.from('abc').toString('base64'),final,expected:sha('abc'),expectedSize:3},context(artifactJob,'new-'+id,successor.epoch));
  fresh('art_unsealed003',false);
  unchanged(artifactJob,()=>finish(artifactJob,successor,context(artifactJob,'unsealed',successor.epoch,['art_unsealed003'])),/invalid_sealed_artifact/);
  fresh('art_finish_new03');
  assert.equal(store.protocolState(artifactJob),'result_staged');
  const current=store.db.prepare('SELECT * FROM artifacts WHERE request_id=? AND client_artifact_id=?').get(artifactJob,'art_finish_new03');
  const artifactCtx=context(artifactJob,'finish',successor.epoch,['art_finish_new03']);
  writeFileSync(current.path,'bad');
  unchanged(artifactJob,()=>finish(artifactJob,successor,artifactCtx),/artifact_integrity_failure/);
  writeFileSync(current.path,originalBytes);
  unchanged(artifactJob,()=>finish(artifactJob,successor,artifactCtx,JSON.stringify({source:'wrong',policy:'policy'})),/binding_mismatch/);
  unchanged(artifactJob,()=>finish(artifactJob,successor,artifactCtx,JSON.stringify({source:'source',policy:'wrong'})),/binding_mismatch/);
  const other='other-artifact-job',otherClaim=submit(other);
  unchanged(other,()=>finish(other,otherClaim,context(other,'foreign',otherClaim.epoch,['art_finish_new03'])),/invalid_sealed_artifact/);
  const evidence={snapshot:'server-derived'};
  const artifactReceipt=finishProtocol(store,artifactJob,successor.claim_id,'completed','Summary',body,subject,evidence,'dot',artifactCtx);
  const binding=JSON.parse(store.db.prepare('SELECT identity FROM immutable_result_bindings WHERE job=?').get(artifactJob).identity);
  assert.deepEqual(binding.artifacts.map(ref=>ref.id),[current.id]);
  assert.equal(binding.artifacts[0].origin_epoch,successor.epoch);
  const old=store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(selected.id);
  assert.equal(old.origin_claim_id,first.claim_id);assert.equal(old.origin_epoch,first.epoch);
  assert.deepEqual(readFileSync(old.path),originalBytes);
  const committed=snapshot(artifactJob);
  now+=1001;store.db.close();store=open();
  assert.deepEqual(finish(artifactJob,successor,artifactCtx),artifactReceipt);
  assert.equal(snapshot(artifactJob),committed);
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT workspace_evidence FROM reports WHERE request_id=?').get(artifactJob).workspace_evidence),evidence);
  console.log('PASS native result binding, verified artifact bytes/provenance, retained receipts, rollback and cancelled audit');
} finally {
  store?.db.close();rmSync(dir,{recursive:true,force:true});
  if(priorRoot===undefined)delete process.env.DOT_BRIDGE_WORKSPACE_ROOT;else process.env.DOT_BRIDGE_WORKSPACE_ROOT=priorRoot;
}
