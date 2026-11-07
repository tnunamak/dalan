#!/usr/bin/env node
// Authority ends at D; automatic cleanup may wait until T. This is characterization,
// not a proposal to renew expired authority during a break or process restart.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {parseWorkers} from '../src/workers.mjs';

const dir=mkdtempSync(join(tmpdir(),'dalan-lease-authority-'));
const START=Date.parse('2026-11-03T00:00:00.000Z'), LEASE=60000;
const iso=ms=>new Date(ms).toISOString();
let now=START;
const stores=new Set();
const open=name=>{
  const s=new Store(join(dir,name+'.db'),{now:()=>now,capacity:1,
    resumeIdleMs:0,limits:{leaseMs:LEASE,laneCapacity:1}});
  stores.add(s);return s;
};
const close=s=>{s.db.close();stores.delete(s);};
const payload=id=>({schema_version:1,request_id:id,brief:'lease characterization',
  inputs:[],expected_output:'one result',execution_scope:'read-only'});
const make=(name,{protocol=false}={})=>{
  now=START;
  const s=open(name), p=payload(name);
  if(protocol)p.protocol={profile:'job-v0',source:'test',scope:'read-only',
    policy:'test',destination:'none',retain_until_ms:START+100*LEASE};
  s.submit(p,{mode:'none'},null,'owner');
  const c=s.claim(name,'holder','subject',1,null,'dot',null,LEASE,
    protocol?{key:'claim-1',revision:1}:null);
  assert.equal(s.get(name).claim.lease_deadline_at,iso(START+LEASE));
  return {s,c,id:name,D:START+LEASE};
};
const lane=s=>s.freeLanes('subject','dot',1,1);
const unchanged=(s,id,fn)=>{
  const before=s.get(id);
  fn();
  assert.deepEqual(s.get(id),before,'refusal changed fields, progress, or lifecycle history');
};
const expired=(s,id,c,D)=>{
  assert.equal(s.get(id).claim.lease_expires_at,iso(D),'hard deadline changed');
  unchanged(s,id,()=>assert.throws(()=>s.progress(id,c.claim_id,'too late','subject'),error=>{
    const value=JSON.parse(error.message);
    assert.equal(value.error,'lease_expired');
    assert.equal(value.lease_expires_at,iso(D));
    return true;
  }));
};
const held=(s,id,c)=>{
  unchanged(s,id,()=>assert.deepEqual(s.sweepStaleLeases(),[]));
  assert.equal(s.get(id).status,'claimed');
  assert.equal(s.get(id).claim.claim_id,c.claim_id);
  assert.equal(lane(s),0);
};
const reaped=(s,id)=>{
  assert.deepEqual(s.sweepStaleLeases(),[id]);
  const view=s.get(id);
  assert.equal(view.status,'queued');
  assert.equal(view.claim.state,'abandoned');
  assert.equal(lane(s),1);
  assert.ok(view.lifecycle_events.some(e=>e.type==='abandoned'&&e.actor==='system'&&e.reason.startsWith('lease_expired')));
  assert.deepEqual(s.sweepStaleLeases(),[],'cleanup is idempotent');
};
const beforeDeadline=({s,id,c,D})=>{
  now=D-1;
  assert.equal(s.claims().find(x=>x.request_id===id).expired,false);
  unchanged(s,id,()=>assert.equal(s.assertClaim(id,c.claim_id,'subject').claim_id,c.claim_id));
  held(s,id,c);
};
const pass=text=>console.log('PASS '+text);

try {
  // Successful progress moves an ordinary D; use a separate fixture so the
  // boundary cases below do not accidentally test an already-renewed deadline.
  {
    const {s,id,c,D}=make('live-progress');
    now=D-1;
    assert.equal(s.progress(id,c.claim_id,'still working','subject').recorded,true);
    assert.equal(s.get(id).claim.last_claim_activity_at,iso(now));
    assert.equal(s.get(id).claim.lease_expires_at,iso(now+LEASE));
    now+=LEASE;expired(s,id,c,now);
    close(s);
    pass('ordinary progress at D-1 succeeds and extends D; progress at the new D changes nothing');
  }
  {
    const f=make('no-grace'),{s,id,c,D}=f;
    beforeDeadline(f);now=D;expired(s,id,c,D);reaped(s,id);close(s);
    pass('case 1: no break or restart, D equals T; refusal is immutable and cleanup frees the lane at D');
  }
  {
    const f=make('active-break'),{s,id,c,D}=f;
    now=START+LEASE/2;s.setBreak('test break');
    beforeDeadline(f);now=D;expired(s,id,c,D);reaped(s,id);close(s);
    pass('case 2: an active worker break neither extends the lease nor holds cleanup; the claim is requeued at D');
  }
  {
    const f=make('cleared-break'),{s,id,c,D}=f;
    now=START+LEASE/2;s.setBreak('test break');
    beforeDeadline(f);now=D-1000;s.clearBreak();
    assert.equal(Date.parse(s.get(id).claim.lease_deadline_at),D,'clearing a break moved the deadline');
    now=D;expired(s,id,c,D);reaped(s,id);close(s);
    pass('case 3: clearing a break leaves the persisted deadline alone');
  }
  {
    const f=make('reopen'),{id,c,D}=f;
    let {s}=f;
    beforeDeadline(f);now=D;expired(s,id,c,D);
    const before=s.get(id);close(s);
    now=D+1000;s=open(id);
    assert.deepEqual(s.get(id),before,'reopen changed persistent claim/history');
    expired(s,id,c,D);assert.deepEqual(s.sweepStaleLeases(),[],'no sweep inside the post-start grace');
    now+=LEASE;assert.deepEqual(s.sweepStaleLeases(),[id]);
    assert.equal(s.get(id).status,'queued');close(s);
    pass('case 4: reopening after D preserves the expired deadline and cleanup requeues after the post-start grace');
  }
  for(const clear of [false,true]) {
    const id=clear?'lark-cleared-break':'lark-break',D=START+LEASE;now=START;
    const s=new Store(join(dir,id+'.db'),{now:()=>now,capacity:1,resumeIdleMs:0,limits:{leaseMs:LEASE,laneCapacity:1},
      workers:parseWorkers({workers:{lark:{}}},{builtin:true})});stores.add(s);
    s.submit(payload(id),{mode:'none'},'','owner',false,null,'normal',null,payload(id),null,'lark');
    const c=s.claim(id,'holder','subject',1,null,'lark',null,LEASE,null);
    now=START+LEASE/2;s.setBreak('test break');
    if(clear){now=D-1000;s.clearBreak();}
    now=D-1;unchanged(s,id,()=>assert.deepEqual(s.sweepStaleLeases(),[]));
    assert.equal(s.get(id).claim.claim_id,c.claim_id);
    now=D;assert.deepEqual(s.sweepStaleLeases(),[id]);
    assert.equal(s.get(id).status,'queued');assert.equal(s.get(id).claim.state,'abandoned');close(s);
  }
  pass('case 5: a worker break, active or cleared, gives a claim of another worker no cleanup grace; it requeues at D');
  for(const mode of ['break','restart-before-D','restart-after-D']) {
    const f=make('protocol-'+mode,{protocol:true}),{id,c,D}=f;
    let {s}=f;
    now=START+LEASE/2;s.setBreak('test break');
    if(mode==='restart-before-D'){close(s);s=open(id);}
    beforeDeadline({...f,s});
    now=D;expired(s,id,c,D);
    if(mode==='restart-after-D') {
      const before=s.get(id);close(s);now=D+1;s=open(id);
      assert.deepEqual(s.get(id),before);
      expired(s,id,c,D);
    }
    if(mode!=='break') {
      assert.deepEqual(s.sweepStaleLeases(),[],'no sweep inside the post-start grace');
      now+=LEASE;
    }
    reaped(s,id);close(s);
    pass('case 6 ('+mode+'): absolute protocol deadline bypasses the break; after a restart the sweep waits one lease after the restart');
  }
  {
    const f=make('protocol-cleared-break',{protocol:true}),{s,id,c,D}=f;
    now=START+LEASE/2;s.setBreak('test break');
    now=D+1000;
    s.clearBreak();
    assert.equal(Date.parse(s.get(id).claim.lease_deadline_at),D,
      'clearing a break cannot extend a protocol claim deadline');
    expired(s,id,c,D);
    reaped(s,id);
    close(s);
    pass('case 7: clearing a break cannot revive an expired protocol claim');
  }
  {
    const f=make('fresh-after-deadline'),{s,id,c,D}=f;
    beforeDeadline(f);now=D;expired(s,id,c,D);
    const fresh=s.claim(id,'holder','subject',1,null,'dot',null,LEASE);
    assert.notEqual(fresh.claim_id,c.claim_id);
    assert.equal(fresh.epoch,c.epoch+1);assert.equal(fresh.duplicate,false);
    const fenced=()=>unchanged(s,id,()=>assert.throws(
      ()=>s.progress(id,c.claim_id,'renew old epoch','subject'),/claim_superseded/));
    fenced();
    fenced();held(s,id,fresh);
    assert.equal(s.progress(id,fresh.claim_id,'fresh authority','subject').recorded,true);
    close(s);
    pass('case 8: a fresh claim after the deadline gets a new identity; old progress cannot renew either epoch');
  }
} finally {
  for(const s of stores)s.db.close();
  rmSync(dir,{recursive:true,force:true});
}
