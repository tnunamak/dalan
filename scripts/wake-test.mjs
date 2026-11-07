#!/usr/bin/env node
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
// Flat queue re-wake: one availability event per subscription per tick, at most every queue_rewake_ms, only with a free
// lane and an eligible queued item; the time-based unclaimed report and its alert; the list_pending/claim lane hints.
// Store level with an injected clock.
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { checkAlerts } from '../src/alerts.mjs';
import { explainStatus } from '../src/status-evidence.mjs';

const home=await mkdtemp(join(tmpdir(),'dalan-bridge-wake-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const SEC=1000,MIN=60000,HOUR=3600000,key=`whsec_${randomBytes(32).toString('base64')}`;
const payload=(id,brief=`wake test ${id}`)=>({schema_version:1,request_id:id,brief,inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'read-only'});
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:1000*HOUR,laneCapacity:6,rewakeMs:90*SEC,rewakeWindowMs:2*HOUR,rewakeStaleMs:20*MIN};
let now=Date.parse('2026-10-09T00:00:00.000Z'),ntfy=null;
const fresh=(name,options={})=>{const s=new Store(join(home,`${name}.db`),{now:()=>now,capacity:6,limits,...options});s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+480*HOUR).toISOString());return s;};
// Settles every open event the way drain would: started now, delivered.
const deliverAll=s=>s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=COALESCE(attempt_started_at,?) WHERE kind='event' AND state IN ('pending','sending','failed')").run(s.stamp());
const tick=s=>s.reannounceQueued(limits).announced;
const pending=s=>s.db.prepare("SELECT request_id,body FROM notifications WHERE kind='event' AND state='pending' ORDER BY rowid").all().map(r=>({request_id:r.request_id,title:JSON.parse(r.body).data.title,data:JSON.parse(r.body).data}));
const submit=(s,...ids)=>{for(const id of ids) s.submit(payload(id),'t','e','owner');};
try {
  // one wake per tick regardless of queue size, no wake within queue_rewake_ms of the last delivered event
  {
    const s=fresh('cadence');
    submit(s,'q1','q2','q3','q4','q5');deliverAll(s);
    const before=s.db.prepare('SELECT count(*) n FROM notifications').get().n;
    now+=90*SEC-1;assert(tick(s)===0,'woke before queue_rewake_ms');
    now+=1;assert(tick(s)===1,'no wake at queue_rewake_ms');
    const p=pending(s);
    assert(p.length===1&&p[0].request_id==='q1','not one wake naming the head: '+JSON.stringify(p));
    assert(p[0].title==='5 assignments queued (6 free lanes); claim oldest first via list_pending: wake test q1'&&JSON.stringify(Object.keys(p[0].data))==='["request_id","title"]','wake title or payload shape: '+JSON.stringify(p[0].data));
    assert(s.db.prepare('SELECT count(*) n FROM notifications').get().n===before+1,'more than one event per tick');
    assert(tick(s)===0&&tick(s)===0,'woke while a wake was pending');
    deliverAll(s);
    now+=89*SEC;assert(tick(s)===0,'woke within queue_rewake_ms of a delivered re-wake');
    now+=1*SEC;assert(tick(s)===1&&pending(s).length===1,'second wake missing');
    deliverAll(s);
    // a new assignment's own submit event counts as a wake
    now+=60*SEC;submit(s,'q6');deliverAll(s);
    now+=60*SEC;assert(tick(s)===0,'woke within queue_rewake_ms of a delivered submit event');
    now+=30*SEC;assert(tick(s)===1,'no wake after the submit event aged out');
    // a sending wake counts too
    const sending=s.db.prepare("SELECT id FROM notifications WHERE kind='event' AND state='pending'").get().id;
    const started=s.startAttempt(sending,null);
    now+=10*MIN;assert(tick(s)===0,'woke while a wake was sending');
    s.finishAttempt(sending,started.attempt_id,'delivered');
    // the wake time is the attempt start, so a delivery that started 10 min ago no longer holds the next wake back
    assert(tick(s)===1,'no wake after a delivery that started queue_rewake_ms ago');
    assert(s.db.prepare('SELECT count(*) n FROM assignment_reannouncements').get().n===0,'per-item trackers written');
    s.db.close();
  }
  log('one wake per tick for any queue size; none within queue_rewake_ms of a delivered or sending event, submit events included');

  // a single item: title is the brief
  {
    const s=fresh('single');submit(s,'only');deliverAll(s);now+=2*MIN;
    assert(tick(s)===1&&pending(s)[0].title==='wake test only','single-item title');
    const long=fresh('long');long.submit(payload('L','x'.repeat(300)),'t','e','owner');submit(long,'M');deliverAll(long);now+=2*MIN;
    assert(tick(long)===1&&pending(long)[0].title.length===160&&pending(long)[0].title.startsWith('2 assignments queued (6 free lanes); claim oldest first via list_pending: xxx'),'title not capped at 160');
    s.db.close();long.db.close();
  }
  log('wake title: the brief alone, or "N assignments queued (F free lanes); claim oldest first via list_pending: <brief>" within 160 characters');

  // a suppressed wake did not wake anyone: the next tick wakes again
  {
    const s=fresh('suppressed');submit(s,'A','B');deliverAll(s);
    now+=2*MIN;assert(tick(s)===1&&pending(s)[0].request_id==='A','first wake');
    s.cancel('A'); // suppresses A's pending wake
    assert(tick(s)===1&&pending(s)[0].request_id==='B','no wake after the head wake was suppressed');
    // suppressed at send time (subscription inactive): the attempt was 'sending', then suppressed
    const id=s.db.prepare("SELECT id FROM notifications WHERE kind='event' AND state='pending'").get().id,started=s.startAttempt(id,null);
    s.finishAttempt(id,started.attempt_id,'suppressed','subscription inactive');
    assert(tick(s)===1,'a wake suppressed before any send counted as a wake');
    // a failed assignment wake is being retried (same id, at most a minute apart): that retry is the wake, so no second one
    const failed=s.db.prepare("SELECT id FROM notifications WHERE kind='event' AND state='pending'").get().id,f=s.startAttempt(failed,null);
    s.finishAttempt(failed,f.attempt_id,'failed','HTTP 500');
    now+=10*MIN;assert(tick(s)===0,'second wake queued beside a retrying assignment wake');
    s.db.close();
  }
  log('a suppressed wake does not count; a failed assignment wake is retried instead of doubled');

  // only assignment wake traffic holds re-wake back: a failed message or owner-note event never does
  {
    const s=fresh('unrelated-failed');submit(s,'F');deliverAll(s);
    const fail=id=>{const st=s.startAttempt(id,null);s.finishAttempt(id,st.attempt_id,'failed','HTTP 422');};
    s.tell('a lightweight message');fail(s.db.prepare("SELECT id FROM notifications WHERE wake_kind='message'").get().id);
    const c=s.claim('F','dot','local-principal',6);s.note('F','owner note');fail(s.db.prepare("SELECT id FROM notifications WHERE wake_kind='owner_note'").get().id);
    s.abandon('F');deliverAll(s);s.db.prepare("UPDATE notifications SET state='failed' WHERE wake_kind IN ('message','owner_note')").run();
    now+=2*MIN;assert(tick(s)===1&&pending(s)[0].request_id==='F','a failed message or owner-note event blocked re-wake');
    assert(c.claim_id,'claim');
    // a delivered owner note does count as a wake for the gap
    deliverAll(s);s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=? WHERE wake_kind IN ('message','owner_note')").run(s.stamp());
    now+=60*SEC;s.note('F','second note');s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=? WHERE wake_kind='owner_note' AND state='pending'").run(s.stamp());
    now+=60*SEC;assert(tick(s)===0,'woke within queue_rewake_ms of a delivered owner note');
    now+=30*SEC;assert(tick(s)===1,'no wake after the owner note aged out');
    s.db.close();
  }
  log('failed message and owner-note events never block re-wake; a delivered owner note counts as a wake');

  // an owner-note event for the head is no assignment wake: it never stands in for the re-wake or the requeue event
  {
    const s=fresh('note-not-wake');submit(s,'N');deliverAll(s);
    now+=SEC;s.note('N','owner note');s.db.prepare("UPDATE notifications SET state='failed' WHERE wake_kind='owner_note'").run();
    now+=2*MIN;assert(tick(s)===1&&s.db.prepare("SELECT count(*) n FROM notifications WHERE wake_kind='rewake' AND state='pending'").get().n===1,'a failed owner note stood in for the re-wake');
    deliverAll(s);s.claim('N','dot','local-principal',6);now+=SEC;s.note('N','another note');now+=SEC;s.abandon('N');
    assert(s.db.prepare("SELECT count(*) n FROM notifications WHERE wake_kind='submit' AND state='pending'").get().n===1,'a pending owner note stood in for the requeue event');
    s.db.close();
  }
  log('an owner-note event never stands in for a re-wake or a requeue event');

  // eligibility is checked again at send time: drain may send a queued re-wake much later
  {
    const prep=(name,options)=>{const s=fresh(name,options);submit(s,'A','B');deliverAll(s);now+=2*MIN;assert(tick(s)===1&&pending(s)[0].request_id==='A','prep wake');
      return [s,s.db.prepare("SELECT * FROM notifications WHERE wake_kind='rewake' AND state='pending'").get()];};
    const notSent=(s,row,why)=>{assert(s.startAttempt(row.id,null)===null,`stale re-wake sent (${why})`);const r=s.db.prepare('SELECT state,last_error,attempts FROM notifications WHERE id=?').get(row.id);
      assert(r.state==='suppressed'&&r.last_error===`re-wake not sent: ${why}`&&r.attempts===0,'stale re-wake row: '+JSON.stringify(r));};
    let [s,row]=prep('stale-uncertain');
    s.db.prepare("INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES('evt_owner_A','t3','A','uncertain',?)").run(s.stamp());
    notSent(s,row,'head no longer eligible');
    assert(tick(s)===1&&pending(s)[0].request_id==='B','next tick did not pick a new head after the stale wake');
    s.db.close();
    [s,row]=prep('stale-claimed');s.claim('A','dot','local-principal',6);notSent(s,row,'head no longer eligible');
    assert(tick(s)===1&&pending(s)[0].request_id==='B','no new head after the head was claimed');s.db.close();
    [s,row]=prep('stale-lane',{capacity:1});s.claim('B','dot','local-principal',1);notSent(s,row,'no free lane');
    assert(tick(s)===0,'woke with no free lane after the stale wake');s.db.close();
    [s,row]=prep('stale-terminal');
    s.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,state,last_error,created_at,wake_kind) VALUES('evt_rej_A','event','A','sub_a','suppressed','HTTP 410',?,'submit')").run(new Date(now-1).toISOString());
    s.db.prepare("UPDATE notifications SET created_at=? WHERE id=?").run(new Date(now-2).toISOString(),row.id);
    notSent(s,row,'head no longer eligible');s.db.close();
    // Changed deliberately for the backoff: past the window a queued re-wake is still sent when no wake for the item went out
    // in the last rewakeStaleMs, and suppressed (head no longer eligible) when one did.
    [s,row]=prep('window-sent');now+=2*HOUR;assert(s.startAttempt(row.id,null),'window-aged re-wake with no recent wake was suppressed');s.db.close();
    [s,row]=prep('window-backoff');now+=2*HOUR;
    s.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,state,created_at,attempt_started_at,wake_kind) VALUES('evt_recent_A','event','A','sub_a','delivered',?,?,'rewake')").run(new Date(now-1).toISOString(),new Date(now-MIN).toISOString());
    notSent(s,row,'head no longer eligible');s.db.close();
    [s,row]=prep('stale-subscription');s.db.prepare("UPDATE subscriptions SET expires_at=?").run(new Date(now-1).toISOString());notSent(s,row,'subscription inactive');s.db.close();
    // a still-eligible retry keeps its frozen id and body
    [s,row]=prep('retry');
    let st=s.startAttempt(row.id,null);s.finishAttempt(row.id,st.attempt_id,'failed','HTTP 500');
    s.db.prepare('UPDATE notifications SET next_at=0').run();now+=5*MIN;
    st=s.startAttempt(row.id,null);
    assert(st&&st.id===row.id&&st.body===row.body&&s.db.prepare('SELECT body FROM notifications WHERE id=?').get(row.id).body===row.body,'eligible retry changed id or body');
    s.db.close();
  }
  log('a re-wake that went stale after it was queued (head claimed or uncertain, lane filled, backoff, terminal, subscription) is suppressed unsent; an eligible retry keeps id and body');

  // an owner note never clears a terminal 410/413 exclusion
  {
    const s=fresh('terminal-note');submit(s,'R');
    s.db.prepare("UPDATE notifications SET state='suppressed',last_error='HTTP 410' WHERE request_id='R'").run();
    s.db.prepare("UPDATE assignments SET status='claimed' WHERE request_id='R'").run();s.note('R','note');s.db.prepare("UPDATE assignments SET status='queued' WHERE request_id='R'").run();
    s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=? WHERE wake_kind='owner_note'").run(s.stamp());
    for(let i=0;i<3;i++){now+=10*MIN;assert(tick(s)===0,`owner note cleared the 410 exclusion (${i})`);}
    s.db.close();
  }
  log('an owner note after a 410/413 does not make the item eligible again');

  // free lanes: never wake with none, resume when one frees
  {
    const s=fresh('lanes-zero',{capacity:2});
    submit(s,'c1','c2','q');deliverAll(s);
    const c1=s.claim('c1','dot','local-principal',2);s.claim('c2','dot','local-principal',2);
    for(let i=0;i<5;i++){now+=20*MIN;assert(tick(s)===0,`woke with no free lane (${i})`);}
    s.finish('c1',c1.claim_id,'completed','done','data','local-principal');
    assert(tick(s)===1&&pending(s)[0].request_id==='q','no wake once a lane freed');
    s.db.close();
    // lane capacity bounds it too, and only the subscription principal's claims count
    const l=fresh('lanes-capacity');
    submit(l,'k1','k2');deliverAll(l);
    l.claim('k1','other','someone-else',6);
    now+=2*MIN;assert(l.reannounceQueued({...limits,laneCapacity:1}).announced===1,'another subject used the principal\'s lane');
    deliverAll(l);l.abandon('k1');
    const prior=l.db.prepare('SELECT * FROM claims WHERE request_id=?').get('k1');
    let earlyError;
    try {l.claim('k1','dot','local-principal',6);} catch(error) {earlyError=error;}
    assert(earlyError?.message==='claim_busy: prior lease has not expired','abandoned claim was reclaimed before its lease expired');
    const unchanged=l.db.prepare('SELECT claim_id,last_claim_activity_at FROM claims WHERE request_id=?').get('k1');
    assert(unchanged.claim_id===prior.claim_id&&unchanged.last_claim_activity_at===prior.last_claim_activity_at,'early regrant changed the grant');
    l.db.prepare('UPDATE claims SET last_claim_activity_at=?,lease_deadline_at=?,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?').run(new Date(now-limits.leaseMs-1).toISOString(),new Date(now-1).toISOString(),'k1');
    l.claim('k1','dot','local-principal',6);deliverAll(l);
    now+=2*MIN;assert(l.reannounceQueued({...limits,laneCapacity:1}).announced===0,'woke above worker_lane_capacity');
    assert(l.reannounceQueued({...limits,laneCapacity:2}).announced===1,'no wake with a free lane under worker_lane_capacity');
    l.db.close();
  }
  log('no wake while free_lanes = 0 for the subscription principal; resumes when a lane frees');

  // uncertain or sending owner delivery excludes the item; 410/413 terminal excludes it
  {
    const s=fresh('uncertain');submit(s,'U','V');deliverAll(s);
    const owner=(id,state)=>s.db.prepare("INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES(?,?,?,?,?)").run(`evt_owner_${id}_${state}`,'t3',id,state,s.stamp());
    owner('U','uncertain');
    now+=2*MIN;assert(tick(s)===1&&pending(s)[0].request_id==='V','uncertain head not skipped');
    deliverAll(s);owner('V','sending');
    now+=2*MIN;assert(tick(s)===0,'woke with only uncertain or sending items');
    s.db.close();
    const t=fresh('terminal');submit(t,'R','S','T');
    const reject=(id,error)=>t.db.prepare("UPDATE notifications SET state='suppressed',last_error=? WHERE kind='event' AND request_id=?").run(error,id);
    deliverAll(t);reject('R','HTTP 410');
    now+=2*MIN;assert(tick(t)===1&&pending(t)[0].request_id==='S'&&pending(t)[0].title.startsWith('2 assignments'),'410 item not excluded: '+JSON.stringify(pending(t)));
    // the callback rejects the re-wake itself with 413: the next head is woken at once, S never again
    const id=t.db.prepare("SELECT id FROM notifications WHERE kind='event' AND state='pending'").get().id,started=t.startAttempt(id,null);
    t.finishAttempt(id,started.attempt_id,'suppressed','HTTP 413');
    assert(tick(t)===1&&pending(t)[0].request_id==='T'&&pending(t)[0].title==='wake test T','413 item not excluded');
    deliverAll(t);reject('T','HTTP 410');
    for(let i=0;i<3;i++){now+=10*MIN;assert(tick(t)===0,`woke with only terminal items (${i})`);}
    t.db.close();
  }
  log('uncertain/sending owner delivery and 410/413-terminal items are never re-woken');

  // head order is list_pending order: normal before background, then oldest; background is named once the normal item is not eligible
  {
    const s=fresh('order');
    s.submit(payload('bg_old'),'t','e','owner',false,null,'background');now+=SEC;
    s.submit(payload('n_new'),'t','e','owner');deliverAll(s);
    now+=2*MIN;assert(tick(s)===1&&pending(s)[0].request_id==='n_new'&&pending(s)[0].title.endsWith(': wake test n_new'),'head is not the normal item: '+JSON.stringify(pending(s)));
    deliverAll(s);
    s.db.prepare("INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES('evt_o','t3','n_new','uncertain',?)").run(s.stamp());
    now+=2*MIN;assert(tick(s)===1&&pending(s).at(-1).request_id==='bg_old'&&pending(s).at(-1).title==='wake test bg_old','background is named when the normal item is ineligible');
    s.db.close();
  }
  log('head follows list_pending order: normal before background, then oldest');

  // the window: items queued longer than queue_rewake_window_ms stop being re-woken and are reported, with the alert
  {
    const received=[];
    ntfy=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;received.push({title:req.headers.title,body});res.writeHead(200).end('ok');});
    await new Promise(r=>ntfy.listen(0,'127.0.0.1',r));
    await mkdir(join(home,'.config/dot-bridge'),{recursive:true});
    await writeFile(join(home,'alerts.env'),`NTFY_URL=http://127.0.0.1:${ntfy.address().port}/t\n`,{mode:0o600});
    await writeFile(join(home,'.config/dot-bridge/limits.json'),JSON.stringify({assignment_reannounce_interval_ms:120000,assignment_reannounce_max_count:10}),{mode:0o600});
    process.env.DOT_BRIDGE_ALERTS_FILE=join(home,'alerts.env');process.env.HOME=home;
    const s=fresh('window');
    const created=now;s.submit(payload('stuck','do not leak this brief'),'t','e','owner');deliverAll(s);
    let wakes=0;
    while(now+90*SEC<created+2*HOUR){now+=90*SEC;wakes+=tick(s);deliverAll(s);}
    assert(wakes===Math.floor((2*HOUR-1)/(90*SEC)),`wakes inside the window: ${wakes}`);
    assert(s.status({limits}).unclaimed_after_reannounce.count===0,'unclaimed inside the window');
    await checkAlerts(s,()=>{});
    assert(!received.some(x=>x.body.startsWith('unclaimed_queued:')),'alert inside the window');
    // past the window the item stays eligible but backs off: one re-wake per rewakeStaleMs, counted from its last delivered wake
    now=created+2*HOUR;assert(tick(s)===0,'woke at the window edge, inside rewakeStaleMs of its last wake');
    const lastWake=Date.parse(s.db.prepare("SELECT max(attempt_started_at) at FROM notifications WHERE request_id='stuck' AND state='delivered'").get().at);
    now=lastWake+20*MIN-1;assert(tick(s)===0,'stale item re-woken before rewakeStaleMs');
    now+=1;assert(tick(s)===1&&pending(s)[0].request_id==='stuck','stale item not re-woken after rewakeStaleMs');
    assert(pending(s)[0].title==='wake test stuck'.replace('wake test stuck','do not leak this brief'),'single stale item title');
    deliverAll(s);
    for(let i=0;i<3;i++){now+=20*MIN-1;assert(tick(s)===0,`stale item re-woken early (${i})`);now+=1;assert(tick(s)===1,`stale item not re-woken (${i})`);deliverAll(s);}
    now+=4*HOUR;
    const st=s.status({limits});
    assert(st.unclaimed_after_reannounce.count===1&&JSON.stringify(st.unclaimed_after_reannounce.request_ids)==='["stuck"]'&&st.unclaimed_after_reannounce.oldest_age_ms===now-created,'unclaimed_after_reannounce shape: '+JSON.stringify(st.unclaimed_after_reannounce));
    assert(s.db.prepare("SELECT status FROM assignments WHERE request_id='stuck'").get().status==='queued','window changed assignment status');
    assert(/ queued=1 unclaimed=1 normal=/.test(explainStatus(st)),'explain lacks unclaimed=1: '+explainStatus(st));
    assert(!/unclaimed=/.test(explainStatus({...st,unclaimed_after_reannounce:{count:0}})),'explain shows unclaimed=0');
    await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(!received.some(x=>x.body.startsWith('unclaimed_queued:')),'unclaimed condition paged before 30 minutes');
    now+=30*MIN;await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    const alerts=received.filter(x=>x.body.startsWith('unclaimed_queued:'));
    assert(alerts.length===1&&alerts[0].title==='Dalan attention','unclaimed_queued alert count: '+alerts.length);
    assert(alerts[0].body.startsWith(`unclaimed_queued: 1 queued assignments outlived the 120 min re-wake window without a claim (oldest queued ${Math.round((now-created)/MIN)} min, 0 of 6 slots claimed). They are re-woken at most every 20 min;`),'alert text: '+alerts[0].body);
    assert(!alerts[0].body.includes('leak')&&!alerts[0].body.includes('stuck'),'alert leaks assignment text or id');
    // an uncertain item is waiting for reconcile, not for the worker: not unclaimed
    s.submit(payload('unsure'),'t','e','owner');s.db.prepare("INSERT INTO notifications(id,kind,request_id,state,created_at) VALUES('evt_unsure','t3','unsure','uncertain',?)").run(s.stamp());
    now+=3*HOUR;assert(s.status({limits}).unclaimed_after_reannounce.count===1,'uncertain item counted as unclaimed');
    let cancelError;try{s.cancel('unsure');}catch(error){cancelError=error;}
    assert(cancelError?.message.includes('uncertain_delivery'),'uncertain result delivery must be reconciled before cancellation');
    // requeue after abandon resets the window: claimed late, abandoned, woken again, no longer unclaimed
    s.claim('stuck','dot','local-principal',6);
    assert(s.status({limits}).unclaimed_after_reannounce.count===0,'claimed item counted as unclaimed');
    now+=HOUR;s.abandon('stuck');deliverAll(s);
    assert(s.status({limits}).unclaimed_after_reannounce.count===0,'requeued item counted as unclaimed');
    now+=90*SEC;assert(tick(s)===1&&pending(s)[0].request_id==='stuck','requeue did not restart the window');
    await checkAlerts(s,()=>{});await checkAlerts(s,()=>{});
    assert(received.filter(x=>x.title==='Dalan recovered'&&x.body==='unclaimed_queued resolved').length===1,'recovery notice missing or duplicated');
    s.db.close();
  }
  log('items past queue_rewake_window_ms back off to one re-wake per queue_rewake_stale_ms, show as unclaimed (time-based) with one alert and recovery; requeue restarts the window');

  // backoff past the window with several items: the head is the oldest eligible item, the text counts free lanes, and the
  // 90 s cadence still holds for items inside the window
  {
    const s=fresh('stale');
    submit(s,'old1');deliverAll(s);
    // old1 turns stale at +2 h with its last wake long past; mid arrives inside its own window
    now+=3*HOUR;submit(s,'mid');deliverAll(s);now+=90*SEC;
    assert(tick(s)===1,'no wake with a due stale item and a fresh one');
    let p=pending(s);
    assert(p.length===1&&p[0].request_id==='old1'&&p[0].title==='2 assignments queued (6 free lanes); claim oldest first via list_pending: wake test old1','oldest head and lane count: '+JSON.stringify(p));
    deliverAll(s);
    // old1 was just woken and is stale: only mid (inside the window) is eligible, at the 90 s cadence
    now+=90*SEC-1;assert(tick(s)===0,'woke inside the 90 s cadence');
    now+=1;assert(tick(s)===1,'no wake for the in-window item');
    p=pending(s);assert(p.length===1&&p[0].request_id==='mid'&&p[0].title==='wake test mid','stale item named while backing off: '+JSON.stringify(p));
    deliverAll(s);
    // free lanes in the text: two lanes taken
    submit(s,'c1','c2','c3');s.claim('c1','dot','local-principal',2);s.claim('c2','dot','local-principal',2);
    deliverAll(s);now+=90*SEC;
    assert(tick(s)===1&&/ \(4 free lanes\); /.test(pending(s)[0].title),'free lane count: '+JSON.stringify(pending(s)));
    s.db.close();
  }
  log('past the window the head is the oldest eligible item, the wake text counts free lanes, a freshly woken stale item waits out rewakeStaleMs');

  // pause and no active subscription suppress
  {
    const s=fresh('pause');submit(s,'p');deliverAll(s);
    s.setPause('maintenance');now+=10*MIN;assert(tick(s)===0,'woke while paused');
    s.setPause(null);assert(tick(s)===1,'no wake after resume');
    deliverAll(s);s.unsubscribe('sub_a');now+=10*MIN;assert(tick(s)===0,'woke without an active subscription');
    s.db.close();
    const n=new Store(join(home,'nosub.db'),{now:()=>now,capacity:6,limits});submit(n,'x');now+=HOUR;
    assert(n.reannounceQueued(limits).announced===0,'woke with no subscription');
    n.db.close();
  }
  log('pause and no active subscription suppress re-wake');

  // sending and settling a re-wake changes no other row
  {
    const s=fresh('isolation');submit(s,'i1','i2','i3');
    const settle=s.db.prepare("SELECT id FROM notifications WHERE request_id='i2'").get().id,st=s.startAttempt(settle,null);s.finishAttempt(settle,st.attempt_id,'delivered');
    const fail=s.db.prepare("SELECT id FROM notifications WHERE request_id='i3'").get().id,sf=s.startAttempt(fail,null);s.finishAttempt(fail,sf.attempt_id,'suppressed','HTTP 410');
    s.db.prepare("UPDATE notifications SET state='delivered' WHERE request_id='i1'").run();
    const snapshot=()=>JSON.stringify(s.db.prepare('SELECT * FROM notifications ORDER BY rowid').all());
    const assignments=()=>JSON.stringify(s.db.prepare('SELECT * FROM assignments ORDER BY request_id').all());
    const rows=snapshot(),a=assignments(),count=s.db.prepare('SELECT count(*) n FROM notifications').get().n;
    now+=2*MIN;assert(tick(s)===1,'isolation wake');
    const id=s.db.prepare("SELECT id FROM notifications WHERE kind='event' AND state='pending'").get().id;
    const others=()=>JSON.stringify(s.db.prepare('SELECT * FROM notifications WHERE id<>? ORDER BY rowid').all(id));
    assert(others()===rows,'queueing a re-wake changed another notification row');
    const started=s.startAttempt(id,null);s.finishAttempt(id,started.attempt_id,'delivered');
    assert(others()===rows&&assignments()===a&&s.db.prepare('SELECT count(*) n FROM notifications').get().n===count+1,'settling a re-wake changed another row');
    assert(s.db.prepare('SELECT covers FROM notifications WHERE id=?').get(id).covers===null,'re-wake wrote covers');
    s.db.close();
  }
  log('a re-wake is one ordinary event: sending or settling it changes no other notification or assignment row');

  // list_pending/claim lane hints
  {
    const s=fresh('lane-hints');
    submit(s,'l1','l2','l3','l4');
    assert(JSON.stringify(s.laneState('local-principal','dot',6,10))==='{"free_lanes":6,"queued":4}','lane state before claims');
    s.claim('l1','dot','local-principal',10);s.claim('l2','dot','local-principal',10);
    assert(JSON.stringify(s.laneState('local-principal','dot',6,10))==='{"free_lanes":4,"queued":2}','lane state after two claims');
    assert(s.laneState('local-principal','dot',6,3).free_lanes===1,'free_lanes exceeds the claim cap');
    assert(s.laneState('someone-else','dot',6,10).free_lanes===6,'free_lanes counts another subject');
    assert(s.laneState('local-principal','dot',2,10).free_lanes===0,'free_lanes negative');
    s.db.close();
  }
  log('lane state: free_lanes bounded by lane capacity and claim cap, per subject');
  // migration 23 on a v22 database: old rows get covers NULL (the column stays, unused), claims keep working
  {
    const file=join(home,'v22.db');
    let s=new Store(file,{now:()=>now,limits});
    s.submit(payload('m1'),'t','e','owner');s.submit(payload('m2'),'t','e','owner');
    const c=s.claim('m1','dot','local-principal',6);
    s.subscribe('sub_m','http://127.0.0.1/hook',key,new Date(now+480*HOUR).toISOString());
    preWorkerFixture(s);
    s.db.exec('ALTER TABLE notifications DROP COLUMN covers; PRAGMA user_version=22;');s.db.close();
    s=new Store(file,{now:()=>now,limits});
    assert(s.db.prepare('PRAGMA user_version').get().user_version===65,'migration version');
    assert(s.db.prepare("SELECT count(*) n FROM notifications WHERE covers IS NOT NULL").get().n===0,'old rows got covers');
    assert(s.claims().length===1&&s.claims()[0].claim_id===c.claim_id&&s.claims()[0].epoch===1,'claim lost in migration');
    s.progress('m1',c.claim_id,'still valid','local-principal');
    s.cancel('m2');
    s.db.close();new Store(file).db.close();
  }
  log('migration 23 adds covers and keeps existing claims valid');
  // migration 24 on a v23 database: wake_kind backfilled from existing rows, indexes created, claims keep working
  {
    const file=join(home,'v23.db');
    let s=new Store(file,{now:()=>now,limits});
    s.subscribe('sub_m','http://127.0.0.1/hook',key,new Date(now+480*HOUR).toISOString());
    s.submit(payload('n1'),'t','e','owner');s.submit(payload('n2'),'t','e','owner');
    const c=s.claim('n1','dot','local-principal',6);s.note('n1','a note');s.tell('a message');s.cancel('n2');
    preWorkerFixture(s);
    s.db.exec(`DROP INDEX notifications_request_state;DROP INDEX notifications_wake_gate;DROP INDEX notifications_wake_time;DROP INDEX notifications_wake_latest;
      ALTER TABLE notifications DROP COLUMN wake_kind;PRAGMA user_version=23;`);s.db.close();
    s=new Store(file,{now:()=>now,limits});
    assert(s.db.prepare('PRAGMA user_version').get().user_version===65,'migration 24 version');
    const kinds=s.db.prepare("SELECT kind,request_id,wake_kind FROM notifications ORDER BY rowid").all().map(r=>`${r.kind}:${r.request_id}:${r.wake_kind}`).join(',');
    assert(kinds==='event:n1:submit,event:n2:submit,event:n1:owner_note,event:null:message','wake_kind backfill: '+kinds);
    const indexes=s.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'notifications_%' ORDER BY name").all().map(r=>r.name).join(',');
    assert(indexes==='notifications_due,notifications_request_state,notifications_wake_gate,notifications_wake_latest,notifications_wake_time','indexes: '+indexes);
    assert(s.claims().length===1&&s.claims()[0].claim_id===c.claim_id,'claim lost in migration 24');
    s.progress('n1',c.claim_id,'still valid','local-principal');
    s.db.close();new Store(file).db.close();
  }
  log('migration 24 backfills wake_kind (submit, owner_note, message), adds the re-wake indexes and keeps existing claims valid');
  // per-tick cost does not grow with notification history: 100 queued items, 100k notification rows, in memory
  {
    const s=new Store(':memory:',{now:()=>now,capacity:6,limits});
    s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+480*HOUR).toISOString());
    const old=new Date(now-24*HOUR).toISOString();
    for(let i=0;i<100;i++) s.submit(payload(`perf${i}`),'t','e','owner');
    s.db.exec('BEGIN');
    const a=s.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at) VALUES(?,?,'h','t','e','finished',?)");
    const n=s.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,body,state,created_at,attempt_started_at,wake_kind) VALUES(?,?,?,?,'{}','delivered',?,?,?)");
    // history: half on finished items, half on the queued items themselves, nearly all on the one subscription
    for(let i=0;i<1000;i++) a.run(`old${i}`,JSON.stringify(payload(`old${i}`)),old);
    for(let i=0;i<100000;i++) n.run(`evt_old${i}`,i%5?'event':'t3',i%4===3?null:i%2?`perf${i%100}`:`old${i%1000}`,i%5?'sub_a':null,old,old,i%5?['submit','rewake','owner_note','message'][i%4]:null);
    s.db.exec('COMMIT');
    deliverAll(s);
    // record every statement a tick and a send prepare, to check their plans below
    const prepare=s.db.prepare.bind(s.db),statements=new Set();s.db.prepare=sql=>{statements.add(sql);return prepare(sql);};
    const timed=fn=>{const start=performance.now();const value=fn();return {ms:performance.now()-start,value};};
    now+=30*SEC;const notDue=[0,1,2].map(()=>timed(()=>tick(s)));
    now+=90*SEC;const due=timed(()=>tick(s));
    assert(notDue.every(t=>t.value===0)&&due.value===1,'perf ticks: '+JSON.stringify({notDue,due}));
    const worst=Math.max(...notDue.map(t=>t.ms));
    assert(worst<50&&due.ms<50,`tick too slow: not due ${worst.toFixed(1)} ms, due ${due.ms.toFixed(1)} ms`);
    // the send-time recheck of a re-wake is bounded the same way
    const row=s.db.prepare("SELECT id FROM notifications WHERE wake_kind='rewake' AND state='pending'").get(),send=timed(()=>s.startAttempt(row.id,null));
    assert(send.value&&send.ms<50,`re-wake send check too slow: ${send.ms.toFixed(1)} ms`);
    // the timing bound alone has slack: also require that no statement of a tick or a send scans notifications
    s.db.prepare=prepare;
    const scans=[...statements].filter(sql=>/^\s*SELECT/i.test(sql)&&/notifications/.test(sql)).map(sql=>[sql,prepare('EXPLAIN QUERY PLAN '+sql).all().map(r=>r.detail)]).filter(([,plan])=>plan.some(d=>/^SCAN notifications\b/.test(d)));
    assert(scans.length===0,'re-wake statements scan notifications: '+JSON.stringify(scans));
    console.log(`  timings: not-due tick ${worst.toFixed(1)} ms, due tick ${due.ms.toFixed(1)} ms, re-wake send check ${send.ms.toFixed(1)} ms (100 queued, 100k notifications)`);
    s.db.close();
  }
  log('100 queued items and 100k notification rows: due and not-due ticks and the send-time check each stay under 50 ms, and none scans notifications');
  log('wake test');
} catch(error) {console.error(`FAIL ${error.stack||error}`);process.exitCode=1;}
finally {if(ntfy)await new Promise(r=>ntfy.close(r));await rm(home,{recursive:true,force:true});}
