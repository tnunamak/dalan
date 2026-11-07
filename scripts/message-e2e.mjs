#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { completeJsonLines } from './jsonl.mjs';
import { startT3ResultFixture } from '../src/test-support/t3-result-fixture.mjs';

import { reservedPort } from '../src/test-support/port.mjs';
const repo = resolve(new URL('..', import.meta.url).pathname);
const home = mkdtempSync(join(os.homedir(), '.tmp/dalan-bridge-message-'));
process.once('exit', () => rmSync(home, {recursive: true, force: true}));
const port = Number(process.env.MESSAGE_E2E_PORT) || await reservedPort();
const threadId = 'thread_active';
let t3Fixture;
const env = {
  ...process.env,
  HOME: home,
  DALAN_LEGACY_PROFILE: '1',
  DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1',
  DOT_BRIDGE_PORT: String(port),
  NODE_ENV: 'test',
  DOT_BRIDGE_T3_DRY_RUN: '0',
  DOT_BRIDGE_T3CODE_BIN: join(home, 'bin', 't3code'),
  DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1',
  PATH: `${join(home, 'bin')}:${process.env.PATH}`
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

function run(argv, input) {
  return new Promise((resolveRun) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input || '');
  });
}

async function waitFor(predicate, label) {
  const start = Date.now();
  while (Date.now() - start < 7000) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function setupHome() {
  await rm(home, { recursive: true, force: true });
  await mkdir(join(home, '.config/dot-bridge'), { recursive: true }); // Existing-home compatibility fixture.
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, 'bin', 't3code'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),thread=args[args.indexOf('--thread')+1];
if(args.includes('send')) {
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);
  process.stdin.on('end',()=>{fs.appendFileSync(path.join(process.env.HOME,'sent.jsonl'),JSON.stringify({args,input})+'\\n');console.log(JSON.stringify({ok:true,data:{}}));});
} else console.log(JSON.stringify({ok:true,data:{thread:{id:thread,status:thread.startsWith('settled')?'settled':thread.startsWith('archived')?'archived':'active'},runtime:{environmentId:'fake-environment'}}}));
`, { mode: 0o755 });
}

async function startService() {
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  process.once('exit', () => child.kill('SIGTERM'));
  let ready = false;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    if (chunk.includes('MCP listening')) ready = true;
  });
  child.stderr.setEncoding('utf8').on('data', chunk => process.stderr.write(chunk));
  await waitFor(() => ready, 'service');
  return child;
}

async function stopService(child) {
  child.kill('SIGTERM');
  await new Promise(resolveStop => child.once('exit', resolveStop));
}

async function rpc(secret, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
  const response = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return response.json();
}

async function callTool(secret, name, args) {
  const result = await rpc(secret, 'tools/call', { name, arguments: args });
  assert(!result.result.isError, `${name} failed: ${result.result.content[0].text}`);
  return JSON.parse(result.result.content[0].text);
}

async function main() {
  await setupHome();
  t3Fixture = await startT3ResultFixture({home,threadId,fakeCommand:join(home,'bin','t3code'),messageFile:'sent.jsonl'});
  Object.assign(env,t3Fixture.env);
  let service = await startService();
  const secret = (await readFile(join(home, '.config', 'dot-bridge', 'env'), 'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const events=[];
  const webhook=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);if(value.type==='verification')res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({challenge:value.challenge}));else{events.push(value);res.writeHead(204).end();}});
  await new Promise(resolveListen=>webhook.listen(0,'127.0.0.1',resolveListen));
  const subscription=await rpc(secret,'events/subscribe',{name:'assignment.available',arguments:{},delivery:{mode:'webhook',url:`http://127.0.0.1:${webhook.address().port}/hook`,secret:`whsec_${randomBytes(32).toString('base64')}`}});
  assert(subscription.result?.id,'message webhook subscription failed');
  assert((await run([process.execPath,'bin/dot-worker.mjs','tell','--help','--json'])).code!==0,'tell accepted option as text');

  const cli=(...args)=>run([process.execPath,'bin/dot-worker.mjs',...args,'--json']);
  const submit=async(thread='thread_active')=>{
    const request_id='req_'+randomUUID();
    const result=await run([process.execPath,'bin/dot-worker.mjs','submit','--thread',thread,'--stdin','--json'],JSON.stringify({schema_version:1,request_id,brief:'Assignment note test',inputs:[],expected_output:'test',execution_scope:'read-only'}));
    assert(result.code===0,result.stderr);return request_id;
  };
  const sent=async()=>{try{return completeJsonLines(await readFile(join(home,'sent.jsonl'),'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const requestId=await submit();
  const firstReply=await cli('note',requestId,'first answer');assert(firstReply.code===0,firstReply.stderr);
  const firstNote=JSON.parse(firstReply.stdout);
  const acquisitionId=`note-run-${requestId}`;
  const claim=await callTool(secret,'claim',{request_id:requestId,claimant:'note-test',acquisition_id:acquisitionId});
  assert(claim.owner_notes.length===1&&claim.owner_notes[0].id===firstNote.id,'fresh claim missing notes');
  const secondReply=await cli('note',requestId,'second answer');assert(secondReply.code===0,secondReply.stderr);
  const secondNote=JSON.parse(secondReply.stdout);
  const maxText='é'.repeat(2048); // 4096 UTF-8 bytes
  const maxNote=await cli('note',requestId,maxText);assert(maxNote.code===0,maxNote.stderr);
  for(const text of ['--help','--thread','x'.repeat(4097),'é'.repeat(2049)]) assert((await cli('note',requestId,text)).code!==0,'note accepted flag or oversized text');
  assert((await cli('note',requestId)).code!==0,'note accepted empty text');
  assert((await cli('note','req_missing','answer')).code!==0,'note accepted missing receipt');
  const denied=await new Promise((resolveDenied,rejectDenied)=>{
    const body=JSON.stringify({id:requestId,text:'unauthorized'});
    const req=http.request({socketPath:join(home,'.local/share/dot-bridge/admin.sock'),path:'/note',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolveDenied(res.statusCode));});
    req.on('error',rejectDenied);req.end(body);
  });
  assert(denied===400,'note did not require owner capability');
  await waitFor(()=>events.some(e=>e.data?.title?.includes(secondNote.id)),'claimed assignment note event');
  const noteEvent=events.find(e=>e.data?.title?.includes(secondNote.id));
  assert(noteEvent.name==='assignment.available'&&noteEvent.data.request_id===requestId&&noteEvent.data.title.startsWith('Owner note ')&&noteEvent.data.title.endsWith('Assignment note test'),'note event payload');
  assert(Object.keys(noteEvent.data).sort().join(',')==='request_id,title','unexpected note event fields');
  const repeat=await callTool(secret,'claim',{request_id:requestId,claimant:'note-test',acquisition_id:acquisitionId});
  const beforeRestart=await callTool(secret,'get',{request_id:requestId});
  assert(JSON.stringify(repeat.owner_notes)===JSON.stringify(beforeRestart.owner_notes),'repeat claim notes differ');
  assert(repeat.owner_notes.map(n=>n.text).join('|')===['first answer','second answer',maxText].join('|'),'note ordering or text changed');
  assert(repeat.owner_notes.every(n=>n.id&&n.at&&Object.keys(n).sort().join(',')==='at,id,text'),'note result shape');
  const listed=await rpc(secret,'events/list',{});
  assert(!listed.result.events[0].payloadSchema.properties.note_id,'event schema must stay identical to the catalog ChatGPT cached (no note_id)');
  const progress=note=>callTool(secret,'progress',{request_id:requestId,claim_id:claim.claim_id,note});
  await progress('ordinary progress');
  await progress('QUESTION: first question');await progress('QUESTION: first question');
  await progress('BLOCKED: second question');
  await callTool(secret,'progress',{request_id:requestId,claim_id:claim.claim_id,note:'explicit blocker',blocker:true});
  await waitFor(async()=> (await callTool(secret,'get',{request_id:requestId})).delivery.filter(d=>d.kind==='blocker'&&d.state==='delivered').length===3,'blocker delivery');
  const blockerSends=(await sent()).filter(x=>x.input.includes('Worker question for request '+requestId));
  assert(blockerSends.length===3,'duplicate blocker was sent or normal progress forwarded');
  for(const item of blockerSends) {
    assert(JSON.stringify(item.args)===JSON.stringify(['--json','--origin','http://127.0.0.1:3773','threads','send','--thread','thread_active','--stdin','--if-busy','steer']),'unexpected blocker argv');
    assert(item.input.includes('[dot-bridge event evt_')&&!item.args.includes('--wake-settled'),'blocker marker/lifecycle changed');
  }

  const told = await run([process.execPath, 'bin/dot-worker.mjs', 'tell', 'stand by for a tiny check', '--json']);
  assert(told.code === 0, told.stderr);
  const queued = JSON.parse(told.stdout);
  assert(queued.message_id?.startsWith('msg_') && queued.preview === 'stand by for a tiny check', 'tell did not queue message');
  await waitFor(()=>events.some(event=>event.data?.message_id===queued.message_id),'message wake event');
  assert(events.find(event=>event.data?.message_id===queued.message_id).data.title===queued.preview,'message event title');

  const withdrawn=JSON.parse((await run([process.execPath,'bin/dot-worker.mjs','tell','withdraw this','--json'])).stdout);
  const badWorker=await run([process.execPath,'bin/dot-worker.mjs','untell',withdrawn.message_id,'--worker','no-such-worker','--json']);
  assert(badWorker.code!==0,'untell with an unknown --worker must fail');
  const untold=await run([process.execPath,'bin/dot-worker.mjs','untell',withdrawn.message_id,'--worker','dot','--json']);
  assert(untold.code===0&&JSON.parse(untold.stdout).status==='withdrawn','untell did not withdraw');
  assert((await callTool(secret,'get',{request_id:withdrawn.message_id})).message.status==='withdrawn','withdrawn message get');

  await stopService(service);
  service = await startService();

  assert(JSON.stringify((await callTool(secret,'get',{request_id:requestId})).owner_notes)===JSON.stringify(beforeRestart.owner_notes),'notes lost across restart');
  await callTool(secret,'finish',{request_id:requestId,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'done'});
  await waitFor(async()=> (await sent()).some(x=>x.input.includes('Request '+requestId+': completed')),'result delivery');
  for(const item of (await sent()).filter(x=>x.input.includes('Attention: request '+requestId)||x.input.includes('Request '+requestId+': completed'))) {
    assert(JSON.stringify(item.args)===JSON.stringify(['threads','send','--thread','thread_active','--stdin','--if-busy','steer']),'unexpected result/watch argv');
  }
  for(const status of ['settled','archived']) {
    const request_id=await submit(status+'_thread'),c=await callTool(secret,'claim',{request_id,claimant:'note-test'});
    await callTool(secret,'progress',{request_id,claim_id:c.claim_id,note:'QUESTION: do not wake'});
    await waitFor(async()=> (await callTool(secret,'get',{request_id})).delivery.some(d=>d.kind==='blocker'&&d.state==='suppressed'),'lifecycle suppression');
    assert(!(await sent()).some(x=>x.input.includes(request_id)),'woke '+status+' thread');
    assert((await cli('cancel',request_id)).code===0,'cancel lifecycle assignment');
  }

  const pending = await callTool(secret, 'list_pending', {});
  const item = pending.assignments.find(entry => entry.kind === 'message' && entry.message_id === queued.message_id);
  assert(item && item.title === queued.preview, 'message missing from list_pending after restart');
  assert(!pending.assignments.some(entry=>entry.message_id===withdrawn.message_id),'withdrawn message still pending');

  const got = await callTool(secret, 'get', { request_id: queued.message_id });
  assert(got.kind === 'message' && got.message.text === 'stand by for a tiny check', 'get did not return message text');
  assert(got.message.text_sha256 === queued.text_sha256, 'message digest changed');

  const ack = await callTool(secret, 'ack_message', { message_id: queued.message_id });
  assert(ack.message.status === 'acknowledged' && ack.message.acknowledged_at, 'ack_message did not acknowledge');

  const afterAck = await callTool(secret, 'list_pending', {});
  assert(!afterAck.assignments.some(entry => entry.message_id === queued.message_id), 'acknowledged message still pending');

  const {Store}=await import('../src/store.mjs'),batch=new Store(join(home,'batch.db'));
  for(let i=0;i<51;i++) batch.tell(`offline message ${i}`);
  batch.subscribe('sub_batch','https://example.com/hook','whsec_test',new Date(Date.now()+60000).toISOString());
  assert(batch.db.prepare("SELECT count(*) n FROM notifications WHERE message_id IS NOT NULL").get().n===51,'subscription recovery skipped pending messages beyond inbox limit');

  const batchId='req_notes_batch';
  batch.submit({request_id:batchId,brief:'batch'},'thread','env','owner');
  const saved=batch.note(batchId,'kept');
  for(const sql of ['UPDATE owner_notes SET text=\'changed\'','DELETE FROM owner_notes']) {
    let rejected=false;try{batch.db.exec(sql);}catch(error){rejected=/append-only/.test(error.message);}
    assert(rejected,'owner note mutation allowed');
  }
  assert(batch.ownerNotes(batchId)[0].id===saved.id,'append-only note changed');
  assert((()=>{try{batch.note(batchId,'x'.repeat(4097));return false;}catch{return true;}})(),'store accepted oversized note');
  batch.db.close();
  console.log('PASS assignment notes: owner receipt, append-only storage, ordered get/claim, events, restart, limits and flags');
  console.log('PASS blocker steer and dedupe; result queue; settled/archived targets suppressed with fake t3code');

  await stopService(service);
  await new Promise(resolveClose=>webhook.close(resolveClose));
  await t3Fixture.close();
  console.log('PASS lightweight messages tell/list/get/ack survive restart');
}

main().catch(error => {
  t3Fixture?.close().catch(()=>{});
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
