#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('bridge.example.test');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=process.env.DOT_BRIDGE_TEST_TMP||path.join(os.homedir(),'.tmp');
fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'repo-policy-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const git=spawnSync('which',['git'],{encoding:'utf8'}).stdout.trim();
const fixture=path.join(root,'fixture.git');
const work=path.join(root,'fixture-work');
spawnSync(git,['init','-q',work],{check:true});
fs.writeFileSync(path.join(work,'README.md'),'repo fixture\n');
fs.writeFileSync(path.join(work,'.dot-bridge.json'),JSON.stringify({checks:{review_marker:{argv:['/runtime/node','-e','0'],timeout_ms:1000,output_bytes:4096}}}));
spawnSync(git,['-C',work,'-c','user.name=Fixture','-c','user.email=fixture@example.test','add','.'],{check:true});
spawnSync(git,['-C',work,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture'],{check:true});
const base=spawnSync(git,['-C',work,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
spawnSync(git,['clone','-q','--bare',work,fixture],{check:true});

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'repo-policy-test',alg:'RS256',use:'sig'};
const jwks=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}));});
await new Promise(resolve=>jwks.listen(0,'127.0.0.1',resolve));
const jwksBase=`http://127.0.0.1:${jwks.address().port}`;
const issuer=`${jwksBase}/realm`,audience='https://bridge.example.test/mcp';
const token=worker=>{
  const header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
  const claims=Buffer.from(JSON.stringify({iss:issuer,aud:audience,exp:Math.floor(Date.now()/1000)+600,sub:'owner',azp:`client-${worker}`,scope:'dot-bridge.read dot-bridge.work'})).toString('base64url');
  const message=`${header}.${claims}`;
  return `${message}.${sign('RSA-SHA256',Buffer.from(message),privateKey).toString('base64url')}`;
};
const config=path.join(root,'home','.config/dot-bridge');
fs.mkdirSync(config,{recursive:true,mode:0o700});
const profile={workers:{
  alpha:{workspaceAllowed:true,connections:[{issuer,subject:'owner',client_id:'client-alpha'}],repos:['acme/project'],guidance:'resume'},
  beta:{connections:[{issuer,subject:'owner',client_id:'client-beta'}],repos:[],capabilities:[]},
},default_execution:'none'};
const workersFile=path.join(config,'workers.json');
fs.writeFileSync(workersFile,`${JSON.stringify(profile,null,2)}\n`,{mode:0o600});
fs.writeFileSync(path.join(config,'oauth.env'),`OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=${jwksBase}/jwks\nOAUTH_ALLOWED_SUBJECTS=owner\n`,{mode:0o600});
const gitLog=path.join(root,'fetches.log');
const bin=path.join(root,'bin');fs.mkdirSync(bin,{recursive:true});
fs.writeFileSync(path.join(bin,'git'),`#!/bin/sh\ncase " $* " in *" fetch "*) printf '%s\\n' "$*" >> "$BRIDGE_FETCH_LOG";; esac\nexec ${git} "$@"\n`,{mode:0o755});
const t3Log=path.join(root,'t3.log');
fs.writeFileSync(path.join(bin,'t3code'),'#!/usr/bin/env node\nconst fs=require("fs"),a=process.argv.slice(2);fs.appendFileSync(process.env.TEST_T3_LOG,a.join(" ")+"\\n");if(fs.existsSync(process.env.TEST_T3_LOG+".tighten")){const p=JSON.parse(fs.readFileSync(process.env.TEST_WORKERS_FILE));p.workers.alpha.repos=[];fs.writeFileSync(process.env.TEST_WORKERS_FILE,JSON.stringify(p),{mode:384});}console.log(JSON.stringify({ok:true,data:{runtime:{environmentId:"fixture-env"},thread:{id:a[a.indexOf("--thread")+1],status:"active"}}}));\n',{mode:0o755});
const env={...process.env,HOME:path.dirname(path.dirname(path.dirname(config))),DOT_BRIDGE_PORT:'0',DOT_BRIDGE_AUTH_MODE:'oauth',DOT_BRIDGE_TEST_OAUTH:'1',NODE_ENV:'test',DOT_BRIDGE_ENABLE_WORKSPACE:'1',DOT_BRIDGE_WORKSPACE_ROOT:path.join(root,'work'),DOT_BRIDGE_MIN_FREE_BYTES:'0',BRIDGE_FETCH_LOG:gitLog,PATH:`${bin}${path.delimiter}${process.env.PATH}`,GITHUB_CLONE_BASE_URL:fixture,DOT_BRIDGE_GITHUB_URL_ACME_PROJECT:fixture,DOT_BRIDGE_GITHUB_URL_ACME_SECRET:fixture};
env.TEST_T3_LOG=t3Log;
env.TEST_WORKERS_FILE=workersFile;
env.DOT_BRIDGE_T3CODE_BIN=path.join(bin,'t3code');
// config is <root>/home/.config/dot-bridge; use that HOME for server, CLI and isolated config.
env.HOME=path.join(root,'home');
const server=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',port=null,exited=false;
server.stdout.on('data',chunk=>{stdout+=String(chunk);const m=/MCP listening on (?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/.exec(stdout);if(m)port=Number(m[1]);});
server.stderr.on('data',chunk=>{stderr+=String(chunk);});server.once('exit',()=>{exited=true;});
const waitFor=async(test,label)=>{for(let i=0;i<200;i++){if(test())return;await sleep(25);}throw new Error(`timed out waiting for ${label}: ${stderr}`);};
const cli=(args,input='',home=env.HOME)=>spawnSync(process.execPath,['bin/dalan.mjs',...args],{cwd:repo,env:{...env,HOME:home},input,encoding:'utf8'});
const assignment=(id,repoName)=>({schema_version:1,request_id:id,brief:'Read the repository README and report its fixture line.',inputs:[{github_repo:repoName,base_sha:base}],scope_paths:['README.md'],expected_output:'One sentence.',execution_scope:'read-only'});
const receipts=path.join(env.HOME,'.local/share/dot-bridge/receipts');
const fetchCount=()=>{try{return fs.readFileSync(gitLog,'utf8').trim().split('\n').filter(Boolean).length;}catch{return 0;}};
let db;
const assignmentCount=id=>db.prepare('SELECT count(*) n FROM assignments WHERE request_id=?').get(id).n;
async function rpc(worker,name,args) {
  const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token(worker)}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
  const body=await response.json();
  if(body.result?.isError)return {ok:false,error:body.result.content?.[0]?.text};
  assert.equal(response.status,200,JSON.stringify(body));return {ok:true,value:JSON.parse(body.result.content[0].text)};
}
async function adminSubmit(id,worker,repoName,route='/submit',overrides={}) {
  const payload=JSON.stringify({assignment:assignment(id,repoName),owner_token:`raw-${id}`,delivery:'none',worker,...overrides});
  return new Promise((resolve,reject)=>{
    const request=http.request({socketPath:path.join(env.HOME,'.local/share/dot-bridge/admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}));});
    request.on('error',reject);request.end(payload);
  });
}
try {
  await waitFor(()=>port!==null||exited,'bridge startup');
  assert.notEqual(port,null,`bridge did not start: ${stderr}`);
  db=new DatabaseSync(path.join(env.HOME,'.local/share/dot-bridge/bridge.db'),{readOnly:true});

  const stoppedHome=path.join(root,'stopped-home'),stoppedConfig=path.join(stoppedHome,'.config/dot-bridge');
  fs.mkdirSync(stoppedConfig,{recursive:true});
  fs.writeFileSync(path.join(stoppedConfig,'workers.json'),JSON.stringify({workers:{alpha:{repos:[],connections:[]}}}),{mode:0o600});
  fs.writeFileSync(path.join(stoppedConfig,'acp-secret'),'synthetic-not-an-admission-exemption',{mode:0o600});
  const deniedOffline=cli(['submit','--worker','alpha','--stdin','--json'],JSON.stringify(assignment(`req_${randomUUID()}`,'acme/secret')),stoppedHome);
  assert.equal(deniedOffline.status,1);
  assert.match(deniedOffline.stderr,/not allowed for worker/,'a secret file must not bypass local policy even with the bridge stopped');
  const stoppedReceipts=path.join(stoppedHome,'.local/share/dot-bridge/receipts');
  assert.deepEqual(fs.existsSync(stoppedReceipts)?fs.readdirSync(stoppedReceipts):[],[],'denial must precede receipt creation');

  const deniedId=`req_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const beforeDenied=fetchCount();
  const denied=cli(['submit','--worker','alpha','--stdin','--json'],JSON.stringify(assignment(deniedId,'acme/secret')));
  assert.notEqual(denied.status,0,'unlisted repository was admitted by the real CLI');
  assert.match(denied.stderr,/not allowed for worker/);
  assert.equal(fetchCount(),beforeDenied,'denied CLI admission called git fetch');
  assert.equal(assignmentCount(deniedId),0,'denied CLI admission created an assignment');
  assert.equal(fs.existsSync(path.join(receipts,`${(await import('node:crypto')).createHash('sha256').update(deniedId).digest('hex')}.json`)),false,'denied CLI admission left an owner receipt');

  const rawId=`req_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const beforeRaw=fetchCount();
  const raw=await adminSubmit(rawId,'alpha','acme/secret');
  assert.equal(raw.status,400,JSON.stringify(raw.body));assert.match(raw.body.error,/not allowed for worker "alpha"/);
  assert.equal(fetchCount(),beforeRaw,'raw HTTP admission called git fetch');assert.equal(assignmentCount(rawId),0,'raw HTTP admission created an assignment');

  const betaId=`req_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const beta=cli(['submit','--worker','beta','--stdin','--json'],JSON.stringify(assignment(betaId,'acme/project')));
  assert.notEqual(beta.status,0,'worker beta inherited alpha repository access');assert.equal(assignmentCount(betaId),0);

  const noTargetId=`req_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const noTarget=cli(['submit','--stdin','--json'],JSON.stringify(assignment(noTargetId,'acme/project')));
  assert.notEqual(noTarget.status,0,'multi-worker submission without a target was admitted');assert.match(noTarget.stderr,/needs a target worker/);
  assert.equal(assignmentCount(noTargetId),0);

  const allowedId=`req_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const allowed=cli(['submit','--worker','alpha','--stdin','--json'],JSON.stringify(assignment(allowedId,'acme/project')));
  assert.equal(allowed.status,0,allowed.stderr);assert.equal(assignmentCount(allowedId),1);assert(fetchCount()>beforeDenied,'allowed repository was not fetched');
  const multiId=`req_${randomUUID()}`, multi=assignment(multiId,'acme/project');
  multi.inputs.push({...multi.inputs[0]});
  const multiResult=cli(['submit','--worker','alpha','--stdin','--json'],JSON.stringify(multi));
  assert.notEqual(multiResult.status,0);
  assert.match(multiResult.stderr,/one repository input per job/,'multiple inputs must not be reported as a missing grant');
  assert.equal(assignmentCount(multiId),0);
  const metadataId=`req_${randomUUID()}`;
  const metadataSubmit=await adminSubmit(metadataId,'alpha','acme/project','/submit',{assignment:{...assignment(metadataId,'acme/project'),execution_scope:'implementation'}});
  assert.equal(metadataSubmit.status,200,JSON.stringify(metadataSubmit));
  const ownerGet=()=>new Promise((resolve,reject)=>{
    const q=http.request({socketPath:path.join(env.HOME,'.local/share/dot-bridge/admin.sock'),path:`/get?id=${metadataId}&peek=1`,headers:{'x-owner-capability':`raw-${metadataId}`}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(b)}));});q.on('error',reject);q.end();
  });
  assert.equal((await ownerGet()).body.check_metadata.review_marker.argv[0],'/runtime/node');
  const scopedMirror=worker=>path.join(env.DOT_BRIDGE_WORKSPACE_ROOT,'mirrors','workers',worker,'acme','project.git');
  assert.equal(fs.existsSync(scopedMirror('dot')),false,'owner get prepared the default worker cache instead of the persisted target');
  const liveMetadataId=`req_${randomUUID()}`;
  assert.equal((await adminSubmit(liveMetadataId,'alpha','acme/project','/submit',{assignment:{...assignment(liveMetadataId,'acme/project'),execution_scope:'implementation'}})).status,200);
  const liveMetadataClaim=await rpc('alpha','claim',{request_id:liveMetadataId,claimant:'metadata-holder',acquisition_id:'metadata-fixture-acquisition'});
  assert.equal(liveMetadataClaim.ok,true,JSON.stringify(liveMetadataClaim));
  assert.equal(JSON.parse(fs.readFileSync(workersFile,'utf8')).workers.alpha.guidance,'resume','profile identity fields retained');
  const t3Id=`req_${randomUUID()}`,t3Delivery='t3:repo-policy-fixture-thread';
  const t3Seed=await adminSubmit(t3Id,'alpha','acme/project','/submit',{delivery:t3Delivery});
  assert.equal(t3Seed.status,200,JSON.stringify(t3Seed.body));
  assert(fs.readFileSync(t3Log,'utf8').includes('threads inspect'),'destination fixture was not exercised');
  for(const route of ['/submit','/submit-preview']) {
    const beforeLookup=fs.readFileSync(t3Log);
    const conflict=await adminSubmit(t3Id,'alpha','acme/project',route,{assignment:{...assignment(t3Id,'acme/project'),brief:'Changed immutable brief'},delivery:t3Delivery});
    const reason=conflict.body.error??conflict.body.reasons?.map(r=>r.message).join('; ');
    assert.match(reason,/request_id conflict/);
    assert.deepEqual(fs.readFileSync(t3Log),beforeLookup,'immutable retry conflict reached destination inspection');
  }
  fs.writeFileSync(t3Log+'.tighten','synthetic fixture control');
  try {
    const raceId=`req_${randomUUID()}`,before=fs.readFileSync(t3Log).length;
    const raced=await adminSubmit(raceId,'alpha','acme/project','/submit',{delivery:t3Delivery});
    assert.equal(raced.status,400,JSON.stringify(raced.body));
    assert.match(raced.body.error,/not allowed for worker/);
    assert(fs.readFileSync(t3Log).length>before,'tightening fixture did not run during inspection');
    assert.equal(assignmentCount(raceId),0,'policy tightened during lookup but assignment was admitted');
  } finally {
    fs.rmSync(t3Log+'.tighten',{force:true});
    fs.writeFileSync(workersFile,JSON.stringify(profile),{mode:0o600});
  }

  const changed=JSON.parse(fs.readFileSync(workersFile,'utf8'));changed.workers.alpha.repos=[];fs.writeFileSync(workersFile,`${JSON.stringify(changed,null,2)}\n`,{mode:0o600});fs.chmodSync(workersFile,0o600);
  fs.rmSync(scopedMirror('alpha'),{recursive:true,force:true});
  const beforeMetadataRead=fetchCount();
  const revokedGet=await rpc('alpha','get',{request_id:metadataId});
  assert.equal(revokedGet.ok,true,JSON.stringify(revokedGet));
  assert.deepEqual(revokedGet.value.available_checks,[]);
  assert.equal(revokedGet.value.available_checks_error,'repository_policy_denied');
  const revokedOwner=await ownerGet();assert.equal(revokedOwner.status,200);
  assert.equal(revokedOwner.body.available_checks_error,'repository_policy_denied');
  assert.equal(revokedOwner.body.queue_blocker.code,'repository_policy_denied');
  assert.match(revokedOwner.body.queue_blocker.message,/worker allow alpha acme\/project/);
  const wait=await new Promise((resolve,reject)=>{const q=http.request({socketPath:path.join(env.HOME,'.local/share/dot-bridge/admin.sock'),path:`/wait?id=${metadataId}&timeout=1`,headers:{'x-owner-capability':`raw-${metadataId}`}},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve(JSON.parse(b)));});q.on('error',reject);q.end();});
  assert.equal(wait.status,'blocker');assert.equal(wait.queue_blocker.code,'repository_policy_denied');
  assert.equal(revokedOwner.body.check_metadata,undefined);
  assert.equal(fetchCount(),beforeMetadataRead,'revoked queued get fetched source');
  assert.equal(fs.existsSync(scopedMirror('alpha')),false);
  assert.equal(assignmentCount(metadataId),1,'revocation hid or removed the durable assignment');
  assert.equal(db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get(metadataId).n,0);
  const retainedGet=await rpc('alpha','get',{request_id:liveMetadataId});
  assert.equal(retainedGet.ok,true,JSON.stringify(retainedGet));assert.ok(retainedGet.value.available_checks.includes('review_marker'),'revocation blocked metadata for the existing live grant');
  assert.equal(fs.existsSync(scopedMirror('dot')),false,'retained grant prepared a foreign worker cache');
  const retainedRead=await rpc('alpha','read_file',{request_id:liveMetadataId,claim_id:liveMetadataClaim.value.claim_id,path:'README.md'});
  assert.equal(retainedRead.ok,true,JSON.stringify(retainedRead));assert.equal(retainedRead.value.text,'repo fixture\n');
  const retainedFinish=await rpc('alpha','finish',{request_id:liveMetadataId,claim_id:liveMetadataClaim.value.claim_id,outcome:'completed',summary:'Fixture read complete',result:'repo fixture'});
  assert.equal(retainedFinish.ok,true,JSON.stringify(retainedFinish));
  for(const route of ['/submit','/submit-preview']) {
    const beforeLookup=fs.readFileSync(t3Log),replacement={...assignment(t3Id,'acme/project'),inputs:[]};
    const response=await adminSubmit(t3Id,'alpha','acme/project',route,{assignment:replacement,delivery:t3Delivery});
    const refusal=response.body.error??response.body.reasons?.map(r=>r.message).join('; ');
    assert.match(refusal,/not allowed for worker/,'a changed retry must check the stored repository policy');
    assert.deepEqual(fs.readFileSync(t3Log),beforeLookup,'retry denial reached destination metadata lookup');
    assert.equal(assignmentCount(t3Id),1);
  }
  const beforeRetry=fetchCount();
  const retry=cli(['submit','--stdin','--json'],JSON.stringify(assignment(allowedId,'acme/project')));
  assert.notEqual(retry.status,0,'retry bypassed a tightened current policy');assert.match(retry.stderr,/not allowed for worker/);assert.equal(fetchCount(),beforeRetry);
  const alternateWorkerRetry=cli(['submit','--worker','beta','--stdin','--json'],JSON.stringify(assignment(allowedId,'acme/project')));
  assert.notEqual(alternateWorkerRetry.status,0,'retry used another worker to bypass the original target policy');assert.match(alternateWorkerRetry.stderr,/not allowed for worker/);assert.equal(fetchCount(),beforeRetry);
  const lifecycleBefore=db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=?").get(allowedId).n;
  const claim=await rpc('alpha','claim',{request_id:allowedId,claimant:'repo-policy-test'});
  assert.equal(claim.ok,false,'claim succeeded after policy tightened');assert.match(claim.error,/not allowed for worker "alpha"/);
  assert.equal(db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get(allowedId).n,0,'denied claim created a claim row');
  assert.equal(db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(allowedId).n,0,'denied claim wrote a claimed lifecycle event');
  assert.equal(db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=?").get(allowedId).n,lifecycleBefore,'denied claim changed lifecycle state');
  assert.equal(db.prepare('SELECT status FROM assignments WHERE request_id=?').get(allowedId).status,'queued','denied claim changed assignment state');

  const grant=cli(['worker','allow','alpha','acme/project','--json']);
  assert.equal(grant.status,0,grant.stderr);
  const unblocked=JSON.parse(cli(['get',allowedId,'--json']).stdout);
  assert.equal(unblocked.status,'queued');
  assert.equal(unblocked.queue_blocker,undefined,'a restored grant must clear the queue blocker');
  const resumed=await rpc('alpha','claim',{request_id:allowedId,claimant:'repo-policy-test'});
  assert.equal(resumed.ok,true,`a live server must reload the CLI grant: ${JSON.stringify(resumed)}`);
  assert.equal(exited,false,'grant must not require a server restart');

  const isolated=JSON.parse(fs.readFileSync(workersFile,'utf8'));
  delete isolated.workers.alpha.repos;
  fs.writeFileSync(workersFile,`${JSON.stringify(isolated,null,2)}\n`,{mode:0o600});fs.chmodSync(workersFile,0o600);
  const legacyId=`req_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const legacy=cli(['submit','--worker','alpha','--stdin','--json'],JSON.stringify(assignment(legacyId,'acme/secret')));
  assert.notEqual(legacy.status,0,'an omitted policy retained implicit allow-any access');assert.match(legacy.stderr,/not allowed for worker/);
  assert.equal(assignmentCount(legacyId),0);

  isolated.workers.alpha.repos=['acme/allowed'];isolated.workers.beta.repos=[];fs.writeFileSync(workersFile,`${JSON.stringify(isolated,null,2)}\n`,{mode:0o600});fs.chmodSync(workersFile,0o600);
  const futureId=`req_${randomUUID().replaceAll('-','').slice(0,24)}`;
  const beforeFuture=fetchCount();
  const future=cli(['submit','--worker','alpha','--stdin','--json'],JSON.stringify(assignment(futureId,'acme/future')));
  assert.notEqual(future.status,0,'new repository under an allowed owner inherited access');assert.equal(assignmentCount(futureId),0);assert.equal(fetchCount(),beforeFuture,'new same-owner repository was fetched before denial');

  const adminHome=path.join(root,'cli-home'),adminConfig=path.join(adminHome,'.config/dot-bridge');fs.mkdirSync(adminConfig,{recursive:true,mode:0o700});
  const cliProfile={workers:{alpha:{repos:[],connections:[{issuer,subject:'owner',client_id:'client-alpha'}],capabilities:['t3'],guidance:'resume'},beta:{repos:[],connections:[{issuer,subject:'owner',client_id:'client-beta'}]}},default_execution:'worker'};
  const cliFile=path.join(adminConfig,'workers.json');fs.writeFileSync(cliFile,`${JSON.stringify(cliProfile,null,2)}\n`,{mode:0o600});
  const cliEnv={...env,HOME:adminHome};
  const workerCli=(...args)=>spawnSync(process.execPath,['bin/dalan.mjs','worker',...args],{cwd:repo,env:cliEnv,encoding:'utf8'});
  const cliAllow=workerCli('allow','alpha','acme/project','--json');assert.equal(cliAllow.status,0,cliAllow.stderr||cliAllow.stdout);
  const allowProfile=JSON.parse(fs.readFileSync(cliFile,'utf8'));
  assert.deepEqual(allowProfile.workers.alpha.repos,['acme/project']);assert.deepEqual(allowProfile.workers.beta,cliProfile.workers.beta);
  assert.deepEqual(allowProfile.workers.alpha.connections,cliProfile.workers.alpha.connections);
  assert.deepEqual(allowProfile.workers.alpha.capabilities,cliProfile.workers.alpha.capabilities);
  assert.equal(allowProfile.workers.alpha.guidance,cliProfile.workers.alpha.guidance);
  assert.equal(allowProfile.default_execution,cliProfile.default_execution);
  assert.equal(fs.statSync(cliFile).mode&0o777,0o600);
  assert.equal(workerCli('allow','alpha','bad/**').status,1,'malformed CLI pattern was accepted');
  assert.equal(workerCli('list','extra').status,1,'invalid list arguments were accepted');
  assert.equal(workerCli('allow','alpha','acme/*','--json').status,1,'wildcard CLI grant must be rejected');
  assert.equal(workerCli('allow','alpha','--any','--json').status,1,'--any CLI grant must be rejected');
  const changes=JSON.parse(workerCli('list','--json').stdout);assert.ok(changes.workers[0].changes.length,'worker list exposes actual policy change events');
  const auditFile=path.join(adminConfig,'workers-audit.jsonl'),auditBytes=fs.readFileSync(auditFile);
  try {
    fs.writeFileSync(auditFile,Buffer.concat(Array.from({length:5000},()=>auditBytes)),{mode:0o600});
    assert.ok(fs.statSync(auditFile).size>1024*1024);
    const large=workerCli('list','--json');assert.equal(large.status,0,large.stderr);
    const largePolicy=JSON.parse(large.stdout).workers[0];
    assert.deepEqual(largePolicy.repos,['acme/project']);assert.equal(largePolicy.change_count,null);
    assert.equal(largePolicy.changes.length,20);assert.equal(largePolicy.changes_truncated,true);
    fs.writeFileSync(auditFile,'{"sensitive":"AUDIT_BODY_SENTINEL"}\n',{mode:0o600});
    const malformed=workerCli('list','--json');assert.equal(malformed.status,0,malformed.stderr);
    assert.equal(JSON.parse(malformed.stdout).workers[0].changes.length,0);
    assert.equal(JSON.parse(malformed.stdout).workers[0].change_count,null);
    assert.doesNotMatch(malformed.stdout+malformed.stderr,/AUDIT_BODY_SENTINEL/);
    fs.rmSync(auditFile);const other=path.join(root,'unrelated-journal');
    fs.writeFileSync(other,'LINK_BODY_SENTINEL',{mode:0o600});fs.symlinkSync(other,auditFile);
    const symlink=workerCli('list','--json');assert.equal(symlink.status,0,symlink.stderr);
    assert.ok(JSON.parse(symlink.stdout).workers[0].changes_error);
    assert.doesNotMatch(symlink.stdout+symlink.stderr,/LINK_BODY_SENTINEL/);
  } finally {fs.rmSync(auditFile,{force:true});fs.writeFileSync(auditFile,auditBytes,{mode:0o600});}
  for(const workers of [{alpha:{repos:[],connections:[]}},{alpha:{repos:[],connections:[]},beta:{repos:[]}}]) {
    fs.writeFileSync(cliFile,JSON.stringify({workers}),{mode:0o600});
    for(const command of [['list','--json'],['allow','alpha','acme/project','--json'],['deny','alpha','acme/project','--json']]) {
      const r=workerCli(...command);assert.equal(r.status,0,r.stderr);
    }
    const doctor=cli(['doctor','--json'],'',adminHome);assert.equal(doctor.status,0,doctor.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(cliFile)).workers.alpha.connections,[]);
  }

  const legacyHome=path.join(root,'legacy-home'),legacyConfig=path.join(legacyHome,'.config/dot-bridge');fs.mkdirSync(legacyConfig,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(legacyConfig,'workers.json'),JSON.stringify({workers:{alpha:{connections:[{issuer,subject:'owner',client_id:'client-alpha'}]}}}),{mode:0o600});
  const doctor=spawnSync(process.execPath,['bin/dalan.mjs','doctor','--json'],{cwd:repo,env:{...env,HOME:legacyHome},encoding:'utf8'});
  assert.equal(doctor.status,0,doctor.stderr);const doctorJson=JSON.parse(doctor.stdout);
  assert.equal(doctorJson.repository_access.workers[0].mode,'exact');assert.deepEqual(doctorJson.repository_access.workers[0].repos,[]);assert.equal(doctorJson.repository_access.warnings.length,1);assert.match(doctorJson.repository_access.warnings[0],/worker "alpha".*repository jobs are denied/);
  const legacyList=spawnSync(process.execPath,['bin/dalan.mjs','worker','list','--json'],{cwd:repo,env:{...env,HOME:legacyHome},encoding:'utf8'});assert.equal(legacyList.status,0,legacyList.stderr);assert.equal(JSON.parse(legacyList.stdout).workers[0].warning,undefined);
  const legacyDeny=spawnSync(process.execPath,['bin/dalan.mjs','worker','deny','alpha','acme/project','--json'],{cwd:repo,env:{...env,HOME:legacyHome},encoding:'utf8'});assert.equal(legacyDeny.status,0,'omitted repositories already deny all access');
  const legacyAllow=spawnSync(process.execPath,['bin/dalan.mjs','worker','allow','alpha','acme/project','--json'],{cwd:repo,env:{...env,HOME:legacyHome},encoding:'utf8'});assert.equal(legacyAllow.status,0,legacyAllow.stderr);
  const legacyBounded=JSON.parse(fs.readFileSync(path.join(legacyConfig,'workers.json'),'utf8')).workers.alpha;assert.deepEqual(legacyBounded.repos,['acme/project']);
  const absentHome=path.join(root,'absent-profile');fs.mkdirSync(absentHome);
  const absentDoctor=cli(['doctor','--json'],'',absentHome);assert.equal(absentDoctor.status,0,absentDoctor.stderr);
  const warning=JSON.parse(absentDoctor.stdout).repository_access.warnings[0];
  assert.match(warning,/repository jobs are denied/);assert.doesNotMatch(warning,/worker allow/);
  assert.equal(cli(['worker','list','--json'],'',absentHome).status,0,'the missing-profile warning command must run');
  const guide=fs.readFileSync(path.join(repo,'docs/operations.md'),'utf8');
  assert.doesNotMatch(guide,/"repos"\s*:\s*\[[^\]]*"[^"\n]*\/\*/,'the repository-policy example recommends a rejected wildcard');

  const freshHome=path.join(root,'fresh-home');
  const init=spawnSync(process.execPath,['bin/dalan.mjs','init','--worker','fresh','--public-url','http://127.0.0.1:9'],{cwd:repo,env:{...env,HOME:freshHome,NODE_ENV:'test',DOT_BRIDGE_TEST_OAUTH:'1'},encoding:'utf8'});
  assert.equal(init.status,0,init.stderr);const freshWorkers=JSON.parse(fs.readFileSync(path.join(freshHome,'.config/dalan/workers.json'),'utf8'));
  assert.deepEqual(freshWorkers.workers.fresh.repos,[],'fresh init did not default to deny-all');
  console.log('PASS worker repository policy: admission order, current-policy retry and claim denial, exact-list, CLI preservation, legacy warning, and fresh deny-all');
} finally {
  db?.close();
  if(!exited) { try { process.kill(-server.pid,'SIGTERM'); } catch {} await new Promise(resolve=>server.once('exit',resolve)); }
  await new Promise(resolve=>jwks.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
}
