import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';

// Contract: `scripts/upgrade-drain.mjs --until-quiescent` is the restart-without-drain mode. It closes the admission gate
// (`dalan quiesce on`), waits only until no admitted RPC, delivery or unverified host check remains, and does NOT wait for live
// leases (they survive a restart on the same database). It never pauses claims. On failure it names `dalan quiesce off`.
// `dalan quiesce on|off|status --json` prints the GET/POST /quiesce body of the admin socket.
const repo=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'dalan-drain-quiescent-test-'));
// A fake CLI: `quiesce status` answers from a script of states (one per call, the last repeats); every call is logged.
const fake=(root,states,live=3)=>{
  const bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`import fs from 'node:fs';
const args=process.argv.slice(2),log=${JSON.stringify(path.join(root,'calls.log'))},states=${JSON.stringify(states)},counter=${JSON.stringify(path.join(root,'n'))};
fs.appendFileSync(log,args.filter(a=>a!=='--json').join(' ')+'\\n');
if(args[0]==='quiesce'&&args[1]==='status'){const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;fs.writeFileSync(counter,String(n+1));
  process.stdout.write(JSON.stringify({on:true,live_leases:${live},...states[Math.min(n,states.length-1)]}));}
else if(args[0]==='claims')process.stdout.write(JSON.stringify({claims:[{request_id:'req_live',lease_expires_at:new Date(Date.now()+3600000).toISOString()}]}));
else process.stdout.write(JSON.stringify({on:true,ok:true}));
`);
};
const run=(root,timeout='4000')=>spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs'),'--until-quiescent'],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:timeout},encoding:'utf8',timeout:15000});
const calls=root=>fs.readFileSync(path.join(root,'calls.log'),'utf8').trim().split('\n');
const idle={admitted_in_flight:0,delivery_in_flight:0,host_checks_unverified:0};

test('until-quiescent closes the gate, ignores live leases and never pauses claims',()=>{
  const root=scratch();
  try {
    fake(root,[idle]);
    const result=run(root);
    assert.equal(result.status,0,result.stderr);
    const seen=calls(root);
    assert.ok(seen.includes('quiesce on'),seen.join('|'));
    assert.ok(!seen.some(c=>c.startsWith('pause')),'must not use the ordinary pause');
    assert.ok(!seen.some(c=>c.startsWith('claims')),'must not wait on live leases');
    assert.match(result.stdout,/leases? (survive|kept)/i);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('until-quiescent waits while an admitted call, a delivery or an unverified host check remains',()=>{
  const root=scratch();
  try {
    fake(root,[{...idle,admitted_in_flight:1},{...idle,delivery_in_flight:1},{...idle,host_checks_unverified:2},idle]);
    const result=run(root);
    assert.equal(result.status,0,result.stderr);
    assert.ok(calls(root).filter(c=>c==='quiesce status').length>=4,'each busy state must be polled until all are zero');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('until-quiescent times out when work stays in flight and names the reopen step',()=>{
  const root=scratch();
  try {
    fake(root,[{...idle,admitted_in_flight:1}]);
    const result=run(root,'1500');
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/timed out/i);
    assert.match(result.stderr,/dalan quiesce off/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('the default mode is unchanged: it pauses claims and waits for leases',()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`process.stdout.write(JSON.stringify({claims:[]}));\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs')],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'5000'},encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/Claims paused/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('until-quiescent refuses malformed counters and tells the operator how to reopen',()=>{
  const root=scratch();
  try {
    fake(root,[{...idle,delivery_in_flight:"0"}]);
    const result=run(root);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/invalid in-flight counters/i);
    assert.match(result.stderr,/dalan quiesce off/);
    assert.deepEqual(calls(root),['quiesce on','quiesce status','quiesce off'],'a failed drain reopens the gate');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

for(const [label,counters] of [['negative',{admitted_in_flight:-1}],['fractional',{admitted_in_flight:0.5}],['missing',{host_checks_unverified:undefined}]]) test(`until-quiescent refuses a ${label} counter`,()=>{
  const root=scratch();
  try {
    fake(root,[{...idle,...counters}]);
    const result=run(root);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/invalid in-flight counters/i);
    assert.match(result.stderr,/dalan quiesce off/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('a mistyped drain option fails instead of running the default drain',()=>{
  const root=scratch(),bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  try {
    fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`require('node:fs').appendFileSync(${JSON.stringify(path.join(root,'calls.log'))},'called\\n');\n`);
    const result=spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs'),'--until-quiesent'],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'3000'},encoding:'utf8',timeout:8000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/unknown argument/);
    assert.equal(fs.existsSync(path.join(root,'calls.log')),false,'no command may run, in particular not a pause');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

// The gate must not stay closed after an aborted drain (a closed gate starves every worker with no signal), so a kill or a failure
// during the poll reopens it. After a successful poll the gate stays closed for the restart.
const killMidPoll=async(signal,code)=>{
  const root=scratch();
  try {
    fake(root,[{...idle,admitted_in_flight:1}]);
    const drain=spawn(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs'),'--until-quiescent'],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'60000'},stdio:['ignore','pipe','pipe']});
    let err='';drain.stderr.on('data',b=>err+=b);
    const done=new Promise(resolve=>drain.once('exit',(c,s)=>resolve({code:c,signal:s})));
    const limit=Date.now()+8000;
    while(Date.now()<limit&&!(fs.existsSync(path.join(root,'calls.log'))&&calls(root).filter(c=>c==='quiesce status').length>=2))await new Promise(r=>setTimeout(r,20));
    assert.ok(calls(root).filter(c=>c==='quiesce status').length>=2,'the drain must be polling before the kill');
    drain.kill(signal);
    const result=await done;
    assert.equal(result.code,code,err);
    assert.equal(calls(root).at(-1),'quiesce off','the last call must reopen the gate');
    assert.match(err,/drain aborted .*gate reopened/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
};
test('until-quiescent reopens the gate when killed by SIGTERM mid-poll',()=>killMidPoll('SIGTERM',143));
test('until-quiescent reopens the gate when killed by SIGINT mid-poll',()=>killMidPoll('SIGINT',130));

test('until-quiescent reopens the gate when the terminal hangs up (SIGHUP)',()=>killMidPoll('SIGHUP',129));

test('until-quiescent reopens the gate when the drain times out',()=>{
  const root=scratch();
  try {
    fake(root,[{...idle,admitted_in_flight:1}]);
    const result=run(root,'1500');
    assert.notEqual(result.status,0);
    assert.equal(calls(root).at(-1),'quiesce off');
    assert.match(result.stderr,/gate reopened/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('until-quiescent leaves the gate closed after a successful poll and never reopens it',()=>{
  const root=scratch();
  try {
    fake(root,[idle]);
    const result=run(root);
    assert.equal(result.status,0,result.stderr);
    assert.ok(!calls(root).includes('quiesce off'),'the restart reopens the gate, not the drain');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

// The default mode: quiesce when the running service answers `quiesce status` with the in-flight counters, pause only when it cannot.
const runWith=(root,args,timeout='3000')=>spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs'),...args],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:timeout},encoding:'utf8',timeout:15000});
const oldService=(root,statusExit)=>{
  const bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`import fs from 'node:fs';
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root,'calls.log'))},args.filter(a=>a!=='--json').join(' ')+'\\n');
if(args[0]==='quiesce'){${statusExit?`process.stderr.write('unknown admin route');process.exit(1);`:`process.stdout.write(JSON.stringify({ok:true}));`}}
else if(args[0]==='claims')process.stdout.write(JSON.stringify({claims:[]}));
else process.stdout.write(JSON.stringify({ok:true}));
`);
};

test('with no flag, a service that has the gate is drained by quiesce and is never paused',()=>{
  const root=scratch();
  try {
    fake(root,[idle]);
    const result=runWith(root,[]);
    assert.equal(result.status,0,result.stderr);
    const seen=calls(root);
    assert.ok(seen.includes('quiesce on'),seen.join('|'));
    assert.ok(!seen.some(c=>c.startsWith('pause')||c.startsWith('claims')),'no pause and no lease wait: '+seen.join('|'));
    assert.match(result.stdout,/has the quiesce gate/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

for(const [label,statusExit] of [['answers quiesce status with an error',true],['answers quiesce status without counters',false]]) test(`with no flag, a service that ${label} is drained by the pause`,()=>{
  const root=scratch();
  try {
    oldService(root,statusExit);
    const result=runWith(root,[]);
    assert.equal(result.status,0,result.stderr);
    const seen=calls(root);
    assert.ok(seen.some(c=>c.startsWith('pause')),seen.join('|'));
    assert.ok(!seen.includes('quiesce on'),'a service without the gate is never asked to quiesce');
    assert.match(result.stdout,/no quiesce gate/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('--pause forces the pause drain even when the service has the gate; the two flags exclude each other',()=>{
  const root=scratch();
  try {
    fake(root,[idle]);
    const result=runWith(root,['--pause']);
    const seen=calls(root);
    assert.ok(seen.some(c=>c.startsWith('pause')),seen.join('|'));
    assert.ok(!seen.some(c=>c.startsWith('quiesce')),'--pause must not probe or close the gate: '+seen.join('|'));
    const both=runWith(root,['--pause','--until-quiescent']);
    assert.equal(both.status,2);
    assert.match(both.stderr,/exclude each other/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
