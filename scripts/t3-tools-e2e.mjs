#!/usr/bin/env node
import http from 'node:http';
import { readLines } from '../src/request-log.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { reservedPort } from '../src/test-support/port.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname);
const tempRoot=join(os.homedir(),'.tmp');
mkdirSync(tempRoot,{recursive:true});
const home=mkdtempSync(join(tempRoot,'dalan-bridge-t3-'));
process.once('exit',()=>rmSync(home,{recursive:true,force:true}));
const port=Number(process.env.E2E_T3_PORT)||await reservedPort();
const calls=[];
const env={...process.env,DALAN_ENABLE_T3_TOOLS:'1',HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:String(port),PATH:`${join(home,'bin')}:${process.env.PATH}`};

function assert(value,message){if(!value)throw new Error(message);}
function run(argv,input){return new Promise(resolve=>{const child=spawn(argv[0],argv.slice(1),{cwd:repo,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input??'');});}
async function waitFor(predicate,label){const start=Date.now();while(Date.now()-start<7000){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error(`timed out waiting for ${label}`);}
const sent={};
async function rpc(secret,name,args={},meta){const body=JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args,...(meta===undefined?{}:{_meta:meta})}});const res=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body});const text=await res.text();sent[name]=(sent[name]??0)+Buffer.byteLength(text);return JSON.parse(text);}
function toolResult(response){assert(!response.result.isError,response.result.content[0].text);return JSON.parse(response.result.content[0].text);}

const ntfy=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push({kind:'ntfy',title:req.headers.title,body});res.writeHead(200).end('ok');});
await new Promise(resolve=>ntfy.listen(0,'127.0.0.1',resolve));

await mkdir(join(home,'bin'),{recursive:true});
await mkdir(join(home,'.config','dot-bridge'),{recursive:true});
await writeFile(join(home,'.config','dot-bridge','alerts.env'),`NTFY_URL=http://127.0.0.1:${ntfy.address().port}/alert\n`,{mode:0o600});
await writeFile(join(home,'bin','t3code'),`#!/usr/bin/env node
const args=process.argv.slice(2);
const command=args[args.indexOf('threads')+1];
if(command==='send' && args[args.indexOf('--thread')+1]==='thread_epipe') {
  require('fs').writeFileSync(process.env.HOME+'/early-stdin-close','0');
  require('fs').closeSync(0);
  console.error('fixture closed stdin before reading');
  process.exit(2);
}
if(command==='read' && args[args.indexOf('--thread')+1]==='thread_fail') { console.error('forced failure'); process.exit(7); }
let stdin='';
process.stdin.on('data',b=>stdin+=b);
process.stdin.on('end',()=>{
  const command=args[args.indexOf('threads')+1];
  require('fs').appendFileSync(process.env.HOME+'/t3-invocations',command+'\\n');
  if(stdin.includes('force failure')) { console.error('forced failure'); process.exit(7); }
  const data={command,args,stdin,thread:{id:'thread_fake',projectId:'project_fake',latestRun:{runId:'run_fake'}},message:{messageId:'message_fake'}};
  if(command==='list' && args.includes('active')) return import(${JSON.stringify(join(repo,'scripts/fixtures/t3-threads.mjs'))}).then(m=>console.log(JSON.stringify({ok:true,data:{...m.syntheticThreadList(),args}})));
  if(command==='list') data.threads=[{id:'thread_a',projectId:'project_fake',updatedAt:'2000-01-01T00:00:00.000Z',limitRecovery:{requestId:'x'}},{id:'thread_b',projectId:'project_fake',updatedAt:'2000-01-01T01:00:00.000Z'}];
  if(command==='wait' && args.includes('--timeout') && args[args.indexOf('--timeout')+1]==='1') { console.log(JSON.stringify({ok:false,error:{code:'THREAD_WAIT_TIMEOUT',message:'timed out'}})); process.exit(6); }
  if(command==='read') data.thread={id:args[args.indexOf('--thread')+1],status:'active',projectId:'project_fake',turns:[{finalMessageId:'final_msg'}]};
  console.log(JSON.stringify({ok:true,data}));
});
`,{mode:0o755});

const child=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
let ready=false;child.stdout.on('data',b=>{if(String(b).includes('MCP listening'))ready=true;});child.stderr.on('data',b=>process.stderr.write(b));
try {
  await waitFor(()=>ready,'service');
  const secret=(await readFile(join(home,'.config','dot-bridge','env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  // t3_thread_list returns the compact shape, never the raw t3code payload
  const list=toolResult(await rpc(secret,'t3_thread_list',{status:'all'}));
  assert(JSON.stringify(list.threads.map(t=>t.id))==='["thread_b","thread_a"]'&&list.total===2&&list.shown===2&&list.truncated===false,'compact list: '+JSON.stringify(list));
  assert(!('args' in list)&&!('command' in list)&&!('limitRecovery' in list.threads[1]),'raw fields leaked: '+JSON.stringify(list));
  assert(JSON.stringify(list.projects)==='[{"id":"project_fake","title":null,"count":2}]','projects: '+JSON.stringify(list.projects));
  const before=sent.t3_thread_list, large=toolResult(await rpc(secret,'t3_thread_list',{status:'active'})), largeBytes=sent.t3_thread_list-before;
  assert(largeBytes<20000&&large.total===512&&large.truncated===true&&large.shown===large.threads.length&&large.shown>=30,`synthetic large list ${largeBytes} bytes, ${large.shown} shown`);
  const read=toolResult(await rpc(secret,'t3_thread_read',{threadId:'thread_fake',turns:2,maxChars:50}));
  assert(read.command==='read','read command');
  assert(read.args.includes('--origin')&&read.args.includes('http://127.0.0.1:3773'),'origin not pinned');
  const create=toolResult(await rpc(secret,'t3_thread_create',{cwd:repo,provider:'claudeAgent',model:'claude-haiku-4-5',thinkingEffort:'low',permission:'full-access',prompt:'hello create'}));
  assert(create.command==='create'&&create.stdin==='hello create'&&create.args.includes('--stdin'),'create stdin');
  const send=toolResult(await rpc(secret,'t3_thread_send',{threadId:'thread_fake',mode:'queue',wakeSettled:true,provider:'claudeAgent',model:'claude-haiku-4-5',permission:'full-access',message:'hello send'}));
  assert(send.command==='send'&&send.stdin==='hello send'&&send.args.includes('--wake-settled'),'send stdin wake');
  const partial=toolResult(await rpc(secret,'t3_thread_wait',{threadId:'thread_fake',timeoutMs:1}));
  assert(partial.still_running===true&&partial.partial.thread.id==='thread_fake','wait partial');
  assert(toolResult(await rpc(secret,'t3_thread_set',{threadId:'thread_fake',provider:'claudeAgent',model:'claude-haiku-4-5'})).command==='set','set command');
  // One notify scenario: concurrent/sequential retries replay the first success.
  const notices=(await Promise.all([rpc(secret,'notify_owner',{text:'short alert'}),rpc(secret,'notify_owner',{text:'short alert'})])).map(toolResult);
  notices.push(toolResult(await rpc(secret,'notify_owner',{text:'short alert'})));
  assert(notices.every(result=>JSON.stringify(result)==='{"notified":true}'),'notify identical first result');
  assert(calls.filter(call=>call.kind==='ntfy').length===1&&calls.find(call=>call.kind==='ntfy').body==='short alert','notify payload retries sent more than once');
  const meta={'dot-bridge/idempotencyKey':'fixture-notice'};
  const keyed=toolResult(await rpc(secret,'notify_owner',{text:'keyed alert'},meta));
  const replay=toolResult(await rpc(secret,'notify_owner',{text:'changed payload for same key'},meta));
  assert(JSON.stringify(keyed)===JSON.stringify(replay)&&calls.filter(call=>call.kind==='ntfy').length===2,'notify key did not replay first result');
  for(const key of ['',null,123,'x'.repeat(257)]) {
    const invalid=await rpc(secret,'notify_owner',{text:'must not send'},{'dot-bridge/idempotencyKey':key});
    assert(invalid.result.isError,'invalid explicit notify key accepted');
  }
  assert(calls.filter(call=>call.kind==='ntfy').length===2,'invalid key caused ntfy effect');
  const failed=await rpc(secret,'t3_thread_send',{threadId:'thread_fake',message:'force failure'});
  assert(failed.result.isError,'expected t3 failure');
  const epiped=await rpc(secret,'t3_thread_send',{threadId:'thread_epipe',message:'x'.repeat(262144)});
  assert(epiped.result.isError && epiped.result.content[0].text.includes('fixture closed stdin before reading'),'early-close fixture not reached: '+JSON.stringify(epiped));
  assert(await readFile(join(home,'early-stdin-close'),'utf8')==='0','early-close child consumed stdin');
  assert(toolResult(await rpc(secret,'t3_thread_read',{threadId:'thread_after_epipe'})).thread.id==='thread_after_epipe','service did not survive child stdin closure');
  assert((await rpc(secret,'t3_thread_read',{threadId:'thread_fail'})).result.isError,'expected t3 read failure');
  assert(toolResult(await rpc(secret,'t3_thread_read',{threadId:'thread_after_failure'})).thread.id==='thread_after_failure','service did not survive child stdin closure');

  const tell=await run([process.execPath,'bin/dot-worker.mjs','tell','hello worker','--json']);
  assert(tell.code===0,tell.stderr);
  const msg=JSON.parse(tell.stdout);
  const pending=toolResult(await rpc(secret,'list_pending',{}));
  assert(pending.assignments.some(item=>item.kind==='message'&&item.request_id===msg.message_id),'message pending');
  const got=toolResult(await rpc(secret,'get',{request_id:msg.message_id}));
  assert(got.message.text==='hello worker','message get');
  const ack=toolResult(await rpc(secret,'ack_message',{message_id:msg.message_id}));
  assert(ack.message.status==='acknowledged','message ack');

  const audit=await run([process.execPath,'bin/dot-worker.mjs','audit','--json']);
  assert(audit.code===0,audit.stderr);
  const entries=JSON.parse(audit.stdout).entries;
  for(const tool of ['t3_thread_list','t3_thread_read','t3_thread_create','t3_thread_send','t3_thread_wait','t3_thread_set','notify_owner']) assert(entries.some(row=>row.tool===tool&&row.result_status==='success'),`missing audit ${tool}`);
  assert(entries.some(row=>row.tool==='t3_thread_send'&&row.result_status.startsWith('error:')),'missing failure audit');
  assert(entries.some(row=>row.tool==='t3_thread_send'&&row.text_sha256===createHash('sha256').update('hello send').digest('hex')&&row.text_preview===null),'missing send text digest audit');
  const listAudit=entries.find(row=>row.tool==='t3_thread_list'&&row.result_status==='success'&&row.args_summary.status==='all');
  assert(listAudit.t3_ids.threadIds.includes('thread_a')&&listAudit.t3_ids.threadIds.includes('thread_b'),'list thread ids missing');
  const activeAudit=entries.find(row=>row.tool==='t3_thread_list'&&row.result_status==='success'&&row.args_summary.status==='active');
  assert(activeAudit.t3_ids.threadIds.length===large.shown&&large.threads.every(t=>activeAudit.t3_ids.threadIds.includes(t.id)),'active list audit ids are not the shown threads');
  // response-byte accounting: per tool, the bytes the client received
  const db=new DatabaseSync(join(home,'.local/share/dot-bridge/bridge.db'),{readOnly:true});
  const rows=Object.fromEntries(db.prepare('SELECT tool,sum(count) count,sum(bytes) bytes FROM worker_calls GROUP BY tool').all().map(r=>[r.tool,r]));db.close();
  for(const [tool,bytes] of Object.entries(sent)) assert(rows[tool]?.bytes===bytes,`${tool} bytes ${rows[tool]?.bytes} != received ${bytes}`);
  assert(rows.t3_thread_list.count===2&&rows.t3_thread_read.count===4&&rows.t3_thread_send.count===3,'per-tool counts: '+JSON.stringify(rows));
  // t3_read_tools=off: list and read answer with a short stub, never run t3code, and are audited and logged as blocked.
  const limits=join(home,'.config','dot-bridge','limits.json');
  await writeFile(limits,JSON.stringify({t3_read_tools:'off'}),{mode:0o600});
  const invocations=async()=>(await readFile(join(home,'t3-invocations'),'utf8')).split('\n').filter(Boolean).length;
  const ranBefore=await invocations();
  for(const [tool,args] of [['t3_thread_list',{status:'all'}],['t3_thread_read',{threadId:'thread_fake'}]]) {
    const response=await rpc(secret,tool,args);
    assert(response.result.content[0].text.length<=130,`${tool} stub is ${response.result.content[0].text.length} bytes`);
    assert(toolResult(response).message==='T3 thread tools are off; the needed context is inlined in your assignment.',`${tool} stub text`);
  }
  assert(await invocations()===ranBefore,'t3code ran while t3_read_tools=off');
  const blocked=JSON.parse((await run([process.execPath,'bin/dot-worker.mjs','audit','--json'])).stdout).entries.filter(row=>row.result_status==='blocked: t3_read_tools=off');
  assert(JSON.stringify(blocked.map(row=>row.tool).sort())==='["t3_thread_list","t3_thread_read"]','blocked audit rows: '+JSON.stringify(blocked));
  const blockedLog=[...readLines(join(home,'.local/state/dot-bridge/requests.jsonl'))].filter(line=>line.includes('"t3_read_tool_blocked"'));
  assert(blockedLog.length===2,'blocked log lines: '+blockedLog.length);
  // The switch is reread per call: on again without a restart.
  await writeFile(limits,JSON.stringify({t3_read_tools:'on'}),{mode:0o600});
  assert(toolResult(await rpc(secret,'t3_thread_list',{status:'all'})).total===2,'list after t3_read_tools=on');
  console.log(`PASS t3_read_tools=off stub, audit and log; on again without restart`);
  console.log(`PASS T3 tools, compact list (${largeBytes} bytes for 512 synthetic threads), message queue, notify_owner, audit, response bytes per tool`);
} finally {
  if(child.exitCode===null&&child.signalCode===null) { child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve)); }
  await new Promise(resolve=>ntfy.close(resolve));
  await rm(home,{recursive:true,force:true});
}
