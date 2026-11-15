import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, loadRedeliveryLimits } from './store.mjs';

const minute=60000;
function fixture(t) {
  let now=Date.parse('2026-11-13T12:00:00Z');
  const store=new Store(':memory:',{now:()=>now});
  t.after(()=>store.db.close());
  const at=new Date(now).toISOString();
  // Persist real rows so the liveness SELECT must include last_tool_at.
  store.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,target_worker) VALUES(?,?,?,?,?,'claimed',?,'dot')")
    .run('idle-test','{}','fixture','','',at);
  store.db.prepare("INSERT INTO claims(request_id,claimant,claim_id,claimed_at,subject,worker,state,last_claim_activity_at,lease_ms,lease_deadline_at) VALUES(?,?,?,?,?,'dot','active',?,?,?)")
    .run('idle-test','test-worker','test-claim',at,'local-principal',at,60*minute,new Date(now+60*minute).toISOString());
  const row=()=>store.db.prepare('SELECT * FROM claims WHERE request_id=?').get('idle-test');
  return {store,row,advance:n=>{now+=n;},stamp:()=>new Date(now).toISOString()};
}

test('status reports a 20-minute idle claim despite a live lease, without mutating it',t=>{
  const f=fixture(t);f.advance(20*minute);
  // A lease touch alone is not progress or a recorded tool call.
  f.store.db.prepare('UPDATE claims SET last_claim_activity_at=?,lease_deadline_at=? WHERE request_id=?')
    .run(f.stamp(),'2026-11-13T14:00:00Z','idle-test');
  const before=f.row();
  const status=f.store.status();
  assert.equal(status.stale_claims.count,1);
  assert.equal(status.stale_claims.threshold_ms,15*minute);
  assert.equal(status.stale_claims.max_idle_ms,20*minute);
  assert.deepEqual(status.stale_claims.items,[{
    request_id:'idle-test',idle_ms:20*minute,last_progress_at:null,last_tool_at:null,
  }]);
  assert.deepEqual(status.by_worker.dot.stale_claims,status.stale_claims);
  assert.deepEqual(f.row(),before);
  assert.deepEqual({...f.store.db.prepare('SELECT status,cancelled_at FROM assignments WHERE request_id=?').get('idle-test')},{status:'claimed',cancelled_at:null});
});

test('an assignment tool call two minutes ago keeps a 20-minute-old claim fresh',t=>{
  const f=fixture(t);f.advance(18*minute);
  f.store.db.prepare('UPDATE claims SET last_tool_at=? WHERE request_id=?').run(f.stamp(),'idle-test');
  f.advance(2*minute);
  assert.equal(f.store.status().stale_claims.count,0);
  assert.equal(f.store.status().stale_claims.max_idle_ms,null);
});

test('recent progress independently keeps a claim fresh',t=>{
  const f=fixture(t);f.advance(18*minute);
  f.store.db.prepare('UPDATE claims SET last_progress_at=? WHERE request_id=?').run(f.stamp(),'idle-test');
  f.advance(2*minute);
  assert.equal(f.store.status().stale_claims.count,0);
});

test('threshold is configurable and exact boundary is stale',t=>{
  const f=fixture(t);f.advance(20*minute);
  assert.equal(f.store.status({limits:{...f.store.limits,claimIdleWarningMs:21*minute}}).stale_claims.count,0);
  assert.equal(f.store.status({limits:{...f.store.limits,claimIdleWarningMs:20*minute}}).stale_claims.count,1);
});

test('post-start hold and future lease do not suppress idle observations',t=>{
  const f=fixture(t);f.advance(20*minute);
  f.store.startedMs=f.store.nowMs();
  assert.equal(f.store.heldAfterStart(f.row()),true);
  assert.equal(f.store.leaseExpired(f.row()),false);
  assert.equal(f.store.status().stale_claims.count,1);
});

test('terminal claims are not counted',t=>{
  const f=fixture(t);f.advance(20*minute);
  f.store.db.prepare("UPDATE assignments SET status='finished' WHERE request_id=?").run('idle-test');
  assert.equal(f.store.status().stale_claims.count,0);
});

test('idle warning configuration defaults, validates, and is distinct from legacy lease setting',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-idle-warning-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'limits.json');
  assert.equal(loadRedeliveryLimits(file).claimIdleWarningMs,15*minute);
  fs.writeFileSync(file,JSON.stringify({claim_idle_warning_ms:20*minute,stale_claim_ms:60*minute}),{mode:0o600});
  const limits=loadRedeliveryLimits(file);
  assert.equal(limits.claimIdleWarningMs,20*minute);
  assert.equal(limits.leaseMs,60*minute);
  for(const value of [0,-1,1.5,'900000',604800001]) {
    fs.writeFileSync(file,JSON.stringify({claim_idle_warning_ms:value}));
    assert.throws(()=>loadRedeliveryLimits(file),/invalid claim_idle_warning_ms/);
  }
});
