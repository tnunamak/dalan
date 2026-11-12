#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reservedPort } from '../src/test-support/port.mjs';
import { defaultPath } from '../src/paths.mjs';
import { acceptsMcpEventStream, beginMcpEventStream, mcpResponseText } from '../src/mcp-sse.mjs';
import { createBuiltinHttpServer } from '../src/builtin-http.mjs';
import { createGate } from '../src/try-exposure.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'dalan-mcp-sse-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
let service = null, proxy = null;
const captured = [];

function launch(args, env, cwd = repo) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  return { child, output: () => output, errors: () => errors };
}

async function waitForReady(instance, label) {
  for (let i = 0; i < 300; i++) {
    if (/MCP listening on/.test(instance.output())) return;
    if (instance.child.exitCode !== null) throw new Error(`${label} exited before listening: ${instance.errors()}`);
    await sleep(25);
  }
  throw new Error(`${label} did not listen: ${instance.errors()}`);
}

async function stop(instance) {
  if (!instance || instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  instance.child.kill('SIGTERM');
  for (let i = 0; i < 200 && instance.child.exitCode === null && instance.child.signalCode === null; i++) await sleep(25);
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    instance.child.kill('SIGKILL');
    for (let i = 0; i < 200 && instance.child.exitCode === null && instance.child.signalCode === null; i++) await sleep(25);
  }
}

function request({ port, pathname, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathname, headers }, res => {
      const chunks = [], arrivals = [];
      res.on('data', chunk => { chunks.push(chunk); arrivals.push(performance.now()); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(), arrivals }));
      res.on('aborted', () => reject(new Error('response was cut off')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  assert.equal(acceptsMcpEventStream('application/json, text/event-stream'), true);
  assert.equal(acceptsMcpEventStream('text/event-stream;q=0'), false);
  assert.equal(mcpResponseText(': keepalive\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":"1"}\r\n\r\n'), '{"jsonrpc":"2.0",\n"id":"1"}');
  class FakeResponse extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.frames = []; this.endCount = 0; }
    writeHead(status, headers) { this.status = status; this.headers = headers; }
    write(frame) { this.frames.push(frame); return true; }
    end() { this.ended = true; this.endCount++; this.emit('finish'); }
  }
  const interval = { unref() {} };
  let registeredInterval = null, intervalClears = 0;
  const fakeResponse = new FakeResponse();
  beginMcpEventStream(fakeResponse, { setIntervalFn: (fn, ms) => { assert.equal(ms, 20_000); registeredInterval = { fn, ms, handle: interval }; return interval; }, clearIntervalFn: handle => { assert.equal(handle, interval); intervalClears++; } });
  assert.equal(fakeResponse.frames[0], ': keepalive\n\n');
  fakeResponse.emit('close');
  assert.equal(intervalClears, 1, 'disconnect clears the heartbeat timer');
  assert.equal(registeredInterval.ms, 20_000, 'production heartbeat period is 20 seconds');
  registeredInterval.fn();
  assert.equal(fakeResponse.frames.length, 1, 'a disconnected response receives no later heartbeat');
  const closeDuringStart = new FakeResponse(); let leakedIntervals = 0;
  closeDuringStart.write = function(frame) { this.frames.push(frame); this.destroyed = true; this.emit('close'); return false; };
  beginMcpEventStream(closeDuringStart, { setIntervalFn: () => { leakedIntervals++; return interval; }, clearIntervalFn: () => {} });
  assert.equal(leakedIntervals, 0, 'a synchronous close during the first heartbeat cannot install a timer');
  const alreadyDestroyed = new FakeResponse(); alreadyDestroyed.destroyed = true;
  beginMcpEventStream(alreadyDestroyed, { setIntervalFn: () => { leakedIntervals++; return interval; }, clearIntervalFn: () => {} });
  assert.equal(leakedIntervals, 0, 'an already-destroyed response cannot install a timer');
  const endedResponse = new FakeResponse();
  const endedStream = beginMcpEventStream(endedResponse, { setIntervalFn: () => interval, clearIntervalFn: () => { intervalClears++; } });
  endedStream.finish('{"jsonrpc":"2.0","id":1}');
  endedStream.finish('{"jsonrpc":"2.0","id":2}');
  assert.equal(endedResponse.frames.filter(frame => frame.includes('\ndata:')).length, 1);
  assert.equal(endedResponse.endCount, 1, 'a response can finish only once');
  assert.equal(endedResponse.frames.at(-1), 'event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n');
  assert.equal(intervalClears, 2, 'normal end clears the heartbeat timer');
  const erroredResponse = new FakeResponse();
  beginMcpEventStream(erroredResponse, { setIntervalFn: () => interval, clearIntervalFn: () => { intervalClears++; } });
  erroredResponse.emit('error', new Error('synthetic disconnect'));
  assert.equal(intervalClears, 3, 'response error clears the heartbeat timer');

  const delayBin = path.join(root, 'bin'); fs.mkdirSync(delayBin, { recursive: true });
  const fakeT3 = path.join(delayBin, 't3code');
  fs.writeFileSync(fakeT3, `#!/usr/bin/env node
await new Promise(resolve => setTimeout(resolve, 150000));
process.stdout.write(JSON.stringify({ok:true,data:{thread:{id:'thread_delayed',status:'active',latestRun:{runId:'run_delayed'}},args:process.argv.slice(2)}}));
`, { mode: 0o755 });

  const preload = path.join(root, 'scaled-timers.mjs');
  fs.writeFileSync(preload, `
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 150000 ? 1500 : ms, ...args);
const realInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => realInterval(fn, ms === 20000 ? 200 : ms, ...args);
`);
  const nodeOptions = `--import=${pathToFileURL(preload).href}`;

  // An authenticated trial endpoint must refuse a negotiated SSE request before it writes any stream bytes.
  const authHome = path.join(root, 'auth-home'); fs.mkdirSync(authHome, { recursive: true });
  const authPort = await reservedPort();
  const authEnv = { ...process.env, HOME: authHome, PATH: process.env.PATH, NODE_ENV: 'test', DALAN_AUTH_MODE: 'builtin', DALAN_LOOPBACK: '1', DALAN_TEST_OAUTH: '1', DALAN_PORT: String(authPort) };
  const init = spawnSync(process.execPath, ['bin/dalan.mjs', 'as-init', '--public-url', `http://127.0.0.1:${authPort}`], { cwd: repo, env: authEnv, encoding: 'utf8', timeout: 30_000 });
  check(init.status === 0, `as-init failed (${init.status})`);
  service = launch(['src/server.mjs'], { ...authEnv, DALAN_LEGACY_PROFILE: '1', DALAN_TRIAL_SSE: '1' });
  await waitForReady(service, 'authenticated server');
  const authEnvFile = defaultPath(authHome, '.config/dot-bridge/env');
  check(fs.existsSync(authEnvFile), `auth path secret missing; server: ${service.output()}${service.errors()}`);
  const authSecret = fs.readFileSync(authEnvFile, 'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)?.[1];
  const denied = await request({ port: authPort, pathname: `/${authSecret}/mcp`, headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'auth-test', method: 'ping' }) });
  assert.equal(denied.status, 401);
  assert.notEqual(denied.headers['content-type'], 'text/event-stream');
  assert.equal(denied.text, '');
  await stop(service); service = null;

  // Scale only the server heartbeat and fake read-only delay. The proxy cuts a stream after 120 scaled seconds.
  const port = await reservedPort();
  const home = path.join(root, 'trial-home'); fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, PATH: `${delayBin}${path.delimiter}${process.env.PATH}`, NODE_ENV: 'test', NODE_OPTIONS: nodeOptions,
    DALAN_DEV_ALLOW_UNAUTHENTICATED: '1', DALAN_ENABLE_T3_TOOLS: '1', DALAN_LEGACY_PROFILE: '1', DALAN_T3CODE_BIN: fakeT3,
    DALAN_TRIAL_SSE: process.env.MCP_SSE_TEST_DISABLE === '1' ? '0' : '1', DALAN_PORT: String(port) };
  const inline = "import {main} from './src/server.mjs'; await main({loopbackOnly:true});";
  service = launch(['--input-type=module', '-e', inline], env);
  await waitForReady(service, 'trial server');
  const secret = fs.readFileSync(defaultPath(home, '.config/dot-bridge/env'), 'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)?.[1];
  check(secret, 'server path secret missing');

  // Reproduce the hosted chain: client -> public relay -> gate -> bridge. Connection is hop-by-hop;
  // the streamed response must not force a keep-alive policy across those separate sockets.
  const chainBackend = createBuiltinHttpServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    if (!Object.hasOwn(rpc, 'id')) { res.writeHead(202); res.end(); return; }
    const stream = beginMcpEventStream(res);
    setTimeout(() => stream.finish(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', protocolVersion: '2025-11-25' } })), 5);
  });
  await new Promise(resolve => chainBackend.listen(0, '127.0.0.1', resolve));
  const gate = await createGate();
  let publicRelay = null;
  try {
    gate.open(chainBackend.address().port);
    publicRelay = http.createServer((req, res) => {
      const forward = http.request({ host: '127.0.0.1', port: gate.port, method: req.method, path: req.url, headers: req.headers }, answer => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(forward);
    });
    await new Promise(resolve => publicRelay.listen(0, '127.0.0.1', resolve));
    const publicUrl = `http://127.0.0.1:${publicRelay.address().port}/${secret}/mcp`;
    for (let i = 0; i < 5; i++) {
      const init = await fetch(publicUrl, { method: 'POST', headers: { connection: 'close', accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: `gate-init-${i}`, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) });
      assert.equal(init.status, 200, `gated initialize ${i}`);
      assert.match(init.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.equal(init.headers.get('connection'), 'close');
      const initialized = JSON.parse(mcpResponseText(await init.text()));
      assert.equal(initialized.id, `gate-init-${i}`);
      const notification = await fetch(publicUrl, { method: 'POST', headers: { connection: 'close', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': initialized.result.protocolVersion },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
      assert.equal(notification.status, 202, `gated initialized notification ${i}`);
      assert.equal(await notification.text(), '');
    }
  } finally {
    publicRelay?.closeAllConnections();
    if (publicRelay) await new Promise(resolve => publicRelay.close(resolve));
    await gate.close();
    chainBackend.closeAllConnections();
    await new Promise(resolve => chainBackend.close(resolve));
  }

  const catalog = await request({ port, pathname: `/${secret}/mcp`, headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'catalog-1', method: 'tools/list' }) });
  const waitSchema = JSON.parse(catalog.text).result.tools.find(tool => tool.name === 't3_thread_wait').inputSchema.properties.timeoutMs;
  assert.equal(waitSchema.maximum, 90_000, 't3_thread_wait schema advertises the 90-second cap');

  // The proxy forwards immediately but destroys a downstream response after 1200 ms without upstream bytes.
  const proxyState = { idleCuts: 0 };
  proxy = http.createServer((req, res) => {
    let lastByte = performance.now(), closed = false;
    const idleTimer = setInterval(() => {
      if (!closed && performance.now() - lastByte > 1200) { closed = true; proxyState.idleCuts++; clearInterval(idleTimer); res.destroy(); upstream.destroy(); }
    }, 2);
    const clear = () => { closed = true; clearInterval(idleTimer); };
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, upstreamRes => {
      lastByte = performance.now();
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      res.once('close', clear); upstreamRes.once('end', clear); upstreamRes.once('error', clear);
      upstreamRes.on('data', chunk => { lastByte = performance.now(); res.write(chunk); });
      upstreamRes.once('end', () => res.end());
    });
    upstream.on('error', error => { if (!res.destroyed) res.destroy(error); });
    req.pipe(upstream);
    res.once('close', () => { clear(); upstream.destroy(); });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;
  const rpcId = 'slow-read-1';
  const delayedResult = await request({ port: proxyPort, pathname: `/${secret}/mcp`, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: 't3_thread_wait', arguments: { threadId: 'thread_delayed' } } }) }).then(response => ({ response }), error => ({ error }));
  assert.ok(delayedResult.response, `idle proxy cut before the delayed result (${proxyState.idleCuts} idle cuts): ${delayedResult.error?.code ?? 'no response'}`);
  assert.equal(proxyState.idleCuts, 0, 'heartbeats keep the simulated relay alive');
  const delayed = delayedResult.response;
  assert.equal(delayed.status, 200);
  assert.match(delayed.headers['content-type'] ?? '', /^text\/event-stream/);
  const lines = delayed.text.replace(/\r\n/g, '\n').split('\n');
  const frames = []; let data = [];
  for (const line of lines) {
    if (line === '') { if (data.length) frames.push(data.join('\n')); data = []; }
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  assert.equal(frames.length, 1, `expected one data event, got ${frames.length}`);
  const reply = JSON.parse(frames[0]);
  assert.equal(reply.id, rpcId);
  assert.equal(reply.result.resultType, 'complete');
  assert.equal(reply.result.isError, false, 'delayed tool returned an MCP success');
  const toolReply = JSON.parse(reply.result.content[0].text);
  assert.equal(toolReply.thread.id, 'thread_delayed');
  const waitAt = toolReply.args.indexOf('--timeout');
  assert.ok(waitAt >= 0 && toolReply.args[waitAt + 1] === '90', 'omitted t3_thread_wait timeout defaults to 90 seconds');
  assert.ok(delayed.text.includes(': keepalive'), 'the response has no heartbeat comments');
  const gaps = delayed.arrivals.slice(1).map((at, i) => at - delayed.arrivals[i]);
  assert.ok(gaps.length >= 4, `expected heartbeats during the delayed read, saw ${gaps.length} byte chunks`);
  assert.ok(Math.max(...gaps) <= 250, `stream byte gap exceeded 25 scaled seconds: ${Math.max(...gaps).toFixed(1)} ms`);

  // Unnegotiated requests still receive ordinary application/json.
  const plain = await request({ port, pathname: `/${secret}/mcp`, headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'json-1', method: 'ping' }) });
  assert.equal(plain.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(plain.text).id, 'json-1');
  console.log('PASS authenticated SSE requests wait until bearer verification');
  console.log('PASS five Connection: close SSE initialize / notification rounds through fake relay and real gate');
  console.log('PASS 150-second delayed read-only call survives the 120-second scaled idle proxy with one final event');
  console.log('PASS SSE parser ignores comments, joins multiline data, and disconnect clears heartbeat timer');
  console.log('PASS unnegotiated client still receives JSON');
}

try { await main(); }
finally {
  if (proxy) { const closed = new Promise(resolve => proxy.close(resolve)); proxy.closeAllConnections?.(); await closed; }
  await stop(service);
  fs.rmSync(root, { recursive: true, force: true });
}
