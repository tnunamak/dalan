import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { stopChild } from '../src/test-support/process.mjs';
import { prepareNodeModules, resolvePreparedNodeModules } from '../src/prepared-node-modules.mjs';
import { runHostBudget } from '../src/host-budget.mjs';

const budget={cpu_ms:10000,wall_ms:15000,memory_bytes:256*1024**2,processes:32,disk_write_bytes:8*1024**2,output_bytes:8192};
const hash=(bytes,kind='sha256')=>createHash(kind).update(bytes).digest(kind==='sha512'?'base64':'hex');
const writeJSON=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
const check=code=>[{name:'check',argv:['/runtime/node','--input-type=module','-e',code]}];

test('owner-prepared dependencies are the only mounted dependency input', {skip:process.platform!=='linux' && 'Linux systemd/cgroup backend required'},async t=>{
  const originalHome=process.env.HOME;
  const originalRegistry=process.env.npm_config_registry;
  const root=fs.mkdtempSync(path.join(os.homedir(),'.tmp','pd-'));
  fs.mkdirSync(path.join(root,'.tmp'),{mode:0o700});
  process.env.HOME=root;
  let server;
  try {
    const packageDir=path.join(root,'tar','package');fs.mkdirSync(packageDir,{recursive:true});
    const marker=path.join(root,'lifecycle-marker');
    writeJSON(path.join(packageDir,'package.json'),{name:'prepared-fixture',version:'1.0.0',type:'module',main:'index.mjs',scripts:{install:`node -e "require('fs').writeFileSync('${marker}','bad')"`}});
    fs.writeFileSync(path.join(packageDir,'index.mjs'),'export const value="prepared-byte-identity";\n');
    const tarball=path.join(root,'fixture.tgz');
    const tar=spawnSync('tar',['-czf',tarball,'-C',path.dirname(packageDir),'package'],{encoding:'utf8'});
    assert.equal(tar.status,0,tar.stderr);
    server=spawn(process.execPath,['--input-type=module','-e',`import http from 'node:http';import fs from 'node:fs';const bytes=fs.readFileSync(process.argv[1]);http.createServer((q,r)=>{r.end(bytes)}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})`,tarball],{stdio:['ignore','pipe','pipe']});
    const port=await new Promise((resolve,reject)=>{let text='';server.stdout.on('data',b=>{text+=b;const m=text.match(/^(\d+)\n/);if(m)resolve(Number(m[1]));});server.once('error',reject);server.once('exit',code=>reject(new Error('registry fixture exited '+code)));});
    process.env.npm_config_registry=`http://127.0.0.1:${port}/`;
    const source=path.join(root,'source');fs.mkdirSync(source);
    const manifest={name:'source-fixture',version:'1.0.0',type:'module',dependencies:{'prepared-fixture':'1.0.0'}};
    const lock={name:manifest.name,version:manifest.version,lockfileVersion:3,packages:{'':manifest,'node_modules/prepared-fixture':{version:'1.0.0',resolved:`http://127.0.0.1:${port}/fixture.tgz`,integrity:'sha512-'+hash(fs.readFileSync(tarball),'sha512'),hasInstallScript:true}}};
    writeJSON(path.join(source,'package.json'),manifest);writeJSON(path.join(source,'package-lock.json'),lock);
    await t.test('missing preparation refuses before launching a check',async()=>{
      let started=false;
      await assert.rejects(runHostBudget({dir:source,budgets:budget,enabled:true,phases:check('throw Error("unprepared check ran")'),onStarted:()=>{started=true;}}),{code:'dependencies_unprepared'});
      assert.equal(started,false);
    });
    let prepared;
    try { prepared=prepareNodeModules(source); }
    catch(error) {
      const logs=path.join(root,'.npm','_logs');
      if(fs.existsSync(logs))for(const name of fs.readdirSync(logs))console.error(fs.readFileSync(path.join(logs,name),'utf8'));
      throw error;
    }
    assert.equal(fs.existsSync(marker),false,'dependency lifecycle script must not run');
    const originalModule=fs.readFileSync(path.join(prepared.treePath,'prepared-fixture','index.mjs'));
    await t.test('real guest imports the tree and cannot modify it',async()=>{
      const run=await runHostBudget({dir:source,budgets:budget,enabled:true,phases:check(`import {value} from 'prepared-fixture';import fs from 'node:fs';if('treePath' in JSON.parse(fs.readFileSync('/config.json')).dependencies)process.exit(8);console.log(value);try{fs.writeFileSync('node_modules/prepared-fixture/index.mjs','changed');process.exit(9)}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e;console.log('READ_ONLY')}`)});
      assert.equal(run.exit.code,0,JSON.stringify(run));
      assert.equal(run.stop.verified,true);assert.deepEqual(run.stop.remaining_pids,[]);
      assert.match(run.bytes.toString(),/prepared-byte-identity/);assert.match(run.bytes.toString(),/READ_ONLY/);
      assert.equal(run.dependencies.lock_sha256,hash(fs.readFileSync(path.join(source,'package-lock.json'))));
      assert.equal(JSON.stringify(run.dependencies).includes(root),false,'receipt must not expose host cache path');
      assert.deepEqual(fs.readFileSync(path.join(prepared.treePath,'prepared-fixture','index.mjs')),originalModule);
    });
    await t.test('another fresh guest sees unchanged prepared bytes',async()=>{
      const run=await runHostBudget({dir:source,budgets:budget,enabled:true,phases:check(`import {value} from 'prepared-fixture';console.log(value)`)});
      assert.equal(run.exit.code,0,JSON.stringify(run));assert.equal(run.stop.verified,true);
      assert.match(run.bytes.toString(),/prepared-byte-identity/);
    });
    await t.test('changed manifest and dependency overlays refuse before launch',async()=>{
      writeJSON(path.join(source,'package.json'),{...manifest,description:'changed'});
      await assert.rejects(runHostBudget({dir:source,budgets:budget,enabled:true,phases:check('process.exit(9)')}),{code:'dependencies_unprepared'});
      writeJSON(path.join(source,'package.json'),manifest);
      await assert.rejects(runHostBudget({dir:source,budgets:budget,enabled:true,maskPaths:['package-lock.json'],phases:check('process.exit(9)')}),/overlay overlaps dependency inputs/);
      await assert.rejects(runHostBudget({dir:source,budgets:budget,enabled:true,sourceExemptions:[{path:'alias',hostPath:prepared.treePath}],phases:check('process.exit(9)')}),/overlay exposes dependency tree/);
    });
    await t.test('a source change after lookup is refused inside the real guest',async()=>{
      const overlayFile=path.join(root,'overlay');fs.writeFileSync(overlayFile,'inert overlay');
      let changed=false,started=false;
      // This owner-side getter deterministically changes the candidate between
      // dependency lookup and source production, without adding a runtime hook.
      const overlay={hostPath:overlayFile,get path(){if(!changed){changed=true;writeJSON(path.join(source,'package-lock.json'),{...lock,version:'changed-after-admission'});}return 'probe-overlay';}};
      try {
        const run=await runHostBudget({dir:source,budgets:budget,enabled:true,sourceExemptions:[overlay],onStarted:()=>{started=true;},phases:check('process.exit(9)')});
        assert.equal(run.exit.code,125,JSON.stringify(run));assert.equal(run.stop.verified,true);
        assert.match(run.error,/copied dependency inputs changed/);assert.equal(started,false);assert.deepEqual(run.phases,[]);
      } finally {writeJSON(path.join(source,'package-lock.json'),lock);}
    });
    await t.test('receipt directory cannot be a parent of the dependency tree',async()=>{
      const cacheRoot=path.join(root,'.dalan/prepared-node-modules');
      await assert.rejects(runHostBudget({dir:source,budgets:budget,enabled:true,checkRunId:'dep-isolation',receiptDir:cacheRoot,phases:check('process.exit(9)')}),/overlap|expos|isolat/i);
    });
    await t.test('ambient node_modules is excluded even without a lockfile',async()=>{
      const ambient=path.join(root,'ambient');fs.mkdirSync(path.join(ambient,'node_modules','unexpected'),{recursive:true});
      fs.writeFileSync(path.join(ambient,'node_modules','unexpected','marker'),'not a prepared dependency');
      fs.mkdirSync(path.join(ambient,'sub','node_modules'),{recursive:true});fs.writeFileSync(path.join(ambient,'sub','node_modules','marker'),'also not prepared');
      assert.equal(resolvePreparedNodeModules(ambient),null);
      const run=await runHostBudget({dir:ambient,budgets:budget,enabled:true,phases:check(`import fs from 'node:fs';if(fs.existsSync('node_modules/unexpected/marker')||fs.existsSync('sub/node_modules/marker'))process.exit(9);console.log('NO_AMBIENT_MODULES')`)});
      assert.equal(run.exit.code,0,JSON.stringify(run));assert.equal(run.stop.verified,true);assert.match(run.bytes.toString(),/NO_AMBIENT_MODULES/);
    });
  } finally {
    await stopChild(server);
    process.env.HOME=originalHome;
    if(originalRegistry===undefined)delete process.env.npm_config_registry;else process.env.npm_config_registry=originalRegistry;
    // Only the owned fixture is thawed; production cache and other jobs are untouched.
    const thaw=dir=>{const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())return;fs.chmodSync(dir,0o700);for(const name of fs.readdirSync(dir))thaw(path.join(dir,name));};
    thaw(root);fs.rmSync(root,{recursive:true,force:true});
  }
});
