#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('catalog-fixture.invalid');
// Real loopback HTTP catalogs. All identities, keys and state are disposable fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenFile = path.join(root, 'scripts/fixtures/catalog.golden.json');
const goldenBytes = fs.readFileSync(goldenFile, 'utf8');
const golden = JSON.parse(goldenBytes);
const legacyTools = JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.legacy-v46.tools.json', import.meta.url), 'utf8'));
// Two synthetic worker identities use the same pinned catalog digest.
// Keep both literal expectations independent of the server response.
const captures = [
  { label: 'fixture-a', sha256: '01586cba910a8aafff994ddc945d389f69b2c1c99fa6b29a3d56fbd305fecf0b' },
  { label: 'fixture-b', sha256: '01586cba910a8aafff994ddc945d389f69b2c1c99fa6b29a3d56fbd305fecf0b' },
];
const names = ['list_pending', 'claim', 'get', 'ack_message', 'progress', 'finish',
  'list_files', 'read_file', 'apply_patch', 'run_check', 'workspace_result', 'artifact_chunk'];
assert.deepEqual(legacyTools.map(tool => tool.name), names);
const expected = structuredClone(golden);
expected.tools.tools = legacyTools;
for(const info of [expected.discover._meta['io.modelcontextprotocol/serverInfo'],expected.initialize.serverInfo]) {info.name='dot-bridge';info.version='0.2.0';}
const serialize = value => JSON.stringify(value, null, 1) + '\n';
// The legacy fixture omits newer response metadata.
const hash = value => {
  const catalog = structuredClone(value);
  for (const result of Object.values(catalog)) delete result.resultType;
  catalog.discover = { resultType: 'complete', ...catalog.discover };
  for (const result of [catalog.discover, catalog.tools]) { delete result.ttlMs; delete result.cacheScope; }
  return createHash('sha256').update(serialize(catalog)).digest('hex');
};
for (const capture of captures) assert.equal(hash(expected), capture.sha256, capture.label + ' pinned fixture');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-legacy-v46-'));
fs.chmodSync(sandbox, 0o700);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'catalog-fixture', alg: 'RS256', use: 'sig' };
const issuerServer = http.createServer((req, res) => {
  if (req.url !== '/jwks') { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [jwk] }));
});
const children = new Set();
await new Promise(resolve => issuerServer.listen(0, '127.0.0.1', resolve));
const issuer = 'http://127.0.0.1:' + issuerServer.address().port + '/realms/catalog';
const audience = 'https://catalog-fixture.invalid/mcp';
function token(subject) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: issuer, aud: audience, sub: subject, exp: Math.floor(Date.now() / 1000) + 600,
    scope: 'dot-bridge.read dot-bridge.work',
  })).toString('base64url');
  const input = header + '.' + claims;
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
}
function admin(socketPath, route, body, owner) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(owner ? { 'x-owner-capability': owner } : {}) } },
    response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { assert.equal(response.statusCode, 200, text); resolve(JSON.parse(text)); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('fixture admin timeout')));
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timeout); }
}
async function start(label, profile, oauth = false) {
  const home = path.join(sandbox, label);
  fs.mkdirSync(home, { mode: 0o700 });
  const env = fixtureEnv(home, {
    DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: oauth ? 'oauth' : '',
    DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: oauth ? '' : '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1',
    DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_WORKSPACE_ROOT: path.join(home, '.tmp', 'work'),
    ...(profile === undefined ? {} : { DOT_BRIDGE_CATALOG_PROFILE: profile }),
  });
  const cfg = path.join(home, '.config/dot-bridge');
  fs.mkdirSync(cfg, { recursive: true, mode: 0o700 });
  if (oauth) fs.writeFileSync(path.join(cfg, 'oauth.env'),
    'OAUTH_ISSUER=' + issuer + '\nOAUTH_AUDIENCE=' + audience +
    '\nOAUTH_JWKS_URI=http://127.0.0.1:' + issuerServer.address().port +
    '/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture-a,fixture-b\n', { mode: 0o600 });
  // No workers.json: the existing legacy worker has t3 capability, which must
  // not make hidden legacy-v46 names callable. T3 is dry-run, never contacted.
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import { main } from './src/server.mjs'; await main({loopbackOnly:true});"],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '', errorOutput = '', launchError;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  child.on('error', error => { launchError = error; });
  let match;
  for (let i = 0; i < 400; i++) {
    if (launchError) throw launchError;
    match = /MCP listening on 127\.0\.0\.1:(\d+)/.exec(output);
    if (match && output.includes('admin socket')) break;
    if (child.exitCode !== null) throw new Error('fixture startup failed: ' + errorOutput);
    await sleep(25);
  }
  assert(match && output.includes('admin socket'), 'fixture startup timeout: ' + errorOutput);
  const secret = fs.readFileSync(path.join(cfg, 'env'), 'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const socket = path.join(home, '.local/share/dot-bridge/admin.sock');
  async function rpc(method, params = {}, subject = 'fixture-a') {
    const response = await fetch('http://127.0.0.1:' + match[1] + '/' + secret + '/mcp', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', ...(oauth ? { authorization: 'Bearer ' + token(subject) } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return reply.result;
  }
  async function catalog(subject) {
    return {
      discover: await rpc('server/discover', {}, subject),
      initialize: await rpc('initialize', { protocolVersion: '2025-11-25' }, subject),
      tools: await rpc('tools/list', {}, subject),
      events: await rpc('events/list', {}, subject),
    };
  }
  return { child, socket, rpc, catalog };
}
try {
  const defaults = await start('default', undefined);
  const defaultCatalog = await defaults.catalog();
  assert.equal(serialize(defaultCatalog), goldenBytes, 'unchanged default golden bytes');
  await stop(defaults.child);
  const stable = await start('stable', 'stable');
  const stableCatalog = await stable.catalog();
  assert.equal(serialize(stableCatalog), goldenBytes, 'explicit stable golden bytes');
  assert.equal(serialize(stableCatalog), serialize(defaultCatalog), 'stable/default equivalence');
  await stop(stable.child);
  for (const capture of captures) {
    const server = await start(capture.label, 'legacy-v46', true);
    const actual = await server.catalog(capture.label);
    assert.deepEqual(actual, expected, capture.label + ' exact catalog, including all schemas and descriptions');
    assert.equal(hash(actual), capture.sha256, capture.label + ' HTTP capture hash');
    for (const key of ['discover', 'initialize', 'events']) assert.deepEqual(actual[key], expected[key]);
    assert.deepEqual(actual.tools.tools.map(tool => tool.name), names);
    const requestId = 'catalog_' + capture.label;
    const owner = 'fixture-owner-' + capture.label;
    await admin(server.socket, '/submit', {
      assignment: { schema_version: 1, request_id: requestId, brief: 'Local catalog validation fixture.',
        inputs: [], expected_output: 'No execution; schema refusal only.', execution_scope: 'read-only' },
      delivery: 'none', execution: 'none', owner_token: owner,
    });
    const inspect = () => admin(server.socket, '/get?id=' + requestId + '&peek=1', null, owner);
    const before = await inspect();
    assert.equal(before.status, 'queued');
    const reject = async (name, args, pattern) => {
      const result = await server.rpc('tools/call', { name, arguments: args }, capture.label);
      assert.equal(result.isError, true, name);
      assert.match(result.content.map(item => item.text || '').join('\n'), pattern, name);
      const after = await inspect();
      assert.equal(after.status, 'queued', 'invalid calls cannot claim fixture');
      assert.equal(after.claim, before.claim);
      assert.equal(after.report, before.report);
      assert.deepEqual(after.progress, before.progress);
    };
    await reject('claim', { request_id: requestId, claimant: 'fixture', acquisition_id: 'fixture',
      lease_ms: 60000 }, /unknown field lease_ms/);
    await reject('list_pending', { extra: true }, /unknown field extra/);
    const hidden = ['ask_question', 'consume_answer', 'renew_claim', 't3_thread_list', 't3_thread_read',
      't3_thread_create', 't3_thread_send', 't3_thread_wait', 't3_thread_set', 'notify_owner', 'not_a_tool'];
    for (const name of hidden) await reject(name, {}, /unknown tool/);
    // Valid claim still uses normal grant/lease enforcement; omission of the
    // public lease override does not remove the returned deadline.
    const claimed = await server.rpc('tools/call', { name: 'claim',
      arguments: { request_id: requestId, claimant: 'fixture', acquisition_id: 'fixture' } }, capture.label);
    assert.equal(claimed.isError, false);
    const claim = JSON.parse(claimed.content[0].text);
    assert.equal(typeof claim.claim_id, 'string');
    assert(Number.isFinite(Date.parse(claim.lease_expires_at)), 'normal lease remains enforced');
    await stop(server.child);
  }
  assert.equal(fs.readFileSync(goldenFile, 'utf8'), goldenBytes, 'test never rewrites golden');
  console.log('PASS default/stable unchanged; fixture-a/fixture-b legacy-v46 HTTP catalogs and refusal boundaries');
} finally {
  await Promise.all([...children].map(stop));
  await new Promise(resolve => issuerServer.close(resolve));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
