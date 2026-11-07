#!/usr/bin/env node
// Queue re-wake against the real server and a webhook receiver. limits.json in the test HOME sets queue_rewake_ms to its
// 30 s minimum and one claim slot. The server's existing test preload supplies a frozen clock and acknowledged drains.
// Two items queue with a free lane: re-wakes arrive at least queue_rewake_ms apart in server time, each
// one event naming the oldest item. A claim fills the lane: no wake while it is full. Finishing frees it: wakes resume.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname),home=await mkdtemp(join(tmpdir(),'dalan-bridge-queue-wake-'));
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
  await writeFile(join(home,'.config/dot-bridge/limits.json'),JSON.stringify({max_claimed_outer_assignments:1,queue_rewake_ms:REWAKE,assignment_reannounce_interval_ms:120000,assignment_reannounce_max_count:10}),{mode:0o600});
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
  const [A,B]=['A','B'].map(x=>`req_qw_${x}_${randomUUID()}`);
  side.submit(payload(A),'t','e','owner');
  await advance(1); // Give A an unambiguously older creation time than B.
  side.submit(payload(B),'t','e','owner');
  await tick();
  await waitFor(()=>events.filter(e=>e.data.request_id===A).length>=2,'submit events',10000);
  // A's wake names A. B's submit wake names the queue head A, with the re-wake text.
  assert(events.length===2&&events[0].data.request_id===A&&events[0].data.title===`queue wake ${A}`&&events[1].data.request_id===A&&/^2 assignments queued \(\d+ free lanes?\); claim oldest first via list_pending: queue wake req_qw_A_/.test(events[1].data.title),'submit events: '+JSON.stringify(events.map(e=>e.data)));
  const rewakes=()=>events.slice(2);
  // Each boundary is relative to the previous completed wake at virtual time 1.
  for(let n=1;n<=2;n++) {
    const held=events.length;
    await advance(1+n*REWAKE-1);await tick();
    assert(events.length===held,'re-wake before D: '+JSON.stringify(events.slice(held)));
    await advance(1+n*REWAKE);await tick();
    assert(events.length===held+1,'expected exactly one re-wake at D: '+JSON.stringify(events.slice(held)));
    const e=events.at(-1);
    assert(Date.parse(e.timestamp)===baseMs+now,'re-wake not stamped at D: '+JSON.stringify(e));
  }
  for(const e of rewakes()) assert(e.data.request_id===A&&e.data.title===`2 assignments queued (1 free lane); claim oldest first via list_pending: queue wake ${A}`&&JSON.stringify(Object.keys(e.data))==='["request_id","title"]','re-wake payload: '+JSON.stringify(e.data));
  assert(new Set(events.map(e=>e.eventId)).size===events.length,'re-wakes reused an event id');
  const gaps=events.slice(2).map((e,i)=>Date.parse(e.timestamp)-Date.parse(events[i+1].timestamp));
  assert(gaps.every(g=>g===REWAKE),'re-wake virtual cadence: '+JSON.stringify(gaps));
  log('two re-wakes at D, none at D-1, each naming the oldest item with a unique event id');

  const claim=await tool('claim',{request_id:B,claimant:'dot'});
  assert(claim.free_lanes===0&&claim.queued_after_claim===1,'claim lane fields: '+JSON.stringify({free_lanes:claim.free_lanes,queued:claim.queued_after_claim}));
  const held=events.length;
  await advance(now+REWAKE);await tick();
  assert(events.length===held,'woke while the only lane was claimed: '+JSON.stringify(events.slice(held).map(e=>e.data)));
  assert(side.db.prepare("SELECT status FROM assignments WHERE request_id=?").get(A).status==='queued','A not queued');
  log('no wake after a due, acknowledged and delivery-settled drain while the only lane is full');

  await tool('finish',{request_id:B,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'data'});
  // finish can start its own drain; settle it before requesting another pass.
  await settle();await tick();
  assert(events.length===held+1,'expected exactly one wake after the lane freed');
  assert(events.at(-1).data.request_id===A&&events.at(-1).data.title===`queue wake ${A}`,'wake after finish: '+JSON.stringify(events.at(-1).data));
  log('a finished claim frees the lane and the next tick wakes for the queued item');
  log('queue wake e2e');
} catch(error) {console.error(`FAIL ${error.stack||error}`);process.exitCode=1;}
finally {side?.db.close();if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}if(webhook)await new Promise(r=>webhook.close(r));await rm(home,{recursive:true,force:true});}
