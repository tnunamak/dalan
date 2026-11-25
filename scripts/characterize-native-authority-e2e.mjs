#!/usr/bin/env node
// Characterization only, tnunamak/dalan 4044870094802839f322ff1784f167802588c2ee.
// Run after landing: node scripts/characterize-native-authority-e2e.mjs
// Reconciles prior c8635df2 artifact conceptually; its non-applicable preview
// was not replayed. No HTTP, T3, network, production data or stand-in server.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {PullQueue} from '../src/pull-queue.mjs';
import {LEGACY_PROFILE} from '../src/workers.mjs';

const payload = request_id => ({schema_version:1,request_id,brief:'authority fixture',
  inputs:[],expected_output:'characterization',execution_scope:'read-only'});
const query = (s,sql,...args) => JSON.parse(JSON.stringify(s.db.prepare(sql).all(...args)));
const evidence = s => ({
  reports:query(s,'SELECT * FROM reports ORDER BY request_id'),
  late:query(s,'SELECT * FROM late_evidence ORDER BY request_id,claim_id'),
  progress:query(s,'SELECT * FROM progress ORDER BY id'),
});
function rejectOld(s,id,claimId) {
  // store.mjs refuseClaim/assertClaim 2522-2555, assertFinishClaim 2649-2657.
  const saved=evidence(s);
  assert.throws(()=>s.progress(id,claimId,'old','subject-1'),/claim_superseded/);
  assert.deepEqual(evidence(s),saved,'SELECT reports/late_evidence/progress after stale progress');
  assert.throws(()=>s.finish(id,claimId,'completed','old','old','subject-1'),/claim_superseded/);
  assert.deepEqual(evidence(s),saved,'SELECT reports/late_evidence/progress after stale finish');
}
if(process.argv[2]==='--stale-holder') {
  const [file,clock,id,claimId]=process.argv.slice(3);
  const s=new Store(file,{now:()=>Number(clock),limits:{leaseMs:100},resumeIdleMs:0});
  try {rejectOld(s,id,claimId);} finally {s.db.close();}
} else {
  // Constructor clock/config: store.mjs 291-319.
  // Harness: claim-epoch-test.mjs 15-20, 58-80; late-evidence-test.mjs 16-29.
  const dir=mkdtempSync(join(process.env.DOT_BRIDGE_TEST_TMP??tmpdir(),'dalan-authority-'));
  const file=join(dir,'fixture.sqlite');
  let now=Date.parse('2026-11-15T00:00:00Z'),s,asserted=0,gaps=0;
  const open=()=>new Store(file,{now:()=>now,limits:{leaseMs:100},resumeIdleMs:0});
  const gap=(id,why)=>{gaps++;console.log('GAP '+id+': '+why);};
  const submit=id=>s.submit(payload(id),{mode:'none'},null,'owner');
  // Positional claim API: store.mjs 2378-2384.
  const claim=(id,name='W1',connection=null)=>s.claim(id,name,'subject-1',100,null,'dot',null,100,null,connection);
  const progress=(id,c,note,connection=null)=>s.progress(id,c.claim_id,note,'subject-1',false,'dot',null,null,connection);
  const finish=(id,c,connection=null)=>s.finish(id,c.claim_id,'completed','fixture','fixture','subject-1',null,'dot',null,null,connection);
  try {
    s=open();
    // F14: takeover increments persisted epoch (store.mjs 2402-2427);
    // cancellation preserves late evidence separately (2658-2673).
    submit('prior');finish('prior',claim('prior'));
    submit('audit');const audit=claim('audit');s.cancel('audit','fixture');
    assert.throws(()=>finish('audit',audit),/assignment_cancelled/);
    // control: an unrelated finished report survives cancellation.
    assert.equal(query(s,"SELECT * FROM reports WHERE request_id='prior'").length,1);
    assert.equal(query(s,"SELECT * FROM late_evidence WHERE request_id='audit'").length,1);
    submit('epoch');const old=claim('epoch');progress('epoch',old,'committed');
    now+=101;const fresh=claim('epoch','W2');
    assert.deepEqual(query(s,"SELECT epoch,claim_id,state FROM claims WHERE request_id='epoch'"),
      [{epoch:2,claim_id:fresh.claim_id,state:'active'}]);
    assert.notEqual(fresh.claim_id,old.claim_id);
    finish('epoch',fresh);rejectOld(s,'epoch',old.claim_id);
    const saved=evidence(s);s.db.close();s=null;
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--stale-holder',
      file,String(now),'epoch',old.claim_id],{encoding:'utf8',timeout:15000});
    // control: successful child execution is required before comparing durable evidence.
    assert.equal(child.status,0,child.stderr||child.error?.message);
    s=open();assert.deepEqual(evidence(s),saved,'SELECT persisted evidence after child/reopen');
    asserted++;
    // The child is sequential restart evidence, NOT a lock race proof.

    // F15/F16: current admission requires a profile as well as callback.
    // assertLiveConnection 2320-2347; assertMutationConnection 2529-2540;
    // progress transaction 2581-2597 and finishOnce 2658-2661.
    let live=true;
    s.destinationProfile=()=>LEGACY_PROFILE;
    s.connectionIsLive=id=>live&&['connection-a','connection-b'].includes(id);
    // src/store.mjs#assertLiveConnection: admission itself must refuse, not only later mutations.
    submit('admission-dead');live=false;
    assert.throws(()=>claim('admission-dead','W1','connection-a'),/connection_not_live/);
    assert.deepEqual(query(s,"SELECT * FROM claims WHERE request_id='admission-dead'"),[]);
    assert.deepEqual(query(s,"SELECT status FROM assignments WHERE request_id='admission-dead'"),[{status:'queued'}]);
    live=true;submit('admission-no-profile');
    s.destinationProfile=()=>null;
    assert.throws(()=>claim('admission-no-profile','W1','connection-a'),/connection_not_live/);
    assert.deepEqual(query(s,"SELECT * FROM claims WHERE request_id='admission-no-profile'"),[]);
    assert.deepEqual(query(s,"SELECT status FROM assignments WHERE request_id='admission-no-profile'"),[{status:'queued'}]);
    s.destinationProfile=()=>LEGACY_PROFILE;
    // control: the same live connection with a profile is admitted.
    submit('connection');const connected=claim('connection','W1','connection-a');
    assert.deepEqual(query(s,"SELECT connection_id FROM claims WHERE request_id='connection'"),
      [{connection_id:'connection-a'}]);
    const before=evidence(s);
    assert.throws(()=>progress('connection',connected,'wrong','connection-b'),/connection_not_live/);
    assert.throws(()=>finish('connection',connected,'connection-b'),/connection_not_live/);
    assert.deepEqual(evidence(s),before,'SELECT evidence after mismatched live connection');
    // control: the matching live connection can mutate.
    progress('connection',connected,'right','connection-a');
    assert.deepEqual(query(s,"SELECT note FROM progress WHERE request_id='connection'"),[{note:'right'}]);
    asserted++;
    const beforeRevoke=evidence(s);
    await Promise.resolve();live=false;
    assert.throws(()=>progress('connection',connected,'revoked','connection-a'),/connection_not_live/);
    assert.throws(()=>finish('connection',connected,'connection-a'),/connection_not_live/);
    assert.deepEqual(evidence(s),beforeRevoke,'SELECT evidence after effect-time callback revocation');
    // Only synchronous Store mutation is fenced, not arbitrary external awaits.
    asserted++;
    live=true;finish('connection',connected,'connection-a');
    s.connectionIsLive=null;s.destinationProfile=null;

    // F20: finish rows 2678-2688; cancel suppression is request-scoped 2697-2706;
    // delivery-none maps to wait, store.mjs 2894.
    submit('left');submit('right');claim('left');finish('right',claim('right'));
    const report=query(s,"SELECT * FROM reports WHERE request_id='right'");
    const notices=query(s,"SELECT * FROM notifications WHERE request_id='right' ORDER BY rowid");
    // setup: establish the unrelated report/notice before request-scoped cancellation.
    assert.equal(report.length,1);assert.ok(notices.some(n=>n.kind==='wait'&&n.state==='pending'));
    s.cancel('left','only left');
    assert.deepEqual(query(s,"SELECT status FROM assignments WHERE request_id='left'"),[{status:'cancelled'}]);
    assert.deepEqual(query(s,"SELECT * FROM reports WHERE request_id='right'"),report);
    assert.deepEqual(query(s,"SELECT * FROM notifications WHERE request_id='right' ORDER BY rowid"),notices);
    asserted++;

    // F25: blocker rows 2618-2633; max(rowid) cursor at store.mjs 2895.
    submit('feed');const feedClaim=claim('feed');
    for(const note of ['QUESTION: first','QUESTION: middle','QUESTION: last'])
      s.progress('feed',feedClaim.claim_id,note,'subject-1',true);
    const feed=query(s,"SELECT rowid AS seq,id FROM notifications WHERE request_id='feed' ORDER BY rowid");
    // setup: establish three notifications before the explicit interior deletion.
    assert.equal(feed.length,3);
    const cursor=s.deliveryCursor('feed');
    // Explicit corruption fixture, not a public delivery operation.
    s.db.prepare('DELETE FROM notifications WHERE id=?').run(feed[1].id);
    assert.deepEqual(query(s,"SELECT rowid AS seq,id FROM notifications WHERE request_id='feed' ORDER BY rowid"),[feed[0],feed[2]]);
    assert.equal(s.deliveryCursor('feed'),cursor);assert.equal(cursor,feed[2].seq);
    gap('F25','interior row deletion leaves max(rowid) cursor unchanged; no hole signal');
    gap('F28','covered at HTTP level by scripts/mcp-outcome-e2e.mjs, not re-run here');

    // F35: PullQueue submit 78-94 inserts only policy_work_orders; list 104-116.
    // Store queueEvent 1544-1554 requires an actual assignment/mayAct.
    const q=new PullQueue(s),order=payload('pool');
    q.submit(order,order,{delivery:{mode:'none'},environmentId:null,execution:'worker',
      priority:'normal',review:false,meta:null},
      {version:1,allowed_workers:['dot'],fan_out:1,deadline_at:new Date(now+86400000).toISOString()},
      {},'synthetic-owner-capability');
    const absent=()=>{
      assert.deepEqual(query(s,"SELECT request_id FROM assignments WHERE request_id='pool'"),[]);
      assert.deepEqual(query(s,"SELECT id FROM notifications WHERE request_id='pool'"),[]);
      assert.deepEqual(query(s,"SELECT state,child_request_id FROM policy_work_orders WHERE request_id='pool'"),
        [{state:'queued',child_request_id:null}]);
    };
    // control: elapsed time and polling do not turn a work order into an assignment.
    absent();now+=60000;absent();
    assert.ok(q.list('dot',()=>{}).items.some(item=>item.request_id==='pool'));
    // src/store.mjs#queueEvent/#mayAct: an active subscription must not wake a non-assignment.
    s.subscribe('authority-subject','http://127.0.0.1/fixture','whsec_'+'x'.repeat(44),
      new Date(now+100000).toISOString());
    const subs=s.activeSubscriptions();
    // setup: an active subscription, not subscription inactivity, is the tested precondition.
    assert.equal(subs.length,1);const sub=subs[0];
    assert.equal(s.mayAct(sub.worker,'pool'),false);
    const beforeSuppression=query(s,'SELECT * FROM notifications ORDER BY rowid');
    assert.equal(s.queueEvent('pool',sub),null);
    assert.deepEqual(query(s,'SELECT * FROM notifications ORDER BY rowid'),beforeSuppression);
    // control: this subscription can enqueue an actual authorized assignment.
    submit('wake-control');
    assert.equal(s.mayAct(sub.worker,'wake-control'),true);
    assert.equal(typeof s.queueEvent('wake-control',sub),'string');
    console.log('F35: poll eligible PullQueue/list_pending backlog; no assignment event is not evidence of host inactivity');
    asserted++;
    gap('F35','submission absence and polling characterized; active subscription/mayAct suppression characterized; timed reannounce and delivery transport not exercised');
    console.log('PASS characterize '+asserted+' asserted, '+gaps+' gaps');
  } finally {
    try {s?.db.close();} finally {rmSync(dir,{recursive:true,force:true});}
  }
}
