#!/usr/bin/env node
// `dot-worker inbox` against a real bridge in an isolated HOME: producer scope, --all, finished-unread until `get`, questions,
// expiry cancellations, bridge restart, and no 'consumed' events from the inbox's reads.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { readLines } from '../src/request-log.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname),home=await mkdtemp(join(homedir(),'.tmp/dalan-bridge-inbox-'));
const port=8913,producer='producer-thread-aaaa',other='producer-thread-bbbb';
const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:String(port),DOT_DRAINED_INTERVAL_MS:'100',PATH:`${join(home,'bin')}:${process.env.PATH}`};
for(const k of ['CLAUDE_CODE_SESSION_ID','CODEX_THREAD_ID']) delete env[k];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function run(argv,input,extra={}) { return new Promise(r=>{const child=spawn(argv[0],argv.slice(1),{cwd:repo,env:{...env,...extra},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>r({code,stdout,stderr}));child.stdin.end(input);}); }
function start(argv,extra={}) { const child=spawn(argv[0],argv.slice(1),{cwd:repo,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let stdout='',stderr='',exited=false;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise(r=>child.on('close',code=>{exited=true;r({code,stdout,stderr});}));return {child,done,get exited(){return exited;}}; }
function adminSubmit(assignment,route='/submit') { return new Promise((resolve,reject)=>{const bytes=JSON.stringify({assignment,owner_token:'synthetic-owner-token-'.padEnd(64,'x'),delivery:'none'});const req=http.request({socketPath:join(home,'.local/share/dot-bridge/admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(bytes)}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end(bytes);}); }
async function waitFor(test,label) { for(let t=0;t<5000;t+=25) { if(await test()) return; await sleep(25); } throw new Error(`timed out waiting for ${label}`); }
const cli=(...a)=>run([process.execPath,'bin/dalan.mjs',...a]);
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
  const serverNoInputs=await adminSubmit({schema_version:1,request_id:`req_${randomUUID()}`,brief:'missing inputs',expected_output:'x',execution_scope:'read-only'});
  assert.equal(serverNoInputs.status,400); assert.match(serverNoInputs.body.error,/inputs must be an array/);
  const serverNoId=await adminSubmit({schema_version:1,brief:'missing id',inputs:[],expected_output:'x',execution_scope:'read-only'});
  assert.equal(serverNoId.status,400); assert.match(serverNoId.body.error,/request_id is required/);
  // Both refusals stay typed (invalid_schema), and a preview answers them with a verdict instead of a 400.
  for(const r of [serverNoInputs,serverNoId]) { assert.equal(r.body.verdict,'reject'); assert.deepEqual(r.body.reasons.map(x=>x.code),['invalid_schema']); }
  const previewNoInputs=await adminSubmit({schema_version:1,request_id:`req_${randomUUID()}`,brief:'missing inputs',expected_output:'x',execution_scope:'read-only'},'/submit-preview');
  assert.equal(previewNoInputs.status,200); assert.equal(previewNoInputs.body.dry_run,true); assert.equal(previewNoInputs.body.verdict,'reject'); assert.deepEqual(previewNoInputs.body.reasons.map(x=>x.code),['invalid_schema']);
  const secret=(await readFile(join(home,'.config','dot-bridge','env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  async function rpc(name,args) { const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});const body=await response.json();assert(!body.result.isError,body.result.content[0].text);return JSON.parse(body.result.content[0].text); }
  async function submit(who=producer,brief='inbox test\nsecond line',extra={}) { const request_id=`req_${randomUUID()}`;const r=await run([process.execPath,'bin/dalan.mjs','submit','--deliver','none','--producer-thread',who,'--stdin','--json'],JSON.stringify({schema_version:1,request_id,brief,inputs:[],expected_output:'x',execution_scope:'read-only',...extra}));assert.equal(r.code,0,r.stderr);return request_id; }
  const claim=async request_id=>({request_id,claim_id:(await rpc('claim',{request_id,claimant:'inbox-test'})).claim_id});
  const finish=(item,outcome='completed')=>rpc('finish',{...item,outcome,summary:'done',result:'done'});
  const json=r=>JSON.parse(r.stdout.trim());
  const rawInbox=async(...a)=>{ const r=await cli('inbox','--json',...(a.length?a:['--producer',producer])); assert.equal(r.code,0,r.stderr); return json(r); };
  // Sections 0-9 are about unread work; results the owner read and has not decided yet are the 'undecided' group (section 10).
  const inbox=async(...a)=>{ const box=await rawInbox(...a); const items=box.items.filter(i=>i.group!=='undecided'); return {...box,items,total:items.length}; };
  const ids=(box,group)=>box.items.filter(i=>i.group===group).map(i=>i.request_id).sort();
  const consumed=()=>{ const db=new DatabaseSync(join(home,'.local/share/dot-bridge/bridge.db'),{readOnly:true}); try { return db.prepare("SELECT count(*) n FROM lifecycle_events WHERE type='consumed'").get().n; } finally { db.close(); } };

  // 0. Empty inbox; a fresh shell without a producer defaults to all receipts on this isolated host.
  const empty=await cli('inbox','--producer',producer); assert.equal(empty.code,0,empty.stderr); assert.equal(empty.stdout.trim(),'inbox empty');
  assert.notEqual((await cli('inbox','--producer','bad id!')).code,0);
  for(const [body,reason] of [[{schema_version:1,request_id:`req_${randomUUID()}`,brief:'missing inputs',expected_output:'x',execution_scope:'read-only'},/inputs must be an array/],[{schema_version:1,brief:'missing id',inputs:[],expected_output:'x',execution_scope:'read-only'},/request_id is required/]]) {
    const bad=await run([process.execPath,'bin/dalan.mjs','submit','--deliver','none','--stdin','--json'],JSON.stringify(body));
    assert.notEqual(bad.code,0); assert.match(bad.stderr,reason);
  }
  const noProducer=await cli('inbox'); assert.equal(noProducer.code,0,noProducer.stderr); assert.equal(noProducer.stdout.trim(),'inbox empty');
  // 1. Finished results of two producers; scope isolation and --all.
  const a=await claim(await submit()), b=await claim(await submit()), foreign=await claim(await submit(other));
  await finish(a); await finish(b,'blocked'); await finish(foreign);
  let box=await inbox();
  assert.deepEqual(ids(box,'finished_unread'),[a.request_id,b.request_id].sort());
  assert.equal(box.items.find(i=>i.request_id===b.request_id).status,'blocked');
  const item=box.items.find(i=>i.request_id===a.request_id);
  assert.equal(item.title,'inbox test'); assert.equal(item.worker,'dot'); assert.deepEqual(item.next,[`dalan get ${a.request_id}`]); assert.ok(item.finished_at);
  assert(!box.items.some(i=>i.request_id===foreign.request_id),'another producer leaked into the inbox');
  box=await inbox('--producer',other); assert.deepEqual(ids(box,'finished_unread'),[foreign.request_id]);
  box=await inbox('--all'); assert.deepEqual(ids(box,'finished_unread'),[a.request_id,b.request_id,foreign.request_id].sort());
  const freshShell=await cli('inbox','--json'); assert.equal(freshShell.code,0,freshShell.stderr); assert.deepEqual(ids(json(freshShell),'finished_unread'),[a.request_id,b.request_id,foreign.request_id].sort());
  const human=await cli('inbox','--producer',producer); assert.match(human.stdout,/finished_unread {2}req_/); assert.match(human.stdout,/2 items: 2 finished_unread, 0 question, 0 undecided, 0 cancelled_unread/);
  assert.equal(consumed(),0,'inbox recorded a consumed event');
  // 2. A get consumes: the item leaves the inbox, the others stay.
  assert.equal((await cli('get',a.request_id,'--json')).code,0);
  box=await inbox(); assert.deepEqual(ids(box,'finished_unread'),[b.request_id]); assert.equal(consumed(),1);
  await cli('get',b.request_id,'--json'); await cli('get',foreign.request_id,'--json');
  assert.equal((await inbox('--all')).total,0,'only undecided items remain');
  // 3. A question appears with the note command, and leaves once the owner answers.
  const q=await claim(await submit());
  const hostile='QUESTION: which\u001b]8;;https://evil.invalid\u0007click\u001b]8;;\u0007\u001b[31mred\u001b[0m\u009b2J\u0085\rspoof\nmore\u0007';
  await rpc('progress',{...q,note:hostile,blocker:true});
  box=await inbox(); assert.deepEqual(ids(box,'question'),[q.request_id]);
  const qi=box.items[0]; assert.equal(qi.status,'question'); assert.equal(qi.text,hostile.split('\n')[0]); assert.deepEqual(qi.next,[`dalan get ${q.request_id}`,`dalan note ${q.request_id} "..."`]);
  const safePlain=await cli('inbox','--producer',producer); assert.equal(safePlain.code,0,safePlain.stderr); assert(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(safePlain.stdout),`plain inbox has terminal controls: ${JSON.stringify(safePlain.stdout)}`); assert.match(safePlain.stdout,/\\x1b\]8;;https:\/\/evil\.invalid\\x07/); assert.match(safePlain.stdout,/\\x0dspoof/);
  const logicalJson=await rawInbox('--producer',producer); assert.equal(logicalJson.items.find(i=>i.request_id===q.request_id).text,hostile.split('\n')[0],'JSON preserves logical worker text');
  assert.equal((await cli('note',q.request_id,'json please')).code,0);
  assert.equal((await inbox()).total,0,'answered question stayed in the inbox');
  await rpc('progress',{...q,note:'BLOCKED: need the schema',blocker:true});
  assert.equal((await inbox()).items[0].status,'blocker');
  // 4. Expiry cancels a queued request; the owner sees the reason until it reads it. An owner cancel is not listed.
  const soon=new Date(Date.now()+1500).toISOString(), prepared=new Date(Date.now()-60000).toISOString();
  const expiring=await submit(producer,'expiring task',{prepared_at:prepared,valid_until:soon});
  const mine=await submit(); await cli('cancel',mine,'--json');
  await waitFor(async()=>(await inbox()).counts.cancelled_unread===1,'expiry cancellation to appear');
  box=await inbox(); const ci=box.items.find(i=>i.group==='cancelled_unread');
  assert.equal(ci.request_id,expiring); assert.equal(ci.reason,'expired'); assert.equal(ci.expired,true); assert.equal(ci.failure_type,'expired'); assert.equal(ci.status,'cancelled'); assert(!box.items.some(i=>i.request_id===mine),'owner cancel was listed');
  // 5. Bridge restart between the submit and the inbox: nothing is lost, nothing is consumed.
  const r=await claim(await submit()); await finish(r);
  service.kill('SIGTERM'); await new Promise(res=>service.once('exit',res)); await startService();
  box=await inbox(); assert.deepEqual(ids(box,'finished_unread'),[r.request_id]); assert.deepEqual(ids(box,'cancelled_unread'),[expiring]); assert.deepEqual(ids(box,'question'),[q.request_id]);
  assert.equal(consumed(),3,'restart or inbox changed the consumed count');
  // 6. Reading the cancelled item clears it.
  await cli('get',expiring,'--json'); box=await inbox(); assert.deepEqual(ids(box,'cancelled_unread'),[]);
  // 7. Window: an old unread result is hidden and counted; --since all shows it; a bad --since fails.
  const writeDb=fn=>{ const db=new DatabaseSync(join(home,'.local/share/dot-bridge/bridge.db')); db.exec('PRAGMA busy_timeout=5000'); try { return fn(db); } finally { db.close(); } };
  const [oldA,oldB,oldC,fresh]=[await claim(await submit()),await claim(await submit()),await claim(await submit()),await claim(await submit())];
  for(const x of [oldA,oldB,oldC,fresh]) await finish(x);
  const ago=h=>new Date(Date.now()-h*3600000).toISOString();
  writeDb(db=>{ const up=db.prepare('UPDATE reports SET created_at=? WHERE request_id=?'); up.run(ago(100),oldA.request_id); up.run(ago(200),oldB.request_id); up.run(ago(300),oldC.request_id); });
  box=await inbox(); assert.deepEqual(ids(box,'finished_unread'),[r.request_id,fresh.request_id].sort()); assert.equal(box.hidden_older,3); assert.equal(box.delivered_t3,0);
  assert.match((await cli('inbox','--producer',producer)).stdout,/older items hidden \(--since all to show\)/);
  box=await inbox('--producer',producer,'--since','all'); assert.deepEqual(ids(box,'finished_unread'),[r.request_id,oldA.request_id,oldB.request_id,oldC.request_id,fresh.request_id].sort()); assert.equal(box.hidden_older,0);
  box=await inbox('--producer',producer,'--since','5d'); assert.equal(box.hidden_older,2);
  box=await inbox('--producer',producer,'--since',ago(250)); assert.equal(box.hidden_older,1);
  assert.notEqual((await cli('inbox','--producer',producer,'--since','soon')).code,0);
  // 8. A result delivered to T3 counts as read: sent ('delivered') is excluded and counted; sent-but-uncertain is not.
  const sentOne=await claim(await submit()), uncertainOne=await claim(await submit());
  await finish(sentOne); await finish(uncertainOne);
  writeDb(db=>{ db.prepare("UPDATE notifications SET kind='t3',state='delivered' WHERE request_id=?").run(sentOne.request_id); db.prepare("UPDATE notifications SET kind='t3',state='uncertain' WHERE request_id=?").run(uncertainOne.request_id); });
  box=await inbox('--producer',producer); assert.deepEqual(ids(box,'finished_unread'),[r.request_id,fresh.request_id,uncertainOne.request_id].sort()); assert.equal(box.delivered_t3,1);
  // 9. Bulk mark-read: guards, by id, by --before; writes consumed with via=inbox-mark-read and prints no result.
  for(const bad of [['--mark-read'],['--mark-read','--before','all'],['--mark-read','--before','yesterday'],['--mark-read',fresh.request_id,'--before','1h'],['--before','1h'],[fresh.request_id]]) assert.notEqual((await cli('inbox','--producer',producer,...bad)).code,0,bad.join(' '));
  assert.notEqual((await cli('inbox','--mark-read','--before','1h')).code,0,'mark-read without scope');
  const base=consumed();
  let m=await cli('inbox','--mark-read',oldA.request_id,'--json'); assert.equal(m.code,0,m.stderr); assert.equal(json(m).marked,1); assert(!m.stdout.includes('"result"'));
  m=await cli('inbox','--mark-read',oldA.request_id,'--json'); assert.equal(json(m).marked,0,'second mark counted');
  const via=()=>writeDb(db=>db.prepare("SELECT reason,count(*) n FROM lifecycle_events WHERE type='consumed' AND reason='inbox-mark-read'").get());
  assert.equal(via().n,1); assert.equal(consumed(),base+1);
  m=await cli('inbox','--producer',producer,'--mark-read','--before','72h'); assert.equal(m.code,0,m.stderr); assert.equal(m.stdout.trim(),'marked 2 read');
  box=await inbox('--producer',producer,'--since','all'); assert.deepEqual(ids(box,'finished_unread'),[r.request_id,fresh.request_id,uncertainOne.request_id].sort());
  assert.equal(via().n,3);
  assert.equal(writeDb(db=>db.prepare("SELECT count(*) n FROM assignments WHERE request_id=? AND owner_read_at IS NOT NULL").get(fresh.request_id).n),0);
  // A cancelled-by-expiry row is marked through owner_read_at.
  const exp2=await submit(producer,'expiring two',{prepared_at:new Date(Date.now()-60000).toISOString(),valid_until:new Date(Date.now()+1200).toISOString()});
  await waitFor(async()=>(await inbox()).counts.cancelled_unread===1,'second expiry');
  m=await cli('inbox','--mark-read',exp2,'--json'); assert.equal(json(m).marked,1);
  assert.equal((await inbox()).counts.cancelled_unread,0);
  // 10. Read but undecided: the inbox asks for one word; decide (any word) removes it; the old accept alias does too.
  box=await rawInbox('--all','--since','all'); const und=box.items.filter(i=>i.group==='undecided');
  assert.ok(und.some(i=>i.request_id===a.request_id)&&und.some(i=>i.request_id===foreign.request_id),'read results are asked for a decision');
  assert.ok(und.every(i=>i.next.length===1&&i.next[0]===`dalan decide ${i.request_id} accepted|applied|useful_no_change|useful_negative|not_useful`));
  const humanUndecided=(await cli('inbox','--all','--since','all')).stdout; assert.match(humanUndecided,new RegExp(`undecided {2}${a.request_id}.*dalan decide ${a.request_id} accepted\\|applied`));
  assert.ok(humanUndecided.indexOf('finished_unread')<humanUndecided.indexOf('undecided  '),'undecided is listed after finished_unread');
  const consumedBefore=consumed();
  assert.equal((await cli('decide',a.request_id,'useful_no_change','--note','confirmed')).code,0);
  assert.equal((await cli('accept',foreign.request_id)).code,0);
  assert.equal(consumed(),consumedBefore,'deciding an already-read result adds no read');
  box=await rawInbox('--all','--since','all'); assert.ok(!box.items.some(i=>[a.request_id,foreign.request_id].includes(i.request_id)),'decided results leave the inbox');
  assert.equal((await cli('decide',a.request_id,'bogus')).code,1);
  // a decision on an unread result also records the read
  const fresh2=await claim(await submit()); await finish(fresh2); const before2=consumed();
  assert.equal((await cli('decide',fresh2.request_id,'useful_negative')).code,0); assert.equal(consumed(),before2+1);
  const tab=writeDb(db=>db.prepare('SELECT decision,actor,via FROM decisions WHERE request_id=? ORDER BY id').all(a.request_id).map(x=>({...x})));
  assert.deepEqual(tab,[{decision:'useful_no_change',actor:'owner',via:'cli'}]);
  // Synthetic receipts expose only recovery labels, never capability or body.
  const bodySecret='SYNTHETIC_BODY_SECRET_RECOVERY_1026', tokenSecret='SYNTHETIC_TOKEN_SECRET_RECOVERY_1026';
  const noLeak=r=>{ for(const secret of [bodySecret,tokenSecret]) assert(!(r.stdout+r.stderr).includes(secret),'submit leaked a synthetic secret'); };
  const recoverySubmit=(body,flags=[],extra={})=>run([process.execPath,'bin/dalan.mjs','submit','--deliver','none','--stdin',...flags],JSON.stringify(body),extra);
  const receiptDir=join(home,'.local/share/dot-bridge/receipts');
  await mkdir(receiptDir,{recursive:true,mode:0o700});
  for(const bound of [producer,null]) {
    const id=`req_${randomUUID()}`, body={schema_version:1,request_id:id,brief:'recovery fixture '+bodySecret,inputs:[],expected_output:'x',execution_scope:'read-only'};
    const receiptFile=join(receiptDir,createHash('sha256').update(id).digest('hex')+'.json');
    const bytes=JSON.stringify({request_id:id,token:tokenSecret,body:JSON.stringify(body),delivery:'none',meta:{source:'agent'},...(bound?{producer:bound}:{})})+'\n';
    await writeFile(receiptFile,bytes,{mode:0o600});
    const initial=await recoverySubmit(body,['--json',...(bound?['--producer-thread',bound]:[])]);
    assert.equal(initial.code,0,initial.stderr);noLeak(initial);
    const first=json(initial);assert.equal(first.request_id,id);assert.equal(first.status,'queued');assert.equal(first.duplicate,false);
    assert.equal(first.recovery.producer,bound);assert.equal(first.recovery.get,'dalan get '+id);
    assert.equal(first.recovery.wake,'not_registered_by_this_submit');
    if(bound) assert.equal(first.recovery.inbox,'dalan inbox --producer '+bound);
    else { assert(!Object.hasOwn(first.recovery,'inbox'));assert.equal(first.recovery.binding,'missing'); }
    await finish(await claim(id));const beforeRead=consumed();
    const resumed=await run([process.execPath,'bin/dalan.mjs','inbox','--json'],undefined,{CODEX_THREAD_ID:other});
    assert.equal(resumed.code,0,resumed.stderr);assert(!json(resumed).items.some(x=>x.request_id===id));
    assert.equal((await rawInbox('--producer',producer)).items.some(x=>x.request_id===id),bound!==null);
    assert((await rawInbox('--all')).items.some(x=>x.request_id===id));assert.equal(consumed(),beforeRead);
    const retry=await recoverySubmit(body,['--json','--producer-thread',other]);
    assert.equal(retry.code,0,retry.stderr);noLeak(retry);assert.equal(json(retry).duplicate,true);
    assert.equal(json(retry).recovery.producer,bound);assert.equal(json(retry).recovery.binding,bound?'different':'missing');
    assert.equal(await readFile(receiptFile,'utf8'),bytes,'retry rewrote capability/binding');
    const human=await recoverySubmit(body,['--producer-thread',other]);noLeak(human);
    assert.equal(human.code,0,human.stderr);assert.equal(json(human).duplicate,true);assert(!Object.hasOwn(json(human),'recovery'));
    const hints=human.stderr.trim().split('\n');assert.equal(hints.length,1);assert(hints[0].length<=800);
    // The hint names the CLI as this test runs it: node and the path of bin/dalan.mjs, which is not on PATH here.
    const cliRun=`node '${new URL('../bin/dalan.mjs',import.meta.url).pathname}'`;
    assert.equal(hints[0].split('. List your jobs')[0],`Next: send your worker the job, then run: ${cliRun} wait ${id} (check it any time with: ${cliRun} get ${id})`);assert(!hints[0].includes('no waiter'));
    if(bound) assert(hints[0].includes('inbox --producer '+bound));else assert(!hints[0].includes('inbox --producer'));
    const conflict=await recoverySubmit({...body,brief:body.brief+' changed'},['--json','--producer-thread',other]);
    assert.notEqual(conflict.code,0);noLeak(conflict);assert.equal(await readFile(receiptFile,'utf8'),bytes);
    const invalid=await recoverySubmit(body,['--producer-thread',bodySecret+' invalid']);
    assert.notEqual(invalid.code,0);noLeak(invalid);
    await cli('get',id,'--json');assert.equal(consumed(),beforeRead+1);
    await cli('get',id,'--json');assert.equal(consumed(),beforeRead+1);
    assert.equal(writeDb(db=>db.prepare('SELECT owner_read_at FROM assignments WHERE request_id=?').get(id).owner_read_at),null);
    const waited=await recoverySubmit(body,['--json','--wait','--producer-thread',other]);noLeak(waited);
    assert.equal(waited.code,0,waited.stderr);assert.equal(json(waited).status,'finished');
    assert(Object.hasOwn(json(waited),'report_summary'));assert(Array.isArray(json(waited).artifact_ids));
    assert.equal(json(waited).recovery.wake,'wait_returned');assert.equal(json(waited).recovery.producer,bound);
    assert.equal(await readFile(receiptFile,'utf8'),bytes);assert.equal(consumed(),beforeRead+1);
  }
  console.log('PASS inbox: producer scope, --all, finished unread until get, question until answered, expiry reason, restart, no consumed events, window, delivered-as-read, mark-read');
} finally { if(service&&service.exitCode===null&&service.signalCode===null) { service.kill('SIGTERM'); await new Promise(r=>service.once('exit',r)); } await rm(home,{recursive:true,force:true}); }
