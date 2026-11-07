import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import { Store, UNCERTAIN_DELIVERY_MAX_AGE_MS } from '../src/store.mjs';
import { checkAlerts } from '../src/alerts.mjs';
import { harness } from './fault-cancel-finish-e2e.mjs';

const h=await harness('recovery-order',{legacyHome:true});
const failures=[];
async function check(name,fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch(error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
}
try {
  await h.start();
  const f=h.fixture();await h.submit(f);
  const claim=await h.tool('claim',{request_id:f.id,claimant:'order-test',acquisition_id:'order-test-run'});
  await h.tool('finish',{request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'positive evidence',result:'done'});
  await h.waitFor(async()=>(await h.get(f.id)).delivery.some(n=>n.kind==='t3'&&n.state==='delivered'),'recorded positive ACK');
  const queued=h.fixture(),held=h.fixture();
  for(const job of [queued,held])assert.equal((await h.admin('/submit',{delivery:'none',execution:'none',owner_token:job.owner,assignment:job.assignment})).status,200);
  assert((await h.tool('claim',{request_id:held.id,claimant:'retained-holder'})).claim_id);
  const legacyWorkspace=join(h.home,'.tmp/dot-bridge');await mkdir(join(legacyWorkspace,'host-receipts'),{recursive:true});
  await writeFile(join(legacyWorkspace,'host-receipts','continuity'),'retained receipt');
  const logFile=join(h.home,'.local/state/dot-bridge/requests.jsonl'),logSize=(await stat(logFile)).size;
  const sends=await h.sends();
  await h.stop();
  for(const area of ['.config','.local/share','.local/state','.tmp'])await mkdir(join(h.home,area,'dalan'),{recursive:true});

  await check('preserved positive ACK is checked before an aged notice is released as unknown',async()=>{
    h.inspect(s=>s.db.prepare("UPDATE notifications SET state='uncertain',attempt_started_at=?,last_reconciled_at=NULL,next_at=0 WHERE request_id=? AND kind='t3'").run(new Date(Date.now()-31*60000).toISOString(),f.id));
    try {
      await h.start();
      assert.equal((await h.get(queued.id)).status,'queued');assert.equal((await h.get(held.id)).status,'claimed');
      for(const area of ['.config','.local/share','.local/state','.tmp'])assert.deepEqual(await readdir(join(h.home,area,'dalan')),[],'empty sibling received state');
      assert((await stat(logFile)).size>=logSize,'legacy request log disappeared');
      const paths=spawnSync(process.execPath,['bin/dalan.mjs','paths','--workspace-root'],{cwd:new URL('..',import.meta.url),env:{HOME:h.home,PATH:process.env.PATH},encoding:'utf8'});
      assert.equal(paths.status,0,paths.stderr);assert.equal(paths.stdout.trim(),legacyWorkspace);assert.equal(await readFile(join(legacyWorkspace,'host-receipts','continuity'),'utf8'),'retained receipt');
      const row=await h.get(f.id),delivery=row.delivery.find(n=>n.kind==='t3');
      assert.equal(row.status,'finished');
      assert.equal(delivery.state,'delivered','the durable matching positive ACK was discarded by age handling');
      assert.equal(delivery.terminal_at,null);
      assert.deepEqual(await h.sends(),sends,'positive recovery sent a second notice');
      h.inspect(s=>assert.equal(s.db.prepare('SELECT count(*) n FROM uncertain_delivery_alerts').get().n,0,'confirmed delivery created an unknown-delivery alert'));
    } finally { await h.stop(); }
  });

  for(const guard of ['paused','muted']) await check(`${guard} delivery still recognizes preserved positive ACK before age release`,async()=>{
    h.inspect(s=>{
      s.db.prepare("UPDATE notifications SET state='uncertain',attempt_started_at=?,last_reconciled_at=NULL,next_at=0 WHERE request_id=? AND kind='t3'").run(new Date(Date.now()-31*60000).toISOString(),f.id);
      if(guard==='paused')s.setPause('synthetic pause');
      else s.db.prepare('INSERT OR IGNORE INTO assignment_delivery_mutes(request_id,muted_at) VALUES(?,?)').run(f.id,s.stamp());
    });
    try {
      await h.start();
      const notice=(await h.get(f.id)).delivery.find(n=>n.kind==='t3');
      assert.equal(notice.state,'delivered','local positive proof is independent of permission to send');
      assert.equal(notice.terminal_at,null);
      assert.deepEqual(await h.sends(),sends,'a guarded recovery transmitted a new notice');
      h.inspect(s=>assert.equal(s.db.prepare('SELECT count(*) n FROM uncertain_delivery_alerts').get().n,0));
    } finally {
      await h.stop();
      h.inspect(s=>{s.setPause(null);s.db.prepare('DELETE FROM assignment_delivery_mutes WHERE request_id=?').run(f.id);});
    }
  });

  await check('uncertain age alert retries a failed publisher and records success only after acceptance',async()=>{
    const accepted=[],attempts=[];
    let refuse=true;
    const publisher=http.createServer(async(req,res)=>{
      let body='';for await(const part of req)body+=part;
      if(body.startsWith('uncertain_delivery:')) {
        attempts.push(body);
        if(refuse) { refuse=false;res.writeHead(503).end();return; }
        accepted.push(body);
      }
      res.writeHead(200).end();
    });
    h.sockets.add(publisher);
    await new Promise(resolve=>publisher.listen(0,'127.0.0.1',resolve));
    const config=join(h.home,'alerts-test.env');
    await writeFile(config,`NTFY_URL=http://127.0.0.1:${publisher.address().port}/alerts\n`,{mode:0o600});
    const old=process.env.DOT_BRIDGE_ALERTS_FILE;
    process.env.DOT_BRIDGE_ALERTS_FILE=config;
    let store;
    try {
      store=new Store(h.dbPath);
      store.db.prepare("UPDATE notifications SET state='uncertain',terminal_at=NULL,terminal_reason=NULL,attempt_started_at=? WHERE request_id=? AND kind='t3'").run(new Date(Date.now()-31*60000).toISOString(),f.id);
      store.db.prepare('DELETE FROM uncertain_delivery_alerts').run();
      assert.equal(store.releaseAgedUncertain().length,1);
      await writeFile(config,'',{mode:0o600});
      const logical=[];
      await checkAlerts(store,event=>logical.push(event));await checkAlerts(store,event=>logical.push(event));
      assert.equal(store.db.prepare('SELECT published_at FROM uncertain_delivery_alerts').get().published_at,null,'missing external publisher must not count as external acceptance');
      assert.equal(logical.filter(event=>event.message?.startsWith('uncertain_delivery:')).length,1,'one local logical alert episode while publisher is absent');
      store.db.close();store=new Store(h.dbPath);
      await writeFile(config,`NTFY_URL=http://127.0.0.1:${publisher.address().port}/alerts\n`,{mode:0o600});
      await assert.rejects(checkAlerts(store,()=>{}),/ntfy HTTP 503/,'the configured publisher never received this alert');
      const pending=store.db.prepare('SELECT * FROM uncertain_delivery_alerts').get();
      assert.equal(pending.published_at,null,'failed publisher was recorded as successful');
      store.db.close();store=new Store(h.dbPath);
      store.db.exec("CREATE TRIGGER fail_alert_mark BEFORE UPDATE OF published_at ON uncertain_delivery_alerts BEGIN SELECT RAISE(ABORT,'injected publication record failure'); END");
      await assert.rejects(checkAlerts(store,()=>{}),/injected publication record failure/);
      assert.equal(accepted.length,1,'publisher accepted before the local success-record failure');
      store.db.close();store=new Store(h.dbPath);store.db.exec('DROP TRIGGER fail_alert_mark');
      await Promise.all([checkAlerts(store,()=>{}),checkAlerts(store,()=>{})]);
      assert.equal(accepted.length,2,'at-least-once retry after lost local success record');
      assert.equal(attempts.length,3,'one refused transport and two accepted attempts for one episode');
      assert.match(accepted[0],new RegExp(f.id));
      assert.ok(accepted.every(text=>text.includes(`notification ${pending.notification_id}`)),'every transport identifies the same notice');
      assert.equal(store.db.prepare('SELECT count(*) n FROM uncertain_delivery_alerts').get().n,1,'physical retries remain one durable logical episode');
      assert.ok(store.db.prepare('SELECT published_at FROM uncertain_delivery_alerts').get().published_at);
      store.db.close();store=new Store(h.dbPath);
      await checkAlerts(store,()=>{});
      assert.equal(accepted.length,2,'retries stop after success is recorded, including restart');
    } finally {
      store?.db.close();
      if(old===undefined)delete process.env.DOT_BRIDGE_ALERTS_FILE;else process.env.DOT_BRIDGE_ALERTS_FILE=old;
    }
  });

  await check('periodic local ACK batches fairly reach valid overdue rows behind 100 invalid age timestamps',async()=>{
    const h3=await harness('recovery-fairness');
    try {
      await h3.start();const f=h3.fixture();await h3.submit(f);
      const claim=await h3.tool('claim',{request_id:f.id,claimant:'fairness-test',acquisition_id:'fairness-test-run'});
      await h3.tool('finish',{request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'fairness',result:'done'});
      await h3.waitFor(async()=> (await h3.get(f.id)).delivery.some(n=>n.kind==='t3'&&n.state==='delivered'),'initial fairness owner notice');
      await h3.stop();
      const age=new Date(Date.now()-31*60000).toISOString();
      const invalidCreated=new Date(Date.now()-2*60*60000).toISOString();
      h3.inspect(s=>{
        const insert=s.db.prepare("INSERT INTO notifications(id,kind,request_id,state,created_at,attempt_started_at,attempt_id,next_at) VALUES(?,'t3',?,'uncertain',?,?,?,0)");
        for(let i=0;i<100;i++) insert.run(`notice_invalid_${String(i).padStart(3,'0')}`,f.id,invalidCreated,'invalid-clock-value',`bad-age-${i}`);
        insert.run('notice_valid_overdue',f.id,new Date().toISOString(),age,'valid-age-attempt');
      });
      for(let batch=0;batch<5;batch++) {
        await h3.start();
        await h3.waitFor(()=>h3.inspect(s=>s.db.prepare("SELECT count(*) n FROM notifications WHERE state='uncertain_terminal' AND id='notice_valid_overdue'").get().n===1)||
          h3.inspect(s=>s.db.prepare("SELECT count(*) n FROM notifications WHERE id LIKE 'notice_invalid_%' AND last_reconciled_at IS NOT NULL").get().n>batch*25),'local reconciliation batch').catch(error=>{
            const state=h3.inspect(s=>({updated:s.db.prepare("SELECT count(*) n FROM notifications WHERE id LIKE 'notice_invalid_%' AND last_reconciled_at IS NOT NULL").get().n,batch:s.uncertainBatch().map(row=>row.id),uncertain:s.db.prepare("SELECT id,next_at,last_reconciled_at FROM notifications WHERE id LIKE 'notice_%' ORDER BY id LIMIT 4").all()}));
            throw new Error(error.message+' '+JSON.stringify(state));
          });
        await h3.stop();
      }
      const valid=h3.inspect(s=>s.db.prepare('SELECT state,attempt_started_at,terminal_reason FROM notifications WHERE id=?').get('notice_valid_overdue'));
      assert.equal(valid.state,'uncertain_terminal','valid overdue row progresses after bounded batches');
      assert.equal(valid.attempt_started_at,age,'fair probes do not reset original attempt age');
      assert.match(valid.terminal_reason,/delivery unknown, not proven undelivered/);
    } finally { await h3.close(); }
  });

  await check('accepted webhook with failed sidecar proof stays uncertain, never retries, then releases and alerts once',async()=>{
    const h2=await harness('ack-write'),accepted=[];
    const receiver=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const parsed=JSON.parse(body);if(parsed.type==='verification'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({challenge:parsed.challenge}));return;}accepted.push(parsed.eventId);res.writeHead(204).end();});
    h2.sockets.add(receiver);
    try {
      await h2.start();await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
      await h2.rpc('events/subscribe',{name:'assignment.available',arguments:{},delivery:{mode:'webhook',url:`http://127.0.0.1:${receiver.address().port}/hook`,secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
      const ackPath=join(h2.home,'.local/share/dalan/delivery-acks.db'),ackDb=new DatabaseSync(ackPath);
      ackDb.exec("CREATE TRIGGER injected_ack_write_failure BEFORE INSERT ON acknowledgments BEGIN SELECT RAISE(ABORT,'injected proof write failure'); END");ackDb.close();
      const f=h2.fixture();
      const submitted=await h2.admin('/submit',{delivery:'none',owner_token:f.owner,assignment:f.assignment});
      assert.equal(submitted.status,200,'quiet requester submission must not require a T3 binding');
      await h2.waitFor(async()=>{const row=await h2.get(f.id);return row.delivery.some(n=>n.kind==='event'&&n.state==='uncertain');},'uncertain webhook after ACK proof write failure');
      const event=h2.inspect(s=>s.db.prepare("SELECT * FROM notifications WHERE request_id=? AND kind='event' ORDER BY created_at DESC LIMIT 1").get(f.id));
      assert.equal(accepted.filter(id=>id===event.id).length,1,'fake receiver accepted the callback exactly once');
      assert.equal(event.attempt_id!==null,true,'last attempt ID is durable');assert.equal(event.attempt_started_at!==null,true,'last attempt time is durable');
      assert.match(event.uncertain_reason,/acknowledgment ledger write failed/);
      assert.ok(!JSON.stringify(event).includes('whsec_'),'webhook secret absent from durable uncertain row');
      await h2.stop();await h2.start();
      await new Promise(resolve=>setTimeout(resolve,750));
      assert.deepEqual(accepted.filter(id=>id===event.id),[event.id],'restart does not blindly resend a possibly accepted callback');
      await h2.stop();
      const eventAge=new Date(Date.now()-UNCERTAIN_DELIVERY_MAX_AGE_MS).toISOString(),ledgerPath=join(h2.home,'.local/share/dalan/delivery-acks.db');
      h2.inspect(s=>s.db.prepare('UPDATE notifications SET attempt_started_at=?,last_reconciled_at=NULL,next_at=0 WHERE id=?').run(eventAge,event.id));
      const unreadable=new DatabaseSync(ledgerPath);unreadable.exec('DROP TABLE acknowledgments; CREATE TABLE acknowledgments(unrelated TEXT)');unreadable.close();
      await h2.start();await new Promise(resolve=>setTimeout(resolve,500));
      h2.inspect(s=>{assert.equal(s.db.prepare('SELECT state FROM notifications WHERE id=?').get(event.id).state,'uncertain','unreadable positive proof cannot turn unknown into terminal');assert.equal(s.db.prepare('SELECT count(*) n FROM uncertain_delivery_alerts').get().n,0,'unreadable proof does not publish a terminal alert');});
      await h2.stop();
      const restored=new DatabaseSync(ledgerPath);restored.exec('DROP TABLE acknowledgments');restored.close();
      await h2.start();
      await h2.waitFor(async()=> (await h2.get(f.id)).delivery.some(n=>n.id===event.id&&n.state==='uncertain_terminal'),'recovered proof store permits age policy');
      await h2.stop();
      const store=new Store(h2.dbPath);
      const terminal=store.db.prepare('SELECT state,attempt_id,attempt_started_at,terminal_reason FROM notifications WHERE id=?').get(event.id);
      assert.equal(terminal.state,'uncertain_terminal');assert.equal(terminal.attempt_id,event.attempt_id);assert.equal(terminal.attempt_started_at,eventAge);
      assert.match(terminal.terminal_reason,/delivery unknown, not proven undelivered/);
      assert.deepEqual(store.pendingDeliveryAlerts().map(a=>[a.request_id,a.notification_id]),[[f.id,event.id]],'alert durably links request and notice IDs');
      const alerts=[],publisher=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;if(body.startsWith('uncertain_delivery:'))alerts.push(body);res.writeHead(200).end();});
      h2.sockets.add(publisher);await new Promise(resolve=>publisher.listen(0,'127.0.0.1',resolve));
      const config=join(h2.home,'event-alerts.env');await writeFile(config,`NTFY_URL=http://127.0.0.1:${publisher.address().port}/alerts\n`,{mode:0o600});
      const old=process.env.DOT_BRIDGE_ALERTS_FILE;process.env.DOT_BRIDGE_ALERTS_FILE=config;
      try { await checkAlerts(store,()=>{});await checkAlerts(store,()=>{}); }
      finally { if(old===undefined)delete process.env.DOT_BRIDGE_ALERTS_FILE;else process.env.DOT_BRIDGE_ALERTS_FILE=old; }
      assert.equal(alerts.length,1,'one informational publisher alert requires no operator action');assert.match(alerts[0],/delivery unknown, not proven undelivered/);assert.match(alerts[0],/No action is required/);
      assert.equal(store.get(f.id).status,'queued','terminal notice does not change request or owner capability state');
      assert.deepEqual(accepted.filter(id=>id===event.id),[event.id],'terminal callback never retries');
      assert.deepEqual(await h2.sends(),[],'quiet webhook recovery must not send a T3 message');
      store.db.close();
    } finally { await h2.close(); }
  });

  await check('late accepted owner notice after terminal release is harmless and full report remains owner-readable',async()=>{
    const h4=await harness('late-owner-notice');
    try {
      await h4.start();const f=h4.fixture();await h4.submit(f);
      const fake=join(h4.home,'bin/t3code'),source=await readFile(fake,'utf8');
      const acceptedButReplyLost=source.replace("console.log(JSON.stringify({ok:true,data:{sent:true}}));","console.error('synthetic accepted notice reply lost');process.exitCode=1;");
      assert.notEqual(acceptedButReplyLost,source,'synthetic delayed receiver failure installed');await writeFile(fake,acceptedButReplyLost,{mode:0o755});
      const claim=await h4.tool('claim',{request_id:f.id,claimant:'late-notice-test',acquisition_id:'late-notice-run'});
      await h4.tool('finish',{request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'retained owner report',result:'full result remains available'});
      await h4.waitFor(async()=> (await h4.get(f.id)).delivery.some(n=>n.kind==='t3'&&n.state==='uncertain'),'ambiguous accepted owner notice');
      const accepted=(await h4.sends()).find(message=>message.includes(`dalan get ${f.id} --json`));
      assert.ok(accepted,'fake receiver retained the accepted owner notice');
      await h4.stop();
      h4.inspect(s=>s.db.prepare("UPDATE notifications SET attempt_started_at=?,last_reconciled_at=NULL,next_at=0 WHERE request_id=? AND kind='t3'").run(new Date(Date.now()-31*60000).toISOString(),f.id));
      await h4.start();
      await h4.waitFor(async()=> (await h4.get(f.id)).delivery.some(n=>n.kind==='t3'&&n.state==='uncertain_terminal'),'automatic terminal no-retry release');
      const snapshot=()=>h4.inspect(s=>({claim:{...s.db.prepare('SELECT claim_id,epoch FROM claims WHERE request_id=?').get(f.id)},report:{...s.db.prepare('SELECT receipt_id FROM reports WHERE request_id=?').get(f.id)},claimed:s.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(f.id).n,completed:s.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='completed'").get(f.id).n,status:s.get(f.id).status}));
      const before=snapshot();
      // The delayed owner consumes the already-accepted message after release. Its only instruction is read-only report retrieval.
      const owner=await h4.admin(`/get?id=${encodeURIComponent(f.id)}`,null,{'x-owner-capability':f.owner});
      assert.equal(owner.status,200);assert.equal(owner.body.status,'finished');assert.equal(owner.body.report.result,'full result remains available');
      const lateClaim=await h4.tool('claim',{request_id:f.id,claimant:'late-notice-test',acquisition_id:'late-other-run'});
      assert.match(lateClaim.error,/assignment finished/,'late notice cannot start a second acquisition');
      const duplicate=await h4.tool('finish',{request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'retained owner report',result:'full result remains available'});
      assert.equal(duplicate.receipt_id,owner.body.report.receipt_id,'late completion retry must return the existing receipt');
      const after=snapshot();
      assert.deepEqual(after,before,'late owner consumption changes no claim, completion count or assignment state');
      const delivery=owner.body.delivery.find(n=>n.kind==='t3');assert.equal(delivery.state,'uncertain_terminal');
      assert.deepEqual(await h4.sends(),[accepted],'already accepted notice was not sent a second time');
    } finally { await h4.close(); }
  });
} finally { await h.close(); }
assert.equal(failures.length,0,failures.join('; '));
