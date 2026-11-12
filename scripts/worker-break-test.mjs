#!/usr/bin/env node
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
// Usage breaks and the rolling-usage estimates at store level with an injected clock: owner set/clear/since, the three inferred-start
// conditions, auto-end on the next tool call, one start and one end alert, probe cadence, the window clock without break
// time, estimated limits that hold nothing, the ledger
// snapshot on a fixture timeline, and migration 25 on a v24 database.
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { checkAlerts } from '../src/alerts.mjs';
import { explainStatus } from '../src/status-evidence.mjs';

const home=await mkdtemp(join(tmpdir(),'dalan-bridge-break-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const SEC=1000,MIN=60000,HOUR=3600000,key=`whsec_${randomBytes(32).toString('base64')}`;
const payload=(id,brief=`break test ${id}`)=>({schema_version:1,request_id:id,brief,inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'read-only'});
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:1000*HOUR,laneCapacity:6,rewakeMs:90*SEC,rewakeWindowMs:2*HOUR,breakSilenceMs:20*MIN,breakProbeMs:30*MIN,maxClaimsPerHour:30,maxToolCallsPerHour:330,maxResponseBytesPerHour:2500000};
let now=Date.parse('2026-10-09T00:00:00.000Z'),ntfy=null;
const iso=ms=>new Date(ms).toISOString();
const fresh=(name,options={})=>{const s=new Store(join(home,`${name}.db`),{now:()=>now,capacity:6,limits,...options});s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+480*HOUR).toISOString());return s;};
const deliverAll=s=>s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=COALESCE(attempt_started_at,?) WHERE kind='event' AND state IN ('pending','sending','failed')").run(s.stamp());
const tick=(s,l=limits)=>s.reannounceQueued(l).announced;
const submit=(s,...ids)=>{for(const id of ids) s.submit(payload(id),'thread-x','e','owner');};
// Background-priority submit: no estimate holds it (scripts/gate-fairness-test.mjs).
const submitBg=(s,...ids)=>{for(const id of ids) s.submit(payload(id),'thread-x','e','owner',false,null,'background');};
const call=(s,n=1,subject='dot')=>{for(let i=0;i<n;i++) s.recordWorkerCall(subject,'get');};
try {
  // owner set, since, clear; validation
  {
    const s=fresh('owner');
    assert(JSON.stringify(s.breakState())==='{"active":false,"since":null,"reason":null,"source":null,"duration_ms":null}','inactive shape: '+JSON.stringify(s.breakState()));
    let threw=null;try{s.setBreak('x',iso(now+MIN));}catch(e){threw=e.message;}
    assert(/future/.test(threw),'future since accepted');
    const b=s.setBreak('limit hit',iso(now-2*HOUR));
    assert(b.active&&b.source==='owner'&&b.reason==='limit hit'&&b.since===iso(now-2*HOUR)&&b.duration_ms===2*HOUR,'owner break: '+JSON.stringify(b));
    const st=s.status({limits});
    assert(st.worker_break.active&&st.worker_break.since===b.since&&st.worker_break.source==='owner'&&st.worker_break.duration_ms===2*HOUR,'status worker_break');
    assert(explainStatus(st).includes(` worker_break=since:${b.since}(owner)`),'explain worker_break: '+explainStatus(st));
    // a second mark over the active break takes it over with the new reason; since kept unless given
    now+=MIN;const again=s.setBreak('limit hit (confirmed)');
    assert(again.id===b.id&&again.since===b.since&&again.reason==='limit hit (confirmed)'&&s.breaks().length===1,'second mark: '+JSON.stringify(again));
    const cleared=s.clearBreak();
    assert(cleared.cleared&&!cleared.worker_break.active&&s.breaks()[0].end_source==='owner'&&s.breaks()[0].until===iso(now),'clear: '+JSON.stringify(cleared));
    assert(!s.clearBreak().cleared,'second clear cleared something');
    assert(!explainStatus(s.status({limits})).includes('worker_break='),'explain shows an inactive break');
    threw=null;try{s.setBreak('overlap',iso(now-HOUR));}catch(e){threw=e.message;}
    assert(/previous break/.test(threw),'since before the previous break end accepted');
    s.db.close();
  }
  log('owner break: set with since, take-over keeps since, clear records end_source owner; future and overlapping since refused');

  // inferred start: silence AND a 2xx event after the last call AND queued work; since is the last call
  {
    const setup=(name,{silence=20*MIN,event=true,queued=true,eventStatus=200}={})=>{
      const s=fresh(name);submit(s,'w1');deliverAll(s);
      const t0=now;call(s);
      now+=MIN;if(event) s.eventResult('sub_a',eventStatus);
      if(!queued) s.cancel('w1');
      now=t0+silence;return {s,t0};
    };
    let {s,t0}=setup('infer-ok');
    const b=s.inferBreak(limits);
    assert(b&&b.source==='inferred'&&b.since===iso(t0)&&/no worker tool call for 20 min/.test(b.reason),'inferred break: '+JSON.stringify(b));
    assert(s.inferBreak(limits)===null&&s.breaks().length===1,'inferred twice');
    // auto-end: the next tool call ends it
    now+=5*MIN;call(s);
    const ended=s.breaks()[0];
    assert(!s.breakState().active&&ended.until===iso(now)&&ended.end_source==='tool_call','auto-end: '+JSON.stringify(ended));
    s.db.close();
    for(const [name,opts,why] of [['infer-short',{silence:20*MIN-1},'silence below worker_break_silence_ms'],['infer-noevent',{event:false},'no event after the last call'],['infer-500',{eventStatus:500},'a non-2xx event'],['infer-empty',{queued:false},'no queued work']]) {
      ({s}=setup(name,opts));assert(s.inferBreak(limits)===null,`inferred with ${why}`);s.db.close();
    }
    // a worker that never made a tool call has no known silence start: not inferred
    {const n=fresh('infer-nocall');submit(n,'w1');deliverAll(n);n.eventResult('sub_a',200);now+=HOUR;assert(n.inferBreak(limits)===null,'inferred without any tool call');n.db.close();}
    // an event older than the last call does not count
    ({s,t0}=setup('infer-old-event',{event:false}));s.db.prepare('UPDATE subscriptions SET last_event_2xx_at=?').run(iso(t0-MIN));
    assert(s.inferBreak(limits)===null,'inferred from an event before the last call');s.db.close();
    // an owner clear is not undone by inference until the worker calls again
    ({s}=setup('infer-cleared'));s.inferBreak(limits);s.clearBreak();now+=10*MIN;
    assert(s.inferBreak(limits)===null,'re-inferred after an owner clear without a new call');s.db.close();
  }
  log('inferred start needs all three: 20 min silence, a 2xx event after the last call, queued work; since = last call; next tool call ends it');

  // alerts: one start and one end per break, through the ntfy path, without assignment text
  {
    const received=[];
    ntfy=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;received.push({title:req.headers.title,body});res.writeHead(200).end('ok');});
    await new Promise(r=>ntfy.listen(0,'127.0.0.1',r));
    await mkdir(join(home,'.config/dot-bridge'),{recursive:true});
    await writeFile(join(home,'alerts.env'),`NTFY_URL=http://127.0.0.1:${ntfy.address().port}/t\n`,{mode:0o600});
    process.env.DOT_BRIDGE_ALERTS_FILE=join(home,'alerts.env');process.env.HOME=home;
    const s=fresh('alerts');s.submit(payload('secret_req','do not leak this brief'),'thread-x','e','owner');deliverAll(s);
    call(s);now+=MIN;s.eventResult('sub_a',200);now+=19*MIN;
    await checkAlerts(s,()=>{});
    const starts=()=>received.filter(x=>x.body.startsWith('worker_break:')), ends=()=>received.filter(x=>x.body.startsWith('worker_break resolved'));
    assert(starts().length===0,'inferred break paged before 30 minutes of observed queued work');
    now+=30*MIN;await checkAlerts(s,()=>{});
    assert(starts().length===1&&starts()[0].title==='Dalan attention'&&/\(inferred\)/.test(starts()[0].body),'start alert: '+JSON.stringify(received));
    assert(/may be on a usage break/.test(starts()[0].body)&&/Not confirmed, so nothing is held/.test(starts()[0].body)&&!/limited to one probe/.test(starts()[0].body),'inferred start alert text: '+starts()[0].body);
    assert(!starts()[0].body.includes('leak')&&!starts()[0].body.includes('secret_req'),'start alert leaks assignment text');
    for(let i=0;i<3;i++){now+=MIN;await checkAlerts(s,()=>{});}
    assert(starts().length===1&&ends().length===0,'start alert repeated or early end');
    call(s);await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(ends().length===1&&ends()[0].title==='Dalan recovered'&&/by tool_call/.test(ends()[0].body),'end alert: '+JSON.stringify(ends()));
    // an owner break alerts the same way, once each edge
    s.setBreak('Your worker is on a break.');await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(starts().length===1,'owner break paged before its threshold');
    now+=30*MIN;await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(starts().length===2&&/\(owner\): Your worker is on a break\./.test(starts()[1].body),'owner start alert: '+JSON.stringify(starts()));
    assert(/the worker is on a usage break/.test(starts()[1].body)&&/limited to one probe every 30 min/.test(starts()[1].body),'owner start alert text: '+starts()[1].body);
    s.clearBreak();await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(ends().length===2&&/by owner/.test(ends()[1].body),'owner end alert');
    // a failed publish is retried next minute, not lost
    now+=MIN;s.setBreak('ntfy down');await checkAlerts(s,()=>{});
    await new Promise(r=>ntfy.close(r));
    now+=30*MIN;let failed=false;try{await checkAlerts(s,()=>{});}catch{failed=true;}
    assert(failed&&s.breakAlertsDue().length===1,'failed publish marked as sent');
    ntfy=null;
    s.db.close();
  }
  log('ntfy: exactly one start (source, reason, no assignment text) and one recovery alert per break, inferred or owner; a failed publish retries');

  // probe cadence: during a break one re-wake every 30 min and nothing else; normal cadence after
  {
    const s=fresh('probe');submit(s,'p1','p2');deliverAll(s);
    now+=10*MIN;s.setBreak('limit',iso(now));
    const since=now,probes=[];
    for(let t=0;t<=2*HOUR;t+=30*SEC){now=since+t;const n=tick(s);if(n){probes.push(t);deliverAll(s);}}
    assert(JSON.stringify(probes)===JSON.stringify([30*MIN,60*MIN,90*MIN,120*MIN]),'probe times: '+JSON.stringify(probes.map(t=>t/MIN)));
    const kinds=s.db.prepare("SELECT wake_kind,request_id FROM notifications WHERE wake_kind='rewake'").all();
    assert(kinds.length===4&&kinds.every(k=>k.request_id==='p1'),'probe is the usual head re-wake: '+JSON.stringify(kinds));
    assert(s.breakState().last_probe_at===iso(since+120*MIN),'last_probe_at');
    // a new submit during the break still sends its own first event
    submit(s,'p3');assert(s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id='p3' AND wake_kind='submit' AND state='pending'").get().n===1,'submit event held during break');
    deliverAll(s);
    call(s);now+=90*SEC;assert(tick(s)===1,'normal re-wake did not resume after the break');
    s.db.close();
  }
  log('during a break: one probe re-wake (usual head) every worker_break_probe_ms and no other; submit events unchanged; normal cadence after');

  // an inferred break holds nothing: re-wakes keep the normal cadence, the break still ends on the next tool call; only an owner mark paces probes
  {
    const s=fresh('inferred-hold');submit(s,'i1','i2');deliverAll(s);
    call(s);now+=MIN;s.eventResult('sub_a',200);now+=20*MIN;
    const b=s.inferBreak(limits);
    assert(b?.source==='inferred'&&s.breakState().active&&s.holdingBreak()===null,'inferred break is not a holding break: '+JSON.stringify(b));
    const wakes=[];
    for(let t=0;t<=10*MIN;t+=30*SEC){now+=30*SEC;if(tick(s)){wakes.push(t);deliverAll(s);}}
    assert(wakes.length>=6&&wakes[1]-wakes[0]<=2*MIN,'inferred break paced re-wakes to probes: '+JSON.stringify(wakes.map(t=>t/MIN)));
    assert(s.reannounceQueued(limits).worker_break===undefined&&s.breakState().last_probe_at===null,'inferred break recorded a probe');
    // an owner mark over it takes over and starts the probe pacing
    s.setBreak('confirmed',iso(now));assert(s.holdingBreak()?.source==='owner','owner mark over an inferred break does not hold');
    now+=2*MIN;assert(tick(s)===0&&s.reannounceQueued(limits).worker_break===true,'owner break did not pace re-wakes');
    // the worker's next tool call still ends it
    call(s);assert(!s.breakState().active&&s.holdingBreak()===null,'break did not end on the tool call');
    s.db.close();
  }
  log('inferred break holds nothing: re-wakes keep the normal cadence and record no probe, holdingBreak is null; an owner mark over it starts probe pacing');

  // window clock: break time is not queued age
  {
    const s=fresh('window');submit(s,'old');deliverAll(s);const t0=now;
    now=t0+30*MIN;s.setBreak('limit',iso(now));
    now=t0+150*MIN;
    assert(s.status({limits}).unclaimed_after_reannounce.count===0,'unclaimed during break (age without break 30 min)');
    assert(s.rewakeCandidates('sub_a',limits).length===1,'head left the window during the break');
    call(s);// break ends at t0+150min
    now=t0+150*MIN+89*MIN;assert(s.status({limits}).unclaimed_after_reannounce.count===0,'unclaimed before 2 h of non-break queue time');
    now=t0+150*MIN+90*MIN;const u=s.status({limits}).unclaimed_after_reannounce;
    assert(u.count===1&&u.oldest_age_ms===240*MIN,'unclaimed at 2 h of non-break queue time: '+JSON.stringify(u));
    // Changed deliberately for the backoff: past the window the head stays eligible while its last wake is older than rewakeStaleMs
    assert(s.rewakeCandidates('sub_a',limits).length===1,'stale head with an old last wake not eligible');
    s.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,state,created_at,attempt_started_at,wake_kind) VALUES('evt_recent','event','old','sub_a','delivered',?,?,'rewake')").run(iso(now),iso(now));
    assert(s.rewakeCandidates('sub_a',limits).length===0,'stale head eligible right after a wake');
    assert(s.db.prepare("SELECT status FROM assignments WHERE request_id='old'").get().status==='queued','break changed the queue');
    s.db.close();
  }
  log('re-wake window and unclaimed clock exclude break time; the queue stays intact');

  // estimated limits hold nothing: reaching or passing the claim and tool-call estimates changes no re-wake, submit event or list_pending; it only reports
  {
    const tl={...limits,rewakeWindowMs:24*HOUR,maxClaimsPerHour:2,maxToolCallsPerHour:5};
    const s=fresh('throttle',{backgroundMaxInFlight:10});submitBg(s,'a','b','c','d');deliverAll(s);
    s.claim('a','dot','local-principal',6);now+=2*MIN;
    assert(tick(s,tl)===1&&s.rollingUsage(tl).over_estimate.length===0,'woke under the claim limit (1 of 2)');deliverAll(s);
    s.claim('b','dot','local-principal',6);now+=2*MIN;
    assert(tick(s,tl)===1&&s.rollingUsage(tl).over_estimate.join()==='claims_per_hour','re-wake went out at the claim estimate (2 of 2): '+JSON.stringify(s.rollingUsage(tl).over_estimate));deliverAll(s);
    s.claim('c','dot','local-principal',6);now+=2*MIN;assert(tick(s,tl)===1,'re-wake held over the claim estimate');deliverAll(s);
    const u=s.rollingUsage(tl);assert(u.claims_last_hour===3&&u.over_estimate.join()==='claims_per_hour'&&!u.rewake_throttled&&!u.submit_throttled&&!u.normal_rewake_throttled&&JSON.stringify(u.holding)==='{"rewake":[],"submit":[]}','rolling usage reports, holds nothing: '+JSON.stringify(u));
    assert(s.reannounceQueued(tl).throttled===undefined,'reannounceQueued still returns throttled');
    assert(/ calls=1h:0\/5,24h:0\/10000 bytes=1h:0\/2500000,24h:0\/100000000 over_estimate=claims_per_hour$/.test(explainStatus(s.status({limits:tl}))),'explain names the reached estimate and no throttle: '+explainStatus(s.status({limits:tl})));
    assert(s.listPending().some(x=>x.request_id==='d'),'background hidden from list_pending by an estimate');
    submitBg(s,'e');assert(s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id='e' AND wake_kind='submit'").get().n===1,'submit event held');deliverAll(s);
    now+=HOUR;assert(s.rollingUsage(tl).over_estimate.length===0&&tick(s,tl)===1,'claims did not leave the rolling hour');deliverAll(s);
    call(s,4);now+=2*MIN;assert(tick(s,tl)===1&&s.rollingUsage(tl).over_estimate.length===0,'woke under the tool-call limit failed (4 of 5)');deliverAll(s);
    call(s,1);now+=2*MIN;assert(tick(s,tl)===1&&s.rollingUsage(tl).over_estimate.join()==='tool_calls_per_hour','re-wake went out at the tool-call estimate (5 of 5)');deliverAll(s);
    call(s,3);now+=2*MIN;assert(s.rollingUsage(tl).tool_calls_last_hour===8&&tick(s,tl)===1,'re-wake held over the tool-call estimate');deliverAll(s);
    now+=61*MIN;assert(s.rollingUsage(tl).tool_calls_last_hour===0&&s.rollingUsage(tl).over_estimate.length===0&&tick(s,tl)===1,'tool calls did not leave the rolling hour');
    assert(!explainStatus(s.status({limits})).includes('over_estimate'),'explain shows an estimate while under it');
    s.db.close();
  }
  log('estimates: reaching max_claims_per_hour or max_tool_calls_per_hour reports over_estimate and holds nothing (re-wake, submit event, list_pending); cleared after the hour');

  // response bytes: per tool per minute in worker_calls; reaching max_response_bytes_per_hour reports over_estimate and holds nothing
  {
    const bl={...limits,rewakeWindowMs:24*HOUR,maxResponseBytesPerHour:100000};
    const s=fresh('bytes');submitBg(s,'a','b');deliverAll(s);
    const t0=Math.floor(now/60000);
    s.recordWorkerCall('dot','t3_thread_list');s.recordResponseBytes('dot','t3_thread_list',60000);
    s.recordWorkerCall('dot','read_file');s.recordResponseBytes('dot','read_file',39999);
    s.recordWorkerCall('dot','read_file');s.recordResponseBytes('dot','read_file',0);
    const rows=s.db.prepare('SELECT subject,minute,tool,count,bytes FROM worker_calls ORDER BY tool').all().map(r=>({...r}));
    assert(JSON.stringify(rows)===JSON.stringify([{subject:'dot',minute:t0,tool:'read_file',count:2,bytes:39999},{subject:'dot',minute:t0,tool:'t3_thread_list',count:1,bytes:60000}]),'per tool per minute: '+JSON.stringify(rows));
    let threw=null;try{s.recordResponseBytes('dot','get',-1);}catch(e){threw=e.message;}assert(/invalid response bytes/.test(threw??''),'negative bytes accepted');
    now+=2*MIN;
    let u=s.rollingUsage(bl);assert(u.response_bytes_last_hour===99999&&u.max_response_bytes_per_hour===100000&&u.over_estimate.length===0&&!u.rewake_throttled&&!u.submit_throttled,'under: '+JSON.stringify(u));
    assert(tick(s,bl)===1,'no re-wake under the byte limit');deliverAll(s);
    // a response written in a later minute than its call adds bytes to a count-0 row
    s.recordResponseBytes('dot','t3_thread_wait',1);now+=2*MIN;
    u=s.rollingUsage(bl);assert(u.response_bytes_last_hour===100000&&u.tool_calls_last_hour===3&&u.over_estimate.join()==='response_bytes_per_hour'&&!u.rewake_throttled&&!u.submit_throttled,'at: '+JSON.stringify(u));
    assert(tick(s,bl)===1,'re-wake held at the byte estimate');deliverAll(s);
    assert(/ calls=1h:3\/330,24h:3\/10000 bytes=1h:100000\/100000,24h:100000\/100000000 over_estimate=response_bytes_per_hour$/.test(explainStatus(s.status({limits:bl}))),'explain bytes: '+explainStatus(s.status({limits:bl})));
    s.recordResponseBytes('dot','get',5000);now+=2*MIN;assert(tick(s,bl)===1,'re-wake held over the byte estimate');
    assert(s.status({limits:bl}).throttle.response_bytes_last_hour===105000,'status throttle bytes');
    // the worker's own calls are never refused: recording keeps working over the limit
    s.recordWorkerCall('dot','claim');s.recordResponseBytes('dot','claim',10);
    deliverAll(s);now+=61*MIN;u=s.rollingUsage(bl);assert(u.response_bytes_last_hour===0&&u.over_estimate.length===0&&tick(s,bl)===1,'bytes did not leave the rolling hour');
    s.db.close();
  }
  // Rolling 24 h byte estimate: cumulative bytes report over_estimate, name the limit, and hold nothing.
  {
    const dl={...limits,rewakeWindowMs:48*HOUR,maxResponseBytesPerHour:1000000,maxResponseBytesPer24h:3000000};
    const s=fresh('bytes24');submit(s,'a','b');deliverAll(s);
    for(let h=0;h<3;h++){s.recordWorkerCall('dot','read_file');s.recordResponseBytes('dot','read_file',900000);now+=HOUR;}
    let u=s.rollingUsage(dl);
    assert(u.response_bytes_last_hour===0&&u.response_bytes_last_24h===2700000&&u.over_estimate.length===0,'24h under: '+JSON.stringify(u));
    s.recordWorkerCall('dot','read_file');s.recordResponseBytes('dot','read_file',300000);now+=2*MIN;
    u=s.rollingUsage(dl);
    assert(u.response_bytes_last_hour===300000&&u.response_bytes_last_24h===3000000&&u.over_estimate.join()==='response_bytes_per_24h'&&!u.rewake_throttled&&!u.submit_throttled,'24h at: '+JSON.stringify(u));
    assert(JSON.stringify(u.holding)==='{"rewake":[],"submit":[]}','nothing held by the 24 h estimate: '+JSON.stringify(u.holding));
    assert(tick(s,dl)===1,'re-wake held over the 24 h byte estimate');
    assert(/ calls=1h:1\/330,24h:4\/10000 bytes=1h:300000\/1000000,24h:3000000\/3000000 over_estimate=response_bytes_per_24h$/.test(explainStatus(s.status({limits:dl}))),'explain 24h: '+explainStatus(s.status({limits:dl})));
    deliverAll(s);now+=23*HOUR;u=s.rollingUsage(dl);assert(u.response_bytes_last_24h===300000&&u.over_estimate.length===0&&tick(s,dl)===1,'24 h estimate did not roll off: '+JSON.stringify(u)+' tick');
    s.db.close();
  }
  // Rolling 24 h tool-call estimate: cumulative calls report over_estimate and hold nothing.
  {
    const cl={...limits,rewakeWindowMs:48*HOUR,maxToolCallsPerHour:50,maxToolCallsPer24h:100};
    const s=fresh('calls24');submit(s,'a','b');deliverAll(s);
    for(let h=0;h<3;h++){call(s,30);now+=HOUR;}
    let u=s.rollingUsage(cl);assert(u.tool_calls_last_hour===0&&u.tool_calls_last_24h===90&&u.over_estimate.length===0,'calls 24h under: '+JSON.stringify(u));
    call(s,10);now+=2*MIN;u=s.rollingUsage(cl);
    assert(u.tool_calls_last_24h===100&&u.over_estimate.join()==='tool_calls_per_24h'&&!u.rewake_throttled&&!u.submit_throttled&&JSON.stringify(u.holding)==='{"rewake":[],"submit":[]}','calls 24h at: '+JSON.stringify(u));
    assert(tick(s,cl)===1,'re-wake held over the 24 h call estimate');
    assert(/ calls=1h:10\/50,24h:100\/100 /.test(explainStatus(s.status({limits:cl}))),'explain calls: '+explainStatus(s.status({limits:cl})));
    now+=23*HOUR;u=s.rollingUsage(cl);assert(u.tool_calls_last_24h===10&&u.over_estimate.length===0,'24 h call estimate did not roll off: '+JSON.stringify(u));
    s.db.close();
  }
  // Learned claims limit: 70% of the busiest rolling hour of claims in the 24 h before the break, not the (possibly quiet) last hour.
  {
    const s=fresh('learn-claims');
    const ids=Array.from({length:12},(_,i)=>`c${i}`);submit(s,...ids);deliverAll(s);
    for(let i=0;i<10;i++){s.claim(ids[i],'dot','local-principal',100);now+=3*MIN;}   // 10 claims within 30 min
    now+=5*HOUR;s.claim(ids[10],'dot','local-principal',100);now+=2*HOUR;           // a quiet stretch: 0 claims in the last hour
    s.setBreak('claims break',iso(now));
    const u=s.rollingUsage(limits);
    // learned 7 (70% of 10); the effective limit is floored at 25% of the configured 30, so 8.
    assert(u.learned_claims_per_hour?.value===7&&u.max_claims_per_hour===8&&u.configured_claims_per_hour===limits.maxClaimsPerHour,'learned claims 70% of peak 10, floored at 8: '+JSON.stringify(u));
    const usage=s.listBreaks?s.listBreaks()[0]?.usage_before:JSON.parse(s.db.prepare('SELECT usage FROM worker_breaks ORDER BY id DESC LIMIT 1').get().usage);
    assert(usage['24h'].peak_claims_per_hour===10&&usage['1h'].claims===0,'ledger peak: '+JSON.stringify(usage['24h']));
    s.db.close();
  }
  // Learned limits: a break whose ledger has complete byte windows cuts both budgets to 70%; only ever lower; partial windows skip.
  {
    const s=fresh('learn');submit(s,'a');deliverAll(s);
    const start=now;
    for(let m=0;m<25*60;m+=30){s.recordWorkerCall('dot','read_file');s.recordResponseBytes('dot','read_file',100000);now+=30*MIN;}
    // 24 h window before since: 48 records x 100000 = 4.8 MB; 1 h window: 2 records = 200000.
    s.setBreak('test break',iso(now));
    let u=s.rollingUsage(limits);
    // the ledger values are kept as learned; the effective limits are floored at 25% of the configured ones.
    assert(u.learned_response_bytes.response_bytes_per_hour.value===140000&&u.learned_response_bytes.response_bytes_per_24h.value===3360000,'learned 70%: '+JSON.stringify(u));
    assert(u.max_response_bytes_per_hour===625000&&u.max_response_bytes_per_24h===25000000,'learned bytes floored at 25% of configured: '+JSON.stringify(u));
    // calls: 2 calls in the 1 h window, 48 in the 24 h window (one per record) -> 70% floors 1 and 33.
    assert(u.learned_tool_calls.tool_calls_per_hour.value===1&&u.learned_tool_calls.tool_calls_per_24h.value===33&&u.learned_tool_calls.tool_calls_per_24h.break_id===1,'learned calls 70%: '+JSON.stringify(u));
    assert(u.max_tool_calls_per_hour===83&&u.max_tool_calls_per_24h===2500,'learned calls floored at 25% of configured: '+JSON.stringify(u));
    assert(u.learned_response_bytes.response_bytes_per_hour.break_id===1&&u.configured_response_bytes.hour===limits.maxResponseBytesPerHour,'learned source and configured kept: '+JSON.stringify(u));
    s.clearBreak();
    // a later break with higher usage never raises a learned limit
    for(let m=0;m<60;m+=10){s.recordWorkerCall('dot','read_file');s.recordResponseBytes('dot','read_file',500000);now+=10*MIN;}
    s.setBreak('second break',iso(now));
    u=s.rollingUsage(limits);assert(u.learned_response_bytes.response_bytes_per_hour.value===140000&&u.learned_tool_calls.tool_calls_per_24h.value===33,'learned limit raised: '+JSON.stringify(u));
    s.db.close();
    // a break with partial byte history (no 24 h of data) learns the hour only
    const p=fresh('learn-partial');now+=MIN;
    p.recordWorkerCall('dot','read_file');p.recordResponseBytes('dot','read_file',1000);now+=30*MIN;
    p.recordWorkerCall('dot','read_file');p.recordResponseBytes('dot','read_file',1000);now+=5*MIN;
    p.setBreak('partial',iso(now));
    u=p.rollingUsage(limits);
    assert(u.max_response_bytes_per_24h===100000000&&!u.learned_response_bytes.response_bytes_per_24h,'partial 24 h window learned: '+JSON.stringify(u));
    p.db.close();
  }
  // An inferred break learns nothing: it starts at the last call, so its last hour is quiet by construction.
  // An owner-marked break can train limits; clearing it removes everything learned.
  {
    const s=fresh('learn-inferred');submit(s,'a','b');deliverAll(s);
    for(let m=0;m<25*60;m+=30){s.recordWorkerCall('dot','read_file');s.recordResponseBytes('dot','read_file',100000);now+=30*MIN;}
    s.eventResult('sub_a',200);now+=25*MIN;
    const b=s.inferBreak(limits);
    assert(b?.source==='inferred'&&s.learnedLimits().length===0,'inferred break learned limits: '+JSON.stringify(s.learnedLimits()));
    let u=s.rollingUsage(limits);assert(u.max_tool_calls_per_hour===limits.maxToolCallsPerHour&&u.max_claims_per_hour===limits.maxClaimsPerHour,'inferred break cut limits: '+JSON.stringify(u));
    s.setBreak('confirmed: synthetic usage pause');
    assert(s.learnedLimits().some(r=>r.name==='tool_calls_per_24h'&&r.break_id===b.id),'owner mark over an inferred break did not learn: '+JSON.stringify(s.learnedLimits()));
    // without --since the mark keeps the inferred since, whose last hour is quiet: no hourly limit is learned from it
    assert(!s.learnedLimits().some(r=>r.name.endsWith('_per_hour')&&r.name!=='claims_per_hour'),'hourly limit learned from the quiet hour: '+JSON.stringify(s.learnedLimits()));
    // over estimate: the learned 24 h calls limit (floored 2500) is reached at 2500 calls (the configured 10000 would not be) and is reported with its source; it holds nothing.
    s.clearBreak();
    for(let i=0;i<2500;i++) s.recordWorkerCall('dot','read_file');
    const over=s.overEstimate(limits);
    assert(over.some(x=>x.name==='tool_calls_per_24h'&&x.used>=2500&&x.limit===2500&&x.configured===10000&&x.learned===33&&x.break_id===b.id),'learned over estimate: '+JSON.stringify(over));
    assert(!s.rollingUsage(limits).rewake_throttled&&!s.rollingUsage(limits).submit_throttled,'a learned limit held work');
    // alert: one usage_over_estimate page while it is reached, one recovery after clear
    const received=[];const server=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;received.push({title:req.headers.title,body});res.writeHead(200).end('ok');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    await writeFile(join(home,'alerts.env'),`NTFY_URL=http://127.0.0.1:${server.address().port}/t\n`,{mode:0o600});
    await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    const pages=()=>received.filter(x=>x.body.startsWith('usage_over_estimate'));
    assert(pages().length===0,'over-estimate paged before 30 minutes');
    now+=30*MIN;await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(pages().length===1&&/^usage_over_estimate: (?:tool_calls_per_hour \d+\/1000; )?tool_calls_per_24h 25\d\d\/2500 \(configured 10000, learned 33 from break \d+, floored\)\. Estimates only; the bridge holds no work for them\./.test(pages()[0].body),'over-estimate alert: '+JSON.stringify(received));
    now+=61*MIN;const cleared=s.clearLearnedLimits();/* the hour leaves the window; only the learned 24 h estimate was still reached */
    await checkAlerts(s,()=>{});
    assert(pages().length===2&&pages()[1].title==='Dalan recovered','over-estimate recovery alert: '+JSON.stringify(pages()));
    await new Promise(r=>server.close(r));
    assert(cleared.cleared>0&&s.learnedLimits().length===0&&s.overEstimate(limits).length===0,'clear learned: '+JSON.stringify(cleared));
    u=s.rollingUsage(limits);assert(u.max_tool_calls_per_24h===10000,'clear did not restore configured: '+JSON.stringify(u));
    s.db.close();
  }
  log('learned limits: only owner-confirmed breaks learn, effective limits floored at 25% of configured, a reached learned limit pages once (usage_over_estimate) and recovers, clear restores configured');
  {
  }
  log('response bytes: recorded per subject, tool and minute; no re-wake at/over max_response_bytes_per_hour, re-wake under it and after the hour; explain and status show bytes');

  // ledger: usage snapshot for the 1h/6h/24h before since on a fixture timeline
  {
    const T=Date.parse('2026-10-09T14:24:44.840Z');now=T-31*HOUR;
    const s=new Store(join(home,'ledger.db'),{now:()=>now,capacity:6,limits});
    for(const id of ['A','B','C','D']) s.submit(payload(id),'thread-x','e','owner');
    const at=ms=>{now=T-ms;};
    at(30*HOUR);call(s,1);s.recordResponseBytes('dot','get',99);
    at(20*HOUR);s.recordResponseBytes('dot','get',1000);at(3*HOUR);s.recordResponseBytes('dot','read_file',700);
    at(30*MIN);s.recordResponseBytes('dot','read_file',2000);s.recordResponseBytes('dot','t3_thread_list',5000);at(0);s.recordResponseBytes('dot','t3_thread_list',123456);
    at(25*HOUR);const d=s.claim('D','dot','local-principal',6);at(24.5*HOUR);s.finish('D',d.claim_id,'completed','s','r','local-principal');
    at(20*HOUR);call(s,5);const a=s.claim('A','dot','local-principal',6);at(19*HOUR);s.finish('A',a.claim_id,'completed','s','r','local-principal');
    at(3*HOUR);call(s,7);const b=s.claim('B','dot','local-principal',6);at(2*HOUR);s.finish('B',b.claim_id,'completed','s','r','local-principal');
    at(30*MIN);call(s,11);const c=s.claim('C','dot','local-principal',6);at(10*MIN);s.finish('C',c.claim_id,'completed','s','r','local-principal');
    const check=(id,ms,duration)=>s.db.prepare("INSERT INTO check_runs(id,request_id,claim_id,check_id,exit_code,timed_out,output_artifact_id,output_sha256,duration_ms,created_at) VALUES(?,?,?,'test',0,0,'art','sha',?,?)").run(id,'A',a.claim_id,duration,iso(T-ms));
    check('r1',5*HOUR,90000);check('r2',20*MIN,61000);check('r3',2*HOUR,60000);check('r4',23*HOUR,120000);
    now=T+5*HOUR;s.setBreak('Your worker is on a break.',iso(T));
    const usage=s.breaks()[0].usage_before;
    const want={'1h':{claims:1,finishes:1,tool_calls:11,checks_over_60s:1,response_bytes:7000,response_bytes_by_tool:{t3_thread_list:5000,read_file:2000}},
      '6h':{claims:2,finishes:2,tool_calls:18,checks_over_60s:2,response_bytes:7700,response_bytes_by_tool:{t3_thread_list:5000,read_file:2700}},
      '24h':{claims:3,peak_claims_per_hour:1,finishes:3,tool_calls:23,checks_over_60s:3,response_bytes:8700,response_bytes_by_tool:{t3_thread_list:5000,read_file:2700,get:1000}}};
    assert(JSON.stringify(usage)===JSON.stringify(want),'ledger snapshot: '+JSON.stringify(usage));
    assert(s.breaks()[0].duration_ms===5*HOUR&&s.breaks()[0].source==='owner','ledger row');
    // the counter did not exist before since: tool_calls null; it starts inside a window: partial
    const n=new Store(join(home,'ledger-new.db'),{now:()=>now,limits});
    assert(n.usageBefore(T)['1h'].tool_calls===null&&n.usageBefore(T)['1h'].response_bytes===null&&!('response_bytes_by_tool' in n.usageBefore(T)['1h']),'tool_calls/bytes without counter history');
    now=T-30*MIN;call(n,2);now=T+MIN;
    const p=n.usageBefore(T);assert(p['1h'].tool_calls===2&&p['1h'].tool_calls_partial===true&&p['24h'].tool_calls_partial===true,'partial counter: '+JSON.stringify(p));
    assert(p['1h'].response_bytes===0&&p['1h'].response_bytes_partial===true&&JSON.stringify(p['1h'].response_bytes_by_tool)==='{}','partial bytes: '+JSON.stringify(p));
    // the counter keeps 48 h
    // backfill from the request log merges a request_log entry per window, never touching DB-sourced numbers; idempotent
    const before=s.breaks()[0].usage_before, id=s.breaks()[0].id;
    const win=(bytes,partial)=>({response_bytes:bytes,calls:3,by_tool:{get:{calls:1,bytes:bytes-100},t3_thread_list:{calls:2,bytes:100}},...(partial?{partial:true}:{})});
    const windows={'1h':win(1100),'6h':win(2100),'24h':win(3100,true)};
    for(const [bad,msg] of [[[id+99,iso(T),windows],/break not found/],[[id,iso(T+1),windows],/since mismatch/],[[id,iso(T),{'1h':win(1)}],/exactly 1h, 6h and 24h/],
      [[id,iso(T),{...windows,'1h':{...win(1100),response_bytes:1}}],/invalid 1h window/],[[id,iso(T),{...windows,'6h':{...win(2100),by_tool:{'Bad Tool':{calls:3,bytes:2100}}}}],/invalid 6h window/],
      [[id,iso(T),{...windows,'24h':{...win(3100),extra:1}}],/invalid 24h window/],[[id,iso(T),{...windows,'1h':{...win(1100),calls:-1}}],/invalid 1h window/]]) {
      let threw=null;try{s.mergeBreakUsage(...bad);}catch(e){threw=e.message;}assert(bad[1]&&msg.test(threw??''),`backfill accepted ${msg}: ${threw}`);
    }
    assert(JSON.stringify(s.breaks()[0].usage_before)===JSON.stringify(before),'a refused backfill changed the snapshot');
    const merged=s.mergeBreakUsage(id,iso(T),windows);
    assert(merged.updated&&JSON.stringify(merged.usage_before['24h'].request_log)==='{"source":"request_log","response_bytes":3100,"calls":3,"by_tool":{"get":{"calls":1,"bytes":3000},"t3_thread_list":{"calls":2,"bytes":100}},"partial":true}','merged: '+JSON.stringify(merged.usage_before['24h']));
    for(const name of ['1h','6h','24h']) { const {request_log,...db}=s.breaks()[0].usage_before[name]; assert(JSON.stringify(db)===JSON.stringify(before[name]),`backfill clobbered DB-sourced ${name}`); }
    const again=s.mergeBreakUsage(id,iso(T),windows);assert(!again.updated&&JSON.stringify(again.usage_before)===JSON.stringify(merged.usage_before),'backfill not idempotent');
    const revised=s.mergeBreakUsage(id,iso(T),{...windows,'1h':win(1200)});assert(revised.updated&&revised.usage_before['1h'].request_log.response_bytes===1200&&revised.usage_before['6h'].request_log.response_bytes===2100,'re-backfill replaces request_log');
    now=T+49*HOUR;assert(s.pruneWorkerCalls()===8&&s.db.prepare('SELECT count(*) n FROM worker_calls').get().n===0,'prune');
    s.db.close();n.db.close();
  }
  log('ledger: break start records claims, finishes, tool calls, checks >60 s and response bytes (total and by tool) for the 1h/6h/24h before since; null/partial without counter history; request-log backfill validated, merged without clobbering, idempotent; counter pruned at 48 h');

  // migration 25 on a v24 database keeps existing claims valid
  {
    const file=join(home,'v24.db');
    let s=new Store(file,{now:()=>now,limits});
    s.submit(payload('m1'),'thread-x','e','owner');s.submit(payload('m2'),'thread-x','e','owner');
    const c=s.claim('m1','dot','local-principal',6);
    preWorkerFixture(s);
    // The rewound fixture carries the break table under its original name.
    s.db.exec('DROP TABLE break_notices; DROP TABLE dot_breaks; DROP TABLE worker_calls; PRAGMA user_version=24;');s.db.close();
    s=new Store(file,{now:()=>now,limits});
    assert(s.db.prepare('PRAGMA user_version').get().user_version===66,'migration 25+26+27 version');
    assert(s.claims().length===1&&s.claims()[0].claim_id===c.claim_id&&s.claims()[0].epoch===1,'claim lost in migration 25');
    s.progress('m1',c.claim_id,'still valid','local-principal');
    call(s);s.setBreak('after migration');
    let threw=null;try{s.db.prepare("INSERT INTO worker_breaks(since,reason,source,usage,created_at) VALUES(?,?,?,?,?)").run(s.stamp(),'two','owner','{}',s.stamp());}catch(e){threw=e.message;}
    assert(/UNIQUE/.test(threw??''),'two active breaks allowed');
    s.db.close();new Store(file).db.close();
  }
  log('migration 25 on a v24 database: tables added, at most one active break, existing claims stay valid');

  // migration 26 on a v25 database: worker_calls gains tool and bytes; old counts kept as 'unrecorded', bytes NULL
  {
    const file=join(home,'v25.db'), T=now;
    let s=new Store(file,{now:()=>now,limits});
    s.submit(payload('n1'),'thread-x','e','owner');const c=s.claim('n1','dot','local-principal',6);
    preWorkerFixture(s);
    s.db.exec(`DROP TABLE worker_calls; CREATE TABLE worker_calls (subject TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(subject,minute));
      CREATE INDEX worker_calls_minute ON worker_calls(minute); PRAGMA user_version=25;`);
    s.db.prepare('INSERT INTO worker_calls VALUES(?,?,?)').run('dot',Math.floor((T-30*MIN)/60000),7);s.db.close();
    s=new Store(file,{now:()=>now,limits});
    assert(s.db.prepare('PRAGMA user_version').get().user_version===66,'migration 26 version');
    const rows=s.db.prepare('SELECT subject,tool,count,bytes FROM worker_calls').all().map(r=>({...r}));
    assert(JSON.stringify(rows)==='[{"subject":"dot","tool":"unrecorded","count":7,"bytes":null}]','migrated rows: '+JSON.stringify(rows));
    assert(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='worker_calls_minute'").get(),'minute index lost');
    assert(s.claims().length===1&&s.claims()[0].claim_id===c.claim_id,'claim lost in migration 26');
    s.progress('n1',c.claim_id,'still valid','local-principal');
    const u=s.usageBefore(now);assert(u['1h'].tool_calls===7&&u['1h'].response_bytes===null,'pre-26 counts without bytes: '+JSON.stringify(u['1h']));
    assert(s.rollingUsage(limits).response_bytes_last_hour===0&&s.rollingUsage(limits).tool_calls_last_hour===7,'rolling usage after 26');
    s.recordWorkerCall('dot','get');s.recordResponseBytes('dot','get',42);now+=MIN;
    assert(s.usageBefore(now)['1h'].response_bytes===42&&s.usageBefore(now)['1h'].response_bytes_partial===true,'bytes after 26: '+JSON.stringify(s.usageBefore(now)['1h']));
    s.db.close();new Store(file).db.close();
  }
  log('migration 26 on a v25 database: worker_calls rebuilt with tool and bytes, old counts kept as unrecorded with bytes NULL, existing claims stay valid');
  log('worker break test');
} catch(error) {console.error(`FAIL ${error.stack||error}`);process.exitCode=1;}
finally {if(ntfy)await new Promise(r=>ntfy.close(r));await rm(home,{recursive:true,force:true});}
