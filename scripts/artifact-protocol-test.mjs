import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateArtifactJournal, createArtifactJournal, artifactBytesDigest } from '../src/artifact-journal.mjs';

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
