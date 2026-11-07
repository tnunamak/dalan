#!/usr/bin/env node
// A worker note that reports a denied claim is evidence the worker will not take that request: the bridge stops re-waking it,
// and after a capacity-overrun denial holds every re-wake until a claimed assignment ends (at most 30 min). Store level,
// injected clock; plus the claim_denied alert.
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { checkAlerts } from '../src/alerts.mjs';

const home=await mkdtemp(join(tmpdir(),'dalan-bridge-claim-denial-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const SEC=1000,MIN=60000,HOUR=3600000,key=`whsec_${randomBytes(32).toString('base64')}`;
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:HOUR,laneCapacity:6,rewakeMs:90*SEC,rewakeWindowMs:2*HOUR,breakSilenceMs:20*MIN,breakProbeMs:30*MIN};
let now=Date.parse('2026-10-11T21:00:00.000Z');
const payload=id=>({schema_version:1,request_id:id,brief:`task ${id}`,inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'read-only'});
const fresh=name=>{const s=new Store(join(home,`${name}.db`),{now:()=>now,capacity:6,limits});s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+480*HOUR).toISOString());return s;};
const deliverAll=s=>s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=COALESCE(attempt_started_at,?) WHERE kind='event' AND state IN ('pending','sending','failed')").run(s.stamp());
const named=s=>s.rewakeCandidates('sub_a',limits).map(r=>r.request_id);
try {
  // a non-capacity denial: only the named request stops being re-woken; others still are
  {
    const s=fresh('plain');
    for(const id of ['fixture-active-3','fixture-denied-2','fixture-other-1']) s.submit(payload(id),'thread-x','e','owner');
    deliverAll(s);
    const c=s.claim('fixture-active-3','dot','local-principal',6);
    s.progress('fixture-active-3',c.claim_id,'Note: I will claim fixture-other-1 next.','local-principal');
    assert(s.deniedQueued().length===0,'a note without a denial recorded one');
    s.progress('fixture-active-3',c.claim_id,'BLOCKED: the claim of fixture-denied-2 was denied by auto-review. I will not retry it.','local-principal');
    const d=s.claimDenial('fixture-denied-2');
    assert(d&&d.reported_in==='fixture-active-3'&&d.capacity===false,'denial: '+JSON.stringify(d));
    assert(!named(s).includes('fixture-denied-2')&&named(s).includes('fixture-other-1'),'re-wake candidates: '+named(s));
    assert(s.capacityHoldUntil()===null,'a plain denial held every re-wake');
    now+=5*MIN;deliverAll(s);assert(s.reannounceQueued(limits).announced===1,'other work no longer re-woken');
    const st=s.status({limits});assert(st.claim_denied.count===1&&st.claim_denied.request_ids[0]==='fixture-denied-2','status: '+JSON.stringify(st.claim_denied));
    assert(s.get('fixture-denied-2').claim_denied?.reported_in==='fixture-active-3','get shows the denial');
    // the worker claims it after all: the denial is gone
    s.claim('fixture-denied-2','dot','local-principal',6);assert(s.claimDenial('fixture-denied-2')===null&&s.deniedQueued().length===0,'claim did not clear the denial');
    s.db.close();
  }
  console.log('PASS a note reporting a denied claim stops re-waking only the named request; a claim clears it; status and get show it');
  // precision: the ID, a claim and a denial in one sentence; whole IDs only; "capacity" only in that sentence
  {
    const s=fresh('precision');
    for(const id of ['host-0000001','task-0000001','task-00000010','task-0000002']) s.submit(payload(id),'thread-x','e','owner');
    deliverAll(s);const h=s.claim('host-0000001','dot','local-principal',6);
    s.progress('host-0000001',h.claim_id,'BLOCKED: Guardian denied reading .env. Moving on with the claim; also see task-0000002 for context.','local-principal');
    assert(s.deniedQueued().length===0,'a denied read plus a mentioned ID recorded a claim denial: '+JSON.stringify(s.deniedQueued()));
    s.progress('host-0000001',h.claim_id,'BLOCKED: the claim of task-00000010 was denied by auto-review. Tool capacity is unknown.','local-principal');
    assert(JSON.stringify(s.deniedQueued().map(d=>d.request_id))==='["task-00000010"]','prefix ID matched: '+JSON.stringify(s.deniedQueued()));
    assert(s.claimDenial('task-00000010').capacity===false&&s.capacityHoldUntil()===null,'capacity in another sentence set the hold');
    // a later note can upgrade the same request to a capacity denial
    s.progress('host-0000001',h.claim_id,'BLOCKED: claim of task-00000010 denied again for capacity overrun.','local-principal');
    assert(s.claimDenial('task-00000010').capacity===true&&s.capacityHoldUntil()!==null,'upgrade to capacity');
    // cancelling queued work does not free a slot
    s.cancel('task-0000002');assert(s.capacityHoldUntil()!==null,'a queued cancel released the hold');
    s.db.close();
  }
  console.log('PASS claim denials need the ID, a claim and a denial in one sentence; whole IDs only; capacity upgrades; a queued cancel frees no slot');
  // a capacity-overrun denial holds every re-wake until a claimed assignment ends, at most 30 min
  {
    const s=fresh('capacity');
    for(const id of ['work-a','work-b','denied-c','other-d']) s.submit(payload(id),'thread-x','e','owner');
    deliverAll(s);
    const a=s.claim('work-a','dot','local-principal',6);s.claim('work-b','dot','local-principal',6);
    s.progress('work-a',a.claim_id,'QUESTION: New claim denied-c was just denied on capacity grounds (capacity overrun).','local-principal');
    assert(s.claimDenial('denied-c')?.capacity===true,'capacity flag');
    const until=s.capacityHoldUntil();assert(until===new Date(now+30*MIN).toISOString(),'hold until: '+until);
    now+=5*MIN;deliverAll(s);
    assert(JSON.stringify(s.reannounceQueued(limits))==='{"announced":0,"capacity_denied":true}','re-woke under a capacity hold');
    assert(/capacity denial/.test(s.rewakeStale({subscription_id:'sub_a',request_id:'other-d'})??''),'a queued re-wake would still be sent under the hold');
    // a slot frees when a claimed assignment completes: the hold ends, the denied request stays out
    s.finish('work-a',a.claim_id,'completed','done','result','local-principal');
    assert(s.capacityHoldUntil()===null,'hold outlived a completion');
    now+=2*MIN;assert(s.reannounceQueued(limits).announced===1&&!named(s).includes('denied-c')&&named(s).includes('other-d'),'after the hold');
    // no slot frees: the hold still ends after 30 min
    const b2=s.db.prepare("SELECT claim_id FROM claims WHERE request_id='work-b'").get().claim_id;
    s.submit(payload('denied-e'),'thread-x','e','owner');
    s.progress('work-b',b2,'BLOCKED: claim of denied-e denied by Guardian: capacity overrun.','local-principal');
    assert(s.capacityHoldUntil()!==null,'second hold');
    now+=31*MIN;assert(s.capacityHoldUntil()===null,'hold outlived 30 min');
    s.db.close();
  }
  console.log('PASS a capacity-overrun denial holds every re-wake until a claimed assignment ends, at most 30 min');
  // alert: one claim_denied page per episode, recovery when the denied request is claimed or cancelled
  {
    const received=[];const server=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;received.push({title:req.headers.title,body});res.writeHead(200).end('ok');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    await writeFile(join(home,'alerts.env'),`NTFY_URL=http://127.0.0.1:${server.address().port}/t\n`,{mode:0o600});
    process.env.DOT_BRIDGE_ALERTS_FILE=join(home,'alerts.env');process.env.HOME=home;
    const s=fresh('alert');
    for(const id of ['host-1','denied-2']) s.submit(payload(id),'thread-x','e','owner');
    deliverAll(s);const h=s.claim('host-1','dot','local-principal',6);
    s.progress('host-1',h.claim_id,'BLOCKED: the claim of denied-2 was denied by auto-review for capacity overrun.','local-principal');
    await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    const pages=()=>received.filter(x=>x.body.startsWith('claim_denied'));
    assert(pages().length===0,'claim denial paged before 30 minutes');
    now+=30*MIN;
    s.progress('host-1',h.claim_id,'BLOCKED: the claim of denied-2 was denied by auto-review for capacity overrun.','local-principal');
    await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(pages().length===1&&/denied-2/.test(pages()[0].body)&&/capacity overrun/.test(pages()[0].body),'claim_denied page: '+JSON.stringify(received));
    s.cancel('denied-2','owner');await checkAlerts(s,()=>{});
    assert(pages().length===2&&pages()[1].title==='Dalan recovered','recovery: '+JSON.stringify(pages()));
    server.closeAllConnections();await new Promise(r=>server.close(r));s.db.close();
  }
  console.log('PASS claim_denied pages once while a denied request is queued and recovers when it leaves the queue');
} finally { await rm(home,{recursive:true,force:true}); }
