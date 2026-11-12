#!/usr/bin/env node
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
const fetch=fetchForPublicHost('bridge.example');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readLines, listGenerations } from '../src/request-log.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const home = fs.mkdtempSync(path.join(tempRoot, 'dalan-bridge-outcomes-'));
const configDir = path.join(home, '.config/dot-bridge');
fs.mkdirSync(configDir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig' };
let jwksStatus = 503;
let jwksDelay = 0, jwksRequests = 0;
const jwks = http.createServer((req, res) => {
  jwksRequests++;
  const status = jwksStatus;
  const respond = () => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  };
  if (jwksDelay) setTimeout(respond, jwksDelay);
  else respond();
});
await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${jwks.address().port}`;
fs.writeFileSync(path.join(configDir, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=https://bridge.example\nOAUTH_JWKS_URI=${issuer}/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture-subject\n`, { mode: 0o600 });
const logPath = path.join(home, '.local/state/dot-bridge/requests.jsonl');
const logs = () => [...readLines(logPath, { missingOk: true })].filter(Boolean).map(JSON.parse);
const outcomes = () => logs().filter(row => row.kind === 'mcp_outcome');
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for fixture');
};
const token = (claims = {}) => {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: issuer, aud: 'https://bridge.example', exp: Math.floor(Date.now() / 1000) + 300, sub: 'fixture-subject', scope: 'dot-bridge.read dot-bridge.work', ...claims })).toString('base64url');
  const input = `${head}.${body}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
};
const bearer = token();
let child, origin, endpoint, secret;
async function start() {
  let output = '', errors = '';
  child = spawn(process.execPath, ['src/server.mjs'], { cwd: root,
    env: { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: '0', DOT_BRIDGE_LOG_MAX_BYTES: '2048', DOT_BRIDGE_LOG_KEEP: '32', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '', DOT_BRIDGE_T3_DRY_RUN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  await waitFor(() => output.includes('MCP listening') || child.exitCode !== null);
  assert.equal(child.exitCode, null, errors);
  const port = /MCP listening on 0\.0\.0\.0:(\d+)/.exec(output)[1];
  assert.notEqual(port, '0', 'fixture must report its actual bound port');
  origin = `http://127.0.0.1:${port}`;
  secret = fs.readFileSync(path.join(configDir, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  endpoint = `${origin}/${secret}/mcp`;
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
}
async function request(body, auth = bearer, method = 'POST') {
  const before = outcomes().length;
  const response = await fetch(endpoint, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'content-type': 'application/json', 'user-agent': 'Claude-User/1.0 (+Anthropic; private-ua-detail)' }, ...(method === 'POST' ? { body } : {}) });
  const bytes = Buffer.from(await response.arrayBuffer());
  await waitFor(() => outcomes().length === before + 1);
  const outcome = outcomes().at(-1);
  assert.equal(outcome.completion, 'finished');
  assert.equal(outcome.http_status, response.status);
  assert.equal(outcome.response_bytes, bytes.length);
  assert.equal(typeof outcome.duration_ms, 'number');
  assert(outcome.duration_ms >= 0);
  assert.equal(logs().filter(row => row.kind === 'mcp_received' && row.call_id === outcome.call_id).length, 1);
  // Only a fixed class name for the User-Agent is logged, never its text.
  assert.equal(logs().find(row => row.kind === 'mcp_received' && row.call_id === outcome.call_id).ua, 'Claude-User');
  return { response, bytes, outcome, json: bytes.length ? JSON.parse(bytes) : null };
}
const rpc = (method, params = {}, auth = bearer) => request(JSON.stringify({ jsonrpc: '2.0', id: 'private-rpc-id', method, params }), auth);
const tool = (name, args = {}, auth = bearer) => rpc('tools/call', { name, arguments: args }, auth);
const admin = body => new Promise((resolve, reject) => {
  const bytes = JSON.stringify(body);
  const req = http.request({ socketPath: path.join(home, '.local/share/dot-bridge/admin.sock'), path: '/submit', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } }, res => {
    let value = '';
    res.on('data', chunk => { value += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(value) }));
  });
  req.on('error', reject);
  req.end(bytes);
});

try {
  await start();
  const missing = await rpc('tools/list', {}, null);
  assert.equal(missing.response.status, 401);
  assert(missing.response.headers.get('www-authenticate').includes('resource_metadata'));
  assert.equal(missing.outcome.auth_reason, 'missing_bearer');
  assert.equal(missing.outcome.jwks_outcome, 'not_attempted');
  jwksDelay = 150;
  const beforeAuthClose = outcomes().length;
  const beforeJwks = jwksRequests;
  const authClosed = http.request(endpoint, { method: 'POST', headers: { host:'bridge.example', authorization: `Bearer ${bearer}` } });
  authClosed.on('error', () => {});
  authClosed.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  await waitFor(() => jwksRequests > beforeJwks);
  authClosed.destroy();
  await waitFor(() => outcomes().length === beforeAuthClose + 1);
  const pendingAuth = outcomes().at(-1);
  assert.equal(pendingAuth.completion, 'closed');
  assert.equal(pendingAuth.phase, 'auth');
  assert.equal(pendingAuth.auth_outcome, 'pending');
  assert.equal(pendingAuth.auth_reason, null);
  assert.equal(pendingAuth.auth_duration_ms, null);
  assert.equal(pendingAuth.jwks_outcome, 'pending');
  assert.equal(pendingAuth.jwks_duration_ms, null);
  assert.equal(pendingAuth.jwks_http_status, null);
  assert.equal(pendingAuth.http_status, null);
  jwksDelay = 0;
  const unavailable = await rpc('tools/list');
  assert.equal(unavailable.response.status, 401);
  assert.equal(unavailable.outcome.jwks_outcome, 'http_error');
  assert.equal(unavailable.outcome.jwks_http_status, 503);
  jwksStatus = 200;
  const valid = await tool('list_pending');
  assert.equal(valid.json.result.isError, false);
  assert.equal(valid.outcome.tool, 'list_pending');
  assert.equal(valid.outcome.auth_outcome, 'success');
  assert.equal(valid.outcome.jwks_outcome, 'fetched');
  const expired = await rpc('tools/list', {}, token({ exp: 1 }));
  assert.equal(expired.response.status, 401);
  assert.equal(expired.outcome.auth_reason, 'expired');
  const denied = await tool('claim', { request_id: 'req_fixture', claimant: 'dot' }, token({ scope: 'dot-bridge.read' }));
  const neutralDenied = await tool('claim', { request_id: 'req_fixture', claimant: 'dot' }, token({ scope: 'dalan.read' }));
  assert.equal(neutralDenied.json.result.isError, true, 'a neutral read scope must not allow a work tool');
  const neutralList = await rpc('tools/list', {}, token({ scope: 'dalan.read' }));
  assert.equal(neutralList.response.status, 200, 'a neutral scope is accepted');
  const unknownOnly = await rpc('tools/list', {}, token({ scope: 'dalan.admin' }));
  assert.equal(unknownOnly.response.status, 401, 'a token with only unknown scopes is refused');
  assert.equal(denied.json.result.isError, true);
  assert.equal(denied.outcome.tool_error, true);
  assert.equal(denied.outcome.rpc_error_code, null);
  assert(denied.json.result._meta['mcp/www_authenticate']);
  assert(denied.json.result._meta['mcp/www_authenticate'][0].includes('scope="dot-bridge.work"'), 'external issuer: the insufficient_scope challenge keeps the legacy name');
  const disabled = await tool('read_file', { request_id: 'req_fixture', claim_id: 'claim_fixture', path: 'private-path' });
  assert.equal(disabled.outcome.tool_error, true);
  const unsupported = await rpc('private-method-name');
  assert.equal(unsupported.outcome.rpc_method, 'unknown');
  assert.equal(unsupported.outcome.rpc_error_code, -32601);
  const dispatchError = await rpc('events/subscribe');
  assert.equal(dispatchError.response.status, 200);
  assert.equal(dispatchError.outcome.rpc_error_code, -32602);
  const unknown = await tool('private-tool-name', { secret: 'private-argument' });
  assert.equal(unknown.outcome.tool, 'unknown');
  assert.equal(unknown.outcome.tool_error, true);
  const malformed = await request('{');
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.outcome.rpc_error_code, -32700);
  const invalid = await request('null');
  assert.equal(invalid.outcome.rpc_error_code, -32600);
  const notification = await request(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(notification.response.status, 202);
  assert.equal(notification.outcome.response_kind, 'empty');
  const get = await request('', bearer, 'GET');
  assert.equal(get.response.status, 405);

  const assignment = { schema_version: 1, request_id: 'req_fixture', brief: 'private-assignment-text', inputs: [], expected_output: 'result', execution_scope: 'read-only' };
  assert.equal((await admin({ assignment, delivery: 'none', owner_token: 'private-owner-capability' })).status, 200);
  const acquisitionId = 'outcome-recovery-run';
  const claimed = await tool('claim', { request_id: assignment.request_id, claimant: 'dot', acquisition_id: acquisitionId });
  const claimId = JSON.parse(claimed.json.result.content[0].text).claim_id;
  assert(claimId);
  const progress = await tool('progress', { request_id: assignment.request_id, claim_id: claimId, note: 'private-progress-note' });
  assert.equal(progress.json.result.isError, false);
  await stop();
  await start();
  const retry = await tool('claim', { request_id: assignment.request_id, claimant: 'dot', acquisition_id: acquisitionId });
  assert.equal(JSON.parse(retry.json.result.content[0].text).claim_id, claimId, 'restart must preserve claim identity');
  const restored = await tool('get', { request_id: assignment.request_id });
  const restoredBody = JSON.parse(restored.json.result.content[0].text);
  assert(restoredBody.progress.some(row => row.note === 'private-progress-note'));
  // Worker-visible claim activity: claim, progress, claim retry have been recorded when this get runs (get itself counts after it answers).
  assert.deepEqual(Object.keys(restoredBody.claim.activity), ['tool_calls', 'last_tool', 'last_tool_at', 'last_tool_error', 'first_workspace_tool_at']);
  assert.equal(Object.hasOwn(restoredBody.claim,'claim_id'),false,'worker get exposes claim_id');
  assert.equal(Object.hasOwn(restoredBody.claim.activity,'acquisition_id'),false,'worker get exposes acquisition_id');
  assert.equal(restoredBody.claim.activity.tool_calls, 3);
  assert.equal(restoredBody.claim.activity.last_tool, 'claim');
  assert.equal(restoredBody.claim.activity.first_workspace_tool_at, null);
  const again = JSON.parse((await tool('get', { request_id: assignment.request_id })).json.result.content[0].text);
  assert.equal(again.claim.activity.tool_calls, 4);
  assert.equal(again.claim.activity.last_tool, 'get');
  const timeline = outcomes().filter(row => row.request_id === assignment.request_id).map(row => row.tool);
  assert.deepEqual(timeline.slice(-4), ['progress', 'claim', 'get', 'get'], 'request_id lets the log rebuild a per-job timeline: ' + timeline);
  assert(outcomes().every(row => row.request_id === null || /^[-\w]{8,128}$/.test(row.request_id)));
  assert.equal(outcomes().find(row => row.tool === 'unknown').request_id, null, 'unknown tool logs no request_id');

  const count = outcomes().length;
  const received = logs().filter(row => row.kind === 'mcp_received').length;
  const aborted = http.request(endpoint, { method: 'POST', headers: { host:'bridge.example', authorization: `Bearer ${bearer}`, 'content-length': 10000 } });
  aborted.on('error', () => {});
  aborted.write('{"jsonrpc":');
  await waitFor(() => logs().filter(row => row.kind === 'mcp_received').length === received + 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  aborted.destroy();
  await waitFor(() => outcomes().length === count + 1);
  const closed = outcomes().at(-1);
  assert.equal(closed.completion, 'closed');
  assert.equal(closed.http_status, null, 'do not invent HTTP 200 for a disconnected request');
  assert.equal(closed.error_type, 'request_aborted');
  assert.equal(closed.auth_outcome, 'success');
  assert.equal(closed.phase, 'body', 'distinguish an incomplete request body from tool execution');
  const beforeLarge = outcomes().length;
  let largeResponse;
  try {
    largeResponse = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: 'x'.repeat(1024 * 1024 + 1) });
    await largeResponse.arrayBuffer();
  } catch {
    // The body reader can destroy the socket while rejecting an oversized body.
  }
  await waitFor(() => outcomes().length === beforeLarge + 1);
  const tooLarge = outcomes().at(-1);
  assert.equal(tooLarge.error_type, 'body_too_large');
  assert(['finished', 'closed'].includes(tooLarge.completion));
  if (largeResponse) assert.equal(largeResponse.status, 400);
  // A request that matches no route is logged with its method and a path shape that never carries a long segment.
  const probe = await fetch(`${origin}/A1${'z'.repeat(46)}/mcp?private-path=1`, { method: 'GET', headers: { authorization: 'Bearer private-probe-token', 'user-agent': 'python-httpx/0.27 private-ua-detail' } });
  assert.equal(probe.status, 404);
  await waitFor(() => logs().some(row => row.kind === 'mcp_inbound' && row.route === 'other'));
  const other = logs().findLast(row => row.kind === 'mcp_inbound' && row.route === 'other');
  assert.deepEqual([other.status, other.http_method, other.path_shape, other.auth_header_present, other.ua], [404, 'GET', '/<48 chars>/mcp', true, 'python']);
  assert.equal(fs.readFileSync(logPath, 'utf8').includes('private-ua-detail'), false);
  const wellKnown = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  assert.equal(wellKnown.status, 404);
  await waitFor(() => logs().filter(row => row.kind === 'mcp_inbound' && row.route === 'other').length === 2);
  assert.deepEqual(logs().findLast(row => row.kind === 'mcp_inbound' && row.route === 'other').path_shape, '/.well-known/oauth-authorization-server');
  // Short and all-lowercase unknown segments are still replaced, and the real secret never reaches a 404 line.
  for (const [url, shape] of [['/private-token-123/mcp', '/<17 chars>/mcp'], [`/${'a'.repeat(30)}/mcp`, '/<30 chars>/mcp'], [`/${secret}/wrong?probe=1`, `/<${secret.length} chars>/<5 chars>`]]) {
    const before = logs().filter(row => row.kind === 'mcp_inbound' && row.route === 'other').length;
    assert.equal((await fetch(`${origin}${url}`)).status, 404);
    await waitFor(() => logs().filter(row => row.kind === 'mcp_inbound' && row.route === 'other').length === before + 1);
    assert.equal(logs().findLast(row => row.kind === 'mcp_inbound' && row.route === 'other').path_shape, shape);
  }
  // Hostile paths: the logged shape is bounded and never carries segment text.
  const hostile = [
    ['/' + 'q'.repeat(8000) + '/mcp', '/<999 chars>/mcp'],
    ['/\u043a\u043b\u044e\u0447-\u79d8\u5bc6/mcp', '/<43 chars>/mcp'],
    ['/%6dcp', '/<5 chars>'],
    ['//', '/<0 chars>/<0 chars>'],
    ['/s1/s2/s3/s4/s5/s6/s7/s8', '/<2 chars>/<2 chars>/<2 chars>/<2 chars>/<2 chars>/<2 chars>'],
  ];
  for (const [url, shape] of hostile) {
    const before = logs().filter(row => row.kind === 'mcp_inbound' && row.route === 'other').length;
    assert.equal((await fetch(`${origin}${url}`)).status, 404);
    await waitFor(() => logs().filter(row => row.kind === 'mcp_inbound' && row.route === 'other').length === before + 1);
    const logged = logs().findLast(row => row.kind === 'mcp_inbound' && row.route === 'other').path_shape;
    assert.equal(logged, shape);
    assert(logged.length <= 100, 'path_shape stays bounded');
  }
  // A 1 MB segment is refused by the HTTP parser before routing; it must not reach the log in any form.
  await fetch(`${origin}/${'m'.repeat(1 << 20)}/mcp`).then(res => assert([404, 414, 431].includes(res.status)), () => {});
  const raw = [...readLines(logPath)].join('\n');
  assert(listGenerations(logPath).length > 1, 'MCP calls rotated the request log');
  for (const privateValue of [secret, bearer, 'private-rpc-id', 'private-method-name', 'private-tool-name', 'private-argument', 'private-path', 'private-assignment-text', 'private-owner-capability', 'private-probe-token', 'A1zzzzzzzz', 'private-token-123', 'a'.repeat(30), 'private-progress-note', 'qqqqqqqq', '\u043a\u043b\u044e\u0447', 'mmmmmmmm']) assert(!raw.includes(privateValue), `log leaked ${privateValue.slice(0, 20)}`);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  console.log('PASS MCP outcomes: OAuth/JWKS failures, HTTP/JSON-RPC/tool errors, bytes, disconnect, redaction and claim recovery');
} finally {
  await stop();
  jwks.closeAllConnections();
  await new Promise(resolve => jwks.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
