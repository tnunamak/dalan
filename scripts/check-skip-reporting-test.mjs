#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'check-skips-'));
process.env.HOME=home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT=path.join(home,'work');
process.env.DOT_BRIDGE_MIN_FREE_BYTES='0';
const {Store}=await import('../src/store.mjs');
const {Workspace}=await import('../src/workspace.mjs');
const {withEvidence}=await import('../src/execution.mjs');
const {checkOutcome,lifecycleMetrics,explainMetrics}=await import('../src/lifecycle.mjs');
const {buildResultText}=await import('../src/acp-bridge.mjs');
const repo=path.join(home,'repo');fs.mkdirSync(repo);
const git=(...args)=>{
  const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);return r.stdout.trim();
};
git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
fs.writeFileSync(path.join(repo,'file.mjs'),'export const value=1;\n');
git('add','file.mjs');git('commit','-qm','synthetic check fixture');
const base=git('rev-parse','HEAD');
process.env.DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE=repo;
const file=path.join(home,'bridge.db'),store=new Store(file),ws=new Workspace(store,false);
console.log(`Check fixtures retained: ${home}`);
after(()=>store.db.close());

function fixture(output,exit=0,extra={}) {
  const request_id=`req_${randomUUID()}`,id=`check_${randomUUID()}`;
  const payload={schema_version:1,request_id,brief:'synthetic check completion',inputs:[{github_repo:'test/fixture',base_sha:base}],expected_output:'patch',execution_scope:'implementation'};
  store.submit(payload,{mode:'none'},null,'owner',false,null,'normal',null,payload,null,null,'host');
  const claim_id=store.claim(request_id,'fixture','subject',99).claim_id;
  const artifact=ws.saveArtifact(request_id,claim_id,'check-output',Buffer.from(output));
  const result={id,check_run_id:id,request_id,claim_id,check_id:'default',status:'completed',phase:'check',exit_code:exit,timed_out:false,cancelled:false,
    output_artifact_id:artifact.artifact_id,output_sha256:artifact.sha256,diff_sha256:'synthetic',output_preview:output,duration_ms:1,
    evidence:{trust:'bridge_verified',phase:'check',output_redaction_version:1,input_diff_sha256:'synthetic'},...extra};
  store.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES(?,?,?,?,?,'running',?)")
    .run(id,request_id,claim_id,'default','synthetic',new Date().toISOString());
  return result;
}
const hostSkip='SKIP host executor journey: /synthetic/scripts/npm-question-test.mjs (resource_limits_unavailable)\n';

function metricsFor(outcomes) {
  const now=Date.parse('2026-10-28T00:00:00Z'),s=new Store(':memory:',{now:()=>now});
  try {
    const request_id='req_metrics_fixture',payload={schema_version:1,request_id,brief:'synthetic metrics',inputs:[],expected_output:'report',execution_scope:'read-only'};
    s.submit(payload,{mode:'none'},null,'owner');
    outcomes.forEach(type=>s.lifecycle(request_id,type,'system','synthetic check outcome'));
    return lifecycleMetrics(s,{since:new Date(now-60000).toISOString()});
  } finally {s.db.close();}
}

test('R4 prior 6: a pass plus a skip is not a clean pass rate',()=>{
  const m=metricsFor(['check_passed','check_skipped']);
  assert.equal(m.checks.skipped?.value,1);
  assert.equal(m.checks.passed.value,1);
  assert.equal(m.checks.pass_rate.value,0.5);
  assert(!Object.hasOwn(m.checks,'unknown'),'known skipped checks must have their own count');
  assert.match(explainMetrics(m),/checks=passed:1,failed:0,skipped:1/);
});

test('R4 prior 6: skip-only coverage has a zero pass rate',()=>{
  const m=metricsFor(['check_skipped']);
  assert.equal(m.checks.skipped?.value,1);assert.equal(m.checks.pass_rate.value,0);
  assert.match(explainMetrics(m),/checks=passed:0,failed:0,skipped:1/);
});

test('R4 prior 6: an empty check window has no pass-rate claim',()=>{
  const m=metricsFor([]);
  assert.equal(m.checks.skipped?.value,0);assert.equal(m.checks.pass_rate.value,null);
});

for(const exit of [0,77]) for(const ending of ['\n','\r\n']) {
  test(`R4 R3: a reason-less executor skip is counted and named (exit ${exit}, ${JSON.stringify(ending)})`,()=>{
    const output='SKIP host executor journey: /synthetic/scripts/npm-question-test.mjs'+ending;
    const row=fixture(output,exit),saved=ws.recordCheckResult(row,Buffer.from(output));
    assert.equal(saved.skipped_segments,1);assert.equal(saved.status,'skipped');
    assert.deepEqual(saved.skipped_segment_names,['scripts/npm-question-test.mjs']);
    assert.match(saved.check_summary,/scripts\/npm-question-test\.mjs/);
    const shown=ws.result(row.request_id,row.claim_id,'subject').checks[0];
    assert.equal(shown.skipped_segments,1);assert.equal(shown.status,'skipped');
    assert.deepEqual(shown.skipped_segment_names,['scripts/npm-question-test.mjs']);
  });
}

for(const exit of [0,77]) for(const ending of ['\n','\r\n']) for(const suffix of ['','   ',' (resource_limits_unavailable)']) {
  test(`R5 N4: an unnamed host journey skip is counted (exit ${exit}, ${JSON.stringify(ending+suffix)})`,()=>{
    const output='SKIP host executor journey:'+suffix+ending;
    const row=fixture(output,exit),saved=ws.recordCheckResult(row,Buffer.from(output));
    assert.equal(saved.skipped_segments,1);assert.equal(saved.status,'skipped');
    assert.deepEqual(saved.skipped_segment_names,[],'a reason is not a segment name');
    assert.match(saved.check_summary,/1 skipped segment: segment name unavailable/);
    const shown=ws.result(row.request_id,row.claim_id,'subject').checks[0];
    assert.equal(shown.skipped_segments,1);assert.equal(shown.status,'skipped');
    assert.deepEqual(shown.skipped_segment_names,[]);
  });
}

test('R5 N4: an unnamed skip adds to the named coverage gap',()=>{
  const output=hostSkip+'SKIP host executor journey:\n';
  const row=fixture(output,0),saved=ws.recordCheckResult(row,Buffer.from(output));
  assert.equal(saved.skipped_segments,2);assert.equal(saved.status,'skipped');
  assert.deepEqual(saved.skipped_segment_names,['scripts/npm-question-test.mjs']);
});

for(const exit of [0,77]) {
  test(`N4: a bare skip and its segment-runner summary count once (exit ${exit})`,()=>{
    const output='SKIP host executor journey:\nTEST SEGMENTS: 1 total, 0 passed, 0 failed, 1 skipped\nSKIP #1/1: node scripts/optional.mjs\n';
    const row=fixture(output,exit),saved=ws.recordCheckResult(row,Buffer.from(output));
    assert.equal(saved.skipped_segments,1);assert.equal(saved.status,'skipped');
    assert.deepEqual(saved.skipped_segment_names,['scripts/optional.mjs']);
  });
}

test('N4: an aggregate summary cannot hide a bare skipped journey',()=>{
  const output='SKIP host executor journey:\nTEST SEGMENTS: 1 total, 1 passed, 0 failed, 0 skipped\n';
  const row=fixture(output,0),saved=ws.recordCheckResult(row,Buffer.from(output));
  assert.equal(saved.skipped_segments,1);assert.equal(saved.status,'skipped');
});

test('N2: a legacy completed exit-77 check is visibly skipped',()=>{
  const row=fixture(hostSkip,77);
  store.db.prepare("UPDATE check_jobs SET status='completed',output_preview=? WHERE id=?").run(hostSkip,row.id);
  store.db.prepare('INSERT INTO check_runs(id,request_id,claim_id,check_id,exit_code,timed_out,output_artifact_id,output_sha256,duration_ms,created_at,phase,evidence) VALUES(?,?,?,?,?,0,?,?,1,?,?,?)')
    .run(row.id,row.request_id,row.claim_id,row.check_id,77,row.output_artifact_id,row.output_sha256,new Date().toISOString(),'check',JSON.stringify(row.evidence));
  const shown=ws.result(row.request_id,row.claim_id,'subject').checks[0];
  assert.equal(shown.status,'skipped');
  assert.equal(shown.skipped_segments,1);
  assert.deepEqual(shown.skipped_segment_names,['scripts/npm-question-test.mjs']);
  assert.match(shown.check_summary,/default: 1 skipped segment.*scripts\/npm-question-test\.mjs/);
});

test('N2: skips are not a passed lifecycle outcome even when the command exits zero',()=>{
  const [type,reason]=checkOutcome({id:'check',check_id:'default',status:'completed',skipped_segments:1,check_summary:'default: 1 skipped segment: scripts/optional.mjs'},
    {phase:'check',exit_code:0,timed_out:false,cancelled:false});
  assert.equal(type,'check_skipped');assert.match(reason,/scripts\/optional\.mjs/);
});

for(const [name,exit,output,extra,status,event] of [
  ['exit 77',77,hostSkip,{},'skipped','check_skipped'],
  ['exit zero with a skipped segment',0,'TEST SEGMENTS: 2 total, 1 passed, 0 failed, 1 skipped\nSKIP #2/2: node scripts/optional.mjs\n',{},'skipped','check_skipped'],
  ['plain skip marker',0,'SKIP scripts/optional.mjs\n',{},'skipped','check_skipped'],
  ['TAP skip marker',0,'ok 2 - scripts/optional.mjs # SKIP unavailable\n',{},'skipped','check_skipped'],
  ['failure with a skipped segment',1,hostSkip,{},'failed','check_failed'],
  ['timeout with a skipped segment',0,hostSkip,{timed_out:true},'failed','check_failed'],
  ['cancellation with a skipped segment',0,hostSkip,{cancelled:true},'failed','check_failed'],
  ['no skips',0,'PASS synthetic check\n',{},'completed','check_passed'],
]) test(`N2: ${name} persists its coverage, status and lifecycle`,()=>{
  const row=fixture(output,exit,extra);
  const result=ws.recordCheckResult(row,Buffer.from(output));
  assert.equal(result.status,status);
  assert.equal(result.skipped_segments,name==='no skips'?0:1);
  const db=new DatabaseSync(file);
  try {
    const job=db.prepare('SELECT * FROM check_jobs WHERE id=?').get(row.id);
    const run=db.prepare('SELECT * FROM check_runs WHERE id=?').get(row.id);
    assert.equal(job.status,status);
    const owner=withEvidence({...job,...run,status:job.status});
    assert.equal(owner.skipped_segments,result.skipped_segments);
    assert.equal(JSON.parse(run.evidence).skipped_segments,result.skipped_segments);
    assert.equal(owner.status,status);
    if(result.skipped_segments) assert.match(owner.check_summary,/scripts\/(?:npm-question-test|optional)\.mjs/);
    const events=db.prepare("SELECT type,reason FROM lifecycle_events WHERE request_id=? AND type LIKE 'check_%'").all(row.request_id);
    assert.equal(events.length,1);assert.equal(events[0].type,event);
    if(result.skipped_segments) assert.match(events[0].reason,/skipped/);
  } finally {db.close();}
  const worker=ws.result(row.request_id,row.claim_id,'subject').checks[0];
  assert.equal(worker.status,status);assert.equal(worker.skipped_segments,result.skipped_segments);
});

test('N2: default check runs security and skip-reporting tests before any early exit',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const commands=pkg.scripts['test:sandbox'].split(' && ');
  assert.equal(commands[0],'node --test scripts/auth-repository-security-test.mjs');
  assert.equal(commands[1],'node --test scripts/check-skip-reporting-test.mjs');
  const config=JSON.parse(fs.readFileSync(new URL('../.dalan.json',import.meta.url),'utf8'));
  assert.deepEqual(config.checks.default.argv.slice(-2),['run','test:sandbox']);
});

test('N2: stored coverage survives a preview that omits the skip line',()=>{
  const output='TEST SEGMENTS: 2 total, 1 passed, 0 failed, 1 skipped\nSKIP #2/2: node scripts/optional.mjs\n';
  const row=fixture(output,0);row.output_preview='HEAD\n[omitted]\nTAIL';
  const saved=ws.recordCheckResult(row,Buffer.from(output));
  const shown=ws.result(row.request_id,row.claim_id,'subject').checks[0];
  assert.equal(shown.skipped_segments,1);
  assert.deepEqual(shown.skipped_segment_names,['scripts/optional.mjs']);
  assert.equal(shown.check_summary,saved.check_summary);
});

test('N2: a real segment runner skip reaches the stored default summary',()=>{
  const dir=path.join(home,'runner');fs.mkdirSync(path.join(dir,'scripts'),{recursive:true});
  fs.copyFileSync(new URL('./test-segments.mjs',import.meta.url),path.join(dir,'scripts/test-segments.mjs'));
  fs.writeFileSync(path.join(dir,'scripts/optional.mjs'),'process.exit(77);\n');
  fs.writeFileSync(path.join(dir,'scripts/pass.mjs'),'console.log("PASS synthetic");\n');
  fs.writeFileSync(path.join(dir,'scripts/test-segments.json'),JSON.stringify(['node scripts/optional.mjs','node scripts/pass.mjs']));
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({scripts:{test:'node scripts/test-segments.mjs'}}));
  const run=spawnSync(process.execPath,['scripts/test-segments.mjs'],{cwd:dir,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const row=fixture(run.stdout,run.status),saved=ws.recordCheckResult(row,Buffer.from(run.stdout));
  assert.equal(saved.status,'skipped');assert.equal(saved.skipped_segments,1);
  assert.match(saved.check_summary,/scripts\/optional\.mjs/);
});

test('N2: requester build summary names the skipped default segment',()=>{
  const check={check_id:'default',status:'skipped',exit_code:77,skipped_segments:1,check_summary:'default: 1 skipped segment: scripts/npm-question-test.mjs'};
  const text=buildResultText({request_id:'synthetic',report:{workspace_evidence:{checks:[check]}}},'done',null);
  assert.match(text,/worker checks: default skipped.*scripts\/npm-question-test\.mjs/);
});
