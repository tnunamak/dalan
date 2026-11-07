import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {dropEmptyPost54FixtureState} from '../src/test-support/pre-worker-fixture.mjs';

const scratch=path.join(process.env.HOME||os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'lease-restart-'));
const file=path.join(root,'bridge.db'),start=Date.parse('2026-11-04T12:00:00Z'),lease=60000,graceMs=lease,iso=ms=>new Date(ms).toISOString();
const payload={schema_version:1,request_id:'legacy-claim',brief:'lease restart',inputs:[],expected_output:'result',execution_scope:'read-only'};
let now=start,store;
try {
  store=new Store(file,{now:()=>now,limits:{leaseMs:lease}});
  store.submit(payload,{mode:'none'},null,'owner');
  store.claim('legacy-claim','worker','subject',1,null,'dot',null,lease);
  const deadline=store.get('legacy-claim').claim.lease_deadline_at;
  assert.equal(Date.parse(deadline),start+lease,'every claim must store its lease deadline');
  store.db.close();store=null;
  now=start+lease;
  store=new Store(file,{now:()=>now,limits:{leaseMs:lease}});
  assert.deepEqual(store.sweepStaleLeases(),[],'a lease that ran out during downtime waits one lease after start');
  now+=graceMs;
  assert.deepEqual(store.sweepStaleLeases(),['legacy-claim'],'restart must not reset an expired lease');
  store.db.close();store=null;

  const legacyFile=path.join(root,'migrated-null-deadline.db');
  now=start;
  store=new Store(legacyFile,{now:()=>now,limits:{leaseMs:lease}});
  store.submit({...payload,request_id:'migrated-null-deadline'},{mode:'none'},null,'owner');
  store.claim('migrated-null-deadline','worker','subject',1,null,'dot',null,lease);
  store.db.prepare('UPDATE claims SET lease_deadline_at=NULL WHERE request_id=?').run('migrated-null-deadline');
  dropEmptyPost54FixtureState(store.db);
  store.db.exec('PRAGMA user_version=55');
  store.db.close();store=null;

  now=start+lease;
  store=new Store(legacyFile,{now:()=>now,limits:{leaseMs:lease}});
  assert.equal(store.db.prepare('SELECT lease_deadline_at FROM claims WHERE request_id=?').get('migrated-null-deadline').lease_deadline_at,iso(start+lease),
    'opening the store backfills the absolute deadline of a legacy claim from its activity and lease');
  now+=graceMs;
  assert.deepEqual(store.sweepStaleLeases(),['migrated-null-deadline'],
    'a migrated NULL deadline uses the legacy activity and lease duration instead of aborting the sweep');
  store.db.close();store=null;

  let wall=start,elapsed=1000;
  const jumpFile=path.join(root,'wall-clock-jump.db');
  const jumpOptions={now:()=>wall,elapsedNow:()=>elapsed,bootId:'test-boot',limits:{leaseMs:lease}};
  store=new Store(jumpFile,jumpOptions);
  store.submit({...payload,request_id:'wall-clock-jump'},{mode:'none'},null,'owner');
  store.claim('wall-clock-jump','worker','subject',1,null,'dot',null,lease);
  wall+=30*24*60*60*1000;elapsed+=lease/2;
  store.db.close();store=null;
  store=new Store(jumpFile,jumpOptions);
  const jumpClaim=store.db.prepare('SELECT * FROM claims WHERE request_id=?').get('wall-clock-jump');
  assert.deepEqual(store.sweepStaleLeases(),[],'a forward wall-clock jump cannot make the lease sweep expire a live claim');
  assert.equal(store.leaseExpired(jumpClaim),false,'a forward wall-clock jump cannot expire a live claim');
  wall-=60*24*60*60*1000;elapsed+=lease/2-1;
  assert.equal(store.leaseExpired(jumpClaim),false,'a backward wall-clock jump cannot extend an elapsed claim before its monotonic deadline');
  elapsed+=1;
  assert.equal(store.leaseExpired(jumpClaim),true,'a backward wall-clock jump cannot extend an elapsed claim');
  wall+=graceMs;elapsed+=graceMs;
  assert.deepEqual(store.sweepStaleLeases(),['wall-clock-jump'],'the lease sweep uses the same monotonic deadline as claim authorization');
  store.db.close();store=null;

  // A claim in flight across the upgrade has no persisted deadline. A break does not move the deadline written for it.
  const breakFile=path.join(root,'break-null-deadline.db');
  now=start;
  store=new Store(breakFile,{now:()=>now,limits:{leaseMs:lease}});
  store.submit({...payload,request_id:'break-null-deadline'},{mode:'none'},null,'owner');
  store.claim('break-null-deadline','worker','subject',1,null,'dot',null,lease);
  store.db.prepare('UPDATE claims SET lease_deadline_at=NULL,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?').run('break-null-deadline');
  store.db.close();store=null;
  now=start+30000;
  store=new Store(breakFile,{now:()=>now,limits:{leaseMs:lease}});
  now=start+40000;store.setBreak('usage limit',iso(now));
  now+=30*60000;store.clearBreak();
  now=start+lease+graceMs;
  assert.deepEqual(store.sweepStaleLeases(),['break-null-deadline'],'a break does not extend the backfilled deadline');
  store.db.close();store=null;

  // A deadline that passed while the bridge was down is not swept until the worker has had its full lease after start.
  const graceFile=path.join(root,'grace.db');
  now=start;
  store=new Store(graceFile,{now:()=>now,limits:{leaseMs:lease}});
  store.submit({...payload,request_id:'grace'},{mode:'none'},null,'owner');
  store.claim('grace','worker','subject',1,null,'dot',null,lease);
  store.db.close();store=null;
  now=start+lease+5*60000;
  store=new Store(graceFile,{now:()=>now,limits:{leaseMs:lease}});
  assert.deepEqual(store.sweepStaleLeases(),[],'no sweep at the first tick after a restart');
  now+=graceMs-1;
  assert.deepEqual(store.sweepStaleLeases(),[],'no sweep inside the grace window');
  now+=1;
  assert.deepEqual(store.sweepStaleLeases(),['grace'],'a lease still stale after the grace is requeued');
  assert.deepEqual(store.sweepStaleLeases(),[],'and only once');
  store.db.close();store=null;

  // A claim with a one-hour lease is held for the full hour after a restart, not just one poll interval: a redeploy that drains
  // for longer than the poll interval must not requeue work a worker is still running.
  const longLease=3600000,longFile=path.join(root,'grace-long.db'),longOpts=()=>({now:()=>now,limits:{leaseMs:longLease}});
  now=start;
  store=new Store(longFile,longOpts());
  store.submit({...payload,request_id:'grace-long'},{mode:'none'},null,'owner');
  store.claim('grace-long','worker','subject',1,null,'dot',null,longLease);
  store.db.close();store=null;
  now=start+longLease+30*60000;
  store=new Store(longFile,longOpts());
  now+=11*60000;
  assert.deepEqual(store.sweepStaleLeases(),[],'a one-hour lease is still held after the 10-minute poll interval');
  now+=longLease-11*60000-1;
  assert.deepEqual(store.sweepStaleLeases(),[],'no sweep until the claim\'s own lease has passed since the start');
  now+=1;
  assert.deepEqual(store.sweepStaleLeases(),['grace-long'],'requeued once after its own lease');
  assert.deepEqual(store.sweepStaleLeases(),[],'and only once');
  store.db.close();store=null;

  // A claim the worker touches after the restart is judged by its own deadline, with no grace.
  const liveFile=path.join(root,'grace-live.db');
  now=start;
  store=new Store(liveFile,{now:()=>now,limits:{leaseMs:lease}});
  store.submit({...payload,request_id:'grace-live'},{mode:'none'},null,'owner');
  store.claim('grace-live','worker','subject',1,null,'dot',null,lease);
  store.db.close();store=null;
  now=start+30000;
  store=new Store(liveFile,{now:()=>now,limits:{leaseMs:lease}});
  store.db.prepare('UPDATE claims SET last_claim_activity_at=?,lease_deadline_at=? WHERE request_id=?').run(iso(now),iso(now+1000),'grace-live');
  now+=1000;
  assert.deepEqual(store.sweepStaleLeases(),['grace-live'],'a claim active since the restart is swept at its own deadline');
  store.db.close();store=null;

  // Startup stamps only claims still in flight. A claim row keeps state 'active' after its job finishes, so an old queue
  // holds thousands of them; stamping those one commit at a time held a real service past its start-up check.
  const doneFile=path.join(root,'finished-claims.db');
  now=start;
  store=new Store(doneFile,{now:()=>now,limits:{leaseMs:lease}});
  for(const id of ['still-claimed','long-finished','long-cancelled']) {
    store.submit({...payload,request_id:id},{mode:'none'},null,'owner');
    store.claim(id,'worker','subject',3,null,'dot',null,lease);
  }
  store.db.exec("UPDATE assignments SET status='finished' WHERE request_id='long-finished'");
  store.db.exec("UPDATE assignments SET status='cancelled' WHERE request_id='long-cancelled'");
  store.db.exec('UPDATE claims SET lease_deadline_at=NULL,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL');
  store.db.close();store=null;
  store=new Store(doneFile,{now:()=>now,elapsedNow:()=>5000,bootId:'next-boot',limits:{leaseMs:lease}});
  const stamps=Object.fromEntries(store.db.prepare('SELECT request_id,state,lease_deadline_at,lease_boot_id FROM claims').all().map(row=>[row.request_id,row]));
  assert.equal(stamps['still-claimed'].lease_deadline_at,iso(start+lease),'a claim in flight gets its deadline at startup');
  assert.equal(stamps['still-claimed'].lease_boot_id,'next-boot','a claim in flight is bound to the new boot');
  for(const id of ['long-finished','long-cancelled']) {
    assert.equal(stamps[id].state,'active','the fixture keeps the old claim row active, as real queues do');
    assert.equal(stamps[id].lease_deadline_at,null,`startup leaves the claim of a ${id.split('-')[1]} job alone`);
    assert.equal(stamps[id].lease_boot_id,null,`startup does not bind the claim of a ${id.split('-')[1]} job to the boot`);
  }
} finally {store?.db.close();fs.rmSync(root,{recursive:true,force:true});}
console.log('PASS persisted claim lease survives restart, migrated NULL deadlines sweep safely, and wall-clock jumps do not change lease authority');
