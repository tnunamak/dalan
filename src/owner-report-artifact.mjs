import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {redactSinkText,splitFields} from './redaction.mjs';

export const OWNER_REPORT_ARTIFACT_LIMIT=8*1024*1024;
const clean=value=>redactSinkText(value);

const preparedReports=new WeakMap();
// Preparing a document performs redaction exactly once. Storage accepts only
// this process-local capability, not arbitrary bytes claiming to be prepared.
// New documents carry the neutral id; the original id is still accepted so documents written earlier stay valid.
export const ownerReportFormat='dalan-owner-report';
const ownerReportFormats=[ownerReportFormat,'dot-bridge-owner-report'];
export function prepareOwnerReportArtifact(doc) {
  const invalid=()=>{throw new Error('invalid owner report artifact document');};
  const closed=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&
    Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
  if(!closed(doc,['format','version','summary','result','progress'])||!ownerReportFormats.includes(doc.format)||doc.version!==1||
    typeof doc.summary!=='string'||typeof doc.result!=='string'||!Array.isArray(doc.progress))invalid();
  for(const row of doc.progress) if(!closed(row,['sequence','at','text'])||!Number.isSafeInteger(row.sequence)||row.sequence<1||typeof row.at!=='string'||typeof row.text!=='string')invalid();
  // A report whose raw text is already over the limit is refused before the split check, which reads all of it.
  const rawTexts=[doc.summary,doc.result,...doc.progress.flatMap(row=>[row.at,row.text])];
  if(rawTexts.reduce((n,text)=>n+Buffer.byteLength(text),0)>OWNER_REPORT_ARTIFACT_LIMIT)throw new Error('owner report artifact exceeds 8 MiB');
  // One split check over every text the worker wrote: a credential split between summary, result and progress is
  // masked. Timestamps come from the bridge and take no part.
  const [summary,result,...texts]=splitFields([doc.summary,doc.result,...doc.progress.map(row=>row.text)]).map(clean);
  const progress=doc.progress.map((row,i)=>({sequence:row.sequence,at:clean(row.at),text:texts[i]}));
  const encoded=Buffer.from(JSON.stringify({format:doc.format,version:doc.version,summary,result,progress})+'\n');
  if(encoded.length>OWNER_REPORT_ARTIFACT_LIMIT)throw new Error('owner report artifact exceeds 8 MiB');
  const prepared=Object.freeze({size:encoded.length,sha256:createHash('sha256').update(encoded).digest('hex')});
  preparedReports.set(prepared,encoded);
  return prepared;
}
export function ownerReportArtifactBytes(prepared) {
  const bytes=preparedReports.get(prepared);
  if(!bytes)throw new Error('owner report artifact requires a prepared document');
  return Buffer.from(bytes);
}

// Called only from a trusted finish transaction. Workspace remains the owner of
// artifact storage, sealing, retention, and ordinary rollback cleanup.
export function captureOwnerReportArtifact(store,workspace,{requestId,claimId,outcome,summary,result,onRollback}) {
  if(outcome!=='completed') return null;
  if(!store.db.isTransaction||typeof onRollback!=='function') throw new Error('owner report artifact requires finish transaction');
  const progress=store.db.prepare('SELECT id,note,created_at FROM progress WHERE request_id=? ORDER BY id').all(requestId)
    .map(row=>({sequence:row.id,at:row.created_at,text:row.note}));
  const document={format:ownerReportFormat,version:1,summary,result,progress};
  const prepared=prepareOwnerReportArtifact(document);
  const artifactId=`art_${randomUUID()}`;
  const saved=workspace.saveArtifactInTransaction(requestId,claimId,'owner-report',prepared,artifactId,onRollback);
  const row=store.db.prepare('SELECT path,size,sha256 FROM artifacts WHERE id=? AND request_id=? AND kind=\'owner-report\' AND sealed=1').get(artifactId,requestId);
  if(!row||row.size!==prepared.size||row.sha256!==prepared.sha256) throw new Error('owner report artifact integrity failure');
  const fd=fs.openSync(row.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size!==row.size) throw new Error('owner report artifact integrity failure');
    const actual=Buffer.alloc(row.size);let offset=0;
    while(offset<actual.length){const count=fs.readSync(fd,actual,offset,actual.length-offset,offset);if(!count)throw new Error('owner report artifact integrity failure');offset+=count;}
    if(createHash('sha256').update(actual).digest('hex')!==row.sha256) throw new Error('owner report artifact integrity failure');
    fs.fsyncSync(fd);
  } finally {fs.closeSync(fd);}
  const dirfd=fs.openSync(path.dirname(row.path),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  try {fs.fsyncSync(dirfd);} finally {fs.closeSync(dirfd);}
  return {artifact_id:saved.artifact_id,kind:saved.kind,size:saved.size,sha256:saved.sha256};
}
