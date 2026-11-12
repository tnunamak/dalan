import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('fixture.invalid');
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {seedWorkerRepos,parseWorkers,loadOwnerWorkers,readWorkerRepoHistory,updateWorkerRepoPolicy,workerRepoMigrationFile} from '../src/workers.mjs';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(home,settings) {
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env:{HOME:home,PATH:process.env.PATH,DALAN_PORT:'0',...settings},stdio:['ignore','pipe','pipe']});
 let out='',error='',port;child.stdout.on('data',b=>{out+=b;port=Number(/MCP listening on [^\n]+:(\d+)/.exec(out)?.[1]);});child.stderr.on('data',b=>error+=b);
 for(let n=0;n<200&&!port&&child.exitCode===null;n++)await sleep(25);
 if(!port){child.kill('SIGTERM');throw new Error('fixture startup failed: '+error);}
 return {child,port,get stderr(){return error;},stop:()=>new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');})};
}
const assignment=(id,repo,sha)=>({schema_version:1,request_id:id,brief:'Read the fixture repository',inputs:[{github_repo:repo,base_sha:sha}],scope_paths:['README.md'],execution_scope:'read-only',expected_output:'one sentence'});
function history(store,worker,sha) {
 for(const [n,repo] of ['acme/one','acme/two'].entries()) store.submit(assignment(`req_history_${worker}_${n}`,repo,sha),{mode:'none'},null,'fixture-owner',false,null,'normal',null,undefined,null,worker,'none');
 // Another worker's history must never enter this worker's seed.
 store.submit(assignment('req_history_other','acme/third',sha),{mode:'none'},null,'fixture-owner',false,null,'normal',null,undefined,null,'other','none');
}

// The seed counts only jobs a worker claimed, so the upgrade fixtures also hold claimed jobs that later finished.
const known=(dbFile,...workers)=>new Store(dbFile,{workers:parseWorkers({workers:Object.fromEntries(workers.map(worker=>[worker,{}]))},{builtin:true})});
function worked(store,worker,sha) {
 for(const [n,repo] of ['acme/one','acme/two'].entries()) {
  const id=`req_worked_${worker}_${n}`;
  store.submit(assignment(id,repo,sha),{mode:'none'},null,'fixture-owner',false,null,'normal',null,undefined,null,worker,'none');
  store.claim(id,`${worker}-claimant`,'local-principal',4,null,worker);store.cancel(id,'fixture');
 }
}

test('old worker and omitted worker lists seed once; admissions retain only their own historical repositories',{timeout:60000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-history-upgrade-'));
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'fixture',use:'sig'};
 const issuerServer=http.createServer((req,res)=>res.end(JSON.stringify({keys:[jwk]})));
 let service;
 try {
  await new Promise(resolve=>issuerServer.listen(0,'127.0.0.1',resolve));
  const issuer=`http://127.0.0.1:${issuerServer.address().port}/realm`,audience='https://fixture.invalid/mcp';
  const fixture=path.join(root,'repository');fs.mkdirSync(fixture);
  const git=(...args)=>{const result=spawnSync('git',['-C',fixture,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');fs.writeFileSync(path.join(fixture,'README.md'),'fixture\n');git('add','.');git('commit','-qm','fixture');const sha=git('rev-parse','HEAD');
  for(const worker of ['dot','worker-a','worker-b','worker-c']) {
   const home=path.join(root,worker),config=path.join(home,'.config/dot-bridge'),data=path.join(home,'.local/share/dot-bridge'),workersFile=path.join(config,'workers.json');
   fs.mkdirSync(config,{recursive:true,mode:0o700});fs.mkdirSync(data,{recursive:true});
   const dbFile=path.join(data,'bridge.db');let store=known(dbFile,worker);history(store,worker,sha);worked(store,worker,sha);store.db.close();
   if(worker!=='dot')fs.writeFileSync(workersFile,JSON.stringify({workers:{[worker]:{connections:[{issuer,subject:'fixture',client_id:'fixture-client'}],capabilities:['t3']}}}),{mode:0o600});
   fs.writeFileSync(path.join(config,'oauth.env'),`OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=http://127.0.0.1:${issuerServer.address().port}/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture\n`,{mode:0o600});
   const settings={DALAN_AUTH_MODE:'oauth',DALAN_TEST_OAUTH:'1',NODE_ENV:'test',DALAN_GITHUB_URL_ACME_ONE:fixture,DALAN_GITHUB_URL_ACME_TWO:fixture};
   const cli=(args,extra={})=>spawnSync(process.execPath,['bin/dalan.mjs',...args],{cwd:repo,env:{HOME:home,PATH:process.env.PATH,...settings,...extra},encoding:'utf8'});
   if(worker==='dot') {const absent=cli(['worker','allow','dot','acme/one','--json']);assert.notEqual(absent.status,0);assert.match(absent.stderr,/no workers.json/);assert.match(absent.stderr,/operations.md#legacy-repository-policy-migration/);assert.doesNotMatch(absent.stderr,/ENOENT|lstat/);const migrated=cli(['worker','migrate-repos','--json']);assert.equal(migrated.status,0,migrated.stderr);const named=JSON.parse(migrated.stdout);assert.equal(named.database,path.join(data,'bridge.db'));assert.equal(named.workers_file,workersFile);}
   service=await start(home,settings);
   const policy=loadOwnerWorkers(workersFile);assert.deepEqual(policy.repoPolicy(worker).repos,['acme/one','acme/two']);assert(!policy.allowsRepo(worker,'acme/third'));
   if(worker==='dot')assert(!fs.existsSync(workersFile),'migration invented a connection profile');
   else assert.deepEqual(JSON.parse(fs.readFileSync(workersFile)).workers[worker].repos,['acme/one','acme/two']);
   const auditFile=path.join(config,'workers-audit.jsonl'),events=readWorkerRepoHistory(auditFile).events;
   assert.equal(events.length,1);assert.equal(events[0].worker,worker);assert.deepEqual(events[0].before,{mode:'legacy-any',repos:null});assert.deepEqual(events[0].after,{mode:'exact',repos:['acme/one','acme/two']});
   const doctor=cli(['doctor','--json']);assert.equal(doctor.status,0,doctor.stderr);const view=JSON.parse(doctor.stdout);
   assert.deepEqual(view.repository_access.workers[0].repos,['acme/one','acme/two']);assert.equal(view.repository_access.changes.length,1);
   assert.match(view.t3.warnings.join(' '),/DALAN_ENABLE_T3_TOOLS=1/);
   for(const enabled of [{DALAN_ENABLE_T3_TOOLS:'1'},{DOT_BRIDGE_ENABLE_T3_TOOLS:'1'}]) {const ready=cli(['doctor','--json'],enabled);assert.equal(ready.status,0,ready.stderr);assert.deepEqual(JSON.parse(ready.stdout).t3.warnings,[]);}
   const submit=job=>new Promise((resolve,reject)=>{const request=http.request({socketPath:path.join(data,'admin.sock'),path:'/submit',method:'POST',headers:{'content-type':'application/json'}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});request.on('error',reject);request.end(JSON.stringify({assignment:job,owner_token:'fixture-owner',delivery:'none',execution:'none',worker}));});
   for(const [n,name] of ['acme/one','acme/two','acme/third'].entries()) {
    const response=await submit(assignment(`req_after_${worker}_${n}`,name,sha));assert.equal(response.status,n===2?400:200,JSON.stringify(response));
    if(n===2) {assert.match(response.body.error,/not allowed/);assert.match(response.body.error,/dalan worker allow/);if(worker==='dot')assert.match(response.body.error,/operations.md#legacy-repository-policy-migration/);}
   }
   const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url'),body=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub:'fixture',azp:'fixture-client',exp:Math.floor(Date.now()/1000)+600,scope:'dot-bridge.read dot-bridge.work'})).toString('base64url');
   const token=header+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+body),privateKey).toString('base64url');
   const secret=/BRIDGE_PATH_SECRET=(.+)/.exec(fs.readFileSync(path.join(config,'env'),'utf8'))[1];
   const claimed=await(await fetch(`http://127.0.0.1:${service.port}/${secret}/mcp`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'claim',arguments:{request_id:`req_history_${worker}_0`,claimant:'fixture'}}})})).json();assert.equal(claimed.result?.isError,false,JSON.stringify(claimed));
   await service.stop();service=null;
   const before=fs.readFileSync(workerRepoMigrationFile(workersFile),'utf8');
   store=new Store(dbFile);store.submit(assignment(`req_later_${worker}`,'acme/later',sha),{mode:'none'},null,'fixture-owner',false,null,'normal',null,undefined,null,worker,'none');store.db.close();
   service=await start(home,settings);assert.equal(fs.readFileSync(workerRepoMigrationFile(workersFile),'utf8'),before,'restart reseeded history or audit');assert(!loadOwnerWorkers(workersFile).allowsRepo(worker,'acme/later'));assert.equal(readWorkerRepoHistory(auditFile).events.length,1);
   await service.stop();service=null;
   if(worker==='dot') {updateWorkerRepoPolicy(workersFile,'dot','deny','acme/one');assert(!loadOwnerWorkers(workersFile).allowsRepo('dot','acme/one'));assert.equal(readWorkerRepoHistory(auditFile).events.length,2);const grant=cli(['worker','allow','dot','acme/manual','--json']);assert.equal(grant.status,0,grant.stderr);assert(loadOwnerWorkers(workersFile).allowsRepo('dot','acme/manual'));service=await start(home,settings);assert(!loadOwnerWorkers(workersFile).allowsRepo('dot','acme/one'));assert(loadOwnerWorkers(workersFile).allowsRepo('dot','acme/manual'));assert.equal(readWorkerRepoHistory(auditFile).events.length,3);await service.stop();service=null;}
  }
 } finally {if(service)await service.stop();await new Promise(resolve=>issuerServer.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});

test('fresh policy stays empty; explicit lists win; an interrupted profile publication reuses its original seed',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-seed-restart-'));
 try {
  const file=path.join(root,'workers.json');fs.writeFileSync(file,JSON.stringify({workers:{'worker-a':{}}}),{mode:0o600});
  const store=known(path.join(root,'bridge.db'),'worker-a');history(store,'worker-a','a'.repeat(40));worked(store,'worker-a','a'.repeat(40));
  seedWorkerRepos(file,store.db,{existingInstall:false});assert.deepEqual(loadOwnerWorkers(file).repoPolicy('worker-a').repos,[]);
  assert.equal(readWorkerRepoHistory(path.join(root,'workers-audit.jsonl')).events.length,0);
  fs.rmSync(workerRepoMigrationFile(file));
  seedWorkerRepos(file,store.db);const journal=JSON.parse(fs.readFileSync(workerRepoMigrationFile(file)));journal.entries[0].complete=false;fs.writeFileSync(workerRepoMigrationFile(file),JSON.stringify(journal));
  fs.writeFileSync(file,JSON.stringify({workers:{'worker-a':{repos:[]}}}),{mode:0o600});
  seedWorkerRepos(file,store.db);assert.deepEqual(loadOwnerWorkers(file).repoPolicy('worker-a').repos,[],'retry overwrote explicit owner policy');
  assert.equal(readWorkerRepoHistory(path.join(root,'workers-audit.jsonl')).events.length,1);
  store.db.close();
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('the seed includes live queued jobs, including destination-blocked work, and records queued job IDs',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-seed-evidence-'));
 try {
  const file=path.join(root,'workers.json');fs.writeFileSync(file,JSON.stringify({workers:{'worker-a':{}}}),{mode:0o600});
  const store=new Store(path.join(root,'bridge.db'),{workers:parseWorkers({workers:{'worker-a':{}}},{builtin:true})}),sha='a'.repeat(40);
  const submit=(id,repo)=>store.submit(assignment(id,repo,sha),{mode:'none'},null,'owner',false,null,'normal',null,undefined,null,'worker-a','none');
  submit('req_seed_claimed','acme/claimed');submit('req_seed_queued','acme/queued');submit('req_seed_expired','acme/expired');submit('req_seed_cancelled','acme/cancelled');submit('req_seed_claimed_cancelled','acme/worked');
  store.db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?').run(new Date(Date.now()+60000).toISOString(),'req_seed_queued');
  store.db.prepare('INSERT INTO destination_blocks(request_id,body) VALUES(?,?)').run('req_seed_queued',JSON.stringify({error:'destination_changed'}));
  store.db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?').run(new Date(Date.now()-60000).toISOString(),'req_seed_expired');
  store.claim('req_seed_claimed','worker-a-claimant','local-principal',4,null,'worker-a');
  store.claim('req_seed_claimed_cancelled','worker-a-claimant','local-principal',4,null,'worker-a');store.cancel('req_seed_claimed_cancelled','fixture');
  store.cancel('req_seed_cancelled','fixture');
  const migration=seedWorkerRepos(file,store.db);store.db.close();
  const profile=loadOwnerWorkers(file);
  assert.deepEqual(profile.repoPolicy('worker-a').repos,['acme/claimed','acme/queued','acme/worked']);
  assert.equal(profile.allowsRepo('worker-a','acme/new'),false);
  assert.equal(readWorkerRepoHistory(path.join(root,'workers-audit.jsonl')).events.length,1);
  assert.deepEqual(migration.workers[0].seeded_repositories,[
    {repo:'acme/claimed',queued_request_ids:[]},
    {repo:'acme/queued',queued_request_ids:['req_seed_queued']},
    {repo:'acme/worked',queued_request_ids:[]}
  ],
    'the migration report identifies each queued job behind a seeded repository, including blocked destinations');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('repository migration evaluates every worker against one injected instant at lease boundaries',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-seed-fixed-time-'));
 try {
  const file=path.join(root,'workers.json'),fixed='2024-05-06T07:08:09.000Z';
  fs.writeFileSync(file,JSON.stringify({workers:{'worker-a':{},'worker-b':{}}}),{mode:0o600});
  const store=known(path.join(root,'bridge.db'),'worker-a','worker-b');
  const submit=(id,worker,repo)=>store.submit(assignment(id,repo,'a'.repeat(40)),{mode:'none'},null,'owner',false,null,'normal',null,undefined,null,worker,'none');
  submit('req_null','worker-a','boundary/null');
  submit('req_equal','worker-a','boundary/equal');
  submit('req_past','worker-a','boundary/past');
  submit('req_future','worker-a','boundary/future');
  submit('req_expired_claimed','worker-a','boundary/expired-claimed');
  submit('req_second_worker','worker-b','boundary/second-worker');
  store.db.prepare('UPDATE assignments SET valid_until=NULL WHERE request_id=?').run('req_null');
  for(const [id,time,source] of [
   ['req_equal',fixed,'owner'],['req_past','2024-05-06T07:08:08.999Z','owner'],
   ['req_future','2024-05-06T07:08:09.001Z','owner'],['req_second_worker','2024-05-06T07:08:09.001Z','owner']
  ])store.db.prepare('UPDATE assignments SET valid_until=?,valid_until_source=? WHERE request_id=?').run(time,source,id);
  store.claim('req_expired_claimed','old-claimant','local-principal',4,null,'worker-a');
  store.db.prepare("UPDATE assignments SET status='queued',valid_until=?,valid_until_source='queue_p90' WHERE request_id=?")
   .run('2024-05-06T07:08:08.999Z','req_expired_claimed');
  assert.equal(store.get('req_past').status,'queued','the expiry sweep has not changed the expired row before migration');
  assert.equal(store.get('req_expired_claimed').status,'queued','the prior claim remains on an expired queued row');
  const migration=seedWorkerRepos(file,store.db,{migrationNow:fixed});store.db.close();
  assert.deepEqual(migration.workers.find(row=>row.worker==='worker-a').repos,
   ['boundary/expired-claimed','boundary/future','boundary/null']);
  assert.deepEqual(migration.workers.find(row=>row.worker==='worker-b').repos,
   ['boundary/second-worker'],'later workers use the exact same migration instant');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('one shared worker profile seeds disjoint histories and one audit for each worker',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-shared-worker-history-'));
 try {
  const file=path.join(root,'workers.json');fs.writeFileSync(file,JSON.stringify({workers:{'worker-b':{},'worker-c':{}}}),{mode:0o600});
  const store=known(path.join(root,'bridge.db'),'worker-b','worker-c');
  history(store,'worker-b','a'.repeat(40));worked(store,'worker-b','a'.repeat(40));
  store.submit(assignment('req_history_worker_c','acme/third','a'.repeat(40)),{mode:'none'},null,'owner',false,null,'normal',null,undefined,null,'worker-c','none');
  store.claim('req_history_worker_c','worker-c-claimant','local-principal',4,null,'worker-c');store.cancel('req_history_worker_c','fixture');
  seedWorkerRepos(file,store.db);store.db.close();
  const profile=loadOwnerWorkers(file);
  assert.deepEqual(profile.repoPolicy('worker-b').repos,['acme/one','acme/two']);assert.deepEqual(profile.repoPolicy('worker-c').repos,['acme/third']);
  assert(!profile.allowsRepo('worker-b','acme/third'));assert(!profile.allowsRepo('worker-c','acme/one'));
  assert.equal(readWorkerRepoHistory(path.join(root,'workers-audit.jsonl')).events.length,2);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('startup logs one empty-policy count per worker, including queued repository jobs',{timeout:10000},async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-empty-policy-'));let service;
 try {
  const config=path.join(home,'.config/dot-bridge'),data=path.join(home,'.local/share/dot-bridge');fs.mkdirSync(config,{recursive:true,mode:0o700});fs.mkdirSync(data,{recursive:true});
  const connection={issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'};
  fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({workers:{dot:{repos:[],connections:[connection]},idle:{connections:[connection]}}}),{mode:0o600});
  const store=new Store(path.join(data,'bridge.db'));history(store,'dot','a'.repeat(40));store.db.close();
  const doctor=spawnSync(process.execPath,['bin/dalan.mjs','doctor','--json'],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});assert.equal(doctor.status,0,doctor.stderr);
  const warningsBefore=JSON.parse(doctor.stdout).repository_access.warnings;assert.equal(warningsBefore.length,2);for(const worker of ['dot','idle'])assert(warningsBefore.some(message=>message.includes('"'+worker+'"')&&message.includes('denied')),'doctor did not warn for '+worker);
  service=await start(home,{DALAN_DEV_ALLOW_UNAUTHENTICATED:'1',DALAN_BIND_HOST:'127.0.0.1'});
  for(let n=0;n<50&&!service.stderr.includes('repository_policy_empty');n++)await sleep(5);
  const warnings=service.stderr.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse).filter(row=>row.kind==='repository_policy_empty');
  assert.deepEqual(warnings,[{kind:'repository_policy_empty',worker:'dot',queued_repo_jobs_blocked:2},{kind:'repository_policy_empty',worker:'idle',queued_repo_jobs_blocked:0}]);
  const logged=fs.readFileSync(path.join(home,'.local/state/dot-bridge/requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.kind==='repository_policy_empty');assert.equal(logged.length,2);
 } finally {if(service)await service.stop();fs.rmSync(home,{recursive:true,force:true});}
});
