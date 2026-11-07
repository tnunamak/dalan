import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {migrateJobRetention,createJobRetention} from '../src/job-retention.mjs';
const dir=mkdtempSync(join(tmpdir(),'job-retention-'));let db;
try{
 const file=join(dir,'db');db=new DatabaseSync(file);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 tx(()=>migrateJobRetention(db));db.exec("CREATE TABLE native(job TEXT PRIMARY KEY,status TEXT,stopped INTEGER,fenced INTEGER,payload TEXT);INSERT INTO native VALUES('J','claimed',0,0,'keep')");
 let now=0;
 const open=()=>createJobRetention({db,clock:()=>now,authorize:({owner,worker})=>owner==='O'&&worker==='W',
 readState:job=>{const r=db.prepare('SELECT * FROM native WHERE job=?').get(job);return r&&{status:r.status,compute_stopped:!!r.stopped};},
 fence:({job})=>db.prepare('UPDATE native SET fenced=1 WHERE job=?').run(job).changes===1,
 purge:({job})=>db.prepare('UPDATE native SET payload=NULL WHERE job=?').run(job).changes===1});
 let api=open();const who={job:'J',owner:'O',worker:'W'};tx(()=>api.define({...who,retainUntil:100}));
 assert.throws(()=>tx(()=>api.define({...who,retainUntil:200})),/retention_conflict/);
 now=99;assert.equal(api.assertAvailable(who),true);assert.equal(tx(()=>api.expire(who)).deleted,false);
 now=100;assert.throws(()=>api.assertAvailable(who),/TOMBSTONE/);
 assert.throws(()=>tx(()=>{api.expire(who);throw Error('rollback');}),/rollback/);
 assert.equal(db.prepare('SELECT fenced FROM native').get().fenced,0);
 assert.equal(db.prepare('SELECT count(*) n FROM job_retention_tombstones').get().n,0);
 const tomb=tx(()=>api.expire(who));assert.equal(tomb.purge_pending,1);assert.equal(db.prepare('SELECT payload FROM native').get().payload,'keep');
 assert.equal(tx(()=>api.completePurge(who)).purged,false);
 assert.throws(()=>tx(()=>api.define({...who,retainUntil:1000,key:'new'})),/TOMBSTONE/);
 db.close();db=new DatabaseSync(file);api=open();
 assert.throws(()=>api.assertAvailable(who),/TOMBSTONE/);
 assert.equal(api.assertAvailable({...who,job:'OTHER'}),true);
 assert.throws(()=>api.assertAvailable({...who,owner:'OTHER'}),/unauthorized/);
 db.exec("UPDATE native SET status='cancelled',stopped=1");
 assert.equal(tx(()=>api.completePurge(who)).purged,true);
 assert.equal(db.prepare('SELECT payload FROM native').get().payload,null);
 assert.throws(()=>api.assertAvailable(who),/TOMBSTONE/);
 assert.deepEqual(tx(()=>api.expire(who)).deleted,true);
 console.log('retention offline assertions passed');
}finally{db?.close();rmSync(dir,{recursive:true,force:true});}
