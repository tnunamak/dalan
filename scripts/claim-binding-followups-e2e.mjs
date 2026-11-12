// Built-in HTTP tests for claim-binding follow-ups: configuration errors never reach a worker, a replacement
// connection cannot recover a grant for a worker with no destination block, and an exact retry by the granting
// connection is not re-admitted against current policy. Each test drives the real server over MCP HTTP.
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
import {randomUUID,createHash} from 'node:crypto';
import {AsStore} from '../src/as-store.mjs';
import {fullSnapshot,fileSnapshot,changedColumns} from '../src/test-support/full-snapshot.mjs';

const code=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'claim-binding-http-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const declaration=(provider='Fixture')=>({operator:'Fixture',provider,data_categories:['assignment','results'],retention:'30 days',training:'none',terms:'v1'});
const REPO='acme/project';
const protocol=()=>({profile:'job-v0',source:'fixture',scope:'fixture',policy:'fixture',destination:'fixture',retain_until_ms:Date.now()+3600000});
// A repository job pins a pull request, as the existing built-in admission fixtures do; sha is the fixture repository head.
const assignment=(id,{repo=false,native=false,sha=null,implementation=false}={})=>({schema_version:1,request_id:id,brief:'claim binding fixture',
  inputs:repo?[{github_repo:REPO,pr_number:7,base_sha:sha,head_sha:sha}]:[],expected_output:'report',execution_scope:implementation?'implementation':'read-only',
  ...(implementation?{output_paths:['out.txt']}:{}),
  ...(repo?{scope_paths:['README.md'],prepared_at:new Date(Date.now()-1000).toISOString(),valid_until:new Date(Date.now()+3600000).toISOString()}:{}),
  ...(native?{protocol:protocol()}:{})});

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
// workers: the workers.json object written at 0600, or null for a legacy profile with no file.
async function fixture(t,{workers,native=false}) {
  const home=fs.mkdtempSync(path.join(root,'http-')),config=path.join(home,'.config/dalan'),data=path.join(home,'.local/share/dalan');
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const repository=path.join(home,'repository');fs.mkdirSync(repository);
  const git=args=>execFileSync('git',args,{encoding:'utf8',cwd:repository}).trim();
  git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(repository,'README.md'),'fixture');git(['add','README.md']);git(['commit','-qm','fixture']);
  const sha=git(['rev-parse','HEAD']);
  // The only remote call a claim makes for a pinned pull request is the GitHub API read; answer it locally.
  const stub=path.join(home,'gh-stub.mjs');
  fs.writeFileSync(stub,`import childProcess from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const iterate=http.IncomingMessage.prototype[Symbol.asyncIterator];
http.IncomingMessage.prototype[Symbol.asyncIterator]=function(...args){
  // The MCP handler starts readBody only after verifyBearer and resolveWorker.
  if(this.headers['x-claim-body-barrier']==='1'&&this.url?.endsWith('/mcp'))
    fs.writeFileSync(process.env.TEST_CLAIM_BODY_READY,'authenticated');
  return iterate.apply(this,args);
};
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
const originalParse=JSON.parse;
JSON.parse=(text,...args)=>{
  if(typeof text==='string'&&text.includes('NESTED_CONFIG_CAUSE_FIXTURE'))throw new Error('configuration wrapper',{cause:new Error('NESTED_PRIVATE_CAUSE')});
  if(typeof text==='string'&&text.includes('CYCLIC_CONFIG_FIXTURE')){
    const error=new Error('cyclic configuration wrapper');error.self=error;error.cause=new Error('inner',{cause:error});
    error.blob='B'.repeat(300000);error.list=Array.from({length:500},(_, i)=>'item'+i);
    let deep={level:0};const top=deep;for(let i=1;i<40;i++){deep.next={level:i};deep=deep.next;}error.deep=top;
    throw error;
  }
  return originalParse(text,...args);
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
    DALAN_GITHUB_URL_ACME_PROJECT:repository,TEST_CLAIM_SHA:sha,TEST_CLAIM_BODY_READY:path.join(home,'body-ready'),...(native?{DALAN_CATALOG_PROFILE:'protocol-v0'}:{})});
  fs.mkdirSync(config,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(config,'limits.json'),JSON.stringify({max_claimed_outer_assignments:6}),{mode:0o600});
  const workersFile=path.join(config,'workers.json');
  const writeWorkers=(value,mode=0o600)=>{fs.writeFileSync(workersFile,typeof value==='string'?value:JSON.stringify(value),{mode});fs.chmodSync(workersFile,mode);};
  if(workers)writeWorkers(workers);
  else { fs.mkdirSync(path.join(home,'.local/share/dalan'),{recursive:true});{const fixture=new DatabaseSync(path.join(home,'.local/share/dalan/bridge.db'));fixture.exec('PRAGMA user_version=1');fixture.close();} } // an install that predates workers.json already has a database
  execFileSync(process.execPath,['bin/dalan.mjs','as-init','--public-url',`http://127.0.0.1:${port}`],{cwd:code,env,stdio:'pipe'});
  let child=null,stdout='',stderr='',auth;
  async function stop() {
    if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}
  }
  async function start(extraEnv={}) {
    stdout='';stderr='';
    child=spawn(process.execPath,['--import',stub,'src/server.mjs'],{cwd:code,env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    for(let i=0;i<400&&!stdout.includes('MCP listening on')&&child.exitCode===null;i++)await delay(25);
    assert.match(stdout,/MCP listening on/,stderr);
  }
  await start();
  t.after(async()=>{await stop();auth?.close();fs.rmSync(home,{recursive:true,force:true});});
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
    const b=await r.json();if(b.error)return {error:JSON.stringify(b.error)};if(b.result?.isError)return {error:b.result.content[0].text};return JSON.parse(b.result.content[0].text);
  }
  async function heldRpc(c,name,args) {
    const marker=path.join(home,'body-ready');fs.rmSync(marker,{force:true});
    const body=JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}});
    let req;
    const result=new Promise((resolve,reject)=>{
      req=http.request(resource,{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/json',
        'content-length':Buffer.byteLength(body),'x-claim-body-barrier':'1'}},res=>{
        let text='';res.on('data',b=>text+=b);res.on('end',()=>{
          try {resolve({status:res.statusCode,body:JSON.parse(text)});}catch(e){reject(e);}
        });
      });req.on('error',reject);req.write(body.slice(0,-1));
    });
    t.after(()=>req.destroy());
    // Avoid an unhandled rejection if setup fails before the caller completes the body.
    result.catch(()=>{});
    for(let i=0;i<400&&!fs.existsSync(marker);i++)await delay(10);
    assert.equal(fs.existsSync(marker),true,'request never reached the post-auth body barrier');
    return async()=>{req.end(body.slice(-1));return result;};
  }
  function mutationState(id) {
    const d=db();try {
      const all=(table,key='request_id')=>d.prepare('SELECT * FROM '+table+' WHERE '+key+'=?').all(id);
      return {claims:all('claims'),progress:all('progress'),reports:all('reports'),late:all('late_evidence'),
        revision:all('claim_command_revisions','job'),receipts:all('claim_command_receipts','job'),
        events:all('protocol_events'),notifications:all('notifications'),status:all('assignments')};
    }finally{d.close();}
  }
  // Owner submit through the admin socket. Returns the body so a test can also assert an owner-side refusal.
  async function submitRaw(id,opts={},destinationRevision) {
    const body={assignment:assignment(id,{native,sha,...opts}),worker:'dot',owner_token:'owner',delivery:'none',execution:'worker'};
    const preview=await admin('/submit-preview',body);
    if(preview.error||preview.verdict==='reject')return preview;
    const revision=destinationRevision??preview.destination_disclosure?.revision;
    return admin('/submit',{...body,...(revision?{destination_revision:revision}:{})});
  }
  async function submit(id,opts={}) {const result=await submitRaw(id,opts);assert.ok(!result.error&&result.verdict!=='reject',JSON.stringify(result));return result;}
  const claimArgs=(id,extra={})=>({request_id:id,claimant:'run',acquisition_id:'acq',...(native?{command_key:'claim-'+id,expected_revision:1}:{}),...extra});
  const db=()=>new DatabaseSync(path.join(data,'bridge.db'),{readOnly:true});
  // Everything a retry must leave alone: the grant, refusal blocks, notifications and native receipts. Activity
  // counters (tool_calls, last_tool_*) move on every call, successful or refused, and are not part of the grant.
  function state(id) {
    const d=db();
    try {
      const all=(sql)=>d.prepare(sql).all(id);
      return {claims:all('SELECT request_id,claimant,claim_id,claimed_at,subject,worker,epoch,state,acquisition_id,lease_ms,connection_id FROM claims WHERE request_id=?'),blocks:all('SELECT * FROM destination_blocks WHERE request_id=?'),
        notifications:all('SELECT * FROM notifications WHERE request_id=?'),receipts:d.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id),
        status:d.prepare('SELECT status FROM assignments WHERE request_id=?').get(id)?.status};
    } finally {d.close();}
  }
  // Every table row for the assignment plus its files on disk; see src/test-support/full-snapshot.mjs.
  function snapshot(id) {const d=db();try {return {tables:fullSnapshot(d,id),files:fileSnapshot(home,id)};}finally{d.close();}}
  function claimRow(id) {const d=db();try {return d.prepare('SELECT * FROM claims WHERE request_id=?').get(id);}finally{d.close();}}
  function revision(id) {const d=db();try {return d.prepare('SELECT revision FROM claim_command_revisions WHERE job=?').get(id)?.revision;}finally{d.close();}}
  // Owner-side calls go through the admin socket with the capability the fixture submits with.
  function ownerPost(route,body) {return new Promise((resolve,reject)=>{const req=http.request({socketPath:path.join(data,'admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json','x-owner-capability':'owner'}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve(JSON.parse(s)));});req.on('error',reject);req.end(JSON.stringify(body));});}
  return {auth,connect,submit,submitRaw,rpc,heldRpc,mutationState,snapshot,claimRow,revision,ownerPost,claimArgs,state,writeWorkers,workersFile,home,config,stop,start,getOutput:()=>stdout+stderr,logFile:path.join(home,'.local/state/dalan/requests.jsonl')};
}

const baseWorkers=(over={})=>({default_execution:'worker',workers:{dot:{destination:declaration(),repos:[REPO],workspaceAllowed:true,...over},other:{}}});
const noDestination=()=>({default_execution:'worker',workers:{dot:{repos:[REPO],workspaceAllowed:true},other:{}}});

// ---- Finding 1: configuration errors reach a worker only as the generic error ----------------------------------

const CANARY='PRIVATE_CONFIG_CANARY_7f3a';
// Mirrors Store.destinationConfigurationError: the only text a caller may receive for any configuration failure.
// A parse error gets 'invalid JSON configuration'; any other loader error gets 'configuration could not be loaded'.
const fixedConfigError=(requestId,cause='configuration could not be loaded')=>JSON.stringify({error:'destination_configuration_invalid',request_id:requestId,
  message:'Current destination configuration is unavailable or invalid; restore it before a new admission. Cause: '+cause});
for(const kind of ['invalid-json','invalid-shape','wrong-mode','deleted']) test('worker never sees raw workers.json errors on repository jobs: '+kind,{timeout:60000},async t=>{
  const f=await fixture(t,{workers:baseWorkers()});
  const a=f.connect('A');
  await f.submit('req_cfg_live',{repo:true,implementation:true});await f.submit('req_cfg_queued',{repo:true});
  // A live grant on an implementation job, so `get` reaches repository-policy metadata preparation.
  assert.ok((await f.rpc(a,'claim',f.claimArgs('req_cfg_live'))).claim_id);
  const bad={
    'invalid-json':()=>f.writeWorkers(`{"${CANARY}": not json`),
    'invalid-shape':()=>f.writeWorkers({[CANARY]:{unknown:true}}),
    'wrong-mode':()=>f.writeWorkers(baseWorkers(),0o644),
    'deleted':()=>fs.rmSync(f.workersFile),
  }[kind];
  bad();
  const before=f.state('req_cfg_queued');
  const attempts={
    'fresh claim':await f.rpc(a,'claim',f.claimArgs('req_cfg_queued')),
    'get of live grant':await f.rpc(a,'get',{request_id:'req_cfg_live'}),
  };
  const leak=new RegExp(CANARY+'|workers\\.json|'+f.home.replaceAll('.','\\.')+'|Unexpected token|not valid JSON|mode 0600|worker profile disappeared|EACCES|ENOENT');
  // Check every call site before failing, so one run names each site that leaks.
  const problems=Object.entries(attempts).flatMap(([label,result])=>{
    const text=result.error??JSON.stringify(result);
    if(!result.error)return [label+' must be refused: '+text];
    return [...(/destination_configuration_invalid/.test(text)?[]:[label+' lacks the generic configuration error: '+text]),
      ...(leak.test(text)?[label+' leaked configuration detail: '+text]:[])];
  });
  assert.deepEqual(problems,[]);
  assert.deepEqual(f.state('req_cfg_queued'),before,'refused claim changed state');
});

test('server log keeps the real configuration error that the worker never sees',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:baseWorkers()});
  const a=f.connect('A');
  await f.submit('req_cfg_log',{repo:true});
  f.writeWorkers(`{"${CANARY}": not json`);
  const result=await f.rpc(a,'claim',f.claimArgs('req_cfg_log'));
  assert.equal(result.error,fixedConfigError('req_cfg_log','invalid JSON configuration'));
  const log=fs.readFileSync(f.logFile,'utf8');
  assert.match(log,/destination_configuration_error/);
  assert.match(log,/SyntaxError/);
});

test('server log retains nested configuration causes without exposing them to workers',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:baseWorkers()});
  const a=f.connect('nested-log');
  await f.submit('req_nested_log',{repo:true});
  f.writeWorkers('{"NESTED_CONFIG_CAUSE_FIXTURE":true}');
  const result=await f.rpc(a,'claim',f.claimArgs('req_nested_log'));
  // The caller gets the complete fixed error, nothing more: not a prefix, and not the wrapper or its cause.
  assert.equal(result.error,fixedConfigError('req_nested_log'));
  const log=fs.readFileSync(f.logFile,'utf8');
  assert.match(log,/configuration wrapper/);
  assert.match(log,/NESTED_PRIVATE_CAUSE/);
});

test('server log bounds a cyclic configuration error with a huge attached string',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:baseWorkers()});
  const a=f.connect('cyclic-log');
  await f.submit('req_cyclic_log',{repo:true});
  f.writeWorkers('{"CYCLIC_CONFIG_FIXTURE":true}');
  const result=await f.rpc(a,'claim',f.claimArgs('req_cyclic_log'));
  assert.equal(result.error,fixedConfigError('req_cyclic_log'));
  const lines=fs.readFileSync(f.logFile,'utf8').split('\n').filter(l=>l.includes('destination_configuration_error'));
  assert.ok(lines.length>=1,'no configuration error was logged');
  for(const line of lines){
    const reason=JSON.parse(line).reason;
    assert.ok(line.length<20000,'log line is '+line.length+' bytes, not bounded');
    assert.match(reason,/cyclic configuration wrapper/);
    assert.match(reason,/\[Circular/);
    assert.match(reason,/more characters/);
    assert.match(reason,/more items/);
    assert.doesNotMatch(reason,/B{9000}/);
    assert.doesNotMatch(reason,/item60\b/);
    assert.doesNotMatch(reason,/level: 39/);
  }
});

// ---- Finding 1 / legacy: no workers.json is a legacy profile, not a configuration error -------------------------

test('legacy profile without workers.json keeps its own repository refusal through the real policy loader',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:null});
  const a=f.connect('A');
  assert.equal(fs.existsSync(f.workersFile),false);
  // A repository job is refused with the migration hint, not a configuration error.
  const refused=await f.submitRaw('req_legacy_repo',{repo:true});
  const text=JSON.stringify(refused);
  assert.match(text,/not allowed for worker \\"dot\\"/,text);
  assert.match(text,/no workers\.json/,text);
  assert.doesNotMatch(text,/destination_configuration_invalid/);
  // A job with no repository still claims through the same server.
  await f.submit('req_legacy_plain');
  const got=await f.rpc(a,'claim',f.claimArgs('req_legacy_plain'));
  assert.ok(got.claim_id,JSON.stringify(got));
  assert.equal((await f.rpc(a,'claim',f.claimArgs('req_legacy_plain'))).claim_id,got.claim_id);
});

test('legacy restart: a queued repository job gets the legacy refusal on claim, not a configuration error',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:baseWorkers()});
  const a=f.connect('A');
  await f.submit('req_legacy_restart',{repo:true});
  await f.stop();
  fs.rmSync(f.workersFile);
  await f.start({DALAN_LEGACY_PROFILE:'1'});
  const result=await f.rpc(a,'claim',f.claimArgs('req_legacy_restart'));
  assert.ok(result.error,JSON.stringify(result));
  assert.match(result.error,/not allowed for worker "dot"/);
  assert.match(result.error,/no workers\.json/);
  assert.doesNotMatch(result.error,/destination_configuration_invalid/);
});

// ---- Finding 2: a worker with no destination block is fenced to its granting connection -------------------------

for(const native of [false,true]) test('replacement connection cannot recover a grant for a worker with no destination ('+(native?'native receipt':'duplicate')+')',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:noDestination(),native});
  const a=f.connect('A'),id='req_undeclared_'+native;
  await f.submit(id);await f.submit(id+'_fresh');
  const first=await f.rpc(a,'claim',f.claimArgs(id));
  assert.ok(first.claim_id,JSON.stringify(first));
  assert.equal((await f.rpc(a,'claim',f.claimArgs(id))).claim_id,first.claim_id,'the granting connection still recovers its own grant');
  const grantedTo=f.state(id).claims[0].connection_id;
  assert.equal(grantedTo,a.connection_id,'the claim records the connection that was granted');
  const before=f.state(id);
  const b=f.connect('B','dot',true);
  const stolen=await f.rpc(b,'claim',f.claimArgs(id));
  assert.ok(stolen.error,'replacement connection recovered the old grant: '+JSON.stringify(stolen));
  assert.match(stolen.error,/destination_changed/);
  assert.doesNotMatch(stolen.error,new RegExp(first.claim_id));
  assert.deepEqual(f.state(id),before,'refusal changed state');
  assert.equal((await f.rpc(a,'claim',f.claimArgs(id))).error,'HTTP 401','the replaced connection is gone');
  // Control: B still claims fresh work, and that grant is bound to B.
  const fresh=await f.rpc(b,'claim',f.claimArgs(id+'_fresh'));
  assert.ok(fresh.claim_id,JSON.stringify(fresh));
  assert.equal(f.state(id+'_fresh').claims[0].connection_id,b.connection_id);
});

// ---- Finding 3: an exact retry by the granting connection is not a new admission --------------------------------

for(const native of [false,true]) test('same-connection retry survives allowlist and destination edits without writing a refusal ('+(native?'native receipt':'duplicate')+')',{timeout:90000},async t=>{
  const f=await fixture(t,{workers:baseWorkers(),native});
  const a=f.connect('A'),id='req_retry_edit_'+native;
  await f.submit(id,{repo:true});await f.submit(id+'_fresh',{repo:true});
  const first=await f.rpc(a,'claim',f.claimArgs(id));
  assert.ok(first.claim_id,JSON.stringify(first));
  const before=f.state(id);
  const edits={
    'allowlist removes the repository':()=>f.writeWorkers(baseWorkers({repos:['acme/other']})),
    'destination text changes':()=>f.writeWorkers(baseWorkers({destination:declaration('Provider B')})),
    'both change':()=>f.writeWorkers(baseWorkers({destination:declaration('Provider C'),repos:[]})),
  };
  for(const [label,edit] of Object.entries(edits)) {
    edit();
    const retry=await f.rpc(a,'claim',f.claimArgs(id));
    assert.equal(retry.claim_id,first.claim_id,label+': '+JSON.stringify(retry));
    assert.deepEqual(f.state(id),before,label+': the retry wrote state');
  }
  // Current policy still gates every new grant: the same edit refuses a fresh claim.
  const fresh=await f.rpc(a,'claim',f.claimArgs(id+'_fresh'));
  assert.ok(fresh.error,'a fresh claim must still obey current policy: '+JSON.stringify(fresh));
  assert.equal(f.state(id+'_fresh').claims.length,0);
});


// ---- Commit-time connection authority after authentication, while the HTTP body is held --------------------
const heldArgs=(operation,id,claim,native)=>({request_id:id,claim_id:claim.claim_id,
  ...(operation==='progress'?{note:'must not persist'}:operation==='renew_claim'?{lease_ms:60000}:
    {outcome:'completed',summary:'held',result:native?JSON.stringify({source:'fixture',policy:'fixture'}):'must not persist'}),
  ...(native?{command_key:'held-'+operation,expected_revision:claim.revision,...(operation==='finish'?{artifact_ids:[]}:{})}:{})});
for(const native of [false,true]) for(const operation of native?['progress','renew_claim','finish']:['progress','finish'])
test('control: held authenticated '+operation+' by the live holder succeeds ('+(native?'native':'legacy')+')',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:noDestination(),native}),a=f.connect('held-a');
  const id='req_control_'+operation+'_'+native;await f.submit(id);
  const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  const complete=await f.heldRpc(a,operation,heldArgs(operation,id,claim,native)),reply=await complete();
  assert.equal(reply.body.result?.isError,false,JSON.stringify(reply));
});
for(const native of [false,true]) for(const change of ['revoke','replace'])
for(const operation of native?['progress','renew_claim','finish']:['progress','finish'])
test('held authenticated '+operation+' refuses '+change+' ('+(native?'native':'legacy')+')',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:noDestination(),native}),a=f.connect('held-a');
  const id='req_commit_'+operation+'_'+change+'_'+native;await f.submit(id);
  const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  const args=heldArgs(operation,id,claim,native);
  const complete=await f.heldRpc(a,operation,args),before=f.mutationState(id);
  if(change==='revoke')f.auth.revokeGrant(a.grantId,'fixture');else f.connect('held-b','dot',true);
  const reply=await complete();
  assert.equal(reply.status,200,'must reach dispatch using the already authenticated principal');
  assert.equal(reply.body.result?.isError,true,JSON.stringify(reply));
  assert.match(reply.body.result.content[0].text,/connection_not_live/);
  assert.deepEqual(f.mutationState(id),before,'refusal changed claim/lease, revision, progress, report or receipt');
});


// ---- Complete fence: native upload, workspace tools, ask/consume and the get cursor -------------------------------
// Each refusal compares a full snapshot (every table row for the assignment, plus its files), not only the error.
async function heldChange(f,holder,change,name,args,id) {
  const complete=await f.heldRpc(holder,name,args),before=f.snapshot(id);
  if(change==='revoke')f.auth.revokeGrant(holder.grantId,'fixture');else f.connect('held-b','dot',true);
  const reply=await complete();
  return {reply,before,after:f.snapshot(id)};
}
function assertRefused({reply,before,after},label) {
  assert.equal(reply.status,200,label+': must reach dispatch using the already authenticated principal');
  assert.equal(reply.body.result?.isError,true,label+': '+JSON.stringify(reply));
  assert.match(reply.body.result.content[0].text,/connection_not_live/,label);
  assert.deepEqual(after,before,label+': the refusal changed state');
}
const uploadArgs=(id,claim,tag)=>{const bytes=Buffer.from('held upload '+tag);
  return {request_id:id,claim_id:claim.claim_id,artifact_id:'art_held_'+tag,offset:0,data_base64:bytes.toString('base64'),final:true,
    sha256:createHash('sha256').update(bytes).digest('hex'),command_key:'chunk-'+tag,expected_revision:claim.revision};};
const NEW_FILE_PATCH='diff --git a/out.txt b/out.txt\nnew file mode 100644\n--- /dev/null\n+++ b/out.txt\n@@ -0,0 +1 @@\n+held patch\n';
const workspaceArgs=(tool,id,claim)=>({request_id:id,claim_id:claim.claim_id,
  ...({list_files:{},read_file:{path:'README.md'},apply_patch:{patch:NEW_FILE_PATCH},run_check:{check_id:'default'},workspace_result:{}})[tool]});

test('control: held native artifact_chunk by the live holder seals the upload',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:noDestination(),native:true}),a=f.connect('held-a'),id='req_chunk_control';
  await f.submit(id);const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  const reply=await (await f.heldRpc(a,'artifact_chunk',uploadArgs(id,claim,'control')))();
  assert.equal(reply.body.result?.isError,false,JSON.stringify(reply));
  assert.equal(f.revision(id),claim.revision+1,'a sealed upload is a protocol command');
});
for(const change of ['revoke','replace']) test('held native artifact_chunk refuses '+change+' and changes nothing',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:noDestination(),native:true}),a=f.connect('held-a'),id='req_chunk_'+change;
  await f.submit(id);const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  const attempt=await heldChange(f,a,change,'artifact_chunk',uploadArgs(id,claim,change),id);
  assertRefused(attempt,'artifact_chunk');
  assert.equal(f.revision(id),claim.revision,'the protocol revision did not move');
  assert.deepEqual(attempt.after.tables.artifacts,[],'no artifact row');
});

test('held legacy artifact_chunk refuses revoke and changes nothing (legacy upload is fenced by the activity touch)',{timeout:60000},async t=>{
  const f=await fixture(t,{workers:noDestination()}),a=f.connect('held-a'),id='req_chunk_legacy';
  await f.submit(id);const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  const {command_key,expected_revision,...legacyArgs}=uploadArgs(id,claim,'legacy');
  const attempt=await heldChange(f,a,'revoke','artifact_chunk',legacyArgs,id);
  assertRefused(attempt,'legacy artifact_chunk');
  assert.deepEqual(attempt.after.tables.artifacts,[]);
});

const WORKSPACE_TOOLS=['list_files','read_file','apply_patch','run_check','workspace_result'];
for(const tool of WORKSPACE_TOOLS) test('control: held native '+tool+' by the live holder succeeds',{timeout:90000},async t=>{
  const f=await fixture(t,{workers:baseWorkers(),native:true}),a=f.connect('held-a'),id='req_ws_control_'+tool;
  await f.submit(id,{repo:true,implementation:true});const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  const reply=await (await f.heldRpc(a,tool,workspaceArgs(tool,id,claim)))();
  assert.equal(reply.body.result?.isError,false,JSON.stringify(reply));
});
for(const tool of WORKSPACE_TOOLS) for(const change of ['revoke','replace'])
test('held native '+tool+' refuses '+change+' and changes nothing (read-only tools included)',{timeout:90000},async t=>{
  const f=await fixture(t,{workers:baseWorkers(),native:true}),a=f.connect('held-a'),id='req_ws_'+tool+'_'+change;
  await f.submit(id,{repo:true,implementation:true});const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  // Create the worktree first, so a refused call that wrote to it would show in the file snapshot.
  assert.equal((await f.rpc(a,'list_files',{request_id:id,claim_id:claim.claim_id})).error,undefined);
  const attempt=await heldChange(f,a,change,tool,workspaceArgs(tool,id,claim),id);
  assertRefused(attempt,tool);
  assert.ok(Object.keys(attempt.after.files).length>0,'the snapshot covers the worktree files');
  assert.equal(f.revision(id),claim.revision,'the protocol revision did not move');
});
test('held legacy apply_patch refuses revoke and changes nothing (the fence is not native-only)',{timeout:90000},async t=>{
  const f=await fixture(t,{workers:baseWorkers()}),a=f.connect('held-a'),id='req_ws_legacy_patch';
  await f.submit(id,{repo:true,implementation:true});const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
  assert.equal((await f.rpc(a,'list_files',{request_id:id,claim_id:claim.claim_id})).error,undefined);
  assertRefused(await heldChange(f,a,'revoke','apply_patch',workspaceArgs('apply_patch',id,claim),id),'legacy apply_patch');
});

// Built-in HTTP ask and consume: the server must pass the authenticated connection (removing it fails the controls too).
const askArgs=(id,claim,native,tag)=>({request_id:id,claim_id:claim.claim_id,question_id:'Q_'+tag,text:'held question',
  ...(native?{command_key:'ask-'+tag,expected_revision:claim.revision}:{})});
// ask_question and consume_answer exist only in the protocol-v0 catalog, so the HTTP tests are native; the Store tests cover legacy.
for(const native of [true]) {
  const mode=native?'native':'legacy';
  test('control: held ask_question then consume_answer by the live holder succeed ('+mode+')',{timeout:60000},async t=>{
    const f=await fixture(t,{workers:noDestination(),native}),a=f.connect('held-a'),id='req_qa_control_'+mode;
    await f.submit(id);const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
    const asked=await (await f.heldRpc(a,'ask_question',askArgs(id,claim,native,'c')))();
    assert.equal(asked.body.result?.isError,false,JSON.stringify(asked));
    const answered=await f.ownerPost('/answer',{id,question_id:'Q_c',text:'because',...(native?{command_key:'answer-c',expected_revision:f.revision(id)}:{})});
    assert.ok(!answered.error,JSON.stringify(answered));
    const consumed=await (await f.heldRpc(a,'consume_answer',{request_id:id,claim_id:claim.claim_id,question_id:'Q_c',
      ...(native?{command_key:'consume-c',expected_revision:f.revision(id)}:{})}))();
    assert.equal(consumed.body.result?.isError,false,JSON.stringify(consumed));
    assert.match(consumed.body.result.content[0].text,/because/);
  });
  for(const change of ['revoke','replace']) {
    test('held ask_question refuses '+change+' and records nothing ('+mode+')',{timeout:60000},async t=>{
      const f=await fixture(t,{workers:noDestination(),native}),a=f.connect('held-a'),id='req_ask_'+change+'_'+mode;
      await f.submit(id);const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
      const attempt=await heldChange(f,a,change,'ask_question',askArgs(id,claim,native,'h'),id);
      assertRefused(attempt,'ask_question');
      assert.deepEqual(attempt.after.tables.job_questions,[]);
    });
    test('held consume_answer refuses '+change+', consumes nothing and does not leak the answer ('+mode+')',{timeout:60000},async t=>{
      const f=await fixture(t,{workers:noDestination(),native}),a=f.connect('held-a'),id='req_consume_'+change+'_'+mode;
      await f.submit(id);const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
      assert.ok((await f.rpc(a,'ask_question',askArgs(id,claim,native,'h'))).recorded);
      const answered=await f.ownerPost('/answer',{id,question_id:'Q_h',text:'SECRET_ANSWER_TEXT',...(native?{command_key:'answer-h',expected_revision:f.revision(id)}:{})});
      assert.ok(!answered.error,JSON.stringify(answered));
      const attempt=await heldChange(f,a,change,'consume_answer',{request_id:id,claim_id:claim.claim_id,question_id:'Q_h',
        ...(native?{command_key:'consume-h',expected_revision:f.revision(id)}:{})},id);
      assertRefused(attempt,'consume_answer');
      assert.doesNotMatch(JSON.stringify(attempt.reply),/SECRET_ANSWER_TEXT/);
      assert.equal(attempt.after.tables.job_questions[0].consumed_at,null);
    });
  }
}

// The get note-seen cursor: only the live holding connection moves it. Anyone else still reads, and nothing changes.
const CURSOR_ACTIVITY=['last_seen_note_seq','last_tool','last_tool_at','tool_calls'];
for(const native of [false,true]) {
  const mode=native?'native':'legacy';
  async function cursorFixture(t,tag) {
    const f=await fixture(t,{workers:noDestination(),native}),a=f.connect('cursor-a'),id='req_cursor_'+tag+'_'+mode;
    await f.submit(id);const claim=await f.rpc(a,'claim',f.claimArgs(id));assert.ok(claim.claim_id,JSON.stringify(claim));
    const note=await f.ownerPost('/note',{id,text:'owner note after the claim'});assert.ok(!note.error,JSON.stringify(note));
    assert.equal(f.claimRow(id).last_seen_note_seq,0,'the note is unseen');
    return {f,a,id,claim};
  }
  const assertReadOnly=(reply,before,after,label)=>{
    assert.equal(reply.body.result?.isError,false,label+': get still reads: '+JSON.stringify(reply));
    assert.match(reply.body.result.content[0].text,new RegExp('"request_id":"'+before.tables.assignments[0].request_id+'"'),label);
    assert.deepEqual(after,before,label+': get changed state');
    assert.equal(after.tables.claims[0].last_seen_note_seq,0,label+': cursor moved');
  };
  test('control: the granting connection get advances the note cursor ('+mode+')',{timeout:60000},async t=>{
    const {f,a,id}=await cursorFixture(t,'control'),before=f.snapshot(id);
    const got=await f.rpc(a,'get',{request_id:id});assert.equal(got.error,undefined,JSON.stringify(got));
    const after=f.snapshot(id);
    assert.equal(after.tables.claims[0].last_seen_note_seq,1);
    assert.deepEqual(changedColumns(before.tables.claims[0],after.tables.claims[0]).sort(),CURSOR_ACTIVITY);
    for(const table of Object.keys(before.tables).filter(x=>x!=='claims'))assert.deepEqual(after.tables[table],before.tables[table],table);
    assert.deepEqual(after.files,before.files);
  });
  for(const change of ['revoke','replace']) test('held get after '+change+' reads but leaves the note cursor and all state unchanged ('+mode+')',{timeout:60000},async t=>{
    const {f,a,id}=await cursorFixture(t,change),complete=await f.heldRpc(a,'get',{request_id:id}),before=f.snapshot(id);
    if(change==='revoke')f.auth.revokeGrant(a.grantId,'fixture');else f.connect('cursor-b','dot',true);
    const reply=await complete();
    assertReadOnly(reply,before,f.snapshot(id),'held get');
  });
  test('a different live connection (the replacement) get reads but does not move the old holder\'s cursor ('+mode+')',{timeout:60000},async t=>{
    const {f,id}=await cursorFixture(t,'other'),b=f.connect('cursor-b','dot',true),before=f.snapshot(id);
    assert.equal(f.claimRow(id).connection_id!==b.connection_id,true,'the claim stays bound to the replaced connection');
    const got=await f.rpc(b,'get',{request_id:id});assert.equal(got.error,undefined,JSON.stringify(got));
    assert.equal(got.request_id??got.assignment?.request_id,id);
    const after=f.snapshot(id);
    assert.deepEqual(after,before);assert.equal(after.tables.claims[0].last_seen_note_seq,0);
  });
  test('get with no claim advances nothing and creates no claim ('+mode+')',{timeout:60000},async t=>{
    const f=await fixture(t,{workers:noDestination(),native}),a=f.connect('cursor-a'),id='req_cursor_noclaim_'+mode;
    await f.submit(id);assert.ok(!(await f.ownerPost('/note',{id,text:'owner note'})).error);
    const before=f.snapshot(id);
    const got=await f.rpc(a,'get',{request_id:id});assert.equal(got.error,undefined,JSON.stringify(got));
    assert.deepEqual(f.snapshot(id),before);assert.deepEqual(f.snapshot(id).tables.claims,[]);
  });
}
