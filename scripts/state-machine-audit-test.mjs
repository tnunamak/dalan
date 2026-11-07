import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { createT3Destination } from '../src/destinations/t3.mjs';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';

const payload=id=>({schema_version:1,request_id:id,brief:'state machine regression',inputs:[],expected_output:'one result',execution_scope:'read-only'});
const question='QUESTION: May I proceed?';
const notices=(store,id)=>store.db.prepare('SELECT * FROM notifications WHERE request_id=? ORDER BY rowid').all(id);
function fixture(t,delivery='none') {
  let now=Date.parse('2026-10-27T12:00:00Z');
  const store=new Store(':memory:',{now:()=>now,resumeIdleMs:120000});
  t.after(()=>store.db.close());
  const id='req_regression';
  store.submit(payload(id),delivery==='none'?{mode:'none'}:'fixture-thread','fixture-environment','owner');
  const claim=store.claim(id,'holder','local-principal',6,null,'dot','fixture-run');
  return {store,id,claim,advance:ms=>{now+=ms;}};
}
const finish=(store,id,claim)=>store.finish(id,claim.claim_id,'completed','done','report');
const counts=(store,id)=>({
  reports:store.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(id).n,
  completed:store.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='completed'").get(id).n,
  results:store.db.prepare('SELECT count(*) n FROM notifications WHERE request_id=? AND body IS NULL').get(id).n,
});

test('C1: slow old failures cannot starve a newer result',t=>{
  let now=Date.parse('2026-10-27T12:00:00Z');
  t.mock.method(Date,'now',()=>now);
  const store=new Store(':memory:',{now:()=>now});t.after(()=>store.db.close());
  const id='req_fair_delivery';
  store.submit(payload(id),'fixture-thread','fixture-environment','owner');
  store.subscribe('sub_fixture','http://127.0.0.1/unused','whsec_fixture',new Date(now+86400000).toISOString());
  const seeded=Array.from({length:20},(_,index)=>{
    const eventId=`event_${String(index).padStart(2,'0')}`;
    const body=JSON.stringify({eventId,name:'assignment.available',data:{request_id:id}});
    store.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,body,state,attempts,created_at) VALUES(?,'event',?,'sub_fixture',?,'failed',6,?)").run(eventId,id,body,new Date(now+index).toISOString());
    return {id:eventId,body};
  });
  now+=20;
  const claim=store.claim(id,'holder');finish(store,id,claim);
  const result=notices(store,id).find(n=>n.kind==='t3'),attempted=[];
  Array.from({length:6}).forEach(()=>{
    store.due().forEach(item=>{
      const started=store.startAttempt(item.id,null);assert.ok(started);
      attempted.push(item.id);
      // Fake transport: every old callback takes the entire 15-second deadline and fails.
      now+=15000;
      store.finishAttempt(item.id,started.attempt_id,item.kind==='event'?'failed':'delivered');
    });
  });
  assert.ok(attempted.indexOf(result.id)>=0&&attempted.indexOf(result.id)<30,'new result was starved by repeatedly due older failures');
  seeded.forEach(original=>{
    const current=notices(store,id).find(n=>n.id===original.id);
    assert.equal(current.body,original.body);assert.equal(current.state,'failed');
  });
  assert.ok(attempted.filter(id=>id===seeded[0].id).length>1,'older failures must keep retrying');
});

test('C2: committed finish retry survives expiry and reopen without granting new writes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-finish-retry-'));
  let now=Date.parse('2026-10-27T12:00:00Z');
  const file=path.join(dir,'bridge.db');let store=new Store(file,{now:()=>now});
  t.after(()=>{store.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const id='req_finished';store.submit(payload(id),{mode:'none'},null,'owner');
  const original=store.claim(id,'holder');
  const originalRow=store.get(id).claim;
  assert.throws(()=>store.resume(id,'local-principal'),/claim_busy: prior lease has not expired/);
  assert.equal(store.get(id).claim.claim_id,original.claim_id,'early resume changed the active grant');
  now=Date.parse(originalRow.last_claim_activity_at)+store.limits.leaseMs+1;
  const claim=store.resume(id,'local-principal');
  const receipt=finish(store,id,claim);
  const activity=store.get(id).claim.last_claim_activity_at,lease=store.limits.leaseMs;
  store.db.close();now+=lease;store=new Store(file,{now:()=>now});
  assert.equal(store.leaseExpired(store.get(id).claim),true);
  const duplicate=finish(store,id,claim);
  assert.equal(duplicate.receipt_id,receipt.receipt_id);assert.equal(duplicate.duplicate,true);
  now++;
  assert.equal(finish(store,id,claim).receipt_id,receipt.receipt_id);
  assert.throws(()=>store.finish(id,claim.claim_id,'failed','done','report'),/contradictory report/);
  assert.throws(()=>store.finish(id,claim.claim_id,'completed','changed','report'),/contradictory report/);
  assert.throws(()=>store.finish(id,claim.claim_id,'completed','done','changed'),/contradictory report/);
  assert.throws(()=>store.finish(id,'wrong-claim','completed','done','report'),/invalid claim|claim_superseded/);
  assert.throws(()=>finish(store,id,original),/claim_superseded/);
  assert.throws(()=>store.finish(id,claim.claim_id,'completed','done','report','other-subject'),/invalid claim/);
  assert.throws(()=>store.finish(id,claim.claim_id,'completed','done','report','local-principal',null,'lark'),/invalid claim/);
  assert.equal(store.get(id).claim.last_claim_activity_at,activity,'read-only duplicate renewed the grant');
  assert.deepEqual(counts(store,id),{reports:1,completed:1,results:1});
  store.submit(payload('req_unfinished'),{mode:'none'},null,'owner');
  const unfinished=store.claim('req_unfinished','holder');now+=lease;
  assert.throws(()=>finish(store,'req_unfinished',unfinished),/lease_expired/);
  assert.deepEqual(counts(store,'req_unfinished'),{reports:0,completed:0,results:0});
});

test('C2: MCP returns the committed receipt after reopening beyond the lease',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-finish-mcp-'));
  const env=fixtureEnv(home,{DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1'});
  const data=path.join(home,'.local/share/dot-bridge');fs.mkdirSync(data,{recursive:true});
  // Commit at an injected earlier clock, then reopen the real MCP service after the deadline.
  const store=new Store(path.join(data,'bridge.db'),{now:()=>Date.now()-2*3600000});
  const id='req_finished_mcp';store.submit(payload(id),{mode:'none'},null,'owner');
  const claim=store.claim(id,'holder');const receipt=finish(store,id,claim);store.db.close();
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('exit',resolve));
  let reopened;
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await closed;}reopened?.db.close();fs.rmSync(home,{recursive:true,force:true});});
  let output='',errors='';child.stderr.on('data',b=>errors+=b);
  const port=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('MCP startup timed out: '+output+errors)),10000);
    child.once('error',reject);child.once('exit',()=>{clearTimeout(timeout);reject(new Error('MCP exited: '+errors));});
    child.stdout.on('data',b=>{
      output+=b;const found=/MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(output);
      if(found){clearTimeout(timeout);resolve(Number(found[1]));}
    });
  });
  const secret=fs.readFileSync(path.join(home,'.config/dot-bridge/env'),'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const call=async args=>{
    const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'finish',arguments:{request_id:id,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'report',...args}}})});
    assert.equal(response.status,200);return (await response.json()).result;
  };
  const reply=await call();assert.equal(reply.isError,false,JSON.stringify(reply));
  const duplicate=JSON.parse(reply.content[0].text);
  assert.equal(duplicate.receipt_id,receipt.receipt_id);assert.equal(duplicate.duplicate,true);
  const changed=await call({result:'changed'});assert.equal(changed.isError,true);assert.match(changed.content[0].text,/contradictory report/);
  assert.equal((await call({claim_id:'wrong-claim'})).isError,true);
  reopened=new Store(path.join(data,'bridge.db'));
  assert.deepEqual(counts(reopened,id),{reports:1,completed:1,results:1});
});

['none','t3'].forEach(delivery=>test(`C3: ${delivery} repeats identical questions after an answer and a new epoch`,async t=>{
  const {store,id,claim,advance}=fixture(t,delivery);let currentClaim=claim;
  const sent=[];
  const destination=createT3Destination({store,quiet:()=>null,inspectThread:async()=>({state:'active'}),callT3:async(argv,text)=>sent.push(text),env:{}});
  const ask=()=>store.progress(id,currentClaim.claim_id,question);
  async function deliver(expected) {
    const cursor=store.deliveryCursor(id);
    ask();ask();
    assert.equal(notices(store,id).length,expected,'question occurrence did not get exactly one notification');
    const pending=notices(store,id).filter(n=>n.state==='pending');assert.equal(pending.length,1);
    if(delivery==='none') {
      const item=store.claimWaiterDelivery(id,cursor);assert.ok(item,'waiter missed the repeated question');
      assert.equal(JSON.parse(item.body).note,question);store.settleWaiterDelivery(item.id);
    } else {
      const item=pending[0],started=store.startAttempt(item.id,null);
      const result=await destination.send(item,{started,argv:destination.argv(item,store.get(id))});
      assert.equal(result.state,'delivered');store.finishAttempt(item.id,started.attempt_id,result.state);
      assert.equal(sent.length,expected);assert.ok(sent.at(-1).includes(question));
    }
    ask();assert.equal(notices(store,id).length,expected,'a delivered retry in the same generation was forwarded again');
  }
  await deliver(1);
  store.note(id,'Proceed with the next decision.');store.markNotesSeen(id,'local-principal');
  await deliver(2);
  const prior=store.get(id).claim;
  assert.throws(()=>store.claim(id,'holder','local-principal',6,null,'dot','next-run'),/"error":"claim_busy"/);
  assert.equal(store.get(id).claim.claim_id,prior.claim_id,'early new epoch changed the active grant');
  advance(Date.parse(prior.last_claim_activity_at)+store.limits.leaseMs+1-Date.parse(prior.last_claim_activity_at));
  currentClaim=store.claim(id,'holder','local-principal',6,null,'dot','next-run');
  assert.equal(currentClaim.epoch,2);await deliver(3);
  assert.equal(store.get(id).progress.filter(p=>p.note===question).length,9);
  assert.equal(store.get(id).owner_notes.length,1);
}));

['none','t3'].forEach(delivery=>test(`C4: finish retires unsent ${delivery} questions and preserves uncertain evidence`,t=>{
  const {store,id,claim}=fixture(t,delivery);
  store.progress(id,claim.claim_id,question);const item=notices(store,id)[0];
  store.db.prepare("UPDATE notifications SET state='failed',next_at=? WHERE id=?").run(Date.now()+60000,item.id);
  store.progress(id,claim.claim_id,'QUESTION: still pending?');
  store.progress(id,claim.claim_id,'QUESTION: acceptance unknown?');
  const uncertain=notices(store,id)[2];store.db.prepare("UPDATE notifications SET state='uncertain',attempt_id='old-attempt' WHERE id=?").run(uncertain.id);
  finish(store,id,claim);
  assert.equal(notices(store,id).find(n=>n.id===item.id).state,'suppressed');
  assert.equal(notices(store,id)[1].state,'suppressed');
  assert.equal(notices(store,id).find(n=>n.id===uncertain.id).state,'uncertain');
  const result=store.claimWaiterDelivery(id,0);assert.equal(result.body,null,'finished result was hidden behind a stale question');
  store.settleWaiterDelivery(result.id);
  store.db.prepare('UPDATE notifications SET next_at=0 WHERE id=?').run(item.id);
  assert.equal(store.startAttempt(item.id,null),null,'retry sent a finished question');
}));

test('C4: start-attempt fences a question on an already finished assignment',t=>{
  const {store,id,claim}=fixture(t,'t3');finish(store,id,claim);
  store.db.prepare("INSERT INTO notifications(id,kind,request_id,body,created_at) VALUES('stale-question','blocker',?,?,?)").run(id,JSON.stringify({note:question}),store.stamp());
  assert.equal(store.startAttempt('stale-question',null),null);
  assert.equal(notices(store,id).find(n=>n.id==='stale-question').state,'suppressed');
});

[0,1,2].forEach(finishAt=>test(`C4: a finish before inspection ${finishAt} prevents the question send`,async t=>{
  const {store,id,claim}=fixture(t,'t3');store.progress(id,claim.claim_id,question);
  const item=notices(store,id)[0],started=store.startAttempt(item.id,null);let inspected=0,sends=0;
  if(finishAt===0)finish(store,id,claim);
  const destination=createT3Destination({store,quiet:()=>null,env:{},callT3:async()=>{sends++;},inspectThread:async()=>{
    inspected++;if(inspected===finishAt){await Promise.resolve();finish(store,id,claim);}return {state:'active'};
  }});
  const result=await destination.send(item,{started,argv:destination.argv(item,store.get(id))});
  assert.equal(result.state,'suppressed');assert.equal(sends,0);
  store.finishAttempt(item.id,started.attempt_id,result.state,result.reason);
  assert.equal(notices(store,id).find(n=>n.id===item.id).state,'suppressed');
}));
