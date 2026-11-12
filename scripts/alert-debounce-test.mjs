import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Store} from '../src/store.mjs';
import {checkAlerts} from '../src/alerts.mjs';
import {dropEmptyPost54FixtureState} from '../src/test-support/pre-worker-fixture.mjs';

const MIN=60_000,origin=Date.parse('2026-10-27T12:00:00Z');
async function fixture(run) {
  const root=await mkdtemp(path.join(os.tmpdir(),'dalan-alert-'));
  const originalFile=process.env.DOT_BRIDGE_ALERTS_FILE,originalFetch=globalThis.fetch;
  const alertsFile=path.join(root,'alerts.env'),dbFile=path.join(root,'bridge.db');
  process.env.DOT_BRIDGE_ALERTS_FILE=alertsFile;
  let now=origin,store,skipped=0,pause=0,mode='ok';
  const attempts=[],accepted=[],logged=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'http://publisher.invalid/fixture','no external requests');
    const notice={title:options.headers.Title,body:options.body};attempts.push(notice);
    if(mode==='lost'){accepted.push(notice);throw new Error('publisher reply lost');}
    if(mode==='fail')return {ok:false,status:503};
    accepted.push(notice);return {ok:true,status:200};
  };
  const configure=enabled=>writeFile(alertsFile,enabled?'NTFY_URL=http://publisher.invalid/fixture\n':'',{mode:0o600});
  const queued=()=>store.db.prepare("SELECT count(*) n FROM assignments WHERE status='queued' AND target_worker='dot'").get().n;
  function open() {
    store=new Store(dbFile,{now:()=>now});
    store.status=()=>({counts:[{status:'queued',count:queued()}],
      queue_classes:{pause_suspected:pause,transport_failing:0},
      skipped_by_worker:{count:skipped,request_ids:skipped?['fixture-job']:[]},
      claimed_outer_count:0,max_claimed_outer_assignments:2,
      subscription:{expires_at:null,auth_failures:0},subscriptions_active:1,
      stale_claims:{count:0,max_idle_ms:0},unclaimed_after_reannounce:{count:0,oldest_age_ms:0},worker_silence_ms:0});
    store.overEstimate=()=>[];
    store.denialNotes=()=>({matches:[]});store.ackDenialNotes=()=>{};
  }
  const h={
    get store(){return store;},get now(){return now;},set now(value){now=value;},
    advance:ms=>{now+=ms;},skip:value=>{skipped=value;},pause:value=>{pause=value;},
    publisher:value=>{mode=value;},configure,attempts,accepted,logged,
    removeConfig:()=>rm(alertsFile,{force:true}),
    tick:()=>checkAlerts(store,notice=>logged.push(notice)),
    reopen:()=>{store.db.close();open();},
    queue:id=>store.submit({schema_version:1,request_id:id,brief:'fixture queued work',inputs:[],expected_output:'report'},{mode:'none'},null,'owner'),
    count:(title,prefix)=>accepted.filter(n=>n.title===`Dalan ${title}`&&n.body.startsWith(prefix)).length,
    logCount:(title,prefix)=>logged.filter(n=>n.title===`Dalan ${title}`&&n.message.startsWith(prefix)).length,
    row:()=>store.db.prepare("SELECT * FROM alert_episodes WHERE condition='skipped_by_worker'").get()
  };
  try {await configure(true);open();await run(h);}
  finally {
    store?.db.close();globalThis.fetch=originalFetch;
    if(originalFile===undefined)delete process.env.DOT_BRIDGE_ALERTS_FILE;else process.env.DOT_BRIDGE_ALERTS_FILE=originalFile;
    await rm(root,{recursive:true,force:true});
  }
}

await test('five-minute skipped episode sends neither attention nor recovery',()=>fixture(async h=>{
  h.skip(1);await h.tick();h.advance(5*MIN);await h.tick();
  assert.equal(h.accepted.length,0,'five-minute condition must stay quiet');
  h.skip(0);await h.tick();await h.tick();
  assert.equal(h.accepted.length,0,'an unsent attention cannot produce recovery');
}));

await test('30-minute attention and 35-minute recovery publish once across restart',()=>fixture(async h=>{
  h.skip(1);await h.tick();h.advance(30*MIN-1);await h.tick();
  assert.equal(h.accepted.length,0,'no attention at 29:59.999');
  h.reopen();await h.tick();assert.equal(h.accepted.length,0,'restart must not send early');
  h.advance(1);await h.tick();await h.tick();
  assert.equal(h.count('attention','skipped_by_worker:'),1);
  assert(h.row().attention_sent_at,'successful attention is durable');
  h.reopen();await h.tick();assert.equal(h.accepted.length,1,'success stops retries');
  h.advance(5*MIN);h.skip(0);await h.tick();await h.tick();h.reopen();await h.tick();
  assert.equal(h.count('recovered','skipped_by_worker resolved'),1);
  assert.equal(h.accepted.length,2);
}));

for(const missingFile of [false,true]) {
  await test(`log-only condition delivers once per episode (missing file: ${missingFile})`,()=>fixture(async h=>{
    if(missingFile)await h.removeConfig();else await h.configure(false);
    for(let episode=1;episode<=2;episode++) {
      h.skip(1);await h.tick();h.advance(30*MIN);
      for(let i=0;i<4;i++){await h.tick();h.advance(MIN);}
      h.reopen();await h.tick();
      assert.equal(h.logCount('attention','skipped_by_worker:'),episode);
      assert(h.row().attention_sent_at,'log delivery is durable');
      h.skip(0);
      for(let i=0;i<4;i++){await h.tick();h.advance(MIN);}
      h.reopen();await h.tick();
      assert.equal(h.logCount('recovered','skipped_by_worker resolved'),episode);
      assert.equal(h.row().active,0);
    }
    assert.equal(h.attempts.length,0,'no publisher means no POST');
  }));

  await test(`log-only break delivers once per episode (missing file: ${missingFile})`,()=>fixture(async h=>{
    if(missingFile)await h.removeConfig();else await h.configure(false);
    h.queue('log-only-break-work');
    for(let episode=1;episode<=2;episode++) {
      h.store.setBreak('log-only fixture break');await h.tick();h.advance(30*MIN);
      for(let i=0;i<4;i++){await h.tick();h.advance(MIN);}
      h.reopen();await h.tick();
      assert.equal(h.logCount('attention','worker_break:'),episode);
      h.store.clearBreak();
      for(let i=0;i<4;i++){await h.tick();h.advance(MIN);}
      h.reopen();await h.tick();
      assert.equal(h.logCount('recovered','worker_break resolved:'),episode);
    }
    assert.equal(h.attempts.length,0,'no publisher means no POST');
  }));
}

await test('published attention can recover once through the log after publisher removal',()=>fixture(async h=>{
  h.skip(1);h.queue('recovery-sink-work');h.store.setBreak('publisher removed');
  await h.tick();h.advance(30*MIN);await h.tick();
  assert.equal(h.count('attention','skipped_by_worker:'),1);
  assert.equal(h.count('attention','worker_break:'),1);
  await h.removeConfig();h.skip(0);h.store.clearBreak();
  for(let i=0;i<4;i++){await h.tick();h.advance(MIN);}
  h.reopen();await h.tick();
  assert.equal(h.logCount('recovered','skipped_by_worker resolved'),1);
  assert.equal(h.logCount('recovered','worker_break resolved:'),1);
  assert.equal(h.attempts.length,2,'recovery must not POST without a publisher');
}));

await test('failed break attention and recovery POSTs retry on the next tick',()=>fixture(async h=>{
  h.queue('retry-break-work');h.store.setBreak('publisher failure');
  await h.tick();h.advance(30*MIN);h.publisher('fail');
  for(let i=0;i<2;i++){await assert.rejects(h.tick(),/ntfy HTTP 503/);h.advance(MIN);}
  assert.equal(h.attempts.length,2);assert.equal(h.accepted.length,0);
  h.reopen();h.publisher('ok');await h.tick();await h.tick();
  assert.equal(h.count('attention','worker_break:'),1);assert.equal(h.attempts.length,3);
  h.store.clearBreak();h.publisher('fail');
  for(let i=0;i<2;i++){await assert.rejects(h.tick(),/ntfy HTTP 503/);h.advance(MIN);}
  assert.equal(h.attempts.length,5);
  h.reopen();h.publisher('ok');await h.tick();await h.tick();
  assert.equal(h.count('recovered','worker_break resolved:'),1);assert.equal(h.attempts.length,6);
}));

await test('failed sends and lost replies never manufacture success',()=>fixture(async h=>{
  h.skip(1);await h.tick();h.advance(30*MIN);h.publisher('fail');
  await assert.rejects(h.tick(),/ntfy HTTP 503/);assert.equal(h.row().attention_sent_at,null);
  h.advance(MIN);await assert.rejects(h.tick(),/ntfy HTTP 503/);
  assert.equal(h.attempts.length,2,'failed POST must retry on the next tick');
  assert.equal(h.row().attention_sent_at,null);
  h.publisher('lost');await assert.rejects(h.tick(),/publisher reply lost/);
  assert.equal(h.row().attention_sent_at,null,'ambiguous acceptance remains retryable');
  h.publisher('ok');await h.tick();const attempts=h.attempts.length;
  h.reopen();await h.tick();assert.equal(h.attempts.length,attempts,'recorded success stops transport retries');
  assert.equal(h.count('attention','skipped_by_worker:'),2,'lost reply can duplicate physical transport');
  h.skip(0);h.publisher('fail');await assert.rejects(h.tick(),/ntfy HTTP 503/);
  h.reopen();h.publisher('ok');await h.tick();const recoveredAttempts=h.attempts.length;
  h.reopen();await h.tick();assert.equal(h.attempts.length,recoveredAttempts,'recorded recovery stops retries');
  assert.equal(h.count('recovered','skipped_by_worker resolved'),1);
}));

await test('invalid, future and backward timestamps never send early',()=>fixture(async h=>{
  h.skip(1);await h.tick();
  const set=value=>h.store.db.prepare("UPDATE alert_episodes SET started_at=? WHERE condition='skipped_by_worker'").run(value);
  set('invalid');h.advance(60*MIN);await h.tick();assert.equal(h.accepted.length,0);
  set(new Date(h.now+MIN).toISOString());await h.tick();assert.equal(h.accepted.length,0);
  set(new Date(h.now).toISOString());const since=h.now;
  h.now-=MIN;await h.tick();assert.equal(h.accepted.length,0,'backward clock cannot age the condition');
  h.now=since+30*MIN-1;h.reopen();await h.tick();assert.equal(h.accepted.length,0);
  h.advance(1);await h.tick();assert.equal(h.accepted.length,1);
}));

await test('break without queued work is quiet and a queue gap resets its observation',()=>fixture(async h=>{
  h.store.setBreak('fixture break');await h.tick();h.advance(35*MIN);await h.tick();
  assert.equal(h.count('attention','worker_break:'),0,'idle breaks must stay quiet');
  h.queue('queue-before-gap');await h.tick();h.advance(20*MIN);
  h.store.cancel('queue-before-gap','owner');await h.tick();
  h.advance(15*MIN);await h.tick();assert.equal(h.count('attention','worker_break:'),0);
  h.queue('queue-after-gap');await h.tick();h.advance(30*MIN-1);await h.tick();
  assert.equal(h.count('attention','worker_break:'),0,'queue gap must reset the 30-minute interval');
  h.reopen();h.advance(1);await h.tick();await h.tick();
  assert.equal(h.count('attention','worker_break:'),1);
  h.store.clearBreak();await h.tick();await h.tick();
  assert.equal(h.count('recovered','worker_break resolved:'),1);
}));

await test('resolved unpaged breaks never catch up with attention/recovered pairs',()=>fixture(async h=>{
  h.queue('short-break-work');h.store.setBreak('short fixture break');await h.tick();
  h.advance(5*MIN);h.store.clearBreak();await h.tick();
  assert.equal(h.accepted.length,0,'five-minute break stays quiet');
  h.store.setBreak('break ended between checks');await h.tick();
  h.advance(35*MIN);h.store.clearBreak();await h.tick();
  assert.equal(h.accepted.length,0,'an ended unpaged condition does not page retroactively');
}));

await test('inferred breaks also require a sustained queued-work interval',()=>fixture(async h=>{
  h.queue('inferred-break-work');
  h.store.startBreak({since:h.store.stamp(),reason:'fixture inferred break',source:'inferred'});
  await h.tick();h.advance(5*MIN);await h.tick();assert.equal(h.accepted.length,0);
  h.advance(25*MIN);await h.tick();await h.tick();
  assert.equal(h.count('attention','worker_break:'),1);
  h.store.clearBreak();await h.tick();assert.equal(h.count('recovered','worker_break resolved:'),1);
}));

await test('pause suspicion requires queued work for the whole delay',()=>fixture(async h=>{
  h.pause(1);await h.tick();h.advance(35*MIN);await h.tick();
  assert.equal(h.count('attention','pause_suspected:'),0);
  h.queue('pause-work');await h.tick();h.advance(5*MIN);await h.tick();
  assert.equal(h.count('attention','pause_suspected:'),0);
  h.advance(25*MIN);await h.tick();await h.tick();
  assert.equal(h.count('attention','pause_suspected:'),1);
  h.pause(0);await h.tick();assert.equal(h.count('recovered','pause_suspected resolved'),1);
}));

await test('schema49 episode rows survive additive migration without invented publication',()=>fixture(async h=>{
  const db=h.store.db;
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,66);
  h.store.setBreak('legacy fixture break');h.store.clearBreak();
  // The helper also restores the original break table name, as at that version.
  dropEmptyPost54FixtureState(db);
  db.exec(`ALTER TABLE alert_episodes DROP COLUMN attention_sent_at;
    ALTER TABLE dot_breaks DROP COLUMN alert_first_observed_at;
    ALTER TABLE dot_breaks DROP COLUMN attention_published_at;
    PRAGMA user_version=49;`);
  // Reconstruct the exact old columns to exercise an existing schema49 layout.
  db.prepare('INSERT INTO alert_episodes(condition,active,started_at,last_change_at) VALUES(?,1,?,?)').run('skipped_by_worker',h.store.stamp(),h.store.stamp());
  const before=db.prepare('SELECT * FROM dot_breaks').get();
  h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version,66);
  assert.equal(h.store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  const after=h.store.db.prepare('SELECT * FROM worker_breaks').get();
  assert.deepEqual({...after,alert_first_observed_at:undefined,attention_published_at:undefined},
    {...before,alert_first_observed_at:undefined,attention_published_at:undefined});
  assert.equal(after.attention_published_at,null);assert.equal(h.row().attention_sent_at,null);
  await h.tick();assert.equal(h.accepted.length,0,'legacy timestamps cannot prove a published attention');
}));

await test('historical migration fixtures retain columns already present on replay',()=>fixture(async h=>{
  h.skip(1);await h.tick();h.advance(30*MIN);await h.tick();
  const row=h.row();assert(row.attention_sent_at);
  // Test-owned legacy fixtures rewind selected schema sections, retaining unrelated columns.
  dropEmptyPost54FixtureState(h.store.db);
  h.store.db.exec('PRAGMA user_version=49;');h.reopen();
  assert.equal(h.store.db.prepare('PRAGMA user_version').get().user_version,66);
  assert.deepEqual(h.row(),row,'replayed migration must preserve existing success evidence');
  await h.tick();assert.equal(h.count('attention','skipped_by_worker:'),1);
}));
