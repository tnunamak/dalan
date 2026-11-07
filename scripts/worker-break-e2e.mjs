#!/usr/bin/env node
// Usage break and rolling-usage estimates against the real server and CLI: dot-worker break/breaks, status --json/--explain, auto-end on
// the worker's next tool call, the request-log backfill, and the status throttle block (counts and over_estimate, no holds) on rolling tool calls and response bytes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repo=fileURLToPath(new URL('..',import.meta.url));
const home=await mkdtemp(join(tmpdir(),'worker-break-e2e-'));
const root=join(home,'.local/share/dot-bridge'),port=19007;
const env={...process.env,DALAN_ENABLE_T3_TOOLS:'1',HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_AUTH_MODE:'',DOT_BRIDGE_ENABLE_WORKSPACE:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_CRASH_AT:'',DOT_BRIDGE_T3_DRY_RUN:'1'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let service,output='';
function run(argv,input='') { return new Promise((resolve,reject)=>{const child=spawn(argv[0],argv.slice(1),{cwd:repo,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.on('error',reject);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);}); }
const cli=(...argv)=>run([process.execPath,'bin/dalan.mjs',...argv]);
const ok=async(...argv)=>{const r=await cli(...argv);assert.equal(r.code,0,r.stderr);return argv.includes('--explain')&&!argv.includes('--json')?r.stdout:JSON.parse(r.stdout);};
async function until(test,label) { for(let i=0;i<200;i++){if(await test())return;await sleep(25);}throw new Error('timeout: '+label+'\n'+output); }
try {
  await mkdir(join(home,'.config/dot-bridge'),{recursive:true});
  await writeFile(join(home,'.config/dot-bridge/limits.json'),JSON.stringify({max_claimed_outer_assignments:10,background_max_in_flight:10,max_claims_per_hour:3,max_tool_calls_per_hour:5}),{mode:0o600});
  let ready=false;service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});service.stdout.on('data',b=>{output+=b;if(String(b).includes('MCP listening'))ready=true;});service.stderr.on('data',b=>output+=b);
  await until(()=>ready,'server startup');
  const secret=(await readFile(join(home,'.config/dot-bridge/env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const tool=async name=>{const r=await (await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:{}}})})).json();assert.equal(r.result.isError,false,JSON.stringify(r));return JSON.parse(r.result.content[0].text);};

  let status=await ok('status','--json');
  assert.deepEqual(status.worker_break,{active:false,since:null,reason:null,source:null,duration_ms:null});
  assert.deepEqual([status.throttle.claims_last_hour,status.throttle.tool_calls_last_hour,status.throttle.max_claims_per_hour,status.throttle.max_tool_calls_per_hour],[0,0,3,5]);
  assert.deepEqual(status.budget,{window:'rolling_24h',calls_used:0,calls_cap:10000,bytes_used:0,bytes_cap:100000000,remaining_fraction:1},'admin /status exposes budget through the real CLI');

  // refill is held only on evidence: an inferred break (silence) holds nothing, an owner-confirmed one holds. /owner-states is what `wait --drained` reads.
  const adminPost=(route,payload)=>new Promise((resolve,reject)=>{const req=http.request({socketPath:join(root,'admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json'}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve(JSON.parse(b)));});req.on('error',reject);req.end(JSON.stringify(payload));});
  assert.deepEqual((await adminPost('/owner-states',{items:[]})).refill,{held:null,paused:false,worker_break:false,throttled:false},'refill with no break');
  {
    const db=new DatabaseSync(join(root,'bridge.db'));
    db.prepare("INSERT INTO worker_breaks(since,reason,source,usage,created_at) VALUES(?,?,'inferred','{}',?)").run(new Date(Date.now()-3600000).toISOString(),'no worker tool call for 60 min',new Date().toISOString());
    status=await ok('status','--json');assert(status.worker_break.active&&status.worker_break.source==='inferred','inferred break not active: '+JSON.stringify(status.worker_break));
    assert.deepEqual((await adminPost('/owner-states',{items:[]})).refill,{held:null,paused:false,worker_break:false,throttled:false},'an inferred break held refill');
    db.prepare('DELETE FROM worker_breaks').run();db.prepare("DELETE FROM sqlite_sequence WHERE name='worker_breaks'").run();db.close();
  }

  // CLI break: validation, then mark one with --since
  for(const argv of [['break'],['break','--reason'],['break','--reason','x','--since','yesterday'],['break','--reason','x','--since',new Date(Date.now()+3600000).toISOString()],['break','--clear','--reason','x'],['break','--bogus']]) {
    const r=await cli(...argv,'--json');assert.equal(r.code,1,`accepted ${argv.join(' ')}`);
  }
  const since=new Date(Date.now()-3600000).toISOString(),reason='Synthetic usage pause for regression test.';
  const marked=await ok('break','--reason',reason,'--since',since,'--json');
  assert(marked.active&&marked.source==='owner'&&marked.since===since&&marked.reason===reason&&marked.duration_ms>=3600000,JSON.stringify(marked));
  status=await ok('status','--json');assert(status.worker_break.active&&status.worker_break.since===since&&status.worker_break.source==='owner');
  assert((await ok('status','--explain')).includes(` worker_break=since:${since}(owner)`),'explain lacks worker_break');

  assert.deepEqual((await adminPost('/owner-states',{items:[]})).refill,{held:'worker_break',paused:false,worker_break:true,throttled:false},'an owner break did not hold refill');

  // the worker's next tool call ends the break
  await tool('list_pending');
  status=await ok('status','--json');assert.equal(status.worker_break.active,false,'tool call did not end the break');
  const ledger=await ok('breaks','--json');
  assert(ledger.breaks.length===1&&ledger.breaks[0].end_source==='tool_call'&&ledger.breaks[0].source==='owner'&&ledger.breaks[0].reason===reason&&ledger.breaks[0].until,JSON.stringify(ledger));
  assert.deepEqual(Object.keys(ledger.breaks[0].usage_before),['1h','6h','24h']);
  assert.deepEqual(ledger.breaks[0].usage_before['1h'],{claims:0,finishes:0,tool_calls:null,checks_over_60s:0,response_bytes:null},'snapshot on a fresh bridge');

  // learned limits through the CLI: a fresh ledger learns nothing; --clear is supported and idempotent; unknown flags fail
  assert.deepEqual(await ok('learned','--json'),{learned:[],over_estimate:[]},'learned on a fresh bridge');
  assert.deepEqual(await ok('learned','--clear','--json'),{cleared:0,removed:[]},'learned --clear');
  assert.equal((await cli('learned','--bogus','--json')).code,1,'learned accepted --bogus');

  // request-log backfill: operator key required; complete lines only; merges request_log without clobbering; idempotent
  const brk=ledger.breaks[0], at=ms=>new Date(Date.parse(brk.since)-ms).toISOString();
  const line=(ms,tool,bytes)=>JSON.stringify({at:at(ms),kind:'mcp_outcome',tool,response_bytes:bytes,rpc_method:'tools/call'});
  const logFile=join(home,'requests-fixture.jsonl');
  await writeFile(logFile+'.2',[JSON.stringify({at:at(30*3600000),kind:'mcp_received'}),line(30*3600000,'get',1),line(20*3600000,'get',1000),''].join('\n'),{mode:0o600});
  await writeFile(logFile+'.1',[line(3*3600000,'read_file',700),'{"kind":"mcp_outcome", broken',''].join('\n')+'incomplete old tail',{mode:0o600});
  await writeFile(logFile,[
    line(1800000,'t3_thread_list',1000000),line(60000,'read_file',2000),line(-60000,'t3_thread_list',999),JSON.stringify({at:at(60000),kind:'mcp_outcome',tool:null,response_bytes:50}),
    ''].join('\n')+line(1000,'t3_thread_list',777).slice(0,40),{mode:0o600});
  const denied=await new Promise((resolve,reject)=>{const req=http.request({socketPath:join(root,'admin.sock'),path:'/break-usage-backfill',method:'POST',headers:{'content-type':'application/json'}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b)}));});req.on('error',reject);req.end(JSON.stringify({id:brk.id,since:brk.since,windows:{}}));});
  assert.deepEqual(denied,{status:400,body:{error:'invalid operator key'}},'backfill without the operator key');
  for(const argv of [['break-usage-backfill'],['break-usage-backfill','--id','0'],['break-usage-backfill','--id','99','--log',logFile],['break-usage-backfill','--id','1','--bogus']]) assert.equal((await cli(...argv,'--json')).code,1,`accepted ${argv.join(' ')}`);
  const filled=await ok('break-usage-backfill','--id',String(brk.id),'--log',logFile,'--json');
  assert.equal(filled.updated,true,JSON.stringify(filled));
  assert.deepEqual(filled.log,{file:logFile,lines:9,outcomes:6,skipped:1,first_at:at(30*3600000)},'log scan: '+JSON.stringify(filled.log));
  assert.deepEqual(filled.usage_before['1h'],{claims:0,finishes:0,tool_calls:null,checks_over_60s:0,response_bytes:null,request_log:{source:'request_log',response_bytes:1002000,calls:2,by_tool:{t3_thread_list:{calls:1,bytes:1000000},read_file:{calls:1,bytes:2000}}}});
  assert.deepEqual(filled.usage_before['24h'].request_log,{source:'request_log',response_bytes:1003700,calls:4,by_tool:{t3_thread_list:{calls:1,bytes:1000000},read_file:{calls:2,bytes:2700},get:{calls:1,bytes:1000}}});
  assert.equal((await ok('break-usage-backfill','--id',String(brk.id),'--log',logFile,'--json')).updated,false,'backfill not idempotent');
  const after=(await ok('breaks','--json')).breaks[0];
  assert.deepEqual(after.usage_before,filled.usage_before,'breaks shows the merged snapshot');
  const defaultLog=await ok('break-usage-backfill','--id',String(brk.id),'--json');
  assert.equal(defaultLog.log.file,join(home,'.local/state/dot-bridge/requests.jsonl'),'default request log path');
  assert(defaultLog.log.outcomes>0&&defaultLog.usage_before['1h'].request_log.partial===true,'default log scan: '+JSON.stringify(defaultLog.log));
  assert.equal((await cli('breaks','--bogus')).code,1);
  assert.equal((await ok('break','--clear','--json')).cleared,false,'clear without an active break');

  // tool calls at the estimate are reported (over_estimate) and hold nothing; the status throttle block is what a producer reads
  for(let i=0;i<4;i++) await tool('list_pending');
  const gate=(await ok('status','--json')).throttle;
  assert(gate.tool_calls_last_hour===5&&gate.over_estimate.includes('tool_calls_per_hour')&&gate.submit_throttled===false&&gate.rewake_throttled===false&&gate.normal_rewake_throttled===false&&JSON.stringify(gate.holding)==='{"rewake":[],"submit":[]}','tool-call estimate: '+JSON.stringify(gate));
  {const explain=await ok('status','--explain');assert(/ over_estimate=tool_calls_per_hour/.test(explain)&&!/throttle=|holding:/.test(explain),'explain lacks over_estimate or still shows a throttle: '+explain);}
  assert.deepEqual((await ok('learned','--json')).over_estimate.map(o=>[o.name,o.limit]),[['tool_calls_per_hour',5]],'learned --json over_estimate');
  // response-byte estimate against a second bridge: max_response_bytes_per_hour 100000, a fake t3code with 60 KB reads
  { const exited=new Promise(resolve=>service.once('exit',resolve));service.kill('SIGTERM');await exited; }
  const home2=await mkdtemp(join(tmpdir(),'dalan-break-bytes-e2e-')), root2=join(home2,'.local/share/dot-bridge'), port2=port+1;
  try {
    const env2={...env,HOME:home2, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_PORT:String(port2),DOT_BRIDGE_T3CODE_BIN:join(home2,'t3code'),NODE_ENV:'test'};
    await mkdir(join(home2,'.config/dot-bridge'),{recursive:true});
    await writeFile(join(home2,'.config/dot-bridge/limits.json'),JSON.stringify({max_claimed_outer_assignments:10,background_max_in_flight:10,max_claims_per_hour:1000,max_tool_calls_per_hour:100000,max_response_bytes_per_hour:100000}),{mode:0o600});
    await writeFile(join(home2,'t3code'),`#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,data:{thread:{id:'thread_fake',status:'active',messages:[{role:'assistant',text:'x'.repeat(60000)}]}}}));\n`,{mode:0o755});
    const run2=(argv,input='')=>new Promise((resolve,reject)=>{const child=spawn(argv[0],argv.slice(1),{cwd:repo,env:env2,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.on('error',reject);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);});
    const status2=async()=>{const r=await run2([process.execPath,'bin/dalan.mjs','status','--json']);assert.equal(r.code,0,r.stderr);return JSON.parse(r.stdout);};
    let ready2=false;service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env:env2,stdio:['ignore','pipe','pipe']});service.stdout.on('data',b=>{output+=b;if(String(b).includes('MCP listening'))ready2=true;});service.stderr.on('data',b=>output+=b);
    await until(()=>ready2,'second server startup');
    const secret2=(await readFile(join(home2,'.config/dot-bridge/env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    let received=0;
    const read=async()=>{const text=await (await fetch(`http://127.0.0.1:${port2}/${secret2}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'t3_thread_read',arguments:{threadId:'thread_fake'}}})})).text();assert.equal(JSON.parse(text).result.isError,false,text.slice(0,300));received+=Buffer.byteLength(text);};
    let t=(await status2()).throttle;assert.deepEqual([t.response_bytes_last_hour,t.max_response_bytes_per_hour,t.submit_throttled],[0,100000,false]);assert.deepEqual(t.over_estimate,[]);
    await read();t=(await status2()).throttle;
    assert(t.response_bytes_last_hour===received&&received>60000&&received<100000&&!t.submit_throttled&&!t.rewake_throttled&&t.over_estimate.length===0,'under: '+JSON.stringify(t));
    await read();t=(await status2()).throttle;
    assert(t.response_bytes_last_hour===received&&received>=100000&&t.over_estimate.join()==='response_bytes_per_hour'&&!t.submit_throttled&&!t.rewake_throttled,'over: '+JSON.stringify(t));
    const explained=await run2([process.execPath,'bin/dalan.mjs','status','--explain']);
    assert(explained.stdout.includes(` bytes=1h:${received}/100000,24h:${received}/`)&&explained.stdout.includes(' over_estimate=response_bytes_per_hour')&&!explained.stdout.includes('holding:'),'explain lacks bytes or the reached estimate: '+explained.stdout);
    // the worker's own calls are never refused over the limit
    await read();assert.equal((await status2()).throttle.response_bytes_last_hour,received,'a call over the byte limit was refused or not counted');
  } finally { if(service&&service.exitCode===null&&service.signalCode===null){const exited=new Promise(resolve=>service.once('exit',resolve));service.kill('SIGTERM');await exited;} await rm(home2,{recursive:true,force:true}); }
  console.log('PASS break e2e: CLI break/breaks with validation, status --json/--explain, auto-end on tool call, refill held by an owner break and not by an inferred one, tool-call and response-byte over_estimate status (nothing held), request-log backfill (operator key, complete lines, merge, idempotent)');
} finally { if(service&&service.exitCode===null&&service.signalCode===null){const exited=new Promise(resolve=>service.once('exit',resolve));service.kill('SIGTERM');await exited;} await rm(home,{recursive:true,force:true}); }
