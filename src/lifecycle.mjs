// Append-only lifecycle events: one row per state change, written in the same transaction as the change.
// Metrics derive from these rows only; anything the rows cannot show is reported as unknown with a reason, never as zero.
import { fromStoredSource, canonicalObjectiveKey, canonicalKindSql, canonicalKindLabel } from './objectives.mjs';
export const lifecycleTypes=['queued','claimed','working','waiting','blocked','completed','consumed','accepted','integrated','abandoned','cancelled','delivery_sent','delivery_uncertain','reconciled','check_started','check_passed','check_failed','check_skipped'];
export const retentionDays=90;
// Two consecutive claim activity events no more than this far apart count as working time (see docs/usage.md, "Metrics").
export const activeGapMs=20*60000;
const defaultWindowMs=30*86400000;
// Kind of an assignment (alias a): the submitter's task_kind (column, else payload), else review or execution_scope; then the priority.
export const kindSql=`${canonicalKindSql("COALESCE(a.task_kind,json_extract(a.payload,'$.task_kind'),CASE WHEN a.review=1 THEN 'review' ELSE json_extract(a.payload,'$.execution_scope') END,'unknown')")}||'/'||COALESCE(a.priority,'normal')`;
// Same rule as the blocker forwarding in Store.progress: BLOCKED: or blocker:true is blocked, QUESTION: is waiting for the owner.
export const progressType=(note,blocker=false)=>blocker||/^\s*BLOCKED:/im.test(note)?'blocked':/^\s*QUESTION:/im.test(note)?'waiting':'working';

// Retention deletes go through one guarded path: the trigger admits a DELETE only for rows older than the cutoff that
// retainLifecycle sets and clears inside its own transaction. This guards against accidental writes, not against a
// process that can rewrite the schema.
export const lifecycleSchema=`CREATE TABLE IF NOT EXISTS lifecycle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, claim_id TEXT, epoch INTEGER, type TEXT NOT NULL CHECK(type IN (${lifecycleTypes.map(t=>`'${t}'`).join(',')})), at TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('live','backfill')), reason TEXT);
  CREATE INDEX IF NOT EXISTS lifecycle_events_request ON lifecycle_events(request_id,id);
  CREATE INDEX IF NOT EXISTS lifecycle_events_type_at ON lifecycle_events(type,at);
  CREATE TABLE IF NOT EXISTS lifecycle_daily (day TEXT NOT NULL, type TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,type,kind));
  CREATE TABLE IF NOT EXISTS lifecycle_retention (id INTEGER PRIMARY KEY CHECK(id=1), cutoff TEXT, rolled_up_before TEXT);
  INSERT OR IGNORE INTO lifecycle_retention(id) VALUES(1);
  CREATE TRIGGER IF NOT EXISTS lifecycle_events_no_update BEFORE UPDATE ON lifecycle_events BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS lifecycle_events_no_delete BEFORE DELETE ON lifecycle_events WHEN NOT EXISTS (SELECT 1 FROM lifecycle_retention WHERE id=1 AND cutoff IS NOT NULL AND old.at<cutoff) BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only'); END;`;

export const checkOutcome=(job,run)=>{
  const base=`check_id=${job.check_id};check_run_id=${job.id}`;
  const skipped=job.skipped_segments??run?.skipped_segments??(run?.exit_code===77?1:0);
  const detail=job.check_summary??run?.check_summary??(skipped?`skipped_segments=${skipped}`:null);
  const suffix=detail?`;${detail}`:'';
  if(['completed','skipped','failed'].includes(job.status)&&run) {
    const clean=job.status!=='failed'&&run.phase==='check'&&[0,77].includes(run.exit_code)&&!run.timed_out&&!run.cancelled;
    if(clean&&(skipped||job.status==='skipped')) return ['check_skipped',base+suffix];
    return clean&&run.exit_code===0?['check_passed',base]:['check_failed',`${base};phase=${run.phase};exit=${run.exit_code}${run.timed_out?';timed_out':''}${run.cancelled?';cancelled':''}${suffix}`];
  }
  if(job.status==='failed') return ['check_failed',`${base};error${suffix}`];
  if(job.status==='interrupted') return ['check_failed',`${base};interrupted`];
  return null;
};

// History from rows that predate lifecycle events. Only what the rows prove: claims keep their current epoch only, and
// consumed, accepted, integrated, abandoned and check_skipped leave no trace before v21, so none is invented.
export function backfillLifecycle(db) {
  // Idempotent: a table that already holds any event (backfilled or live) is never backfilled again.
  if(db.prepare('SELECT 1 FROM lifecycle_events LIMIT 1').get()) return 0;
  const claims=new Map(db.prepare('SELECT request_id,claim_id,epoch,claimed_at FROM claims').all().map(c=>[c.request_id,c]));
  const byClaimId=new Map([...claims.values()].map(c=>[c.claim_id,c]));
  const inClaim=(id,at)=>{ const c=claims.get(id); return c&&at>=c.claimed_at?c:null; };
  const events=[], add=(requestId,type,at,claim,reason=null)=>{ if(requestId&&at) events.push([requestId,claim?.claim_id??null,claim?.epoch??null,type,at,reason]); };
  for(const a of db.prepare('SELECT request_id,created_at,cancelled_at FROM assignments').all()) {
    add(a.request_id,'queued',a.created_at,null);
    if(a.cancelled_at) add(a.request_id,'cancelled',a.cancelled_at,inClaim(a.request_id,a.cancelled_at));
  }
  for(const c of claims.values()) add(c.request_id,'claimed',c.claimed_at,c,c.epoch>1?'current epoch only; earlier epochs unknown':null);
  for(const p of db.prepare('SELECT request_id,note,created_at FROM progress ORDER BY id').all()) add(p.request_id,progressType(p.note),p.created_at,inClaim(p.request_id,p.created_at));
  for(const r of db.prepare('SELECT request_id,claim_id,outcome,late,created_at FROM reports').all()) {
    const claim=byClaimId.get(r.claim_id)??{claim_id:r.claim_id,epoch:null};
    add(r.request_id,'completed',r.created_at,claim,`outcome=${r.outcome}${r.late?';late':''}`);
    if(r.outcome==='blocked') add(r.request_id,'blocked',r.created_at,claim);
  }
  for(const n of db.prepare("SELECT request_id,kind,state,attempt_started_at,last_reconciled_at,uncertain_reason FROM notifications WHERE kind IN ('t3','blocker','watch') AND attempt_started_at IS NOT NULL AND state IN ('delivered','uncertain')").all()) {
    const claim=inClaim(n.request_id,n.attempt_started_at);
    if(n.state==='uncertain') add(n.request_id,'delivery_uncertain',n.attempt_started_at,claim,n.kind);
    else if(n.last_reconciled_at) { add(n.request_id,'delivery_uncertain',n.attempt_started_at,claim,n.kind); add(n.request_id,'reconciled',n.last_reconciled_at,inClaim(n.request_id,n.last_reconciled_at),n.kind); }
    else add(n.request_id,'delivery_sent',n.attempt_started_at,claim,n.kind);
  }
  for(const job of db.prepare('SELECT j.*,r.phase,r.exit_code,r.timed_out FROM check_jobs j LEFT JOIN check_runs r ON r.id=j.id').all()) {
    const claim=byClaimId.get(job.claim_id)??{claim_id:job.claim_id,epoch:null};
    add(job.request_id,'check_started',job.started_at,claim,`check_id=${job.check_id};check_run_id=${job.id}`);
    const outcome=checkOutcome(job,job.phase==null?null:job);
    if(outcome) add(job.request_id,outcome[0],job.finished_at??job.started_at,claim,outcome[1]);
  }
  events.sort((a,b)=>a[4]<b[4]?-1:a[4]>b[4]?1:0);
  const insert=db.prepare("INSERT INTO lifecycle_events(request_id,claim_id,epoch,type,at,actor,source,reason) VALUES(?,?,?,?,?,'system','backfill',?)");
  for(const e of events) insert.run(...e);
  return events.length;
}

// Events older than the retention window become per-day counts by type and kind, then leave the event table.
export function retainLifecycle(store,days=retentionDays) { return store.transaction(()=>{
  const db=store.db, cutoff=new Date(store.nowMs()-days*86400000).toISOString();
  db.prepare(`INSERT INTO lifecycle_daily(day,type,kind,count) SELECT substr(e.at,1,10),e.type,${kindSql},count(*) FROM lifecycle_events e LEFT JOIN assignments a ON a.request_id=e.request_id WHERE e.at<? GROUP BY 1,2,3
    ON CONFLICT(day,type,kind) DO UPDATE SET count=count+excluded.count`).run(cutoff);
  db.prepare('UPDATE lifecycle_retention SET cutoff=? WHERE id=1').run(cutoff);
  const deleted=db.prepare('DELETE FROM lifecycle_events WHERE at<?').run(cutoff).changes;
  db.prepare('UPDATE lifecycle_retention SET cutoff=NULL,rolled_up_before=CASE WHEN ?>0 THEN ? ELSE rolled_up_before END WHERE id=1').run(deleted,cutoff);
  return {cutoff,rolled_up:deleted};
}); }

const metric=(value,unit)=>({value,unit}), unknown=reason=>({value:null,unknown_reason:reason});
const rank=(xs,p)=>{ const s=[...xs].sort((a,b)=>a-b); return s[Math.max(0,Math.ceil(p*s.length)-1)]; };
const distribution=(xs,why)=>({n:metric(xs.length,'count'),p50:xs.length?metric(rank(xs,0.5),'ms'):unknown(why),p90:xs.length?metric(rank(xs,0.9),'ms'):unknown(why)});
const ratio=(num,den,unit,why)=>den>0?metric(Math.round(num/den*1000)/1000,unit):unknown(why);
const activity=new Set(['claimed','working','blocked','waiting','check_started','check_passed','check_failed','check_skipped','completed']);
const firstActivity=new Set(['working','blocked','waiting','check_started']);
const closes=new Set(['completed','abandoned','cancelled']);

// Claim intervals of one request timeline: claimed .. the next claimed, completed, abandoned or cancelled (or now while open).
function claimSpans(events,nowMs) {
  const spans=[];
  events.forEach((claim,i)=>{
    if(claim.type!=='claimed') return;
    let end=events.length;
    for(let j=i+1;j<events.length;j++) if(events[j].type==='claimed'||closes.has(events[j].type)) { end=j; break; }
    const open=end===events.length;
    spans.push({claim,open,closedBy:open?null:events[end].type,endMs:open?nowMs:events[end].ms,inside:events.slice(i,end).filter(e=>activity.has(e.type))});
  });
  return spans;
}
// Each activity event holds until the next one (or the claim end): blocked/waiting by type, working for a running check or a gap within activeGapMs, else idle.
const segmentsOf=({inside,endMs})=>inside.map((e,k)=>{
  const next=k+1<inside.length?inside[k+1].ms:endMs;
  return {kind:e.type==='blocked'||e.type==='waiting'?e.type:e.type==='check_started'||next-e.ms<=activeGapMs?'working':'idle',from:e.ms,to:next};
});

// A queued item that has waited longer than this is a claiming gap, not a normal pickup delay.
export const pickupBudgetMs=180000;
const minLevelMs=10*60000;
const windows=[['24h','last_24h',86400000],['7d','last_7d',7*86400000]];
// Fixed windows ending now, independent of --since. A sweep over interval endpoints splits covered wall time into three shares
// that add up: queue empty, all lanes busy, and idle-while-queued (queued_count>0 and active_claims<laneCapacity).
// Time before the first lifecycle event (or before the retention roll-up) is unknown, not idle: it leaves the denominator.
function laneUtilization(store,laneCapacity,nowMs,firstEventMs,rolledUpBefore) {
  const db=store.db, startOfAll=nowMs-windows.at(-1)[2], startText=new Date(startOfAll).toISOString();
  const rows=db.prepare(`SELECT request_id,type,at,epoch,source,actor FROM lifecycle_events WHERE request_id IN (SELECT request_id FROM lifecycle_events WHERE at>=? UNION SELECT request_id FROM assignments WHERE status IN ('queued','claimed')) ORDER BY request_id,at,id`).all(startText);
  const queuedNow=new Set(db.prepare("SELECT request_id FROM assignments WHERE status='queued'").all().map(a=>a.request_id));
  const timelines=new Map();
  for(const row of rows) { row.ms=Date.parse(row.at); (timelines.get(row.request_id)??timelines.set(row.request_id,[]).get(row.request_id)).push(row); }
  // delta = [ms, queued, claims, stale (queued longer than the pickup budget), completion marker, worker active (a claim event by the worker within activeGapMs), owner break]
  const deltas=[], work=[], pickups=[];
  const queuedSpan=(from,to)=>{ deltas.push([from,1,0,0,0],[to,-1,0,0,0]); if(to-from>pickupBudgetMs) deltas.push([from+pickupBudgetMs,0,0,1,0],[to,0,0,-1,0]); };
  for(const [requestId,events] of timelines) {
    let queuedFrom=null;
    for(const e of events) {
      if(e.actor?.startsWith('worker:')||e.actor?.startsWith('dot:')) deltas.push([e.ms,0,0,0,0,1,0],[e.ms+activeGapMs,0,0,0,0,-1,0]);
      if(e.type==='queued'&&queuedFrom===null) queuedFrom=e.ms;
      else if((e.type==='claimed'||e.type==='cancelled')&&queuedFrom!==null) { queuedSpan(queuedFrom,e.ms); if(e.type==='claimed'&&!(e.source==='backfill'&&e.epoch>1)) pickups.push([e.ms,e.ms-queuedFrom]); queuedFrom=null; }
    }
    if(queuedFrom!==null&&queuedNow.has(requestId)) queuedSpan(queuedFrom,nowMs);
    for(const span of claimSpans(events,nowMs)) {
      deltas.push([span.claim.ms,0,1,0,0],[span.endMs,0,-1,0,0]);
      if(span.closedBy==='completed') deltas.push([span.endMs,0,0,0,1]);
      for(const seg of segmentsOf(span)) if(seg.kind==='working') work.push([seg.from,Math.min(seg.to,nowMs)]);
    }
  }
  for(const b of db.prepare("SELECT since,until FROM worker_breaks WHERE source='owner'").all()) deltas.push([Date.parse(b.since),0,0,0,0,0,1],[b.until?Date.parse(b.until):nowMs,0,0,0,0,0,-1]);
  deltas.sort((a,b)=>a[0]-b[0]||b[4]-a[4]); // a completion counts at the concurrency that still includes its own claim
  const coveredFrom=Math.max(startOfAll,firstEventMs===null?nowMs:Date.parse(firstEventMs),rolledUpBefore?Date.parse(rolledUpBefore):0);
  const overlap=(from,to,lo,hi)=>Math.max(0,Math.min(to,hi)-Math.max(from,lo));
  const share=(ms,of,why)=>of>0?{value:Math.round(ms/of*1000)/1000,unit:'ratio',ms,of_ms:of}:unknown(why);
  return {lanes:metric(laneCapacity,'count'),...Object.fromEntries(windows.map(([,key,span])=>{
    const lo=nowMs-span, from=Math.max(lo,coveredFrom), covered=Math.max(0,nowMs-from);
    const t={empty:0,busy:0,idle:0,waiting:0}, waitingBy={owner_break:0,worker_inactive:0,worker_active:0}, level=new Map();
    let q=0,c=0,stale=0,active=0,brk=0,prev=-Infinity,maxClaims=0;
    const bump=(k,field,n)=>{ const l=level.get(k)??level.set(k,{ms:0,done:0}).get(k); l[field]+=n; };
    const add=(to)=>{ const ms=overlap(prev,to,from,nowMs); if(!ms) return; const state=q===0?'empty':c>=laneCapacity?'busy':stale>0?'waiting':'idle'; t[state]+=ms; if(state==='waiting') waitingBy[brk>0?'owner_break':active>0?'worker_active':'worker_inactive']+=ms; maxClaims=Math.max(maxClaims,c); bump(c,'ms',ms); };
    for(const [at,dq,dc,ds,done,da=0,dbrk=0] of deltas) { add(at); prev=at; if(done&&at>=from&&at<=nowMs) bump(c,'done',1); q+=dq; c+=dc; stale+=ds; active+=da; brk+=dbrk; }
    add(nowMs);
    const waits=pickups.filter(([at])=>at>=lo&&at<=nowMs).map(([,w])=>w);
    const byConcurrency=[...level].filter(([k,l])=>k>0&&l.ms>=minLevelMs).sort((a,b)=>a[0]-b[0]).map(([k,l])=>{ const perHour=l.done/(l.ms/3600000); return {claims_held:k,time_ms:l.ms,completions:l.done,completions_per_hour:Math.round(perHour*100)/100,per_claim_per_hour:Math.round(perHour/k*100)/100}; });
    const numerator=work.reduce((sum,[a,b])=>sum+overlap(a,b,from,nowMs),0), denominator=laneCapacity*covered, why='the window has no covered time (no lifecycle events yet)';
    return [key,{window:{since:new Date(lo).toISOString(),wall_ms:span,covered_ms:covered,covered_fraction:Math.round(covered/span*1000)/1000},
      utilization:denominator>0?{value:Math.round(numerator/denominator*1000)/1000,unit:'ratio',numerator_ms:numerator,denominator_ms:denominator,lanes:laneCapacity}:unknown(why),
      idle_while_queued:share(t.idle+t.waiting,covered,why),idle_while_fresh_queued:share(t.idle,covered,why),idle_while_waiting_queued:share(t.waiting,covered,why),idle_while_waiting_by_cause:Object.fromEntries(Object.entries(waitingBy).map(([k,ms])=>[k,share(ms,covered,why)])),pickup_budget_ms:pickupBudgetMs,
      pickup_wait:distribution(waits,'no assignment was claimed from the queue in the window'),max_concurrent_claims:covered>0?metric(maxClaims,'count'):unknown(why),throughput_by_concurrency:byConcurrency,queue_empty:share(t.empty,covered,why),all_lanes_busy:share(t.busy,covered,why)}];
  }))};
}

export function lifecycleMetrics(store,{since=null,laneCapacity=store.limits.laneCapacity??6}={}) {
  const db=store.db, nowMs=store.nowMs();
  if(since!==null&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(since)||!Number.isFinite(Date.parse(since)))) throw new Error('since must be an RFC 3339 time with offset');
  const sinceMs=since===null?nowMs-defaultWindowMs:Date.parse(since), sinceText=new Date(sinceMs).toISOString();
  if(sinceMs>=nowMs) throw new Error('since must be in the past');
  const rolledUpBefore=db.prepare('SELECT rolled_up_before FROM lifecycle_retention WHERE id=1').get().rolled_up_before;
  const rolledUp=!!rolledUpBefore&&sinceText<rolledUpBefore;
  const rows=db.prepare(`SELECT e.*,${kindSql} kind FROM lifecycle_events e LEFT JOIN assignments a ON a.request_id=e.request_id
    WHERE e.request_id IN (SELECT request_id FROM lifecycle_events WHERE at>=?) ORDER BY e.request_id,e.at,e.id`).all(sinceText);
  const timelines=new Map();
  for(const row of rows) { row.ms=Date.parse(row.at); (timelines.get(row.request_id)??timelines.set(row.request_id,[]).get(row.request_id)).push(row); }
  const statuses=new Map(db.prepare('SELECT request_id,status FROM assignments').all().map(a=>[a.request_id,a.status]));
  const inWindow=e=>e.ms>=sinceMs;
  const queueLatency=[], firstActivityMs=[], totals={working:0,blocked:0,waiting:0,idle:0,claimed:0};
  let stillQueued=0, earlierEpochUnknown=0, noActivity=0, awaitingActivity=0, openClaims=0;
  const clip=(from,to)=>Math.max(0,Math.min(to,nowMs)-Math.max(from,sinceMs));
  for(const [requestId,events] of timelines) {
    events.forEach((e,i)=>{
      if(e.type!=='queued'||!inWindow(e)) return;
      const claimed=events.slice(i+1).find(x=>x.type==='claimed'||x.type==='cancelled'||x.type==='queued');
      if(claimed?.type!=='claimed') { if(!claimed&&statuses.get(requestId)==='queued') stillQueued++; return; }
      if(claimed.source==='backfill'&&claimed.epoch>1) { earlierEpochUnknown++; return; }
      queueLatency.push(claimed.ms-e.ms);
    });
    for(const span of claimSpans(events,nowMs)) {
      if(span.open) openClaims++;
      if(inWindow(span.claim)) {
        const first=span.inside.find(e=>firstActivity.has(e.type));
        if(first) firstActivityMs.push(first.ms-span.claim.ms); else if(span.open) awaitingActivity++; else noActivity++;
      }
      totals.claimed+=clip(span.claim.ms,span.endMs);
      for(const seg of segmentsOf(span)) totals[seg.kind]+=clip(seg.from,seg.to);
    }
  }
  const firstEventMs=db.prepare('SELECT min(at) at FROM lifecycle_events').get().at??null;
  const wallStart=Math.max(sinceMs,firstEventMs?Date.parse(firstEventMs):nowMs), wallMs=Math.max(0,nowMs-wallStart);
  const rolled=why=>({n:unknown(why),p50:unknown(why),p90:unknown(why)});
  const duration=value=>rolledUp?unknown('rolled up'):metric(value,'ms');
  const windowed=rows.filter(inWindow);
  const count=type=>windowed.filter(e=>e.type===type).length;
  const backfilled=windowed.some(e=>e.source==='backfill');
  // Throughput: completed (terminal worker report) events per UTC day and kind, plus daily roll-ups when the window reaches them.
  const perDay=new Map();
  for(const e of windowed.filter(e=>e.type==='completed')) { const key=`${e.at.slice(0,10)}\0${e.kind}`; perDay.set(key,(perDay.get(key)??0)+1); }
  if(rolledUp) for(const r of db.prepare("SELECT day,kind,count FROM lifecycle_daily WHERE type='completed' AND day>=?").all(sinceText.slice(0,10))) { const key=`${r.day}\0${canonicalKindLabel(r.kind)}`; perDay.set(key,(perDay.get(key)??0)+r.count); }
  const byDay=[...perDay].map(([key,n])=>{ const [day,kind]=key.split('\0'); return {day,kind,completed:n}; }).sort((a,b)=>a.day.localeCompare(b.day)||a.kind.localeCompare(b.kind));
  const completedTotal=byDay.reduce((sum,x)=>sum+x.completed,0), days=Math.max(1,Math.ceil(wallMs/86400000));
  const byKind={}; for(const x of byDay) byKind[x.kind]=(byKind[x.kind]??0)+x.completed;
  // Rework: an earlier submission of the same objective_key had another revision. Duplicate: an earlier one had the same
  // objective_key and revision under another request_id. Columns first, then payload fields (older hand-written payloads).
  // A row cancelled because its preparation expired was never worked: it is neither repeated nor makes its re-preparation one.
  const all=db.prepare("SELECT request_id,created_at,COALESCE(objective_key,json_extract(payload,'$.objective_key')) k,COALESCE(revision,json_extract(payload,'$.revision')) r,COALESCE(source,'unknown') src,cancelled_reason FROM assignments ORDER BY created_at,request_id").all().map(x=>({...x,k:canonicalObjectiveKey(x.k),src:fromStoredSource(x.src)}));
  const seen=new Map(), repeat={rework:{value:0,by_source:{}},duplicates:{value:0,by_source:{}}}, coverage={keyed:0,total:0,by_source:{}};
  for(const x of all) {
    const inside=x.created_at>=sinceText, keyed=x.k!=null&&x.r!=null;
    if(inside) { coverage.total++; const c=coverage.by_source[x.src]??={keyed:0,total:0}; c.total++; if(keyed) { coverage.keyed++; c.keyed++; } }
    if(!keyed||x.cancelled_reason==='expired') continue;
    const revisions=seen.get(x.k)??seen.set(x.k,new Set()).get(x.k);
    if(inside) for(const [name,hit] of [['rework',revisions.size>(revisions.has(x.r)?1:0)],['duplicates',revisions.has(x.r)]]) if(hit) { repeat[name].value++; repeat[name].by_source[x.src]=(repeat[name].by_source[x.src]??0)+1; }
    revisions.add(x.r);
  }
  const noKey=coverage.total?`none of the ${coverage.total} assignments submitted in the window has an objective_key and revision (submitters send them as meta; run dalan backfill-objectives for older rows)`:'no assignment was submitted in the window';
  const repeated=name=>coverage.keyed?{value:repeat[name].value,unit:'count',n:coverage.keyed,by_source:repeat[name].by_source}:unknown(noKey);
  // Owner acceptance of requests whose terminal report landed in the window. The latest verdict wins.
  const verdicts={accepted:0,rejected:0,consumed_only:0,unknown:0};
  for(const [requestId,events] of timelines) {
    if(!events.some(e=>e.type==='completed'&&inWindow(e))) continue;
    const verdict=events.filter(e=>e.type==='accepted'||e.type==='consumed'&&/^rejected/.test(e.reason??'')).at(-1);
    verdicts[verdict?verdict.type==='accepted'?'accepted':'rejected':events.some(e=>e.type==='consumed')?'consumed_only':'unknown']++;
  }
  const finished=Object.values(verdicts).reduce((a,b)=>a+b,0);
  const passed=count('check_passed'), failed=count('check_failed'), skipped=count('check_skipped');
  const notes=[`lane_utilization = working lane time / (worker_lane_capacity x covered wall time) over fixed windows ending now (not --since); idle_while_queued is the share of covered time with work queued and fewer active claims than lanes, split into idle_while_fresh_queued (every queued item has waited at most pickup_budget_ms) and idle_while_waiting_queued (some queued item has waited longer, which indicates a wake-up or claiming gap, not a supply gap); idle_while_waiting_by_cause splits idle_while_waiting_queued into owner_break (an owner-confirmed usage break was active), worker_inactive (no claim event by the worker, such as a claim, progress or finish, in the last ${activeGapMs/60000} min: the worker is silent or away) and worker_active (the worker was working claims but left a free lane unused); queue_empty + all_lanes_busy + idle_while_queued = 1; time before the first lifecycle event is unknown and excluded`,`working time = sum of gaps of at most ${activeGapMs/60000} min between consecutive claim activity events, plus running checks; longer gaps are idle; gaps after blocked/waiting count as blocked/waiting`];
  if(backfilled) notes.push('window includes backfilled history: claims show the current epoch only; consumed, accepted, integrated, abandoned and check_skipped before lifecycle events are unknown');
  if(rolledUp) notes.push(`events before ${rolledUpBefore} are rolled up to daily counts: durations are unknown`);
  // Resume wake, per worker: resumed = 'claimed' events with reason 'resume' (an idle own claim rotated to a new epoch);
  // lease_expiry_retries = 'abandoned' events whose reason starts lease_expired (sweep or takeover). Time to finish = first
  // 'queued' event to 'completed' (submit to finish) for requests that finished in the window; a request that was resumed
  // counts as resumed, one that only went through lease expiry as lease_expiry. duplicate_epoch_claims must be 0: it counts
  // (request, epoch) pairs that more than one claim_id acted under.
  const resumeWake={};
  const resumeRow=worker=>resumeWake[worker]??={resumed:0,lease_expiry_retries:0,_resumed:[],_expiry:[]};
  for(const events of timelines.values()) {
    const done=events.find(e=>e.type==='completed'&&inWindow(e)), queued=events.find(e=>e.type==='queued');
    const resumes=events.filter(e=>e.type==='claimed'&&e.reason==='resume'), expiries=events.filter(e=>e.type==='abandoned'&&/^lease_expired\b/.test(e.reason??''));
    for(const e of resumes) if(inWindow(e)) resumeRow(e.worker).resumed++;
    for(const e of expiries) if(inWindow(e)) resumeRow(e.worker).lease_expiry_retries++;
    if(done&&queued&&(resumes.length||expiries.length)) resumeRow(done.worker)[resumes.length?'_resumed':'_expiry'].push(done.ms-queued.ms);
  }
  const resumeByWorker=Object.fromEntries(Object.entries(resumeWake).map(([worker,r])=>[worker,{resumed:metric(r.resumed,'count'),lease_expiry_retries:metric(r.lease_expiry_retries,'count'),
    time_to_finish_resumed:distribution(r._resumed,'no resumed request finished in the window'),time_to_finish_lease_expiry:distribution(r._expiry,'no request that went through lease expiry finished in the window')}]));
  const duplicateEpochs=db.prepare("SELECT count(*) n FROM (SELECT request_id,epoch FROM lifecycle_events WHERE claim_id IS NOT NULL AND epoch IS NOT NULL AND source='live' AND request_id IN (SELECT request_id FROM lifecycle_events WHERE at>=?) GROUP BY request_id,epoch HAVING count(DISTINCT claim_id)>1)").get(sinceText).n;
  return {
    resume_wake:{by_worker:resumeByWorker,duplicate_epoch_claims:metric(duplicateEpochs,'count')},
    window:{since:sinceText,until:new Date(nowMs).toISOString(),wall_ms:wallMs,rolled_up:rolledUp},
    queue_latency:rolledUp?rolled('rolled up'):{...distribution(queueLatency,'no queued event in the window was claimed'),still_queued:metric(stillQueued,'count'),earlier_epoch_unknown:metric(earlierEpochUnknown,'count')},
    claim_to_first_activity:rolledUp?rolled('rolled up'):{...distribution(firstActivityMs,'no claim in the window has recorded activity'),closed_without_activity:metric(noActivity,'count'),awaiting_activity:metric(awaitingActivity,'count')},
    time:{claimed:duration(totals.claimed),working:duration(totals.working),blocked:duration(totals.blocked),waiting:duration(totals.waiting),idle:duration(totals.idle),open_claims:metric(openClaims,'count')},
    utilization:{working_over_claimed:rolledUp?unknown('rolled up'):ratio(totals.working,totals.claimed,'ratio','no claimed time in the window')},
    lane_utilization:laneUtilization(store,laneCapacity,nowMs,firstEventMs,rolledUpBefore),
    throughput:{completed:metric(completedTotal,'count'),per_day:metric(Math.round(completedTotal/days*100)/100,'count/day'),by_kind:Object.fromEntries(Object.entries(byKind).map(([k,n])=>[k,metric(n,'count')])),by_day:byDay},
    rework:repeated('rework'),
    duplicates:repeated('duplicates'),
    objective_coverage:coverage.total?{value:Math.round(coverage.keyed/coverage.total*1000)/1000,unit:'ratio',keyed:coverage.keyed,total:coverage.total,by_source:coverage.by_source}:unknown('no assignment was submitted in the window'),
    // Output filed after cancel. Not a completion: throughput counts results only; late reports before migration 42 stay counted as completed.
    late_evidence:metric(db.prepare('SELECT count(*) n FROM late_evidence WHERE created_at>=?').get(sinceText).n,'count'),
    orphaned_claims:{current:metric(store.claims().filter(c=>c.expired).length,'count'),lease_expired_takeovers:metric(windowed.filter(e=>e.type==='abandoned'&&/^lease_expired\b/.test(e.reason??'')).length,'count'),abandoned:metric(count('abandoned'),'count')},
    checks:{passed:metric(passed,'count'),failed:metric(failed,'count'),skipped:metric(skipped,'count'),pass_rate:ratio(passed,passed+failed+skipped,'ratio','no check passed, failed or skipped in the window'),started:metric(count('check_started'),'count')},
    acceptance:{finished:metric(finished,'count'),accepted:metric(verdicts.accepted,'count'),rejected:metric(verdicts.rejected,'count'),consumed_only:metric(verdicts.consumed_only,'count'),unknown:metric(verdicts.unknown,'count'),
      accept_rate:ratio(verdicts.accepted,verdicts.accepted+verdicts.rejected,'ratio','no owner accept or reject in the window'),integrated:metric(count('integrated'),'count')},
    notes,
  };
}

const show=(m,format=x=>x)=>m?.value==null?'unknown':format(m.value);
const minutes=ms=>ms<60000?`${Math.round(ms/1000)}s`:`${Math.round(ms/6000)/10}m`, percent=x=>`${Math.round(x*1000)/10}%`;
const laneText=l=>['24h','7d'].map(w=>{ const x=l[`last_${w}`], cover=x.window.covered_fraction<1?`,covered ${percent(x.window.covered_fraction)}`:''; return `util${w}=${show(x.utilization,percent)}(of ${l.lanes.value} lanes${cover}) idle_while_queued${w}=${show(x.idle_while_queued,percent)} iwq_waiting${w}=${show(x.idle_while_waiting_queued,percent)}(break:${show(x.idle_while_waiting_by_cause.owner_break,percent)},worker_inactive:${show(x.idle_while_waiting_by_cause.worker_inactive,percent)},worker_active:${show(x.idle_while_waiting_by_cause.worker_active,percent)}) idle_no_queue${w}=${show(x.queue_empty,percent)}`; }).join(' ');
export function explainMetrics(m) {
  return `metrics(since=${m.window.since}) queue_latency=p50:${show(m.queue_latency.p50,minutes)},p90:${show(m.queue_latency.p90,minutes)},n=${show(m.queue_latency.n)} claim_to_activity=p50:${show(m.claim_to_first_activity.p50,minutes)} `+
    `working/claimed=${show(m.utilization.working_over_claimed,percent)} ${laneText(m.lane_utilization)} completed=${show(m.throughput.completed)}(${show(m.throughput.per_day)}/day) `+
    `checks=passed:${show(m.checks.passed)},failed:${show(m.checks.failed)},skipped:${show(m.checks.skipped)} acceptance=accepted:${show(m.acceptance.accepted)},rejected:${show(m.acceptance.rejected)},consumed_only:${show(m.acceptance.consumed_only)},unknown:${show(m.acceptance.unknown)} `+
    `resumed=${Object.entries(m.resume_wake?.by_worker??{}).map(([w,r])=>`${w}:${r.resumed.value}/expiry:${r.lease_expiry_retries.value}/ttf_resumed_p50:${show(r.time_to_finish_resumed.p50,minutes)}/ttf_expiry_p50:${show(r.time_to_finish_lease_expiry.p50,minutes)}`).join(',')||'none'} duplicate_epochs=${show(m.resume_wake?.duplicate_epoch_claims)} orphaned=${show(m.orphaned_claims.current)} rework=${show(m.rework)} duplicates=${show(m.duplicates)} objective_coverage=${m.objective_coverage?.total?`${m.objective_coverage.keyed}/${m.objective_coverage.total}`:'unknown'}`;
}
