import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateArtifactJournal, createArtifactJournal, artifactBytesDigest } from '../src/artifact-journal.mjs';

import { createArtifactDownloadGuard } from '../src/protocol-artifact-commands.mjs';
import { artifactSecretRule, registerSecret } from '../src/redaction.mjs';

const notes=[];
let scans=0;
const guard=createArtifactDownloadGuard({scan:bytes=>{ scans++; return artifactSecretRule(bytes); },log:row=>notes.push(row)});
const download=(id,bytes,offset=0)=>{
  guard({id,requestId:'fixture-request',sha256:artifactBytesDigest(bytes),bytes});
  return bytes.subarray(offset);
};
const clean=Buffer.from([0,255,65,0,66]);
assert.deepEqual(download('A-clean',clean),clean);
assert.deepEqual(download('A-clean-alias',clean,2),clean.subarray(2));
assert.equal(scans,1);
const fixtures=[
  [Buffer.from(['-----','BEGIN ','PRIVATE ','KEY','-----'].join('')+'\nsample'), 'private_key_armor'],
  [Buffer.concat([Buffer.from([255,0]),Buffer.from(['Bear','er '].join('')+'q'.repeat(40))]), 'bearer_credential'],
];
for(const [bytes,rule] of fixtures){
  for(const offset of [0,bytes.length-1]){
    assert.throws(()=>download('A-refused',bytes,offset),error=>{
      assert.equal(error.code,'artifact_secret_content');
      assert.equal(error.message,`artifact_secret_content: ${rule}`);
      return true;
    });
  }
}
assert.equal(scans,3,'one scan per distinct digest across repeated or sliced reads');
assert.deepEqual(notes.map(note=>note.rule),['private_key_armor','private_key_armor','bearer_credential','bearer_credential']);
const newlyKnown=Buffer.from('fixture-value-added-after-initial-scan');
assert.deepEqual(download('A-epoch',newlyKnown),newlyKnown);
registerSecret(newlyKnown.toString('utf8'));
assert.throws(()=>download('A-epoch',newlyKnown),/artifact_secret_content: registered_credential/);

const dir=mkdtempSync(join(tmpdir(),'artifact-journal-'));
let db;
try {
  const file=join(dir,'journal.sqlite');
  db=new DatabaseSync(file);
  function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const v=fn();db.exec('COMMIT');return v; } catch(e){db.exec('ROLLBACK');throw e;} }
  tx(()=>migrateArtifactJournal(db));
  db.exec('CREATE TABLE metadata (id TEXT PRIMARY KEY)');
  let epoch=1;
  const sha=artifactBytesDigest(Buffer.from('abc'));
  let observed={reference:'native:A',size:3,sha256:sha,chunkSha256:sha};
  const open=()=>createArtifactJournal({db,authorize:c=>c.epoch===epoch,inspect:()=>observed});
  let journal=open();
  const upload={job:'J',artifact:'A',key:'u1',subject:'S',worker:'W',claim:'C1',epoch:1,
    operation:'upload',offset:0,chunkSize:3,chunkSha256:sha,size:3,sha256:sha,reference:'native:A'};
  assert.throws(()=>journal.record(upload),/transaction_required/);
  const first=tx(()=>journal.record(upload));
  assert.deepEqual(tx(()=>journal.record({...upload})),first);
  assert.throws(()=>tx(()=>journal.record({...upload,size:4})),/mutation_conflict/);
  assert.throws(()=>tx(()=>journal.record({...upload,key:'u2',epoch:2})),/stale_authority/);
  observed={...observed,sha256:'0'.repeat(64)};
  assert.throws(()=>tx(()=>journal.record({...upload,artifact:'B',key:'bad'})),/artifact_integrity_mismatch/);
  assert.equal(journal.get('J','B'),null);
  observed={reference:'native:A',size:3,sha256:sha,chunkSha256:sha};
  assert.throws(()=>tx(()=>journal.record({...upload,artifact:'B',key:'wrong-size',size:4,chunkSize:4})),/artifact_integrity_mismatch/);
  const seal={job:'J',artifact:'A',key:'s1',subject:'S',worker:'W',claim:'C1',epoch:1,
    operation:'seal',size:3,sha256:sha,reference:'native:A'};
  assert.throws(()=>tx(()=>journal.record({...seal,size:2})),/seal_extent_mismatch/);
  assert.throws(()=>tx(()=>{journal.record(seal);db.prepare('INSERT INTO metadata VALUES(?)').run('A');throw Error('rollback');}),/rollback/);
  assert.equal(journal.get('J','A').sealed,false);
  assert.equal(db.prepare('SELECT count(*) n FROM metadata').get().n,0);
  const sealed=tx(()=>journal.record(seal));
  assert.equal(sealed.sealed,true);
  assert.throws(()=>tx(()=>journal.record({...upload,key:'u3'})),/artifact_sealed/);
  db.close();db=new DatabaseSync(file);journal=open();
  assert.deepEqual(tx(()=>journal.record(seal)),sealed);
  assert.equal(journal.get('J','A').origin_epoch,1);
  epoch=2;
  assert.throws(()=>tx(()=>journal.record(seal)),/stale_authority/);
  assert.equal(journal.get('J','A').origin_epoch,1,'regrant cannot rewrite sealed provenance');
  assert.throws(()=>tx(()=>journal.record({...seal,key:'s2',claim:'C2',epoch:2})),/artifact_sealed/);
  console.log('artifact journal offline assertions passed');
} finally { db?.close();rmSync(dir,{recursive:true,force:true}); }
