#!/usr/bin/env node
// Resume wake: an idle own claim wakes its worker, list_pending offers a resume entry, claim() rotates the epoch, and the old
// claim_id is fenced. Store level with a fake clock; two Store handles on one database file play the old and the new run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-bridge-resume-'));
process.env.HOME=home; // src/workspace.mjs reads HOME at import
delete process.env.DOT_BRIDGE_RESUME_IDLE_MS;
const { Store, resumeNudge, workerGuidance } = await import('../src/store.mjs');
const { dropEmptyPost54FixtureState } = await import('../src/test-support/pre-worker-fixture.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const { parseWorkers } = await import('../src/workers.mjs');
const { createSignal } = await import('../src/signal.mjs');
const { lifecycleMetrics, explainMetrics } = await import('../src/lifecycle.mjs');
const MIN=60000, IDLE=2*MIN, LEASE=20*MIN; let now=Date.parse('2026-10-24T00:00:00.000Z');
const limits={intervalMs:10*MIN,maxCount:3,silenceMs:20*MIN,leaseMs:LEASE};
const workers=parseWorkers({workers:{lark:{guidance:'resume'},other:{}}},{builtin:true});
const file=path.join(home,'bridge.db');
const open=(extra={})=>new Store(file,{now:()=>now,capacity:6,limits,workers,...extra});
const payload=id=>({schema_version:1,request_id:id,brief:`resume ${id}`,inputs:[],expected_output:'one',execution_scope:'read-only'});
const submit=(s,id,target='lark')=>s.submit(payload(id),{mode:'none'},'','owner',false,null,'normal',null,payload(id),null,target);
const superseded=/claim_superseded/;
const sha=b=>createHash('sha256').update(b).digest('hex');
const pass=m=>console.log(`PASS ${m}`);

// Run the regression scenarios independently so the failing-first transcript shows each defect.
function acquisitionRegressions() {
  const failures=[];
  const check=(name,fn)=>{ try { fn(); pass(name); } catch(error) { failures.push(name); console.log(`FAIL ${name}: ${error.message}`); } };
  const raceFile=path.join(home,'acquisitions.db');
  const a=new Store(raceFile,{now:()=>now,workers,limits}), b=new Store(raceFile,{now:()=>now,workers,limits});
  const claim=(run,acquisition)=>run.claim('req_acquisition','stable-worker','sub',6,null,'lark',acquisition);
  try {
    submit(a,'req_acquisition');
    const c1=claim(a,'original'); now+=IDLE;
    const busy=fn=>assert.throws(fn,error=>{
      const e=JSON.parse(error.message);
      assert.equal(e.error,'claim_busy'); assert.equal(e.request_id,'req_acquisition');
      assert.match(e.message,/req_acquisition.*another run of this worker.*active.*pick other work or retry after its lease expires/i);
      return true;
    },'a different run must never receive the active claim');
    check('acquisition: idle different or omitted ID cannot rotate before expiry',()=>{
      busy(()=>claim(b,'a')); busy(()=>claim(b,undefined));
      const exactRetry=claim(a,'original'); assert.equal(exactRetry.claim_id,c1.claim_id); assert.equal(exactRetry.epoch,1); assert.equal(exactRetry.duplicate,true);
      assert.equal(a.get('req_acquisition').claim.activity.acquisition_id,'original');
    });
    now=Date.parse(a.get('req_acquisition').claim.lease_expires_at); // exact expiry after the live same-ID retry
    const c2=claim(a,'a'); assert.notEqual(c1.claim_id,c2.claim_id); assert.equal(c2.epoch,2);
    check('acquisition: a different acquisition stays busy and exact retry is idempotent',()=>{
      busy(()=>claim(b,'b')); busy(()=>claim(b,undefined));
      const retry=claim(a,'a'); assert.equal(retry.claim_id,c2.claim_id); assert.equal(retry.duplicate,true);
      assert.equal(a.get('req_acquisition').claim.activity.acquisition_id,'a');
    });
    check('acquisition: busy calls do not refresh activity',()=>{
      const idleAt=now+IDLE; now=idleAt;
      busy(()=>claim(b,'b'));
      assert.equal(a.isIdleClaim(a.get('req_acquisition').claim),false,'the unexpired lease is not an idle regrant');
    });
    check('acquisition: expiry rotates to C3 and fences a',()=>{
      now=Date.parse(a.get('req_acquisition').claim.lease_expires_at);
      const c3=claim(b,'b'); assert.notEqual(c3.claim_id,c2.claim_id); assert.equal(c3.epoch,3);
      assert.equal(b.get('req_acquisition').claim.activity.acquisition_id,'b');
      assert.throws(()=>a.progress('req_acquisition',c2.claim_id,'late','sub',false,'lark'),superseded);
      assert.throws(()=>a.finish('req_acquisition',c2.claim_id,'completed','late','late','sub',null,'lark'),superseded);
      assert.equal(b.progress('req_acquisition',c3.claim_id,'current','sub',false,'lark').recorded,true);
    });
    check('acquisition: switch 0 retains keyed fencing',()=>{
      const disabled=new Store(path.join(home,'disabled.db'),{now:()=>now,workers,limits,resumeIdleMs:0});
      try {
        submit(disabled,'req_disabled');
        const first=disabled.claim('req_disabled','stable-worker','sub',6,null,'lark','a');
        for(const acquisition of ['a']) {
          now+=IDLE;
          const retry=disabled.claim('req_disabled','stable-worker','sub',6,null,'lark',acquisition);
          assert.equal(retry.claim_id,first.claim_id); assert.equal(retry.epoch,1); assert.equal(retry.duplicate,true);
        }
        assert.throws(()=>disabled.claim('req_disabled','stable-worker','sub',6,null,'lark','b'),/already claimed by another claimant/);
        assert.throws(()=>disabled.claim('req_disabled','stable-worker','sub',6,null,'lark'),/already claimed by another claimant/);
      } finally { disabled.db.close(); }
    });
    for(const [threshold,interval] of [[120000,'1 minute'],[240000,'2 minutes'],[45000,'30 seconds']]) {
      check(`guidance: threshold ${threshold} gives ${interval}`,()=>{
        const store=new Store(':memory:',{workers,resumeIdleMs:threshold});
        try {
          const text=store.guidanceFor('lark');
          assert.ok(text.includes(`Post progress at least every ${interval} with what is done and what remains`),'heartbeat interval must leave a margin before idle');
          assert.match(text,/Generate one random acquisition_id per run and pass it on every claim call, including retries/);
          assert.doesNotMatch(text,/3 minutes/);
        } finally { store.db.close(); }
      });
    }
    check('unkeyed identity survives restart and rejects rivals and keyed adoption',()=>{
      const db=path.join(home,'unkeyed.db');
      const first=new Store(db,{workers,now:()=>now,limits});
      submit(first,'req_unkeyed');
      const grant=first.claim('req_unkeyed','stable-worker','sub',6,null,'lark');
      first.db.close();
      const restarted=new Store(db,{workers,now:()=>now,limits});
      try {
        const attempt=(claimant,subject,worker,id)=>restarted.claim('req_unkeyed',claimant,subject,6,null,worker,id);
        assert.equal(attempt('stable-worker','sub','lark').claim_id,grant.claim_id);
        assert.throws(()=>attempt('stable-worker','sub','lark','new-run'),/claim_busy/);
        assert.throws(()=>attempt('rival','sub','lark'),/claim_busy/);
        assert.throws(()=>attempt('stable-worker','other-sub','lark'),/another claimant/);
        assert.throws(()=>attempt('stable-worker','sub','other'),/assignment not found|invalid claim/);
        submit(restarted,'req_finish_retry');
        const done=restarted.claim('req_finish_retry','stable-worker','sub',6,null,'lark');
        assert.equal(restarted.finish('req_finish_retry',done.claim_id,'completed','done','done','sub',null,'lark').duplicate,false);
        assert.equal(restarted.finish('req_finish_retry',done.claim_id,'completed','done','done','sub',null,'lark').duplicate,true);
        assert.throws(()=>restarted.claim('req_finish_retry','stable-worker','sub',6,null,'lark'),/finished/);
        restarted.cancel('req_unkeyed');
        assert.throws(()=>attempt('stable-worker','sub','lark'),/cancelled/);
      } finally { restarted.db.close(); }
    });
    check('same acquisition after lease expiry gets a new fenced epoch',()=>{
      let expiredNow=now;
      const expired=new Store(path.join(home,'expired-retry.db'),{workers,now:()=>expiredNow,limits});
      try {
        submit(expired,'req_expired_retry');
        const old=expired.claim('req_expired_retry','stable-worker','sub',6,null,'lark','same-run');
        expiredNow+=LEASE+1;
        const retry=expired.claim('req_expired_retry','stable-worker','sub',6,null,'lark','same-run');
        assert.notEqual(retry.claim_id,old.claim_id,'an expired retry revived its stale claim_id');
        assert.equal(retry.epoch,old.epoch+1,'an expired retry did not fence the stale epoch');
        assert.equal(retry.duplicate,false,'an expired retry was reported as a live-lease duplicate');
        assert.equal(expired.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id='req_expired_retry' AND type='claimed'").get().n,2);
        assert.throws(()=>expired.progress('req_expired_retry',old.claim_id,'stale','sub',false,'lark'),superseded);
      } finally { expired.db.close(); }
    });
    // Migration from main's v42 keeps existing claims usable and leaves their acquisition unknown.
    const migratingFile=path.join(home,'migration.db');
    const migrating=new Store(migratingFile,{workers,now:()=>now});
    submit(migrating,'req_legacy');
    const legacyClaim=migrating.claim('req_legacy','stable-worker','sub',6,null,'lark');
    dropEmptyPost54FixtureState(migrating.db);
    migrating.db.exec('ALTER TABLE claims DROP COLUMN acquisition_id; PRAGMA user_version=42;');
    migrating.db.close();
    const migrated=new Store(migratingFile,{workers,now:()=>now});
    try {
      assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,65);
      assert.equal(migrated.get('req_legacy').claim.activity.acquisition_id,null);
      assert.equal(migrated.get('req_legacy').claim.claim_id,legacyClaim.claim_id);
      assert.equal(migrated.progress('req_legacy',legacyClaim.claim_id,'still valid','sub',false,'lark').recorded,true);
      assert.equal(migrated.claim('req_legacy','stable-worker','sub',6,null,'lark').claim_id,legacyClaim.claim_id);
    } finally { migrated.db.close(); }
    pass('v42 migration preserves claims with null acquisition');
    for(const invalid of ['', 'has spaces', 'x'.repeat(129),42,{}]) assert.throws(()=>claim(a,invalid),/invalid acquisition_id/);
    pass('acquisition ids are short opaque strings');
  } finally { a.db.close(); b.db.close(); }
  assert.deepEqual(failures,[],'resume acquisition regressions');
}


// Exercise the advertised schema and the MCP dispatch path, using a throwaway bridge only.
async function mcpAcquisitions() {
  const serverHome=path.join(home,'mcp'), data=path.join(serverHome,'.local/share/dot-bridge');
  fs.mkdirSync(data,{recursive:true});
  const store=new Store(path.join(data,'bridge.db'));
  store.submit(payload('req_00000000-0000-4000-8000-000000000001'),{mode:'none'},'','owner');
  const listener=createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const child=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,HOME:serverHome,NODE_ENV:'test',DOT_BRIDGE_AUTH_MODE:'',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_RESUME_IDLE_MS:String(IDLE)},stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  let ready=false; child.stdout.on('data',chunk=>{ if(String(chunk).includes('MCP listening')) ready=true; });
  child.stderr.resume();
  try {
    for(let i=0;i<100&&!ready&&child.exitCode===null;i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(ready,'temporary MCP server startup');
    const secret=fs.readFileSync(path.join(serverHome,'.config/dot-bridge/env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const rpc=async(method,params)=>{
      const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      const value=await response.json(); assert.equal(response.status,200); assert.ok(value.result);
      return value.result;
    };
    const call=async(name,args)=>{
      const result=await rpc('tools/call',{name,arguments:args});
      return {error:result.isError===true,value:result.content[0].text};
    };
    const keyedId='req_00000000-0000-4000-8000-000000000001';
    const claimFor=(requestId,acquisition)=>call('claim',{request_id:requestId,claimant:'stable-worker',...(acquisition===undefined?{}:{acquisition_id:acquisition})});
    const claim=acquisition=>claimFor(keyedId,acquisition);
    const catalog=await rpc('tools/list',{}), schema=catalog.tools.find(tool=>tool.name==='claim').inputSchema;
    assert.equal(schema.properties.acquisition_id.maxLength,128);
    assert.equal(schema.required.includes('acquisition_id'),false);
    for(const invalid of ['', 'has spaces', 'x'.repeat(129),42,null]) {
      const result=await claim(invalid); assert.equal(result.error,true); assert.match(result.value,/invalid acquisition_id/);
    }
    const freshId='req_00000000-0000-4000-8000-000000000002';
    store.submit(payload(freshId),{mode:'none'},'','owner');
    const freshFirst=await claimFor(freshId,undefined); assert.equal(freshFirst.error,false,freshFirst.value);
    const freshRetry=await claimFor(freshId,undefined); assert.equal(freshRetry.error,false,freshRetry.value);
    const freshGrant=JSON.parse(freshFirst.value), freshAgain=JSON.parse(freshRetry.value);
    assert.equal(freshAgain.claim_id,freshGrant.claim_id,'fresh omitted-ID MCP retry changed the grant');
    assert.equal(freshAgain.epoch,freshGrant.epoch); assert.equal(freshAgain.duplicate,true);
    assert.equal(store.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(freshId).n,1,'fresh omitted-ID MCP retry added a lifecycle event');
    assert.equal(store.db.prepare('SELECT acquisition_id FROM claims WHERE request_id=?').get(freshId).acquisition_id,null);
    assert.equal((await call('finish',{request_id:freshId,claim_id:freshGrant.claim_id,outcome:'completed',summary:'retry test complete',result:'done'})).error,false,'fresh MCP claim did not finish cleanly');
    const c1=await claim('original'); assert.equal(c1.error,false,c1.value);
    store.db.prepare('UPDATE claims SET last_claim_activity_at=?,lease_deadline_at=?,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?').run(new Date(Date.now()-3600000-1000).toISOString(),new Date(Date.now()-1000).toISOString(),'req_00000000-0000-4000-8000-000000000001');
    const c2=await claim('a'); assert.equal(c2.error,false);
    const current=JSON.parse(c2.value); assert.equal(current.epoch,2);
    for(const acquisition of ['b',undefined]) {
      const result=await claim(acquisition); assert.equal(result.error,true);
      assert.equal(JSON.parse(result.value).error,'claim_busy');
    }
    const retry=await claim('a'); assert.equal(retry.error,false); assert.equal(JSON.parse(retry.value).claim_id,current.claim_id);
    const read=await call('get',{request_id:'req_00000000-0000-4000-8000-000000000001'});
    assert.equal(read.error,false,read.value);
    assert.equal(Object.hasOwn(JSON.parse(read.value).claim.activity,'acquisition_id'),false,'worker get shows the activity acquisition_id');
    assert.equal(store.get('req_00000000-0000-4000-8000-000000000001').claim.activity.acquisition_id,'a');
    pass('MCP: acquisition schema, validation, busy errors, retry and activity survive dispatch');
  } finally {
    child.kill('SIGTERM'); await exited; store.db.close();
  }
}

try {
  acquisitionRegressions();
  const s=open(), oldRun=s, newRun=open(); // two handles on one file
  const ws=new Workspace(s,false);

  // ---- workers.json: the guidance field validates
  assert.throws(()=>parseWorkers({workers:{lark:{guidance:'other'}}},{builtin:true}),/guidance may only be "resume"/);
  assert.throws(()=>parseWorkers({workers:{lark:{guidance:true}}},{builtin:true}),/guidance may only be "resume"/);
  assert.equal(parseWorkers({workers:{lark:{}}},{builtin:true}).workers.get('lark').guidance,undefined);
  pass('workers.json guidance accepts only "resume"');

  // ---- wake bit
  submit(s,'req_a');
  const a1=s.claim('req_a','lark-run-1','sub',6,null,'lark');
  assert.equal(a1.epoch,1); assert.ok(a1.guidance.endsWith(resumeNudge(IDLE)),'lark claim guidance carries the nudge');
  assert.equal(s.guidanceFor('other'),workerGuidance,'a worker without the field gets the plain guidance');
  assert.equal(s.hasWakeFor('lark'),false,'fresh claim: no wake');
  now+=IDLE-1000; assert.equal(s.hasWakeFor('lark'),false,'just inside the threshold: no wake');
  now+=1000; assert.equal(s.hasWakeFor('lark'),false,'idle threshold alone does not permit a regrant');
  s.progress('req_a',a1.claim_id,'still here','sub',false,'lark');
  assert.equal(s.hasWakeFor('lark'),false,'progress resets activity');
  now+=LEASE; assert.equal(s.hasWakeFor('lark'),true,'expired lease wakes the worker');
  assert.equal(s.hasWakeFor('other'),false,"another worker's wake is unaffected by lark's claim");
  submit(s,'req_other','other'); assert.equal(s.hasWakeFor('other'),true,'queued work still wakes its worker');
  const o1=s.claim('req_other','other-run','sub',6,null,'other'); void o1;
  now+=IDLE; assert.equal(s.hasWakeFor('lark'),true,'req_a lease is expired');
  assert.equal(s.hasWakeFor('other'),false,"another worker's fresh lease is not eligible for regrant");
  assert.equal(s.hasWakeFor('lark'),true,'expiry makes the old claim eligible for resume');
  // a long run_check is one tool call: while a check runs for the claim, the claim is busy, not idle
  s.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES('chk_busy','req_a',?,'default','x','running',?)").run(a1.claim_id,new Date(now).toISOString());
  assert.equal(s.hasWakeFor('lark'),false,'a running check keeps the claim busy: no resume wake');
  assert.deepEqual(s.listPending('lark').filter(x=>x.resume),[],'... and no resume entry');
  s.db.prepare("UPDATE check_jobs SET status='completed',stop_verified=1 WHERE id='chk_busy'").run();
  assert.equal(s.hasWakeFor('lark'),true,'once the check ends the expired claim can wake again');
  now+=LEASE; assert.equal(s.hasWakeFor('lark'),true,'expired claims remain eligible until the sweep requeues them');
  now-=LEASE;
  process.env.DOT_BRIDGE_RESUME_IDLE_MS='0';
  assert.equal(s.hasWakeFor('lark'),false,'DOT_BRIDGE_RESUME_IDLE_MS=0 turns the wake off');
  assert.deepEqual(s.listPending('lark').filter(x=>x.resume),[],'... and the resume entries');
  delete process.env.DOT_BRIDGE_RESUME_IDLE_MS;
  assert.equal(s.hasWakeFor('lark'),true);
  pass('wake bit: expired own claim only, per worker, off at 0');

  // ---- signal endpoint: one bit, same cache
  {
    const dir=fs.mkdtempSync(path.join(home,'sig-'));
    const sig=createSignal({dir,store:s,workerNames:()=>['lark','other'],publicUrl:'http://127.0.0.1:1',log:()=>{},now:()=>now});
    const token=sig.tokenUrl({worker:'lark'}).url.split('/signal/')[1];
    const ask=()=>{ now+=11000; let status,body; sig.handle({url:`/signal/${token}`,method:'GET',socket:{remoteAddress:'1.2.3.4'}},{writeHead:c=>{status=c;},end:b=>{body=b;}}); return [status,JSON.parse(body)]; };
    assert.deepEqual(ask(),[200,{work:true}],'the signal answers work:true for an expired claim');
    now+=IDLE; assert.deepEqual(ask(),[200,{work:true}]);
    now+=LEASE-IDLE; assert.deepEqual(ask(),[200,{work:true}]);
    pass('signal: work:true for an idle own claim');
  }

  // ---- list_pending resume entry
  {
    now=Date.parse(s.get('req_a').claim.lease_expires_at);
    const entries=s.listPending('lark'), r=entries[0];
    assert.equal(r.resume,true); assert.equal(r.request_id,'req_a'); assert.equal(r.previous_epoch,1);
    assert.ok(r.idle_seconds>=120); assert.match(r.note,/prior lease expired.*Call claim\(request_id, claimant, acquisition_id\).*new epoch.*get first/i);
    assert.equal(s.listPending('other').some(x=>x.resume&&x.request_id==='req_a'),false,'only the owner sees its resume entries');
    submit(s,'req_queued'); assert.equal(s.listPending('lark')[0].request_id,'req_a','resume entries come before queued work');
    pass('list_pending lists the resume entry first, for its own worker only');
  }

  // ---- rotation: worktree + sealed uploads carry, unsealed does not; old claim fenced everywhere
  {
    const at=s.stamp(), art=s.db.prepare('INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sha256,sealed,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    s.db.prepare('INSERT INTO workspaces(request_id,claim_id,base_sha,path,created_at) VALUES(?,?,?,?,?)').run('req_a',a1.claim_id,'a'.repeat(40),path.join(home,'wt'),at);
    art.run('art_sealed','req_a',a1.claim_id,'upload',path.join(home,'u1'),3,sha('abc'),1,at);
    art.run('art_open','req_a',a1.claim_id,'upload',path.join(home,'u2'),3,null,0,at);
    // a read-only get by the resuming run must not end the idle state
    s.recordToolActivity('req_a','sub','lark','get'); s.markNotesSeen('req_a','sub','lark');
    assert.equal(s.hasWakeFor('lark'),true,'get does not reset the idle clock');
    const queuedBefore=s.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE type='claimed' AND (reason IS NULL OR reason<>'resume')").get().n;
    const exactExpiry=Date.parse(s.get('req_a').claim.lease_expires_at);
    now=exactExpiry-1;
    assert.throws(()=>newRun.claim('req_a','lark-run-2','sub',6,null,'lark','run-2'),/claim_busy/,'different acquisition cannot rotate before expiry');
    now=exactExpiry; // fake clock; no lease-duration sleep
    const b=newRun.claim('req_a','lark-run-2','sub',6,null,'lark','run-2');
    assert.equal(b.epoch,2); assert.equal(b.previous_epoch,1); assert.equal(b.resumed,true); assert.equal(b.duplicate,false);
    assert.notEqual(b.claim_id,a1.claim_id);
    assert.equal(s.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE type='claimed' AND (reason IS NULL OR reason<>'resume')").get().n,queuedBefore,'a resume is not a new admission');
    const ev=s.db.prepare("SELECT epoch,claim_id,reason FROM lifecycle_events WHERE request_id='req_a' AND type='claimed' ORDER BY id").all();
    assert.deepEqual(ev.map(e=>[e.epoch,e.reason]),[[1,'new'],[2,'resume']]);
    assert.match(s.get('req_a').progress.at(-1).note,/epoch 1 lease expired after \d+s without activity; epoch 2 continues under a new claim/);
    assert.equal(s.db.prepare('SELECT claim_id FROM workspaces WHERE request_id=?').get('req_a').claim_id,b.claim_id,'worktree carried');
    assert.equal(s.db.prepare("SELECT claim_id FROM artifacts WHERE id='art_sealed'").get().claim_id,b.claim_id,'sealed upload carried');
    assert.equal(s.db.prepare("SELECT claim_id FROM artifacts WHERE id='art_open'").get().claim_id,a1.claim_id,'unsealed upload not carried');
    // the old run's every call is refused as superseded
    assert.throws(()=>oldRun.progress('req_a',a1.claim_id,'late','sub',false,'lark'),superseded);
    assert.throws(()=>oldRun.finish('req_a',a1.claim_id,'completed','x','y','sub',null,'lark'),superseded);
    assert.throws(()=>ws.read('req_a',a1.claim_id,'sub','f.txt',1,10,'lark'),superseded);
    assert.throws(()=>ws.list('req_a',a1.claim_id,'sub','',10,'lark'),superseded);
    assert.throws(()=>oldRun.progress('req_a',a1.claim_id,'late','sub',false,'lark'),/invalid claim/,'message keeps the invalid claim text');
    assert.throws(()=>oldRun.progress('req_a','claim_never_existed','x','sub',false,'lark'),e=>e.message==='invalid claim','an unknown claim_id is still plain invalid claim');
    assert.throws(()=>oldRun.progress('req_a',a1.claim_id,'x','intruder',false,'lark'),e=>e.message==='invalid claim','another subject learns nothing');
    oldRun.touchClaim('req_a',a1.claim_id,'sub','lark');
    assert.equal(newRun.get('req_a').claim.claim_id,b.claim_id,'the old claim cannot touch the new one');
    assert.equal(newRun.progress('req_a',b.claim_id,'new epoch works','sub',false,'lark').recorded,true);
    assert.equal(s.idleClaims('lark').filter(c=>c.request_id==='req_a').length,0,'after rotation the claim is fresh');
    // a rotated claim in turn rotates only after it is idle again
    const again=newRun.claim('req_a','lark-run-2','sub',6,null,'lark','run-2');
    assert.equal(again.duplicate,true); assert.equal(again.claim_id,b.claim_id,'same acquisition retries inside the threshold');
    pass('claim on an idle own claim rotates the epoch; old claim_id superseded on progress/finish/read_file/list_files; sealed carried, unsealed not');
  }

  // ---- race: old run calls after rotation, never acts under the new epoch
  {
    submit(s,'req_race');
    const r1=oldRun.claim('req_race','run-1','sub',6,null,'lark');
    now=Date.parse(s.get('req_race').claim.lease_expires_at);
    const r2=newRun.claim('req_race','run-2','sub',6,null,'lark');
    const results=await Promise.allSettled([
      Promise.resolve().then(()=>oldRun.progress('req_race',r1.claim_id,'zombie','sub',false,'lark')),
      Promise.resolve().then(()=>newRun.progress('req_race',r2.claim_id,'live','sub',false,'lark')),
      Promise.resolve().then(()=>oldRun.finish('req_race',r1.claim_id,'completed','zombie','zombie','sub',null,'lark')),
    ]);
    assert.deepEqual(results.map(r=>r.status),['rejected','fulfilled','rejected']);
    assert.match(results[0].reason.message,superseded); assert.match(results[2].reason.message,superseded);
    assert.deepEqual(s.get('req_race').progress.map(p=>p.note).filter(n=>!n.startsWith('[bridge]')),['live']);
    // the old run claiming again under its old claimant name is refused: the live claim belongs to the new run and is not idle
    assert.throws(()=>oldRun.claim('req_race','run-1','sub',6,null,'lark'),/claim_busy/);
    assert.equal(s.get('req_race').claim.epoch,2);
    pass('race: an old run that is still alive is refused after rotation');
  }

  // ---- the same worker only, and not another subject
  {
    submit(s,'req_subj');
    s.claim('req_subj','run-1','sub',6,null,'lark');
    assert.throws(()=>newRun.claim('req_subj','run-x','other-subject',6,null,'lark'),/already claimed by another claimant/,'another subject never rotates');
    assert.throws(()=>newRun.claim('req_subj','run-x','sub',6,null,'other'),/assignment not found|invalid claim/,'another worker never rotates');
    process.env.DOT_BRIDGE_RESUME_IDLE_MS='0';
    assert.equal(newRun.claim('req_subj','run-1','sub',6,null,'lark').duplicate,true,'omitted-ID exact retry keeps the same live grant');
    delete process.env.DOT_BRIDGE_RESUME_IDLE_MS;
    pass('live claim retries preserve worker, subject, omitted-ID grant and fencing');
  }

  // ---- metrics: resumed vs lease expiry, and the epoch invariant
  {
    const fin=(id,claim)=>s.finish(id,claim.claim_id,'completed','done','ok','sub',null,'lark');
    submit(s,'req_m1'); const m1=s.claim('req_m1','r1','sub',6,null,'lark'); now=Date.parse(s.get('req_m1').claim.lease_expires_at); const m1b=newRun.claim('req_m1','r2','sub',6,null,'lark'); now+=5*MIN; fin('req_m1',m1b); void m1;
    submit(s,'req_m2'); s.claim('req_m2','r1','sub',6,null,'lark'); now+=LEASE+MIN; s.sweepStaleLeases(); const m2=s.claim('req_m2','r2','sub',6,null,'lark'); now+=9*MIN; fin('req_m2',m2);
    const m=lifecycleMetrics(s,{since:'2026-10-23T00:00:00Z'}), w=m.resume_wake.by_worker.lark;
    assert.ok(w.resumed.value>=3,'resumed count'); assert.ok(w.lease_expiry_retries.value>=1,'the sweep abandoned stale claims (including the other tests\' leftovers)');
    assert.equal(w.time_to_finish_resumed.n.value>=1,true); assert.equal(w.time_to_finish_lease_expiry.n.value,1);
    assert.ok(w.time_to_finish_lease_expiry.p50.value>=LEASE,'lease expiry waited the whole lease');
    assert.ok(w.time_to_finish_resumed.p50.value<w.time_to_finish_lease_expiry.p50.value);
    assert.equal(m.resume_wake.duplicate_epoch_claims.value,0,'no job has two claims acting under one epoch');
    assert.match(explainMetrics(m),/resumed=lark:\d+\/expiry:\d+.*duplicate_epochs=0/);
    // the invariant sees a violation
    s.db.prepare("INSERT INTO lifecycle_events(request_id,claim_id,epoch,type,at,actor,source,reason,worker) VALUES('req_m1','claim_forged',2,'working',?,'x','live',NULL,'lark')").run(s.stamp());
    assert.equal(lifecycleMetrics(s,{since:'2026-10-23T00:00:00Z'}).resume_wake.duplicate_epoch_claims.value,1);
    pass('metrics: resumed, lease-expiry retries, time to finish by path, no duplicate epochs');
  }
  // every request: one claim_id per epoch
  assert.equal(s.db.prepare("SELECT count(*) n FROM (SELECT request_id,epoch FROM lifecycle_events WHERE claim_id IS NOT NULL AND epoch IS NOT NULL AND claim_id<>'claim_forged' GROUP BY 1,2 HAVING count(DISTINCT claim_id)>1)").get().n,0);
  await mcpAcquisitions();
  s.db.close(); newRun.db.close();
  console.log('ALL PASS');
} finally { fs.rmSync(home,{recursive:true,force:true}); }
