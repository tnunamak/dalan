#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('catalog-fixture.invalid');
// Real loopback HTTP catalogs. All identities, keys and state are disposable fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sandbox = fs.mkdtempSync(path.resolve('fixture-'));
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
  async function rpc(method, params = {}, subject = 'fixture-a', protocolVersion = '2026-07-28') {
    const response = await fetch('http://127.0.0.1:' + match[1] + '/' + secret + '/mcp', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion, 'mcp-method': method, ...(oauth ? { authorization: 'Bearer ' + token(subject) } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {...params, _meta: {'io.modelcontextprotocol/protocolVersion':protocolVersion,'io.modelcontextprotocol/clientInfo':{name:'mcpval',version:'1.0.0'},'io.modelcontextprotocol/clientCapabilities':{}}} }),
    });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const reply = JSON.parse(raw);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return reply;
  }
  // A notification carries no id, so the server answers 202 with no body
  // (see src/server.mjs: a request without an id is answered 202 before
  // dispatch). There is therefore no JSON reply to schema-check here;
  // the 202 asserts the notifications/initialized step was accepted.
  async function notify(method, protocolVersion = '2026-07-28', subject = 'fixture-a') {
    const response = await fetch('http://127.0.0.1:' + match[1] + '/' + secret + '/mcp', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion, 'mcp-method': method, ...(oauth ? { authorization: 'Bearer ' + token(subject) } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
    assert.equal(response.status, 202, method + ': expected 202, got ' + response.status);
  }
  return { rpc, notify };
}
// Revisions the server answers initialize for (src/server.mjs, the
// initialize case), in addition to the current 2026-07-28 revision.
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SCHEMA_COMMIT = 'd0e246ea3c69eafaa2806bc4cd28025703ba2c2b';
const schemaPath = version => path.join(root, 'test-fixtures/mcp-schema', version, 'schema.json');
const schemaUrl = version => 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/' + SCHEMA_COMMIT + '/schema/' + version + '/schema.json';
// One fresh Ajv instance per revision: the revisions share schema keys,
// so reusing a single instance would collide across revisions.
// Fails with a clear message when the fixture file is missing.
function loadValidator(version) {
  const file = schemaPath(version);
  assert(fs.existsSync(file), 'missing MCP schema fixture for ' + version + ': ' + file + ' — vendor it from ' + schemaUrl(version));
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Revisions up to 2025-06-18 are draft-07 and keep their types under
  // definitions; later ones are 2020-12 and use $defs.
  const draft07 = String(schema?.$schema || '').includes('draft-07');
  const defsKey = draft07 ? 'definitions' : '$defs';
  assert(schema && typeof schema === 'object' && schema[defsKey] && !String(schema.$comment || '').startsWith('PLACEHOLDER'),
    'placeholder MCP schema fixture for ' + version + ': ' + file + ' — replace it with the official schema from ' + schemaUrl(version));
  const ajv = draft07 ? new Ajv({ allErrors: true, strict: false }) : new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema, 'mcp');
  return (definition, reply) => {
    const defs = schema[defsKey];
    if (defs[definition]) {
      const validate = ajv.compile({ $ref: 'mcp#/' + defsKey + '/' + definition });
      assert(validate(reply), version + ' ' + definition + ': ' + JSON.stringify(validate.errors));
      return;
    }
    // Older revisions name only the result type (e.g. ListToolsResult
    // instead of ListToolsResultResponse); validate the result against
    // that, plus the JSON-RPC envelope, rather than assuming the newer
    // per-method response names exist in every revision.
    const resultDefinition = definition.replace(/Response$/, '');
    assert(defs[resultDefinition], 'schema for ' + version + ' has neither ' + defsKey + '/' + definition + ' nor ' + defsKey + '/' + resultDefinition);
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.id, 1);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    const validate = ajv.compile({ $ref: 'mcp#/' + defsKey + '/' + resultDefinition });
    assert(validate(reply.result), version + ' ' + resultDefinition + ': ' + JSON.stringify(validate.errors));
  };
}
const validateCurrent = loadValidator('2026-07-28');
try {
  const server = await start('oauth', undefined, true);
  for (const [method, params, definition] of [
    ['server/discover', {}, 'DiscoverResultResponse'],
    ['tools/list', {}, 'ListToolsResultResponse'],
    ['tools/call', { name: 'list_pending', arguments: {} }, 'CallToolResultResponse'],
  ]) {
    const reply = await server.rpc(method, params);
    validateCurrent(definition, reply);
    if (method === 'tools/call') assert.equal(reply.result.isError, false);
    console.log('PASS', method, definition);
  }
  // Legacy revisions: initialize, then notifications/initialized, then
  // tools/list and one tools/call, each with that revision's header and
  // _meta protocolVersion, each reply validated against that revision's
  // official schema. The server is stateless across these calls (it does
  // not track an initialized session), so the sequence is exercised in
  // order on one server instance, not as a stateful session.
  for (const version of LEGACY_VERSIONS) {
    const validate = loadValidator(version);
    const init = await server.rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'mcpval', version: '1.0.0' } }, 'fixture-a', version);
    assert.equal(init.result.protocolVersion, version, 'initialize for ' + version + ' answered with ' + init.result.protocolVersion);
    validate('InitializeResultResponse', init);
    console.log('PASS', version, 'initialize', 'InitializeResultResponse');
    await server.notify('notifications/initialized', version);
    for (const [method, params, definition] of [
      ['tools/list', {}, 'ListToolsResultResponse'],
      ['tools/call', { name: 'list_pending', arguments: {} }, 'CallToolResultResponse'],
    ]) {
      const reply = await server.rpc(method, params, 'fixture-a', version);
      validate(definition, reply);
      if (method === 'tools/call') assert.equal(reply.result.isError, false);
      console.log('PASS', version, method, definition);
    }
  }
  // Unknown version: the server must not echo it. Validate the reply
  // against the schema of the version the server actually answers with,
  // then run the same post-initialize sequence under that version.
  const unknown = await server.rpc('initialize', { protocolVersion: '1900-01-01', capabilities: {}, clientInfo: { name: 'mcpval', version: '1.0.0' } }, 'fixture-a', '1900-01-01');
  assert.notEqual(unknown.result.protocolVersion, '1900-01-01', 'server echoed unknown protocol version 1900-01-01');
  const answered = unknown.result.protocolVersion;
  const validateAnswered = loadValidator(answered);
  validateAnswered('InitializeResultResponse', unknown);
  console.log('PASS unknown-version initialize answered-as', answered, 'InitializeResultResponse');
  await server.notify('notifications/initialized', answered);
  for (const [method, params, definition] of [
    ['tools/list', {}, 'ListToolsResultResponse'],
    ['tools/call', { name: 'list_pending', arguments: {} }, 'CallToolResultResponse'],
  ]) {
    const reply = await server.rpc(method, params, 'fixture-a', answered);
    validateAnswered(definition, reply);
    if (method === 'tools/call') assert.equal(reply.result.isError, false);
    console.log('PASS unknown-version answered-as', answered, method, definition);
  }
} finally {
  await Promise.all([...children].map(stop));
  await new Promise(resolve => issuerServer.close(resolve));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
