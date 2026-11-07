import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'protocol-artifact-'));
process.env.DOT_BRIDGE_WORKSPACE_ROOT=join(dir,'workspace');
process.env.DALAN_HOST_CHECKS='off';
const {Store}=await import('../src/store.mjs');
const {Workspace}=await import('../src/workspace.mjs');
const {protocolArtifactChunk}=await import('../src/protocol-artifact-commands.mjs');
let now=1800000000000,store,workspace;
const file=join(dir,'isolated.sqlite'),subject='offline-subject',token='offline-owner';
const digest=x=>createHash('sha256').update(x).digest('hex');
function open(){store=new Store(file,{now:()=>now});workspace=new Workspace(store,false);}
function setup(id) {
  const p={schema_version:1,request_id:id,brief:'Offline native artifact regression',inputs:[],scope_paths:[],
    execution_scope:'analysis',expected_output:'evidence',
    protocol:{profile:'job-v0',source:'source',scope:'scope',policy:'policy',destination:'owner',retain_until_ms:now+86400000}};
  store.submit(p,{mode:'none'},null,token,false,null,'normal',null,p,null,'dot','worker');
  return store.claim(id,'offline-claimant',subject,20,null,'dot','acquisition-'+id,1000,{key:'claim',revision:store.protocolRevision(id)});
}
const ctx=(id,c,key)=>({key,epoch:c.epoch,revision:store.protocolRevision(id)});
const params=(id,c,offset,bytes,final=false)=>({requestId:id,claimId:c.claim_id,subject,worker:'dot',artifactId:'art_native_upload01',offset,base64:Buffer.from(bytes).toString('base64'),final});
function snap(id){return JSON.stringify({revision:store.protocolRevision(id),facts:store.protocolFacts(id),
  artifacts:store.db.prepare('SELECT * FROM artifacts WHERE request_id=? ORDER BY id').all(id),
  journal:store.db.prepare('SELECT * FROM artifact_mutation_journal WHERE job=? ORDER BY mutation_key').all(id),
  heads:store.db.prepare('SELECT * FROM artifact_journal_heads WHERE job=?').all(id),
  receipts:store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=? ORDER BY command_key').all(id)});}
const row=id=>store.db.prepare("SELECT * FROM artifacts WHERE request_id=? AND kind='upload'").get(id);
function unchanged(id,fn,pattern){const before=snap(id);assert.throws(fn,pattern);assert.equal(snap(id),before);}
try {
 open();const id='artifact-case',c=setup(id),one=params(id,c,0,'abc'),key1=ctx(id,c,'one');
 const first=protocolArtifactChunk(store,workspace,one,key1);
 assert.equal(first.revision,key1.revision+1);assert.equal(first.offset,3);
 assert.equal(store.protocolFacts(id).at(-1).state,'leased');
 assert.equal(store.db.prepare('SELECT sha256 FROM artifact_journal_heads WHERE job=?').get(id).sha256,digest('abc'));
 const afterOne=snap(id),bytesOne=readFileSync(row(id).path);
 assert.deepEqual(protocolArtifactChunk(store,workspace,one,key1),first);
 assert.equal(snap(id),afterOne);assert.deepEqual(readFileSync(row(id).path),bytesOne);
 unchanged(id,()=>protocolArtifactChunk(store,workspace,{...one,base64:Buffer.from('xyz').toString('base64')},key1),/command_conflict/);
 unchanged(id,()=>protocolArtifactChunk(store,workspace,one,ctx(id,c,'duplicate-new-key')),/artifact_exists/);
 const two=params(id,c,3,'def'),key2=ctx(id,c,'two');
 protocolArtifactChunk(store,workspace,two,key2);
 assert.equal(store.db.prepare('SELECT sha256 FROM artifact_journal_heads WHERE job=?').get(id).sha256,digest('abcdef'));
 const seal={...params(id,c,6,'',true),expected:digest('abcdef'),expectedSize:6},sealKey=ctx(id,c,'seal');
 unchanged(id,()=>protocolArtifactChunk(store,workspace,{...seal,expectedSize:7},sealKey),/artifact_size_mismatch/);
 unchanged(id,()=>protocolArtifactChunk(store,workspace,{...seal,expected:digest('wrong')},sealKey),/digest mismatch/);
 const sealed=protocolArtifactChunk(store,workspace,seal,sealKey);
 assert.equal(sealed.sealed,true);assert.equal(row(id).sealed,1);
 assert.equal(store.protocolFacts(id).at(-1).state,'result_staged');
 assert.equal(store.protocolFacts(id).filter(x=>x.type==='uploaded').length,2);
 assert.equal(store.protocolFacts(id).filter(x=>x.type==='sealed').length,1);
 assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_mutation_journal WHERE job=?').get(id).n,3);
 assert.equal(row(id).origin_claim_id,c.claim_id);assert.equal(row(id).origin_epoch,c.epoch);
 const afterSeal=snap(id);store.db.close();open();
 assert.deepEqual(protocolArtifactChunk(store,workspace,seal,sealKey),sealed);assert.equal(snap(id),afterSeal);
 unchanged(id,()=>protocolArtifactChunk(store,workspace,seal,ctx(id,c,'seal-new')),/artifact_exists/);
 unchanged(id,()=>protocolArtifactChunk(store,workspace,{...seal,claimId:'wrong'},sealKey),/claim|authority/i);
 unchanged(id,()=>protocolArtifactChunk(store,workspace,seal,{...sealKey,epoch:c.epoch+1}),/stale_authority/);
 const tailId='tail-case',tailClaim=setup(tailId);
 protocolArtifactChunk(store,workspace,params(tailId,tailClaim,0,'abc'),ctx(tailId,tailClaim,'one'));
 const tail=params(tailId,tailClaim,3,'def'),tailKey=ctx(tailId,tailClaim,'two');
 const beforeFailure=snap(tailId),path=row(tailId).path;
 // A real SQLite trigger injects publication failure; no Store/Workspace monkeypatch.
 store.db.exec("CREATE TEMP TRIGGER reject_upload BEFORE INSERT ON protocol_events WHEN NEW.request_id='tail-case' AND NEW.event_type='uploaded' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END");
 unchanged(tailId,()=>protocolArtifactChunk(store,workspace,tail,tailKey),/injected publication failure/);
 assert.equal(snap(tailId),beforeFailure);assert.equal(row(tailId).size,3);
 assert.equal(statSync(path).size,6,'durable bytes survive SQL rollback');
 store.db.exec('DROP TRIGGER reject_upload');
 protocolArtifactChunk(store,workspace,tail,tailKey);
 assert.equal(row(tailId).size,6);assert.equal(readFileSync(path).toString(),'abcdef');
 const cancelled='cancel-case',cc=setup(cancelled);store.cancel(cancelled,'stop',{key:'cancel',revision:store.protocolRevision(cancelled)},token);
 unchanged(cancelled,()=>protocolArtifactChunk(store,workspace,params(cancelled,cc,0,'x'),ctx(cancelled,cc,'upload')),/authority|terminal|cancel|closed/i);
 now+=1001;
 unchanged(tailId,()=>protocolArtifactChunk(store,workspace,tail,tailKey),/expired|lease/i);
 const combinedId='combined-final',combinedClaim=setup(combinedId);
 const combined={...params(combinedId,combinedClaim,0,'abc',true),expected:digest('abc'),expectedSize:3};
 const combinedKey=ctx(combinedId,combinedClaim,'combined');
 const complete=protocolArtifactChunk(store,workspace,combined,combinedKey);
 assert.equal(complete.sealed,true);assert.equal(row(combinedId).size,3);
 assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_mutation_journal WHERE job=?').get(combinedId).n,1);
 assert.equal(store.protocolFacts(combinedId).filter(f=>f.type==='sealed').length,1);
 assert.deepEqual(protocolArtifactChunk(store,workspace,combined,combinedKey),complete);
 const appendId='append-final',appendClaim=setup(appendId);
 protocolArtifactChunk(store,workspace,params(appendId,appendClaim,0,'abc'),ctx(appendId,appendClaim,'prefix'));
 const append={...params(appendId,appendClaim,3,'def',true),expected:digest('abcdef'),expectedSize:6};
 protocolArtifactChunk(store,workspace,append,ctx(appendId,appendClaim,'append-seal'));
 assert.equal(readFileSync(row(appendId).path).toString(),'abcdef');assert.equal(row(appendId).sealed,1);
 const emptyId='empty-final',emptyClaim=setup(emptyId);
 protocolArtifactChunk(store,workspace,{...params(emptyId,emptyClaim,0,'',true),expected:digest(''),expectedSize:0},ctx(emptyId,emptyClaim,'empty-seal'));
 assert.equal(row(emptyId).sealed,1);assert.equal(row(emptyId).size,0);
 const regrantId='partial-regrant',oldGrant=setup(regrantId);
 protocolArtifactChunk(store,workspace,params(regrantId,oldGrant,0,'old'),ctx(regrantId,oldGrant,'old-prefix'));
 const oldRow={...row(regrantId)},oldJournal=store.db.prepare('SELECT * FROM artifact_mutation_journal WHERE job=?').all(regrantId);
 now+=1001;
 const newGrant=store.claim(regrantId,'successor',subject,20,null,'dot','next',1000,{key:'regrant',revision:store.protocolRevision(regrantId)});
 assert.equal(store.db.prepare('SELECT client_artifact_id FROM artifacts WHERE id=?').get(oldRow.id).client_artifact_id,null);
 unchanged(regrantId,()=>protocolArtifactChunk(store,workspace,params(regrantId,oldGrant,0,'stale'),ctx(regrantId,oldGrant,'stale')),/claim|authority/i);
 const fresh=protocolArtifactChunk(store,workspace,params(regrantId,newGrant,0,'new'),ctx(regrantId,newGrant,'new-prefix'));
 assert.equal(fresh.offset,3);
 const newRow=store.db.prepare('SELECT * FROM artifacts WHERE request_id=? AND client_artifact_id=?').get(regrantId,'art_native_upload01');
 assert.notEqual(newRow.id,oldRow.id);assert.equal(newRow.origin_claim_id,newGrant.claim_id);assert.equal(newRow.origin_epoch,newGrant.epoch);
 assert.equal(readFileSync(oldRow.path).toString(),'old');assert.equal(readFileSync(newRow.path).toString(),'new');
 assert.deepEqual(store.db.prepare('SELECT * FROM artifact_mutation_journal WHERE job=? AND mutation_key=?').all(regrantId,'old-prefix'),oldJournal);
 console.log('PASS native keyed uploads, prefix integrity, combined sealing, rollback/tail recovery and authority');
} finally {store?.db.close();rmSync(dir,{recursive:true,force:true});}
