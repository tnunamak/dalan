import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {migrateResultBindings,createResultBindings,terminalAuthority} from '../src/result-binding.mjs';
const dir=mkdtempSync(join(tmpdir(),'result-binding-'));let db;
try{
 const file=join(dir,'db');db=new DatabaseSync(file);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
 tx(()=>migrateResultBindings(db));db.exec("CREATE TABLE native_reports(job TEXT PRIMARY KEY,status TEXT)");
 let live=true;
 const ref={id:'A',size:3,sha256:'a'.repeat(64),origin_claim:'C0',origin_epoch:1};
 let artifact={...ref,job:'J',sealed:true};
 const open=()=>createResultBindings({db,authorize:a=>a.subject==='S'&&a.worker==='W'&&a.claim==='C'&&a.epoch===2&&(a.mode==='receipt'||live),
 readIntent:()=>({source:'git:BASE',policy:'P0'}),readArtifact:()=>artifact,
 readTerminal:job=>({status:db.prepare('SELECT status FROM native_reports WHERE job=?').get(job)?.status??'claimed'})});
 let api=open(),calls=0;
 const publish=({job})=>{calls++;db.prepare("INSERT INTO native_reports VALUES(?,'finished')").run(job);return {receipt_id:'R:'+job};};
 const base={job:'J',subject:'S',worker:'W',claim:'C',epoch:2,source:'git:BASE',policy:'P0',outcome:'completed',summary:'done',result:'ok',artifacts:[ref]};
 assert.throws(()=>tx(()=>api.bind({...base,source:'git:OTHER'},publish)),/binding_mismatch/);assert.equal(calls,0);
 artifact={...artifact,sealed:false};assert.throws(()=>tx(()=>api.bind(base,publish)),/artifact_binding_mismatch/);
 artifact={...artifact,sealed:true};
 assert.throws(()=>tx(()=>api.bind({...base,artifacts:[{...ref,sha256:'b'.repeat(64)}]},publish)),/artifact_binding_mismatch/);
 assert.throws(()=>tx(()=>api.bind({...base,evidence:[{trust:'bridge_verified',statement:'tests passed'}]},publish)),/worker_evidence_cannot_be_verified/);
 assert.throws(()=>tx(()=>{api.bind(base,publish);throw Error('rollback');}),/rollback/);
 assert.equal(db.prepare('SELECT count(*) n FROM native_reports').get().n,0);
 const first=tx(()=>api.bind(base,publish));assert.equal(first.authority.live_authority,false);assert.equal(first.authority.compute_stopped,null);
 live=false;assert.equal(tx(()=>api.bind(base,publish)).duplicate,true);
 assert.throws(()=>tx(()=>api.bind({...base,policy:'OTHER'},publish)),/result_conflict/);
 assert.throws(()=>tx(()=>api.bind({...base,subject:'X'},publish)),/unauthorized/);
 db.close();db=new DatabaseSync(file);api=open();assert.equal(tx(()=>api.bind(base,publish)).receipt_id,'R:J');
 assert.deepEqual(terminalAuthority({status:'cancelled'}),{status:'cancelled',live_authority:false,result_authority:false,compute_stopped:null});
 assert.equal(terminalAuthority({status:'finished',compute_stopped:false}).compute_stopped,false);
 live=true;
 for(const outcome of ['blocked','failed'])tx(()=>api.bind({...base,job:outcome,outcome,artifacts:[]},publish));
 assert.equal(ref.origin_epoch,1,'inherited artifact provenance remains unchanged');
 console.log('result binding offline assertions passed');
}finally{db?.close();rmSync(dir,{recursive:true,force:true});}
