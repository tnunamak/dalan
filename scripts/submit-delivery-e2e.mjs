#!/usr/bin/env node
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname);
const delegated='thread:delegated-task:command%3Amcp%3A00000000-0000-4000-8000-000000000004%3Adelegate-task%3Afixture-task';
const provider='thread:provider:codex:native-thread:provider-thread%3Aprovider%3Acodex%3Anative-thread%3Apending%253Arun%253Athread%253A00000000-0000-4000-8000-000000000005%253Aordinal%253A1%3A'+'a'.repeat(17);
const home=mkdtempSync(join(tmpdir(),'dalan-bridge-delivery-'));
const port=await reservedPort();
const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_PORT:String(port),PATH:`${join(home,'bin')}:${process.env.PATH}`};
const sleep=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms));
const assignment=request_id=>({schema_version:1,request_id,brief:'delivery mode test',inputs:[],expected_output:'result',execution_scope:'read-only'});
function run(args,input='') { return new Promise(resolveRun=>{const child=spawn(args[0],args.slice(1),{cwd:repo,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('close',code=>resolveRun({code,stdout,stderr}));child.stdin.end(input);}); }
function countSends() { try{return readFileSync(join(home,'t3-sends.log'),'utf8').trim().split('\n').filter(Boolean).length;}catch{return 0;} }
async function waitFor(test,label) { for(let elapsed=0;elapsed<5000;elapsed+=25) { if(await test()) return; await sleep(25); } throw new Error(`timed out waiting for ${label}`); }
function migrateExistingCopy() {
  const source=join(home,'bridge-v15.db'),copy=join(home,'bridge-upgrade-copy.db');
  const oldId='req_migration_legacy';
  const store=new Store(source);
  store.submit(assignment(oldId),'mcp:12345678-1234-1234-1234-123456789abc','legacy-env','owner');
  store.db.close();
  const db=new DatabaseSync(source);
  preWorkerFixture({db});
  db.exec('DROP TABLE pr_preflights; ALTER TABLE assignments DROP COLUMN delivery; PRAGMA user_version=15;');
  db.close();
  copyFileSync(source,copy);
  mkdirSync(`${copy}.secrets`,{recursive:true,mode:0o700});
  copyFileSync(`${source}.secrets/storage.key`,`${copy}.secrets/storage.key`);
  chmodSync(`${copy}.secrets`,0o700);
  chmodSync(`${copy}.secrets/storage.key`,0o600);
  const migrated=new Store(copy);
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,65,'migration version');
  assert.equal(migrated.get(oldId).delivery_mode,'t3:mcp:12345678-1234-1234-1234-123456789abc','legacy delivery');
  migrated.db.close();
}

mkdirSync(join(home,'bin'),{recursive:true});
mkdirSync(join(home,'.config','dot-bridge'),{recursive:true});
writeFileSync(join(home,'.config','dot-bridge','limits.json'),JSON.stringify({main_thread_ids:[delegated,provider]}),{mode:0o600});
writeFileSync(join(home,'bin','t3code'),`#!/usr/bin/env node
const fs=require('fs'); const args=process.argv.slice(2);
if(args.includes('read')) { console.error('metadata must use threads inspect'); process.exit(2); }
else if(args.includes('inspect')) console.log(JSON.stringify({ok:true,data:{runtime:{environmentId:'fake-environment'},thread:{id:args[args.indexOf('--thread')+1],status:'active'}}}));
else if(args.includes('send')) { let text=''; process.stdin.on('data',b=>text+=b); process.stdin.on('end',()=>{fs.appendFileSync(process.env.HOME+'/t3-sends.log',text+'\\n');console.log(JSON.stringify({ok:true,data:{}}));}); }
else console.log(JSON.stringify({ok:true,data:{}}));
`,{mode:0o755});
let service;
let serviceExit=null;
try {
  migrateExistingCopy();
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  service.once('exit',code=>{serviceExit=code;});
  let ready=false; service.stdout.on('data',b=>{if(String(b).includes('MCP listening'))ready=true;}); service.stderr.on('data',b=>process.stderr.write(b));
  await waitFor(()=>ready,'server');
  const secret=readFileSync(join(home,'.config','dot-bridge','env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  async function rpc(name,arguments_) { const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:arguments_}})});const body=await response.json();assert(!body.result.isError,body.result.content?.[0]?.text);return JSON.parse(body.result.content[0].text); }
  async function submit(delivery,id,extra=[]) { return run([process.execPath,'bin/dalan.mjs','submit','--deliver',delivery,'--stdin','--json',...extra],JSON.stringify(assignment(id))); }

  const missing=await run([process.execPath,'bin/dalan.mjs','submit','--stdin','--json'],JSON.stringify(assignment(`req_${randomUUID()}`)));
  assert.equal(missing.code,0,missing.stderr);
  const defaultGet=JSON.parse((await run([process.execPath,'bin/dalan.mjs','get',JSON.parse(missing.stdout).request_id,'--json'])).stdout);
  assert.equal(defaultGet.delivery_mode,'none','CLI quiet default');
  for(const bad of ['t3:short','t3:has space','t3:slash/value','email@example.com']) { const result=await submit(bad,`req_${randomUUID()}`); assert.notEqual(result.code,0,`accepted malformed ${bad}`); }

  const noneId=`req_${randomUUID()}`;
  const noneSubmit=await submit('none',noneId); assert.equal(noneSubmit.code,0,noneSubmit.stderr);
  assert.equal(countSends(),0,'none submission called T3');
  const claim=await rpc('claim',{request_id:noneId,claimant:'delivery-test'});
  await rpc('finish',{request_id:noneId,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'done'});
  await sleep(750);
  const noneGet=JSON.parse((await run([process.execPath,'bin/dalan.mjs','get',noneId,'--json'])).stdout);
  assert.equal(noneGet.delivery_mode,'none'); assert.equal(noneGet.delivery.some(item=>item.state==='uncertain'),false,'none became uncertain'); assert.equal(countSends(),0,'none result sent to T3');
  const waited=await run([process.execPath,'bin/dalan.mjs','wait',noneId,'--timeout','1','--json']);
  assert.equal(waited.code,0,waited.stderr); assert.equal(JSON.parse(waited.stdout).status,'finished');

  const aliasId=`req_${randomUUID()}`;
  const alias=await run([process.execPath,'bin/dalan.mjs','submit','--thread','00000000-0000-4000-8000-000000000001','--stdin','--json'],JSON.stringify(assignment(aliasId)));
  assert.equal(alias.code,0,alias.stderr);
  const aliasGet=JSON.parse((await run([process.execPath,'bin/dalan.mjs','get',aliasId,'--json'])).stdout);
  assert.equal(aliasGet.delivery_mode,'t3:00000000-0000-4000-8000-000000000001','thread alias');

  for(const threadId of [delegated,provider]) {
    const denied=await submit(`t3:${threadId}`,`req_${randomUUID()}`);
    assert.notEqual(denied.code,0,`main-thread guard accepted ${threadId}`); assert.match(denied.stderr,/protected T3 destination/); assert.doesNotMatch(denied.stderr,/allow-main/);
    const allowed=await submit(`t3:${threadId}`,`req_${randomUUID()}`,['--allow-main']);
    assert.equal(allowed.code,0,allowed.stderr);
  }
  const operator=readFileSync(join(home,'.config','dot-bridge','operator.key'),'utf8').trim();
  function admin(route,body,headers={}) { return new Promise((resolveAdmin,reject)=>{const req=http.request({socketPath:join(home,'.local/share/dot-bridge/admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json',...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolveAdmin({code:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));}); }
  const bypass=await admin('/submit',{delivery:`t3:${delegated}`,assignment:assignment(`req_${randomUUID()}`),owner_token:'owner',allow_main:true});
  assert.equal(bypass.code,400); assert.match(bypass.body.error,/invalid operator key/); assert.doesNotMatch(bypass.body.error,/allow-main/);
  const admitted=await admin('/submit',{delivery:`t3:${delegated}`,assignment:assignment(`req_${randomUUID()}`),owner_token:'owner',allow_main:true},{'x-operator-key':operator}); assert.equal(admitted.code,200);
  writeFileSync(join(home,'.config','dot-bridge','operator.key'),'wrong-key\n',{mode:0o600});
  const cliDenied=await submit(`t3:${delegated}`,`req_${randomUUID()}`,['--allow-main']);assert.notEqual(cliDenied.code,0);assert.match(cliDenied.stderr,/invalid operator key/);
  writeFileSync(join(home,'.config','dot-bridge','operator.key'),operator+'\n',{mode:0o600});
  async function get(id) { const result=await run([process.execPath,'bin/dalan.mjs','get',id,'--json']);assert.equal(result.code,0,result.stderr);return JSON.parse(result.stdout); }
  const dynamicThread='00000000-0000-4000-8000-000000000001';
  const protectedItems=[];
  for(const type of ['finish','blocker']) {
    const id=`req_${randomUUID()}`;assert.equal((await submit(`t3:${dynamicThread}`,id)).code,0);protectedItems.push({id,type});
  }
  writeFileSync(join(home,'.config','dot-bridge','limits.json'),JSON.stringify({main_thread_ids:[delegated,provider,dynamicThread]}),{mode:0o600});
  for(const {id,type} of protectedItems) {
    { const claimed=await rpc('claim',{request_id:id,claimant:'delivery-test'});if(type==='finish') await rpc('finish',{request_id:id,claim_id:claimed.claim_id,outcome:'completed',summary:'protected finish',result:'retained'});else await rpc('progress',{request_id:id,claim_id:claimed.claim_id,note:'QUESTION: retained question',blocker:true}); }
  }
  await waitFor(async()=>{const rows=await Promise.all(protectedItems.map(({id})=>get(id)));return rows.every(row=>row.delivery.some(n=>n.last_error==='protected T3 destination'));},'protected notification retention');
  assert.equal(countSends(),0,'protected finish/blocker sent to T3');
  for(const {id,type} of protectedItems) {
    const row=await get(id);assert.equal(row.delivery_mode,`t3:${dynamicThread}`,'immutable delivery binding');
    {const waited=await run([process.execPath,'bin/dalan.mjs','wait',id,'--timeout','1','--json']);assert.equal(waited.code,type==='finish'?0:3,waited.stderr);assert.equal(JSON.parse(waited.stdout).status,type==='finish'?'finished':'question');}
  }
  for(const {id,type} of protectedItems) if(type==='blocker') assert.equal((await run([process.execPath,'bin/dalan.mjs','cancel',id,'--json'])).code,0);
  writeFileSync(join(home,'.config','dot-bridge','limits.json'),JSON.stringify({main_thread_ids:[]}),{mode:0o600});

  const badDeliveryId=aliasId,goodDeliveryId=`req_${randomUUID()}`,drainThread='00000000-0000-4000-8000-000000000002';
  const goodCreated=await submit(`t3:${drainThread}`,goodDeliveryId);assert.equal(goodCreated.code,0,goodCreated.stderr);
  const pause=await run([process.execPath,'bin/dalan.mjs','pause','--reason','quarantine test']);assert.equal(pause.code,0,pause.stderr);
  const db=new DatabaseSync(join(home,'.local','share','dot-bridge','bridge.db'));
  try {
    db.exec('BEGIN');
    db.prepare('UPDATE assignments SET delivery=?,thread_id=? WHERE request_id=?').run('smtp:other',drainThread,badDeliveryId);
    const insert=db.prepare("INSERT INTO notifications(id,kind,request_id,body,state,next_at,created_at) VALUES(?,'blocker',?,?, 'pending',0,?)");
    insert.run(`evt_bad_${randomUUID()}`,badDeliveryId,JSON.stringify({note:'bad destination fixture'}),'2000-01-01T00:00:00.000Z');
    insert.run(`evt_good_${randomUUID()}`,goodDeliveryId,JSON.stringify({note:'valid destination fixture'}),'2000-01-02T00:00:00.000Z');
    db.exec('COMMIT');
  } catch(error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
  const resume=await run([process.execPath,'bin/dalan.mjs','resume']);assert.equal(resume.code,0,resume.stderr);
  let drainStates='not read';
  await waitFor(async()=>{
    if(serviceExit!==null) return true;
    try {
      const [bad,good]=await Promise.all([get(badDeliveryId),get(goodDeliveryId)]);
      drainStates=JSON.stringify([bad.delivery,good.delivery]);
      return bad.delivery.some(item=>item.kind==='blocker'&&item.state==='suppressed')&&good.delivery.some(item=>item.kind==='blocker'&&item.state==='delivered');
    } catch(error) {
      await sleep(25);
      if(service.exitCode!==null) { serviceExit=service.exitCode; return true; }
      throw error;
    }
  },'bad delivery quarantine and valid delivery').catch(error=>{throw new Error(`${error.message}; last rows: ${drainStates}; service exit: ${serviceExit}`);});
  assert.equal(serviceExit,null,'bad persisted delivery stopped the server');
  const [badDrain,goodDrain]=await Promise.all([get(badDeliveryId),get(goodDeliveryId)]);
  const quarantined=badDrain.delivery.find(item=>item.kind==='blocker');
  assert.equal(quarantined.state,'suppressed');assert.match(quarantined.last_error,/invalid delivery mode: smtp:other/);
  assert.equal(goodDrain.delivery.find(item=>item.kind==='blocker')?.state,'delivered','valid row did not deliver after malformed row');
  const requestLog=readFileSync(join(home,'.local','state','dot-bridge','requests.jsonl'),'utf8');
  assert.match(requestLog,/delivery_quarantined/,'quarantine error was not logged');
  console.log('PASS operator admission, quiet default, runtime protection, wait retention, submit delivery modes, T3 ID forms, main-thread guard, no-send wait delivery, and v15 migration copy');
} finally {
  if(service&&serviceExit===null) { const exited=new Promise(resolveStop=>service.once('exit',resolveStop));service.kill('SIGTERM');await exited; }
  rmSync(home,{recursive:true,force:true});
}
