import {openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {createResultBindings} from './result-binding.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
function canonical(value) {
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(canonical);
  if(value&&Object.getPrototypeOf(value)===Object.prototype)
    return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  fail('invalid_command');
}
const json=value=>JSON.stringify(canonical(value));
const nat=n=>Number.isSafeInteger(n)&&n>=0;
function nativeArtifact(store,job,claimId,epoch,selectedId) {
  const row=store.db.prepare("SELECT * FROM artifacts WHERE request_id=? AND COALESCE(client_artifact_id,id)=? AND kind='upload' AND claim_id=? AND sealed=1").get(job,selectedId,claimId);
  if(!row||row.origin_claim_id!==claimId||row.origin_epoch!==epoch||!nat(row.size)||row.size>8*1024*1024||!row.origin_claim_id||
    !nat(row.origin_epoch)||row.origin_epoch<1||!/^[a-f0-9]{64}$/.test(row.sha256??''))fail('invalid_sealed_artifact');
  const fd=openSync(row.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size!==row.size)fail('artifact_integrity_failure');
    const bytes=Buffer.alloc(row.size);
    let offset=0;
    while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)fail('artifact_integrity_failure');offset+=count;}
    if(fstatSync(fd).size!==row.size||createHash('sha256').update(bytes).digest('hex')!==row.sha256)
      fail('artifact_integrity_failure');
  } finally {closeSync(fd);}
  return {id:row.id,origin_claim:row.origin_claim_id,origin_epoch:row.origin_epoch,sha256:row.sha256,size:row.size};
}
export function finishProtocol(store,id,claimId,outcome,summary,result,subject,evidence,worker,ctx,captureEvidence=null,connectionId=null) {
  // Parent never routes cancelled native finishes back here. Native finish owns
  // its late-evidence transaction and throws only after that audit commits.
  if(store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id)?.status==='cancelled')
    return store.finish(id,claimId,outcome,summary,result,subject,evidence,worker,null,null,connectionId);
  const rollback=[];
  try {return store.transaction(()=>{
    const claim=store.assertFinishClaim(id,claimId,subject,worker);
    // Commit-time authority gates both a fresh finish and a stored receipt replay.
    store.assertMutationConnection(id,claim,connectionId);
    if(!store.isProtocolJob(id))fail('protocol_required');
    if(!ctx||typeof ctx.key!=='string'||!ctx.key||ctx.key.length>512||!nat(ctx.revision)||
      ctx.epoch!==undefined&&(!nat(ctx.epoch)||ctx.epoch!==claim.epoch))fail('stale_authority');
    const ids=ctx.args?.artifact_ids;
    if(!Array.isArray(ids)||ids.some(x=>typeof x!=='string'||!x)||new Set(ids).size!==ids.length)
      fail('invalid_artifact_ids');
    // Snapshot evidence is server-derived and may be absent on receipt replay.
    // The key binds caller intent; the original report retains its own evidence.
    const args={outcome,summary,result,artifact_ids:ids};
    const command={job:id,subject,worker,claim:claimId,epoch:claim.epoch,key:ctx.key,
      expectedRevision:ctx.revision,operation:'finish',args};
    const identity=json(command);
    const prior=store.db.prepare('SELECT identity,result FROM claim_command_receipts WHERE job=? AND command_key=?').get(id,ctx.key);
    if(prior) {
      if(prior.identity!==identity)fail('command_conflict');
      const report=store.db.prepare('SELECT receipt_id,claim_id,worker FROM reports WHERE request_id=?').get(id);
      const binding=store.db.prepare('SELECT receipt FROM immutable_result_bindings WHERE job=?').get(id);
      const saved=JSON.parse(prior.result);
      if(!report||!binding||report.claim_id!==claimId||report.worker!==worker||
        saved.value?.receipt_id!==report.receipt_id||JSON.parse(binding.receipt).receipt_id!==report.receipt_id)
        fail('retained_receipt_required');
      return {...saved.value,revision:saved.revision};
    }
    if(store.db.prepare('SELECT 1 FROM reports WHERE request_id=?').get(id))fail('original_finish_key_required');
    let parsed;try{parsed=JSON.parse(result);}catch{fail('invalid_result_json');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
      typeof parsed.source!=='string'||typeof parsed.policy!=='string')fail('binding_mismatch');
    const receipt=store.protocolMutationInTransaction(id,claimId,subject,worker,
      {...ctx,operation:'finish',args},()=>{
        const refs=ids.map(selected=>nativeArtifact(store,id,claimId,claim.epoch,selected));
        const byId=new Map(refs.map(ref=>[ref.id,ref]));
        if(byId.size!==refs.length)fail('duplicate_artifact_reference');
        const bindings=createResultBindings({db:store.db,
          authorize:c=>{
            const current=store.assertFinishClaim(id,claimId,subject,worker);
            return c.job===id&&c.subject===subject&&c.worker===worker&&c.claim===claimId&&c.epoch===current.epoch;
          },
          readIntent:job=>store.getProtocol(job),
          readArtifact:({job,id:artifactId})=>{
            const ref=byId.get(artifactId);
            return ref&&job===id?{...ref,job,sealed:true}:null;
          },
          readTerminal:job=>{
            const row=store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(job);
            return row?{status:row.status,late:false,compute_stopped:false}:null;
          }});
        const bound=bindings.bind({job:id,subject,worker,claim:claimId,epoch:claim.epoch,
          source:parsed.source,policy:parsed.policy,outcome,summary,result,artifacts:refs},()=>{
            // A newly committed report cannot already have an owner decision.
            store.assertQuestionsResolved(id,claimId,outcome);
            const captured=captureEvidence?captureEvidence(cleanup=>rollback.push(cleanup)):evidence;
            const native={...store.finishOnce(id,claimId,outcome,summary,result,subject,captured,worker,null,connectionId),acceptance:'unreviewed'};
            store.protocolEventInTransaction(id,'finished',{receipt_id:native.receipt_id,outcome},claim.epoch);
            return native;
          });
        return bound;
      },connectionId);
    return {...receipt.value,revision:receipt.revision};
  });} catch(error) {for(const cleanup of rollback)cleanup();throw error;}
}
