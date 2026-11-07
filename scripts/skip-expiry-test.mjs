#!/usr/bin/env node
// Skip expiry at store level with an injected clock: a queued worker assignment skipped_by_worker for >= 6 h (default) with
// passed_over >= 3 is cancelled with cancelled_reason 'skipped_by_worker' and a lifecycle event; everything else is untouched.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { parseWorkers } from '../src/workers.mjs';

const home=await mkdtemp(join(tmpdir(),'dalan-bridge-skip-expiry-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const MIN=60000,HOUR=3600000;
let now=Date.parse('2026-10-24T00:00:00.000Z');
const iso=ms=>new Date(ms).toISOString();
const payload=id=>({schema_version:1,request_id:id,brief:`skip expiry ${id}`,inputs:[],expected_output:'findings',execution_scope:'read-only'});
const s=new Store(join(home,'s.db'),{now:()=>now,capacity:6,backgroundMaxInFlight:4});
const mark=(id,{at=now,passed=5}={})=>s.db.prepare('UPDATE assignments SET skipped_at=?,passed_over=? WHERE request_id=?').run(iso(at),passed,id);
const submit=(id,target)=>s.submit(payload(id),{mode:'none'},'','owner',false,null,'normal',null,payload(id),null,target);
try {
  for(const id of ['sk_old','sk_young','sk_fewpass','sk_claimed','sk_unmarked']) submit(id);
  mark('sk_old'); mark('sk_young'); mark('sk_fewpass',{passed:2}); mark('sk_claimed');
  const c=s.claim('sk_claimed','dot','local-principal',6);
  now+=5*HOUR+59*MIN;
  assert(s.sweepSkipped().length===0,'swept before 6 h');
  now+=2*MIN; // sk_old is now 6 h 1 min old
  mark('sk_young',{at:now-HOUR});
  s.setPause('maintenance');assert(JSON.stringify(s.sweepSkipped())==='["sk_old"]'&&s.get('sk_old').status==='cancelled','maintenance did not sweep while paused');s.setPause(null);
  assert(s.sweepSkipped().length===0,'sweep not idempotent after resume');
  const got=s.get('sk_old');
  assert(got.status==='cancelled'&&got.cancelled_reason==='skipped_by_worker'&&got.cancelled_at===iso(now),'cancelled with reason: '+JSON.stringify([got.status,got.cancelled_reason]));
  const ev=s.db.prepare("SELECT type,actor,reason FROM lifecycle_events WHERE request_id='sk_old' ORDER BY id DESC LIMIT 1").get();
  assert(ev.type==='cancelled'&&ev.actor==='system'&&ev.reason==='skipped_by_worker','lifecycle: '+JSON.stringify(ev));
  for(const id of ['sk_young','sk_fewpass','sk_unmarked']) assert(s.get(id).status==='queued',id+' was cancelled');
  assert(s.get('sk_claimed').status==='claimed'&&s.claims()[0].claim_id===c.claim_id,'claimed row touched');
  assert(s.sweepSkipped().length===0,'sweep not idempotent');
  log('skipped+passed_over>=3+age>=6h is cancelled as skipped_by_worker (lifecycle cancelled/system), including while paused; younger, passed_over<3, unmarked and claimed rows stay; idempotent');

  // a target other than the default worker is untouched
  const ISS='https://idp.example/realm';
  const t=new Store(join(home,'t.db'),{now:()=>now,capacity:6,backgroundMaxInFlight:4,workers:parseWorkers({workers:{dot:{connections:[{issuer:ISS,subject:'owner',client_id:'c-dot'}]},lark:{connections:[{issuer:ISS,subject:'owner',client_id:'c-lark'}]}}})});
  t.submit(payload('sk_other'),{mode:'none'},'','owner',false,null,'normal',null,payload('sk_other'),null,'lark');
  t.db.prepare("UPDATE assignments SET skipped_at=?,passed_over=9 WHERE request_id='sk_other'").run(iso(now-9*HOUR));
  assert(t.sweepSkipped().length===0&&t.get('sk_other').status==='queued','non-default target swept');
  log('non-default target_worker is untouched');

  // the sender sees it: the get row (what wait reads) carries the reason, and the wait summary does too
  assert(s.get('sk_old').status==='cancelled'&&s.get('sk_old').cancelled_reason==='skipped_by_worker','get row');
  const server=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert(/status==='cancelled'&&row\.cancelled_reason\?\{cancelled_reason/.test(server),'waitSummary lacks cancelled_reason');
  log('get shows cancelled_reason skipped_by_worker; wait summary carries cancelled_reason for cancelled rows (exit 4)');

  // configurable threshold
  const u=new Store(join(home,'u.db'),{now:()=>now,capacity:6,backgroundMaxInFlight:4,skipExpireMs:HOUR});
  u.submit(payload('sk_short'),{mode:'none'},'','owner');
  u.db.prepare("UPDATE assignments SET skipped_at=?,passed_over=3 WHERE request_id='sk_short'").run(iso(now-90*MIN));
  assert(JSON.stringify(u.sweepSkipped())==='["sk_short"]','custom threshold');
  log('skipExpireMs option (DOT_BRIDGE_SKIP_EXPIRE_HOURS) sets the threshold');
} finally { await rm(home,{recursive:true,force:true}); }
