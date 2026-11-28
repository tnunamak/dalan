#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('fixture.test');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {portFromListeningBanner} from '../src/test-support/port.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const COMMAND_TIMEOUT_MS=15000;
const HARD_STOP={timeout:COMMAND_TIMEOUT_MS,killSignal:'SIGKILL'};
const exited=child=>child.exitCode!==null||child.signalCode!==null;
const waitForExit=async(child,ms)=>{
  if(exited(child)) return true;
  const signal=AbortSignal.timeout(ms);
  try { await once(child,'exit',{signal}); return true; }
  catch(error) { if(!signal.aborted) throw error; return exited(child); }
};
const stopService=async(child)=>{
  if(exited(child)) return;
  child.kill('SIGTERM');
  if(await waitForExit(child,2000)) return;
  child.kill('SIGKILL');
  if(!await waitForExit(child,1500)) throw new Error('fixture service did not exit after SIGTERM and SIGKILL');
};
if(process.argv.includes('--fixture-server')) {
  // This child replaces executor readiness and launch. Policy, HTTP, check
  // orchestration, recording, lifecycle and result projection are production code.
  const {mock}=await import('node:test');
  const execution=await import('../src/execution.mjs');
  mock.module(new URL('../src/execution.mjs',import.meta.url).href,{namedExports:{...execution,
    hostReadiness:()=>({ready:true,reason:null}),hostBackend:()=>execution.hostBackend({ready:true,reason:null}),admitHostExecution:()=>{}}});
  const policy=await import('../src/host-execution-policy.mjs');
  mock.module(new URL('../src/host-execution-policy.mjs',import.meta.url).href,{namedExports:{...policy,
    // The fixture supplies the executor on every platform. Keep authorization
    // and scope policy, but replace the native-backend availability check too.
    hostCheckRefusal:(...args)=>{
      const refusal=policy.hostCheckRefusal(...args);
      return refusal?.startsWith('resource_limits_unavailable: no enforced host budget backend on ') ? null : refusal;
    }}});
  const {Workspace}=await import('../src/workspace.mjs');
  Workspace.prototype.runConfined=async function(requestId,dir,command,options) {
    assert(fs.realpathSync(dir).startsWith(fs.realpathSync(process.env.DOT_BRIDGE_WORKSPACE_ROOT)+path.sep));
    assert(command[0]==='/runtime/node'||(command[0]==='node'&&command[1]==='scripts/named-skip.mjs'));
    assert(['scripts/test-segments.mjs','scripts/named-skip.mjs','scripts/armored-skip.mjs'].includes(command[1]));
    assert.equal(command.length,2);
    const started=Date.now(),chunks=[];
    const child=spawn(process.execPath,command.slice(1),{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR},stdio:['ignore','pipe','pipe'],timeout:10000,killSignal:'SIGKILL'});
    child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>chunks.push(b));
    const [code]=await once(child,'close',{signal:AbortSignal.timeout(11000)});
    const bytes=Buffer.concat(chunks),duration_ms=Date.now()-started,stop={verified:true,reason:'fixture_child_exited'};
    const receipt={exit:{code},timedOut:false,cancelled:false,duration_ms,stop,budgets:options.host_budget,usage:{},phases:[{name:'check',exit:{code},timedOut:false,cancelled:false,duration_ms,stop,bytes,truncated:false}]};
    fs.appendFileSync(process.env.CHECK_SKIP_EXECUTIONS,JSON.stringify({requestId,command,exit:code})+'\n');
    return receipt;
  };
  const { main } = await import('../src/server.mjs');
  await main();
} else {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cse-')),repo=path.join(home,'repo'),config=path.join(home,'.config/dot-bridge');
  fs.mkdirSync(path.join(repo,'scripts'),{recursive:true});fs.mkdirSync(config,{recursive:true});
  console.log(`Check skip end-to-end fixtures retained: ${home}`);
  const git=(...args)=>{const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8',...HARD_STOP});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Synthetic fixture');
  fs.copyFileSync(new URL('./test-segments.mjs',import.meta.url),path.join(repo,'scripts/test-segments.mjs'));
  fs.writeFileSync(path.join(repo,'scripts/skip.mjs'),"console.log('SKIP host executor journey:');process.exit(77);\n");
  fs.writeFileSync(path.join(repo,'scripts/named-skip.mjs'),"console.log('SKIP host executor journey: scripts/named-skip.mjs');process.exit(77);\n");
  fs.writeFileSync(path.join(repo,'scripts/armored-skip.mjs'),"console.log('"+'-'.repeat(5)+'BE'+'GIN OPENSSH PRIVATE KEY'+'-'.repeat(5)+"\\nSYNTHETIC_BODY\\nSKIP host executor journey: scripts/named-skip.mjs\\n"+'-'.repeat(5)+'EN'+'D OPENSSH PRIVATE KEY'+'-'.repeat(5)+"');\n");
  fs.writeFileSync(path.join(repo,'scripts/test-segments.json'),JSON.stringify(['node scripts/skip.mjs']));
  fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({type:'module',scripts:{test:'node scripts/test-segments.mjs'}}));
  const check=script=>({argv:['/runtime/node',script],timeout_ms:10000,output_bytes:65536,test_paths:[script],host_budget:{cpu_ms:3000,wall_ms:8000,memory_bytes:192*1024*1024,processes:32,disk_write_bytes:8*1024*1024,output_bytes:16384}});
  const checks={default:check('scripts/test-segments.mjs'),direct:check('scripts/named-skip.mjs'),armored:check('scripts/armored-skip.mjs')};
  fs.writeFileSync(path.join(repo,'.dot-bridge.json'),JSON.stringify({checks}));
  fs.writeFileSync(path.join(config,'checks.json'),JSON.stringify({'test/fixture':{checks}}),{mode:0o600});
  fs.writeFileSync(path.join(config,'host-check-allowlist.json'),JSON.stringify({version:1,checks:[...Object.keys(checks),'named'].map(check_id=>({repo:'test/fixture',check_id}))}),{mode:0o600});
  git('add','scripts','package.json','.dot-bridge.json');git('commit','-qm','synthetic exit-77 segments');
  const base=git('rev-parse','HEAD'),{privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'fixture',use:'sig'};
  const jwks=http.createServer((req,res)=>{
    if(req.url==='/stall') return;
    res.end(JSON.stringify({keys:[jwk]}));
  });
  jwks.listen(0,'127.0.0.1');
  await once(jwks,'listening',{signal:AbortSignal.timeout(10000)});
  const issuer=`http://127.0.0.1:${jwks.address().port}`;
  let port=null;
  fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{workspaceAllowed:true,connections:[{issuer,subject:'fixture',client_id:'fixture-client'}],repos:['test/fixture']}}}),{mode:0o600});
  fs.writeFileSync(path.join(config,'oauth.env'),`OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=https://fixture.test\nOAUTH_JWKS_URI=${issuer}/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture\n`,{mode:0o600});
  const executions=path.join(home,'executions.jsonl'),env={...process.env,HOME:home,DALAN_PORT:'0',DOT_BRIDGE_PORT:'0',DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'1',DALAN_HOST_CHECKS:'1',DOT_BRIDGE_MIN_FREE_BYTES:'0',DOT_BRIDGE_WORKSPACE_ROOT:path.join(home,'work'),DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE:repo,CHECK_SKIP_EXECUTIONS:executions};
  const service=spawn(process.execPath,['--experimental-test-module-mocks',fileURLToPath(import.meta.url),'--fixture-server'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let out='',err='';service.stdout.on('data',b=>out+=b);service.stderr.on('data',b=>err+=b);
  let db;
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`fixture server readiness: ${err}`)),10000);
      service.stdout.on('data',()=>{if((port=portFromListeningBanner(out))&&out.includes('admin socket')){clearTimeout(timer);resolve();}});
      service.once('exit',code=>{clearTimeout(timer);reject(new Error(`fixture server exited ${code}: ${err}`));});
    });
    const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({iss:issuer,aud:'https://fixture.test',exp:Math.floor(Date.now()/1000)+300,sub:'fixture',azp:'fixture-client',scope:'dot-bridge.read dot-bridge.work'})).toString('base64url');
    const unsigned=`${header}.${payload}`,token=`${unsigned}.${sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url')}`;
    const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const call=async(name,args,{url=`http://127.0.0.1:${port}/${secret}/mcp`,deadlineMs=COMMAND_TIMEOUT_MS}={})=>{
      const signal=AbortSignal.timeout(deadlineMs);
      try {
        const response=await fetch(url,{signal,method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
        assert.equal(response.status,200);const result=(await response.json()).result;assert(!result.isError,result.content[0].text);return JSON.parse(result.content[0].text);
      } catch(error) {
        if(signal.aborted) throw new Error(`MCP ${name} exceeded ${deadlineMs} ms`,{cause:error});
        throw error;
      }
    };
    let watchdog;
    try {
      const bounded=call('stalled-fixture',{}, {url:`${issuer}/stall`,deadlineMs:100});
      const guard=new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(new Error('stalled fixture exceeded outer watchdog')),1500);});
      await assert.rejects(Promise.race([bounded,guard]),/MCP stalled-fixture exceeded 100 ms/);
    } finally {clearTimeout(watchdog);}
    const request_id=`req_${randomUUID()}`,file=path.join(home,'assignment.json');
    fs.writeFileSync(file,JSON.stringify({schema_version:1,request_id,brief:'Exercise synthetic skip coverage',inputs:[{github_repo:'test/fixture',base_sha:base}],scope_paths:['.'],expected_output:'report',execution_scope:'implementation',checks:['node scripts/named-skip.mjs']}));
    const submitted=spawnSync(process.execPath,['bin/dot-worker.mjs','submit','--file',file,'--execution','host','--json'],{cwd:root,env,encoding:'utf8',...HARD_STOP});
    assert.ifError(submitted.error);
    assert.equal(submitted.status,0,submitted.stderr);
    const claim=await call('claim',{request_id,claimant:'fixture'});
    db=new DatabaseSync(path.join(home,'.local/share/dot-bridge/bridge.db'),{readOnly:true});
    const offered=await call('get',{request_id});
    assert(offered.available_checks.includes('named/1'));
    assert(offered.available_check_details['named/1'].includes('node scripts/named-skip.mjs'));
    for(const [check_id,segment,exit] of [['default','scripts/skip.mjs',0],['direct','scripts/named-skip.mjs',77],['armored','scripts/named-skip.mjs',0],['named/1','scripts/named-skip.mjs',77]]) {
      const receipt=await call('run_check',{request_id,claim_id:claim.claim_id,check_id});
      assert.equal(receipt.status,'skipped',JSON.stringify(receipt));assert.equal(receipt.exit_code,exit);
      if(check_id==='default') assert.match(receipt.output_preview,/=== SEGMENT 1\/1: SKIP ===/);
      if(check_id==='armored') { assert(!receipt.output_preview.includes('SYNTHETIC_BODY')); assert(!receipt.output_preview.includes('SKIP host')); }
      assert.equal(receipt.skipped_segments,1);assert.deepEqual(receipt.skipped_segment_names,[segment]);
      const shown=(await call('workspace_result',{request_id,claim_id:claim.claim_id})).checks.find(c=>c.check_id===check_id);
      assert.equal(shown.status,'skipped');assert.equal(shown.skipped_segments,1);assert.deepEqual(shown.skipped_segment_names,[segment]);
      assert(shown.check_summary.includes(segment));
      const stored=db.prepare('SELECT j.status,r.evidence FROM check_jobs j JOIN check_runs r USING(id) WHERE j.id=?').get(receipt.id);
      assert.equal(stored.status,'skipped');assert.equal(JSON.parse(stored.evidence).skipped_segments,1);
      if(check_id==='named/1') {
        const evidence=JSON.parse(stored.evidence);
        assert.equal(evidence.definition.source,'requester_declared');
        assert.deepEqual(evidence.argv,['node','scripts/named-skip.mjs']);
        assert.equal(evidence.exit_code,77);
      }
      const events=db.prepare("SELECT type FROM lifecycle_events WHERE request_id=? AND reason LIKE ? AND type IN ('check_passed','check_failed','check_skipped')").all(request_id,`%check_run_id=${receipt.id}%`);
      assert.deepEqual(events.map(e=>e.type),['check_skipped']);
    }
    const launches=fs.readFileSync(executions,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(launches.map(r=>r.exit),[0,77,0,77]);
    fs.writeFileSync(path.join(config,'host-check-allowlist.json'),JSON.stringify({version:1,checks:Object.keys(checks).map(check_id=>({repo:'test/fixture',check_id}))}),{mode:0o600});
    const stillDeclared=await call('get',{request_id});
    assert(stillDeclared.available_checks.includes('named/1'));
    // Since #157 each named check reports its own refusal in its details; the top-level reason is only set when nothing can run.
    assert.match(stillDeclared.available_check_details['named/1'],/not runnable: host_check_not_allowlisted/);
    assert.equal(stillDeclared.host_execution_available,true);assert.equal(stillDeclared.host_execution_unavailable_reason,null);
    const refused=await call('run_check',{request_id,claim_id:claim.claim_id,check_id:'named/1'});
    assert.match(JSON.stringify(refused),/host_check_not_allowlisted/);
    assert.equal(fs.readFileSync(executions,'utf8').trim().split('\n').length,launches.length);
    const owner=spawnSync(process.execPath,['bin/dot-worker.mjs','get',request_id,'--json'],{cwd:root,env,encoding:'utf8',...HARD_STOP});
    assert.ifError(owner.error);
    assert.equal(owner.status,0,owner.stderr);
    const ownerChecks=JSON.parse(owner.stdout).checks;
    for(const [check_id,segment] of [['default','scripts/skip.mjs'],['direct','scripts/named-skip.mjs'],['armored','scripts/named-skip.mjs'],['named/1','scripts/named-skip.mjs']]) {
      const shown=ownerChecks.find(c=>c.check_id===check_id);
      assert.equal(shown.status,'skipped');assert.equal(shown.skipped_segments,1);
      assert.deepEqual(shown.skipped_segment_names,[segment]);
    }
    console.log('PASS current-head MCP check journey: real exit-77 segments persist and surface skipped rows with segment names');
  } finally {
    try { db?.close(); }
    finally {
      try { await stopService(service); }
      finally {
        const closed=once(jwks,'close',{signal:AbortSignal.timeout(2000)});
        jwks.close();
        jwks.closeAllConnections();
        await closed;
      }
    }
  }
}
