#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { parseWorkers } from '../src/workers.mjs';
import { dropEmptyPost54FixtureState } from '../src/test-support/pre-worker-fixture.mjs';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR??os.tmpdir(),'dalan-bridge-grant-lease-'));
const file=path.join(root,'bridge.db');
const limits={leaseMs:2000};
let now=Date.parse('2026-10-30T12:00:00.000Z');
const open=(name=file,leaseMs=limits.leaseMs)=>new Store(name,{now:()=>now,limits:{...limits,leaseMs},resumeIdleMs:0});
const payload=id=>({schema_version:1,request_id:id,brief:'grant lease test',inputs:[],expected_output:'lease evidence',execution_scope:'read-only'});
let store;
try {
  store=open();
  for(const id of ['default','long','persist']) store.submit(payload(`req_${id}`),{mode:'none'},null,'owner');
  const defaultClaim=store.claim('req_default','default-worker','local-principal',6);
  assert.equal(store.db.prepare('SELECT lease_ms FROM claims WHERE request_id=?').get('req_default').lease_ms,2000,'omitted duration did not use configured default');

  const long=store.claim('req_long','long-worker','local-principal',6,null,'dot',null,1500);
  const longBefore=store.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get('req_long');
  for(const invalid of [0,-1,2001,1.5,'100']) {
    assert.throws(()=>store.claim('req_long','rival','local-principal',6,null,'dot',null,invalid),/invalid lease_ms/);
    assert.deepEqual(store.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get('req_long'),longBefore,'invalid duration mutated claim');
  }
  now+=1000;
  const retry=store.claim('req_long','long-worker','local-principal',6,null,'dot',null,100);
  assert.equal(retry.claim_id,long.claim_id);
  assert.equal(store.db.prepare('SELECT lease_ms FROM claims WHERE request_id=?').get('req_long').lease_ms,1500,'live retry changed stored duration');
  const refreshed=store.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get('req_long');
  now+=1499;
  assert.throws(()=>store.claim('req_long','rival','local-principal',6,null,'dot',null,100),/already claimed by another claimant/,'shorter rival stole a live long grant');
  assert.deepEqual(store.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get('req_long'),refreshed,'refused rival altered old duration/deadline');
  now+=1;
  const next=store.claim('req_long','rival','local-principal',6,null,'dot',null,100);
  assert.equal(next.epoch,2,'claim did not regrant at the stored deadline');
  assert.equal(store.leaseExpiresAt(store.db.prepare('SELECT * FROM claims WHERE request_id=?').get('req_long')),new Date(now+100).toISOString());

  const sweepId='req_sweep';
  store.submit(payload(sweepId),{mode:'none'},null,'owner');
  store.claim(sweepId,'sweep-worker','local-principal',6,null,'dot',null,500);
  now+=499;
  assert.equal(store.claims().find(claim=>claim.request_id===sweepId).expired,false,'claim diagnostics expired before the stored deadline');
  assert(!store.sweepStaleLeases().includes(sweepId),'sweep used the owner maximum instead of the grant duration before deadline');
  now+=1;
  assert.equal(store.claims().find(claim=>claim.request_id===sweepId).expired,true,'claim diagnostics missed the stored deadline');
  assert(store.sweepStaleLeases().includes(sweepId),'sweep did not expire the claim at its stored deadline');

  // Reopen proves the active grant keeps its duration instead of adopting a later owner setting.
  const persisted=store.claim('req_persist','persist-worker','local-principal',6);
  assert.equal(persisted.duplicate,false);
  store.db.close();
  store=open(file,1000);
  assert.equal(store.db.prepare('SELECT lease_ms FROM claims WHERE request_id=?').get('req_persist').lease_ms,2000,'reopen changed a durable grant duration');
  assert.equal(store.leaseExpiresAt(store.db.prepare('SELECT * FROM claims WHERE request_id=?').get('req_persist')),new Date(now+2000).toISOString());

  // Model a schema-52 database. Its active claims inherit the old owner-configured lease on upgrade.
  store.db.close();
  const raw=new DatabaseSync(file);
  dropEmptyPost54FixtureState(raw);
  raw.exec('ALTER TABLE claims DROP COLUMN lease_ms; PRAGMA user_version=52;');
  raw.close();
  store=open(file,1800);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,73);
  assert.equal(store.db.prepare('SELECT lease_ms FROM claims WHERE request_id=?').get('req_persist').lease_ms,1800,'schema-52 grant did not inherit prior configured lease');

  // A blocked regrant keeps the expired old claim and its epoch intact.
  const before=store.db.prepare('SELECT claim_id,epoch,lease_ms,state FROM claims WHERE request_id=?').get('req_persist');
  store.db.prepare("INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES('uncertain_grant','blocker','req_persist','uncertain',?)").run(store.stamp());
  now+=1800;
  assert.throws(()=>store.claim('req_persist','successor','local-principal',6,null,'dot',null,100),/uncertain_delivery/);
  assert.deepEqual(store.db.prepare('SELECT claim_id,epoch,lease_ms,state FROM claims WHERE request_id=?').get('req_persist'),before,'uncertain delivery guard changed the prior grant');
  assert.throws(()=>store.progress('req_persist',persisted.claim_id,'expired authority','local-principal'),/lease_expired/,'old authority remained usable at its deadline');
  // Worker policy caps the persisted lease, including sliding and explicit renewal.
  const cap=900000, hour=3600000;
  const capped=new Store(path.join(root,'worker-cap.db'),{now:()=>now,limits:{leaseMs:hour,workerClaimLeaseMs:{muse:cap}},
    workers:parseWorkers({workers:{dot:{connections:[{issuer:'issuer',subject:'dot',client_id:'dot'}]},muse:{connections:[{issuer:'issuer',subject:'muse',client_id:'muse'}]}}})});
  try {
    const row=id=>capped.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
    const submit=(id,worker,protocol=false)=>capped.submit({...payload(id),...(protocol?{protocol:{profile:'job-v0',source:'test',scope:'test',policy:'test',destination:'test',retain_until_ms:now+24*hour}}:{})},{mode:'none'},null,'owner',false,null,'normal',null,null,null,worker,'worker');
    for(const [id,worker,requested,expected] of [['muse-default','muse',undefined,cap],['muse-long','muse',hour,cap],['muse-short','muse',60000,60000],['uncapped-default','dot',undefined,hour],['uncapped-short','dot',120000,120000]]) {
      submit(id,worker);
      capped.claim(id,'run','local-principal',10,null,worker,id,requested);
      assert.equal(row(id).lease_ms,expected,id);
      assert.equal(Date.parse(row(id).lease_deadline_at),now+expected,id);
    }
    const held=row('muse-default');
    now+=30000;
    capped.touchClaim('muse-default',held.claim_id,'local-principal','muse');
    assert.equal(row('muse-default').lease_ms,cap);
    assert.equal(Date.parse(row('muse-default').lease_deadline_at),now+cap,'ordinary claim-bearing tool activity renews capped lease');
    now+=cap-1;
    assert.equal(capped.sweepStaleLeases().includes('muse-default'),false);
    now+=1;
    assert.equal(capped.sweepStaleLeases().includes('muse-default'),true);
    assert.equal(row('muse-default').state,'abandoned');
    assert.equal(capped.db.prepare('SELECT status FROM assignments WHERE request_id=?').get('muse-default').status,'queued');
    assert.equal(row('uncapped-default').state,'active','uncapped worker keeps its slot');

    submit('muse-protocol','muse',true);
    const native=capped.claim('muse-protocol','native','local-principal',10,null,'muse','native',hour,{key:'claim',revision:1});
    assert.equal(row('muse-protocol').lease_ms,cap);
    now+=30000;
    const ctx={key:'renew',revision:native.revision};
    const renewed=capped.renewClaim('muse-protocol',native.claim_id,hour,ctx,'local-principal','muse');
    assert.equal(row('muse-protocol').lease_ms,cap);
    assert.equal(Date.parse(row('muse-protocol').lease_deadline_at),now+cap);
    assert.equal(renewed.leaseUntil,now+cap,'explicit renewal receipt matches capped deadline');
    assert.deepEqual(capped.renewClaim('muse-protocol',native.claim_id,hour,ctx,'local-principal','muse'),renewed);
    assert.throws(()=>capped.renewClaim('muse-protocol',native.claim_id,hour-1,ctx,'local-principal','muse'),/command_conflict/,'cap must not collapse distinct command identities');
  } finally { capped.db.close(); }
  console.log('grant-lease-test ok: defaults, validation, retries, deadline takeover, persistence, schema-52 migration and regrant guard');
} finally {
  try { store?.db.close(); } catch {}
  fs.rmSync(root,{recursive:true,force:true});
}
