#!/usr/bin/env node
// Lease sweep and idle-while-waiting attribution at store level with an injected clock: an expired lease with no activity
// is abandoned (actor system, reason lease_expired) and its lane frees; a claim inside its lease, a break, and a lease whose
// deadline the end of a break extended are left alone; cancel records a reason; the idle-while-waiting figure splits by cause.
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { lifecycleMetrics, explainMetrics } from '../src/lifecycle.mjs';

const home=await mkdtemp(join(tmpdir(),'dalan-bridge-lease-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const MIN=60000,HOUR=3600000,key=`whsec_${randomBytes(32).toString('base64')}`;
let now=Date.parse('2026-10-19T00:00:00.000Z');
const iso=ms=>new Date(ms).toISOString();
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:HOUR,laneCapacity:2,rewakeMs:90000,rewakeWindowMs:2*HOUR,breakSilenceMs:20*MIN,breakProbeMs:30*MIN,maxClaimsPerHour:30,maxToolCallsPerHour:330,maxResponseBytesPerHour:2500000};
const payload=id=>({schema_version:1,request_id:id,brief:`lease test ${id}`,inputs:[],expected_output:'findings',execution_scope:'read-only'});
const fresh=name=>{const s=new Store(join(home,`${name}.db`),{now:()=>now,capacity:2,limits});s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+48*HOUR).toISOString());return s;};
const submit=(s,id)=>s.submit(payload(id),{mode:'none'},'','owner');
const claim=(s,id)=>s.claim(id,'dot','local-principal',2);
const lane=s=>s.freeLanes('local-principal','dot',2,2);
const row=(s,id)=>s.db.prepare('SELECT status,cancelled_reason FROM assignments WHERE request_id=?').get(id);

// expired lease, no activity: abandoned, requeued, lane free; a claim inside its lease is untouched
{
  const s=fresh('sweep');
  submit(s,'dead'); submit(s,'live');
  claim(s,'dead'); const live=claim(s,'live');
  assert(lane(s)===0,'both lanes held');
  now+=50*MIN; s.progress('live',live.claim_id,'still working'); // refreshes only the live claim
  now+=15*MIN; // dead: 65 min since claim (> 1 h lease); live: 15 min since progress
  assert(JSON.stringify(s.sweepStaleLeases())==='["dead"]','sweep result');
  assert(lane(s)===1,'lane freed: '+lane(s));
  assert(row(s,'dead').status==='queued'&&row(s,'live').status==='claimed','statuses: '+JSON.stringify([row(s,'dead'),row(s,'live')]));
  const ev=s.db.prepare("SELECT type,actor,reason FROM lifecycle_events WHERE request_id='dead' ORDER BY id").all().map(e=>`${e.type}:${e.actor}:${e.reason}`);
  assert(ev.includes('abandoned:system:lease_expired: 0 calls, no workspace tool')&&ev.includes('queued:system:requeued'),'lifecycle: '+ev);
  assert(s.sweepStaleLeases().length===0,'second sweep is a no-op');
  log('expired lease abandoned, lane freed, live claim untouched');
}
// tool activity per claim and its expiry summary
{
  const s=fresh('activity');
  submit(s,'quiet'); submit(s,'busy');
  claim(s,'quiet'); claim(s,'busy');
  now=Date.parse('2026-10-19T13:35:37.000Z')-0; // the stamp is the injected clock
  s.recordToolActivity('quiet','local-principal','dot','claim');
  s.recordToolActivity('quiet','local-principal','dot','get');
  s.recordToolActivity('quiet','other-subject','dot','get'); // foreign subject: counted nowhere
  s.recordToolActivity('quiet','local-principal','lark','get'); // foreign worker: counted nowhere
  let c=s.get('quiet').claim.activity;
  assert(c.tool_calls===2&&c.last_tool==='get'&&c.last_tool_at===iso(now)&&c.last_tool_error===null&&c.first_workspace_tool_at===null,'quiet activity: '+JSON.stringify(c));
  assert(!('tool_calls' in s.get('quiet').claim),'raw columns stay out of the claim object');
  s.recordToolActivity('busy','local-principal','dot','read_file',{workspace:true});
  now+=MIN; s.recordToolActivity('busy','local-principal','dot','read_file',{workspace:true,error:'x'.repeat(300)});
  c=s.get('busy').claim.activity;
  assert(c.tool_calls===2&&c.first_workspace_tool_at===iso(now-MIN)&&c.last_tool_error==='x'.repeat(200),'busy activity: '+JSON.stringify(c));
  now+=2*HOUR;
  assert(s.sweepStaleLeases().sort().join()==='busy,quiet','both swept');
  const reason=id=>s.db.prepare("SELECT reason FROM lifecycle_events WHERE request_id=? AND type='abandoned'").get(id).reason;
  assert(reason('quiet')==='lease_expired: 2 calls, last get at 13:35:37Z, no workspace tool','quiet summary: '+reason('quiet'));
  assert(/^lease_expired: 2 calls, last read_file at 13:36:37Z, first workspace tool at 13:35:37Z, last error: x+$/.test(reason('busy')),'busy summary: '+reason('busy'));
  assert(s.get('quiet').claim.abandon_reason===reason('quiet'),'abandon_reason carries the summary');
  claim(s,'quiet'); // a new epoch starts a fresh record
  assert(s.get('quiet').claim.activity.tool_calls===0,'reclaim resets activity');
  assert(lifecycleMetrics(s,{since:iso(now-30*24*HOUR)}).orphaned_claims.lease_expired_takeovers.value===2,'metrics still read');
  log('claim tool activity recorded, scoped to the owning worker and subject, summarised on lease expiry, reset on reclaim');
}
// a usage break never extends a lease or holds the sweep: a claim with no worker progress for one lease period is released
{
  const s=fresh('break');
  submit(s,'held'); claim(s,'held');
  now+=30*MIN; s.setBreak('abuse limit',iso(now));
  now+=31*MIN; // 61 min after the claim, inside the break
  assert(s.liveness(limits,2).stale_claims.count===1,'liveness reports the claim stale at its own deadline during a break');
  assert(s.sweepStaleLeases().join()==='held','swept at its own deadline during a break');
  assert(row(s,'held').status==='queued','requeued');
  log('a break does not hold the sweep');
}
// ending a break (owner clear or the worker's own call) does not move a lease deadline
for(const [name,end] of [['break-clear',s=>s.clearBreak()],['break-tool-call',s=>s.recordWorkerCall('local-principal','list_pending','dot')]]) {
  const s=fresh(name);
  submit(s,'held'); const c=claim(s,'held');
  const deadline=s.get('held').claim.lease_expires_at;
  now+=10*MIN; s.setBreak('abuse limit',iso(now));
  now+=50*MIN-1; end(s);
  assert(!s.activeBreak(),'break ended');
  assert(s.get('held').claim.lease_expires_at===deadline,'break end moved the deadline: '+s.get('held').claim.lease_expires_at);
  now+=1; assert(s.sweepStaleLeases().join()==='held','swept at the original deadline');
  log(`${name}: ending a break leaves the lease deadline alone`);
}
// a read never extends a lease: list_pending leaves a claim's activity and deadline as they were
{
  const s=fresh('reads');
  submit(s,'idle'); claim(s,'idle');
  const before=s.get('idle').claim.lease_expires_at;
  now+=30*MIN;
  s.recordWorkerCall('local-principal','list_pending','dot'); s.listPending?.('local-principal','dot');
  assert(s.get('idle').claim.lease_expires_at===before,'listing moved the deadline');
  now+=30*MIN; assert(s.sweepStaleLeases().join()==='idle','swept at the original deadline after listing');
  log('reads do not extend a lease');
}
// cancel records a reason
{
  const s=fresh('cancel');
  submit(s,'c1'); submit(s,'c2'); claim(s,'c2');
  s.cancel('c1','pr_closed'); s.cancel('c2','pr_closed');
  assert(row(s,'c1').cancelled_reason==='pr_closed'&&row(s,'c2').status==='cancelled'&&row(s,'c2').cancelled_reason==='pr_closed','cancel reason');
  assert(lane(s)===2,'a cancelled claim frees its lane');
  log('cancel records its reason');
}
// idle-while-waiting by cause: worker activity within 20 min is worker_active, longer silence is worker_inactive, an owner break is owner_break
{
  const s=fresh('cause'); const t0=now=Date.parse('2026-10-19T06:00:00.000Z');
  submit(s,'a'); claim(s,'a');                      // lane 1 of 2 held; worker event at t0
  now=t0+MIN; submit(s,'b');                              // queued, lane free; stale from t0+4 min
  now=t0+60*MIN;
  const by=lifecycleMetrics(s,{laneCapacity:2}).lane_utilization.last_24h.idle_while_waiting_by_cause;
  const near=(x,min)=>Math.abs(x.ms-min*MIN)<=1000;
  assert(near(by.worker_active,16)&&near(by.worker_inactive,40)&&by.owner_break.ms===0,'split: '+JSON.stringify(by));
  s.setBreak('abuse limit',iso(t0+30*MIN));
  now=t0+90*MIN;
  const m=lifecycleMetrics(s,{laneCapacity:2}), by2=m.lane_utilization.last_24h.idle_while_waiting_by_cause;
  assert(near(by2.owner_break,60)&&near(by2.worker_active,16)&&near(by2.worker_inactive,10),'with break: '+JSON.stringify(by2));
  assert(/worker_inactive:/.test(explainMetrics(m)),'explain shows the split');
  log('idle-while-waiting splits by cause');
}
// the lease deadline fences every worker mutation: at now >= deadline a call is refused with lease_expired and changes nothing
{
  const s=fresh('fence');
  submit(s,'f1'); const c=claim(s,'f1');
  const code=e=>{try{return JSON.parse(e.message);}catch{return null;}};
  const refused=fn=>{try{fn();}catch(e){const j=code(e);assert(j?.error==='lease_expired','not lease_expired: '+e.message);return j;}throw new Error('call was not refused');};
  const snap=()=>JSON.stringify([s.db.prepare('SELECT * FROM claims WHERE request_id=?').get('f1'),s.db.prepare('SELECT count(*) n FROM progress').get(),s.db.prepare('SELECT count(*) n FROM lifecycle_events').get(),s.db.prepare('SELECT count(*) n FROM reports').get()]);
  now+=HOUR-1; // one ms before the deadline: allowed, and it extends the lease
  assert(s.progress('f1',c.claim_id,'inside the lease').recorded===true,'allowed one ms before the deadline');
  const extended=s.db.prepare('SELECT last_claim_activity_at a FROM claims WHERE request_id=?').get('f1').a;
  assert(extended===iso(now),'progress extended the lease');
  now+=HOUR; // exactly the new deadline
  const before=snap();
  const err=refused(()=>s.progress('f1',c.claim_id,'at the deadline'));
  assert(err.request_id==='f1'&&err.lease_expires_at===iso(now)&&/f1/.test(err.message),'error names the request and deadline: '+JSON.stringify(err));
  refused(()=>s.finish('f1',c.claim_id,'completed','s','r'));
  refused(()=>s.assertClaim('f1',c.claim_id,'local-principal','dot'));
  s.touchClaim('f1',c.claim_id,'local-principal','dot'); s.recordToolActivity('f1','local-principal','dot','progress');
  const after=JSON.parse(snap()), prior=JSON.parse(before);
  assert(after[0].last_claim_activity_at===prior[0].last_claim_activity_at&&after[0].state==='active','touch or tool activity extended or changed an expired claim');
  assert(JSON.stringify(after.slice(1))===JSON.stringify(prior.slice(1)),'a refused call wrote something');
  log('worker mutations are refused at the lease deadline, allowed one ms before, and a refused call changes nothing');
}
// the sweep abandons the refused claim; a same-claimant re-claim after the deadline is a new epoch, not a lease refresh
{
  const s=fresh('fence2');
  submit(s,'g1'); const c=claim(s,'g1'); now+=HOUR;
  assert(JSON.stringify(s.sweepStaleLeases())==='["g1"]','sweep abandons the expired claim');
  let msg=''; try{s.progress('g1',c.claim_id,'late');}catch(e){msg=e.message;}
  assert(msg==='invalid claim','after the sweep the old claim is just invalid: '+msg);
  submit(s,'g2'); const d=claim(s,'g2'); now+=HOUR;
  const again=claim(s,'g2');
  assert(again.epoch===2&&again.claim_id!==d.claim_id&&again.duplicate===false,'re-claim after the deadline is a new epoch: '+JSON.stringify(again));
  let stale=''; try{s.progress('g2',d.claim_id,'old');}catch(e){stale=e.message;}
  assert(/"error":"claim_superseded"/.test(stale)&&/superseded by epoch 2/.test(stale),'the old claim_id is fenced as superseded: '+stale);
  log('sweep abandons an expired claim; re-claim after the deadline starts a new epoch');
}
// Exercise the same composition used by the server when another job is queued.
{
  const {nonterminalOutcome}=await import('../src/store.mjs');
  assert(typeof nonterminalOutcome==='function','claim outcome composer is available');
  const queued='1 queued and 1 lane free: claim other-request now (oldest first)';
  const receipt=nonterminalOutcome('current-request',{request_id:'current-request',next_action:queued,free_lanes:1});
  assert(receipt.terminal===false&&receipt.request_action.startsWith('Keep working on request current-request.')&&receipt.next_action===queued&&receipt.free_lanes===1,'claim keeps both current-request and queue guidance');
  log('claim composition preserves queued-work guidance and the current request');
}
// Receipt outcomes are snapshots of the current grant, not permission to act after a stop.
const openOutcome=(receipt,id,blocker=false)=>{
  const next=blocker
    ? `Request ${id} remains open. Resolve the blocker within scope or call finish with outcome blocked; progress is not finish.`
    : `Keep working on request ${id}. Send progress about every minute. Call finish when done; progress is not finish.`;
  assert(JSON.stringify({terminal:receipt.terminal,request_action:receipt.request_action})===JSON.stringify({terminal:false,request_action:next}),'open outcome: '+JSON.stringify(receipt));
};
const stoppedOutcome=(fn,pattern)=>{
  let caught;
  try { fn(); } catch(error) { caught=error; }
  assert(caught&&pattern.test(caught.message),'expected stop: '+caught?.message);
  let receipt; try { receipt=JSON.parse(caught.message); } catch { receipt={message:caught.message}; }
  assert(!Object.hasOwn(receipt,'request_action')&&!Object.hasOwn(caught,'request_action'),'stop must not invite continued work: '+caught.message);
};
{
  const s=fresh('outcome-open'); submit(s,'outcome-open');
  const c=claim(s,'outcome-open'); openOutcome(c,'outcome-open');
  const retry=claim(s,'outcome-open'); openOutcome(retry,'outcome-open');
  assert(retry.duplicate===true&&retry.claim_id===c.claim_id,'claim retry keeps its grant');
  const p=s.progress('outcome-open',c.claim_id,'working'); openOutcome(p,'outcome-open');
  assert(p.recorded===true&&p.blocker_forwarded===false,'progress fields preserved');
  const b=s.progress('outcome-open',c.claim_id,'QUESTION: need scope clarification'); openOutcome(b,'outcome-open',true);
  assert(b.recorded===true&&b.blocker_forwarded===true,'blocker fields preserved');
  log('fresh and duplicate claim, progress and blocker outcomes explicitly remain open');
}
{
  const s=fresh('outcome-finish'); submit(s,'outcome-finish');
  const c=claim(s,'outcome-finish'); openOutcome(c,'outcome-finish');
  for(const receipt of [s.finish('outcome-finish',c.claim_id,'completed','done','result'),s.finish('outcome-finish',c.claim_id,'completed','done','result')]) {
    assert(JSON.stringify({terminal:receipt.terminal,status:receipt.status,result_authority:receipt.result_authority,request_action:receipt.request_action})===JSON.stringify({terminal:true,status:'finished',result_authority:true}),'finish outcome: '+JSON.stringify(receipt));
  }
  stoppedOutcome(()=>s.progress('outcome-finish',c.claim_id,'late'),/assignment is terminal/);
  log('finish and duplicate finish are terminal; progress after finish cannot continue');
}
{
  const s=fresh('outcome-cancel'); submit(s,'outcome-cancel');
  const c=claim(s,'outcome-cancel'); openOutcome(c,'outcome-cancel');
  s.cancel('outcome-cancel','owner withdrew');
  stoppedOutcome(()=>claim(s,'outcome-cancel'),/assignment cancelled/);
  stoppedOutcome(()=>s.progress('outcome-cancel',c.claim_id,'late'),/assignment is terminal/);
  stoppedOutcome(()=>s.finish('outcome-cancel',c.claim_id,'completed','late','evidence'),/assignment_cancelled/);
  log('cancelled claim, progress and finish never gain a continuation action');
}
{
  const s=fresh('outcome-superseded'); submit(s,'outcome-superseded');
  const c=claim(s,'outcome-superseded'); openOutcome(c,'outcome-superseded');
  now+=HOUR;
  const next=claim(s,'outcome-superseded'); openOutcome(next,'outcome-superseded');
  assert(next.claim_id!==c.claim_id,'takeover obtains a different grant');
  stoppedOutcome(()=>s.progress('outcome-superseded',c.claim_id,'old'),/claim_superseded/);
  stoppedOutcome(()=>s.finish('outcome-superseded',c.claim_id,'completed','old','old'),/claim_superseded/);
  log('superseded grant cannot continue while the replacement is explicitly open');
}
{
  const s=fresh('outcome-expired'); submit(s,'outcome-expired');
  const c=claim(s,'outcome-expired'); openOutcome(c,'outcome-expired');
  now+=HOUR;
  stoppedOutcome(()=>s.progress('outcome-expired',c.claim_id,'late'),/lease_expired/);
  stoppedOutcome(()=>s.finish('outcome-expired',c.claim_id,'completed','late','late'),/lease_expired/);
  submit(s,'outcome-queue-expired');
  s.db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?').run(iso(now),'outcome-queue-expired');
  stoppedOutcome(()=>claim(s,'outcome-queue-expired'),/expired/);
  log('expired grant and queued assignment have no continuation action');
}
{
  const s=fresh('outcome-denied'); submit(s,'outcome-denied');
  const c=claim(s,'outcome-denied'); openOutcome(c,'outcome-denied');
  stoppedOutcome(()=>s.progress('outcome-denied',c.claim_id,'foreign','other-subject'),/invalid claim/);
  submit(s,'outcome-capacity');
  stoppedOutcome(()=>s.claim('outcome-capacity','dot','local-principal',1),/capacity_full/);
  log('identity and capacity denials have no continuation action');
}
{
  const s=fresh('outcome-busy'); submit(s,'outcome-busy');
  const c=claim(s,'outcome-busy'); openOutcome(c,'outcome-busy');
  stoppedOutcome(()=>s.claim('outcome-busy','other-run','local-principal',2,null,'dot','other-acquisition'),/claim_busy/);
  log('claim_busy has no continuation action for the rival run');
}
{
  const s=fresh('outcome-protocol-replay'),id='outcome-protocol-replay';
  s.submit({...payload(id),protocol:{profile:'job-v0',source:'test',scope:'test',policy:'test',destination:'test',retain_until_ms:now+24*HOUR}},{mode:'none'},'','owner');
  const c=s.claim(id,'dot','local-principal',2,null,'dot','protocol-run',HOUR,{key:'claim',revision:1});
  openOutcome(c,id);
  const ctx={key:'progress',revision:c.revision};
  const p=s.progress(id,c.claim_id,'working','local-principal',false,'dot',null,ctx);
  openOutcome(p,id);
  // The durable value intentionally has the pre-addition shape; decoration belongs to the live return path.
  const durable=s.db.prepare('SELECT result FROM claim_command_receipts WHERE job=? AND command_key=?').get(id,'progress');
  assert(durable&&!/"terminal"|"request_action"/.test(durable.result),'persisted progress stays undecorated');
  const replay=s.progress(id,c.claim_id,'working','local-principal',false,'dot',null,ctx);
  openOutcome(replay,id);
  assert(replay.revision===p.revision,'replay preserves the command revision');
  now+=HOUR;
  stoppedOutcome(()=>s.progress(id,c.claim_id,'working','local-principal',false,'dot',null,ctx),/lease_expired/);
  stoppedOutcome(()=>s.claim(id,'dot','local-principal',2,null,'dot','protocol-run',HOUR,{key:'claim',revision:1}),/lease_expired/);
  log('live protocol replay decorates old-shape progress, but expired replay cannot continue');
}
console.log('lease-sweep-test ok');
