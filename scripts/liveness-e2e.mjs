#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store, loadRedeliveryLimits } from '../src/store.mjs';
import { checkAlerts, redactNote } from '../src/alerts.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname),home=await mkdtemp(join(tmpdir(),'dalan-bridge-liveness-'));
// Use a free port to avoid fixture collisions unless LIVENESS_PORT pins it.
const port=Number(process.env.LIVENESS_PORT)||await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port));});});
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const payload=id=>({schema_version:1,request_id:id,brief:'liveness test',inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'read-only'});
const MIN=60000,key=`whsec_${randomBytes(32).toString('base64')}`;
let service=null,ntfy=null;
try {
  // ---- store level, injected clock
  let now=Date.parse('2026-10-07T00:00:00.000Z');
  const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:45*MIN};
  const fresh=(name,options={})=>{const s=new Store(join(home,`${name}.db`),{now:()=>now,random:()=>0.5,capacity:2,limits,...options});s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+48*3600000).toISOString());return s;};
  const deliver=(s,id)=>s.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id=? AND state IN ('pending','sending','failed')").run(id);
  const eventsFor=(s,id)=>s.db.prepare("SELECT count(*) n FROM notifications WHERE kind='event' AND request_id=?").get(id).n;
  const klass=(s,id)=>s.liveness().items.find(i=>i.request_id===id)?.class;

  // limits.json: each key independently optional, validated
  {
    const file=join(home,'limits.json');
    await writeFile(file,JSON.stringify({stale_claim_ms:60000}),{mode:0o600});
    const only=loadRedeliveryLimits(file);
    assert(only.leaseMs===60000&&only.silenceMs===1200000&&only.intervalMs===600000,'limits keys are not independently optional');
    await writeFile(file,JSON.stringify({pause_suspected_silence_ms:1000}),{mode:0o600});
    let rejected=false;try{loadRedeliveryLimits(file);}catch(error){rejected=error.message==='invalid pause_suspected_silence_ms';}
    assert(rejected,'bad silence threshold accepted');
    await writeFile(file,'{}',{mode:0o600});assert(loadRedeliveryLimits(file).leaseMs===3600000,'empty limits file');
    assert(loadRedeliveryLimits(file).laneCapacity===6,'worker_lane_capacity default');
    await writeFile(file,JSON.stringify({worker_lane_capacity:10,max_claimed_outer_assignments:3}),{mode:0o600});assert(loadRedeliveryLimits(file).laneCapacity===10,'worker_lane_capacity read');
    for(const bad of [0,11,2.5,'6']){ await writeFile(file,JSON.stringify({worker_lane_capacity:bad}),{mode:0o600}); let ok=false;try{loadRedeliveryLimits(file);}catch(error){ok=error.message==='invalid worker_lane_capacity';} assert(ok,`worker_lane_capacity ${bad} accepted`); }
  }
  log('limits.json keys independently optional and validated');

  // classification: pause_suspected, alive_not_claiming
  {
    const s=fresh('classes');
    s.submit(payload('req_a'),'t','e','owner');deliver(s,'req_a');
    now+=19*MIN;assert(klass(s,'req_a')===null,'classified before silence threshold');
    now+=1*MIN;assert(klass(s,'req_a')==='pause_suspected','pause_suspected missing');
    const st=s.status();
    assert(st.queue_classes.pause_suspected===1&&st.last_worker_call_at===null&&st.oldest_unclaimed_event_2xx_age_ms===20*MIN&&st.claimed_outer_count===0&&st.max_claimed_outer_assignments===2,'status observations wrong');
    assert(!JSON.stringify(st).includes('"paused_suspected"')&&!('items' in st),'status shape');
    s.recordWorkerCall('local-principal','list_pending');
    assert(klass(s,'req_a')!=='pause_suspected','recent worker call did not clear pause_suspected');
    now+=25*MIN;s.recordWorkerCall('local-principal','get');
    assert(klass(s,'req_a')==='alive_not_claiming','alive_not_claiming missing');
    assert(s.status().last_list_pending_at!==null,'last_list_pending_at missing');
    s.db.close();
  }
  log('pause_suspected and alive_not_claiming classification');

  // at_capacity_healthy vs stale_claims, even with an empty queue; never auto-reclaimed
  {
    const s=fresh('capacity');
    for(const id of ['c1','c2','q1']){s.submit(payload(id),'t','e','owner');deliver(s,id);}
    const c1=s.claim('c1','dot','local-principal',2),c2=s.claim('c2','dot','local-principal',2);
    now+=30*MIN;assert(klass(s,'q1')==='at_capacity_healthy','at_capacity_healthy missing');
    s.progress('c1',c1.claim_id,'working','local-principal');
    now+=30*MIN;
    assert(klass(s,'q1')==='at_capacity_healthy','fresh progress on one claim should keep capacity healthy');
    const st=s.status();
    assert(st.stale_claims.count===2&&st.stale_claims.max_idle_ms===60*MIN&&st.oldest_claim_age_ms===60*MIN&&st.oldest_claim_progress_age_ms===60*MIN,'stale claim observations wrong');
    now+=60*MIN;assert(klass(s,'q1')!=='at_capacity_healthy','stale capacity still healthy');
    assert(s.status().stale_claims.count===2,'both claims should be stale');
    s.cancel('q1');
    assert(s.status().stale_claims.count===2,'stale_claims must hold with an empty queue');
    assert(s.db.prepare("SELECT count(*) n FROM assignments WHERE status='claimed'").get().n===2,'claim was auto-reclaimed');
    s.db.close();
  }
  log('at_capacity_healthy, stale_claims with empty queue, no auto-reclaim');

  // transport_failing: no event ever got a 2xx
  {
    const s=fresh('transport');
    s.submit(payload('req_t'),'t','e','owner');
    now+=21*MIN;assert(klass(s,'req_t')==='transport_failing','transport_failing missing');
    assert(s.reannounceQueued().announced===0,'transport failure must not re-announce');
    s.db.close();
  }
  log('transport_failing is a separate path');

  // terminal 410 stays terminal
  {
    const s=fresh('terminal');
    s.submit(payload('req_410'),'t','e','owner');
    s.db.prepare("UPDATE notifications SET state='suppressed',last_error='HTTP 410' WHERE request_id='req_410'").run();
    const before=eventsFor(s,'req_410');
    now+=10*MIN;assert(s.reannounceQueued().announced===0,'announced after 410');
    now+=3*3600000;assert(s.reannounceQueued().announced===0&&eventsFor(s,'req_410')===before,'event recreated after terminal rejection');
    s.db.close();
  }
  log('410/413 suppressed event is never recreated');

  // flat queue re-wake: one event per subscription titled by the head, held back while one is pending and for
  // queue_rewake_ms (default 90 s) after one went out, suppressed with no free lane or no subscription
  {
    const s=fresh('coalesce');
    for(const id of ['q1','q2','q3']){s.submit(payload(id),'t','e','owner');deliver(s,id);}
    now+=90*1000;
    assert(s.reannounceQueued().announced===1,'first coalesced re-wake');
    const pending=s.db.prepare("SELECT request_id,body FROM notifications WHERE kind='event' AND state='pending'").all();
    assert(pending.length===1&&pending[0].request_id==='q1'&&JSON.parse(pending[0].body).data.title==='3 assignments queued (2 free lanes); claim oldest first via list_pending: liveness test','not one event titled by the first item');
    now+=30*MIN;assert(s.reannounceQueued().announced===0,'woke while an availability event was pending');
    const settle=()=>s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=? WHERE kind='event' AND state='pending'").run(s.stamp());
    settle();assert(s.reannounceQueued().announced===0,'woke right after a delivered wake');
    now+=90*1000;assert(s.reannounceQueued().announced===1,'no wake queue_rewake_ms after the last one');settle();
    // Changed deliberately for the backoff: past the window items are re-woken, at most once per queue_rewake_stale_ms (20 min).
    now+=2*3600000;assert(s.reannounceQueued().announced===1,'stale items not re-woken once rewakeStaleMs passed');settle();
    // each stale item has its own backoff: q2 and q3 were never woken past the window, so they follow q1 at the 90 s cadence
    for(const id of ['q2','q3']){now+=90*1000;assert(s.reannounceQueued().announced===1,`stale ${id} not re-woken`);settle();}
    now+=90*1000;assert(s.reannounceQueued().announced===0,'woke a stale item inside rewakeStaleMs');
    now+=20*MIN;assert(s.reannounceQueued().announced===1,'q1 not re-woken after rewakeStaleMs');settle();
    assert(s.status().unclaimed_after_reannounce.count===3,'items past the window not reported unclaimed');
    // no free lane for the subscription principal
    const c=fresh('suppress');
    for(const id of ['c1','c2','q']){c.submit(payload(id),'t','e','owner');deliver(c,id);}
    c.claim('c1','dot','local-principal',2);c.claim('c2','dot','local-principal',2);
    now+=30*MIN;assert(c.reannounceQueued().announced===0,'woke with no free lane');
    // no active subscription
    const n=new Store(join(home,'nosub.db'),{now:()=>now,random:()=>0.5,capacity:2,limits});
    n.submit(payload('x'),'t','e','owner');
    now+=30*MIN;assert(n.reannounceQueued().announced===0,'woke without subscription');
    for(const x of [s,c,n]) x.db.close();
  }
  log('coalesced, rate-limited and suppressed queue re-wake');

  // owner-note attention
  {
    const s=fresh('attention');
    s.submit(payload('req_n'),'t','e','owner');
    const acquisitionId='owner-note-run';
    const claim=s.claim('req_n','dot','local-principal',2,null,'dot',acquisitionId);
    assert(claim.guidance.includes('BLOCKED:')&&s.claim('req_n','dot','local-principal',2,null,'dot',acquisitionId).guidance,'claim guidance missing');
    assert(s.attention('local-principal').length===0,'attention before any note');
    s.note('req_n','first');s.note('req_n','second');
    assert(JSON.stringify(s.attention('local-principal'))===JSON.stringify([{request_id:'req_n',note_count:2}]),'attention missing');
    assert(s.attention('someone-else').length===0,'attention leaked to another subject');
    s.markNotesSeen('req_n','local-principal');
    assert(s.attention('local-principal').length===0,'attention not cleared by get');
    s.note('req_n','third');
    assert(s.attention('local-principal')[0].note_count===1,'attention after get');
    s.claim('req_n','dot','local-principal',2,null,'dot',acquisitionId);
    assert(s.attention('local-principal').length===0,'attention not cleared by duplicate claim');
    s.db.close();
  }
  log('owner-note attention for claimed assignments');

  // alerts
  await mkdir(join(home,'.config/dot-bridge'),{recursive:true});
  const received=[];
  ntfy=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;received.push({title:req.headers.title,body});res.writeHead(200).end('ok');});
  await new Promise(r=>ntfy.listen(0,'127.0.0.1',r));
  const alertsFile=join(home,'alerts.env');
  await writeFile(alertsFile,`NTFY_URL=http://127.0.0.1:${ntfy.address().port}/t\n`,{mode:0o600});
  process.env.DOT_BRIDGE_ALERTS_FILE=alertsFile;process.env.HOME=home;
  await writeFile(join(home,'.config/dot-bridge/limits.json'),JSON.stringify({pause_suspected_silence_ms:20*MIN,stale_claim_ms:45*MIN,max_claimed_outer_assignments:3}),{mode:0o600});
  {
    const s=fresh('alerts');
    s.submit(payload('a1'),'t','e','owner');s.submit(payload('a2'),'t','e','owner');deliver(s,'a1');deliver(s,'a2');
    now+=47*MIN;
    await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(!received.some(x=>x.body.startsWith('pause_suspected:')),'pause suspicion paged before 30 observed minutes');
    now+=30*MIN;await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    const pause=received.filter(x=>x.body.startsWith('pause_suspected:'));
    assert(pause.length===1,'pause_suspected alert count');
    assert(pause[0].body==='pause_suspected: no worker tool call for 77 min while 2 assignments are queued (0 of 2 slots claimed). Pause cause unconfirmed.','pause_suspected text: '+pause[0].body);
    assert(!pause[0].body.includes('liveness test'),'assignment text in alert');
    s.recordWorkerCall('local-principal','list_pending');
    await checkAlerts(s,()=>{});
    assert(received.some(x=>x.title==='Dalan recovered'&&x.body==='pause_suspected resolved'),'pause_suspected recovery missing');
    s.cancel('a1');s.cancel('a2');
    const c=s.claim.bind(s);s.submit(payload('a3'),'t','e','owner');c('a3','dot','local-principal',2);
    now+=50*MIN;await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(!received.some(x=>x.body.startsWith('stale_claims:')),'stale claims paged before 30 observed minutes');
    now+=30*MIN;await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    const stale=received.filter(x=>x.body.startsWith('stale_claims:'));
    assert(stale.length===1&&/idle up to 80 min \(1 of 2 slots claimed\)/.test(stale[0].body),'stale_claims alert: '+stale[0]?.body);
    // Test note alerts on a fresh grant; a3's persisted lease expired during the stale-claim scenario.
    s.submit(payload('denial'),'t','e','owner');
    const claim=s.claim('denial','dot','local-principal',2).claim_id;
    s.progress('denial',claim,'Auto-review denied git push token ' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789' + ' Bearer ' + ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJl'].join('.') + ' and then a very long trailing explanation of everything that happened',  'local-principal');
    const logged=[],logTo=entry=>logged.push(entry);
    await checkAlerts(s,logTo);await checkAlerts(s,logTo);
    assert(!received.some(x=>x.body.startsWith('denial_mentioned:')),'denial_mentioned paged ntfy; it must be log-only');
    const denial=logged.filter(x=>x.kind==='alert'&&x.message.startsWith('denial_mentioned:'));
    assert(denial.length===1,'denial alert not deduplicated');
    const quoted=denial[0].message.match(/"([^"]*)"/)[1];
    assert(quoted.length<=80&&!/ghp_abc|Bearer eyJ/.test(denial[0].message),'denial alert leaks token or exceeds 80 chars: '+denial[0].message);
    s.progress('denial',claim,'routine update, nothing to see','local-principal');
    await checkAlerts(s,logTo);
    assert(logged.filter(x=>x.kind==='alert'&&x.message.startsWith('denial_mentioned:')).length===1,'benign note raised denial alert');
    // Alert notes have no generic hex rule: a commit hash stays readable.
    assert(redactNote('0123456789abcdef'.repeat(2) + '0123 ok')==='0123456789abcdef'.repeat(2) + '0123 ok','hex changed');
    s.db.close();
  }
  log('named alerts, recovery, denial_mentioned log-only, dedup and redaction');

  // migration idempotence on reopen
  { const s=new Store(join(home,'alerts.db'));assert(s.db.prepare('PRAGMA user_version').get().user_version>=13,'migration version');s.db.close();new Store(join(home,'alerts.db')).db.close(); }
  log('migration reopens cleanly');

  // ---- server level: guidance and attention in tool results, activity recorded
  const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS:'1',DOT_BRIDGE_T3_DRY_RUN:'1'};
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let out='';service.stdout.on('data',b=>out+=b);service.stderr.on('data',b=>process.stderr.write(b));
  for(let i=0;i<100&&!out.includes('MCP listening');i++) await sleep(100);
  assert(out.includes('MCP listening'),'server did not start');
  const secret=(await readFile(join(home,'.config/dot-bridge/env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc=async(method,params={})=>(await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})})).json();
  const tool=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});if(r.result.isError) throw new Error(r.result.content[0].text);return JSON.parse(r.result.content[0].text);};
  const srvId='req_'+randomUUID();
  const side=new Store(join(home,'.local/share/dot-bridge/bridge.db'));
  side.submit(payload(srvId),'t','e','owner');
  const listed=await tool('list_pending',{});
  assert(listed.assignments.some(x=>x.request_id===srvId)&&Array.isArray(listed.attention)&&listed.attention.length===0,'list_pending result shape');
  assert(listed.free_lanes===3&&listed.guidance.includes('up to free_lanes')&&listed.guidance.includes('Do not claim one and stop'),'list_pending free_lanes/guidance: '+JSON.stringify(listed));
  const claimed=await tool('claim',{request_id:srvId,claimant:'dot'});
  assert(claimed.guidance.startsWith('If auto-review or Guardian denies'),'claim guidance missing');
  assert(claimed.guidance.includes('credential input field is ordinary UI work')&&claimed.guidance.includes('revealing, copying, changing or transmitting actual secret values'),'credential-input context missing from claim guidance');
  assert(claimed.guidance===`${side.guidanceFor('dot')} If free_lanes > 0 and work is queued, claim more now.`,'claim guidance: '+claimed.guidance);
  assert(claimed.guidance.includes('acquisition_id')&&claimed.guidance.includes('saved run state'),'legacy acquisition guidance missing');
  assert(claimed.free_lanes===2&&claimed.queued_after_claim===0,'claim lane fields: '+JSON.stringify({free_lanes:claimed.free_lanes,queued:claimed.queued_after_claim}));
  side.note(srvId,'please use the other branch');
  const again=await tool('list_pending',{});
  assert(again.attention.length===1&&again.attention[0].request_id===srvId&&again.attention[0].note_count===1,'attention missing in list_pending');
  const got=await tool('get',{request_id:srvId});
  assert(got.guidance.includes('owner_notes')&&got.owner_notes.length===1,'get guidance or notes missing');
  assert((await tool('list_pending',{})).attention.length===0,'attention not cleared by get');
  await tool('progress',{request_id:srvId,claim_id:claimed.claim_id,note:'still going'});
  const status=side.status();
  assert(status.last_worker_call_at&&status.last_list_pending_at&&status.claimed_outer_count===1&&status.oldest_claim_progress_age_ms!==null,'server did not record activity');
  const cli=await new Promise(r=>{const c=spawn(process.execPath,['bin/dot-worker.mjs','status','--json'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});let t='';c.stdout.on('data',b=>t+=b);c.on('close',()=>r(JSON.parse(t)));});
  assert(cli.claimed_outer_count===1&&cli.max_claimed_outer_assignments>=1&&'oldest_unclaimed_event_2xx_age_ms' in cli&&cli.queue_classes&&cli.stale_claims,'dot-worker status --json lacks liveness fields');
  log('server: guidance, attention, lane hints and activity recording');

  // ---- server level: lane hints track queued work and the caller's claims
  const laneIds=[1,2].map(i=>`req_lane_${i}_${randomUUID()}`);
  for(const id of laneIds) side.submit(payload(id),'t','e','owner');
  const more=await tool('list_pending',{});
  assert(more.free_lanes===2,'free_lanes with one claim held');
  const next=await tool('claim',{request_id:laneIds[0],claimant:'dot'});
  assert(next.queued_after_claim===1&&next.free_lanes===1,'claim lane fields: '+JSON.stringify({free_lanes:next.free_lanes,queued:next.queued_after_claim}));
  assert(next.next_queued?.length===1&&next.next_queued[0].request_id===laneIds[1]&&/^1 queued and 1 lane free: claim /.test(next.next_action),'claim next_queued: '+JSON.stringify({q:next.next_queued,a:next.next_action}));
  log('server: lane hints after a second claim');

  // finish names the next queued item and tells the lane to claim it before its run ends
  const third=`req_lane_3_${randomUUID()}`;side.submit(payload(third),'t','e','owner');
  const done=await tool('finish',{request_id:laneIds[0],claim_id:next.claim_id,outcome:'completed',summary:'done',result:'ok'});
  assert(done.next_queued?.[0]?.request_id===laneIds[1],'finish next_queued: '+JSON.stringify(done));
  assert(done.guidance.includes(`Claim ${laneIds[1]} yourself before you end this run`)&&done.guidance.includes('list_pending')&&done.guidance.includes('assignment_expired'),'finish guidance: '+done.guidance);
  const quiet=await tool('finish',{request_id:srvId,claim_id:claimed.claim_id,outcome:'completed',summary:'done',result:'ok'});
  assert(quiet.next_queued?.length>0&&quiet.guidance.includes('list_pending'),'second finish guidance: '+JSON.stringify(quiet));
  log('server: finish carries next_queued and claim-it-yourself guidance');

  side.db.close();
  log('liveness e2e');
} catch(error) {console.error(`FAIL ${error.stack||error}`);process.exitCode=1;}
finally {if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}if(ntfy)await new Promise(r=>ntfy.close(r));await rm(home,{recursive:true,force:true});}
