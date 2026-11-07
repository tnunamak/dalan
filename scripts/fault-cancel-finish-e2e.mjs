#!/usr/bin/env node
import assert from 'node:assert/strict';
import {defaultPath} from '../src/paths.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { completeJsonLines } from './jsonl.mjs';
import { startT3ResultFixture } from '../src/test-support/t3-result-fixture.mjs';
const repo=resolve(new URL('..',import.meta.url).pathname);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function listeningPort(stdout) {
  const match=stdout.match(/^MCP listening on [^\r\n]+:(\d+)\r?\n/m);
  if(!match)return null;
  const port=Number(match[1]);
  assert.ok(Number.isInteger(port)&&port>0&&port<=65535,'server reported an invalid bound port');
  return port;
}
export async function harness(label,{legacyHome=false}={}) {
  const home=await mkdtemp(join(tmpdir(),'dalan-bridge-'+label+'-'));
  if(legacyHome)await mkdir(join(home,'.config/dot-bridge'),{recursive:true});
  const dbPath=defaultPath(home,'.local/share/dot-bridge/bridge.db');
  const thread='00000000-0000-4000-8000-000000000001';
  const env={...process.env,HOME:home, DALAN_LEGACY_PROFILE: '1',DOT_BRIDGE_AUTH_MODE:'',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS:'1',
    DOT_BRIDGE_ENABLE_WORKSPACE:'0',DOT_BRIDGE_T3_DRY_RUN:'0',DOT_BRIDGE_CRASH_AT:'',DOT_BRIDGE_CRASH_REQUEST_ID:'',
    PATH:join(home,'bin')+':'+process.env.PATH};
  // Bind in the child, rather than releasing a probe's port before startup.
  env.DOT_BRIDGE_PORT='0';
  await mkdir(join(home,'bin'),{recursive:true});
  await writeFile(join(home,'bin/package.json'),'{"type":"commonjs"}');
  await writeFile(join(home,'bin/t3code'),[
    '#!/usr/bin/env node',
    "const fs=require('fs'),path=require('path'),args=process.argv.slice(2),file=path.join(process.env.HOME,'sends.jsonl');",
    "if(args.includes('inspect')) console.log(JSON.stringify({ok:true,data:{runtime:{environmentId:'fake-environment'},thread:{id:"+JSON.stringify(thread)+",status:'active',deletedAt:null}}}));",
    "else if(args.includes('read')) {",
    "const messages=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').filter(Boolean).map(line=>({role:'user',text:JSON.parse(line),textTruncated:false})):[];",
    "console.log(JSON.stringify({ok:true,data:{runtime:{environmentId:'fake-environment'},thread:{id:"+JSON.stringify(thread)+",status:'active',deletedAt:null,messages}}}));",
    "} else if(args.includes('send')) {let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{fs.appendFileSync(file,JSON.stringify(body)+'\\n');console.log(JSON.stringify({ok:true,data:{sent:true}}));});}",
    "else {console.error('unexpected fake T3 call');process.exitCode=1;}"
  ].join('\n'),{mode:0o755});
  const t3Fixture=await startT3ResultFixture({home,threadId:thread,fakeCommand:join(home,'bin/t3code')});
  Object.assign(env,t3Fixture.env);
  let service,secret,port;
  const sockets=new Set();
  async function waitFor(fn,label,timeout=10000) {
    const end=Date.now()+timeout;
    while(Date.now()<end){if(await fn())return;await sleep(25);}
    throw new Error('timeout: '+label);
  }
  async function start() {
    let output='',stdout='';port=null;
    service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
    service.stdout.on('data',b=>{stdout+=b;output+=b;});service.stderr.on('data',b=>output+=b);
    await waitFor(()=>{if(service.exitCode!==null)throw new Error('server exited: '+output);port=listeningPort(stdout);return port!==null;},'server ready');
    secret=(await readFile(defaultPath(home,'.config/dot-bridge/env'),'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  }
  async function stop() {
    if(!service||service.exitCode!==null)return;
    const child=service,exited=new Promise(r=>child.once('exit',r));
    child.kill('SIGTERM');await exited;service=null;
  }
  async function admin(route,payload,headers={}) {
    return new Promise((done,reject)=>{
      const body=payload?JSON.stringify(payload):'';
      const req=http.request({socketPath:defaultPath(home,'.local/share/dot-bridge/admin.sock'),path:route,
        method:payload?'POST':'GET',headers:{...headers,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
        let text='';res.on('data',b=>text+=b);res.on('end',()=>{try{done({status:res.statusCode,body:JSON.parse(text)});}catch(e){reject(e);}});
      });
      req.setTimeout(10000,()=>req.destroy(new Error('admin timeout')));req.on('error',reject);req.end(body);
    });
  }
  async function rpc(method,params={}) {
    const response=await fetch('http://127.0.0.1:'+port+'/'+secret+'/mcp',{
      method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),
      body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});
    assert.equal(response.status,200);const value=await response.json();assert.ok(!value.error,JSON.stringify(value));return value.result;
  }
  async function tool(name,args={}) {
    const value=await rpc('tools/call',{name,arguments:args});
    return value.isError?{error:value.content[0].text}:JSON.parse(value.content[0].text);
  }
  function fixture() {
    const id='req_'+randomUUID(),owner=randomBytes(32).toString('hex');
    return {id,owner,assignment:{schema_version:1,request_id:id,brief:'fault injection fixture',inputs:[],expected_output:'one report',execution_scope:'read-only'}};
  }
  async function submit(f) {
    const response=await admin('/submit',{delivery:'t3:'+thread,owner_token:f.owner,assignment:f.assignment});
    assert.equal(response.status,200,JSON.stringify(response));return response.body;
  }
  const cancel=f=>admin('/cancel',{id:f.id},{'x-owner-capability':f.owner});
  const get=id=>tool('get',{request_id:id});
  const ownerGet=async f=>{
    const response=await admin(`/get?id=${encodeURIComponent(f.id)}&peek=1`,null,{'x-owner-capability':f.owner});
    assert.equal(response.status,200,JSON.stringify(response));return response.body;
  };
  async function sends() {
    try{return completeJsonLines(await readFile(join(home,'sends.jsonl'),'utf8'));}
    catch(e){if(e.code==='ENOENT')return [];throw e;}
  }
  function inspect(fn){const s=new Store(dbPath);try{return fn(s);}finally{s.db.close();}}
  async function close() {
    await stop();await t3Fixture.close();for(const server of sockets){server.closeAllConnections();await new Promise(r=>server.close(r));}
    await rm(home,{recursive:true,force:true});
  }
  return {home,dbPath,start,stop,close,waitFor,admin,rpc,tool,fixture,submit,cancel,get,ownerGet,sends,inspect,sockets};
}

async function main() {
  assert.equal(listeningPort('MCP listening'),null);
  assert.equal(listeningPort('MCP listening on 0.0.0.0:43'),null);
  assert.equal(listeningPort('MCP listening on 0.0.0.0:43127'),null);
  assert.equal(listeningPort('MCP listening on 0.0.0.0:43127\n'),43127);
  assert.equal(listeningPort('diagnostic MCP listening on 0.0.0.0:1\n'),null);
  for(const port of [0,65536])assert.throws(()=>listeningPort(`MCP listening on 0.0.0.0:${port}\n`));
  const h=await harness('cancel-finish');
  try {
    await h.start();
    const counts={cancelled:0,finished:0},cancelledIds=new Set(),finishedIds=new Set();
    async function check(f,claim,cancelled,report) {
      const row=await h.get(f.id),notices=row.delivery.filter(n=>n.kind==='t3');
      assert.equal(Object.hasOwn(row.claim,'claim_id'),false,'worker get exposes claim_id');
      assert.equal(Object.hasOwn(row.claim.activity,'acquisition_id'),false,'worker get exposes acquisition_id');
      assert.equal((await h.ownerGet(f)).claim.claim_id,claim.claim_id,'owner get changed claim identity');
      assert.equal(row.compute_stopped,false);
      const args={request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'race',result:'retained result'};
      if(cancelled.status===200) {
        // Cancellation wins: finish is refused with a structured TERMINAL error, the output is kept only as late evidence.
        counts.cancelled++;cancelledIds.add(f.id);
        assert.ok(report.error,'finish after cancel must be a tool error: '+JSON.stringify(report));
        const refusal=JSON.parse(report.error);assert.equal(refusal.error,'assignment_cancelled');assert.match(refusal.message,/kept as audit evidence only \(not a result\)/);
        assert.equal(row.status,'cancelled');assert.equal(row.report,null);
        assert.equal(row.late_evidence.summary,'race');assert.equal(row.late_evidence.truncated,false);
        assert.equal(row.authority_revoked,true);assert.ok(row.cancelled_at);assert.equal(notices.length,0);
        const retry=await h.tool('finish',args);assert.equal(JSON.parse(retry.error).error,'assignment_cancelled');
        const different=await h.tool('finish',{...args,result:'contradiction'});assert.equal(JSON.parse(different.error).error,'assignment_cancelled');
        h.inspect(s=>{assert.equal(s.db.prepare('SELECT count(*) n FROM late_evidence WHERE request_id=?').get(f.id).n,1);assert.equal(s.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(f.id).n,0);});
      } else {
        counts.finished++;finishedIds.add(f.id);
        assert.ok(!report.error,JSON.stringify(report));assert.equal(row.report.receipt_id,report.receipt_id);
        assert.equal(cancelled.status,400);assert.equal(cancelled.body.error,'already finished');
        assert.equal(row.status,'finished');assert.equal(report.late,false);assert.equal(report.result_authority,true);assert.equal(report.status,'finished');assert.equal(row.report.result_authority,true);
        assert.equal(row.late_evidence,null);
        assert.equal(row.authority_revoked,false);assert.equal(row.cancelled_at,null);assert.equal(notices.length,1);
        const duplicate=await h.tool('finish',args);
        assert.equal(duplicate.receipt_id,report.receipt_id);assert.equal(duplicate.late,report.late);assert.equal(duplicate.result_authority,report.result_authority);
        assert.ok((await h.tool('finish',{...args,result:'contradiction'})).error);
        h.inspect(s=>{assert.equal(s.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(f.id).n,1);assert.equal(s.db.prepare('SELECT count(*) n FROM late_evidence WHERE request_id=?').get(f.id).n,0);});
      }
      assert.ok((await h.tool('progress',{request_id:f.id,claim_id:claim.claim_id,note:'stale authority'})).error);
      assert.ok((await h.tool('claim',{request_id:f.id,claimant:'rival'})).error);
      h.inspect(s=>{for(const table of ['assignments','claims'])assert.equal(s.db.prepare('SELECT count(*) n FROM '+table+' WHERE request_id=?').get(f.id).n,1);});
    }
    for(let i=0;i<50;i++) {
      const f=h.fixture();await h.submit(f);
      const claim=await h.tool('claim',{request_id:f.id,claimant:'fault-worker'});assert.ok(claim.claim_id);
      const finish=()=>h.tool('finish',{request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'race',result:'retained result'});
      // No intervening await: cancel and finish launch in the same tick.
      // Alternate launch order without assuming which socket wins.
      const calls=i%2?[finish(),h.cancel(f)]:[h.cancel(f),finish()];
      const results=await Promise.all(calls);
      await check(f,claim,results[i%2?1:0],results[i%2?0:1]);
    }
    console.log('PASS 50 concurrent cancel/finish races '+JSON.stringify(counts));
    // Deterministic controls cover both serial outcomes even if all races choose one.
    for(const cancelFirst of [true,false]) {
      const f=h.fixture();await h.submit(f);
      const claim=await h.tool('claim',{request_id:f.id,claimant:'fault-worker'});
      const finish=()=>h.tool('finish',{request_id:f.id,claim_id:claim.claim_id,outcome:'completed',summary:'race',result:'retained result'});
      let cancelled,report;
      if(cancelFirst){cancelled=await h.cancel(f);report=await finish();}
      else{report=await finish();cancelled=await h.cancel(f);}
      await check(f,claim,cancelled,report);
    }
    await h.waitFor(async()=>{
      for(const id of finishedIds)if(!(await h.get(id)).delivery.some(n=>n.kind==='t3'&&n.state==='delivered'))return false;
      return true;
    },'authorized sends',30000);
    await sleep(600);
    const sends=await h.sends();
    for(const id of cancelledIds)assert.equal(sends.filter(s=>s.includes('Request '+id+':')).length,0,'late evidence woke owner');
    for(const id of finishedIds)assert.equal(sends.filter(s=>s.includes('Request '+id+':')).length,1,'finish wake count');
    console.log('PASS both serialized controls, late evidence, terminal authority, duplicate receipts and actual owner-send counts');
  } finally {await h.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e=>{console.error(e);process.exitCode=1;});
}
