import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

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
    assert.deepEqual(calls(root),['quiesce on','quiesce status']);
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
