#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('dot-bridge.example.test');
// A patch must not reach finish unchecked: when the worker finishes a host implementation job with a diff and never called run_check,
// the bridge runs the owner's default check itself, so a check_* lifecycle event exists whether or not the worker remembered.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { stopChild } from '../src/test-support/process.mjs';
import { portFromListeningBanner } from '../src/test-support/port.mjs';

// Keep the socket short and the cache under private owner-controlled parents.
const scratch = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const home = fs.mkdtempSync(path.join(scratch, 'hh-'));
const repo = path.join(home, 'repo');
const config = path.join(home, '.config/dot-bridge');
fs.mkdirSync(repo); fs.mkdirSync(config, { recursive: true });
let port;
const audience = 'https://dot-bridge.example.test';
const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: ['/runtime/node', '-e', 'process.stdout.write("SHOULD_NOT_RUN")'], prerequisites: { binaries: [] } } } }));
const manifest={name:'http-prepared-fixture',version:'1.0.0'};
fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify(manifest));
fs.writeFileSync(path.join(repo,'package-lock.json'),JSON.stringify({...manifest,lockfileVersion:3,packages:{'':manifest}}));
git('add', '.'); git('commit', '-qm', 'fixture');
const base = git('rev-parse', 'HEAD');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'host-policy-test', use: 'sig' };
const jwks = http.createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
const jwksPort = jwks.address().port, issuer = `http://127.0.0.1:${jwksPort}/realm`;
fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{workspaceAllowed:true,connections:[{issuer,subject:'dot',client_id:'fixture-client'}],repos:['example-owner/fixture']}}}),{mode:0o600});
fs.writeFileSync(path.join(config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n`, { mode: 0o600 });
const env = { ...process.env, HOME: home, DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_T3_DRY_RUN: '1', DALAN_HOST_CHECKS: '1', DALAN_FINISH_CHECK_WAIT_MS: '24000', DOT_BRIDGE_WORKSPACE_ROOT: path.join(home, 'work'), DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE: repo };
const service = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve(new URL('..', import.meta.url).pathname), env, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false, stderr = '';
let stdout = '';
service.stdout.on('data', b => { stdout += String(b); port = portFromListeningBanner(stdout); if (port) ready = true; });
service.stderr.on('data', b => { stderr += String(b); });
const token = () => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'host-policy-test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 300, sub: 'dot', azp:'fixture-client', scope: 'dot-bridge.read dot-bridge.work' })).toString('base64url');
  const body = `${header}.${claims}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
};

try {
  for (let i = 0; i < 160 && !ready; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert(ready, `server did not start: ${stderr}`);
  const secret = fs.readFileSync(path.join(config, 'env'), 'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const auth = token();
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json();
    assert(!body.result.isError, body.result.content?.[0]?.text ?? 'MCP call failed');
    return JSON.parse(body.result.content[0].text);
  };

  const { Store } = await import('../src/store.mjs');
  const dbPath = path.join(home, '.local/share/dot-bridge/bridge.db');
  const budget={cpu_ms:10000,wall_ms:15000,memory_bytes:256*1024**2,processes:32,disk_write_bytes:8*1024**2,output_bytes:8192};
  const writeCheck=(code,wallMs=15000)=>fs.writeFileSync(path.join(config,'checks.json'),JSON.stringify({'example-owner/fixture':{checks:{default:{argv:['/runtime/node','-e',code],host_budget:{...budget,wall_ms:wallMs},timeout_ms:wallMs,output_bytes:8192},slow:{argv:['/runtime/node','-e','setTimeout(()=>console.log("SLOW_DONE"),6000)'],host_budget:budget,timeout_ms:15000,output_bytes:8192}}}}),{mode:0o600});
  writeCheck('console.log("AUTO_CHECK_RAN")');
  fs.writeFileSync(path.join(config,'host-check-allowlist.json'),JSON.stringify({version:1,checks:[{repo:'example-owner/fixture',check_id:'default'},{repo:'example-owner/fixture',check_id:'slow'}]}),{mode:0o600});
  const patch=name=>`diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+hello\n`;
  const submit=execution=>{
    const id=`req_${randomUUID()}`,assignment={schema_version:1,request_id:id,brief:'fixture',inputs:[{github_repo:'example-owner/fixture',base_sha:base}],expected_output:'report',execution_scope:'implementation'};
    const store=new Store(dbPath);
    try{store.submit(assignment,'thread','environment','auto-check-owner',false,null,'normal',null,assignment,null,null,execution);}finally{store.db.close();}
    return id;
  };
  const rows=(sql,...args)=>{const db=new Store(dbPath);try{return db.db.prepare(sql).all(...args);}finally{db.db.close();}};
  const events=id=>rows("SELECT type,actor,reason FROM lifecycle_events WHERE request_id=? AND type LIKE 'check_%' ORDER BY id",id);
  const claimJob=async id=>{const claim=await call('claim',{request_id:id,claimant:'dot'});assert(claim.claim_id,JSON.stringify(claim));return claim.claim_id;};
  const finish=(id,claim_id)=>call('finish',{request_id:id,claim_id,outcome:'completed',summary:'done',result:'done'});
  const finishRaw=async(id,claim_id)=>{
    const response=await fetch(`http://127.0.0.1:${port}/${secret}/mcp`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'finish',arguments:{request_id:id,claim_id,outcome:'completed',summary:'done',result:'done'}}})});
    return (await response.json()).result;
  };
  const reported=id=>rows('SELECT 1 FROM reports WHERE request_id=?',id).length===1;

  // 1. A patch and no run_check: the bridge runs the check and records the outcome.
  const a=submit('host'),aClaim=await claimJob(a);
  await call('apply_patch',{request_id:a,claim_id:aClaim,patch:patch('hello.txt')});
  await finish(a,aClaim);
  const aEvents=events(a);
  assert.deepEqual(aEvents.map(e=>e.type),['check_started','check_passed'],JSON.stringify(aEvents));
  assert.match(aEvents[1].reason,/check_id=default/);
  assert.equal(rows("SELECT COUNT(*) n FROM check_jobs WHERE request_id=? AND status='completed'",a)[0].n,1);
  assert(reported(a),'the worker report is stored after the automatic check');
  console.log('PASS a patch finished without run_check gets a check_started and check_passed event from the bridge');

  // 2. The worker already checked this exact diff: no second run.
  const b=submit('host'),bClaim=await claimJob(b);
  await call('apply_patch',{request_id:b,claim_id:bClaim,patch:patch('hello.txt')});
  const ran=await call('run_check',{request_id:b,claim_id:bClaim,check_id:'default'});
  assert.equal(ran.status,'completed',JSON.stringify(ran));
  await finish(b,bClaim);
  assert.equal(rows('SELECT COUNT(*) n FROM check_jobs WHERE request_id=?',b)[0].n,1,'one check for one diff');
  console.log('PASS a diff the worker already checked is not checked again');

  // 3. The worker checked an earlier diff and patched more: the new diff is checked.
  const c=submit('host'),cClaim=await claimJob(c);
  await call('apply_patch',{request_id:c,claim_id:cClaim,patch:patch('one.txt')});
  assert.equal((await call('run_check',{request_id:c,claim_id:cClaim,check_id:'default'})).status,'completed');
  await call('apply_patch',{request_id:c,claim_id:cClaim,patch:patch('two.txt')});
  await finish(c,cClaim);
  assert.equal(rows('SELECT COUNT(*) n FROM check_jobs WHERE request_id=? AND status=?',c,'completed')[0].n,2,'the changed diff is checked again');
  console.log('PASS a diff changed after the worker\'s check is checked again');

  // 4. A failing check is recorded and the report is still stored.
  writeCheck('process.exit(3)');
  const d=submit('host'),dClaim=await claimJob(d);
  await call('apply_patch',{request_id:d,claim_id:dClaim,patch:patch('hello.txt')});
  await finish(d,dClaim);
  assert.deepEqual(events(d).map(e=>e.type),['check_started','check_failed'],JSON.stringify(events(d)));
  assert.match(events(d)[1].reason,/phase=check/);
  assert(reported(d),'a failed check does not block the report');
  console.log('PASS a failing automatic check records check_failed and the report is still stored');

  // 5. No diff, or a job that may not run host checks: nothing runs.
  writeCheck('console.log("AUTO_CHECK_RAN")');
  const e=submit('host'),eClaim=await claimJob(e);
  await finish(e,eClaim);
  assert.deepEqual(events(e),[],'no patch, no check');
  const f=submit('worker'),fClaim=await claimJob(f);
  await call('apply_patch',{request_id:f,claim_id:fClaim,patch:patch('hello.txt')});
  await finish(f,fClaim);
  assert.deepEqual(events(f),[],'a job without host execution is never checked by the bridge');
  console.log('PASS no patch and no host execution run no automatic check');

  // 6. A check that is still running when the wait ends stops this finish with a retryable error; the next finish takes the result.
  // check() answers 'running' after 20 s; the wait budget (24 s here, 330 s by default) covers that time, so the wait ends 4 s later.
  writeCheck('setTimeout(()=>console.log("SLOW_CHECK_DONE"),30000)',60000);
  const g=submit('host'),gClaim=await claimJob(g);
  await call('apply_patch',{request_id:g,claim_id:gClaim,patch:patch('hello.txt')});
  const early=await finishRaw(g,gClaim);
  assert(early.isError,'a check still running after the wait must stop the finish '+JSON.stringify(early).slice(0,300)+JSON.stringify(events(g)));
  assert.match(early.content[0].text,/default check is still running; call finish again/);
  assert(!reported(g),'no report while the check runs');
  for(let i=0;i<400&&rows("SELECT 1 FROM check_jobs WHERE request_id=? AND status='running'",g).length;i++)await new Promise(resolve=>setTimeout(resolve,100));
  await finish(g,gClaim);
  assert(reported(g),'the retried finish stores the report');
  assert.deepEqual(events(g).map(e=>e.type),['check_started','check_passed'],JSON.stringify(events(g)));
  assert.equal(rows('SELECT COUNT(*) n FROM check_jobs WHERE request_id=?',g)[0].n,1,'the retry reuses the first check');
  console.log('PASS a check still running after the wait stops finish with a retryable error and the retry stores the report');

  // 7. A check job that failed to complete does not stand in for a check of that diff.
  writeCheck('console.log("AUTO_CHECK_RAN")');
  const h=submit('host'),hClaim=await claimJob(h);
  await call('apply_patch',{request_id:h,claim_id:hClaim,patch:patch('hello.txt')});
  assert.equal((await call('run_check',{request_id:h,claim_id:hClaim,check_id:'default'})).status,'completed');
  const db=new Store(dbPath);try{db.db.prepare("UPDATE check_jobs SET status='failed' WHERE request_id=?").run(h);}finally{db.db.close();}
  await finish(h,hClaim);
  assert.equal(rows("SELECT COUNT(*) n FROM check_jobs WHERE request_id=? AND status='completed'",h)[0].n,1,'the bridge ran its own check');
  assert.equal(rows('SELECT COUNT(*) n FROM check_jobs WHERE request_id=?',h)[0].n,2);
  console.log('PASS a failed check job does not count as a check of that diff');

  // 8. The worker started a different check and finishes while it runs: finish waits for it. Its completed run covers the diff.
  writeCheck('console.log("AUTO_CHECK_RAN")');
  const k=submit('host'),kClaim=await claimJob(k);
  await call('apply_patch',{request_id:k,claim_id:kClaim,patch:patch('hello.txt')});
  const slow=call('run_check',{request_id:k,claim_id:kClaim,check_id:'slow'});
  for(let i=0;i<100&&!events(k).length;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(events(k).length,1,'the slow check is running');
  await finish(k,kClaim);
  assert(reported(k),'finish waited for the worker\'s own check and stored the report');
  await slow;
  assert.deepEqual(events(k).map(e=>e.type),['check_started','check_passed'],JSON.stringify(events(k)));
  assert.equal(rows('SELECT COUNT(*) n FROM check_jobs WHERE request_id=?',k)[0].n,1,'a completed check of any id covers the exact diff');
  console.log('PASS finish waits for a check the worker started under another id, and that check covers the diff');

  // 9. The worker's own check is running and there is nothing for the bridge to check (no patch): finish still waits for it.
  const m=submit('host'),mClaim=await claimJob(m);
  const slow2=call('run_check',{request_id:m,claim_id:mClaim,check_id:'slow'});
  for(let i=0;i<100&&!events(m).length;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(events(m).length,1,'the slow check is running on an empty diff');
  await finish(m,mClaim);
  assert(reported(m),'finish waited for the worker\'s own check even with no patch');
  await slow2;
  console.log('PASS finish waits for the worker\'s own check even when there is no patch to check');
} finally {
  await stopChild(service);
  await new Promise(resolve => jwks.close(resolve));
  const thaw=dir=>{const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())return;fs.chmodSync(dir,0o700);for(const name of fs.readdirSync(dir))thaw(path.join(dir,name));};
  thaw(home);
  fs.rmSync(home, { recursive: true, force: true });
}
