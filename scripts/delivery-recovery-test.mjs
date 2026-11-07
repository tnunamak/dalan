#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AckLedger } from '../src/ack-ledger.mjs';
import { createT3Destination } from '../src/destinations/t3.mjs';
import { Store } from '../src/store.mjs';
import { harness } from './fault-cancel-finish-e2e.mjs';

const dir=await mkdtemp(join(tmpdir(),'dalan-bridge-delivery-recovery-'));
try {
  const file=join(dir,'acks.db'),ledger=new AckLedger(file);
  assert.equal((await stat(file)).mode&0o777,0o600,'new proof ledger is private at creation');
  const key=ledger.key('event-1','stable body','webhook\0worker-a\0environment-a');
  assert.equal(ledger.has(key),false,'absence is not positive evidence');
  ledger.record(key,'2026-10-27T12:00:00.000Z');
  assert.equal(ledger.has(key),true,'accepted ACK is durable');
  assert.equal(ledger.has(ledger.key('event-1','changed body','webhook\0worker-a\0environment-a')),false,'body change cannot reuse proof');
  assert.equal(ledger.has(ledger.key('event-1','stable body','webhook\0worker-b\0environment-a')),false,'worker change cannot reuse proof');
  assert.equal(ledger.has(ledger.key('event-1','stable body','webhook\0worker-a\0environment-b')),false,'environment change cannot reuse proof');
  let sends=0;
  let target={request_id:'req_test',status:'claimed',target_worker:'worker-a',thread_id:'thread-a',environment_id:'environment-a',report:{outcome:'completed',summary:'first summary'}};
  const t3=createT3Destination({store:{get:()=>target,paused:()=>false},ackLedger:ledger,quiet:()=>null,inspectThread:async()=>({state:'active'}),callT3:async()=>{sends++;}});
  const item={id:'t3-event',kind:'t3',request_id:'req_test'},attempt={attempts:0};
  assert.equal((await t3.send(item,{started:attempt,argv:['threads','send']})).state,'delivered');
  assert.equal((await t3.send(item,{started:attempt,argv:['threads','send']})).reason,'recovered from durable T3 acceptance acknowledgment');
  assert.equal(sends,1,'matching T3 positive ACK prevents another transport');
  target={...target,target_worker:'worker-b'};
  await t3.send(item,{started:attempt,argv:['threads','send']});
  assert.equal(sends,2,'changed T3 worker binding requires a new transport');
  target={...target,report:{...target.report,summary:'changed summary'}};
  await t3.send(item,{started:attempt,argv:['threads','send']});
  assert.equal(sends,3,'changed T3 body requires a new transport');
  ledger.close();
  await chmod(file,0o644);
  assert.throws(()=>new AckLedger(file),/mode 0600/,'loose proof ledger fails closed');
  await rm(file);
  const corrupt=join(dir,'corrupt.db'); await writeFile(corrupt,'not sqlite');
  await chmod(corrupt,0o600);
  assert.throws(()=>new AckLedger(corrupt),/unavailable|integrity/i,'corrupt proof ledger fails closed');

  const h=await harness('uncertainty-age');
  try {
    await h.start(); const f=h.fixture(); await h.submit(f);
    const claim=await h.tool('claim',{request_id:f.id,claimant:'age-test',acquisition_id:'age-test-run'});
    await h.tool('finish',{request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'age test',result:'done'});
    await h.waitFor(async()=>(await h.get(f.id)).delivery.some(n=>n.kind==='t3'&&n.state==='delivered'),'initial owner notice');
    await h.stop();
    const fake=join(h.home,'bin/t3code');
    const originalFakeSource=await readFile(fake,'utf8');
    const fakeSource=originalFakeSource.replace("else if(args.includes('read')) {", "else if(args.includes('read')) { fs.appendFileSync(path.join(process.env.HOME,'reads.txt'),'read\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);");
    assert.notEqual(fakeSource,originalFakeSource,'slow fake read was installed');
    await writeFile(fake,fakeSource,{mode:0o755});
    await rm(join(h.home,'.local/share/dalan/delivery-acks.db'),{force:true});
    await rm(join(h.home,'.local/share/dalan/delivery-acks.db-wal'),{force:true});
    await rm(join(h.home,'.local/share/dalan/delivery-acks.db-shm'),{force:true});
    const probeAt=new Date().toISOString();
    h.inspect(s=>s.db.prepare("UPDATE notifications SET state='uncertain',attempt_started_at=?,attempt_id='manual-probe-attempt',last_reconciled_at=NULL,next_at=0 WHERE request_id=? AND kind='t3'").run(probeAt,f.id));
    await h.start();
    // The startup tick did only a sidecar check. Reset its observation stamp
    // so the independent manual-path concurrency probe is eligible now.
    h.inspect(s=>s.db.prepare("UPDATE notifications SET last_reconciled_at=NULL,next_at=0 WHERE request_id=? AND kind='t3'").run(f.id));
    assert.equal(await readFile(join(h.home,'reads.txt'),'utf8').then(()=>true,()=>false),false,'periodic recovery never polls the full T3 transcript');
    const operatorKey=(await readFile(join(h.home,'.config/dalan/operator.key'),'utf8')).trim();
    const replies=await Promise.all([
      h.admin('/reconcile',{id:f.id},{'x-operator-key':operatorKey}),
      h.admin('/reconcile',{id:f.id},{'x-operator-key':operatorKey})
    ]);
    assert.ok(replies.every(response=>response.status===200),'manual reconcile remains available');
    await h.waitFor(async()=>(await h.get(f.id)).delivery.some(n=>n.kind==='t3'&&n.state==='delivered'),'manual transcript reconciliation');
    assert.equal((await readFile(join(h.home,'reads.txt'),'utf8')).trim().split('\n').length,1,'startup and concurrent manual probes do not overlap or repeat an observation');
    await h.stop();
    let now=Date.parse('2026-10-27T12:00:00.000Z');
    h.inspect(s=>s.db.prepare("UPDATE notifications SET state='uncertain',attempt_started_at=?,attempt_id='uncertain-attempt',last_reconciled_at=NULL,next_at=0 WHERE request_id=? AND kind='t3'").run(new Date(now-1800000).toISOString(),f.id));
    now-=1;
    const store=new Store(h.dbPath,{now:()=>now});
    assert.equal(store.db.prepare("SELECT next_at FROM notifications WHERE request_id=? AND kind='t3'").get(f.id).next_at,0,'synthetic age setup clears the real-time retry backoff');
    assert.equal(store.uncertainDue(now).request_id,f.id,'the oldest due unknown is selected');
    const current=store.uncertainDue(now);
    const assignment=store.db.prepare('SELECT status,delivery delivery_mode,thread_id,environment_id,target_worker FROM assignments WHERE request_id=?').get(f.id);
    const report=store.db.prepare('SELECT outcome,summary,result FROM reports WHERE request_id=?').get(f.id)??null;
    const fence={attemptId:current.attempt_id,attemptStartedAt:current.attempt_started_at,body:current.body,argv:current.argv,threadId:assignment.thread_id,environmentId:assignment.environment_id,targetWorker:assignment.target_worker,assignmentStatus:assignment.status,deliveryMode:assignment.delivery_mode,reportSnapshot:JSON.stringify(report)};
    assert.equal(store.reconciled(current.id,'delivered','late result',{...fence,attemptId:'different-attempt'}),false,'late result from a stale attempt is fenced');
    for(const [label,sql,args] of [
      ['attempt','UPDATE notifications SET attempt_id=? WHERE id=?',['changed-attempt',current.id]],
      ['body','UPDATE notifications SET body=? WHERE id=?',['changed-body',current.id]],
      ['report body','UPDATE reports SET summary=? WHERE request_id=?',['changed-report',f.id]],
      ['target','UPDATE assignments SET target_worker=? WHERE request_id=?',['changed-worker',f.id]],
      ['state','UPDATE notifications SET state=? WHERE id=?',['pending',current.id]],
    ]) {
      if(label==='target') store.db.exec('DROP TRIGGER assignments_target_worker_immutable');
      store.db.prepare(sql).run(...args);
      const before=store.db.prepare('SELECT state,last_reconciled_at,next_at FROM notifications WHERE id=?').get(current.id);
      assert.equal(store.reconciled(current.id,'delivered','late result',fence),false,`captured ${label} change is fenced`);
      assert.deepEqual(store.db.prepare('SELECT state,last_reconciled_at,next_at FROM notifications WHERE id=?').get(current.id),before,`late ${label} result leaves state and clocks untouched`);
      store.db.prepare("UPDATE notifications SET state='uncertain',attempt_id=?,body=?,attempt_started_at=?,last_reconciled_at=NULL,next_at=0 WHERE id=?").run(fence.attemptId,fence.body,fence.attemptStartedAt,current.id);
      if(label==='target') {
        store.db.prepare('UPDATE assignments SET target_worker=? WHERE request_id=?').run(fence.targetWorker,f.id);
        store.db.exec("CREATE TRIGGER assignments_target_worker_immutable BEFORE UPDATE OF target_worker ON assignments BEGIN SELECT RAISE(ABORT,'assignments.target_worker is immutable'); END");
      }
      if(label==='report body') store.db.prepare('UPDATE reports SET summary=? WHERE request_id=?').run(report.summary,f.id);
    }
    assert.equal(store.uncertainDue(now).request_id,f.id,'stale result left the current attempt untouched');
    store.db.prepare('UPDATE notifications SET attempt_started_at=? WHERE id=?').run('invalid-clock-value',current.id);
    assert.deepEqual(store.releaseAgedUncertain(),[],'invalid persisted attempt time never releases');
    store.db.prepare('UPDATE notifications SET attempt_started_at=? WHERE id=?').run(new Date(now+1).toISOString(),current.id);
    assert.deepEqual(store.releaseAgedUncertain(),[],'future attempt time never releases under a backward clock');
    store.db.prepare('UPDATE notifications SET attempt_started_at=? WHERE id=?').run(fence.attemptStartedAt,current.id);
    now-=60000;
    assert.deepEqual(store.releaseAgedUncertain(),[],'a backward wall clock cannot release before the persisted age boundary');
    now+=60000;
    assert.deepEqual(store.releaseAgedUncertain(),[],'age cap does not fire before 30 minutes');
    const beforeThreshold=new Store(h.dbPath,{now:()=>now});
    assert.deepEqual(beforeThreshold.releaseAgedUncertain(),[],'restart at 29:59.999 must not release early');
    assert.equal(beforeThreshold.get(f.id).delivery.find(n=>n.kind==='t3').attempt_started_at,fence.attemptStartedAt,'restart must preserve the original attempt age');
    beforeThreshold.db.close();
    now+=1;
    const released=store.releaseAgedUncertain();
    assert.equal(released.length,1,'age cap releases once at the threshold');
    assert.equal(store.uncertainDeliveries(f.id),1,'terminal unknown retains its claim-epoch fence');
    assert.equal(store.due().some(n=>n.request_id===f.id),false,'terminal unknown is never resent');
    const delivery=store.get(f.id).delivery.find(n=>n.kind==='t3');
    assert.equal(delivery.state,'uncertain_terminal');
    assert.equal(delivery.attempt_started_at,new Date(now-1800000).toISOString());
    assert.ok(delivery.terminal_at);assert.match(delivery.terminal_reason,/delivery unknown, not proven undelivered/);
    assert.equal(store.db.prepare('SELECT count(*) n FROM uncertain_delivery_alerts WHERE notification_id=?').get(delivery.id).n,1,'release alert is durable and unique');
    assert.equal(store.status().uncertain_terminal_deliveries[0].id,delivery.id,'status exposes terminal ID and reason');
    assert.deepEqual(store.releaseAgedUncertain(),[],'restart/tick cannot alert twice');
    store.db.close();
    const restarted=new Store(h.dbPath,{now:()=>now});
    assert.equal(restarted.get(f.id).delivery.find(n=>n.kind==='t3').state,'uncertain_terminal','terminal state survives restart');
    restarted.db.close();
  } finally { await h.close(); }
  console.log('PASS webhook/T3 ACK matching, body/target binding, fail-closed ledger, slow single-flight manual probe, bounded periodic lookup, age threshold, durable release, gate release and terminal no-retry');
} finally { await rm(dir,{recursive:true,force:true}); }
