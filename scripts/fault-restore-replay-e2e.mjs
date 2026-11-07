#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { harness } from './fault-cancel-finish-e2e.mjs';

// The receiver ledger intentionally survives the bridge DB rollback. A stable
// event ID permits deduplication; it does not prove ChatGPT uses such a ledger.
async function main() {
  const h=await harness('restore-replay');
  let releaseFirst;
  try {
    await h.start();
    const deliveries=[],logicalWakes=new Set(),key='whsec_'+randomBytes(32).toString('base64');
    let held=true,callbackError;
    const webhook=http.createServer(async(req,res)=>{
      try {
        let raw='';for await(const chunk of req)raw+=chunk;
        const signature=createHmac('sha256',Buffer.from(key.slice(6),'base64'))
          .update(req.headers['webhook-id']+'.'+req.headers['webhook-timestamp']+'.'+raw).digest('base64');
        assert.equal(req.headers['webhook-signature'],'v1,'+signature);
        const body=JSON.parse(raw);
        if(body.type==='verification'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({challenge:body.challenge}));return;}
        assert.equal(req.headers['webhook-id'],body.eventId);
        deliveries.push({body,raw});logicalWakes.add(body.eventId);
        if(held){held=false;await new Promise(r=>releaseFirst=r);}
        res.writeHead(204).end();
      } catch(e){callbackError=e;res.writeHead(500).end();}
    });
    h.sockets.add(webhook);
    await new Promise(r=>webhook.listen(0,'127.0.0.1',r));
    const subscription=await h.rpc('events/subscribe',{name:'assignment.available',arguments:{},
      delivery:{mode:'webhook',url:'http://127.0.0.1:'+webhook.address().port+'/hook',secret:key}});
    assert.ok(subscription.id);
    const f=h.fixture();await h.submit(f);
    await h.waitFor(()=>{if(callbackError)throw callbackError;return deliveries.length===1&&releaseFirst;},'first held webhook');
    const eventId=deliveries[0].body.eventId,snapshot=join(h.home,'snapshot.db');
    let callbackSnapshot;
    // VACUUM INTO creates a transactionally consistent SQLite copy including
    // committed WAL content. Copying only the live main .db file would be invalid.
    h.inspect(s=>{
      assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(eventId).state,'sending');
      assert.equal(s.db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get(f.id).n,0);
      s.db.prepare('UPDATE subscriptions SET auth_failures=3 WHERE id=?').run(subscription.id);
      callbackSnapshot={...s.db.prepare('SELECT auth_failures,last_event_2xx_at FROM subscriptions WHERE id=?').get(subscription.id)};
      s.db.prepare('VACUUM INTO ?').run(snapshot);
    });
    releaseFirst();releaseFirst=null;
    await h.waitFor(async()=>(await h.get(f.id)).delivery.some(n=>n.id===eventId&&n.state==='delivered'),'first delivery receipt');
    const oldClaim=await h.tool('claim',{request_id:f.id,claimant:'restore-worker',acquisition_id:'restore-before-snapshot'});
    assert.ok(oldClaim.claim_id,'post-snapshot claim failed');
    await h.stop();
    await rm(h.dbPath+'-wal',{force:true});await rm(h.dbPath+'-shm',{force:true});
    await copyFile(snapshot,h.dbPath);
    await h.start();
    await h.waitFor(async()=>{
      if(callbackError)throw callbackError;
      return (await h.get(f.id)).delivery.some(n=>n.id===eventId&&n.state==='delivered');
    },'restored in-flight event replay');
    assert.equal(deliveries.length,1,'durable positive ACK must prevent replay after main DB restore');
    h.inspect(s=>assert.deepEqual({...s.db.prepare('SELECT auth_failures,last_event_2xx_at FROM subscriptions WHERE id=?').get(subscription.id)},callbackSnapshot,'recovering an old ACK must not invent a fresh callback or clear newer failure evidence'));
    assert.equal(deliveries[0].body.eventId,eventId);
    assert.equal(logicalWakes.size,1,'one actual receiver callback creates one wake');
    // Adversarial control: if the independent ACK evidence is also lost, the
    // bridge cannot infer acceptance from the restored main database.
    const second=h.fixture(),snapshot2=join(h.home,'snapshot-ack-loss.db'); held=true;
    await h.submit(second);
    await h.waitFor(()=>{if(callbackError)throw callbackError;return deliveries.length===2&&releaseFirst;},'second held webhook');
    const eventId2=deliveries[1].body.eventId;
    h.inspect(s=>{assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(eventId2).state,'sending');s.db.prepare('VACUUM INTO ?').run(snapshot2);});
    releaseFirst();releaseFirst=null;
    await h.waitFor(async()=>(await h.get(second.id)).delivery.some(n=>n.id===eventId2&&n.state==='delivered'),'second ACK receipt');
    await h.stop();
    await rm(h.dbPath+'-wal',{force:true});await rm(h.dbPath+'-shm',{force:true});
    await rm(join(h.home,'.local/share/dalan/delivery-acks.db'),{force:true});
    await rm(join(h.home,'.local/share/dalan/delivery-acks.db-wal'),{force:true});
    await rm(join(h.home,'.local/share/dalan/delivery-acks.db-shm'),{force:true});
    await copyFile(snapshot2,h.dbPath); await h.start();
    await h.waitFor(async()=>deliveries.length>=3&&(await h.get(second.id)).delivery.some(n=>n.id===eventId2&&n.state==='delivered'),'ACK-loss retry');
    assert.equal(deliveries.length,3,'losing both DB state and ACK evidence remains at-least-once');
    assert.equal(deliveries[2].body.eventId,eventId2,'ACK-loss retry keeps event ID');
    assert.equal(logicalWakes.size,2,'receiver callback counts are not mock-deduplicated');
    // The ACK-loss control is finished. Leaving it queued creates a fresh wake when the primary claim frees its lane;
    // stopping during that unrelated send would test loss of ACK evidence, rather than a clean acknowledged restart.
    assert.equal((await h.cancel(second)).body.status,'cancelled');
    assert.equal((await h.submit(f)).duplicate,true);
    let row=await h.get(f.id);
    assert.equal(row.status,'queued');assert.ok(!row.claim);
    const staleFinish=await h.tool('finish',{request_id:f.id,claim_id:oldClaim.claim_id,outcome:'completed',summary:'stale',result:'stale'});
    assert.equal(staleFinish.error,'invalid claim','rolled-back claim retained authority');
    const acquisition_id='restore-recovery-run';
    const [claim,retry]=await Promise.all([
      h.tool('claim',{request_id:f.id,claimant:'restore-worker',acquisition_id}),
      h.tool('claim',{request_id:f.id,claimant:'restore-worker',acquisition_id})
    ]);
    assert.ok(claim.claim_id);assert.equal(retry.claim_id,claim.claim_id);
    assert.notEqual(claim.claim_id,oldClaim.claim_id);
    assert.match((await h.tool('claim',{request_id:f.id,claimant:'rival',acquisition_id:'restore-rival'})).error,/"error":"claim_busy"/,'an independent run must remain fenced');
    const args={request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'restored',result:'one authoritative report'};
    const report=await h.tool('finish',args);assert.ok(report.receipt_id);
    await h.waitFor(async()=>(await h.get(f.id)).delivery.some(n=>n.kind==='t3'&&n.state==='delivered'),'restored report delivery');
    assert.equal((await h.tool('finish',args)).receipt_id,report.receipt_id);
    h.inspect(s=>{
      for(const table of ['assignments','claims','reports'])assert.equal(s.db.prepare('SELECT count(*) n FROM '+table+' WHERE request_id=?').get(f.id).n,1);
      assert.equal(s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id=? AND kind='event'").get(f.id).n,1);
      assert.equal(s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id=? AND kind='t3'").get(f.id).n,1);
      assert.equal(s.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    });
    const before=await h.sends();assert.equal(before.length,1);
    const callbacksBeforeCleanRestart=deliveries.map(d=>d.body.eventId);
    h.inspect(s=>{
      for(const id of logicalWakes) assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(id).state,'delivered','clean restart requires positive delivery evidence');
    });
    await h.stop();await h.start();
    await new Promise(r=>setTimeout(r,1100));
    assert.deepEqual(await h.sends(),before,'restart replayed terminal owner wake');
    assert.deepEqual(deliveries.map(d=>d.body.eventId),callbacksBeforeCleanRestart,'clean restart replayed an acknowledged webhook');
    row=await h.get(f.id);assert.equal(row.report.receipt_id,report.receipt_id);
    assert.equal(Object.hasOwn(row.claim,'claim_id'),false,'worker get exposes claim_id');
    assert.equal(Object.hasOwn(row.claim.activity,'acquisition_id'),false,'worker get exposes acquisition_id');
    assert.equal((await h.ownerGet(f)).claim.claim_id,claim.claim_id,'owner get changed claim identity');
    assert.equal(row.status,'finished');
    console.log('PASS DB-only restore with ACK suppresses callback replay; loss of both DB and ACK replays once (at-least-once); stale-claim fencing and terminal owner-wake preservation');
  } finally {releaseFirst?.();await h.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
