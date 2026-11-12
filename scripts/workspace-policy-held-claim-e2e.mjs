#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-workspace-policy-'));
const config=path.join(home,'.config/dot-bridge'),repo=path.join(home,'repo'),dbFile=path.join(home,'.local/share/dot-bridge/bridge.db');
const freePort=async()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(error=>error?reject(error):resolve(port));});});
const port=await freePort(),jwksPort=await freePort(),issuer=`http://127.0.0.1:${jwksPort}/realm`,aud='https://dot-bridge.example.test';
fs.mkdirSync(config,{recursive:true});fs.mkdirSync(repo,{recursive:true});
const git=(...args)=>{const result=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
git('init','-q');git('config','user.email','test@example.com');git('config','user.name','Test');fs.writeFileSync(path.join(repo,'hello.txt'),'workspace fixture\n');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
fs.writeFileSync(path.join(config,'oauth.env'),`OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${aud}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n`,{mode:0o600});
const workersFile=path.join(config,'workers.json');
const writeWorkers=workspaceAllowed=>fs.writeFileSync(workersFile,JSON.stringify({workers:{dot:{connections:[{issuer,subject:'dot',client_id:'test-client'}],repos:['example-owner/fixture'],workspaceAllowed}}}),{mode:0o600});
writeWorkers(true);
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'test',use:'sig'};
const jwks=http.createServer((_req,res)=>res.end(JSON.stringify({keys:[jwk]})));await new Promise(resolve=>jwks.listen(jwksPort,'127.0.0.1',resolve));
const env={...process.env,HOME:home,DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',DOT_BRIDGE_ENABLE_WORKSPACE:'1',DOT_BRIDGE_WORKSPACE_ROOT:path.join(home,'work'),DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE:repo};
const cwd=path.resolve(new URL('..',import.meta.url).pathname),fetch=fetchForPublicHost('dot-bridge.example.test');
let service,ready=false;
function launch(enableWorkspace){ready=false;service=spawn(process.execPath,['src/server.mjs'],{cwd,env:{...env,DOT_BRIDGE_ENABLE_WORKSPACE:enableWorkspace?'1':'0'},stdio:['ignore','pipe','pipe']});service.stdout.on('data',chunk=>{if(String(chunk).includes('MCP listening'))ready=true;});service.stderr.on('data',chunk=>process.stderr.write(chunk));return service;}
async function waitReady(){for(let i=0;i<100&&!ready;i++){if(service.exitCode!==null)throw new Error(`server exited ${service.exitCode}`);await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,'server ready');}
function token(){const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url'),payload=Buffer.from(JSON.stringify({iss:issuer,aud,exp:Math.floor(Date.now()/1000)+300,sub:'dot',client_id:'test-client',scope:'dot-bridge.read dot-bridge.work'})).toString('base64url'),input=`${header}.${payload}`;return `${input}.${sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;}
const auth=token();
async function rawTool(name,args){const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});const body=await response.json();if(!body.result)throw new Error(`MCP HTTP ${response.status}: ${JSON.stringify(body)}`);return body.result;}
async function tool(name,args){const result=await rawTool(name,args);if(result.isError)throw new Error(result.content?.[0]?.text??'tool failed');return JSON.parse(result.content[0].text);}
const {Store}=await import('../src/store.mjs');
const receipts=path.join(home,'.local/share/dot-bridge/receipts'),ownerToken=randomUUID();
function submit(execution_scope,inputs=[{revision:'fixture'}]){const request_id=`req_${randomUUID()}`,assignment={schema_version:1,request_id,brief:'workspace policy fixture',inputs,expected_output:'report',execution_scope},store=new Store(dbFile);store.submit(assignment,'thread','env',ownerToken);store.db.close();fs.mkdirSync(receipts,{recursive:true});fs.writeFileSync(path.join(receipts,`${createHash('sha256').update(request_id).digest('hex')}.json`),JSON.stringify({request_id,token:ownerToken,body:JSON.stringify(assignment),thread:'thread'}),{mode:0o600});return request_id;}
function activeClaims(request_id){const store=new Store(dbFile);try{return store.db.prepare("SELECT count(*) n FROM claims WHERE request_id=? AND state='active'").get(request_id).n;}finally{store.db.close();}}
async function stop(){if(service&&service.exitCode===null&&service.signalCode===null){const exited=new Promise(resolve=>service.once('exit',resolve));service.kill('SIGTERM');await exited;}}
try {
  launch(true);await waitReady();
  const implementation=submit('implementation',[{github_repo:'example-owner/fixture',base_sha:base}]);
  const claim=await tool('claim',{request_id:implementation,claimant:'allowed'});
  const files=await tool('list_files',{request_id:implementation,claim_id:claim.claim_id});assert.ok(files.files.includes('hello.txt'),'workspaceAllowed=true grants workspace access');
  writeWorkers(false);const denied=await rawTool('list_files',{request_id:implementation,claim_id:claim.claim_id});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/capability_not_enabled/,'workspaceAllowed=false denies workspace access');await tool('finish',{request_id:implementation,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'done'});

  writeWorkers(true);const held=submit('read-only'),heldClaim=await tool('claim',{request_id:held,claimant:'held'});
  fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  let retryError;try{const retry=await tool('claim',{request_id:held,claimant:'held'});assert.equal(retry.claim_id,heldClaim.claim_id);}catch(error){retryError=error.message;}
  assert.equal(retryError,undefined,`exact retry must survive malformed profile: ${retryError}`);
  const workspaceFailure=await rawTool('list_files',{request_id:held,claim_id:heldClaim.claim_id});assert.equal(workspaceFailure.isError,true);assert.match(workspaceFailure.content[0].text,/destination_configuration_invalid/,'workspace use fails closed');
  await tool('progress',{request_id:held,claim_id:heldClaim.claim_id,note:'still working'});
  await tool('finish',{request_id:held,claim_id:heldClaim.claim_id,outcome:'completed',summary:'recovered',result:'done'});

  // Removing the worker must not strand an already held non-workspace grant either.
  writeWorkers(false);const removed=submit('read-only'),removedClaim=await tool('claim',{request_id:removed,claimant:'removed'});
  fs.writeFileSync(workersFile,JSON.stringify({workers:{other:{connections:[{issuer,subject:'other',client_id:'other-client'}],repos:[]}}}),{mode:0o600});
  assert.equal((await tool('claim',{request_id:removed,claimant:'removed'})).claim_id,removedClaim.claim_id);
  await tool('get',{request_id:removed});
  const foreign=await rawTool('progress',{request_id:removed,claim_id:randomUUID(),note:'foreign'});assert.equal(foreign.isError,true,'foreign grant remains refused');
  await tool('progress',{request_id:removed,claim_id:removedClaim.claim_id,note:'worker removed'});
  await tool('finish',{request_id:removed,claim_id:removedClaim.claim_id,outcome:'completed',summary:'done',result:'done'});
  fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});

  const fresh=submit('implementation');let admissionError;try{await tool('claim',{request_id:fresh,claimant:'fresh'});}catch(error){admissionError=error.message;}
  assert.match(admissionError??'',/destination_configuration_invalid/,'new workspace admission fails closed');assert.equal(activeClaims(fresh),0,'malformed policy must not create a claim');

  writeWorkers(true);const hostOff=submit('implementation',[{github_repo:'example-owner/fixture',base_sha:base}]);const offClaim=await tool('claim',{request_id:hostOff,claimant:'host-off'});await stop();launch(false);await waitReady();fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  const offWorkspace=await rawTool('list_files',{request_id:hostOff,claim_id:offClaim.claim_id});
  assert.equal(offWorkspace.isError,true);assert.match(offWorkspace.content[0].text,/capability_not_enabled/,'host workspace disabled fails closed without reading malformed profile');
  console.log('PASS workspace policy: held claim control survives broken profile; workspace use, fresh grants and disabled modes fail closed');
} finally {await stop();await new Promise(resolve=>jwks.close(resolve));fs.rmSync(home,{recursive:true,force:true});}
