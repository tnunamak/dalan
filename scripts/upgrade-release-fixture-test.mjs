import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadOwnerWorkers,readWorkerRepoHistory,workerRepoMigrationFile} from '../src/workers.mjs';
import {skipCheck} from '../src/test-support/skipped-check.mjs';
import {prepublicSkip,readPrepublicFixture} from '../src/test-support/prepublic-fixtures.mjs';

const repo=path.resolve(new URL('..',import.meta.url).pathname);
// v0.3.0 is a pre-public release. Its source archive is kept outside the repository; see prepublic-fixtures.mjs.
const RELEASE_FIXTURE='test-fixtures/dalan-v0.3.0-release.tgz';
const inheritedEnv=()=>Object.fromEntries(['PATH','TMPDIR','LANG','NODE_OPTIONS'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
function fixtureEnv(home,port){
  const scratch=path.join(os.homedir(),'.tmp');fs.mkdirSync(scratch,{recursive:true});
  return {...inheritedEnv(),HOME:home,TMPDIR:scratch,
    DOT_BRIDGE_PORT:String(port),DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1'};
}
function makeTempRoot(temp= os.tmpdir()){fs.mkdirSync(temp,{recursive:true});return fs.mkdtempSync(path.join(temp,'dalan-v030-upgrade-'));}
async function withProcessEnv(env,fn){
  const before={...process.env};
  for(const key of Object.keys(process.env))delete process.env[key];
  Object.assign(process.env,env);
  try{return await fn();}finally{
    for(const key of Object.keys(process.env))delete process.env[key];
    Object.assign(process.env,before);
  }
}
const run=(command,args,options={})=>{
  const result=spawnSync(command,args,{encoding:'utf8',env:inheritedEnv(),...options});
  assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);
  return result.stdout;
};
async function freePort(){
  const server=net.createServer();await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
function waitReady(child,label){return new Promise((resolve,reject)=>{
  let out='',err='';const timer=setTimeout(()=>reject(new Error(`${label} server did not start: ${err}`)),15000);
  child.stdout.on('data',chunk=>{out+=chunk;const port=out.match(/MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/)?.[1];if(port)child.port=Number(port);if(out.includes('MCP listening')&&out.includes('admin socket')){clearTimeout(timer);resolve(out);}});
  child.stderr.on('data',chunk=>{err+=chunk;child.capturedStderr=err;});
  child.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error(`${label} server exited (${code??signal}): ${err}`));});
});}
async function stop(child){if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
async function rpcAt(port,secret,name,args){
  const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.result?.isError,false,body.result?.content?.[0]?.text??JSON.stringify(body));
  return JSON.parse(body.result.content[0].text);
}

test('upgrade fixture subprocesses exclude developer configuration and create their temp parent',()=>{
  const keys=['DALAN_WORKERS_FILE','DALAN_OAUTH_FILE','DALAN_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','DOT_BRIDGE_DATA_DIR'];
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const oldTmp=process.env.TMPDIR;
  const base=path.join(os.tmpdir(),`dalan-missing-tmp-${randomUUID()}`);process.env.TMPDIR=path.join(base,'nested','tmp');
  try {
    for(const key of keys)process.env[key]=`poison-${key}`;
    const env=fixtureEnv(path.join(base,'home'),41234);
    for(const key of keys)assert.equal(env[key],undefined,`${key} must not cross the fixture boundary`);
    assert(Object.keys(env).every(key=>['PATH','TMPDIR','LANG','NODE_OPTIONS','HOME'].includes(key)||key.startsWith('DOT_BRIDGE_')),
      'only the documented inherited variables and fixture-owned settings cross the boundary');
    const temp=makeTempRoot(os.tmpdir());
    assert.equal(temp.startsWith(path.join(base,'nested','tmp')+path.sep),true);
    assert.equal(fs.statSync(path.dirname(temp)).isDirectory(),true);
    fs.rmSync(temp,{recursive:true,force:true});
  } finally {
    for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
    if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;
    fs.rmSync(base,{recursive:true,force:true});
  }
});

const releaseSkip=prepublicSkip(RELEASE_FIXTURE);
if(releaseSkip)skipCheck('repository migration boots the v0.3.0 release fixture',releaseSkip);
test('repository migration boots the v0.3.0 release fixture and preserves its live queued grant and in-flight claim',{timeout:240000,skip:releaseSkip},async()=>{
  const root=makeTempRoot(path.join(os.homedir(),'.tmp'));
  let oldServer,currentServer;
  let drainChild;
  let env=null;
  const poisonKeys=['DALAN_WORKERS_FILE','DALAN_OAUTH_FILE','DALAN_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','DOT_BRIDGE_DATA_DIR'];
  const originalEnv=Object.fromEntries(poisonKeys.map(key=>[key,process.env[key]]));
  try {
    const home=path.join(root,'home'),port=await freePort();
    env=fixtureEnv(home,port);
    const release=path.join(root,'release');
    // The archive holds the v0.3.0 source without its tests or optional reviewer tool, so this test needs no git tag.
    const archive=readPrepublicFixture(RELEASE_FIXTURE);
    fs.mkdirSync(release);
    run('tar',['-xz','-C',release],{env,input:archive,timeout:30000});
    assert.equal(JSON.parse(fs.readFileSync(path.join(release,'package.json'))).version,'0.3.0');
    // The archive holds the release's own source; its two runtime dependencies come from this checkout.
    fs.symlinkSync(path.join(repo,'node_modules'),path.join(release,'node_modules'));

    const sentinelRoot=path.join(root,'sentinel'),sentinelWorkers=path.join(sentinelRoot,'workers.json'),sentinelOAuth=path.join(sentinelRoot,'oauth.env');
    fs.mkdirSync(sentinelRoot,{recursive:true});fs.writeFileSync(sentinelWorkers,'{"workers":{"dot":{}}}\n',{mode:0o600});
    fs.writeFileSync(sentinelOAuth,'sentinel=untouched\n',{mode:0o600});
    const sentinelDirs=Object.fromEntries(['DALAN_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','DOT_BRIDGE_DATA_DIR'].map((key,index)=>{
      const dir=path.join(sentinelRoot,`dir-${index}`);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'sentinel'),'untouched\n');return [key,dir];
    }));
    process.env.DALAN_WORKERS_FILE=sentinelWorkers;process.env.DALAN_OAUTH_FILE=sentinelOAuth;Object.assign(process.env,sentinelDirs);
    assert.equal(env.DALAN_WORKERS_FILE,undefined);
    assert.equal(env.DALAN_OAUTH_FILE,undefined);
    for(const key of Object.keys(sentinelDirs))assert.equal(env[key],undefined,`${key} must not cross the fixture boundary`);
    assert(Object.keys(env).every(key=>['PATH','TMPDIR','LANG','NODE_OPTIONS','HOME'].includes(key)||key.startsWith('DOT_BRIDGE_')),
      'fixture commands receive only the small base allowlist and fixture-owned settings');
    run(process.execPath,['bin/dot-worker.mjs','init','--legacy','--public-url','https://fixture.invalid','--json'],
      {cwd:release,env,timeout:30000});

    oldServer=spawn(process.execPath,['src/server.mjs'],{cwd:release,env,stdio:['ignore','pipe','pipe']});
    const startup=await waitReady(oldServer,'v0.3.0');assert.match(startup,/MCP listening/);
    const oldSecret=fs.readFileSync(path.join(home,'.config/dot-bridge/env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const requestId=`req_${randomUUID()}`,queuedRepo='fixture/queued-repository';
    const assignment={schema_version:1,request_id:requestId,brief:'Read the queued fixture repository',
      inputs:[{github_repo:queuedRepo,base_sha:'a'.repeat(40)}],scope_paths:['README.md'],
      execution_scope:'read-only',expected_output:'one sentence'};
    const runnableId=`req_${randomUUID()}`,ownerToken=`fixture-owner-${randomUUID()}`;
    const runnable={schema_version:1,request_id:runnableId,brief:'Finish one repository-free upgrade request',inputs:[],
      execution_scope:'read-only',expected_output:'one sentence'};
    const {inflightId}=await withProcessEnv(env,async()=>{
      assert.equal(process.env.DALAN_WORKERS_FILE,undefined,'the in-process v0.3.0 Store import cannot see a developer profile path');
      assert.equal(process.env.DALAN_OAUTH_FILE,undefined,'the in-process v0.3.0 Store import cannot see a developer OAuth path');
      for(const key of Object.keys(sentinelDirs))assert.equal(process.env[key],undefined,`${key} cannot reach the in-process v0.3.0 Store import`);
      assert(Object.keys(process.env).every(key=>['PATH','TMPDIR','LANG','NODE_OPTIONS','HOME'].includes(key)||key.startsWith('DOT_BRIDGE_')),
        'the in-process v0.3.0 Store import runs under the fixture allowlist');
      const {Store:LegacyStore}=await import(pathToFileURL(path.join(release,'src/store.mjs')).href);
      const legacyStore=new LegacyStore(path.join(home,'.local/share/dot-bridge/bridge.db'));
      legacyStore.submit(assignment,{mode:'none'},null,ownerToken,false,null,'normal',null,undefined,null,'dot','none');
      legacyStore.submit(runnable,{mode:'none'},null,ownerToken,false,null,'normal',null,undefined,null,'dot','none');
      assert.equal(legacyStore.get(requestId).status,'queued');assert.equal(legacyStore.get(runnableId).status,'queued');
      // A second job is in flight at upgrade time: v0.3.0 claimed it and its worker has not finished yet.
      const inflightId=`req_${randomUUID()}`;
      legacyStore.submit({...assignment,request_id:inflightId},{mode:'none'},null,ownerToken,false,null,'normal',null,undefined,null,'dot','none');
      legacyStore.db.close();return {inflightId};
    });
    const inflightClaim=await rpcAt(oldServer.port,oldSecret,'claim',{request_id:inflightId,claimant:'v030-claimant'});
    assert.ok(inflightClaim.claim_id);
    assert.equal((await rpcAt(oldServer.port,oldSecret,'get',{request_id:inflightId})).status,'claimed');

    let drainOut='',drainErr='';
    drainChild=spawn(process.execPath,['scripts/upgrade-drain.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
    drainChild.stdout.setEncoding('utf8').on('data',chunk=>drainOut+=chunk);
    drainChild.stderr.setEncoding('utf8').on('data',chunk=>drainErr+=chunk);
    for(let n=0;n<300&&!drainOut.includes(`Waiting for ${inflightId};`);n++) {
      if(drainChild.exitCode!==null)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.match(drainOut,new RegExp(`Waiting for ${inflightId}; lease expires `),'the drain reports the old live claim and its lease expiry');
    const drainExitPromise=once(drainChild,'exit');
    const oldFinish=await rpcAt(oldServer.port,oldSecret,'finish',{request_id:inflightId,claim_id:inflightClaim.claim_id,
      outcome:'completed',summary:'old worker finished before upgrade',result:'drained report'});
    assert.ok(oldFinish.receipt_id);
    const drainExit=await drainExitPromise;
    assert.equal(drainExit[0],0,drainErr||drainOut);
    assert.match(drainOut,/dalan resume/,'the successful drain tells the owner to resume after restart');
    drainChild=null;
    await stop(oldServer);oldServer=null;

    const workersFile=path.join(home,'.config/dot-bridge/workers.json');
    assert.equal(fs.existsSync(workersFile),false,'the legacy release has no worker profile');
    const migration=JSON.parse(run(process.execPath,['bin/dalan.mjs','worker','migrate-repos','--json'],{cwd:repo,env,timeout:30000}));
    assert.deepEqual(migration.workers[0].seeded_repositories,[{repo:queuedRepo,queued_request_ids:[requestId]}]);
    const policy=loadOwnerWorkers(workersFile);
    assert.equal(fs.existsSync(workersFile),false,'migration must not create a worker profile or guess a connection');
    assert(policy.allowsRepo('dot',queuedRepo),'the old live queued repository must remain allowed');
    assert(!policy.allowsRepo('dot','fixture/new-repository'),'a repository with no old job stays blocked');
    const audit=readWorkerRepoHistory(path.join(path.dirname(workersFile),'workers-audit.jsonl')).events;
    assert.equal(audit.length,1);assert.deepEqual(audit[0].after.repos,[queuedRepo]);
    const journal=workerRepoMigrationFile(workersFile),savedJournal=fs.readFileSync(journal);
    run(process.execPath,['bin/dalan.mjs','worker','migrate-repos','--json'],{cwd:repo,env,timeout:30000});
    assert.deepEqual(fs.readFileSync(journal),savedJournal,'a repeat must not reseed or duplicate its audit entry');
    assert.equal(readWorkerRepoHistory(path.join(path.dirname(workersFile),'workers-audit.jsonl')).events.length,1);

    currentServer=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
    const upgradedStartup=await waitReady(currentServer,'current');
    assert.match(upgradedStartup,/MCP listening/);
    assert.match(currentServer.capturedStderr,/DALAN_ENABLE_T3_TOOLS=1/,
      'the legacy T3 capability warning names the exact setting required to restore the old behavior');
    run(process.execPath,['bin/dot-worker.mjs','resume','--json'],{cwd:repo,env,timeout:30000});
    const secret=fs.readFileSync(path.join(home,'.config/dot-bridge/env'),'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const call=(name,args)=>rpcAt(currentServer.port,secret,name,args);
    const inflight=await call('get',{request_id:inflightId});
    assert.equal(inflight.status,'finished','the drain worker report survives the upgrade');
    const surviving=await call('get',{request_id:runnableId});
    assert.equal(surviving.status,'queued');assert.equal(surviving.assignment.request_id,runnableId);
    const reportToken=ownerToken;
    const receiptDir=path.join(home,'.local/share/dot-bridge/receipts');fs.mkdirSync(receiptDir,{recursive:true,mode:0o700});
    const receiptFile=path.join(receiptDir,`${(await import('node:crypto')).createHash('sha256').update(runnableId).digest('hex')}.json`);
    fs.writeFileSync(receiptFile,JSON.stringify({request_id:runnableId,token:reportToken,body:JSON.stringify(runnable),delivery:'none'})+'\n',{mode:0o600});
    const inflightReceiptFile=path.join(receiptDir,`${(await import('node:crypto')).createHash('sha256').update(inflightId).digest('hex')}.json`);
    fs.writeFileSync(inflightReceiptFile,JSON.stringify({request_id:inflightId,token:reportToken,body:JSON.stringify({...runnable,request_id:inflightId}),delivery:'none'})+'\n',{mode:0o600});
    const runnableClaim=await call('claim',{request_id:runnableId,claimant:'upgrade-claimant'});
    assert.ok(runnableClaim.claim_id,'the new server claims the exact queued request seeded by the old Store');
    const workerRead=await call('get',{request_id:runnableId});assert.equal(workerRead.status,'claimed');
    assert.equal(workerRead.assignment.request_id,runnableId);
    const finished=await call('finish',{request_id:runnableId,claim_id:runnableClaim.claim_id,outcome:'completed',summary:'upgrade finished once',result:'upgrade report'});
    const duplicateFinish=await call('finish',{request_id:runnableId,claim_id:runnableClaim.claim_id,outcome:'completed',summary:'upgrade finished once',result:'upgrade report'});
    assert.equal(duplicateFinish.receipt_id,finished.receipt_id,'a retry returns the same finish receipt');
    const ownerGet=JSON.parse(run(process.execPath,['bin/dalan.mjs','get',runnableId,'--json'],{cwd:repo,env,timeout:30000}));
    assert.equal(ownerGet.status,'finished');assert.equal(ownerGet.report.result,'upgrade report','dalan get reads the finished report after the upgrade');
    const drainedOwnerGet=JSON.parse(run(process.execPath,['bin/dalan.mjs','get',inflightId,'--json'],{cwd:repo,env,timeout:30000}));
    assert.equal(drainedOwnerGet.status,'finished');assert.equal(drainedOwnerGet.report.result,'drained report','the pre-upgrade finished report remains readable');
    const {Store:CurrentStore}=await withProcessEnv(env,()=>import(pathToFileURL(path.join(repo,'src/store.mjs')).href));
    const upgraded=new CurrentStore(path.join(home,'.local/share/dot-bridge/bridge.db'));
    assert.equal(upgraded.get(requestId).status,'queued');
    assert.equal(upgraded.get(requestId).assignment.inputs[0].github_repo,queuedRepo);
    assert(policy.allowsRepo('dot',queuedRepo),'the queued repository remains eligible under the migrated grant');
    assert.equal(upgraded.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(runnableId).n,1,'exactly one report is stored');
    assert.equal(upgraded.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(runnableId).n,1,'the exact queued request is claimed once');
    assert.equal(upgraded.db.prepare('SELECT count(*) n FROM reports WHERE request_id=?').get(inflightId).n,1,'the in-flight request finishes once');
    // The repository-bearing job remains claimable under the migrated grant, with no duplicate claimant.
    const queuedClaim=upgraded.claim(requestId,'upgrade-claimant','local-principal',2,null,'dot');
    assert.ok(queuedClaim.claim_id,'the new build can claim the job queued by v0.3.0');
    assert.throws(()=>upgraded.claim(requestId,'second-claimant','local-principal',3,null,'dot'),/claim_busy/);
    upgraded.finish(requestId,queuedClaim.claim_id,'completed','done','result');
    assert.equal(upgraded.get(requestId).status,'finished');
    assert.equal(upgraded.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(requestId).n,1,'one claim, no duplicate');
    assert.equal(upgraded.get(inflightId).status,'finished');
    upgraded.db.close();
    assert.equal(fs.readFileSync(sentinelWorkers,'utf8'),'{"workers":{"dot":{}}}\n','the developer workers profile was not read or modified');
    assert.equal(fs.readFileSync(sentinelOAuth,'utf8'),'sentinel=untouched\n','the developer OAuth file was not read or modified');
    for(const dir of Object.values(sentinelDirs))assert.equal(fs.readFileSync(path.join(dir,'sentinel'),'utf8'),'untouched\n');
    await stop(currentServer);currentServer=null;
  } finally {
    if(oldServer)await stop(oldServer);
    if(currentServer)await stop(currentServer);
    if(drainChild){drainChild.kill('SIGKILL');await once(drainChild,'exit').catch(()=>{});}
    for(const key of poisonKeys){if(originalEnv[key]===undefined)delete process.env[key];else process.env[key]=originalEnv[key];}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
