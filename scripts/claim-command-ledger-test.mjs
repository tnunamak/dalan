import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {migrateClaimCommands,createClaimCommands} from '../src/claim-command-ledger.mjs';
const dir=mkdtempSync(join(tmpdir(),'claim-commands-'));let db;
try{
 const file=join(dir,'db');db=new DatabaseSync(file);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 tx(()=>migrateClaimCommands(db));db.exec('CREATE TABLE native_claim(deadline INTEGER,epoch INTEGER);INSERT INTO native_claim VALUES(100,1)');
 let now=20,calls=0;
 const open=()=>createClaimCommands({db,clock:()=>now,maxLeaseMs:100,
  authorize:()=>({job:'J',subject:'S',worker:'W',claim:'C',active:true,leaseUntil:db.prepare('SELECT deadline FROM native_claim').get().deadline,epoch:db.prepare('SELECT epoch FROM native_claim').get().epoch})});
 let api=open();tx(()=>api.initialize('J',2));
 const c={job:'J',subject:'S',worker:'W',claim:'C',epoch:1,operation:'renew',key:'k',expectedRevision:2,args:{leaseMs:100}};
 const mutate=({leaseUntil})=>{calls++;db.prepare('UPDATE native_claim SET deadline=?').run(leaseUntil);return {ok:true};};
 const first=tx(()=>api.execute(c,mutate));assert.equal(first.leaseUntil,120);assert.equal(first.revision,3);
 now=50;assert.deepEqual(tx(()=>api.execute(c,mutate)),first);assert.equal(calls,1);
 assert.throws(()=>tx(()=>api.execute({...c,args:{leaseMs:99}},mutate)),/command_conflict/);
 assert.throws(()=>tx(()=>api.execute({...c,key:'race'},mutate)),/revision_conflict/);
 assert.throws(()=>tx(()=>api.execute({...c,claim:'other'},mutate)),/stale_authority/);
 assert.throws(()=>tx(()=>{api.execute({...c,key:'rollback',expectedRevision:3},mutate);throw Error('rollback');}),/rollback/);
 assert.equal(api.revision('J'),3);assert.equal(db.prepare('SELECT deadline FROM native_claim').get().deadline,120);
 db.close();db=new DatabaseSync(file);api=open();assert.deepEqual(tx(()=>api.execute(c,mutate)),first);
 assert.equal(api.revision('J'),3);
 // A second connection races the old revision after the first committed.
 const other=new DatabaseSync(file);
 const contender=createClaimCommands({db:other,clock:()=>50,authorize:()=>({job:'J',subject:'S',worker:'W',claim:'C',epoch:1,active:true,leaseUntil:120})});
 other.exec('BEGIN IMMEDIATE');assert.throws(()=>contender.execute({...c,key:'other'},()=>null),/revision_conflict/);other.exec('ROLLBACK');other.close();
 now=120;assert.throws(()=>tx(()=>api.execute(c,mutate)),/lease_expired/);
 assert.equal(db.prepare('SELECT epoch FROM native_claim').get().epoch,1);
 now=50;db.exec('UPDATE native_claim SET epoch=2');assert.throws(()=>tx(()=>api.execute(c,mutate)),/stale_authority/);
 assert.equal(api.revision('J'),3);
 console.log('claim command offline assertions passed');
}finally{db?.close();rmSync(dir,{recursive:true,force:true});}
