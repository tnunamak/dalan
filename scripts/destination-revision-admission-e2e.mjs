#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('fixture.invalid');
// Local-only HTTP acceptance journey. The gh binary is an inert fixture, never a network client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const repo=path.resolve(new URL('..',import.meta.url).pathname),home=fs.mkdtempSync(path.join(os.tmpdir(),'destination-http-'));
const config=path.join(home,'.config/dalan'),data=path.join(home,'.local/share/dalan');
const workersFile=path.join(config,'workers.json'),fixture=path.join(home,'fixture'),bin=path.join(home,'bin');
const marker=path.join(home,'change-during-preflight'),observation=path.join(home,'pr.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const declaration=provider=>({operator:'Fixture operator',provider,data_categories:['assignment','results'],
  retention:'30 days',training:'not used',terms:'Terms v1'});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'destination-fixture',alg:'RS256',use:'sig'};
const jwks=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}));});
await new Promise(resolve=>jwks.listen(0,'127.0.0.1',resolve));
const issuer='http://127.0.0.1:'+jwks.address().port+'/realm',audience='https://fixture.invalid/mcp';
const raw={default_execution:'worker',workers:{
  alpha:{connections:[{issuer,subject:'owner',client_id:'alpha'}],repos:['acme/project'],destination:declaration('Provider A')},
  legacy:{connections:[{issuer,subject:'owner',client_id:'legacy'}],repos:[]},
}};
function publish(provider='Provider A',repos=['acme/project']) {
  raw.workers.alpha.repos=repos;
  if(provider===null)delete raw.workers.alpha.destination;else raw.workers.alpha.destination=declaration(provider);
  fs.writeFileSync(workersFile+'.tmp',JSON.stringify(raw),{mode:0o600});fs.renameSync(workersFile+'.tmp',workersFile);
}
function token(worker) {
  const h=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
  const c=Buffer.from(JSON.stringify({iss:issuer,aud:audience,exp:Math.floor(Date.now()/1000)+3600,
    sub:'owner',azp:worker,scope:'dot-bridge.read dot-bridge.work'})).toString('base64url');
  const message=h+'.'+c;return message+'.'+sign('RSA-SHA256',Buffer.from(message),privateKey).toString('base64url');
}
const env={...process.env};
for(const key of Object.keys(env))if(key.startsWith('DALAN_')||key.startsWith('DOT_BRIDGE_'))delete env[key];
Object.assign(env,{HOME:home,NODE_ENV:'test',DALAN_PORT:'0',DALAN_BIND_HOST:'127.0.0.1',
  DALAN_AUTH_MODE:'oauth',DALAN_TEST_OAUTH:'1',DALAN_ENABLE_WORKSPACE:'0',DALAN_CATALOG_PROFILE:'stable',
  DALAN_GITHUB_URL_ACME_PROJECT:fixture,DOT_BRIDGE_GITHUB_URL_ACME_PROJECT:fixture,
  PATH:bin+path.delimiter+process.env.PATH,TEST_DESTINATION_PROFILE:workersFile,
  TEST_DESTINATION_MARKER:marker,TEST_DESTINATION_PR:observation});
let server,db,port,secret,stderr='',exited=false;
function git(args){const r=spawnSync('git',args,{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function admin(route,body,owner,method='POST') {return new Promise((resolve,reject)=>{
  const req=http.request({socketPath:path.join(data,'admin.sock'),path:route,method,
    headers:{'content-type':'application/json',...(owner?{'x-owner-capability':owner}:{})}},res=>{
      let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
});}
async function rpc(name,args,worker='alpha') {
  const response=await fetch('http://127.0.0.1:'+port+'/'+secret+'/mcp',{method:'POST',
    headers:{authorization:'Bearer '+token(worker),'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
  const body=await response.json();if(body.error)return {error:body.error.message};
  if(body.result?.isError)return {error:body.result.content[0].text};
  return JSON.parse(body.result.content[0].text);
}
const assignment=(id,inputs=[])=>({schema_version:1,request_id:id,brief:'CANARY inspect the fixture.',
  inputs,expected_output:'Fixture findings.',execution_scope:'read-only',...(inputs.length?{scope_paths:['README.md']}:{}),
  prepared_at:new Date(Date.now()-1000).toISOString(),valid_until:new Date(Date.now()+3600000).toISOString()});
const body=(a,revision,worker='alpha')=>({assignment:a,owner_token:'owner-'+a.request_id,worker,delivery:'none',
  ...(revision===undefined?{}:{destination_revision:revision})});
const get=a=>admin('/get?id='+a.request_id+'&peek=1',undefined,'owner-'+a.request_id,'GET');
const preview=a=>admin('/submit-preview',body(a));
const submit=(a,revision,worker)=>admin('/submit',body(a,revision,worker));
const count=(table,id)=>db.prepare('SELECT count(*) n FROM '+table+' WHERE request_id=?').get(id).n;
async function accepted(a){const p=await preview(a);assert.equal(p.status,200,JSON.stringify(p));
  const revision=p.body.destination_disclosure.revision,s=await submit(a,revision);
  assert.equal(s.status,200,JSON.stringify(s));return {revision,receipt:s.body};}
try {
  fs.mkdirSync(config,{recursive:true});fs.mkdirSync(bin);publish();
  fs.writeFileSync(path.join(config,'oauth.env'),'OAUTH_ISSUER='+issuer+'\nOAUTH_AUDIENCE='+audience+
    '\nOAUTH_JWKS_URI=http://127.0.0.1:'+jwks.address().port+'/jwks\nOAUTH_ALLOWED_SUBJECTS=owner\n',{mode:0o600});
  git(['init','-q',fixture]);git(['-C',fixture,'config','user.name','Fixture']);
  git(['-C',fixture,'config','user.email','fixture@example.test']);
  fs.writeFileSync(path.join(fixture,'README.md'),'fixture\n');git(['-C',fixture,'add','README.md']);
  git(['-C',fixture,'commit','-qm','fixture']);const sha=git(['-C',fixture,'rev-parse','HEAD']);
  fs.writeFileSync(observation,JSON.stringify({state:'open',draft:false,merged:false,head:{sha}}));
  fs.writeFileSync(path.join(bin,'gh'),'#!/usr/bin/env node\n'+
    "const fs=require('fs'),a=process.argv.slice(2);"+
    "if(a.join(' ')!=='api --hostname github.com repos/acme/project/pulls/7')process.exit(9);"+
    "if(fs.existsSync(process.env.TEST_DESTINATION_MARKER)){const p=JSON.parse(fs.readFileSync(process.env.TEST_DESTINATION_PROFILE));"+
    "p.workers.alpha.destination.provider='Provider B';fs.writeFileSync(process.env.TEST_DESTINATION_PROFILE,JSON.stringify(p),{mode:384});"+
    "fs.unlinkSync(process.env.TEST_DESTINATION_MARKER);}process.stdout.write(fs.readFileSync(process.env.TEST_DESTINATION_PR));\n",{mode:0o755});
  server=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let stdout='';server.stdout.on('data',x=>{stdout+=x;const m=/MCP listening on (?:0\.0\.0\.0|127\.0\.0\.1):(\d+)/.exec(stdout);if(m)port=Number(m[1]);});
  server.stderr.on('data',x=>stderr+=x);server.once('exit',()=>{exited=true;});
  for(let i=0;i<200&&!port&&!exited;i++)await sleep(25);assert.ok(port,stderr);
  secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  db=new DatabaseSync(path.join(data,'bridge.db'),{readOnly:true});

  const positive=assignment('req_http_destination_positive'),A=await accepted(positive);
  const assertNoActor=value=>{
    if(!value||typeof value!=='object')return;
    assert.equal(Object.hasOwn(value,'actor'),false,'worker get must omit actor');
    for(const child of Object.values(value))assertNoActor(child);
  };
  const assertWorkerGet=(response,grant=null)=>{
    const approval=response.destination_approval;
    assert.deepEqual(Object.keys(approval).sort(),['approved_at','revision','snapshot']);
    assertNoActor(approval);
    if(response.destination_changed)assertNoActor(response.destination_changed);
    const {assignment,...metadata}=response;
    const assertNoCapabilities=value=>{
      if(!value||typeof value!=='object')return;
      for(const [key,child] of Object.entries(value)) {
        assert.ok(!['claim_id','origin_claim_id','acquisition_id'].includes(key),'worker metadata leaks '+key);
        assertNoCapabilities(child);
      }
    };
    assertNoCapabilities(metadata);
    if(grant) {
      assert.equal(response.claim.destination_revision,grant.destination_revision);
      assert.ok(!JSON.stringify(metadata).includes(grant.claim_id),'worker metadata leaks claim capability value');
      assert.ok(!JSON.stringify(metadata).includes('private-http-acquisition-canary'),'worker metadata leaks acquisition value');
    }
    return response;
  };
  assert.ok(A.receipt.destination_approval.actor.id,'submit retains owner actor');
  assertWorkerGet(await rpc('get',{request_id:positive.request_id}));
  assert.ok((await get(positive)).body.destination_approval.actor.id,'owner get retains actor');
  const first=await rpc('claim',{request_id:positive.request_id,claimant:'positive',acquisition_id:'private-http-acquisition-canary'});
  assert.equal(first.destination_revision,A.revision,JSON.stringify(first));
  assertWorkerGet(await rpc('get',{request_id:positive.request_id}),first);
  assert.equal((await get(positive)).body.claim.claim_id,first.claim_id,'owner get retains claim identity');
  publish('Provider B');
  const duplicate=await rpc('claim',{request_id:positive.request_id,claimant:'positive',acquisition_id:'private-http-acquisition-canary'});
  assert.equal(duplicate.claim_id,first.claim_id);assert.equal(duplicate.epoch,first.epoch);assert.equal(duplicate.duplicate,true);
  const replay=await submit(positive,A.revision);assert.equal(replay.status,200);
  assert.deepEqual(replay.body.destination_approval,A.receipt.destination_approval);
  assert.equal((await submit(positive,undefined)).status,400,'omitted retry approval is changed intent');

  publish();const stale=assignment('req_http_destination_stale'),p=await preview(stale);
  const old=p.body.destination_disclosure.revision;publish('Provider B');
  const staleSubmit=await submit(stale,old);assert.equal(staleSubmit.status,400);
  assert.equal(staleSubmit.body.destination.error,'destination_changed');
  assert.equal(staleSubmit.body.destination.current.declaration.provider,'Provider B');
  assert.equal(count('assignments',stale.request_id),0);assert.equal(count('notifications',stale.request_id),0);
  const missing=await submit(assignment('req_http_destination_no_approval'),undefined);
  assert.equal(missing.status,400);assert.equal(missing.body.destination.error,'destination_approval_required');

  publish();const drift=assignment('req_http_destination_drift');await accepted(drift);publish('Provider B');
  // Pre-claim exposure remains intentionally visible; this gate is not egress protection.
  assert.match((await rpc('get',{request_id:drift.request_id})).assignment.brief,/CANARY/);
  assert.match((await rpc('list_pending',{})).assignments.find(x=>x.request_id===drift.request_id).title,/CANARY/);
  const denied=await rpc('claim',{request_id:drift.request_id,claimant:'drift'});
  assert.match(denied.error,/destination_changed/);assert.equal(count('claims',drift.request_id),0);
  assertWorkerGet(await rpc('get',{request_id:drift.request_id}));
  const ownerGet=await get(drift);assert.equal(ownerGet.body.status,'queued');
  assert.equal(ownerGet.body.destination_changed.current.declaration.provider,'Provider B');
  const waited=await admin('/wait?id='+drift.request_id+'&timeout=1',undefined,'owner-'+drift.request_id,'GET');
  assert.equal(waited.body.status,'blocker');assert.match(waited.body.blocker_text,/Provider A/);
  assert.match(waited.body.blocker_text,/Provider B/);
  assert.equal((await admin('/get?id='+drift.request_id,undefined,'wrong','GET')).status,400);
  const forged=await rpc('claim',{request_id:drift.request_id,claimant:'forged',destination_revision:old});
  assert.match(forged.error,/unknown field/,'worker cannot supply approval');
  const original=(await get(drift)).body.destination_approval;
  assert.deepEqual((await get(drift)).body.destination_approval,original,'delivery never changes approval');

  publish();const preflight=assignment('req_http_destination_preflight',[{github_repo:'acme/project',base_sha:sha,head_sha:sha,pr_number:7}]);
  await accepted(preflight);fs.writeFileSync(marker,'synthetic change after the preflight starts');
  const raced=await rpc('claim',{request_id:preflight.request_id,claimant:'preflight'});
  assert.equal(fs.existsSync(marker),false,'inert PR preflight did not execute');
  assert.match(raced.error,/destination_changed/);assert.equal(count('claims',preflight.request_id),0);
  assert.equal((await get(preflight)).body.destination_changed.current.declaration.provider,'Provider B');

  publish();const policy=assignment('req_http_destination_policy',[{github_repo:'acme/project',base_sha:sha}]);
  await accepted(policy);publish('Provider A',[]);
  assert.match((await rpc('claim',{request_id:policy.request_id,claimant:'policy'})).error,/not allowed|destination_policy_denied/);
  assert.equal(count('claims',policy.request_id),0);

  const legacy=assignment('req_http_destination_legacy'),legacySubmit=await submit(legacy,undefined,'legacy');
  assert.equal(legacySubmit.status,200);assert.equal(legacySubmit.body.destination_approval,undefined);
  const legacyClaim=await rpc('claim',{request_id:legacy.request_id,claimant:'legacy'},'legacy');
  assert.ok(legacyClaim.claim_id);assert.equal(legacyClaim.destination_revision,undefined);
  assert.equal((await rpc('claim',{request_id:legacy.request_id,claimant:'legacy'},'legacy')).claim_id,legacyClaim.claim_id);
  assert.equal((await submit(legacy,undefined,'legacy')).body.duplicate,true);
  console.log('PASS destination disclosure and claim admission HTTP; pre-claim disclosure remains possible');
} finally {
  db?.close();
  if(server&&!exited){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
  await new Promise(resolve=>jwks.close(resolve));fs.rmSync(home,{recursive:true,force:true});
}
