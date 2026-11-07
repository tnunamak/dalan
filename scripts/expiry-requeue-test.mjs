#!/usr/bin/env node
// Preparation-expiry requeues (defect A, design section 1.4/4) at store level with an injected clock: a learned queue_p90
// deadline requeues with a fresh learned deadline up to 2 times and never past created_at + 12 h; requester deadlines never
// requeue; the cancel error no longer promises a requeue; get exposes expiry_requeues and the requeue lifecycle events and
// status reports queued_expired_requeued. Written first, before the sweep change; each block asserts the new behaviour.
// Seeded queue history: five claimed jobs for worker 'dot', kind read-only, with zero wait each, so defaultValidUntil has the
// 5 samples QUEUE_WINDOW needs and its p90 yields the 15-minute floor window.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';

const home=await mkdtemp(join(tmpdir(),'dalan-bridge-expiry-requeue-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const MIN=60000,HOUR=3600000,key=`whsec_${randomBytes(32).toString('base64')}`;
let now=Date.parse('2026-10-10T16:00:00.000Z');
const iso=ms=>new Date(ms).toISOString();
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:HOUR,laneCapacity:6,rewakeMs:90000,rewakeWindowMs:2*HOUR,breakSilenceMs:20*MIN,breakProbeMs:30*MIN,maxClaimsPerHour:30,maxToolCallsPerHour:330,maxResponseBytesPerHour:2500000};
const payload=(id,validUntil)=>({schema_version:1,request_id:id,brief:`expiry requeue test ${id}`,inputs:[],expected_output:'findings',execution_scope:'read-only',...(validUntil!==undefined?{prepared_at:iso(now-MIN),valid_until:validUntil}:{})});
const fresh=(name,options={})=>{const s=new Store(join(home,`${name}.db`),{now:()=>now,capacity:6,backgroundMaxInFlight:2,limits,...options});s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+48*HOUR).toISOString());return s;};
const seed=(s,n)=>{for(let i=0;i<n;i++){const id=`seed_${i}`;s.submit(payload(id,iso(now+HOUR)),{mode:'none'},'','owner');s.claim(id,'dot','local-principal',6);}};
const asLearned=(s,id)=>s.db.prepare("UPDATE assignments SET valid_until_source='queue_p90' WHERE request_id=?").run(id);
try {
  // A1. Learned deadline requeues instead of cancelling.
  {
    const s=fresh('a1');
    seed(s,5);
    s.submit(payload('a1_job',iso(now+10*MIN)),{mode:'none'},'','owner');
    asLearned(s,'a1_job');
    now+=16*MIN; // past the 10-minute learned deadline; the fresh window is the 15-minute floor
    const bounds=s.queueWaitEvidence('dot','read-only').expired_lower_bounds;
    const swept=s.sweepExpired();
    assert(!swept.includes('a1_job')&&swept.requeued?.includes('a1_job'),'A1: learned row was cancelled instead of requeued: '+JSON.stringify(swept));
    assert(s.queueWaitEvidence('dot','read-only').expired_lower_bounds===bounds+1,'A1: a requeue must add one censored lower bound: '+JSON.stringify(s.queueWaitEvidence('dot','read-only')));
    const got=s.get('a1_job');
    assert(got.status==='queued'&&got.cancelled_reason===null,'A1 status: '+JSON.stringify([got.status,got.cancelled_reason]));
    assert(got.expiry_requeues===1,'A1 requeue count: '+got.expiry_requeues);
    assert(got.valid_until===iso(now+15*MIN),'A1 fresh deadline: '+got.valid_until);
    assert(got.lifecycle_events.some(e=>e.type==='queued'&&e.actor==='system'&&e.reason==='expired_requeued'),'A1 lifecycle: '+JSON.stringify(got.lifecycle_events));
    assert(s.status({limits}).queued_expired_requeued.count===1,'A1 status count: '+JSON.stringify(s.status({limits}).queued_expired_requeued));
    assert(s.listPending().some(r=>r.request_id==='a1_job'),'A1: requeued row not listed as live work');
    log('A1 learned deadline requeues: stays queued, fresh deadline, expiry_requeues 1, cancelled_reason null, expired_requeued lifecycle event, queued_expired_requeued 1, one censored lower bound, listed again');
  }

  // A2. Requeue budget exhausts into an honest cancellation.
  {
    const s=fresh('a2');
    seed(s,5);
    s.submit(payload('a2_job',iso(now+10*MIN)),{mode:'none'},'','owner');
    s.db.prepare("UPDATE assignments SET valid_until_source='queue_p90',expiry_requeues=2 WHERE request_id=?").run('a2_job');
    now+=16*MIN;
    assert(s.sweepExpired().includes('a2_job'),'A2: budget-exhausted row was not cancelled');
    const got=s.get('a2_job');
    assert(got.status==='cancelled'&&got.cancelled_reason==='expired'&&got.expiry_requeues===2,'A2 row: '+JSON.stringify([got.status,got.cancelled_reason,got.expiry_requeues]));
    let threw=null;try{s.claim('a2_job','dot','local-principal',6);}catch(e){threw=e.message;}
    assert(/^assignment_expired: its prepared inputs were valid until /.test(threw)&&/will not requeue/.test(threw)&&!/fresh preparation will be queued/.test(threw),'A2 error text: '+threw);
    log('A2 budget-exhausted learned row cancels with reason expired and an error that names the deadline and states no requeue will happen');
  }

  // A3. Requester deadline is never requeued.
  {
    const s=fresh('a3');
    s.submit(payload('a3_job',iso(now+10*MIN)),{mode:'none'},'','owner'); // submit keeps valid_until_source 'requester'
    now+=16*MIN;
    assert(s.sweepExpired().includes('a3_job'),'A3: requester row was not cancelled');
    const got=s.get('a3_job');
    assert(got.status==='cancelled'&&got.cancelled_reason==='expired'&&got.expiry_requeues===0,'A3 row: '+JSON.stringify([got.status,got.cancelled_reason,got.expiry_requeues]));
    log('A3 requester deadline cancels with expiry_requeues 0, never requeued');
  }

  // A4. Requeue never extends past the total-age cap.
  {
    const s=fresh('a4');
    seed(s,5);
    s.submit(payload('a4_job',iso(now+10*MIN)),{mode:'none'},'','owner');
    s.db.prepare("UPDATE assignments SET valid_until_source='queue_p90',created_at=? WHERE request_id=?").run(iso(now-13*HOUR),'a4_job');
    now+=16*MIN; // created_at + 12 h is already past, so the cap forbids a requeue
    assert(s.sweepExpired().includes('a4_job'),'A4: over-cap row was requeued instead of cancelled');
    const got=s.get('a4_job');
    assert(got.status==='cancelled'&&got.cancelled_reason==='expired'&&got.expiry_requeues===0,'A4 row: '+JSON.stringify([got.status,got.cancelled_reason,got.expiry_requeues]));
    log('A4 row past created_at + 12 h cancels instead of requeueing');
  }

  // A5. Over-full queue does not mass-cancel (seven jobs, no claims, past the learned deadline).
  {
    const s=fresh('a5');
    seed(s,5);
    const ids=[];
    for(let i=0;i<7;i++){const id=`a5_job_${i}`;ids.push(id);s.submit(payload(id,iso(now+10*MIN)),{mode:'none'},'','owner');asLearned(s,id);}
    now+=16*MIN;
    const swept=s.sweepExpired();
    assert(swept.length===0,'A5 cancelled rows: '+JSON.stringify(swept));
    for(const id of ids){const got=s.get(id);assert(got.status==='queued'&&got.expiry_requeues===1&&Date.parse(got.valid_until)>now,'A5 '+id+': '+JSON.stringify([got.status,got.expiry_requeues,got.valid_until]));}
    assert(s.status({limits}).queued_expired_requeued.count===7,'A5 status count: '+JSON.stringify(s.status({limits}).queued_expired_requeued));
    assert(s.listPending().map(x=>x.request_id).filter(x=>x.startsWith('a5_job_')).length===7,'A5: not all requeued rows listed');
    log('A5 seven unclaimed learned-deadline jobs all requeue with fresh deadlines, zero cancelled');
  }

  // F1. A pre-sweep refusal is not a cancellation, and refuseExpired accepts a refreshed row.
  {
    const s=fresh('honesty');seed(s,5);
    s.submit(payload('honest_job',iso(now+10*MIN)),{mode:'none'},'','owner');asLearned(s,'honest_job');
    now+=26*MIN;
    let threw=null;try{s.claim('honest_job','dot','local-principal',6);}catch(e){threw=e.message;}
    assert(/^assignment_expired: /.test(threw)&&!/will not requeue|bridge cancelled/.test(threw),'F1 pre-sweep learned refusal: '+threw);
    assert(s.get('honest_job').status==='queued','F1 claim guard changed status');
    // Expiry maintenance runs while delivery is paused, so a paused bridge refreshes the row instead of refusing it.
    s.setPause('test');s.refuseExpired('honest_job');s.setPause(null);
    assert(s.get('honest_job').status==='queued'&&s.get('honest_job').expiry_requeues===1&&Date.parse(s.get('honest_job').valid_until)>now,'F1 paused refresh not accepted');
    s.db.prepare("UPDATE assignments SET expiry_requeues=2,valid_until=? WHERE request_id=?").run(iso(now-MIN),'honest_job');
    threw=null;try{s.claim('honest_job','dot','local-principal',6);}catch(e){threw=e.message;}
    assert(/will not requeue/.test(threw)&&!/bridge cancelled/.test(threw),'F1 exhausted pre-sweep refusal: '+threw);
    threw=null;try{s.refuseExpired('honest_job');}catch(e){threw=e.message;}
    assert(/bridge cancelled it and will not requeue/.test(threw)&&s.get('honest_job').status==='cancelled','F1 final cancellation: '+threw);
    s.db.close();log('F1 pre-sweep refusal is honest; paused bridge refreshes the row; exhausted row cancels');
  }

  // F2. Pin both sides of the floor, its exact boundary, and the actual cap clamp.
  for(const remaining of [MIN,15*MIN-1,15*MIN,20*MIN]) {
    const s=fresh('floor-'+remaining);seed(s,5);
    // Ten-minute observed waits yield a 30-minute fresh window, longer than every cap below.
    s.db.prepare("UPDATE assignments SET created_at=? WHERE request_id LIKE 'seed_%'").run(iso(now-10*MIN));
    s.submit(payload('floor_job',iso(now+10*MIN)),{mode:'none'},'','owner');
    s.db.prepare("UPDATE assignments SET valid_until_source='queue_p90',created_at=?,valid_until=? WHERE request_id=?").run(iso(now-12*HOUR+remaining),iso(now-MIN),'floor_job');
    assert(s.defaultValidUntil('dot','read-only').window_ms===30*MIN,'F2 fixture window');
    const swept=s.sweepExpired(),got=s.get('floor_job');
    if(remaining<15*MIN) assert(swept.includes('floor_job')&&got.status==='cancelled'&&got.cancelled_reason==='expired'&&got.expiry_requeues===0,'F2 insufficient floor: '+remaining);
    else assert(swept.requeued.includes('floor_job')&&got.status==='queued'&&got.expiry_requeues===1&&got.valid_until===iso(now+remaining),'F2 cap clamp: '+JSON.stringify(got));
    s.db.close();log('F2 total-age cap with remaining ms '+remaining);
  }

  // F3. The immediately following skip sweep cannot undo a fresh expiry requeue.
  {
    const s=fresh('skip');seed(s,5);
    s.submit(payload('skip_job',iso(now+10*MIN)),{mode:'none'},'','owner');
    s.db.prepare("UPDATE assignments SET valid_until_source='queue_p90',valid_until=?,skipped_at=?,passed_over=3 WHERE request_id=?").run(iso(now-MIN),iso(now-7*HOUR),'skip_job');
    assert(s.sweepExpired().requeued.includes('skip_job'),'F3 did not requeue');
    assert(!s.sweepSkipped().includes('skip_job')&&s.get('skip_job').status==='queued','F3 skip sweep cancelled requeue');
    const row=s.db.prepare('SELECT skipped_at,passed_over FROM assignments WHERE request_id=?').get('skip_job');
    assert(row.skipped_at===null&&row.passed_over===0,'F3 stale skip fields');
    s.db.close();log('F3 expiry requeue resets skips before same-tick skip sweep');
  }

  // F3b. A requeue starts a new claimable window: the next listing with a free lane does not mark the job skipped again,
  // and it lists ahead of a newer job. Before, the old eligible_since survived the requeue and re-marked it at once.
  {
    const s=fresh('window');seed(s,5);
    s.submit(payload('window_job',iso(now+HOUR)),{mode:'none'},'','owner');asLearned(s,'window_job');
    s.recordListed(s.listPending('dot'),6);
    now+=11*MIN; s.recordListed(s.listPending('dot'),6);
    assert(s.db.prepare('SELECT skipped_at FROM assignments WHERE request_id=?').get('window_job').skipped_at!==null,'F3b fixture: not skipped after the window');
    s.db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?').run(iso(now-MIN),'window_job');
    assert(s.sweepExpired().requeued.includes('window_job'),'F3b did not requeue');
    s.submit(payload('newer_job',iso(now+HOUR)),{mode:'none'},'','owner');
    now+=MIN; s.recordListed(s.listPending('dot'),6);
    const row=s.db.prepare('SELECT skipped_at,eligible_since,listed_count FROM assignments WHERE request_id=?').get('window_job');
    assert(row.skipped_at===null,'F3b re-marked skipped right after the requeue: '+JSON.stringify(row));
    assert(row.eligible_since===iso(now),'F3b window did not restart: '+JSON.stringify(row));
    const order=s.listPending('dot').filter(x=>x.kind==='assignment').map(x=>x.request_id);
    assert(order.indexOf('window_job')<order.indexOf('newer_job'),'F3b order: '+JSON.stringify(order));
    s.db.close();log('F3b expiry requeue restarts the claimable window');
  }

  // F6. Requeue preserves pending notifications and legacy armed watches; final cancel suppresses them.
  {
    const s=fresh('delivery');seed(s,5);
    const created=now;s.submit(payload('delivery_job',iso(now+10*MIN)),{mode:'none'},'','owner');asLearned(s,'delivery_job');
    s.db.prepare("INSERT INTO watches(request_id,deadline,state,updated_at) VALUES(?,?,'armed',?)").run('delivery_job',iso(now+HOUR),iso(now));
    const snapshot=()=>JSON.stringify([s.db.prepare('SELECT * FROM notifications WHERE request_id=? ORDER BY id').all('delivery_job'),s.db.prepare('SELECT * FROM watches WHERE request_id=?').get('delivery_job')]);
    const before=snapshot();
    assert(s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id=? AND state='pending'").get('delivery_job').n>0,'F6 missing pending fixture');
    // One censored sample per unclaimed job; each requeue or the final expiry raises it to the latest bound.
    const ev=()=>s.queueWaitEvidence('dot','read-only'), job=()=>({bounds:ev().expired_lower_bounds,samples:ev().samples,wait:ev().waits_ms.at(-1)});
    now+=16*MIN;assert(s.sweepExpired().requeued.includes('delivery_job')&&snapshot()===before,'F6 requeue changed delivery state');
    assert(JSON.stringify(job())===JSON.stringify({bounds:1,samples:6,wait:now-created}),'F6 first requeue must add one censored sample: '+JSON.stringify(job()));
    now=Date.parse(s.get('delivery_job').valid_until)+1;s.sweepExpired();
    assert(s.get('delivery_job').expiry_requeues===2&&snapshot()===before,'F6 second requeue changed delivery state');
    assert(JSON.stringify(job())===JSON.stringify({bounds:1,samples:6,wait:now-created}),'F6 second requeue must raise the same censored sample: '+JSON.stringify(job()));
    now=Date.parse(s.get('delivery_job').valid_until)+1;assert(s.sweepExpired().includes('delivery_job'),'F6 final cancel absent');
    assert(JSON.stringify(job())===JSON.stringify({bounds:1,samples:6,wait:now-created}),'F6 final expiry must raise the same censored sample: '+JSON.stringify(job()));
    assert(s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id=? AND state IN ('pending','failed','waiting')").get('delivery_job').n===0,'F6 pending notifications survived cancellation');
    assert(s.db.prepare('SELECT state FROM watches WHERE request_id=?').get('delivery_job').state==='suppressed','F6 watch survived cancellation');
    s.db.close();log('F6 delivery rows unchanged by both requeues, suppressed by final cancel');
  }

  // F7. A job requeued twice and then claimed contributes one exact wait, not its earlier lower bounds.
  {
    const s=fresh('claimed_after');seed(s,5);
    const created=now;s.submit(payload('ca_job',iso(now+10*MIN)),{mode:'none'},'','owner');asLearned(s,'ca_job');
    now+=16*MIN;assert(s.sweepExpired().requeued.includes('ca_job'),'F7 first requeue absent');
    now=Date.parse(s.get('ca_job').valid_until)+1;s.sweepExpired();
    assert(s.get('ca_job').expiry_requeues===2,'F7 second requeue absent');
    now+=MIN;s.claim('ca_job','dot','local-principal',6);
    const ev=s.queueWaitEvidence('dot','read-only');
    assert(ev.samples===6&&ev.expired_lower_bounds===0&&ev.waits_ms.at(-1)===now-created,'F7 claimed job must contribute one exact wait: '+JSON.stringify(ev));
    s.db.close();log('F7 requeued-then-claimed job contributes one exact wait');
  }

  // F6. Migration 59 preserves a populated schema-58 database, not just an empty fixture.
  {
    const file=join(home,'populated-v58.db');let s=new Store(file,{now:()=>now,limits});
    for(const id of ['mg_queued','mg_claimed','mg_finished']) s.submit(payload(id,iso(now+HOUR)),{mode:'none'},'','owner');
    const c=s.claim('mg_claimed','dot','local-principal',6),f=s.claim('mg_finished','dot','local-principal',6);
    s.finish('mg_finished',f.claim_id,'completed','done','ok');
    const snapshot=()=>JSON.stringify([s.db.prepare('SELECT request_id,payload,payload_hash,status,created_at,valid_until FROM assignments ORDER BY request_id').all(),s.db.prepare('SELECT * FROM claims ORDER BY request_id').all().map(({lease_boot_id,lease_deadline_monotonic_ms,...row})=>row),s.db.prepare('SELECT * FROM reports ORDER BY request_id').all()]);
    const before=snapshot();
    s.db.exec('DROP TABLE destination_blocks; DROP TABLE destination_approvals; ALTER TABLE claims DROP COLUMN connection_id; ALTER TABLE claims DROP COLUMN destination_revision; ALTER TABLE assignments DROP COLUMN expiry_requeues; PRAGMA user_version=58;');s.db.close();
    s=new Store(file,{now:()=>now,limits});
    assert(s.db.prepare('PRAGMA user_version').get().user_version===65&&snapshot()===before,'F6 v58 rows changed');
    assert(s.db.prepare('SELECT expiry_requeues FROM assignments').all().every(r=>r.expiry_requeues===0),'F6 existing rows not initialized');
    s.progress('mg_claimed',c.claim_id,'claim survived migration','local-principal');s.db.close();
    s=new Store(file,{now:()=>now,limits});assert(s.get('mg_queued').expiry_requeues===0&&s.get('mg_finished').report.outcome==='completed','F6 reopen lost data');s.db.close();
    log('F6 populated v58 migration preserves queued/claimed/finished rows and active claim, initializes zero, reopens');
  }

  // migration 59 on a fresh database: column present, existing rows default to 0.
  {
    const s=fresh('migration');
    assert(s.db.prepare('PRAGMA user_version').get().user_version===65,'schema 65 after migration 59');
    assert(s.db.prepare("SELECT name FROM pragma_table_info('assignments') WHERE name='expiry_requeues'").get(),'expiry_requeues column missing');
    s.submit(payload('mg_job',iso(now+HOUR)),{mode:'none'},'','owner');
    assert(s.get('mg_job').expiry_requeues===0,'fresh row default: '+s.get('mg_job').expiry_requeues);
    log('migration 59: expiry_requeues column present, fresh rows default to 0');
  }
  console.log('PASS expiry requeue test');
} finally { await rm(home,{recursive:true,force:true}); }
