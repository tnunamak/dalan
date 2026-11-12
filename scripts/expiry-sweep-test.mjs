#!/usr/bin/env node
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
// Preparation expiry at store level with an injected clock: valid_until mirrored on submit and by migration 27, the sweep
// (queued only, claimed and valid_until-less rows untouched, lifecycle/notifications/watches, pause-independent), live queue
// counts for list_pending, status, the throttle and the background cap, queued_expired and the 'expired' liveness class,
// assignment_expired on claim, /admission-style lookups, re-preparation identities and truthful duplicate metrics, and
// tool_error_message in the mcp_outcome log line.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { explainStatus } from '../src/status-evidence.mjs';
import { lifecycleMetrics } from '../src/lifecycle.mjs';
import { drainerRequestId, verifyObjective, deriveObjectives } from '../src/objectives.mjs';
import { recordMcpResponse, beginMcpOutcome } from '../src/mcp-outcome.mjs';
import { EventEmitter } from 'node:events';

const home=await mkdtemp(join(tmpdir(),'dalan-bridge-expiry-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const MIN=60000,HOUR=3600000,key=`whsec_${randomBytes(32).toString('base64')}`;
let now=Date.parse('2026-10-09T16:00:00.000Z');
const iso=ms=>new Date(ms).toISOString();
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:HOUR,laneCapacity:6,rewakeMs:90000,rewakeWindowMs:2*HOUR,breakSilenceMs:20*MIN,breakProbeMs:30*MIN,maxClaimsPerHour:30,maxToolCallsPerHour:330,maxResponseBytesPerHour:2500000};
const payload=(id,validUntil)=>({schema_version:1,request_id:id,brief:`expiry test ${id}`,inputs:[],expected_output:'findings',execution_scope:'read-only',...(validUntil!==undefined?{prepared_at:iso(now-MIN),valid_until:validUntil}:{})});
const fresh=(name,options={})=>{const s=new Store(join(home,`${name}.db`),{now:()=>now,capacity:6,backgroundMaxInFlight:2,limits,...options});s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+48*HOUR).toISOString());return s;};
const queuedCount=st=>st.counts.find(x=>x.status==='queued')?.count??0;
try {
  // submit mirrors valid_until; live counts and lists before and after expiry
  {
    const s=fresh('live');
    s.submit(payload('exp_bg_1',iso(now+10*MIN)),{mode:'none'},'','owner',false,null,'background');
    s.submit(payload('exp_bg_2',iso(now+20*MIN)),{mode:'none'},'','owner',false,null,'background');
    s.submit(payload('exp_none_1'),{mode:'none'},'','owner');
    s.submit(payload('exp_bad_1','not a time'),{mode:'none'},'','owner');
    const row=id=>s.db.prepare('SELECT valid_until,cancelled_reason FROM assignments WHERE request_id=?').get(id);
    assert(row('exp_bg_1').valid_until===iso(now+10*MIN)&&row('exp_none_1').valid_until===null&&row('exp_bad_1').valid_until===null,'valid_until mirror: '+JSON.stringify([row('exp_bg_1'),row('exp_none_1'),row('exp_bad_1')]));
    s.cancel('exp_bad_1'); // keep the background cap at the two rows under test
    let threw=null;try{s.submit(payload('exp_bg_3',iso(now+30*MIN)),{mode:'none'},'','owner',false,null,'background');}catch(e){threw=e.message;}
    assert(threw==='background_capacity_full','cap before expiry: '+threw);
    // a normal live row hides background ones; let it finish first so background rows are listable
    const c=s.claim('exp_none_1','dot','local-principal',6);s.finish('exp_none_1',c.claim_id,'completed','done','ok');
    assert(s.listPending().map(x=>x.request_id).join()==='exp_bg_1,exp_bg_2','listed before expiry');
    now+=15*MIN; // exp_bg_1 expired, exp_bg_2 live
    assert(s.listPending().map(x=>x.request_id).join()==='exp_bg_2','list_pending advertised an expired row: '+JSON.stringify(s.listPending()));
    assert(s.laneState('local-principal','dot').queued===1,'lane hint counted an expired row');
    let st=s.status({limits});
    assert(queuedCount(st)===1&&st.priority_counts.background.queued===1&&st.throttle.queued===1,'live counts: '+JSON.stringify([st.counts,st.priority_counts,st.throttle.queued]));
    assert(st.queued_expired.count===1&&st.queued_expired.oldest_expired_at===iso(now-5*MIN),'queued_expired: '+JSON.stringify(st.queued_expired));
    assert(/ queued=1 queued_expired=1 /.test(explainStatus(st)),'explain lacks queued_expired=1: '+explainStatus(st));
    assert(!/queued_expired=/.test(explainStatus({...st,queued_expired:{count:0,oldest_expired_at:null}})),'explain shows queued_expired=0');
    // the expired row frees the background cap before the sweep runs, so the drainer and the bridge agree
    assert(s.submit(payload('exp_bg_3',iso(now+30*MIN)),{mode:'none'},'','owner',false,null,'background').status==='queued','expired row held background cap room');
    // liveness: 'expired', never alive_not_claiming, and outside the other classes
    s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=? WHERE kind='event'").run(iso(now-60*MIN));
    s.recordWorkerCall('local-principal','list_pending');
    const live=s.liveness(limits);
    assert(live.items.find(i=>i.request_id==='exp_bg_1').class==='expired','expired class: '+JSON.stringify(live.items));
    assert(live.queue_classes.expired===1&&live.queue_classes.alive_not_claiming===2,'queue classes: '+JSON.stringify(live.queue_classes));
    // claim refuses with assignment_expired (store guard), and refuseExpired cancels it as expired first
    threw=null;try{s.claim('exp_bg_1','dot','local-principal',6);}catch(e){threw=e.message;}
    assert(/^assignment_expired: its prepared inputs were valid until 2026-10-09T16:10:00.000Z/.test(threw),'claim of expired row: '+threw);
    assert(row('exp_bg_1').cancelled_reason===null,'store claim guard must not cancel inside a rolled-back transaction');
    threw=null;try{s.refuseExpired('exp_bg_1');}catch(e){threw=e.message;}
    assert(/^assignment_expired: /.test(threw)&&s.get('exp_bg_1').status==='cancelled'&&s.get('exp_bg_1').cancelled_reason==='expired','refuseExpired: '+threw+' '+JSON.stringify(row('exp_bg_1')));
    threw=null;try{s.claim('exp_bg_1','dot','local-principal',6);}catch(e){threw=e.message;}
    assert(/^assignment_expired: /.test(threw),'claim of an expired-cancelled row: '+threw);
    s.refuseExpired('exp_bg_2'); // live: no throw
    log('valid_until mirrored on submit; list_pending, lane hints, status counts, throttle queued and the background cap exclude expired rows; queued_expired and explain; expired liveness class; assignment_expired on claim');
  }

  // the sweep
  {
    const s=fresh('sweep');
    s.submit(payload('sw_q_expired',iso(now+MIN)),'thread-x','e','owner');
    s.submit(payload('sw_q_live',iso(now+HOUR)),'thread-x','e','owner');
    s.submit(payload('sw_q_none'),'thread-x','e','owner');
    s.submit(payload('sw_claimed',iso(now+MIN)),'thread-x','e','owner');
    s.submit(payload('sw_other_expired',iso(now+MIN)),'thread-x','e','owner',false,null,'normal',null,payload('sw_other_expired',iso(now+MIN)),null,'lark');
    const c=s.claim('sw_claimed','dot','local-principal',6);
    assert(s.sweepExpired().length===0,'swept before valid_until');
    now+=2*MIN;
    s.setPause('maintenance');
    const sweptWhilePaused=s.sweepExpired().sort();
    assert(JSON.stringify(sweptWhilePaused)==='["sw_other_expired","sw_q_expired"]'&&s.get('sw_q_expired').cancelled_reason==='expired','maintenance did not expire queued preparations while paused');
    assert(s.status({limits}).queued_expired.count===0,'queued_expired after maintenance while paused');
    s.setPause(null);
    const swept=s.sweepExpired().sort();
    assert(swept.length===0&&s.get('sw_other_expired').cancelled_reason==='expired','preparation expiry must apply to every worker once: '+JSON.stringify(swept));
    const got=s.get('sw_q_expired');
    assert(got.status==='cancelled'&&got.cancelled_reason==='expired'&&got.cancelled_at===iso(now),'cancelled as expired: '+JSON.stringify([got.status,got.cancelled_reason,got.cancelled_at]));
    const ev=s.db.prepare("SELECT type,actor,reason FROM lifecycle_events WHERE request_id='sw_q_expired' ORDER BY id DESC LIMIT 1").get();
    assert(ev.type==='cancelled'&&ev.actor==='system'&&ev.reason==='expired','lifecycle: '+JSON.stringify(ev));
    assert(s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id='sw_q_expired' AND state IN ('pending','failed')").get().n===0,'pending events not suppressed');
    assert(s.get('sw_claimed').status==='claimed'&&s.claims()[0].claim_id===c.claim_id,'sweep touched a claimed row');
    s.progress('sw_claimed',c.claim_id,'still working','local-principal');
    assert(s.get('sw_q_live').status==='queued'&&s.get('sw_q_none').status==='queued','sweep touched a live or valid_until-less row');
    assert(s.sweepExpired().length===0,'sweep is idempotent');
    // an owner cancel keeps cancelled_reason NULL
    s.cancel('sw_q_none');assert(s.get('sw_q_none').cancelled_reason===null,'owner cancel got a reason');
    // an abandoned claim past valid_until is requeued, then expired by the next sweep
    s.abandon('sw_claimed',{reason:'test'});
    assert(JSON.stringify(s.sweepExpired())==='["sw_claimed"]','requeued expired row not swept');
    // bounded batch
    for(let i=0;i<5;i++) s.submit(payload(`sw_batch_${i}`,iso(now+MIN)),'thread-x','e','owner');
    now+=2*MIN;
    assert(s.sweepExpired(3).length===3&&s.sweepExpired(3).length===2,'sweep not bounded');
    const plan=s.db.prepare("EXPLAIN QUERY PLAN SELECT request_id FROM assignments WHERE status='queued' AND valid_until<=? ORDER BY valid_until LIMIT 100").all(iso(now)).map(r=>r.detail).join(' | ');
    assert(/assignments_expiry/.test(plan),'sweep query does not use the expiry index: '+plan);
    log('sweep cancels only queued rows past valid_until (cancelled_reason expired, lifecycle cancelled/expired by system, events and watches suppressed), including while paused; never claimed or valid_until-less rows; bounded and indexed');
  }


  // Learned preparation windows stop at first claim, including after either requeue path.
  for(const source of ['queue_p90','requester']) {
    for(const requeue of ['lease','operator']) {
      const s=fresh(`requeue-${source}-${requeue}`), id=`rq_${source}_${requeue}`;
      s.submit(payload(id,iso(now+MIN)),{mode:'none'},'','owner');
      // Set provenance explicitly so the fixture does not depend on queue-history sampling.
      s.db.prepare('UPDATE assignments SET valid_until_source=? WHERE request_id=?').run(source,id);
      const first=s.claim(id,'dot','local-principal',6);
      now+=HOUR+MIN;
      if(requeue==='lease') assert(s.sweepStaleLeases().includes(id),'lease did not requeue '+id);
      else s.abandon(id,{reason:'test'});
      assert(s.get(id).status==='queued'&&s.get(id).claim.state==='abandoned','claim history lost '+id);
      const learned=source==='queue_p90', st=s.status({limits});
      assert(s.listPending().some(r=>r.request_id===id)===learned,'listing disagrees '+id);
      assert(queuedCount(st)===(learned?1:0)&&st.queued_expired.count===(learned?0:1),'counts disagree '+id);
      assert((s.liveness(limits).items.find(r=>r.request_id===id).class==='expired')===!learned,'liveness disagrees '+id);
      if(learned) {
        s.refuseExpired(id);
        assert(s.sweepExpired().length===0&&s.get(id).status==='queued','learned requeue expired '+id);
        const next=s.claim(id,'replacement','local-principal',6);
        assert(next.epoch===first.epoch+1&&next.claim_id!==first.claim_id,'learned requeue not claimable '+id);
      } else {
        let threw=null;try{s.claim(id,'replacement','local-principal',6);}catch(e){threw=e.message;}
        assert(/^assignment_expired: /.test(threw),'requester requeue claim accepted '+id);
        assert(s.sweepExpired().includes(id)&&s.get(id).cancelled_reason==='expired','requester requeue not expired '+id);
      }
      s.db.close();
    }
  }
  {
    const s=fresh('learned-never-claimed'), id='learned_never_claimed';
    s.submit(payload(id,iso(now+MIN)),{mode:'none'},'','owner');
    s.db.prepare("UPDATE assignments SET valid_until_source='queue_p90' WHERE request_id=?").run(id);
    now+=2*MIN;
    assert(!s.listPending().some(r=>r.request_id===id)&&s.queuedExpired().count===1,'never-claimed learned row stayed live');
    assert(s.sweepExpired().includes(id)&&s.get(id).cancelled_reason==='expired','never-claimed learned row not expired');
    s.db.close();
  }
  log('learned deadlines stop at first claim across lease/operator requeues; requester and never-claimed deadlines still expire');

  // migration 27 on a v26 database
  {
    const file=join(home,'v26.db');
    let s=new Store(file,{now:()=>now,limits});
    s.submit(payload('mg_q',iso(now-MIN+2*MIN)),'thread-x','e','owner');s.submit(payload('mg_c',iso(now+HOUR)),'thread-x','e','owner');s.submit(payload('mg_f',iso(now+HOUR)),'thread-x','e','owner');
    const c=s.claim('mg_c','dot','local-principal',6);const f=s.claim('mg_f','dot','local-principal',6);s.finish('mg_f',f.claim_id,'completed','x','y');
    preWorkerFixture(s);
    s.db.exec('DROP INDEX assignments_expiry; ALTER TABLE assignments DROP COLUMN valid_until; ALTER TABLE assignments DROP COLUMN cancelled_reason; PRAGMA user_version=26;');s.db.close();
    s=new Store(file,{now:()=>now,limits});
    assert(s.db.prepare('PRAGMA user_version').get().user_version===66,'migration 27 version');
    const v=id=>s.db.prepare('SELECT valid_until FROM assignments WHERE request_id=?').get(id).valid_until;
    assert(v('mg_q')===iso(now+MIN)&&v('mg_c')===iso(now+HOUR)&&v('mg_f')===null,'backfill: '+JSON.stringify([v('mg_q'),v('mg_c'),v('mg_f')]));
    assert(s.claims().length===1&&s.claims()[0].claim_id===c.claim_id,'claim lost in migration 27');
    s.progress('mg_c',c.claim_id,'still valid','local-principal');
    assert(s.get('mg_q').status==='queued','migration cancelled something');
    s.db.close();s=new Store(file,{now:()=>now,limits});assert(s.db.prepare('PRAGMA user_version').get().user_version===66,'reopen');s.db.close();
    log('migration 27 on a v26 database: columns and index added, open rows backfilled, claims stay valid, nothing cancelled');
  }

  // re-preparation identities and truthful repeat metrics
  {
    const base=drainerRequestId('o/r','pr-review:o/r#1','a'.repeat(40),'review',1), again=drainerRequestId('o/r','pr-review:o/r#1','a'.repeat(40),'review',1,1);
    assert(again===`${base}-r1`&&drainerRequestId('o/r','pr-review:o/r#1','a'.repeat(40),'review',1,0)===base,'attempt id form');
    const tuple={objective_key:'pr-review:o/r#1',revision:'a'.repeat(40),task_kind:'review',source:'drainer'}, pl={inputs:[{github_repo:'o/r',head_sha:'a'.repeat(40),pr_number:1}]};
    assert(verifyObjective({request_id:again,payload:pl},tuple)===null&&verifyObjective({request_id:base,payload:pl},tuple)===null,'re-prepared id not verified');
    assert(verifyObjective({request_id:`${base}-r0`,payload:pl},tuple)!==null&&verifyObjective({request_id:`${base}-rx`,payload:pl},tuple)!==null,'malformed attempt verified');
    const derived=deriveObjectives({receipts:[{request_id:again,body:JSON.stringify({...pl,request_id:again})}],manifests:[{policy_version:1,...tuple,preparation_attempt:1,assignment:pl}]});
    assert(derived.counts.verified.manifest===1,'manifest with preparation_attempt not derived: '+JSON.stringify(derived.counts));
    const s=fresh('metrics'), meta={objective_key:'pr-review:o/r#1',revision:'a'.repeat(40),task_kind:'review',source:'drainer'}, since=iso(now-MIN);
    s.submit({...payload(base,iso(now+MIN))},{mode:'none'},'','owner',false,null,'background',meta);
    now+=2*MIN;s.sweepExpired();
    s.submit({...payload(again,iso(now+MIN))},{mode:'none'},'','owner',false,null,'background',meta);
    let m=lifecycleMetrics(s,{since});
    assert(m.duplicates.value===0&&m.rework.value===0,'re-preparation counted as duplicate/rework: '+JSON.stringify([m.duplicates,m.rework]));
    s.submit({...payload('dup_same_objective',iso(now+MIN))},{mode:'none'},'','owner',false,null,'background',meta);
    m=lifecycleMetrics(s,{since});
    assert(m.duplicates.value===1,'a real duplicate is still counted: '+JSON.stringify(m.duplicates));
    log('re-preparation ids (-r<n>) verify and derive; an expired-cancelled row neither counts as nor makes its re-preparation a duplicate; real duplicates still count');
  }

  // tool_error_message
  {
    const lines=[], req=new EventEmitter(), res=new EventEmitter();
    req.method='POST';req.headers={};res.headersSent=true;res.statusCode=200;
    const outcome=beginMcpOutcome(req,res,line=>lines.push(line),new Set(['claim']),false);
    outcome.identify({method:'tools/call',params:{name:'claim'}});
    const message=`assignment_expired: its prepared inputs were valid until 2026-10-09T16:17:00.000Z; Bearer ${'A1b2C3d4'.repeat(3)} token ghp_${'ABCDEF123456abcdef'.repeat(2)} ${'x'.repeat(400)}`;
    recordMcpResponse(res,{jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:message}],isError:true}},194);
    res.emit('finish');
    const line=lines.find(l=>l.kind==='mcp_outcome');
    assert(line.tool_error===true&&line.tool_error_message.startsWith('assignment_expired: its prepared inputs were valid until 2026-10-09T16:17:00.000Z;'),'message: '+line.tool_error_message);
    assert(line.tool_error_message.length<=300&&!/A1b2C3d4|ABCDEF123456/.test(line.tool_error_message),'not redacted or truncated: '+line.tool_error_message);
    const ok=[], res2=new EventEmitter();res2.headersSent=true;res2.statusCode=200;
    beginMcpOutcome(req,res2,l=>ok.push(l),new Set(['claim']),false);
    recordMcpResponse(res2,{jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:'{"secret":"assignment text"}'}],isError:false}},30);res2.emit('finish');
    assert(ok.find(l=>l.kind==='mcp_outcome').tool_error_message===null,'a successful call logged its content');
    log('mcp_outcome carries tool_error_message (redacted, at most 300 chars) for a failed tool call and null otherwise');
  }
  console.log('PASS expiry sweep test');
} finally { await rm(home,{recursive:true,force:true}); }
