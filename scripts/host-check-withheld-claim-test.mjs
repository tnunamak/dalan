#!/usr/bin/env node
import './require-host-sandbox.mjs';
// A host job on a repository-wide scope withholds sensitive files at admission and records them in scope_excluded.
// claim and get have no prepared checkout, so they must advertise checks from that persisted record. They must not
// fall back to "read isolation unavailable" (nothing would run), and they must still refuse when the record does not
// account for every sensitive file in the pinned tree.
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { stopChild } from '../src/test-support/process.mjs';
import { writeOwnerHostChecks } from './lib/owner-host-checks.mjs';

const fetch = fetchForPublicHost('dot-bridge.example.test');
const scratch = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const home = fs.mkdtempSync(path.join(scratch, 'hw-'));
const repo = path.join(home, 'repo');
const config = path.join(home, '.config/dot-bridge');
fs.mkdirSync(repo); fs.mkdirSync(config, { recursive: true });
process.env.HOME = home;
process.env.DALAN_WORKSPACE_ROOT = path.join(home, 'work');
process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
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
const NODE = '/runtime/node';
const PROBE = `const fs=require('fs');for(const p of ['.env','keys/server.pem'])if(fs.existsSync(p))throw Error('withheld file present: '+p);console.log('WITHHELD_ABSENT_OK');`;
fs.mkdirSync(path.join(repo, 'test'));
fs.writeFileSync(path.join(repo, 'test/probe.js'), PROBE);
fs.writeFileSync(path.join(repo, 'README.md'), 'readme\n');
fs.writeFileSync(path.join(repo, '.env'), 'SECRET_A=abc\n');
git('add', '.'); git('commit', '-qm', 'one sensitive file');
const baseOne = git('rev-parse', 'HEAD');
fs.mkdirSync(path.join(repo, 'keys'));
fs.writeFileSync(path.join(repo, 'keys/server.pem'), 'PEM-BODY\n');
git('add', '.'); git('commit', '-qm', 'second sensitive file');
const baseTwo = git('rev-parse', 'HEAD');
writeOwnerHostChecks(home, 'example-owner/fixture', { default: { argv: [NODE, 'test/probe.js'], timeout_ms: 30000, output_bytes: 65536 } });
fs.writeFileSync(path.join(config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n`, { mode: 0o600 });
fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify({ default_execution: 'host', workers: { dot: { workspaceAllowed: true, connections: [{ issuer, subject: 'dot', client_id: 'fixture-client' }], repos: ['example-owner/fixture'] } } }), { mode: 0o600 });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'withheld-claim-test', use: 'sig' };
const jwks = http.createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
await new Promise(resolve => jwks.listen(jwksPort, '127.0.0.1', resolve));
// DALAN_MIN_FREE_BYTES is set for this service only. This scenario checks withheld-scope admission, not pressure eviction;
// on a small fixture filesystem the default 30 GiB floor would start unrelated mirror cleanup that races the test's own mirror fetch.
const env = { ...process.env, DALAN_MIN_FREE_BYTES: '0', HOME: home, DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_T3_DRY_RUN: '1', DALAN_HOST_CHECKS: '1', DOT_BRIDGE_WORKSPACE_ROOT: path.join(home, 'work'), DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE: repo };
const service = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve(new URL('..', import.meta.url).pathname), env, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false, stderr = '';
service.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; });
service.stderr.on('data', b => { stderr += String(b); });
const token = () => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'withheld-claim-test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 300, sub: 'dot', azp: 'fixture-client', scope: 'dot-bridge.read dot-bridge.work' })).toString('base64url');
  const body = `${header}.${claims}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
};

try {
  for (let i = 0; i < 800 && !ready; i++) await new Promise(resolve => setTimeout(resolve, 25));
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
  const { validateSubmission } = await import('../src/submission-policy.mjs');
  const dbPath = path.join(home, '.local/share/dot-bridge/bridge.db');
  const submit = payload => {
    const store = new Store(dbPath);
    try { store.submit(payload, 'thread', 'environment', 'http-owner', false, null, 'normal', null, payload, null, null, 'host'); } finally { store.db.close(); }
  };
  const open = (base, mutate = a => a) => {
    const request_id = `req_${randomUUID()}`;
    const admitted = validateSubmission({ schema_version: 1, request_id, brief: 'Run checks.', expected_output: 'Patch', execution_scope: 'implementation', scope_paths: ['.'], inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }] }, { worker: 'dot' });
    const stored = mutate(admitted);
    submit(stored);
    return { id: request_id, admitted: stored };
  };

  // 1. Admission withholds the one sensitive file; claim and get report the checks as available.
  const one = open(baseOne);
  assert.deepEqual(one.admitted.scope_excluded.map(e => e.path), ['.env'], 'admission withholds the sensitive file');
  assert.deepEqual(one.admitted.scope_paths, ['.']);
  const claim = await call('claim', { request_id: one.id, claimant: 'dot' });
  assert(claim.claim_id, JSON.stringify(claim));
  assert.deepEqual(claim.available_checks, ['default'], `claim must advertise the check: ${claim.host_execution_unavailable_reason}`);
  assert.equal(claim.host_execution_available, true);
  // The worker is told what the id runs and where, not just the id.
  assert.deepEqual(claim.available_check_details, { default: 'node test/probe.js (limit 30 s)' });
  assert.match(claim.check_guidance, /bridge sandbox/);
  assert.match(claim.check_guidance, /check_id \(not check or name\)/);
  const got = await call('get', { request_id: one.id });
  assert.deepEqual(got.available_check_details, claim.available_check_details, 'get describes the same checks as claim');
  assert.deepEqual(got.available_checks, ['default'], `get must advertise the check: ${got.host_execution_unavailable_reason}`);
  assert.equal(got.host_execution_available, true);
  // The advertised check really runs, and the sensitive file is absent from what it sees.
  const ran = await call('run_check', { request_id: one.id, claim_id: claim.claim_id, check_id: 'default' });
  assert.equal(ran.status, 'completed', JSON.stringify(ran));
  assert.equal(ran.exit_code, 0, JSON.stringify(ran));
  assert.match(ran.output_preview, /WITHHELD_ABSENT_OK/);
  const finish = (id, claim_id) => call('finish', { request_id: id, claim_id, outcome: 'blocked', summary: 'Fixture is done', result: 'Fixture is done.' });
  await finish(one.id, claim.claim_id);
  console.log('PASS withheld host job: claim and get advertise the check from the persisted exclusions; the check runs without the sensitive file');

  // 2. Negative: the record does not account for a sensitive file in the pinned tree (a policy change or a hand-edited record).
  const partial = open(baseTwo, a => ({ ...a, scope_excluded: a.scope_excluded.filter(e => e.path === '.env') }));
  assert.deepEqual(partial.admitted.scope_excluded.map(e => e.path), ['.env']);
  const partialClaim = await call('claim', { request_id: partial.id, claimant: 'dot' });
  assert(partialClaim.claim_id, JSON.stringify(partialClaim));
  assert.deepEqual(partialClaim.available_checks, []);
  assert.equal(partialClaim.host_execution_available, false);
  assert.match(partialClaim.host_execution_unavailable_reason, /scope_paths_read_isolation_unavailable/);
  const partialGet = await call('get', { request_id: partial.id });
  assert.deepEqual(partialGet.available_checks, []);
  assert.match(partialGet.host_execution_unavailable_reason, /scope_paths_read_isolation_unavailable/);
  const refused = await call('run_check', { request_id: partial.id, claim_id: partialClaim.claim_id, check_id: 'default' });
  assert.equal(refused.status, 'capability_not_available', JSON.stringify(refused));
  assert.match(refused.reason, /scope_paths_read_isolation_unavailable/);

  await finish(partial.id, partialClaim.claim_id);

  // 3. Negative: exclusions never make a narrowed scope runnable; the executor still exposes the whole checkout.
  const narrow = open(baseOne, a => ({ ...a, scope_paths: ['test'] }));
  assert.deepEqual(narrow.admitted.scope_excluded.map(e => e.path), ['.env']);
  const narrowClaim = await call('claim', { request_id: narrow.id, claimant: 'dot' });
  assert.deepEqual(narrowClaim.available_checks, []);
  assert.equal(narrowClaim.host_execution_available, false);
  assert.match(narrowClaim.host_execution_unavailable_reason, /scope_paths_read_isolation_unavailable/);
  await finish(narrow.id, narrowClaim.claim_id);

  // 4. Negative: a malformed persisted exclusion entry refuses with the isolation reason; it does not fail the claim or get.
  for (const bad of [[{ path: '../escape' }], [{ path: 42 }], [null]]) {
    const malformed = open(baseOne, a => ({ ...a, scope_excluded: bad }));
    const badClaim = await call('claim', { request_id: malformed.id, claimant: 'dot' });
    assert(badClaim.claim_id, JSON.stringify(badClaim));
    assert.deepEqual(badClaim.available_checks, []);
    assert.equal(badClaim.host_execution_available, false);
    assert.match(badClaim.host_execution_unavailable_reason, /scope_paths_read_isolation_unavailable/);
    const badGet = await call('get', { request_id: malformed.id });
    assert.deepEqual(badGet.available_checks, []);
    assert.match(badGet.host_execution_unavailable_reason, /scope_paths_read_isolation_unavailable/);
    await finish(malformed.id, badClaim.claim_id);
  }
  console.log('PASS unproven isolation: an unaccounted sensitive file, a narrowed scope or a malformed record still refuses');
} finally {
  await stopChild(service);
  await new Promise(resolve => jwks.close(resolve));
  const thaw = dir => { const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) return; fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) thaw(path.join(dir, name)); };
  thaw(home);
  fs.rmSync(home, { recursive: true, force: true });
}
