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
function submit(execution_scope,inputs=[{revision:'fixture'}],fields={}){const request_id=`req_${randomUUID()}`,assignment={schema_version:1,request_id,brief:'workspace policy fixture',inputs,expected_output:'report',execution_scope,...fields},store=new Store(dbFile);store.submit(assignment,'thread','env',ownerToken);store.db.close();fs.mkdirSync(receipts,{recursive:true});fs.writeFileSync(path.join(receipts,`${createHash('sha256').update(request_id).digest('hex')}.json`),JSON.stringify({request_id,token:ownerToken,body:JSON.stringify(assignment),thread:'thread'}),{mode:0o600});return request_id;}
function withStore(fn){const store=new Store(dbFile);try{return fn(store);}finally{store.db.close();}}
function activeClaims(request_id){return withStore(store=>store.db.prepare("SELECT count(*) n FROM claims WHERE request_id=? AND state='active'").get(request_id).n);}
function stateOf(request_id){return withStore(store=>({
  report:store.db.prepare('SELECT workspace_evidence FROM reports WHERE request_id=?').get(request_id)??null,
  lateEvidence:store.db.prepare('SELECT count(*) n FROM late_evidence WHERE request_id=?').get(request_id).n,
  workspaces:store.db.prepare('SELECT count(*) n FROM workspaces WHERE request_id=?').get(request_id).n,
  checkRuns:store.db.prepare('SELECT count(*) n FROM check_runs WHERE request_id=?').get(request_id).n,
  artifacts:store.db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(request_id).n,
}));}
function writeOtherWorker(){fs.writeFileSync(workersFile,JSON.stringify({workers:{other:{connections:[{issuer,subject:'other',client_id:randomUUID()}],repos:[]}}}),{mode:0o600});}
async function stop(){if(service&&service.exitCode===null&&service.signalCode===null){const exited=new Promise(resolve=>service.once('exit',resolve));service.kill('SIGTERM');await exited;}}
try {
  launch(true);await waitReady();
  const implementation=submit('implementation',[{github_repo:'example-owner/fixture',base_sha:base}]);
  const claim=await tool('claim',{request_id:implementation,claimant:'allowed'});
  const files=await tool('list_files',{request_id:implementation,claim_id:claim.claim_id});assert.ok(files.files.includes('hello.txt'),'workspaceAllowed=true grants workspace access');
  writeWorkers(false);const denied=await rawTool('list_files',{request_id:implementation,claim_id:claim.claim_id});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/capability_not_enabled/,'workspaceAllowed=false denies workspace access');await tool('finish',{request_id:implementation,claim_id:claim.claim_id,outcome:'completed',summary:'done',result:'done'});

  // A held implementation claim with no workspace grant or workspace effects
  // needs only its stored claim authority to file a plain report.
  writeWorkers(false);const plainImplementation=submit('implementation'),plainImplementationClaim=await tool('claim',{request_id:plainImplementation,claimant:'plain-implementation'});
  assert.equal(withStore(store=>store.db.prepare('SELECT count(*) n FROM workspaces WHERE request_id=?').get(plainImplementation).n),0,'plain finish fixture has no workspace');
  const noWorkspace=await rawTool('list_files',{request_id:plainImplementation,claim_id:plainImplementationClaim.claim_id});assert.equal(noWorkspace.isError,true,'ungranted claim cannot create workspace state');
  fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  const foreignFinish=await rawTool('finish',{request_id:plainImplementation,claim_id:randomUUID(),outcome:'completed',summary:'foreign',result:'must be refused'});
  assert.equal(foreignFinish.isError,true,'a foreign claim cannot use the broken-policy finish fallback');assert.match(foreignFinish.content[0].text,/invalid claim/);
  const artifactFinish=await rawTool('finish',{request_id:plainImplementation,claim_id:plainImplementationClaim.claim_id,outcome:'completed',summary:'artifact',result:'must validate',artifact_ids:[`art_${randomUUID()}`]});
  assert.equal(artifactFinish.isError,true,'an explicit artifact request cannot use the broken-policy finish fallback');assert.match(artifactFinish.content[0].text,/destination_configuration_invalid/);
  assert.equal(stateOf(plainImplementation).report,null,'foreign and artifact finish attempts did not persist a report');
  const plainFinish=await rawTool('finish',{request_id:plainImplementation,claim_id:plainImplementationClaim.claim_id,outcome:'completed',summary:'done without workspace',result:'done'});
  assert.equal(plainFinish.isError,false,'plain finish of non-workspace implementation claim must survive broken policy');
  assert.ok(stateOf(plainImplementation).report,'plain report committed after optional policy failure');

  // Removing the held worker from a valid profile still permits the existing plain-report behavior.
  writeWorkers(false);const removedImplementation=submit('implementation'),removedImplementationClaim=await tool('claim',{request_id:removedImplementation,claimant:'removed-implementation'});
  writeOtherWorker();await tool('finish',{request_id:removedImplementation,claim_id:removedImplementationClaim.claim_id,outcome:'completed',summary:'worker removed',result:'done'});
  assert.ok(stateOf(removedImplementation).report,'held plain report survives removal of its worker from a valid profile');

  // A missing profile is the same optional-policy failure for a plain held report.
  writeWorkers(false);const missingProfile=submit('implementation'),missingProfileClaim=await tool('claim',{request_id:missingProfile,claimant:'missing-profile'});
  fs.rmSync(workersFile);const missingFinish=await rawTool('finish',{request_id:missingProfile,claim_id:missingProfileClaim.claim_id,outcome:'completed',summary:'profile missing',result:'done'});
  assert.equal(missingFinish.isError,false,'plain finish survives removal of the workspace profile');assert.ok(stateOf(missingProfile).report);

  // Declared output paths remain required workspace evidence when the policy read fails.
  writeWorkers(false);const outputAssignment=submit('implementation',[{github_repo:'example-owner/fixture',base_sha:base}],{output_paths:['result.txt']});
  const outputClaim=await tool('claim',{request_id:outputAssignment,claimant:'output-path'});fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  const outputFinish=await rawTool('finish',{request_id:outputAssignment,claim_id:outputClaim.claim_id,outcome:'completed',summary:'output path',result:'must not bypass'});
  assert.equal(outputFinish.isError,true,'output_paths cannot use the broken-policy fallback');assert.match(outputFinish.content[0].text,/destination_configuration_invalid/);
  assert.equal(stateOf(outputAssignment).report,null,'output-path finish refusal did not persist a report');
  withStore(store=>store.abandon(outputAssignment,{actor:'operator',reason:'fixture released after required-evidence refusal'}));

  // Workspace and check evidence remain intact while policy is unavailable, then are captured after it is restored.
  writeWorkers(true);const evidenceRequest=submit('implementation',[{github_repo:'example-owner/fixture',base_sha:base}]);
  const evidenceClaim=await tool('claim',{request_id:evidenceRequest,claimant:'evidence'});
  await tool('list_files',{request_id:evidenceRequest,claim_id:evidenceClaim.claim_id});
  const checkRunId=`check_${randomUUID()}`,checkNow=new Date().toISOString(),checkOutput='fixture check output';
  withStore(store=>{
    store.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at,finished_at,output_preview) VALUES(?,?,?,?,?,'completed',?,?,?)")
      .run(checkRunId,evidenceRequest,evidenceClaim.claim_id,'fixture-check','fixture-diff',checkNow,checkNow,checkOutput);
    store.db.prepare('INSERT INTO check_runs(id,request_id,claim_id,check_id,exit_code,timed_out,output_artifact_id,output_sha256,duration_ms,created_at,diff_sha256,phase,evidence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(checkRunId,evidenceRequest,evidenceClaim.claim_id,'fixture-check',0,0,'',createHash('sha256').update(checkOutput).digest('hex'),1,checkNow,'fixture-diff','check',JSON.stringify({skipped_segments:0,skipped_segment_names:[],phase:'check',trust:'bridge_verified'}));
  });
  const beforeBrokenFinish=stateOf(evidenceRequest);fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  const evidenceFinish=await rawTool('finish',{request_id:evidenceRequest,claim_id:evidenceClaim.claim_id,outcome:'completed',summary:'evidence',result:'must capture'});
  assert.equal(evidenceFinish.isError,true,'existing workspace/check evidence requires a readable workspace policy');assert.match(evidenceFinish.content[0].text,/destination_configuration_invalid/);
  const afterBrokenFinish=stateOf(evidenceRequest);assert.equal(afterBrokenFinish.report,null);assert.equal(afterBrokenFinish.workspaces,beforeBrokenFinish.workspaces);assert.equal(afterBrokenFinish.checkRuns,beforeBrokenFinish.checkRuns);assert.equal(afterBrokenFinish.artifacts,beforeBrokenFinish.artifacts);
  writeWorkers(true);await tool('finish',{request_id:evidenceRequest,claim_id:evidenceClaim.claim_id,outcome:'completed',summary:'evidence restored',result:'captured'});
  const evidence=JSON.parse(stateOf(evidenceRequest).report.workspace_evidence);
  assert.ok(evidence.patch_artifact?.artifact_id,'restored policy captured the existing workspace snapshot');
  assert.ok(evidence.checks.some(check=>check.check_id==='fixture-check'&&check.evidence?.trust==='bridge_verified'),'restored policy preserved existing check evidence');

  // Abandoned, cancelled, and expired grants cannot use the plain-finish fallback.
  writeWorkers(false);const abandonedRequest=submit('implementation'),abandonedClaim=await tool('claim',{request_id:abandonedRequest,claimant:'abandoned'});
  withStore(store=>store.abandon(abandonedRequest,{actor:'operator',reason:'fixture claim revocation'}));
  fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  const abandonedFinish=await rawTool('finish',{request_id:abandonedRequest,claim_id:abandonedClaim.claim_id,outcome:'completed',summary:'stale claim',result:'must be refused'});
  assert.equal(abandonedFinish.isError,true,'abandoned claim cannot use the broken-policy fallback');assert.match(abandonedFinish.content[0].text,/invalid claim/);assert.equal(stateOf(abandonedRequest).report,null);

  writeWorkers(false);const cancelledRequest=submit('implementation'),cancelledClaim=await tool('claim',{request_id:cancelledRequest,claimant:'cancelled'});
  fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});withStore(store=>store.cancel(cancelledRequest,'fixture cancellation'));
  const cancelledFinish=await rawTool('finish',{request_id:cancelledRequest,claim_id:cancelledClaim.claim_id,outcome:'completed',summary:'cancelled claim',result:'must not commit'});
  assert.equal(cancelledFinish.isError,true,'cancelled claim cannot use the broken-policy fallback');assert.match(cancelledFinish.content[0].text,/assignment_cancelled/);
  assert.equal(stateOf(cancelledRequest).report,null);assert.equal(stateOf(cancelledRequest).lateEvidence,1,'cancelled finish remains audit-only');

  writeWorkers(false);const expiredRequest=submit('implementation'),expiredClaim=await tool('claim',{request_id:expiredRequest,claimant:'expired',lease_ms:1000});
  withStore(store=>store.db.prepare('UPDATE claims SET lease_deadline_at=?,lease_deadline_monotonic_ms=0 WHERE request_id=?').run(new Date(0).toISOString(),expiredRequest));
  fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  const expiredFinish=await rawTool('finish',{request_id:expiredRequest,claim_id:expiredClaim.claim_id,outcome:'completed',summary:'expired claim',result:'must be refused'});
  assert.equal(expiredFinish.isError,true,'expired claim cannot use the broken-policy fallback');assert.match(expiredFinish.content[0].text,/lease_expired/);assert.equal(stateOf(expiredRequest).report,null);
  withStore(store=>store.abandon(expiredRequest,{actor:'operator',reason:'lease_expired'}));

  writeWorkers(true);const held=submit('read-only'),heldClaim=await tool('claim',{request_id:held,claimant:'held'});
  fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  let retryError;try{const retry=await tool('claim',{request_id:held,claimant:'held'});assert.equal(retry.claim_id,heldClaim.claim_id);}catch(error){retryError=error.message;}
  assert.equal(retryError,undefined,`exact retry must survive malformed profile: ${retryError}`);
  const workspaceFailure=await rawTool('list_files',{request_id:held,claim_id:heldClaim.claim_id});assert.equal(workspaceFailure.isError,true);assert.match(workspaceFailure.content[0].text,/destination_configuration_invalid/,'workspace use fails closed');
  await tool('progress',{request_id:held,claim_id:heldClaim.claim_id,note:'still working'});
  await tool('finish',{request_id:held,claim_id:heldClaim.claim_id,outcome:'completed',summary:'recovered',result:'done'});

  // A held implementation claim also remains usable after its optional workspace
  // policy source breaks, but its retry must not advertise checks or restore workspace access.
  writeWorkers(true);const heldWorkspace=submit('implementation',[{github_repo:'example-owner/fixture',base_sha:base}]);
  const heldWorkspaceClaim=await tool('claim',{request_id:heldWorkspace,claimant:'held-workspace'});
  fs.writeFileSync(workersFile,'{ invalid json',{mode:0o600});
  const workspaceRetry=await tool('claim',{request_id:heldWorkspace,claimant:'held-workspace'});
  assert.equal(workspaceRetry.claim_id,heldWorkspaceClaim.claim_id,'broken optional workspace policy stranded the existing claim');
  assert.deepEqual(workspaceRetry.available_checks,[],'broken workspace policy advertised checks');
  assert.equal(workspaceRetry.available_checks_error,'destination_configuration_invalid','missing sanitized workspace policy diagnostic');
  const heldWorkspaceDenied=await rawTool('list_files',{request_id:heldWorkspace,claim_id:heldWorkspaceClaim.claim_id});
  assert.equal(heldWorkspaceDenied.isError,true,'broken workspace policy granted workspace access');
  assert.match(heldWorkspaceDenied.content[0].text,/destination_configuration_invalid/);
  await tool('progress',{request_id:heldWorkspace,claim_id:heldWorkspaceClaim.claim_id,note:'control survives broken workspace policy'});
  writeWorkers(true);
  await tool('finish',{request_id:heldWorkspace,claim_id:heldWorkspaceClaim.claim_id,outcome:'completed',summary:'workspace policy restored',result:'done'});

  // Removing the worker must not strand an already held non-workspace grant either.
  writeWorkers(false);const removed=submit('read-only'),removedClaim=await tool('claim',{request_id:removed,claimant:'removed'});
  writeOtherWorker();
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
  console.log('PASS workspace policy: plain held finish survives missing/broken profile; required evidence and stale claims remain protected');
} finally {await stop();await new Promise(resolve=>jwks.close(resolve));fs.rmSync(home,{recursive:true,force:true});}
