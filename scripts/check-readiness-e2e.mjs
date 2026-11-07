#!/usr/bin/env node
// Host admission refuses the disabled executor. Static prerequisite probes still
// inspect metadata, but an unapproved default cannot block a separately selected owner check.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const repo=path.resolve(new URL('..',import.meta.url).pathname);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dalan-check-readiness-'));
const fixture=path.join(home,'fixture');
const env={...process.env,HOME:home,DOT_BRIDGE_PORT:'0',DOT_BRIDGE_ALLOW_INSECURE_PUBLIC:'1',DOT_BRIDGE_BIND_HOST:'127.0.0.1',DOT_BRIDGE_T3_DRY_RUN:'1',DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE:fixture,DOT_BRIDGE_GITHUB_URL_TEST_SELF:fixture};
Object.assign(process.env,env);
const {admitImplementation}=await import('../src/check-readiness.mjs');
const {prepareGithubRepo}=await import('../src/projects.mjs');
const probe=a=>{
  prepareGithubRepo(a.inputs[0],{worker:'dot'});
  return admitImplementation(a,{worker:'dot'});
};
const owner='check-readiness-owner';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function git(...args) { const r=spawnSync('git',['-C',fixture,...args],{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);return r.stdout.trim(); }
function admin(route,body) { return new Promise((resolve,reject)=>{const req=http.request({socketPath:path.join(home,'.local/share/dot-bridge/admin.sock'),path:route,method:'POST',headers:{'content-type':'application/json'}},res=>{let b='';res.on('data',s=>b+=s);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(b)}));});req.on('error',reject);req.end(JSON.stringify(body));}); }
const rows=id=>{const db=new DatabaseSync(path.join(home,'.local/share/dot-bridge/bridge.db'));try{return db.prepare('SELECT count(*) n FROM assignments WHERE request_id=?').get(id).n;}finally{db.close();}};
function commit(name,files) {
  for(const [file,text] of Object.entries(files)) {fs.mkdirSync(path.dirname(path.join(fixture,file)),{recursive:true});fs.writeFileSync(path.join(fixture,file),text);}
  git('add','-A');git('commit','-m',name);return git('rev-parse','HEAD');
}
const withDefault=check=>({'.dot-bridge.json':JSON.stringify({checks:{default:{argv:['sh','-c','true'],...check}}})});
const task=(base,extra={},repoName='test/fixture')=>({schema_version:1,request_id:`req_${randomUUID()}`,brief:'Fix the bug in src/a.js',inputs:[{github_repo:repoName,base_sha:base}],expected_output:'A patch',execution_scope:'implementation',scope_paths:['src/a.js'],...extra});
const submit=a=>admin('/submit',{delivery:'none',assignment:a,owner_token:owner,execution:'none'});
async function blocked(a,pattern) {const r=await submit(a);assert.equal(r.code,400,JSON.stringify(r));assert.match(r.body.error,pattern);assert.equal(rows(a.request_id),0,'blocked submit must not queue a row');}
let service,serviceClosed;
try {
  fs.mkdirSync(path.join(home,'.local/share/dot-bridge'),{recursive:true});
  fs.mkdirSync(path.join(home,'.config/dot-bridge'),{recursive:true});
  fs.writeFileSync(path.join(home,'.config/dot-bridge/workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}],repos:["test/fixture","test/self"]}}}),{mode:0o600});
  fs.mkdirSync(fixture,{recursive:true});
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  const good=commit('good',{'src/a.js':'export const a=1;\n','tests/a.test.js':'// test\n',...withDefault({prerequisites:{binaries:['env'],runtime:'node>=1'},test_paths:['tests']})});
  const missingBinary=commit('missing binary',withDefault({prerequisites:{binaries:['env','definitely-missing-binary-xyz']}}));
  const missingLockfile=commit('missing lockfile',withDefault({prerequisites:{lockfile:'missing.lock'}}));
  const futureNode=commit('future node',withDefault({prerequisites:{runtime:'node>=999'}}));
  const probeDeclared=commit('readiness argv',withDefault({prerequisites:{binaries:['env']},readiness_argv:['sh','-c','exit 1']}));
  const brokenMetadata=commit('broken metadata',{'.dot-bridge.json':'{not json'});
  const noChecks=commit('no checks',{'.dot-bridge.json':'{}'});
  const nonDefault=commit('non-default only unmet',{'.dot-bridge.json':JSON.stringify({checks:{default:{argv:['sh','-c','true']},extra:{argv:['sh','-c','true'],prerequisites:{binaries:['definitely-missing-binary-xyz']}}}})});
  service=spawn(process.execPath,['src/server.mjs'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});let ready=false,closed=false,stdout='',stderr='';
  serviceClosed=new Promise(resolve=>service.once('close',()=>{closed=true;resolve();}));
  service.stdout.on('data',b=>{stdout+=b;if(stdout.includes('MCP listening'))ready=true;});service.stderr.on('data',b=>stderr+=b);
  service.on('error',error=>{stderr+=`server spawn failed: ${error.code??error.message}`;});
  for(let i=0;i<200&&!ready&&!closed;i++) await sleep(25);assert(ready,stderr||`server startup failed (exit ${service.exitCode}, signal ${service.signalCode})`);

  const host=task(good);
  const refused=await admin('/submit',{delivery:'none',assignment:host,owner_token:owner,execution:'host'});
  assert.equal(refused.code,400,JSON.stringify(refused));
  assert.match(refused.body.error,/capability_not_available: host_execution.*(?:resource_limits_unavailable|no host executor on darwin)/);
  assert.equal(rows(host.request_id),0);
  const passing=task(good);
  const admitted=await submit(passing);assert.equal(admitted.code,200,JSON.stringify(admitted));
  assert.equal(rows(passing.request_id),1);
  assert.deepEqual(admitted.body.check_readiness.probed,[]);
  assert.deepEqual(probe(passing).probed,['default']);
  assert.deepEqual(admitted.body.check_readiness.warnings,[]);
  assert.equal((await submit(passing)).code,200,'retry of a stored request is admitted again');

  const missing=task(missingBinary),missingProbe=probe(missing);
  assert.deepEqual(missingProbe.probed,['default']);assert.match(missingProbe.warnings[0],/^default: binary definitely-missing-binary-xyz not found/);assert.equal(rows(missing.request_id),0);
  assert.match(probe(task(missingLockfile)).warnings[0],/^default: lockfile missing\.lock missing at/);
  assert.match(probe(task(futureNode)).warnings[0],/^default: runtime node .* older than required >=999/);
  // Admission sees the unallowlisted default's unmet prerequisite, while the named
  // selected check is independently owner-authorized and does not grant the default.
  const config=path.join(home,'.config/dot-bridge');fs.mkdirSync(config,{recursive:true});
  const budgets={cpu_ms:1000,wall_ms:5000,memory_bytes:134217728,processes:16,disk_write_bytes:1048576,output_bytes:4096};
  fs.writeFileSync(path.join(config,'checks.json'),JSON.stringify({'test/fixture':{checks:{named:{argv:['sh','-c','true'],host_budget:budgets}}}}),{mode:0o600});
  fs.writeFileSync(path.join(config,'host-check-allowlist.json'),JSON.stringify({version:1,checks:[{repo:'test/fixture',check_id:'named'}]}),{mode:0o600});
  const namedReady=probe(task(missingBinary));
  assert.deepEqual(namedReady.probed,['default','named']);assert.match(namedReady.warnings[0],/^default: binary definitely-missing-binary-xyz not found/);
  fs.unlinkSync(path.join(config,'checks.json'));fs.unlinkSync(path.join(config,'host-check-allowlist.json'));
  assert.throws(()=>probe(task(brokenMetadata)),/BLOCKED: check metadata unreadable/);
  // A readiness command is recorded as skipped, never run on the host.
  const declared=await submit(task(probeDeclared));assert.equal(declared.code,200,JSON.stringify(declared));
  assert(probe(task(probeDeclared)).skipped.some(s=>/readiness_argv of default/.test(s.what)&&/not run at admission/.test(s.reason)));
  const none=await submit(task(noChecks));assert.equal(none.code,200);assert.deepEqual(none.body.check_readiness.probed,[]);
  const warned=await submit(task(nonDefault));assert.equal(warned.code,200,JSON.stringify(warned));assert.match(probe(task(nonDefault)).warnings[0],/^extra: binary definitely-missing-binary-xyz/);

  // Read-only scope never probes.
  const readOnly=await submit(task(missingBinary,{execution_scope:'read-only'}));assert.equal(readOnly.code,200,JSON.stringify(readOnly));assert.equal(readOnly.body.check_readiness,undefined);

  // Regression-test rule.
  const ask={expected_output:'A patch with a regression test'};
  await blocked(task(good,ask),/regression_test_scope: .*no scope_paths entry is a test path/);
  assert.equal((await submit(task(good,{...ask,scope_paths:['src/a.js','tests/a.test.js']}))).code,200);
  assert.equal((await submit(task(good,{...ask,scope_paths:['src/a.js','tests']}))).code,200);
  assert.equal((await submit(task(good,{expected_output:'A patch; do not add a regression test'}))).code,200);
  assert.equal((await submit(task(good,{...ask,execution_scope:'read-only'}))).code,200,'rule is for implementation scope');

  // Colocated tests: a Go repo whose tests sit beside the code, and a JS repo with src/*.test.js. The default check is an override
  // with no test_paths, so only the tree lookup at base_sha can admit a directory.
  const goAsk={...ask,brief:'Fix the reported bug'};
  const goRepo=commit('go colocated',{'go.mod':'module example.test/x\n','internal/foo/bar.go':'package foo\n','internal/foo/bar_test.go':'package foo\n','internal/baz/baz.go':'package baz\n','web/src/x.js':'export const x=1;\n','web/src/x.test.js':'// test\n',...withDefault({prerequisites:{binaries:['env']}})});
  {const r=await submit(task(goRepo,{...goAsk,scope_paths:['internal/foo/bar.go','internal/foo']}));assert.equal(r.code,200,`Go package directory with bar_test.go is a test path: ${JSON.stringify(r.body)}`);}
  assert.equal((await submit(task(goRepo,{...goAsk,scope_paths:['internal/foo/bar.go','internal/foo/bar_test.go']}))).code,200,'a _test.go file is a test path');
  await blocked(task(goRepo,{...goAsk,scope_paths:['internal/foo/bar.go']}),/regression_test_scope/);
  await blocked(task(goRepo,{...goAsk,scope_paths:['internal/baz/baz.go','internal/baz']}),/regression_test_scope/);
  assert.equal((await submit(task(goRepo,{...goAsk,scope_paths:['web/src/x.js','web/src']}))).code,200,'JS directory with a colocated x.test.js is a test path');

  // This repo's own default check (npm run test:sandbox) is admitted.
  const self=spawnSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  // Publish the exact checkout in our own fixture: an isolated checkout may have a detached HEAD with no containing branch.
  git('fetch',repo,`${self}:refs/heads/bridge-self`);
  const own=await submit(task(self,{scope_paths:['README.md'],brief:'Improve README.md',request_id:`req_${randomUUID()}`},'test/self'));assert.equal(own.code,200,JSON.stringify(own));
  const configuredChecks=Object.keys(JSON.parse(fs.readFileSync(path.join(repo,'.dalan.json'),'utf8')).checks).sort();
  assert.deepEqual(probe(task(self,{scope_paths:['README.md'],brief:'Improve README.md'},'test/self')).probed.sort(),configuredChecks,'the repo check catalog was not fully probed');
  console.log('check-readiness-e2e: PASS');
} finally {
  if(service) {
    if(service.exitCode===null&&service.signalCode===null) service.kill('SIGTERM');
    await serviceClosed;
  }
  fs.rmSync(home,{recursive:true,force:true});
}
