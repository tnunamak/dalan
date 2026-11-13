#!/usr/bin/env node
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
// Claim epochs, the lease, resume/abandon/takeover and fencing of stale holders, at store level with a fake clock.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';

// These cases cover the plain claim contract; the resume wake (idle own claims rotate on claim) is covered by resume-wake-test.
process.env.DOT_BRIDGE_RESUME_IDLE_MS='0';

const MIN=60000, LEASE=60*MIN, dir=mkdtempSync(join(tmpdir(),'dalan-bridge-claim-epoch-'));
let now=Date.parse('2026-10-08T00:00:00.000Z');
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:LEASE};
const open=(name,options={})=>new Store(join(dir,`${name}.db`),{now:()=>now,random:()=>0.5,capacity:6,limits,...options});
const payload=id=>({schema_version:1,request_id:id,brief:`epoch test ${id}`,inputs:[],expected_output:'one result',execution_scope:'read-only'});
const row=(s,id)=>s.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
const status=(s,id)=>s.db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id).status;
const activity=(s,id)=>row(s,id).last_claim_activity_at;
const pass=message=>console.log(`PASS ${message}`);

try {
  // ---- migration from a v19 database: existing claim_ids stay valid at epoch 1, nothing is abandoned
  {
    const file=join(dir,'migrate.db');
    let s=open('migrate');
    s.submit(payload('req_old_fresh'),{mode:'none'},null,'owner');s.submit(payload('req_old_idle'),{mode:'none'},null,'owner');
    const fresh=s.claim('req_old_fresh','dot','subject_a',6),idle=s.claim('req_old_idle','dot','subject_a',6);
    s.db.close();
    // Rebuild claims with the exact v19 column set, as the live DB has it before this release.
    const raw=new DatabaseSync(file);
    preWorkerFixture({db:raw});
    raw.exec(`PRAGMA foreign_keys=OFF; BEGIN;
      CREATE TABLE claims_v19 (request_id TEXT PRIMARY KEY REFERENCES assignments(request_id), claimant TEXT NOT NULL, claim_id TEXT NOT NULL UNIQUE, claimed_at TEXT NOT NULL, subject TEXT NOT NULL DEFAULT 'local-principal', last_progress_at TEXT, last_claim_activity_at TEXT, last_seen_note_seq INTEGER NOT NULL DEFAULT 0);
      INSERT INTO claims_v19 SELECT request_id,claimant,claim_id,claimed_at,subject,last_progress_at,last_claim_activity_at,last_seen_note_seq FROM claims;
      DROP TABLE claims; ALTER TABLE claims_v19 RENAME TO claims; PRAGMA user_version=19; COMMIT;`);
    assert.deepEqual(raw.prepare("SELECT name FROM pragma_table_info('claims') WHERE name IN ('epoch','state','abandoned_at','abandon_reason')").all(),[],'fixture is not a v19 claims table');
    raw.close();
    now+=2*LEASE; // req_old_idle is far past its lease when the migration runs
    s=open('migrate');
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,66);
    for(const [id,c] of [['req_old_fresh',fresh],['req_old_idle',idle]]) {
      const r=row(s,id);
      assert.equal(r.claim_id,c.claim_id,'migration changed a claim_id');assert.equal(r.epoch,1);assert.equal(r.state,'active');assert.equal(r.abandoned_at,null);
      assert.equal(status(s,id),'claimed','migration requeued a claim');
    }
    assert.deepEqual(s.claims().map(c=>[c.request_id,c.epoch,c.expired]),[['req_old_fresh',1,true],['req_old_idle',1,true]],'claims() after migration');
    assert.throws(()=>s.progress('req_old_idle',idle.claim_id,'too late','subject_a'),/lease_expired/,'an expired pre-migration claim must be refused at the deadline');
    assert.equal(s.claims().find(c=>c.request_id==='req_old_idle').expired,true,'a refused call did not extend the lease');
    now-=2*LEASE-MIN; // back inside the lease: the pre-migration claim_ids still act
    assert.equal(s.progress('req_old_idle',idle.claim_id,'still here','subject_a').recorded,true,'pre-migration claim_id rejected');
    assert.equal(s.claims().find(c=>c.request_id==='req_old_idle').expired,false,'progress inside the lease extends it');
    assert.equal(s.claim('req_old_fresh','dot','subject_a',6).claim_id,fresh.claim_id,'pre-migration claim retry changed the claim_id');
    s.db.close();
    s=open('migrate');assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,66);s.db.close();
  }
  pass('v19 migration keeps claim_ids valid at epoch 1, abandons nothing, reopens cleanly');

  // ---- a matching retry refreshes activity using the grant's stored duration
  {
    const s=open('retry');
    s.submit(payload('req_retry'),{mode:'none'},null,'owner');
    const first=s.claim('req_retry','dot','subject_a',6,null,'dot',null,1000);
    assert.equal(first.epoch,1);assert.equal(first.duplicate,false);
    const original=s.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get('req_retry');
    now+=500;
    const again=s.claim('req_retry','dot','subject_a',6,null,'dot',null,100);
    assert.equal(again.claim_id,first.claim_id);assert.equal(again.duplicate,true);assert.equal(again.epoch,1);
    const retried=s.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get('req_retry');
    assert.equal(retried.lease_ms,original.lease_ms,'retry changed the stored duration');assert.equal(retried.last_claim_activity_at,new Date(now).toISOString(),'exact retry did not refresh activity');
    now+=999;
    const beforeRival=JSON.stringify(retried);
    assert.throws(()=>s.claim('req_retry','rival','subject_a',6,null,'dot',null,100),/claim_busy|already claimed by another claimant/,'rival took the longer grant early');
    assert.equal(JSON.stringify(s.db.prepare('SELECT lease_ms,last_claim_activity_at FROM claims WHERE request_id=?').get('req_retry')),beforeRival,'failed shorter claim changed the old duration or deadline');
    now+=1;
    const late=s.claim('req_retry','rival','subject_a',6,null,'dot',null,2000);
    assert.notEqual(late.claim_id,first.claim_id,'a retry after the deadline is not a renewal: it starts a new epoch');assert.equal(late.duplicate,false);assert.equal(late.epoch,2);
    assert.equal(s.db.prepare('SELECT lease_ms FROM claims WHERE request_id=?').get('req_retry').lease_ms,2000,'new epoch did not store its requested duration');
    assert.throws(()=>s.progress('req_retry',first.claim_id,'old','subject_a'),/claim_superseded/,'the expired claim_id is fenced');
    assert.throws(()=>s.claim('req_retry','dot','subject_b',6),/^Error: already claimed by another claimant$/,'subject remains part of claim identity');
    s.db.close();
  }
  pass('matching retry retains its duration; a shorter rival cannot change or take the live grant');

  // ---- resume: same subject, new claim_id, next epoch; the old claim_id is fenced for progress/finish/touch
  {
    const s=open('resume');
    s.submit(payload('req_resume'),{mode:'none'},null,'owner');
    const c1=s.claim('req_resume','dot','subject_a',6);
    assert.throws(()=>s.resume('req_resume','subject_b'),/no active claim for this subject/);
    const before=row(s,'req_resume');
    assert.equal(before.claim_id,c1.claim_id,'failed resume changed the claim');
    now+=5*MIN;
    assert.throws(()=>s.resume('req_resume','subject_a'),/prior lease has not expired/,'explicit resume cannot fence a live lease');
    assert.equal(row(s,'req_resume').claim_id,c1.claim_id,'early resume changed the claim');
    now+=LEASE-5*MIN; // exact lease deadline
    const r=s.resume('req_resume','subject_a');
    assert.notEqual(r.claim_id,c1.claim_id);assert.equal(r.epoch,2);assert.equal(r.previous_epoch,1);
    assert.equal(row(s,'req_resume').epoch,2);assert.equal(row(s,'req_resume').claimed_at,before.claimed_at,'resume is the same holder');
    assert.throws(()=>s.progress('req_resume',c1.claim_id,'stale','subject_a'),/claim_superseded/);
    assert.throws(()=>s.finish('req_resume',c1.claim_id,'completed','stale','stale','subject_a'),/claim_superseded/);
    assert.throws(()=>s.assertClaim('req_resume',c1.claim_id,'subject_a'),/claim_superseded/);
    const lease=activity(s,'req_resume');
    now+=MIN;s.touchClaim('req_resume',c1.claim_id,'subject_a');
    assert.equal(activity(s,'req_resume'),lease,'stale claim_id extended the lease after resume');
    assert.equal(s.claim('req_resume','dot','subject_a',6).claim_id,r.claim_id,'claim retry after resume must return the current claim_id');
    assert.equal(s.progress('req_resume',r.claim_id,'working','subject_a').recorded,true);
    assert.equal(s.finish('req_resume',r.claim_id,'completed','done','done','subject_a').duplicate,false);
    assert.throws(()=>s.resume('req_resume','subject_a'),/assignment finished/);
    s.db.close();
  }
  pass('resume issues a new claim_id and epoch; stale holder rejected for progress/finish/touch');

  // ---- touch requires the matching active claim_id; get-style note marking does not extend the lease
  {
    const s=open('touch');
    s.submit(payload('req_touch'),{mode:'none'},null,'owner');
    const c=s.claim('req_touch','dot','subject_a',6),lease=activity(s,'req_touch');
    now+=10*MIN;
    s.touchClaim('req_touch','claim_00000000-0000-0000-0000-000000000000','subject_a');
    s.touchClaim('req_touch',c.claim_id,'subject_b');
    s.markNotesSeen('req_touch','subject_a');
    assert.equal(activity(s,'req_touch'),lease,'wrong claim_id, wrong subject or get extended the lease');
    s.touchClaim('req_touch',c.claim_id,'subject_a');
    assert.equal(activity(s,'req_touch'),new Date(now).toISOString(),'holder touch did not extend the lease');
    s.db.close();
  }
  pass('touch with a wrong claim_id or subject does not extend the lease; get does not either');

  // ---- expired-lease takeover by another claimant: refused before expiry, fences the old holder after
  {
    const s=open('takeover',{capacity:1});
    s.submit(payload('req_take'),{mode:'none'},null,'owner');
    const c1=s.claim('req_take','dot','subject_a',1);
    now+=LEASE-1;
    assert.throws(()=>s.claim('req_take','rival','subject_b',1),/^Error: already claimed by another claimant$/);
    assert.equal(row(s,'req_take').claim_id,c1.claim_id);assert.equal(row(s,'req_take').epoch,1);
    assert.equal(s.claims()[0].expired,false);
    assert.equal(s.status().stale_claims.count,1,'idle warning precedes lease expiry without enabling takeover');
    now+=1;
    assert.equal(s.claims()[0].expired,true);assert.equal(s.status().stale_claims.count,1);
    assert.equal(status(s,'req_take'),'claimed','lease expiry alone changed the assignment');
    s.db.prepare('INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES(?,?,?,?,?,?,?)').run('check_unverified','req_take',c1.claim_id,'default','d'.repeat(64),'completed',s.stamp());
    assert.throws(()=>s.claim('req_take','rival','subject_b',1),/claim_effects_unverified/,'expired host work without a verified stop blocks regrant');
    s.db.prepare("UPDATE check_jobs SET stop_verified=1 WHERE id='check_unverified'").run();
    const t=s.claim('req_take','rival','subject_b',1); // capacity 1: the request being taken over does not count against it
    assert.equal(t.epoch,2);assert.equal(t.duplicate,false);assert.notEqual(t.claim_id,c1.claim_id);
    const r=row(s,'req_take');
    assert.deepEqual([r.claimant,r.subject,r.state,r.epoch,r.abandoned_at,r.claimed_at],['rival','subject_b','active',2,null,new Date(now).toISOString()]);
    assert.equal(s.status().stale_claims.count,0);
    assert.throws(()=>s.progress('req_take',c1.claim_id,'stale','subject_a'),/^Error: invalid claim$/);
    assert.throws(()=>s.finish('req_take',c1.claim_id,'completed','stale','stale','subject_a'),/^Error: invalid claim$/);
    const lease=activity(s,'req_take');
    now+=MIN;s.touchClaim('req_take',c1.claim_id,'subject_a');
    assert.equal(activity(s,'req_take'),lease,'stale holder extended the new holder lease');
    assert.throws(()=>s.claim('req_take','dot','subject_a',1),/already claimed by another claimant/,'old holder took the claim back inside the new lease');
    assert.equal(s.progress('req_take',t.claim_id,'mine now','subject_b').recorded,true);
    s.db.close();
  }
  pass('takeover refused before lease expiry; after expiry it bumps the epoch and fences the old holder');

  // ---- takeover and abandon refused while a delivery is uncertain or sending, with no state change
  for(const state of ['uncertain','sending']) {
    const s=open(`uncertain-${state}`);
    s.subscribe('sub_a','http://127.0.0.1/hook','whsec_test',new Date(now+48*3600000).toISOString());
    const id=`req_${state}`;
    s.submit(payload(id),'thread_fake','env_fake','owner');
    s.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id=?").run(id);
    const c=s.claim(id,'dot','subject_a',6);
    s.db.prepare('INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES(?,?,?,?,?)').run(`evt_${state}`,'blocker',id,state,s.stamp());
    now+=2*LEASE;
    const snapshot=()=>JSON.stringify({claim:row(s,id),status:status(s,id),notifications:s.db.prepare('SELECT id,state FROM notifications WHERE request_id=? ORDER BY rowid').all(id)});
    const before=snapshot();
    assert.equal(s.claims()[0].uncertain_deliveries,1);
    assert.throws(()=>s.claim(id,'rival','subject_b',6),/^Error: uncertain_delivery: reconcile first$/);
    assert.throws(()=>s.abandon(id,{actor:'operator',reason:'test'}),/^Error: uncertain_delivery: reconcile first$/);
    assert.equal(snapshot(),before,`refused ${state} takeover or abandon changed state`);
    assert.throws(()=>s.progress(id,c.claim_id,'holder past its deadline','subject_a'),/lease_expired/,'the holder lost authority at the deadline although takeover waits for reconcile');
    assert.equal(snapshot(),before,`refused ${state} progress changed state`);
    s.db.prepare("UPDATE notifications SET state='delivered' WHERE id=?").run(`evt_${state}`);
    now+=2*LEASE;
    assert.equal(s.claim(id,'rival','subject_b',6).epoch,2,'takeover after reconcile');
    s.db.close();
  }
  pass('takeover and abandon refused while a delivery is uncertain or sending; nothing changes');

  // ---- review fixes: resume, claim after abandon, re-announce and subscribe all wait for an uncertain delivery; webhook events do not count
  for(const state of ['uncertain','sending']) {
    const s=open(`review-${state}`);
    s.subscribe('sub_a','http://127.0.0.1/hook','whsec_test',new Date(now+48*3600000).toISOString());
    const id=`req_review_${state}`;
    s.submit(payload(id),'thread_fake','env_fake','owner');
    s.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id=?").run(id);
    // A webhook availability event in flight is not an owner delivery.
    s.db.prepare('INSERT INTO notifications(id,kind,request_id,subscription_id,state,created_at) VALUES(?,?,?,?,?,?)').run(`evt_hook_${state}`,'event',id,'sub_a','sending',s.stamp());
    const c=s.claim(id,'dot','subject_a',6);
    now+=LEASE; // reach expiry so delivery uncertainty is the remaining regrant blocker
    assert.equal(s.claims()[0].uncertain_deliveries,0,'webhook event counted as an owner delivery');
    s.db.prepare("UPDATE notifications SET state='delivered' WHERE id=?").run(`evt_hook_${state}`);
    s.db.prepare('INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES(?,?,?,?,?)').run(`evt_blk_${state}`,'blocker',id,'pending',s.stamp());
    // Resume is a new epoch too.
    s.db.prepare("UPDATE notifications SET state=? WHERE id=?").run(state,`evt_blk_${state}`);
    const before=JSON.stringify(row(s,id));
    assert.throws(()=>s.resume(id,'subject_a'),/^Error: uncertain_delivery: reconcile first$/);
    assert.equal(JSON.stringify(row(s,id)),before,'refused resume changed the claim');
    // Abandon while the blocker is still pending, then the blocker starts sending: no new epoch, no re-announce.
    s.db.prepare("UPDATE notifications SET state='pending' WHERE id=?").run(`evt_blk_${state}`);
    assert.equal(s.abandon(id,{actor:'operator',reason:'test'}).status,'queued');
    s.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id=? AND kind='event'").run(id);
    s.db.prepare("UPDATE notifications SET state=? WHERE id=?").run(state,`evt_blk_${state}`);
    assert.throws(()=>s.claim(id,'rival','subject_b',6),/^Error: uncertain_delivery: reconcile first$/);
    assert.equal(status(s,id),'queued');
    const events=()=>s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id=? AND kind='event'").get(id).n;
    const n=events();
    now+=24*3600000;s.recordWorkerCall('subject_a','list_pending');
    s.reannounceQueued(limits);
    s.subscribe('sub_b','http://127.0.0.1/hook2','whsec_test2',new Date(now+48*3600000).toISOString());
    assert.equal(events(),n,'request with an uncertain delivery was re-announced');
    s.db.prepare("UPDATE notifications SET state='delivered' WHERE id=?").run(`evt_blk_${state}`);
    assert.equal(s.claim(id,'rival','subject_b',6).epoch,2,'claim after reconcile');
    assert.notEqual(row(s,id).claim_id,c.claim_id);
    s.db.close();
  }
  pass('resume, claim after abandon, re-announce and subscribe wait for an uncertain or sending owner delivery; webhook events do not block');

  // ---- abandon: requeue, re-announce, fence the old claim_id; claim after abandon bumps the epoch
  {
    const s=open('abandon');
    s.subscribe('sub_a','http://127.0.0.1/hook','whsec_test',new Date(now+48*3600000).toISOString());
    s.submit(payload('req_ab'),'thread_fake','env_fake','owner');
    s.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id='req_ab'").run();
    const events=()=>s.db.prepare("SELECT count(*) n FROM notifications WHERE kind='event' AND request_id='req_ab' AND state='pending'").get().n;
    assert.throws(()=>s.abandon('req_ab'),/no active claim/);
    const c1=s.claim('req_ab','dot','subject_a',6);
    assert.equal(events(),0);
    const abandonedAt=new Date(now).toISOString();
    const result=s.abandon('req_ab',{actor:'operator',reason:'worker lost'});
    assert.throws(()=>s.claim('req_ab','dot','subject_a',6),/prior lease has not expired/,'abandon revokes authority but cannot permit early regrant');
    now+=LEASE; // fake clock to exact expiry; no real TTL wait
    assert.equal(result.status,'queued');assert.deepEqual([result.abandoned.claim_id,result.abandoned.epoch,result.abandoned.reason,result.abandoned.actor],[c1.claim_id,1,'worker lost','operator']);
    assert.equal(status(s,'req_ab'),'queued');
    const r=row(s,'req_ab');
    assert.deepEqual([r.state,r.abandon_reason,r.abandoned_at],['abandoned','worker lost',abandonedAt]);
    assert.equal(events(),1,'abandon did not queue an availability event');
    assert.ok(s.listPending().some(x=>x.request_id==='req_ab'),'abandoned assignment missing from list_pending');
    assert.deepEqual(s.claims(),[],'abandoned claim listed as active');
    assert.equal(s.attention('subject_a').length,0);
    assert.throws(()=>s.progress('req_ab',c1.claim_id,'stale','subject_a'),/^Error: invalid claim$/);
    assert.throws(()=>s.finish('req_ab',c1.claim_id,'completed','stale','stale','subject_a'),/^Error: invalid claim$/);
    assert.throws(()=>s.resume('req_ab','subject_a'),/no active claim for this subject/);
    assert.throws(()=>s.abandon('req_ab'),/no active claim/);
    const c2=s.claim('req_ab','dot','subject_a',6);
    assert.equal(c2.epoch,2);assert.equal(c2.duplicate,false);assert.notEqual(c2.claim_id,c1.claim_id);
    assert.equal(row(s,'req_ab').state,'active');assert.equal(row(s,'req_ab').abandon_reason,null);
    s.finish('req_ab',c2.claim_id,'completed','done','done','subject_a');
    assert.throws(()=>s.abandon('req_ab'),/assignment is terminal/);
    s.submit(payload('req_ab_cancel'),{mode:'none'},null,'owner');s.claim('req_ab_cancel','dot','subject_a',6);s.cancel('req_ab_cancel');
    assert.throws(()=>s.abandon('req_ab_cancel'),/assignment is terminal/);
    s.db.close();
  }
  pass('abandon requeues, queues an availability event and fences the old claim; claim after abandon is epoch 2');

  // ---- rebind: workspace and uploads follow resume, takeover and claim-after-abandon; check evidence keeps its claim_id
  {
    const s=open('rebind');
    s.submit(payload('req_bind'),{mode:'none'},null,'owner');
    const c1=s.claim('req_bind','dot','subject_a',6),at=s.stamp();
    s.db.prepare('INSERT INTO workspaces(request_id,claim_id,base_sha,path,created_at) VALUES(?,?,?,?,?)').run('req_bind',c1.claim_id,'a'.repeat(40),join(dir,'wt-bind'),at);
    const artifact=s.db.prepare('INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sha256,sealed,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    artifact.run('art_upload_sealed','req_bind',c1.claim_id,'upload',join(dir,'a1'),3,'f'.repeat(64),1,at);
    artifact.run('art_upload_open','req_bind',c1.claim_id,'upload',join(dir,'a2'),1,null,0,at);
    artifact.run('art_check_output','req_bind',c1.claim_id,'check-output',join(dir,'a3'),5,'e'.repeat(64),1,at);
    s.db.prepare('INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES(?,?,?,?,?,?,?)').run('check_1','req_bind',c1.claim_id,'default','d'.repeat(64),'completed',at);
    s.db.prepare('UPDATE check_jobs SET stop_verified=1 WHERE id=\'check_1\'').run();
    s.db.prepare('INSERT INTO check_runs(id,request_id,claim_id,check_id,exit_code,timed_out,output_artifact_id,output_sha256,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('check_1','req_bind',c1.claim_id,'default',0,0,'art_check_output','e'.repeat(64),10,at);
    const bound=()=>({workspace:s.db.prepare('SELECT claim_id FROM workspaces WHERE request_id=?').get('req_bind').claim_id,
      artifacts:Object.fromEntries(s.db.prepare('SELECT id,claim_id FROM artifacts WHERE request_id=? ORDER BY id').all('req_bind').map(x=>[x.id,x.claim_id])),
      job:s.db.prepare('SELECT claim_id FROM check_jobs WHERE id=?').get('check_1').claim_id,run:s.db.prepare('SELECT claim_id FROM check_runs WHERE id=?').get('check_1').claim_id});
    const expect=current=>({workspace:current,artifacts:{art_check_output:c1.claim_id,art_upload_open:c1.claim_id,art_upload_sealed:current},job:c1.claim_id,run:c1.claim_id});
    now+=LEASE; // resume and inherited data are available only after expiry
    const c2=s.resume('req_bind','subject_a');
    assert.deepEqual(bound(),expect(c2.claim_id),'resume rebind');
    now+=LEASE;
    const c3=s.claim('req_bind','rival','subject_b',6);
    assert.deepEqual(bound(),expect(c3.claim_id),'takeover rebind');
    now+=LEASE;
    s.abandon('req_bind',{reason:'test'});
    const c4=s.claim('req_bind','third','subject_c',6);
    assert.equal(c4.epoch,4);
    assert.deepEqual(bound(),expect(c4.claim_id),'claim-after-abandon rebind');
    // finish accepts rebound sealed uploads and bridge-written check output, but not an unsealed upload or another request's artifact
    s.assertSealedArtifacts('req_bind',c4.claim_id,['art_upload_sealed','art_check_output']);
    assert.throws(()=>s.assertSealedArtifacts('req_bind',c4.claim_id,['art_upload_open']),/invalid sealed artifact/);
    assert.throws(()=>s.assertSealedArtifacts('req_bind',c1.claim_id,['art_upload_sealed']),/invalid sealed artifact/,'stale claim_id accepted for an upload');
    s.submit(payload('req_other'),{mode:'none'},null,'owner');
    assert.throws(()=>s.assertSealedArtifacts('req_other',c4.claim_id,['art_upload_sealed']),/invalid sealed artifact/);
    assert.equal(s.finish('req_bind',c4.claim_id,'completed','done','done','subject_c').duplicate,false);
    assert.equal(s.get('req_bind').claim.epoch,4);
    s.db.close();
  }
  pass('workspace and uploads rebind on every new claim_id; check evidence keeps its claim_id; finish accepts rebound sealed artifacts');

  console.log('PASS claim epoch test');
} catch(error) { console.error(`FAIL ${error.stack||error}`); process.exitCode=1; }
finally { rmSync(dir,{recursive:true,force:true}); }
