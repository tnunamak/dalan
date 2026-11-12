// Built-in HTTP tests for the connection fence across an await. A worker request is authenticated, then the server
// awaits (workspace.makeRoom) before it writes. The test holds that await on a file marker, revokes or replaces the
// holder's connection while it is held, then releases it. The refused call must report connection_not_live and
// leave every row and file of the assignment as it was when the call was paused (src/test-support/full-snapshot.mjs).
//
// The server child gets a preload that wraps Workspace.prototype.makeRoom. Arm it by creating <hold>; the next call
// renames <hold> to <hold>.entered and waits until <hold>.release exists.
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {AsStore} from '../src/as-store.mjs';
import {fullSnapshot,fileSnapshot} from '../src/test-support/full-snapshot.mjs';

const code=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'claim-fence-await-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const REPO='acme/project';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const declaration={operator:'Fixture',provider:'Fixture',data_categories:['assignment','results'],retention:'30 days',training:'none',terms:'v1'};
const assignment=(id,{native,sha})=>({schema_version:1,request_id:id,brief:'fence await fixture',
  inputs:[{github_repo:REPO,pr_number:7,base_sha:sha,head_sha:sha}],expected_output:'report',execution_scope:'implementation',output_paths:['out.txt'],
  scope_paths:['README.md'],prepared_at:new Date(Date.now()-1000).toISOString(),valid_until:new Date(Date.now()+3600000).toISOString(),
  ...(native?{protocol:{profile:'job-v0',source:'fixture',scope:'fixture',policy:'fixture',destination:'fixture',retain_until_ms:Date.now()+3600000}}:{})});

function approve(auth,name,replace,resource) {
  auth.closeWindow();const window=auth.openWindow('dot',10),client_id='client-'+name,grantId='grant-'+name;
  auth.admission.run(window.generation,()=>auth.upsert('Client',client_id,{client_id}));
  if(!auth.find('Grant',grantId))auth.upsert('Grant',grantId,{clientId:client_id},3600);
  const snapshot={client_id,client_name:name,redirect_uri:'https://fixture.invalid/callback',resource,scopes:'dot-bridge.read dot-bridge.work',interaction_expires_at:Date.now()+600000};
  const pairing=auth.pairingFor('interaction-'+name,snapshot,window);
  if(!auth.reserve(pairing.code))throw new Error('reserve failed');
  return {...auth.commitApproval({code:pairing.code,worker:'dot',grantId,snapshot,replace}),grantId,client_id};
}

async function fixture(t,{native=false}={}) {
  const home=fs.mkdtempSync(path.join(root,'http-')),config=path.join(home,'.config/dalan'),data=path.join(home,'.local/share/dalan');
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const repository=path.join(home,'repository');fs.mkdirSync(repository);
  const git=args=>execFileSync('git',args,{encoding:'utf8',cwd:repository}).trim();
  git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(repository,'README.md'),'fixture');git(['add','README.md']);git(['commit','-qm','fixture']);
  const sha=git(['rev-parse','HEAD']),hold=path.join(home,'makeroom-hold');
  const preload=path.join(home,'preload.mjs');
  fs.writeFileSync(preload,`import childProcess from 'node:child_process';
import fs from 'node:fs';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
import {Workspace} from ${JSON.stringify(path.join(code,'src/workspace.mjs'))};
const hold=process.env.TEST_MAKEROOM_HOLD,makeRoom=Workspace.prototype.makeRoom;
Workspace.prototype.makeRoom=async function(requestId) {
  if(fs.existsSync(hold)) {
    fs.renameSync(hold,hold+'.entered');
    while(!fs.existsSync(hold+'.release'))await new Promise(r=>setTimeout(r,5));
    fs.rmSync(hold+'.release');
  }
  return makeRoom.call(this,requestId);
};
const original=childProcess.execFile,run=promisify(original);
const fixtureExec=(...args)=>original(...args);
fixtureExec[promisify.custom]=async(file,args,options)=>{
  if(file!=='gh')return run(file,args,options);
  if(args.join(' ')!=='api --hostname github.com repos/acme/project/pulls/7')throw new Error('unexpected fixture command');
  return {stdout:JSON.stringify({state:'open',draft:false,merged:false,head:{sha:process.env.TEST_CLAIM_SHA}}),stderr:''};
};
childProcess.execFile=fixtureExec;syncBuiltinESMExports();
`);
  const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('DALAN_')||k.startsWith('DOT_BRIDGE_'))delete env[k];
  Object.assign(env,{HOME:home,NODE_ENV:'test',DALAN_LOOPBACK:'1',DALAN_AUTH_MODE:'builtin',DALAN_PORT:String(port),DALAN_ENABLE_WORKSPACE:'1',
    DALAN_GITHUB_URL_ACME_PROJECT:repository,TEST_CLAIM_SHA:sha,TEST_MAKEROOM_HOLD:hold,...(native?{DALAN_CATALOG_PROFILE:'protocol-v0'}:{})});
  fs.mkdirSync(config,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(config,'limits.json'),JSON.stringify({max_claimed_outer_assignments:6}),{mode:0o600});
  const workersFile=path.join(config,'workers.json');
  fs.writeFileSync(workersFile,JSON.stringify({default_execution:'worker',workers:{dot:{destination:declaration,repos:[REPO],workspaceAllowed:true},other:{}}}),{mode:0o600});
  execFileSync(process.execPath,['bin/dalan.mjs','as-init','--public-url',`http://127.0.0.1:${port}`],{cwd:code,env,stdio:'pipe'});
  let stdout='',stderr='',auth;
  const child=spawn(process.execPath,['--import',preload,'src/server.mjs'],{cwd:code,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  t.after(async()=>{if(child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}auth?.close();fs.rmSync(home,{recursive:true,force:true});});
  for(let i=0;i<400&&!stdout.includes('MCP listening on')&&child.exitCode===null;i++)await delay(25);
  assert.match(stdout,/MCP listening on/,stderr);
  const secret=fs.readFileSync(path.join(config,'env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1],resource=`http://127.0.0.1:${port}/${secret}/mcp`;
  auth=new AsStore(path.join(config,'as.sqlite'));
  function connect(name,replace=false) {
    const c=approve(auth,name,replace,resource),iat=Math.floor(Date.now()/1000),token=randomUUID().replaceAll('-','');
    auth.upsert('Grant',c.grantId,{jti:c.grantId,kind:'Grant',accountId:'owner',clientId:c.client_id,iat,exp:iat+3600},3600);
    auth.upsert('AccessToken',token,{jti:token,kind:'AccessToken',accountId:'owner',clientId:c.client_id,grantId:c.grantId,aud:resource,scope:'dot-bridge.read dot-bridge.work',iat,exp:iat+3600},3600);
    return {...c,token};
  }
  function admin(route,body) {return new Promise((resolve,reject)=>{const req=http.request({socketPath:path.join(data,'admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json'}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve(JSON.parse(s)));});req.on('error',reject);req.end(JSON.stringify(body));});}
  async function rpc(c,name,args={}) {
    const r=await fetch(resource,{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
    if(!r.ok)return {error:`HTTP ${r.status}`};
    const b=await r.json();if(b.error)return {error:JSON.stringify(b.error)};if(b.result?.isError)return {error:b.result.content[0].text};return JSON.parse(b.result.content[0].text);
  }
  async function submit(id) {
    const body={assignment:assignment(id,{native,sha}),worker:'dot',owner_token:'owner',delivery:'none',execution:'worker'};
    const preview=await admin('/submit-preview',body);
    assert.ok(!preview.error&&preview.verdict!=='reject',JSON.stringify(preview));
    const result=await admin('/submit',{...body,destination_revision:preview.destination_disclosure?.revision});
    assert.ok(!result.error&&result.verdict!=='reject',JSON.stringify(result));
  }
  const db=()=>new DatabaseSync(path.join(data,'bridge.db'),{readOnly:true});
  const snapshot=id=>{const d=db();try {return {tables:fullSnapshot(d,id),files:fileSnapshot(home,id)};}finally{d.close();}};
  // Pause the next makeRoom call at its await. `fire` starts the call and returns its pending result. `change` runs while the
  // call is paused; the snapshot is taken at that moment, after the dispatch-time activity touch, before `change`.
  async function held(fire,change,id) {
    fs.writeFileSync(hold,'');
    const pending=fire();pending.catch(()=>{});
    for(let i=0;i<800&&!fs.existsSync(hold+'.entered');i++)await delay(10);
    assert.equal(fs.existsSync(hold+'.entered'),true,'the call never reached makeRoom');
    const before=snapshot(id);
    change();
    fs.writeFileSync(hold+'.release','');
    const reply=await pending;
    return {reply,before,after:snapshot(id)};
  }
  const claimArgs=id=>({request_id:id,claimant:'run',acquisition_id:'acq',...(native?{command_key:'claim-'+id,expected_revision:1}:{})});
  return {connect,submit,rpc,snapshot,held,claimArgs,auth,native,
    row:(sql,...p)=>{const d=db();try {return d.prepare(sql).get(...p);}finally{d.close();}}};
}

// A claimed implementation job whose worktree already exists, so makeRoom returns at once in production and only the
// test's hold makes it yield.
async function claimed(f,id,{workspace=true}={}) {
  const a=f.connect('held-a');await f.submit(id);
  const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  if(workspace)assert.equal((await f.rpc(a,'list_files',{request_id:id,claim_id:claim.claim_id})).error,undefined);
  return {a,claim};
}
const finishArgs=(id,claim,native)=>({request_id:id,claim_id:claim.claim_id,outcome:'completed',summary:'held finish',
  result:native?JSON.stringify({source:'fixture',policy:'fixture'}):'held result',
  ...(native?{command_key:'finish-'+id,expected_revision:claim.revision,artifact_ids:[]}:{})});
const changer=(f,a,change)=>()=>{if(change==='revoke')f.auth.revokeGrant(a.grantId,'fixture');else f.connect('held-b',true);};
function assertRefused({reply,before,after},label) {
  assert.match(String(reply.error),/connection_not_live/,label+': '+JSON.stringify(reply));
  assert.deepEqual(after,before,label+': the refused call changed state');
}

for(const native of [false,true]) {
  const mode=native?'native':'legacy';
  test('control: finish by the live holder across a held makeRoom commits its patch artifact ('+mode+')',{timeout:90000},async t=>{
    const f=await fixture(t,{native}),id='req_finish_control_'+mode,{a,claim}=await claimed(f,id);
    const {reply,before,after}=await f.held(()=>f.rpc(a,'finish',finishArgs(id,claim,native)),()=>{},id);
    assert.ok(reply.receipt_id,JSON.stringify(reply));
    assert.equal(before.tables.artifacts.length,0);
    assert.ok(after.tables.artifacts.some(x=>x.kind==='patch'),'the patch artifact is committed with the report');
    assert.equal(after.tables.reports.length,1);
  });
  for(const change of ['revoke','replace'])
  test('finish refuses '+change+' during a held makeRoom and commits no artifact ('+mode+')',{timeout:90000},async t=>{
    const f=await fixture(t,{native}),id=`req_finish_${change}_${mode}`,{a,claim}=await claimed(f,id);
    const attempt=await f.held(()=>f.rpc(a,'finish',finishArgs(id,claim,native)),changer(f,a,change),id);
    assertRefused(attempt,'finish');
    assert.equal(attempt.after.tables.artifacts.length,0,'no artifact row');
    assert.equal(attempt.after.tables.reports.length,0,'no report');
    assert.ok(Object.keys(attempt.after.files).length>0,'the snapshot covers the worktree files');
  });
}

// A workspace tool awaits makeRoom (here a held one stands in for a statfs under disk pressure) before its fence.
for(const change of ['revoke','replace'])
test('legacy list_files refuses '+change+' during a held makeRoom and creates no worktree',{timeout:90000},async t=>{
  const f=await fixture(t),id='req_ws_'+change,{a,claim}=await claimed(f,id,{workspace:false});
  const attempt=await f.held(()=>f.rpc(a,'list_files',{request_id:id,claim_id:claim.claim_id}),changer(f,a,change),id);
  assertRefused(attempt,'list_files');
  assert.deepEqual(attempt.after.tables.workspaces,[],'no workspace row');
});
test('control: legacy list_files by the live holder across a held makeRoom creates the worktree',{timeout:90000},async t=>{
  const f=await fixture(t),id='req_ws_control',{a,claim}=await claimed(f,id,{workspace:false});
  const {reply,after}=await f.held(()=>f.rpc(a,'list_files',{request_id:id,claim_id:claim.claim_id}),()=>{},id);
  assert.equal(reply.error,undefined,JSON.stringify(reply));
  assert.equal(after.tables.workspaces.length,1);
});

// A replaced connection that knows the claim id gets the connection error, not an earlier question error.
test('native finish by a replaced connection reports connection_not_live before an unanswered-question error',{timeout:90000},async t=>{
  const f=await fixture(t,{native:true}),id='req_question_first',{a,claim}=await claimed(f,id);
  const ask=await f.rpc(a,'ask_question',{request_id:id,claim_id:claim.claim_id,question_id:'Q1',text:'open question',command_key:'ask-1',expected_revision:claim.revision});
  assert.equal(ask.error,undefined,JSON.stringify(ask));
  const b=f.connect('held-b',true),before=f.snapshot(id);
  const reply=await f.rpc(b,'finish',finishArgs(id,{...claim,revision:claim.revision+1},true));
  assert.match(String(reply.error),/connection_not_live/,JSON.stringify(reply));
  assert.deepEqual(f.snapshot(id),before);
});
