#!/usr/bin/env node
// Dispatch stall: a conversation that is busy inside a long turn keeps calling progress and get but never lists, and the
// webhook wake it already accepted (2xx) does not start another turn. Against the real server: jobs wait unclaimed with free
// lanes. progress and get carry a dispatch_notice naming the queue head once the wake grace has passed, never before, never
// while lanes are full, and at most once per throttle window. The tool list is unchanged.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname),home=await mkdtemp(join(tmpdir(),'dalan-bridge-dispatch-stall-'));
const assert=(ok,message)=>{if(!ok) throw new Error(message);};
const log=message=>console.log(`PASS ${message}`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const REWAKE=30000,baseMs=Date.now();
const clockFile=join(home,'clock'),ackFile=join(home,'tick-ack');
let now=0;
const payload=id=>({schema_version:1,request_id:id,brief:`queue wake ${id}`,inputs:[{revision:'abc'}],expected_output:'one result',execution_scope:'read-only'});
let service=null,webhook=null,side=null;
async function waitFor(fn,label,timeout) { const start=Date.now();while(Date.now()-start<timeout){if(await fn()) return;await sleep(10);}throw new Error(`timeout: ${label}`); }
try {
  await mkdir(join(home,'.config/dot-bridge'),{recursive:true});
  await writeFile(join(home,'.config/dot-bridge/limits.json'),JSON.stringify({max_claimed_outer_assignments:2,queue_rewake_ms:REWAKE,assignment_reannounce_interval_ms:120000,assignment_reannounce_max_count:10}),{mode:0o600});
  await writeFile(clockFile,'0');await writeFile(ackFile,'0');
  const events=[];
  webhook=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const data=JSON.parse(body);
    if(data.type==='verification') res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({challenge:data.challenge}));
    else { events.push(data);res.writeHead(204).end(); }});
  await new Promise(r=>webhook.listen(0,'127.0.0.1',r));
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS:'1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'0',CONFORMANCE_CLOCK_FILE:clockFile,CONFORMANCE_TICK_ACK_FILE:ackFile,CONFORMANCE_BASE_MS:String(baseMs)};
  service=spawn(process.execPath,['--import','./scripts/conformance/clock-preload.mjs','src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let out='';service.stdout.on('data',b=>out+=b);service.stderr.on('data',b=>process.stderr.write(b));
  await waitFor(()=>out.includes('MCP listening'),'server ready',10000);
  const secret=(await readFile(join(home,'.config/dot-bridge/env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc=async(method,params={})=>(await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})})).json();
  const tool=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});if(r.result.isError) throw new Error(r.result.content[0].text);return JSON.parse(r.result.content[0].text);};
  const sub=await rpc('events/subscribe',{name:'assignment.available',arguments:{},delivery:{mode:'webhook',url:`http://127.0.0.1:${webhook.address().port}/hook`,secret:`whsec_${randomBytes(32).toString('base64')}`},ttlMs:3600000});
  assert(sub.result?.id,'subscribe failed: '+JSON.stringify(sub));
  side=new Store(join(home,'.local/share/dot-bridge/bridge.db'),{now:()=>baseMs+now});
  const advance=async to=>{
    assert(Number.isSafeInteger(to)&&to>=now,'clock must be monotonic');
    now=to;await writeFile(clockFile,String(now));
  };
  // drain awaits sendWebhook and finishAttempt before the preload acknowledges it.
  // Also require durable 2xx receipts, so an early ack or a failed/late delivery cannot
  // make a no-event assertion pass while a webhook is still outstanding.
  const settled=()=>side.db.prepare("SELECT id,state FROM notifications WHERE kind='event' AND subscription_id=?").all(sub.result.id);
  const settle=async()=>{
    await waitFor(()=>settled().every(n=>n.state==='delivered'),'webhook delivery settled',5000);
    const rows=settled();
    assert(rows.length===events.length&&rows.every(n=>events.some(e=>e.eventId===n.id)),
      'receiver and delivery receipts disagree: '+JSON.stringify(rows));
  };
  const tick=async()=>{
    const before=Number(await readFile(ackFile,'utf8'));
    assert(service.kill('SIGUSR2'),'could not signal scheduler');
    await waitFor(async()=>Number(await readFile(ackFile,'utf8'))===before+1,'scheduler tick acknowledged',5000);
    await settle();
  };
  const [A,B,C]=['A','B','C'].map(x=>`req_ds_${x}_${randomUUID()}`);
  side.submit(payload(A),'t','e','owner');
  await advance(1);side.submit(payload(B),'t','e','owner');
  await advance(2);side.submit(payload(C),'t','e','owner');
  await tick();
  const held=await tool('claim',{request_id:A,claimant:'dot'});
  assert(held.free_lanes===1,'one lane left after the first claim: '+JSON.stringify(held.free_lanes));
  // Inside the wake grace nothing is stalled yet: the worker may still act on the wake it has.
  await advance(30000);
  const early=await tool('progress',{request_id:A,claim_id:held.claim_id,note:'working'});
  assert(!('dispatch_notice' in early),'notice inside the grace: '+JSON.stringify(early));
  // Past the grace the wakes were accepted but nothing claimed B or C: the busy conversation is told on the calls it makes.
  await advance(150000);await tick();
  assert(events.length>=3,'bridge kept re-waking');
  const late=await tool('progress',{request_id:A,claim_id:held.claim_id,note:'still working'});
  assert(late.dispatch_notice?.free_lanes===1&&late.dispatch_notice.oldest_waiting_s>=90,'progress notice: '+JSON.stringify(late.dispatch_notice));
  assert(late.dispatch_notice.next_queued.map(x=>x.request_id).join()===B,'notice names the oldest queued item, one per free lane: '+JSON.stringify(late.dispatch_notice));
  assert(/claim req_ds_B_\S+ now \(oldest first\)/.test(late.dispatch_notice.next_action),'next_action: '+late.dispatch_notice.next_action);
  // Throttled: a second call inside the window carries none; after it, get carries it too.
  const again=await tool('progress',{request_id:A,claim_id:held.claim_id,note:'more'});
  assert(!('dispatch_notice' in again),'notice not throttled');
  await advance(now+31000);
  const got=await tool('get',{request_id:A});
  assert(got.dispatch_notice?.next_queued?.[0]?.request_id===B,'get notice: '+JSON.stringify(got.dispatch_notice));
  log('a busy conversation is told about waiting work on progress and get, after the wake grace and at most once per window');
  // Acting on it fills the lane: no more notices while lanes are full.
  const second=await tool('claim',{request_id:B,claimant:'dot'});
  assert(second.free_lanes===0,'lanes full');
  await advance(now+31000);
  const full=await tool('progress',{request_id:A,claim_id:held.claim_id,note:'full'});
  assert(!('dispatch_notice' in full),'notice with no free lane: '+JSON.stringify(full));
  log('no notice while lanes are full');
  const names=(await rpc('tools/list')).result.tools.map(t=>t.name).join();
  assert(!/dispatch_notice/.test(names),'tool list unchanged');
  log('dispatch stall e2e');
} catch(error) {console.error(`FAIL ${error.stack||error}`);process.exitCode=1;}
finally {side?.db.close();if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}if(webhook)await new Promise(r=>webhook.close(r));await rm(home,{recursive:true,force:true});}
