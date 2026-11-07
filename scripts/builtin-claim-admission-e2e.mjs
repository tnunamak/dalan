// Local built-in HTTP admission tests with deterministic preflight/quiesce barriers.
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import {AsStore} from '../src/as-store.mjs';
const code=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'builtin-claim-http-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const declaration={operator:'Fixture',provider:'Fixture',data_categories:['assignment','results'],retention:'30 days',training:'none',terms:'v1'};
const assignment=id=>({schema_version:1,request_id:id,brief:'claim fixture',inputs:[],expected_output:'report',execution_scope:'read-only'});

function approve(auth,name,worker='dot',replace=false,grantId='grant-'+name,resource='https://fixture.invalid/mcp') {
  auth.closeWindow();const window=auth.openWindow(worker,10),client_id='client-'+name;
  auth.admission.run(window.generation,()=>auth.upsert('Client',client_id,{client_id}));
  if(!auth.find('Grant',grantId))auth.upsert('Grant',grantId,{clientId:client_id},3600);
  const snapshot={client_id,client_name:name,redirect_uri:'https://fixture.invalid/callback',resource,scopes:'dot-bridge.read dot-bridge.work',interaction_expires_at:Date.now()+600000};
  const pairing=auth.pairingFor('interaction-'+name,snapshot,window);
  if(!auth.reserve(pairing.code))throw new Error('reserve failed');
  return {...auth.commitApproval({code:pairing.code,worker,grantId,snapshot,replace}),grantId,client_id};
}

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,{native=false}={}) {
  const home=fs.mkdtempSync(path.join(root,'http-')),config=path.join(home,'.config/dalan'),data=path.join(home,'.local/share/dalan');
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const repository=path.join(home,'repository');fs.mkdirSync(repository);
  const git=args=>execFileSync('git',args,{encoding:'utf8',cwd:repository}).trim();
  git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(repository,'README.md'),'fixture');git(['add','README.md']);git(['commit','-qm','fixture']);
  const sha=git(['rev-parse','HEAD']);
  const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('DALAN_')||k.startsWith('DOT_BRIDGE_'))delete env[k];
  Object.assign(env,{HOME:home,NODE_ENV:'test',DALAN_LOOPBACK:'1',DALAN_AUTH_MODE:'builtin',DALAN_PORT:String(port),DALAN_ENABLE_WORKSPACE:'1',DALAN_GITHUB_URL_ACME_PROJECT:repository,TEST_CLAIM_SHA:sha,...(native?{DALAN_CATALOG_PROFILE:'protocol-v0'}:{})});
  fs.mkdirSync(config,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(config,'limits.json'),JSON.stringify({max_claimed_outer_assignments:6}),{mode:0o600});
  fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({default_execution:'worker',workers:{dot:{destination:declaration,repos:['acme/project']},other:{}}}),{mode:0o600});
  execFileSync(process.execPath,['bin/dalan.mjs','as-init','--public-url',`http://127.0.0.1:${port}`],{cwd:code,env,stdio:'pipe'});
  const barrier=path.join(home,'barrier.mjs');
  fs.writeFileSync(barrier,`import {pathToFileURL} from 'node:url';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
let armed=false;
process.on('message',message=>{if(message.armPreflight){armed=true;process.send({armed:true});}});
const originalExec=childProcess.execFile,run=promisify(originalExec);
const fixtureExec=(...args)=>originalExec(...args);
fixtureExec[promisify.custom]=async(file,args,options)=>{
  if(file!=='gh')return run(file,args,options);
  if(args.join(' ')!=='api --hostname github.com repos/acme/project/pulls/7')throw new Error('unexpected fixture command');
  if(armed){process.send({preflight:true});await new Promise(resolve=>process.once('message',resolve));}
  return {stdout:JSON.stringify({state:'open',draft:false,merged:false,head:{sha:process.env.TEST_CLAIM_SHA}}),stderr:''};
};
childProcess.execFile=fixtureExec;syncBuiltinESMExports();
const {Workspace}=await import(pathToFileURL(path.join(process.cwd(),'src/workspace.mjs')).href);
const original=Workspace.prototype.quiesce;
Workspace.prototype.quiesce=async function(id,...args) {
  process.send({barrier:id});
  await new Promise(resolve=>process.once('message',resolve));
  return original.call(this,id,...args);
};`);
  const child=spawn(process.execPath,['--import',barrier,'src/server.mjs'],{cwd:code,env,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  let auth;
  t.after(async()=>{if(child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}auth?.close();fs.rmSync(home,{recursive:true,force:true});});
  for(let i=0;i<300&&!stdout.includes('MCP listening on')&&child.exitCode===null;i++)await delay(25);
  assert.match(stdout,/MCP listening on/,stderr);
  const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1],resource=`http://127.0.0.1:${port}/${secret}/mcp`;
  auth=new AsStore(path.join(config,'as.sqlite'));
  function connect(name,worker='dot',replace=false) {
    const c=approve(auth,name,worker,replace,'grant-'+name,resource),iat=Math.floor(Date.now()/1000),token=randomUUID().replaceAll('-','');
    auth.upsert('Grant',c.grantId,{jti:c.grantId,kind:'Grant',accountId:'owner',clientId:c.client_id,iat,exp:iat+3600},3600);
    auth.upsert('AccessToken',token,{jti:token,kind:'AccessToken',accountId:'owner',clientId:c.client_id,grantId:c.grantId,aud:resource,scope:'dot-bridge.read dot-bridge.work',iat,exp:iat+3600},3600);
    return {...c,token};
  }
  function admin(route,body) {return new Promise((resolve,reject)=>{const req=http.request({socketPath:path.join(data,'admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json'}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve(JSON.parse(s)));});req.on('error',reject);req.end(JSON.stringify(body));});}
  async function rpc(c,name,args={}) {
    const r=await fetch(resource,{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
    if(!r.ok)return {error:`HTTP ${r.status}`};
    const b=await r.json();if(b.error)return {error:b.error};if(b.result?.isError)return {error:b.result.content[0].text};return JSON.parse(b.result.content[0].text);
  }
  const a=connect('A');
  async function submit(id,extra={}) {
    const body={assignment:{...assignment(id),...extra,...(native?{protocol:{profile:'job-v0',source:'fixture',scope:'fixture',policy:'fixture',destination:'fixture',retain_until_ms:Date.now()+3600000}}:{})},worker:'dot',owner_token:'owner',delivery:'none',execution:'worker'};
    const preview=await admin('/submit-preview',body);assert.ok(preview.destination_disclosure,JSON.stringify(preview));
    const result=await admin('/submit',{...body,destination_revision:preview.destination_disclosure.revision});assert.ok(!result.error,JSON.stringify(result));
  }
  return {a,auth,child,connect,submit,rpc,sha,dbFile:path.join(data,'bridge.db')};
}

test('built-in HTTP replacement cannot replay or claim an old approval',{timeout:30000},async t=>{
  const f=await fixture(t),id='req_http_replace';await f.submit(id);
  await f.submit('req_http_queued_a');
  const args={request_id:id,claimant:'run',acquisition_id:'acq'};
  const a=await f.rpc(f.a,'claim',args);assert.ok(a.claim_id,JSON.stringify(a));
  assert.equal((await f.rpc(f.a,'claim',args)).claim_id,a.claim_id);
  const b=f.connect('B','dot',true);
  assert.match((await f.rpc(b,'claim',args)).error,/destination_changed/);
  assert.match((await f.rpc(b,'claim',{...args,request_id:'req_http_queued_a'})).error,/destination_changed/);
  assert.equal((await f.rpc(f.a,'claim',args)).error,'HTTP 401');
  await f.submit('req_http_fresh_b');
  assert.ok((await f.rpc(b,'claim',{...args,request_id:'req_http_fresh_b'})).claim_id);
});

test('built-in revoke during awaited claim quiesce prevents a successor grant',{timeout:30000},async t=>{
  const f=await fixture(t),id='req_http_revoke_claim';await f.submit(id);
  const args={request_id:id,claimant:'run',acquisition_id:'acq'};
  assert.ok((await f.rpc(f.a,'claim',args)).claim_id);
  const db=new DatabaseSync(f.dbFile);db.exec('PRAGMA busy_timeout=5000');t.after(()=>db.close());
  db.prepare("UPDATE claims SET last_claim_activity_at='2000-01-01T00:00:00.000Z',lease_deadline_at='2000-01-01T00:00:00.000Z',lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?").run(id);
  const before=db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
  const gate=once(f.child,'message');
  const receipts=db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id);
  const events=db.prepare('SELECT * FROM protocol_events WHERE request_id=?').all(id);
  const claiming=f.rpc(f.a,'claim',{...args,claimant:'successor',acquisition_id:'next'});
  const [msg]=await gate;assert.equal(msg.barrier,id);
  f.auth.revokeGrant(f.a.grantId,'fixture');f.child.send({continue:true});
  assert.match((await claiming).error,/connection_not_live/);
  const after=db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
  assert.deepEqual(db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id),receipts);
  assert.deepEqual(db.prepare('SELECT * FROM protocol_events WHERE request_id=?').all(id),events);
  for(const key of ['claim_id','epoch','claimed_at','last_claim_activity_at','claimant'])assert.equal(after[key],before[key],key);
  // The lease is expired on purpose, so the maintenance sweep may abandon and requeue it while the successor waits at the
  // barrier. Either outcome is safe; what must not happen is a successor claim.
  if(after.state!==before.state){assert.equal(after.state,'abandoned');assert.match(after.abandon_reason,/^lease_expired/);}
});

for(const native of [false,true]) test('built-in revoke during awaited PR preflight refuses '+(native?'native':'legacy')+' fresh claim',{timeout:30000},async t=>{
  const f=await fixture(t,{native}),id='req_http_preflight';
  await f.submit(id,{inputs:[{github_repo:'acme/project',pr_number:7,base_sha:f.sha,head_sha:f.sha}],
    scope_paths:['README.md'],prepared_at:new Date(Date.now()-1000).toISOString(),valid_until:new Date(Date.now()+3600000).toISOString()});
  const armed=once(f.child,'message');f.child.send({armPreflight:true});assert.deepEqual((await armed)[0],{armed:true});
  const barrier=once(f.child,'message');
  const claiming=f.rpc(f.a,'claim',{request_id:id,claimant:'run',acquisition_id:'acq',...(native?{command_key:'claim',expected_revision:1}:{})});
  assert.deepEqual((await barrier)[0],{preflight:true});
  f.auth.revokeGrant(f.a.grantId,'fixture');f.child.send({continue:true});
  assert.match((await claiming).error,/connection_not_live/);
  const db=new DatabaseSync(f.dbFile,{readOnly:true});
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM claims WHERE request_id=?').get(id).n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM claim_command_receipts WHERE job=?').get(id).n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM protocol_events WHERE request_id=? AND event_type='claimed'").get(id).n,0);
  } finally {db.close();}
});
