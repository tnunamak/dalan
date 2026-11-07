#!/usr/bin/env node
// `dalan mcp` is a local stdio MCP server that lets a requester agent submit, wait for and read jobs as tool calls.
// This test runs the real stdio process against a hermetic bridge in a temp home. A built-in demo worker, reached
// through the real OAuth flow, finishes the job so the whole submit -> wait -> result loop is exercised.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { beginPairing, openSession, DEMO_REDIRECT } from '../src/demo-worker.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const WORKER = 'acme';
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const home = fs.mkdtempSync(path.join(tempRoot, 'dalan-mcp-'));
const port = await reservedPort();
const env = { PATH: process.env.PATH, HOME: home, DALAN_LOOPBACK: '1', DALAN_AUTH_MODE: 'builtin', DALAN_PORT: String(port) };
const dalan = args => new Promise((resolve, reject) => execFile(process.execPath, [path.join(repo, 'bin/dalan.mjs'), ...args], { env, cwd: repo, timeout: 30_000 },
  (error, stdout, stderr) => error ? reject(new Error(`dalan ${args.slice(0, 2).join(' ')}: ${(stderr || stdout || error.message).trim()}`)) : resolve(stdout)));
const log = path.join(home, 'server.log');
let server, mcp;
const stdoutLines = [];
const stderrChunks = [];
const pending = new Map();
const send = frame => mcp.stdin.write(`${JSON.stringify(frame)}\n`);
let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 60_000);
  pending.set(id, value => { clearTimeout(timer); resolve(value); });
  send({ jsonrpc: '2.0', id, method, params });
});
const call = async (name, args) => {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, `tools/call ${name} must not be a transport error: ${JSON.stringify(response.error)}`);
  return response.result;
};
const textOf = result => JSON.parse(result.content[0].text);
try {
  await dalan(['init', '--worker', WORKER, '--public-url', `http://127.0.0.1:${port}`]);
  const fd = fs.openSync(log, 'w', 0o600);
  server = spawn(process.execPath, [path.join(repo, 'src/server.mjs')], { env, cwd: repo, stdio: ['ignore', fd, fd] });
  for (let i = 0; !/MCP listening/.test(fs.readFileSync(log, 'utf8')); i++) {
    assert.ok(i < 300 && server.exitCode === null, `server did not start:\n${fs.readFileSync(log, 'utf8')}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const configDir = path.join(home, '.config/dalan');
  const secret = /^BRIDGE_PATH_SECRET=(.+)$/m.exec(fs.readFileSync(path.join(configDir, 'env'), 'utf8'))[1];
  const mcpUrl = `http://127.0.0.1:${port}/${secret}/mcp`;
  await dalan(['connect', 'allow-callback', 'http://127.0.0.1/callback']);
  await dalan(['connect', 'start', '--worker', WORKER]);
  const pairing = await beginPairing(mcpUrl);
  await dalan(['connect', 'approve', pairing.code, '--worker', WORKER, '--confirm-redirect', DEMO_REDIRECT, '--replace']);
  const workerCall = await openSession(mcpUrl, await pairing.complete());

  mcp = spawn(process.execPath, [path.join(repo, 'bin/dalan.mjs'), 'mcp'], { env, cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  mcp.stderr.on('data', chunk => stderrChunks.push(String(chunk)));
  readline.createInterface({ input: mcp.stdout }).on('line', line => {
    stdoutLines.push(line);
    const frame = JSON.parse(line); // stdout carries protocol frames only: anything else throws here
    assert.equal(frame.jsonrpc, '2.0');
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  });

  // initialize: version negotiation like the main server.
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.ok(init.capabilities.tools);
  assert.equal(init.serverInfo.name, 'dalan-mcp');
  const unknown = (await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).result;
  assert.equal(unknown.protocolVersion, '2025-11-25');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // tools/list: exact names, schemas and annotations.
  const tools = (await rpc('tools/list', {})).result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ['dalan_result', 'dalan_status', 'dalan_submit', 'dalan_wait']);
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  for (const name of ['dalan_status', 'dalan_result', 'dalan_wait']) assert.equal(byName[name].annotations.readOnlyHint, true, name);
  assert.equal(byName.dalan_submit.annotations.readOnlyHint, false);
  assert.equal(byName.dalan_submit.annotations.destructiveHint, false);
  assert.deepEqual(byName.dalan_wait.inputSchema.required, ['request_id']);
  assert.equal(byName.dalan_wait.inputSchema.properties.timeout_seconds.maximum, 300);

  // dalan_status reaches the bridge through the admin socket.
  const status = await call('dalan_status', {});
  assert.notEqual(status.isError, true, JSON.stringify(status));
  assert.equal(typeof textOf(status), 'object');

  // submit -> worker finishes -> wait -> result
  const requestId = `req_${randomUUID()}`;
  const assignment = { schema_version: 1, request_id: requestId, brief: 'Report the exact phrase: mcp roundtrip report.', inputs: [], expected_output: 'Text report.', execution_scope: 'read-only' };
  const submitted = await call('dalan_submit', { assignment, execution: 'none' });
  assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
  assert.ok(JSON.stringify(textOf(submitted)).includes(requestId), 'submit returns the request id');
  assert.equal(textOf(submitted).recovery.get, `dalan get ${requestId}`);

  // A resubmission of the same assignment is idempotent, as in the CLI.
  const again = await call('dalan_submit', { assignment, execution: 'none' });
  assert.notEqual(again.isError, true, JSON.stringify(again));

  const early = await call('dalan_wait', { request_id: requestId, timeout_seconds: 1 });
  assert.notEqual(early.isError, true, 'a wait timeout is a state, not an error');
  assert.equal(textOf(early).status, 'timeout');
  const notFinished = await call('dalan_result', { request_id: requestId });
  assert.notEqual(notFinished.isError, true);
  assert.notEqual(textOf(notFinished).status, 'finished');

  const { claim_id } = await workerCall('claim', { request_id: requestId, claimant: 'acme-agent' });
  await workerCall('finish', { request_id: requestId, claim_id, outcome: 'completed', summary: 'mcp roundtrip report', result: 'mcp roundtrip report' });
  const waited = await call('dalan_wait', { request_id: requestId, timeout_seconds: 20 });
  assert.notEqual(waited.isError, true, JSON.stringify(waited));
  assert.equal(textOf(waited).status, 'finished');
  const result = await call('dalan_result', { request_id: requestId });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(textOf(result).status, 'finished');
  assert.equal(textOf(result).report.result, 'mcp roundtrip report');
  assert.deepEqual(result.structuredContent, textOf(result));

  // Redaction and the size cap apply to a finished report.
  const bigId = `req_${randomUUID()}`;
  await call('dalan_submit', { assignment: { ...assignment, request_id: bigId }, execution: 'none' });
  const bigClaim = await workerCall('claim', { request_id: bigId, claimant: 'acme-agent' });
  const secretLine = `token ${'ghp_'}${'a1B2c3D4e5F6g7H8i9J0k1L2'}`;
  await workerCall('finish', { request_id: bigId, claim_id: bigClaim.claim_id, outcome: 'completed', summary: 'big', result: `${secretLine}\n${'x'.repeat(60_000)}` });
  const big = await call('dalan_result', { request_id: bigId });
  assert.notEqual(big.isError, true, JSON.stringify(big).slice(0, 500));
  assert.ok(!big.content[0].text.includes('a1B2c3D4e5F6g7H8i9J0k1L2'), 'secrets are redacted');
  assert.ok(big.content[0].text.length <= 34_000, `capped: ${big.content[0].text.length}`);
  assert.match(big.content[0].text, /truncated/);

  // A refused submission is a tool result with isError, carrying the CLI's verdict.
  const refused = await call('dalan_submit', { assignment: { ...assignment, request_id: `req_${randomUUID()}`, brief: '' }, execution: 'none', dry_run: true });
  assert.equal(refused.isError, true, JSON.stringify(refused));
  assert.match(refused.content[0].text, /"verdict":\s*"(clarify|reject)"/);
  const badShape = await call('dalan_submit', { assignment: { schema_version: 1, brief: 'no id' } });
  assert.equal(badShape.isError, true);
  assert.match(badShape.content[0].text, /request_id/);

  // Bad arguments and unknown ids are tool errors, not crashes or transport errors.
  const noId = await call('dalan_wait', {});
  assert.equal(noId.isError, true);
  const extra = await call('dalan_status', { surprise: true });
  assert.equal(extra.isError, true);
  const unknownRequest = await call('dalan_result', { request_id: 'req_does_not_exist' });
  assert.equal(unknownRequest.isError, true);
  const unknownTool = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  assert.equal((await rpc('no/such', {})).error.code, -32601);
  assert.deepEqual((await rpc('ping', {})).result, {});

  // A malformed frame gets a parse error and the process keeps serving.
  const parseError = new Promise(resolve => pending.set(null, resolve));
  mcp.stdin.write('{this is not json\n');
  const parsed = await parseError;
  assert.equal(parsed.error.code, -32700);
  assert.equal(parsed.id, null);
  assert.equal(mcp.exitCode, null, 'the process survives a malformed frame');
  assert.equal(typeof (await call('dalan_status', {})).content[0].text, 'string');

  // Closing stdin ends the process cleanly.
  mcp.stdin.end();
  const code = await new Promise(resolve => mcp.once('exit', resolve));
  assert.equal(code, 0);
  assert.ok(stdoutLines.length > 10);
  console.log('dalan-mcp-test: ok');
} finally {
  if (mcp && mcp.exitCode === null) mcp.kill('SIGKILL');
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
  if (process.exitCode) console.error(`mcp stderr:\n${stderrChunks.join('')}\nserver log:\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''}`);
  fs.rmSync(home, { recursive: true, force: true });
}
