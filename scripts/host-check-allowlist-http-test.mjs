#!/usr/bin/env node
// Authenticated HTTP regression: a direct run_check call cannot use repository metadata
// to launch an unallowlisted check or publish check output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { stopChild } from '../src/test-support/process.mjs';

// Keep the socket short and the cache under private owner-controlled parents.
const scratch = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const home = fs.mkdtempSync(path.join(scratch, 'hh-'));
const repo = path.join(home, 'repo');
const config = path.join(home, '.config/dot-bridge');
fs.mkdirSync(repo); fs.mkdirSync(config, { recursive: true });
const freePort = async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const port = await freePort(), jwksPort = await freePort();
const issuer = `http://127.0.0.1:${jwksPort}/realm`, audience = 'https://dot-bridge.example.test';
const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: ['/runtime/node', '-e', 'process.stdout.write("SHOULD_NOT_RUN")'], prerequisites: { binaries: [] } } } }));
const manifest={name:'http-prepared-fixture',version:'1.0.0'};
fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify(manifest));
fs.writeFileSync(path.join(repo,'package-lock.json'),JSON.stringify({...manifest,lockfileVersion:3,packages:{'':manifest}}));
git('add', '.'); git('commit', '-qm', 'fixture');
const base = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n`, { mode: 0o600 });
fs.writeFileSync(path.join(config,'workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer,subject:'dot',client_id:'fixture-client'}],repos:['example-owner/fixture']}}}),{mode:0o600});
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'host-policy-test', use: 'sig' };
const jwks = http.createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
await new Promise(resolve => jwks.listen(jwksPort, '127.0.0.1', resolve));
const env = { ...process.env, HOME: home, DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_T3_DRY_RUN: '1', DALAN_HOST_CHECKS: '1', DOT_BRIDGE_WORKSPACE_ROOT: path.join(home, 'work'), DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE: repo };
const service = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve(new URL('..', import.meta.url).pathname), env, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false, stderr = '';
service.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; });
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
  const store = new Store(dbPath), id = `req_${randomUUID()}`;
  const assignment = { schema_version: 1, request_id: id, brief: 'fixture', inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }], expected_output: 'report', execution_scope: 'implementation' };
  store.submit(assignment, 'thread', 'environment', 'http-owner', false, null, 'normal', null, assignment, null, null, 'host');
  store.db.close();
  const claim = await call('claim', { request_id: id, claimant: 'dot' });
  assert(claim.claim_id, JSON.stringify(claim));
  assert.deepEqual(claim.available_checks, [], 'host claim must not advertise an unpermitted check as runnable');
  assert.equal(claim.host_execution_available, false);
  const result = await call('run_check', { request_id: id, claim_id: claim.claim_id, check_id: 'default' });
  assert.equal(result.status, 'capability_not_available', JSON.stringify(result));
  assert.match(result.reason, /host_check_not_allowlisted/);
  assert.equal(Object.hasOwn(result, 'output_preview'), false, 'denial returns no process output');
  assert.equal(Object.hasOwn(result, 'output_artifact_id'), false, 'denial returns no output artifact ID');
  const checkDb = new Store(dbPath);
  try {
    assert.equal(checkDb.db.prepare('SELECT COUNT(*) n FROM check_jobs WHERE request_id=?').get(id).n, 0, 'denial creates no check admission row');
    assert.equal(checkDb.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE request_id=?').get(id).n, 0, 'denial creates no output artifact');
  } finally { checkDb.db.close(); }
  assert.equal(fs.existsSync(path.join(home, 'SHOULD_NOT_RUN')), false);
  console.log('PASS authenticated HTTP unallowlisted run_check: no runnable advertisement, process, row or artifact');
  if(process.platform==='linux') {
    await call('finish',{request_id:id,claim_id:claim.claim_id,outcome:'blocked',summary:'Owner authorization is required',result:'The unallowlisted check was refused.'});
    const budget={cpu_ms:10000,wall_ms:15000,memory_bytes:256*1024**2,processes:32,disk_write_bytes:8*1024**2,output_bytes:8192};
    const check={argv:['/runtime/node','-e','const fs=require("fs");try{fs.writeFileSync("node_modules/new-file","bad");process.exit(9)}catch(e){if(!["EROFS","EACCES"].includes(e.code))throw e}console.log("HTTP_PREPARED_VERIFIED")'],host_budget:budget,timeout_ms:15000,output_bytes:8192};
    fs.writeFileSync(path.join(config,'checks.json'),JSON.stringify({'example-owner/fixture':{checks:{default:check}}}),{mode:0o600});
    fs.writeFileSync(path.join(config,'host-check-allowlist.json'),JSON.stringify({version:1,checks:[{repo:'example-owner/fixture',check_id:'default'}]}),{mode:0o600});
    const freshId=`req_${randomUUID()}`;
    const freshAssignment={...assignment,request_id:freshId,inputs:[{github_repo:'example-owner/fixture',base_sha:git('rev-parse','HEAD')}]};
    const freshStore=new Store(dbPath);
    try{freshStore.submit(freshAssignment,'thread','environment','prepared-http-owner',false,null,'normal',null,freshAssignment,null,null,'host');}finally{freshStore.db.close();}
    const freshClaim=await call('claim',{request_id:freshId,claimant:'dot'});
    assert(freshClaim.claim_id,JSON.stringify(freshClaim));
    const missing=await call('run_check',{request_id:freshId,claim_id:freshClaim.claim_id,check_id:'default'});
    assert.equal(missing.status,'failed',JSON.stringify(missing));assert.match(missing.error,/dependencies_unprepared/);
    const preparation=spawnSync(process.execPath,['bin/dot-worker.mjs','prepare-deps',repo,'--json'],{cwd:path.resolve(new URL('..',import.meta.url).pathname),env,encoding:'utf8',timeout:30000});
    assert.equal(preparation.status,0,preparation.stderr);
    const prepared=JSON.parse(preparation.stdout);
    const good=await call('run_check',{request_id:freshId,claim_id:freshClaim.claim_id,check_id:'default'});
    assert.equal(good.status,'completed',JSON.stringify(good));assert.equal(good.exit_code,0,JSON.stringify(good));
    assert.match(good.output_preview,/HTTP_PREPARED_VERIFIED/);
    assert.equal(good.evidence.host_budget.dependencies.lock_sha256,prepared.lock_sha256);
    assert.equal(good.evidence.host_budget.stop.verified,true);assert.deepEqual(good.evidence.host_budget.stop.remaining_pids,[]);
    assert.equal(fs.existsSync(path.join(repo,'node_modules')),false,'owner preparation must not install in the checkout');
    console.log('PASS authenticated HTTP prepared run_check: named missing-input refusal, owner-only preparation, read-only real backend and persisted identity');
  }
} finally {
  await stopChild(service);
  await new Promise(resolve => jwks.close(resolve));
  const thaw=dir=>{const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())return;fs.chmodSync(dir,0o700);for(const name of fs.readdirSync(dir))thaw(path.join(dir,name));};
  thaw(home);
  fs.rmSync(home, { recursive: true, force: true });
}
