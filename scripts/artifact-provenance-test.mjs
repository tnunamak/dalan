#!/usr/bin/env node
// An upload keeps the claim and epoch that created it when a takeover rebinds it, so the owner can see what a finish inherited.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-prov-'));
process.env.HOME=home; // src/workspace.mjs reads HOME at import
const { Store } = await import('../src/store.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const MIN=60000,HOUR=60*MIN; let now=Date.parse('2026-10-24T00:00:00.000Z');
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:HOUR};
try {
  const s=new Store(path.join(home,'bridge.db'),{now:()=>now,capacity:2,limits});
  const ws=new Workspace(s,false);
  s.submit({schema_version:1,request_id:'req_prov',brief:'provenance',inputs:[],expected_output:'one',execution_scope:'read-only'},{mode:'none'},'','owner');
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,65);
  const one=s.claim('req_prov','worker-a','sub-a',2), bytes=Buffer.from('sealed by epoch one');
  ws.chunk('req_prov',one.claim_id,'sub-a','art_provenance01',0,bytes.toString('base64'),true,createHash('sha256').update(bytes).digest('hex'));
  let [a]=s.sealedUploads('req_prov',{clientIds:true});
  assert.deepEqual([a.id,a.origin_claim_id,a.origin_epoch,a.inherited],['art_provenance01',one.claim_id,1,false],'epoch 1 owns its own upload');
  now+=HOUR; // the lease ends; another claimant takes over
  const two=s.claim('req_prov','worker-b','sub-b',2);
  assert.equal(two.epoch,2);
  [a]=s.sealedUploads('req_prov',{clientIds:true});
  assert.deepEqual([a.origin_claim_id,a.origin_epoch,a.inherited],[one.claim_id,1,true],'after takeover the upload is inherited from epoch 1');
  assert.equal(s.db.prepare('SELECT claim_id FROM artifacts WHERE id=?').get(s.db.prepare('SELECT id FROM artifacts').get().id).claim_id,two.claim_id,'rebind still moves claim_id');
  s.assertSealedArtifacts('req_prov',two.claim_id,['art_provenance01']); // who may cite what is unchanged
  const fin=s.finish('req_prov',two.claim_id,'completed','done','cites A','sub-b',{artifacts:s.sealedUploads('req_prov')},'dot');
  assert.equal(fin.result_authority,true);
  const got=s.get('req_prov').report.workspace_evidence.artifacts[0];
  assert.deepEqual([got.origin_epoch,got.inherited],[1,true],'finish evidence carries the origin');
  console.log('PASS upload provenance survives takeover, is shown in get and finish evidence');

  // C6: only sealed uploads carry across epochs. Unsealed staging of an old epoch stays bound to its claim and cannot be continued.
  s.submit({schema_version:1,request_id:'req_seal',brief:'sealed only',inputs:[],expected_output:'one',execution_scope:'read-only'},{mode:'none'},'','owner');
  const e1=s.claim('req_seal','worker-a','sub-a',2), sha=b=>createHash('sha256').update(b).digest('hex');
  const half=Buffer.from('first half of a big file, '), sealedBytes=Buffer.from('this one was sealed');
  ws.chunk('req_seal',e1.claim_id,'sub-a','art_halfhalf01',0,half.toString('base64'),false);
  ws.chunk('req_seal',e1.claim_id,'sub-a','art_sealedone1',0,sealedBytes.toString('base64'),true,sha(sealedBytes));
  now+=HOUR;
  const e2=s.claim('req_seal','worker-b','sub-b',2);
  assert.equal(e2.epoch,2);
  const row=alias=>s.db.prepare("SELECT * FROM artifacts WHERE request_id='req_seal' AND client_artifact_id=?").get(alias);
  assert.equal(row('art_sealedone1').claim_id,e2.claim_id,'the sealed upload is rebound to epoch 2');
  const staging=s.db.prepare("SELECT * FROM artifacts WHERE request_id='req_seal' AND sealed=0").get();
  assert.equal(staging.claim_id,e1.claim_id,'unsealed staging stays bound to the epoch that made it');
  assert.throws(()=>ws.chunk('req_seal',e2.claim_id,'sub-b','art_halfhalf01',half.length,Buffer.from('second half').toString('base64'),true,sha(Buffer.concat([half,Buffer.from('second half')]))),/wrong upload offset/,'epoch 2 cannot append to the unsealed upload of epoch 1');
  assert.throws(()=>s.assertSealedArtifacts('req_seal',e2.claim_id,['art_halfhalf01']),/invalid sealed artifact/,'the unsealed upload cannot be cited');
  assert.equal(fs.statSync(staging.path).size,half.length,'the old staging bytes are untouched');
  // A fresh upload under the same client alias starts at offset 0 and does not collide with the old unsealed row.
  const fresh=Buffer.from('epoch two starts over');
  ws.chunk('req_seal',e2.claim_id,'sub-b','art_halfhalf01',0,fresh.toString('base64'),true,sha(fresh));
  s.assertSealedArtifacts('req_seal',e2.claim_id,['art_halfhalf01','art_sealedone1']);
  const listed=Object.fromEntries(s.sealedUploads('req_seal',{clientIds:true}).map(u=>[u.id,u]));
  assert.deepEqual([listed.art_sealedone1.origin_epoch,listed.art_sealedone1.inherited],[1,true],'the sealed upload is inherited from epoch 1');
  assert.deepEqual([listed.art_halfhalf01.origin_epoch,listed.art_halfhalf01.inherited,listed.art_halfhalf01.sha256],[2,false,sha(fresh)],'the fresh upload belongs to epoch 2');
  assert.equal(s.db.prepare("SELECT count(*) n FROM artifacts WHERE request_id='req_seal' AND sealed=0").get().n,1,'the old unsealed row is kept as evidence until retention cleanup');
  // A third epoch carries both sealed uploads and still leaves the old staging behind.
  now+=HOUR;
  const e3=s.claim('req_seal','worker-c','sub-c',2);
  s.assertSealedArtifacts('req_seal',e3.claim_id,['art_halfhalf01','art_sealedone1']);
  assert.equal(s.db.prepare('SELECT claim_id FROM artifacts WHERE id=?').get(staging.id).claim_id,e1.claim_id);
  console.log('PASS only sealed uploads carry across epochs; unsealed staging is not continuable');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
