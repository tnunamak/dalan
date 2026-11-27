import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
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

const cleanGzip=gzipSync(Buffer.from('ordinary log text'));
assert.deepEqual(download('A-clean-gzip',cleanGzip),cleanGzip);
assert.throws(()=>download('A-incomplete-gzip',cleanGzip.subarray(0,-5)),error=>{
  assert.equal(error.code,'artifact_secret_content');
  assert.match(error.message,/^artifact_unscannable: [a-z_]+$/);
  return true;
});

const cleanZip=Buffer.from('UEsDBBQAAAAAAAAAAAB6g8OTEQAAABEAAAAJAAAAZW50cnkudHh0b3JkaW5hcnkgbG9nIHRleHRQSwECFAAUAAAAAAAAAAAAeoPDkxEAAAARAAAACQAAAAAAAAAAAAAAAAAAAAAAZW50cnkudHh0UEsFBgAAAAABAAEANwAAADgAAAAAAA==','base64');
assert.deepEqual(download('A-clean-zip',cleanZip),cleanZip);
const ordinaryBinary=Buffer.from([0x66,0x69,0x78,0x1f,0x8b,0x50,0x4b,0x03,0x04,0x74,0x61,0x69,0x6c]);
assert.deepEqual(download('A-incidental-archive-bytes',ordinaryBinary),ordinaryBinary);
const emptyZip=Buffer.alloc(22);
emptyZip.writeUInt32LE(0x06054b50,0);
assert.deepEqual(download('A-empty-zip',emptyZip),emptyZip);
const nested=gzipSync(cleanZip);
assert.deepEqual(download('A-clean-nested',nested),nested);
assert.throws(()=>download('A-unreadable-zip',cleanZip.subarray(0,-5)),/^Error: artifact_unscannable: invalid_archive$/);
assert.throws(()=>download('A-too-many-layers',gzipSync(nested)),/^Error: artifact_unscannable: nesting_limit$/);

// A secret inside an archive is found, whether the archive is gzip, a stored zip member or a deflated zip member.
const zipOf=(name,data,method)=>{
  const body=method===8?deflateRawSync(data):data, nameBytes=Buffer.from(name), crc=crc32(data);
  const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(method,8);
  local.writeUInt32LE(crc,14); local.writeUInt32LE(body.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(nameBytes.length,26);
  const central=Buffer.alloc(46); central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(method,10);
  central.writeUInt32LE(crc,16); central.writeUInt32LE(body.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(nameBytes.length,28);
  const localPart=Buffer.concat([local,nameBytes,body]), centralPart=Buffer.concat([central,nameBytes]);
  const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10);
  end.writeUInt32LE(centralPart.length,12); end.writeUInt32LE(localPart.length,16);
  return Buffer.concat([localPart,centralPart,end]);
};
const armored=fixtures[0][0];
assert.deepEqual(download('A-built-clean-zip',zipOf('notes.txt',Buffer.from('ordinary log text'),8),0),zipOf('notes.txt',Buffer.from('ordinary log text'),8),'the test zip builder makes a zip the scanner accepts');
for(const [label,bytes] of [['gzip',gzipSync(armored)],['stored-zip',zipOf('key.txt',armored,0)],['deflated-zip',zipOf('key.txt',armored,8)],['zip-in-gzip',gzipSync(zipOf('key.txt',armored,8))],['prefixed-zip',Buffer.concat([Buffer.from('#!stub\n'),zipOf('key.txt',armored,8)])],['4k-stub-zip',Buffer.concat([Buffer.alloc(4096,0x41),zipOf('key.txt',armored,0)])]]){
  assert.throws(()=>download(`A-secret-${label}`,bytes),error=>{
    assert.equal(error.code,'artifact_secret_content',label);
    assert.equal(error.message,'artifact_secret_content: private_key_armor',label);
    return true;
  });
}

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
