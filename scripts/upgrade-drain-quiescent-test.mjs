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
const gate=${JSON.stringify(path.join(root,'gate'))},isOn=()=>fs.existsSync(gate)&&fs.readFileSync(gate,'utf8')==='true';
if(args[0]==='quiesce'&&args[1]==='status'){
  // The first status call is the "was it already closed?" read; the scripted states belong to the poll after quiesce on.
  if(!isOn()&&!fs.existsSync(counter+'.pre')){fs.writeFileSync(counter+'.pre','1');process.stdout.write(JSON.stringify({on:false,live_leases:${live},admitted_in_flight:0,delivery_in_flight:0,host_checks_unverified:0}));}
  else{const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;fs.writeFileSync(counter,String(n+1));
  process.stdout.write(JSON.stringify({on:true,live_leases:${live},...states[Math.min(n,states.length-1)]}));}}
else if(args[0]==='claims')process.stdout.write(JSON.stringify({claims:[{request_id:'req_live',lease_expires_at:new Date(Date.now()+3600000).toISOString()}]}));
else{if(args[0]==='quiesce')fs.writeFileSync(gate,String(args[1]==='on'));process.stdout.write(JSON.stringify({on:args[1]!=='off',ok:true}));}
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

test('until-quiescent refuses malformed counters and tells the operator how to reopen',()=>{
  const root=scratch();
  try {
    fake(root,[{...idle,delivery_in_flight:"0"}]);
    const result=run(root);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/invalid in-flight counters/i);
    assert.match(result.stderr,/dalan quiesce off/);
    assert.deepEqual(calls(root),['quiesce status','quiesce on','quiesce status','quiesce off'],'a failed drain reopens the gate');
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

// The default mode: quiesce when the running service answers `quiesce status` with the in-flight counters; pause only when it answers
// HTTP 404 for the route (a legacy service). Any other failure stops the drain without touching the service.
const runWith=(root,args,timeout='3000')=>spawnSync(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs'),...args],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:timeout},encoding:'utf8',timeout:15000});
// A fake CLI with state: `paused` lives in a file that `pause` and `resume` change. quiesce: 'http404' (legacy), 'transport' (always a
// transport error), 'flaky' (one transport error, then counters), 'nocounters' (HTTP 200 without counters). claims: 'empty', 'live' (a
// lease that never ends), 'fail' or 'malformed' (a successful reply with no claims array) or 'odd' (a lease end of numeric 0).
const service=(root,{quiesce='http404',claims='empty',paused=false,lie=''}={})=>{
  const bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
  fs.writeFileSync(path.join(root,'paused'),String(paused));
  fs.writeFileSync(path.join(root,'gate'),'false');
  fs.writeFileSync(path.join(bin,'dot-worker.mjs'),`import fs from 'node:fs';
const args=process.argv.slice(2),dir=${JSON.stringify(root)},flag=dir+'/paused',gate=dir+'/gate',counter=dir+'/n',lie=${JSON.stringify(lie)};
fs.appendFileSync(dir+'/calls.log',args.filter(a=>a!=='--json').join(' ')+'\\n');
const out=v=>process.stdout.write(JSON.stringify(v)),err=v=>{process.stderr.write(JSON.stringify(v));process.exit(1);};
if(args[0]==='quiesce'&&args[1]==='status'){
  const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;fs.writeFileSync(counter,String(n+1));
  const counters={on:fs.readFileSync(gate,'utf8')==='true',admitted_in_flight:${JSON.stringify(quiesce)}==='busy'?1:0,delivery_in_flight:0,host_checks_unverified:0};
  if(${JSON.stringify(quiesce)}==='http404')err({error:'not found',kind:'http',http_status:404});
  else if(${JSON.stringify(quiesce)}==='transport'||(${JSON.stringify(quiesce)}==='flaky'&&n===0))err({error:'admin request timed out after 30000 ms',kind:'transport'});
  else if(${JSON.stringify(quiesce)}==='nocounters')out({ok:true});
  else out(counters);
}
else if(args[0]==='quiesce'){if(lie!==args[1]+'-quiesce')fs.writeFileSync(gate,String(args[1]==='on'));out({on:fs.readFileSync(gate,'utf8')==='true',ok:true});}
else if(args[0]==='status')out({paused:fs.readFileSync(flag,'utf8')==='true',pause_reason:null});
else if(args[0]==='pause'){if(lie!=='pause')fs.writeFileSync(flag,'true');out({paused:fs.readFileSync(flag,'utf8')==='true'});}
else if(args[0]==='resume'){if(lie!=='resume')fs.writeFileSync(flag,'false');out({paused:fs.readFileSync(flag,'utf8')==='true'});}
else if(args[0]==='claims'){
  if(${JSON.stringify(claims)}==='fail')err({error:'claims unavailable',kind:'local'});
  if(${JSON.stringify(claims)}==='malformed'){out({});process.exit(0);}
  if(${JSON.stringify(claims)}==='odd'){out({claims:[{request_id:'req_odd',lease_expires_at:0}]});process.exit(0);}
  out({claims:${JSON.stringify(claims)}==='live'?[{request_id:'req_live',lease_expires_at:new Date(Date.now()+3600000).toISOString()}]:[]});
}
else out({ok:true});
`);
};
const paused=root=>fs.readFileSync(path.join(root,'paused'),'utf8')==='true';
const withRoot=fn=>()=>{const root=scratch();try{return fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}};

test('with no flag, a service that has the gate is drained by quiesce and is never paused',withRoot(root=>{
  service(root,{quiesce:'counters'});
  const result=runWith(root,[]);
  assert.equal(result.status,0,result.stderr);
  const seen=calls(root);
  assert.ok(seen.includes('quiesce on'),seen.join('|'));
  assert.ok(!seen.some(c=>c.startsWith('pause')||c.startsWith('claims')),'no pause and no lease wait: '+seen.join('|'));
  assert.match(result.stdout,/has the quiesce gate/);
}));

test('with no flag, a service that answers HTTP 404 for the route (legacy) is drained by the pause',withRoot(root=>{
  service(root,{quiesce:'http404'});
  const result=runWith(root,[]);
  assert.equal(result.status,0,result.stderr);
  const seen=calls(root);
  assert.ok(seen.includes('pause --reason upgrade drain'),seen.join('|'));
  assert.ok(!seen.includes('quiesce on'),'a service without the gate is never asked to quiesce');
  assert.match(result.stdout,/no quiesce gate/);
  assert.equal(paused(root),true,'a completed drain leaves the pause for the restart');
  assert.ok(!seen.includes('resume'));
}));

for(const quiesce of ['transport','nocounters']) test(`with no flag, a status call that fails or lacks counters (${quiesce}) stops the drain without touching the service`,withRoot(root=>{
  service(root,{quiesce});
  const result=runWith(root,[]);
  assert.equal(result.status,1,result.stdout);
  assert.match(result.stderr,/could not tell whether the running service has the quiesce gate/);
  assert.match(result.stderr,/--until-quiescent or --pause/);
  const seen=calls(root);
  assert.equal(seen.filter(c=>c==='quiesce status').length,3,'three tries');
  assert.deepEqual(seen.filter(c=>c!=='quiesce status'),[],'no pause, no quiesce, no resume: '+seen.join('|'));
  assert.equal(paused(root),false);
}));

test('with no flag, one transient status failure is retried and the gate drain still runs',withRoot(root=>{
  service(root,{quiesce:'flaky'});
  const result=runWith(root,[]);
  assert.equal(result.status,0,result.stderr);
  const seen=calls(root);
  assert.ok(seen.includes('quiesce on'),seen.join('|'));
  assert.ok(!seen.some(c=>c.startsWith('pause')),'a transport error is not proof of a legacy service: '+seen.join('|'));
}));

test('--pause forces the pause drain to success, never probes the gate, and excludes --until-quiescent',withRoot(root=>{
  service(root,{quiesce:'counters'});
  const result=runWith(root,['--pause']);
  assert.equal(result.status,0,result.stderr);
  const seen=calls(root);
  assert.ok(seen.includes('pause --reason upgrade drain'),seen.join('|'));
  assert.ok(!seen.some(c=>c.startsWith('quiesce')),'--pause must not probe or close the gate: '+seen.join('|'));
  assert.equal(paused(root),true);
  const both=runWith(root,['--pause','--until-quiescent']);
  assert.equal(both.status,2);
  assert.match(both.stderr,/exclude each other/);
}));

test('a pause drain that fails after its own pause releases that pause',withRoot(root=>{
  service(root,{quiesce:'http404',claims:'fail'});
  const result=runWith(root,[]);
  assert.equal(result.status,1);
  const seen=calls(root);
  assert.ok(seen.indexOf('pause --reason upgrade drain')>=0&&seen.indexOf('resume')>seen.indexOf('pause --reason upgrade drain'),seen.join('|'));
  assert.match(result.stderr,/claims resumed/);
  assert.equal(paused(root),false);
}));

test('a pause drain whose claims reply has no claims array stops and releases its own pause',withRoot(root=>{
  service(root,{quiesce:'http404',claims:'malformed'});
  const result=runWith(root,[]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.doesNotMatch(result.stdout,/No unexpired claims/i);
  const seen=calls(root);
  assert.ok(seen.indexOf('resume')>seen.indexOf('pause --reason upgrade drain'),seen.join('|'));
  assert.equal(paused(root),false);
}));

test('a gate that does not close stops the drain and never reports ready',withRoot(root=>{
  service(root,{quiesce:'counters',lie:'on-quiesce'});
  const result=runWith(root,['--until-quiescent']);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stderr,/did not report the gate as closed/);
  assert.doesNotMatch(result.stdout,/No admitted calls/);
}));

test('a pause that does not take stops the pause drain and never reports ready',withRoot(root=>{
  service(root,{quiesce:'http404',lie:'pause'});
  const result=runWith(root,[]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stderr,/did not report claims as paused/);
  assert.doesNotMatch(result.stdout,/No unexpired claims/);
}));

test('a gate reopen whose reply still shows the gate closed is reported as unconfirmed',withRoot(root=>{
  service(root,{quiesce:'busy',lie:'off-quiesce'});
  const result=runWith(root,['--until-quiescent'],'1000');
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stderr,/gate could NOT be confirmed reopened/);
  assert.doesNotMatch(result.stderr,/gate reopened/);
}));

test('a gate that was already closed is left closed when the drain aborts',withRoot(root=>{
  service(root,{quiesce:'busy'});
  fs.writeFileSync(path.join(root,'gate'),'true');
  const result=runWith(root,['--until-quiescent'],'1000');
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stdout,/already quiesced/);
  assert.ok(!calls(root).includes('quiesce off'),calls(root).join('|'));
}));

test('a lease end that is not an ISO timestamp counts as a live lease',withRoot(root=>{
  service(root,{quiesce:'http404',claims:'odd'});
  const result=runWith(root,[]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.doesNotMatch(result.stdout,/No unexpired claims/);
  assert.match(result.stderr,/timed out/);
}));

test('a pause drain that times out on a live lease releases its own pause',withRoot(root=>{
  service(root,{quiesce:'http404',claims:'live'});
  const result=runWith(root,[],'1500');
  assert.equal(result.status,1);
  assert.match(result.stderr,/timed out/i);
  assert.equal(paused(root),false);
}));

test('a pause that was already there is not released by a failed drain, and is not re-issued',withRoot(root=>{
  service(root,{quiesce:'http404',claims:'fail',paused:true});
  const result=runWith(root,[]);
  assert.equal(result.status,1);
  const seen=calls(root);
  assert.ok(!seen.some(c=>c.startsWith('pause')||c==='resume'),seen.join('|'));
  assert.equal(paused(root),true,'the operator pause stays');
}));

test('SIGTERM during the lease wait releases the pause the drain issued',async()=>{
  const root=scratch();
  try {
    service(root,{quiesce:'http404',claims:'live'});
    const child=spawn(process.execPath,[path.join(repo,'scripts/upgrade-drain.mjs'),'--pause'],{cwd:root,env:{...process.env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'60000'},stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',d=>stderr+=d);
    const exited=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
    for(let i=0;i<100&&!(fs.existsSync(path.join(root,'calls.log'))&&calls(root).some(c=>c.startsWith('claims')));i++)await new Promise(r=>setTimeout(r,50));
    assert.ok(calls(root).some(c=>c.startsWith('claims')),'the drain reached the lease wait');
    child.kill('SIGTERM');
    const {code}=await exited;
    assert.equal(code,143);
    assert.ok(calls(root).includes('resume'),calls(root).join('|'));
    assert.equal(paused(root),false);
    assert.match(stderr,/claims resumed/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
