#!/usr/bin/env node
import { reservedPort } from '../src/test-support/port.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-pr-preflight-'));
const fixture=path.join(home,'fixture'),observation=path.join(home,'pr-observation.json');
const port=await reservedPort();
const env={...process.env,HOME:home,GH_HOST:'wrong-host.invalid',DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE:fixture,PATH:`${path.join(home,'bin')}:${process.env.PATH}`};
const owner='pr-preflight-test-owner';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function git(args) { const result=spawnSync('git',args,{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);return result.stdout.trim(); }
function observe(value) {fs.writeFileSync(observation,JSON.stringify(value));}
function calls() {try {return fs.readFileSync(path.join(home,'gh-api.log'),'utf8').trim().split('\n').filter(Boolean).length;}catch {return 0;}}
function admin(route,body,headers={},method='POST') {return new Promise((resolve,reject)=>{const req=http.request({socketPath:path.join(home,'.local/share/dalan/admin.sock'),path:route,method,headers:{'content-type':'application/json',...headers}},res=>{let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
function submit(assignment) {return admin('/submit',{delivery:'none',assignment,owner_token:owner});}
function get(id) {return admin(`/get?id=${encodeURIComponent(id)}`,undefined,{'x-owner-capability':owner},'GET');}
function countRows(table,id) {const db=new DatabaseSync(path.join(home,'.local/share/dalan/bridge.db'));try {return db.prepare(`SELECT count(*) n FROM ${table} WHERE request_id=?`).get(id).n;}finally {db.close();}}
async function rejectSubmit(assignment,pattern,status=400) {const result=await submit(assignment);assert.equal(result.code,status,JSON.stringify(result));assert.match(result.body.error,pattern);assert.equal(countRows('assignments',assignment.request_id),0,'rejected PR entered queue');assert.equal(countRows('claims',assignment.request_id),0);}
let service;
try {
  fs.mkdirSync(path.join(home,'.config/dalan'),{recursive:true});
  fs.writeFileSync(path.join(home,'.config/dalan/workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}],repos:['test/fixture']}}}),{mode:0o600});
  fs.mkdirSync(path.join(home,'bin'),{recursive:true});
  fs.writeFileSync(path.join(home,'bin','gh'),`#!/usr/bin/env node
const fs=require('fs');const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='api'||args[1]!=='--hostname'||args[2]!=='github.com'||args[3]!=='repos/test/fixture/pulls/7') {console.error('unexpected gh operation or implicit host');process.exit(2);}
fs.appendFileSync(process.env.HOME+'/gh-api.log',JSON.stringify(args)+'\\n');
const observation=JSON.parse(fs.readFileSync(process.env.HOME+'/pr-observation.json','utf8'));
if(observation.error) {console.error('inert fixture observation unavailable');process.exit(1);}
process.stdout.write(JSON.stringify(observation));
`,{mode:0o755});
  fs.mkdirSync(fixture);
  git(['init',fixture]);git(['-C',fixture,'config','user.name','Fixture']);git(['-C',fixture,'config','user.email','fixture@example.test']);
  fs.writeFileSync(path.join(fixture,'README.md'),'fixture base\n');git(['-C',fixture,'add','README.md']);git(['-C',fixture,'commit','-m','base']);
  const base=git(['-C',fixture,'rev-parse','HEAD']);
  fs.writeFileSync(path.join(fixture,'README.md'),'fixture head\n');git(['-C',fixture,'commit','-am','head']);
  const head=git(['-C',fixture,'rev-parse','HEAD']);
  const open={state:'open',draft:false,merged:false,head:{sha:head}};
  const assignment=(extra={})=>{const now=Date.now();return {schema_version:1,request_id:`req_${randomUUID()}`,brief:'Inspect README.md',inputs:[{github_repo:'test/fixture',base_sha:base,head_sha:head,pr_number:7}],scope_paths:['README.md'],expected_output:'findings',execution_scope:'read-only',prepared_at:new Date(now-1000).toISOString(),valid_until:new Date(now+3600000).toISOString(),...extra};};
  observe(open);
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});let ready=false,stderr='';service.stdout.on('data',b=>{if(String(b).includes('MCP listening'))ready=true;});service.stderr.on('data',b=>stderr+=b);
  for(let i=0;i<200&&!ready;i++) await sleep(25);assert(ready,stderr);
  const secret=fs.readFileSync(path.join(home,'.config/dalan/env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  async function rpc(name,args) {const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});const envelope=await response.json();if(envelope.error) return {error:envelope.error.message};if(envelope.result.isError)return {error:envelope.result.content?.[0]?.text};return JSON.parse(envelope.result.content[0].text);}
  async function rejectClaim(a,pattern) {const result=await rpc('claim',{request_id:a.request_id,claimant:'pr-test'});assert.match(result.error||'',pattern,JSON.stringify(result));assert.equal(countRows('claims',a.request_id),0,'failed preflight created claim');const row=await get(a.request_id);assert.equal(row.code,200);assert.equal(row.body.status,'queued','failed preflight changed assignment');}

  const accepted=assignment();assert.equal((await submit(accepted)).code,200);
  const submitted=await get(accepted.request_id);assert.equal(submitted.code,200);assert(Array.isArray(submitted.body.pr_preflights),'missing preflight facts');assert.equal(submitted.body.pr_preflights.length,1);assert.equal(submitted.body.pr_preflights[0].phase,'submit');assert.equal(submitted.body.pr_preflights[0].head_sha,head);
  const acquisition_id='pr-preflight-run';const beforeFirstClaim=calls();const claim=await rpc('claim',{request_id:accepted.request_id,claimant:'pr-test',acquisition_id});assert(claim.claim_id,JSON.stringify(claim));assert.equal(calls(),beforeFirstClaim+1,'first claim skipped direct PR observation');
  observe({error:true});const beforeRetry=calls();const retry=await rpc('claim',{request_id:accepted.request_id,claimant:'pr-test',acquisition_id});assert.equal(retry.claim_id,claim.claim_id);assert.equal(retry.duplicate,true);assert.equal(calls(),beforeRetry,'successful claim retry fetched remote state');
  const claimed=await get(accepted.request_id);assert.deepEqual(claimed.body.pr_preflights.map(f=>f.phase),['submit','claim']);for(const fact of claimed.body.pr_preflights) {assert.equal(fact.github_repo,'test/fixture');assert.equal(fact.pr_number,7);assert.equal(fact.head_sha,head);assert(Number.isFinite(Date.parse(fact.checked_at)));}
  const finished=await rpc('finish',{request_id:accepted.request_id,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'findings'});assert(finished.receipt_id,JSON.stringify(finished));

  await rejectSubmit(assignment(),/^admin service unavailable$/,503);
  observe({});await rejectSubmit(assignment(),/^admin service unavailable$/,503);
  observe(open);
  fs.writeFileSync(path.join(home,'bin','git'),'#!/bin/sh\nexit 9\n',{mode:0o755});
  try {await rejectSubmit(assignment(),/^admin service unavailable$/,503);}
  finally {fs.unlinkSync(path.join(home,'bin','git'));}
  observe({...open,state:'closed'});await rejectSubmit(assignment(),/open/);
  observe({...open,head:{sha:'a'.repeat(40)}});await rejectSubmit(assignment(),/mismatch/);
  observe(open);await rejectSubmit(assignment({prepared_at:new Date(Date.now()-7201000).toISOString(),valid_until:new Date(Date.now()-1000).toISOString()}),/expired|validity/);
  await rejectSubmit(assignment({objective_resolved:true}),/resolved/);
  for(const value of ['true',1,'yes',null]) await rejectSubmit(assignment({objective_resolved:value}),/boolean/);
  await rejectSubmit(assignment({valid_until:new Date(Date.now()+7201000).toISOString()}),/validity/);

  const moved=assignment();assert.equal((await submit(moved)).code,200);observe({...open,head:{sha:'a'.repeat(40)}});await rejectClaim(moved,/mismatch/);
  observe(open);const unknown=assignment();assert.equal((await submit(unknown)).code,200);observe({error:true});await rejectClaim(unknown,/unknown/);
  observe(open);const closed=assignment();assert.equal((await submit(closed)).code,200);observe({...open,state:'closed'});await rejectClaim(closed,/open/);
  observe(open);const expires=assignment({valid_until:new Date(Date.now()+5000).toISOString()});assert.equal((await submit(expires)).code,200);await sleep(Math.max(0,Date.parse(expires.valid_until)-Date.now()+50));const beforeExpiredClaim=calls();
  // An expired preparation is cancelled as expired (by the sweep or by this claim) and the claim answers assignment_expired, never a generic preflight failure.
  {const result=await rpc('claim',{request_id:expires.request_id,claimant:'pr-test'});assert.match(result.error||'',/^assignment_expired: /,JSON.stringify(result));assert.equal(countRows('claims',expires.request_id),0,'expired claim created claim');const row=await get(expires.request_id);assert.equal(row.body.status,'cancelled');assert.equal(row.body.cancelled_reason,'expired');}
  assert.equal(calls(),beforeExpiredClaim,'expired task fetched PR');
  const db=new DatabaseSync(path.join(home,'.local/share/dalan/bridge.db'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,66);db.close();
  console.log('pr-preflight-e2e: PASS');
} finally {if(service&&service.exitCode===null){service.kill('SIGTERM');await new Promise(resolve=>service.once('exit',resolve));}fs.rmSync(home,{recursive:true,force:true});}
