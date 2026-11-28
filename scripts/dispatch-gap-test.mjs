#!/usr/bin/env node
// Dispatch gap: finish/claim name the next queued items for the free lanes, a freed lane wakes the worker at once (once, behind
// every other re-wake gate), status.dispatch and its explain token separate dispatch gaps from supply gaps, and the submit lint
// suggests dropping an unknown scope path. Store level with an injected clock. (The CLI default fix-scope is in scope-exclude-test.)
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store, expiredError } from '../src/store.mjs';
import { parseWorkers } from '../src/workers.mjs';
import { explainStatus } from '../src/status-evidence.mjs';
import { validateSubmission } from '../src/submission-policy.mjs';

const home=await mkdtemp(join(tmpdir(),'dalan-bridge-dispatch-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const SEC=1000,MIN=60000,HOUR=3600000,key=`whsec_${randomBytes(32).toString('base64')}`;
const payload=(id,brief=`dispatch test ${id}`)=>({schema_version:1,request_id:id,brief,inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'read-only'});
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:HOUR,laneCapacity:3,rewakeMs:90*SEC,rewakeWindowMs:2*HOUR,rewakeStaleMs:20*MIN};
let now=Date.parse('2026-10-09T00:00:00.000Z');
const fresh=name=>{const s=new Store(join(home,`${name}.db`),{now:()=>now,capacity:3,limits});s.subscribe('sub_a','http://127.0.0.1/hook',key,new Date(now+480*HOUR).toISOString());return s;};
const deliverAll=s=>s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=COALESCE(attempt_started_at,?) WHERE kind='event' AND state IN ('pending','sending','failed')").run(s.stamp());
const tick=s=>s.reannounceQueued(limits).announced;
const submit=(s,...ids)=>{for(const id of ids){s.submit(payload(id),'t','e','owner');now+=1000;}};
const claim=(s,id)=>s.claim(id,'dot','local-principal',3);
const finish=(s,id,c)=>s.finish(id,c.claim_id,'completed','done','ok');
const dispatch=s=>s.status({limits,capacity:3}).dispatch;
try {
  // finish and claim name up to F queued items, oldest first, never the claimed one
  {
    const s=fresh('next');submit(s,'q1','q2','q3','q4','q5');deliverAll(s);
    const c1=claim(s,'q1'),n1=s.nextQueued(s.freeLanes('local-principal','dot'),'q1');
    assert(n1.next_queued.map(x=>x.request_id).join()==='q2,q3'&&n1.next_queued[0].title==='dispatch test q2','claim next_queued: '+JSON.stringify(n1));
    assert(n1.next_action==='4 queued and 2 lanes free: claim q2, q3 now (oldest first)',n1.next_action);
    const c2=claim(s,'q2'),c3=claim(s,'q3');
    assert(!('next_queued' in s.nextQueued(s.freeLanes('local-principal','dot'),'q3')),'next_queued with no free lane');
    const f=finish(s,'q1',c1);
    assert(f.next_queued.length===1&&f.next_queued[0].request_id==='q4'&&/^2 queued and 1 lane free: claim q4 now/.test(f.next_action),'finish next_queued: '+JSON.stringify(f));
    finish(s,'q2',c2);finish(s,'q3',c3);
    const last=finish(s,'q3',c3);assert(last.duplicate,'duplicate finish');
    const s2=fresh('empty');submit(s2,'e1');const e=finish(s2,'e1',claim(s2,'e1'));
    assert(!('next_queued' in e)&&!('next_action' in e),'next_queued with an empty queue: '+JSON.stringify(e));
    log('finish and claim return next_queued (oldest first, at most the free lanes, excluding the claimed item)');
  }
  // the submit wake names the queue head, so a worker that follows wakes claims oldest first
  {
    const s=fresh('submit-head');
    const wakes=()=>s.db.prepare("SELECT body FROM notifications WHERE kind='event' ORDER BY rowid").all().map(r=>({id:JSON.parse(r.body).data.request_id,title:JSON.parse(r.body).data.title}));
    submit(s,'h1');deliverAll(s);
    assert(wakes().at(-1).id==='h1','first submit names itself: '+JSON.stringify(wakes()));
    submit(s,'h2');
    const last=wakes().at(-1);
    assert(last.id==='h1','the wake sent at h2 submit names the queue head h1: '+JSON.stringify(wakes()));
    assert(/^2 assignments queued \(3 free lanes\); claim oldest first via list_pending: /.test(last.title),'head wake text: '+last.title);
    deliverAll(s);
    const first=claim(s,wakes().at(-1).id);assert(first.request_id==='h1','first claim follows the wake');
    submit(s,'h3');deliverAll(s);
    assert(wakes().at(-1).id==='h2','after h1 is claimed the next submit wake names h2: '+JSON.stringify(wakes()));
    const order=[first.request_id,claim(s,wakes().at(-1).id).request_id,claim(s,'h3').request_id];
    assert(order.join()==='h1,h2,h3','claim order following wakes: '+order);
    log('the submit wake names the queue head (rewake text), and claims that follow wakes run oldest first');
  }
  // a head that list_pending marks blocked (waiting on a destination approval) is not named: the worker cannot claim it now
  {
    const s=fresh('submit-head-blocked');
    const wakes=()=>s.db.prepare("SELECT body FROM notifications WHERE kind='event' ORDER BY rowid").all().map(r=>JSON.parse(r.body).data.request_id);
    submit(s,'b1');submit(s,'b2');deliverAll(s);
    s.db.prepare('INSERT INTO destination_blocks(request_id,body) VALUES(?,?)').run('b1','{}');
    submit(s,'b3');
    assert(wakes().at(-1)==='b2','the wake skips the blocked head b1 and names b2: '+JSON.stringify(wakes()));
    log('the submit wake skips a head that is blocked on a destination approval');
  }
  // a claim refused for expiry tells the lane to list again before it claims another assignment
  {
    const msg=expiredError('2026-10-09T00:00:00.000Z',{cancelled:true});
    assert(/Call list_pending, then claim another listed assignment\.$/.test(msg),'expired claim error: '+msg);
    log('the expired-claim error tells the lane to call list_pending');
  }
  // a freed lane wakes at once, but only once and only through the usual gates
  {
    const full=name=>{const s=fresh(name);submit(s,'a1','a2','a3','a4');deliverAll(s);const c=['a1','a2','a3'].map(id=>claim(s,id));return {s,c};};
    {
      const {s,c}=full('freed');assert(tick(s)===0,'woke with no free lane');
      finish(s,'a1',c[0]);assert(tick(s)===1,'no immediate wake after finish (rewakeMs not yet elapsed)');
      deliverAll(s);assert(tick(s)===0,'flag not consumed: second tick woke');
      finish(s,'a2',c[1]);assert(tick(s)===1,'second freed lane did not wake');
      deliverAll(s);now+=90*SEC;assert(tick(s)===1,'the 90 s cadence stopped working');
    }
    {
      const {s}=full('abandon');s.abandon('a1',{actor:'operator'});s.db.prepare("UPDATE notifications SET state='delivered' WHERE kind='event'").run();
      s.cancelIfQueued('a4');assert(tick(s)===1,'abandoned (requeued) item did not wake');
    }
    {
      const {s}=full('cancel-claimed');s.cancel('a1');assert(tick(s)===1,'owner cancel of a claimed item did not wake');
    }
    for(const [name,setup] of [
      ['a paused bridge',s=>s.setPause('test')],
      ['an outstanding wake',s=>{s.db.prepare("INSERT INTO notifications(id,kind,request_id,state,wake_kind,created_at,subscription_id) VALUES('evt_out','event','a4','pending','rewake',?,'sub_a')").run(s.stamp());}],
      ['an owner break',s=>s.startBreak({since:s.stamp(),reason:'usage',source:'owner'})],
    ]) {
      const {s,c}=full(`gate-${name}`);finish(s,'a1',c[0]);setup(s);
      assert(tick(s)===0,`woke immediately despite ${name}`);
    }
    {
      const {s,c}=full('none-queued');s.cancelIfQueued('a4');finish(s,'a1',c[0]);
      assert(tick(s)===0,'woke with no queued work');
    }
    log('a freed lane wakes once at once (finish, abandon, owner cancel), not while paused, in an owner break, with a wake outstanding or with nothing queued');
  }
  // status.dispatch and the explain token
  {
    const s=fresh('status');
    let d=dispatch(s);assert(d.state==='supply_gap'&&d.free_lanes===3&&d.queued_live===0&&d.oldest_unclaimed_age_ms===null,'supply_gap '+JSON.stringify(d));
    submit(s,'s1','s2','s3','s4');now+=5*MIN;
    d=dispatch(s);assert(d.state==='dispatch_gap'&&d.queued_live===4&&d.oldest_unclaimed_age_ms>=5*MIN,'dispatch_gap '+JSON.stringify(d));
    assert(/ dispatch=dispatch_gap\(free:3,queued:4,oldest:5m\) outer=/.test(explainStatus(s.status({limits,capacity:3}))),'explain token: '+explainStatus(s.status({limits,capacity:3})));
    for(const id of ['s1','s2','s3']) claim(s,id);
    d=dispatch(s);assert(d.state==='full'&&d.free_lanes===0&&d.queued_live===1,'full '+JSON.stringify(d));
    s.setPause('maintenance');d=dispatch(s);assert(d.state==='paused','paused '+JSON.stringify(d));
    log('status.dispatch reports dispatch_gap, supply_gap, full and paused; explain carries dispatch=');
  }
  // Both dispatch summaries name the same oldest eligible row, with a stable tie.
  {
    const s=fresh('status-oldest-id');
    submit(s,'earlier-skipped','earlier-cancelled');
    s.db.prepare("UPDATE assignments SET skipped_at=? WHERE request_id='earlier-skipped'").run(s.stamp());
    s.cancelIfQueued('earlier-cancelled');
    now+=5*MIN;
    const sameTime=s.stamp();
    submit(s,'ready-z','ready-a');
    s.db.prepare("UPDATE assignments SET created_at=? WHERE request_id IN ('ready-a','ready-z')").run(sameTime);
    now+=MIN;
    let status=dispatch(s);
    for (const state of [status,status.by_worker.dot]) {
      assert(state.oldest_unclaimed_request_id==='ready-a','oldest tie follows request id');
      assert(state.oldest_unclaimed_age_ms===now-Date.parse(sameTime),'age and request id refer to the same row');
      assert(state.queued_live===2,'only two live candidates');
    }
    s.cancelIfQueued('ready-a');s.cancelIfQueued('ready-z');
    status=dispatch(s);
    assert(status.oldest_unclaimed_request_id===null,'empty legacy queue has no request id');
    assert(status.by_worker.dot.oldest_unclaimed_request_id===null,'empty worker queue has no request id');
  }
  // Skipped rows remain in the queue but do not signal a dispatch failure.
  {
    const s=fresh('status-skipped');
    const skippedAt=now;
    submit(s,'skip-old');
    now+=5*MIN;
    const readyAt=now;
    submit(s,'still-ready');
    // Control the first event's exact timestamp independently from wake coalescing.
    s.db.prepare("DELETE FROM notifications WHERE kind='event' AND request_id IN ('skip-old','still-ready')").run();
    const event=s.db.prepare("INSERT INTO notifications(id,kind,request_id,state,wake_kind,created_at,subscription_id) VALUES(?,'event',?,'delivered','rewake',?,'sub_a')");
    event.run('evt_skip','skip-old',new Date(skippedAt+SEC).toISOString());
    event.run('evt_ready','still-ready',new Date(readyAt+SEC).toISOString());
    const skip=s.db.prepare('UPDATE assignments SET skipped_at=?,passed_over=3 WHERE request_id=?');
    skip.run(s.stamp(),'skip-old');
    now+=20*MIN;s.recordWorkerCall('owner','get');
    let st=s.status({limits,capacity:3});
    assert(st.dispatch.state==='dispatch_gap'&&st.dispatch.queued_live===1&&st.dispatch.oldest_unclaimed_age_ms===now-readyAt,'mixed queue: '+JSON.stringify(st.dispatch));
    assert(st.by_worker.dot.queue_classes.alive_not_claiming===1,'only the live, unskipped row counts: '+JSON.stringify(st.by_worker.dot.queue_classes));
    assert(st.by_worker.dot.oldest_unclaimed_event_2xx_age_ms===now-readyAt-SEC,'only the unskipped event sets the age');
    skip.run(s.stamp(),'still-ready');
    st=s.status({limits,capacity:3});
    assert(st.dispatch.state==='supply_gap'&&st.dispatch.queued_live===0&&st.dispatch.oldest_unclaimed_age_ms===null,'all skipped: '+JSON.stringify(st.dispatch));
    assert(st.by_worker.dot.queue_classes.alive_not_claiming===0&&st.by_worker.dot.oldest_unclaimed_event_2xx_age_ms===null,'skipped events do not look unclaimed');
    s.db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?').run(new Date(now-1).toISOString(),'skip-old');
    assert(s.status({limits,capacity:3}).by_worker.dot.queue_classes.expired===1,'skipped expired rows still count as expired');
    log('status excludes skipped rows from dispatch and liveness signals, but still reports expired rows');
  }
  // Independent worker policies: the legacy worker's full lanes do not hide another worker's dispatch gap.
  {
    const connection=worker=>({issuer:'https://issuer.example.test',subject:worker,client_id:`client-${worker}`});
    const workers=parseWorkers({workers:{
      dot:{connections:[connection('dot')]},
      second:{connections:[connection('second')]},
    }});
    const s=new Store(join(home,'workers.db'),{now:()=>now,capacity:3,limits,workers});
    for (const name of workers.workers.keys()) {
      s.subscribe(`sub_${name}`, 'http://127.0.0.1/hook', key, new Date(now+HOUR).toISOString(),
        `principal-${name}`, name, connection(name));
    }
    const legacyWorker=[...workers.workers.keys()].find(name=>name!=='second');
    submit(s,'full-1','full-2','full-3');
    for (const id of ['full-1','full-2','full-3']) s.claim(id,'test',`principal-${legacyWorker}`,3);
    const submitSecond=id=>{const row=payload(id);s.submit(row,'t','e','owner',false,null,'normal',null,row,null,'second');now+=1000;};
    submitSecond('skip-second');
    now+=5*MIN;
    const readyAt=now;
    submitSecond('ready-second');
    s.db.prepare("UPDATE assignments SET skipped_at=? WHERE request_id='skip-second'").run(s.stamp());
    now+=2*MIN;
    const {by_worker: workersDispatch,...legacy}=dispatch(s);
    assert(JSON.stringify(legacy)===JSON.stringify({scope:'dot',state:'full',free_lanes:0,queued_live:0,oldest_unclaimed_age_ms:null,oldest_unclaimed_request_id:null}),
      'unchanged legacy dispatch '+JSON.stringify(legacy));
    assert(workersDispatch?.dot.state==='full'&&workersDispatch.dot.free_lanes===0,'dot must report full');
    const second=workersDispatch?.second;
    assert(second?.state==='dispatch_gap'&&second.free_lanes===3&&second.queued_live===1&&second.oldest_unclaimed_age_ms===now-readyAt,
      'second worker independent dispatch '+JSON.stringify(second));
    log('per-worker dispatch separates full, free and skipped work without changing legacy fields');
  }
  // submit lint: an unknown scope path comes with a suggestion that drops it
  {
    const task={schema_version:1,request_id:'req_dispatch_scope',brief:'Read the docs.',expected_output:'A summary',execution_scope:'read-only',inputs:[{github_repo:'o/r',base_sha:'a'.repeat(40)}],scope_paths:['docs','nope/missing.md']};
    let err=null;try{validateSubmission(task,{scanInput:()=>({files:['docs/a.md'],diffFiles:[],diff:'',symlinks:[]})});}catch(e){err=e;}
    assert(err&&err.message==='unknown scope path: nope/missing.md'&&JSON.stringify(err.suggested_scope_paths)==='["docs"]','unknown scope path: '+err?.message+JSON.stringify(err?.suggested_scope_paths));
    task.scope_paths=['nope/missing.md'];err=null;try{validateSubmission(task,{scanInput:()=>({files:['docs/a.md'],diffFiles:[],diff:'',symlinks:[]})});}catch(e){err=e;}
    assert(err&&!err.suggested_scope_paths,'suggested an empty scope');
    task.scope_paths=['docs'];task.read_list=['docs','x.md'];err=null;try{validateSubmission(task,{scanInput:()=>({files:['docs/a.md'],diffFiles:[],diff:'',symlinks:[]})});}catch(e){err=e;}
    assert(err&&/^contradictory read_list and scope_paths: x\.md$/.test(err.message),'contradictory read_list names the path: '+err?.message);
    log('unknown scope path names the path and suggests the scope without it; contradictory lists name the paths');
  }
} finally { await rm(home,{recursive:true,force:true}); }
