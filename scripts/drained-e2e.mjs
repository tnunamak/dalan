#!/usr/bin/env node
// `dot-worker wait --drained` against a real bridge in an isolated HOME: producer scoping, low water, one waiter per producer,
// attention, pause, timeout, and no 'consumed' events from the waiter's reads.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { readLines } from '../src/request-log.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname),home=await mkdtemp(join(tmpdir(),'dalan-bridge-drained-'));
const port=await reservedPort(),producer='producer-thread-aaaa',other='producer-thread-bbbb';
const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:String(port),DOT_DRAINED_INTERVAL_MS:'100',PATH:`${join(home,'bin')}:${process.env.PATH}`};
for(const k of ['CLAUDE_CODE_SESSION_ID','CODEX_THREAD_ID']) delete env[k];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function run(argv,input) { return new Promise(r=>{const child=spawn(argv[0],argv.slice(1),{cwd:repo,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>r({code,stdout,stderr}));child.stdin.end(input);}); }
function start(argv,extra={}) { const child=spawn(argv[0],argv.slice(1),{cwd:repo,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let stdout='',stderr='',exited=false;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise(r=>child.on('close',code=>{exited=true;r({code,stdout,stderr});}));return {child,done,get exited(){return exited;}}; }
async function waitFor(test,label) { for(let t=0;t<5000;t+=25) { if(await test()) return; await sleep(25); } throw new Error(`timed out waiting for ${label}`); }
const cli=(...a)=>run([process.execPath,'bin/dot-worker.mjs',...a]);
const drained=(...a)=>start([process.execPath,'bin/dot-worker.mjs','wait','--drained','--producer-thread',producer,...a]);
const polls=()=>[...readLines(join(home,'.local/state/dot-bridge/requests.jsonl'),{missingOk:true})].filter(Boolean).map(JSON.parse).filter(row=>row.kind==='admin_call'&&row.route==='/owner-states').length;
async function readyWaiter(launch) {
  const before=polls(), waiter=launch();
  // A second poll proves the first snapshot was received and became the baseline.
  await waitFor(()=>polls()>=before+2,'waiter initial snapshot');
  return waiter;
}
await mkdir(join(home,'.config','dot-bridge'),{recursive:true}); await mkdir(join(home,'bin'),{recursive:true});
await writeFile(join(home,'.config','dot-bridge','limits.json'),JSON.stringify({max_claimed_outer_assignments:10}),{mode:0o600});
await writeFile(join(home,'bin','t3code'),`#!/usr/bin/env node
console.log(JSON.stringify({ok:true,data:{}}));
`,{mode:0o755});
let service;
try {
  async function startService() {
    service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']}); let ready=false;
    service.stdout.on('data',b=>{if(String(b).includes('MCP listening'))ready=true;}); service.stderr.on('data',b=>process.stderr.write(b));
    await waitFor(()=>ready,'service');
  }
  await startService();
  const secret=(await readFile(join(home,'.config','dot-bridge','env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  async function rpc(name,args) { const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});const body=await response.json();assert(!body.result.isError,body.result.content[0].text);return JSON.parse(body.result.content[0].text); }
  async function submit(who=producer) { const request_id=`req_${randomUUID()}`;const r=await run([process.execPath,'bin/dot-worker.mjs','submit','--deliver','none','--producer-thread',who,'--stdin','--json'],JSON.stringify({schema_version:1,request_id,brief:'drained test',inputs:[],expected_output:'x',execution_scope:'read-only'}));assert.equal(r.code,0,r.stderr);return request_id; }
  const claim=async request_id=>({request_id,claim_id:(await rpc('claim',{request_id,claimant:'drained-test'})).claim_id});
  const finish=item=>rpc('finish',{...item,outcome:'completed',summary:'done',result:'done'});
  const json=r=>JSON.parse(r.stdout.trim());

  // 1. Two claimed + one queued; another producer's claimed task never counts. Finishing both of ours drains (0 claimed, 1 queued).
  const a=await claim(await submit()),b=await claim(await submit()); const c=await submit(); const foreign=await claim(await submit(other));
  const w1=await readyWaiter(()=>drained('--timeout','20'));
  assert.equal(w1.exited,false,'waiter exited while above low water');
  const dup=await cli('wait','--drained','--producer-thread',producer,'--timeout','5');
  assert.equal(dup.code,7,dup.stderr); assert.equal(json(dup).status,'already_running');
  await finish(a); await sleep(400); assert.equal(w1.exited,false,'waiter exited with one task still claimed');
  await finish(b);
  const r1=await w1.done; assert.equal(r1.code,0,r1.stderr);
  const o1=json(r1); assert.equal(o1.status,'drained'); assert.deepEqual(o1.in_flight,{queued:1,claimed:0});
  assert.deepEqual(o1.finished.map(x=>x.request_id).sort(),[a.request_id,b.request_id].sort());
  // The pidfile is released, so the next waiter starts.
  // 2. One queued at start is not a wake; its finish is.
  const w2=await readyWaiter(()=>drained('--timeout','20')); assert.equal(w2.exited,false,'single queued task woke at once');
  await finish(await claim(c)); const r2=await w2.done; assert.equal(r2.code,0,r2.stderr); assert.equal(json(r2).status,'drained');
  // 3. A question wakes with code 3.
  const d=await claim(await submit()),e=await claim(await submit());
  const w3=await readyWaiter(()=>drained('--timeout','20'));
  await rpc('progress',{...d,note:'QUESTION: which format?',blocker:true});
  const r3=await w3.done; assert.equal(r3.code,3,r3.stderr); assert.deepEqual(json(r3).attention,[{request_id:d.request_id,status:'question',text:'QUESTION: which format?'}]);
  // 4. A pause during the wait exits 6 with a reason.
  const w4=await readyWaiter(()=>drained('--timeout','20'));
  assert.equal((await cli('pause','--reason','drained test')).code,0);
  const r4=await w4.done; assert.equal(r4.code,6,r4.stderr); assert.equal(json(r4).status,'paused');
  // A waiter started while paused holds rather than spin; it times out with 124.
  const r5=await cli('wait','--drained','--producer-thread',producer,'--timeout','1');
  assert.equal(r5.code,124,r5.stderr); assert.equal(json(r5).status,'timeout');
  await cli('resume');
  // 5. The waiter never records an owner read.
  const db=new DatabaseSync(join(home,'.local/share/dot-bridge/bridge.db'),{readOnly:true});
  assert.equal(db.prepare("SELECT count(*) n FROM lifecycle_events WHERE type='consumed'").get().n,0,'waiter reads recorded consumed');
  db.close();
  // 6. No producer id: a clear error.
  const r6=await cli('wait','--drained'); assert.notEqual(r6.code,0); assert.match(r6.stderr,/producer-thread/);
  for(const x of [d,e,foreign]) await cli('cancel',x.request_id,'--json');
  // 7. Five waiters started at once for one producer: exactly one keeps running.
  const f=await claim(await submit()), g=await claim(await submit());
  const racers=Array.from({length:5},()=>drained('--timeout','30'));
  await waitFor(()=>racers.filter(r=>!r.exited).length===1,'one waiter survives the start race');
  assert.equal(racers.filter(r=>!r.exited).length,1,'not exactly one waiter survived');
  for(const r of racers.filter(r=>r.exited)) { const x=await r.done; assert.equal(x.code,7,x.stderr); }
  // 7b. The same race against a stale pidfile left by a crashed waiter (dead pid).
  for(const r of racers.filter(r=>!r.exited)) r.child.kill('SIGKILL');
  await sleep(200);
  const pidfiles=readdirSync(join(home,'.local/state/dot-bridge/drained')).filter(n=>n.endsWith('.json'));
  assert.equal(pidfiles.length,1,'SIGKILL left no stale pidfile to race on');
  const stale=Array.from({length:5},()=>drained('--timeout','30'));
  await waitFor(()=>stale.filter(r=>!r.exited).length===1,'one waiter survives the stale pidfile race');
  assert.equal(stale.filter(r=>!r.exited).length,1,'not exactly one waiter survived a stale pidfile');
  racers.splice(0,racers.length,...stale);
  // 8. A bridge restart mid-wait is retried; the survivor still drains afterwards.
  const survivor=racers.find(r=>!r.exited);
  service.kill('SIGTERM'); await new Promise(r=>service.once('exit',r));
  await sleep(500); assert.equal(survivor.exited,false,'waiter died with the bridge');
  await startService();
  await finish(f); await finish(g);
  const r8=await survivor.done; assert.equal(r8.code,0,r8.stderr); assert.equal(json(r8).status,'drained');
  // 9. A sustained outage ends with one JSON line and exit 8.
  const h=await claim(await submit()), i=await claim(await submit());
  const w9=await readyWaiter(()=>start([process.execPath,'bin/dot-worker.mjs','wait','--drained','--producer-thread',producer,'--timeout','30'],{DOT_DRAINED_UNREACHABLE_MS:'600'}));
  service.kill('SIGTERM'); await new Promise(r=>service.once('exit',r));
  const r9=await w9.done; assert.equal(r9.code,8,r9.stderr); assert.equal(json(r9).status,'bridge_unreachable');
  await startService(); for(const x of [h,i]) await cli('cancel',x.request_id,'--json');
  console.log('PASS wait --drained: producer scope, low water, single waiter under a start race, attention, pause, timeout, bridge restart, outage exit, no consumed reads');
} finally { if(service&&service.exitCode===null&&service.signalCode===null) { service.kill('SIGTERM'); await new Promise(r=>service.once('exit',r)); } await rm(home,{recursive:true,force:true}); }
