#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const root=process.env.DOT_BRIDGE_TEST_TMP||path.join(os.homedir(),'.tmp');fs.mkdirSync(root,{recursive:true});
const home=fs.mkdtempSync(path.join(root,'quiesce-drain-abort-'));
const env={...fixtureEnv(home),HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_RESUME_IDLE_MS:'0'};
const barrier=path.join(home,'hold-dispatch');
const entered=path.join(home,'dispatch-entered');
const preload=path.join(home,'quiesce-preload.mjs');
// Test-only loader: hold one admitted synthetic RPC before its tool body. No
// production test switch or timer threshold is needed.
const hook=`async function dispatchTool(name,a,principal,notifyMeta,signal) {
  if(name==='progress'&&a.note==='owned barrier'){
    const fs=await import('node:fs/promises');
    await fs.writeFile(${JSON.stringify(entered)},'admitted');
    const until=Date.now()+5000;
    while(!(await fs.stat(${JSON.stringify(barrier)}).catch(()=>null))){
      if(Date.now()>=until)throw new Error('fixture barrier timed out');
      await new Promise(r=>setTimeout(r,10));
    }
  }`;
fs.writeFileSync(preload,`import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
  const result=next(url,context);
  if(!url.endsWith('/src/server.mjs'))return result;
  const source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
  const anchor='async function dispatchTool(name,a,principal,notifyMeta,signal) {';
  if(!source.includes(anchor))throw new Error('quiesce fixture lost its dispatch seam');
  return {...result,source:source.replace(anchor,${JSON.stringify(hook)})};
}});
`);
let server,output,errors,exited,port,closed;
function start() {
  output='';errors='';exited=false;port=undefined;
  server=spawn(process.execPath,['--import',preload,'src/server.mjs'],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe']});
closed=new Promise(resolve=>server.once('exit',()=>{exited=true;resolve();}));
server.stdout.on('data',b=>{output+=b;const m=/^MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\r?\n/m.exec(output);if(m)port=Number(m[1]);});
server.stderr.on('data',b=>errors+=b);
}
async function until(predicate,label) {
  const limit=Date.now()+10000;
  while(!predicate()&&!exited&&Date.now()<limit)await new Promise(r=>setTimeout(r,20));
  assert.ok(predicate(),label+': '+errors);
}
async function stop() {
  if(server&&!exited){try{process.kill(-server.pid,'SIGTERM');}catch{}await closed;}
}
let call=0,secret;
async function rpc(name,args={}) {
  const r=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++call,method:'tools/call',params:{name,arguments:args}})});
  const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b.result;
}
const parse=r=>{assert.equal(r.isError,false,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const ids=['req_abort_1','req_abort_2'];
const assignment=request_id=>({schema_version:1,request_id,brief:'Synthetic fixture',inputs:[],expected_output:'One line',execution_scope:'read-only'});
// Contract: if `upgrade-drain.mjs --until-quiescent` is killed (SIGTERM or SIGINT) while it polls, it reopens the gate before it exits,
// so the remote workers are not starved by a gate nobody will reopen. Here an admitted call is held at a barrier so the drain
// stays in its poll loop, the drain is killed, and a claim then succeeds on the real server.
async function abortWith(signal,code,reqId,otherId,note) {
  const claim=parse(await rpc('claim',{request_id:reqId,claimant:'fixture-worker'}));
  fs.rmSync(entered,{force:true});fs.rmSync(barrier,{force:true});
  const held=rpc('progress',{request_id:reqId,claim_id:claim.claim_id,note});
  void held.catch(()=>{});
  await until(()=>fs.existsSync(entered),'call did not reach admitted barrier');
  const drain=spawn(process.execPath,['scripts/upgrade-drain.mjs','--until-quiescent'],{cwd:repo,env:{...env,DALAN_UPGRADE_DRAIN_TIMEOUT_MS:'60000'},stdio:['ignore','pipe','pipe']});
  let out='',err='';drain.stdout.on('data',b=>out+=b);drain.stderr.on('data',b=>err+=b);
  const done=new Promise(resolve=>drain.once('exit',(c,s)=>resolve({code:c,signal:s})));
  await until(()=>/Admission is quiesced/.test(out),'drain did not close the gate');
  assert.equal((await admin('/quiesce')).on,true,'the gate is closed while the drain polls');
  assert.ok((await admin('/quiesce')).admitted_in_flight>=1,'the drain is waiting on the held call');
  drain.kill(signal);
  const result=await done;
  assert.equal(result.code,code,`${signal}: ${out}${err}`);
  assert.match(err,/drain aborted .*gate reopened/);
  assert.equal((await admin('/quiesce')).on,false,`${signal} must leave the gate open`);
  fs.writeFileSync(barrier,'release');
  parse(await held);
  parse(await rpc('finish',{request_id:reqId,claim_id:claim.claim_id,outcome:'completed',result:'done'}));
  assert.ok(parse(await rpc('claim',{request_id:otherId,claimant:'fixture-worker'})).claim_id,'claims flow again after the aborted drain');
}
const admin=(route,method='GET',body)=>new Promise((resolve,reject)=>{
  const q=http.request({socketPath:path.join(home,'.local/share/dalan/admin.sock'),path:route,method,headers:{'content-type':'application/json','x-operator-key':fs.readFileSync(path.join(home,'.config/dalan/operator.key'),'utf8').trim()}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve(JSON.parse(b)));});
  q.on('error',reject);q.end(method==='GET'?undefined:JSON.stringify(body??{}));
});
try {
  start();
  await until(()=>port,'isolated server did not become ready');
  secret=fs.readFileSync(path.join(home,'.config/dalan/env'),'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  for(const id of [...ids,'req_abort_3'])assert.equal((await admin('/submit','POST',{delivery:'none',owner_token:'synthetic-owner-capability',assignment:assignment(id)})).error,undefined);
  await abortWith('SIGTERM',143,ids[0],ids[1],'owned barrier');
  // the claim that proved the gate open still holds the lane: the SIGINT round reuses it (a repeated claim is idempotent)
  await abortWith('SIGINT',130,ids[1],'req_abort_3','owned barrier');
  console.log('PASS a drain killed mid-poll (SIGTERM or SIGINT) reopens the gate and claims flow again');
} finally {
  fs.writeFileSync(barrier,'release');
  await stop();
  if(process.env.KEEP_TEST_FIXTURES!=='1') fs.rmSync(home,{recursive:true,force:true});
}
