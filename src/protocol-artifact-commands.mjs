import {openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {createArtifactJournal,artifactBytesDigest} from './artifact-journal.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
function inspectNative(store,params,query) {
  const row=store.db.prepare("SELECT * FROM artifacts WHERE id=? AND request_id=? AND claim_id=? AND kind='upload'").get(query.reference,query.job,params.claimId);
  if(!row||!Number.isSafeInteger(row.size)||row.size<0||row.size>8*1024*1024)fail('artifact_integrity_mismatch');
  const fd=openSync(row.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size!==row.size)fail('artifact_integrity_mismatch');
    bytes=Buffer.alloc(row.size);let position=0;
    while(position<bytes.length){const n=readSync(fd,bytes,position,bytes.length-position,position);if(!n)fail('artifact_integrity_mismatch');position+=n;}
    if(fstatSync(fd).size!==row.size)fail('artifact_integrity_mismatch');
  } finally {closeSync(fd);}
  return {reference:row.id,size:row.size,sha256:artifactBytesDigest(bytes),
    chunkSha256:query.offset===undefined?undefined:artifactBytesDigest(bytes.subarray(query.offset,query.offset+query.chunkSize))};
}
export function protocolArtifactChunk(store,workspace,params,ctx) {
  const {requestId,claimId,subject,worker,artifactId,offset,base64,connectionId=null}=params;
  const final=params.final??false,expected=params.expected??null,expectedSize=params.expectedSize??null;
  if(typeof final!=='boolean')fail('invalid_final');
  return store.transaction(()=>{
    const receipt=store.protocolMutationInTransaction(requestId,claimId,subject,worker,
      {...ctx,operation:final?'seal':'upload',
        args:{requestId,claimId,subject,worker,artifactId,offset,base64,final,expected,expectedSize}},()=>{
        const value=workspace.chunkInTransaction(requestId,claimId,subject,artifactId,offset,base64,final,expected,worker,event=>{
          if(event.duplicate)fail('artifact_exists');
          if(final&&expectedSize!==null&&(!Number.isSafeInteger(expectedSize)||expectedSize<0||expectedSize!==event.size))
            fail('artifact_size_mismatch');
          const claim=store.assertClaim(requestId,claimId,subject,worker);
          if(event.row.origin_claim_id!==claimId||event.row.origin_epoch!==claim.epoch)
            fail('artifact_binding_mismatch');
          const journal=createArtifactJournal({db:store.db,
            authorize:c=>{
              const live=store.assertClaim(c.job,c.claim,c.subject,c.worker);
              const status=store.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(c.job)?.status;
              return c.job===requestId&&c.claim===claimId&&c.subject===subject&&c.worker===worker&&
                c.epoch===live.epoch&&status==='claimed';
            },
            inspect:q=>inspectNative(store,params,q)});
          const operation=final?(event.chunkSize>0||!journal.get(requestId,artifactId)?'upload_seal':'seal'):'upload';
          journal.record({job:requestId,artifact:artifactId,key:ctx.key,subject,worker,claim:claimId,epoch:claim.epoch,
            operation,reference:event.reference,size:event.size,sha256:event.sha256,
            ...(operation!=='seal'?{offset:event.offset,chunkSize:event.chunkSize,chunkSha256:event.chunkSha256}:{})});
          store.protocolEventInTransaction(requestId,final?'sealed':'uploaded',
            {artifact_id:artifactId,reference:event.reference,size:event.size,sha256:event.sha256},claim.epoch);
        });
        return value;
      },connectionId);
    return {...receipt.value,revision:receipt.revision};
  });
}
