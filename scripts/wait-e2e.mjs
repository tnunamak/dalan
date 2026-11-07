#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startT3ResultFixture } from '../src/test-support/t3-result-fixture.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname),home=await mkdtemp(join(tmpdir(),'dalan-bridge-wait-'));
const threadId='00000000-0000-4000-8000-000000000001';
let port;
const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_WAIT_RESPONSE_DELAY_MS:'500',DOT_BRIDGE_PORT:'0',PATH:`${join(home,'bin')}:${process.env.PATH}`};
const sleep=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms));
function run(argv,input) { return new Promise(resolveRun=>{const child=spawn(argv[0],argv.slice(1),{cwd:repo,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>resolveRun({code,stdout,stderr}));child.stdin.end(input);}); }
function start(argv) { const child=spawn(argv[0],argv.slice(1),{cwd:repo,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise(resolveDone=>child.on('close',(code,signal)=>resolveDone({code,signal,stdout,stderr})));return {child,done}; }
async function waitFor(test,label) { for(const deadline=performance.now()+5000;performance.now()<deadline;) { if(await test()) return; await sleep(25); } throw new Error(`timed out waiting for ${label}`); }
await mkdir(join(home,'.config','dot-bridge'),{recursive:true}); await mkdir(join(home,'bin'),{recursive:true});
await writeFile(join(home,'bin','t3code'),`#!/usr/bin/env node
const fs=require('fs'); const args=process.argv.slice(2);
if(args.includes('inspect')) console.log(JSON.stringify({ok:true,data:{runtime:{environmentId:'fake-environment'},thread:{id:'${threadId}',status:'active'}}}));
else if(args.includes('send')) { let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{fs.appendFileSync(process.env.HOME+'/sent.jsonl',JSON.stringify(body)+'\\n');console.log(JSON.stringify({ok:true,data:{}}));}); }
else console.log(JSON.stringify({ok:true,data:{}}));
`,{mode:0o755});
const t3Fixture=await startT3ResultFixture({home,threadId,fakeCommand:join(home,'bin','t3code'),messageFile:'sent.jsonl'});
Object.assign(env,t3Fixture.env);
let service,serviceDone,serviceOutcome,scenarioPassed=false;
async function stopService() {
  if(!serviceDone)return;
  if(service.exitCode===null&&service.signalCode===null)service.kill('SIGTERM');
  let timer;
  const stopped=await Promise.race([serviceDone.then(()=>true),new Promise(resolveStop=>{timer=setTimeout(()=>resolveStop(false),5000);})]);
  clearTimeout(timer);
  if(!stopped) {service.kill('SIGKILL');await serviceDone;}
}
try {
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});let output='';
  serviceDone=new Promise(resolveDone=>{
    service.once('error',error=>{serviceOutcome={error:error.message};resolveDone(serviceOutcome);});
    service.once('close',(code,signal)=>{serviceOutcome={code,signal};resolveDone(serviceOutcome);});
  });
  service.stdout.on('data',b=>{output+=b;port=Number(/MCP listening on [^:]+:(\d+)/.exec(output)?.[1])||undefined;});service.stderr.on('data',b=>process.stderr.write(b));
  await waitFor(()=>port||serviceOutcome,'service');
  assert.equal(serviceOutcome,undefined,`service exited before readiness: ${JSON.stringify(serviceOutcome)}`);
  assert.ok(port>0,'service did not report its bound port');
  const secret=(await readFile(join(home,'.config','dot-bridge','env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  async function rpc(name,arguments_) { const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:arguments_}})});const body=await response.json();assert(!body.result.isError,body.result.content[0].text);return JSON.parse(body.result.content[0].text); }
  async function submit() { const request_id=`req_${randomUUID()}`,payload={schema_version:1,request_id,brief:'wait test',inputs:[],expected_output:'wait outcome',execution_scope:'read-only'};const result=await run([process.execPath,'bin/dalan.mjs','submit','--thread',threadId,'--stdin','--json'],JSON.stringify(payload));assert.equal(result.code,0,result.stderr);const claim=await rpc('claim',{request_id,claimant:'wait-test'});return {request_id,claim_id:claim.claim_id}; }
  async function finish(item,summary='done',result='done') { await rpc('finish',{...item,outcome:'completed',summary,result}); }
  async function sentPayloads() {
    let text;
    try { text=await readFile(join(home,'sent.jsonl'),'utf8'); }
    catch(error) { if(error.code==='ENOENT')return [];throw error; }
    return text.split('\n').filter(Boolean).map(line=>{const payload=JSON.parse(line);assert.equal(typeof payload,'string');return payload;});
  }
  async function sentCount() { return (await sentPayloads()).length; }
  function deliveries(payloads,requestId) {
    return payloads.filter(text=>text.split(/[^A-Za-z0-9_-]+/).includes(requestId));
  }
  function assertRaceDelivery(payloads,requestId,summary) {
    const matches=deliveries(payloads,requestId);
    assert.equal(matches.length,1,'expected exactly one fallback for the raced request');
    assert.ok(matches[0].includes(summary),'fallback missing expected summary');
    // The event carries the summary and a fetch hint, not the result body.
    assert.ok(matches[0].includes('get '+requestId),'fallback missing fetch hint');
  }

  async function waitAttached() { await waitFor(()=>new Promise((resolve,reject)=>{const req=http.get({socketPath:join(home,'.local/share/dot-bridge/admin.sock'),path:'/status'},res=>{let out='';res.on('data',b=>out+=b);res.on('end',()=>resolve(JSON.parse(out).owner_waiter_count===1));});req.on('error',reject);}), 'owner waiter attachment'); }

  const completed=await submit(),completeWait=start([process.execPath,'bin/dalan.mjs','wait',completed.request_id,'--timeout','5']);await waitAttached();await finish(completed);const complete=await completeWait.done;assert.equal(complete.code,0,complete.stderr);assert.equal(JSON.parse(complete.stdout).status,'finished');assert.equal(await sentCount(),0,'finished waiter also sent T3 message');

  const blocked=await submit(),blockWait=start([process.execPath,'bin/dalan.mjs','wait',blocked.request_id,'--timeout','5']);await waitAttached();await rpc('progress',{...blocked,note:'QUESTION: choose a format',blocker:true});const blocker=await blockWait.done;assert.equal(blocker.code,3,blocker.stderr);assert.equal(JSON.parse(blocker.stdout).status,'question');assert.equal(await sentCount(),0,'blocker waiter also sent T3 message');
  await run([process.execPath,'bin/dalan.mjs','cancel',blocked.request_id,'--json']);

  const cancelled=await submit(),cancelWait=start([process.execPath,'bin/dalan.mjs','wait',cancelled.request_id,'--timeout','5']);await waitAttached();const receipt=await run([process.execPath,'bin/dalan.mjs','cancel',cancelled.request_id,'--json']);assert.equal(receipt.code,0,receipt.stderr);const cancelledResult=await cancelWait.done;assert.equal(cancelledResult.code,4,cancelledResult.stderr);assert.equal(JSON.parse(cancelledResult.stdout).status,'cancelled');

  const timedOut=await submit(),timeout=await run([process.execPath,'bin/dalan.mjs','wait',timedOut.request_id,'--timeout','1']);assert.equal(timeout.code,124,timeout.stderr);assert.equal(JSON.parse(timeout.stdout).status,'timeout');
  await run([process.execPath,'bin/dalan.mjs','cancel',timedOut.request_id,'--json']);

  const baseline=await sentPayloads();
  const raced=await submit(),raceWait=start([process.execPath,'bin/dalan.mjs','wait',raced.request_id,'--timeout','5']);
  const expectedSummary='race-summary-'+randomUUID();
  assert.equal(deliveries(baseline,raced.request_id).length,0,'race request was already delivered at baseline');
  await waitAttached();
  await finish(raced,expectedSummary);
  assert.equal(deliveries(await sentPayloads(),raced.request_id).length,0,'race request delivered before waiter kill');
  assert.equal(raceWait.child.exitCode,null,'race waiter already completed before kill');
  assert.equal(raceWait.child.signalCode,null,'race waiter already terminated before kill');
  assert.ok(raceWait.child.kill('SIGKILL'),'failed to kill pending race waiter');
  const killed=await raceWait.done;
  assert.equal(killed.signal,'SIGKILL','race waiter completed instead of being killed');
  // Wait up to 5 s (monotonic) for the raced request's own fallback, then keep watching briefly for a duplicate.
  // Unrelated traffic cannot satisfy the oracle: only a message that names this request counts.
  const deadline=performance.now()+5000;
  let observed=[],settleUntil=null;
  do {
    const payloads=await sentPayloads();
    assert.deepEqual(payloads.slice(0,baseline.length),baseline,'delivery baseline changed');
    observed=payloads.slice(baseline.length);
    const matches=deliveries(observed,raced.request_id);
    assert.ok(matches.length<=1,'duplicate fallback for raced request');
    if(matches.length) { assertRaceDelivery(observed,raced.request_id,expectedSummary);settleUntil??=performance.now()+500; }
    const now=performance.now();
    if(settleUntil!==null?now>=settleUntil:now>=deadline)break;
    await sleep(25);
  } while(true);
  assertRaceDelivery(observed,raced.request_id,expectedSummary);
  // Regression guard for the old shared-count false positive.
  assert.throws(()=>assertRaceDelivery(['unrelated delivery'],raced.request_id,expectedSummary));
  scenarioPassed=true;
  console.log('PASS wait exit codes, timeout, attached waiter suppression, and disconnect fallback');
} finally { if(scenarioPassed)t3Fixture.beginPassedTeardown();try {await stopService();} finally {try {await t3Fixture.close();} finally {await rm(home,{recursive:true,force:true});}} }
