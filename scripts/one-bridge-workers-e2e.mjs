#!/usr/bin/env node
// One real built-in OAuth bridge serves four separately paired workers with one stable catalog,
// cannot claim another worker's assignment, and can claim its own. A wrong public Host is refused before MCP dispatch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Vendor, CALLBACK } from './live-trial/fake-vendor.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'dalan-one-bridge-'));
fs.writeFileSync(path.join(root, '.fleet-owner.json'), JSON.stringify({ thread_id: 'one-bridge-b8', disposable: true, tim_driven: true }) + '\n', { mode: 0o600 });
const workers = ['dot', 'muse', 'duet-default', 'duet-dondo'];
const stubBin = path.join(root, 'bin');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 't3code'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const home = path.join(root, 'home');
const configDir = path.join(home, '.config/dot-bridge');
let forwarder = null;
const forwardedSockets = new Set();
let forwardPort;
let socketActivator = null;
let child = null;
let childExit = null;
let stderr = '';
let port;
let publicUrl;
let secret;
let resource;

function cli(args, input) {
  const result = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], {
    cwd: repo,
    env: serverEnv,
    input,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const serverEnv = {
  ...process.env,
  HOME: home,
  PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ''}`,
  DALAN_PORT: '0', // replaced after the port is reserved
  DALAN_BIND_HOST: '127.0.0.1',
  DALAN_AUTH_MODE: 'builtin',
  DALAN_TEST_OAUTH: '1',
  DALAN_CATALOG_PROFILE: 'stable',
  DALAN_ENABLE_T3_TOOLS: '1',
  DALAN_ENABLE_WORKSPACE: '1',
  DALAN_WORKSPACE_ROOT: path.join(home, 'workspace'),
  DALAN_GOZAR_SERVICE: '1',
  NODE_ENV: 'test',
};

async function waitForReady() {
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.once('exit', code => { childExit = code; });
  const start = Date.now();
  while (Date.now() - start < 12000 && childExit === null) {
    const match = output.match(/MCP listening on 127\.0\.0\.1:(\d+)/);
    if (match) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`bridge did not start; exit=${childExit}; stdout=${output}; stderr=${stderr}`);
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  const kill = setTimeout(() => child.kill('SIGKILL'), 2500);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(kill); }
}

function rawRequest({ host, path: requestPath, method = 'POST', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: forwardPort ?? port, path: requestPath, method, headers: { host, ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8').on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function rpc(token, method, params = {}) {
  const response = await fetch(resource, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function callTool(token, name, args) {
  const { status, body } = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(status, 200, `${name}: HTTP ${status}`);
  const result = body.result;
  assert.ok(result, `${name}: ${JSON.stringify(body)}`);
  const text = result.content?.[0]?.text ?? '';
  return result.isError ? { ok: false, error: text } : { ok: true, value: JSON.parse(text) };
}

function submit(requestId, worker) {
  const assignment = {
    schema_version: 1,
    request_id: requestId,
    brief: `one bridge worker gate: ${worker}`,
    inputs: [],
    expected_output: 'one completed report',
    execution_scope: 'read-only',
  };
  const result = cli(['submit', '--stdin', '--json', '--queue-anyway', '--worker', worker], JSON.stringify(assignment));
  assert.equal(result.code, 0, `${worker} submit failed: ${result.stderr}${result.stdout}`);
}

async function main() {
  try {
    port = await reservedPort();
    forwardPort = await reservedPort();
    publicUrl = `http://127.0.0.1:${forwardPort}`;
    serverEnv.DALAN_PORT = String(port);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(configDir, 'workers.json'), JSON.stringify({
      workers: Object.fromEntries(workers.map(worker => [worker, { capabilities: ['t3'], workspaceAllowed: ['dot', 'muse'].includes(worker) }])),
      default_execution: 'none',
    }, null, 2) + '\n', { mode: 0o600 });

    const initialized = cli(['as-init', '--public-url', publicUrl]);
    assert.equal(initialized.code, 0, initialized.stderr + initialized.stdout);
    const asConfigPath = path.join(configDir, 'as.json');
    const asConfig = JSON.parse(fs.readFileSync(asConfigPath, 'utf8'));
    asConfig.limits = { registrations: 20, interactions: 20 };
    fs.writeFileSync(asConfigPath, JSON.stringify(asConfig, null, 2) + '\n', { mode: 0o600 });

    child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForReady();
    // Exercise the installed Linux forwarding program when available; other hosts use a transparent test forwarder.
    if (process.platform === 'linux' && fs.existsSync('/usr/bin/systemd-socket-activate') && fs.existsSync('/usr/lib/systemd/systemd-socket-proxyd')) {
      socketActivator = spawn('/usr/bin/systemd-socket-activate', ['-l', `127.0.0.1:${forwardPort}`, '/usr/lib/systemd/systemd-socket-proxyd', `127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
      let activationLog = '';
      socketActivator.stderr.on('data', chunk => { activationLog += chunk; });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (activationLog.includes('Listening on')) break;
        assert.equal(socketActivator.exitCode, null, activationLog);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.match(activationLog, /Listening on/, 'socket activation did not start');
    } else {
      forwarder = net.createServer(client => {
        const upstream = net.connect(port, '127.0.0.1');
        for (const socket of [client, upstream]) { forwardedSockets.add(socket); socket.on('close', () => forwardedSockets.delete(socket)); socket.on('error', () => { client.destroy(); upstream.destroy(); }); }
        client.pipe(upstream); upstream.pipe(client);
      });
      await new Promise((resolve, reject) => { forwarder.once('error', reject); forwarder.listen(forwardPort, '127.0.0.1', resolve); });
    }
    const envText = fs.readFileSync(path.join(configDir, 'env'), 'utf8');
    secret = envText.match(/^BRIDGE_PATH_SECRET=(.+)$/m)?.[1];
    assert.match(secret ?? '', /^[a-f0-9]{64}$/);
    resource = `${publicUrl}/${secret}/mcp`;
    // Cheap topology checks run before any enrollment or job writes.
    const exactHost = new URL(publicUrl).host;
    const noAuth = await rawRequest({ host: exactHost, path: `/${secret}/mcp` });
    assert.equal(noAuth.status, 401);
    assert.equal((await rawRequest({ host: 'wrong.example', path: `/${secret}/mcp` })).status, 421);
    const discovery = await rawRequest({ host: exactHost, method: 'GET', path: `/.well-known/oauth-protected-resource/${secret}/mcp` });
    assert.equal(discovery.status, 200);
    assert.equal(JSON.parse(discovery.text).resource, resource);
    assert.equal((await rawRequest({ host: 'wrong.example', method: 'GET', path: `/.well-known/oauth-protected-resource/${secret}/mcp` })).status, 421);
    console.log('PASS loopback builtin + transparent forwarder: exact Host, wrong Host, unauthenticated MCP and public discovery');
    const allowed = cli(['connect', 'allow-callback', CALLBACK, '--json']);
    assert.equal(allowed.code, 0, allowed.stderr + allowed.stdout);
    console.log('PASS one fixed-port bridge started with built-in OAuth and stable catalog');

    const requestIds = Object.fromEntries(workers.map(worker => [worker, `req_${worker.replaceAll('-', '_')}_${randomUUID().slice(0, 8)}`]));
    for (const worker of workers) submit(requestIds[worker], worker);

    const sessions = new Map();
    const oauthBridge = {
      resource,
      start_window(worker) {
        cli(['connect', 'stop', '--json']);
        const result = cli(['connect', 'start', '--worker', worker, '--json']);
        assert.equal(result.code, 0, result.stderr + result.stdout);
      },
      approve(code, worker, replace = true) {
        const result = cli(['connect', 'approve', code, '--worker', worker, ...(replace ? ['--replace'] : []), '--json']);
        return { code: result.code, stdout: result.stdout, stderr: result.stderr, json: () => JSON.parse(result.stdout) };
      },
    };
    for (const worker of workers) {
      const vendor = new Vendor(oauthBridge);
      oauthBridge.start_window(worker);
      const registration = await vendor.register({ client_name: `B8 ${worker}` });
      assert.equal(registration.status, 201, `${worker} DCR failed: ${JSON.stringify(registration.body)}`);
      const session = await vendor.connect(worker, { windowOpen: true });
      sessions.set(worker, { vendor, ...session });
      console.log(`PASS ${worker} completed built-in OAuth pairing, approval, PKCE exchange, and token issue`);
    }

    let baseline = null;
    for (const worker of workers) {
      const { access } = sessions.get(worker);
      const response = await rpc(access, 'tools/list');
      assert.equal(response.status, 200, `${worker} tools/list HTTP ${response.status}`);
      const tools = response.body.result?.tools;
      assert.ok(Array.isArray(tools), `${worker} has no tools list`);
      assert.ok(tools.some(tool => tool.name === 'list_tools'), `${worker} did not receive the stable catalog`);
      assert.ok(!tools.some(tool => ['ask_question', 'consume_answer'].includes(tool.name)), `${worker} received a non-stable question tool`);
      if (baseline === null) baseline = tools;
      else assert.deepEqual(tools, baseline, `${worker} tool descriptors differ from the shared stable catalog`);
    }
    console.log(`PASS all four workers received the same stable tools/list catalog (${baseline.length} tools)`);

    const claims = new Map();
    for (const worker of workers) {
      const { access } = sessions.get(worker);
      for (const other of workers) {
        if (other === worker) continue;
        const foreign = await callTool(access, 'claim', { request_id: requestIds[other], claimant: worker });
        assert.equal(foreign.ok, false, `${worker} claimed ${other}'s assignment`);
      }
      const own = await callTool(access, 'claim', { request_id: requestIds[worker], claimant: worker });
      assert.equal(own.ok, true, `${worker} could not claim its own assignment: ${own.error}`);
      assert.ok(own.value.claim_id, `${worker} claim had no claim_id`);
      claims.set(worker, own.value);
    }
    console.log('PASS each worker was refused all three foreign claims and claimed its own job');

    const duetClaim = claims.get('duet-default');
    const worktrees = path.join(serverEnv.DALAN_WORKSPACE_ROOT, 'worktrees');
    const worktreesBefore = fs.readdirSync(worktrees);
    const refusedWorkspace = await callTool(sessions.get('duet-default').access, 'list_files', { request_id: requestIds['duet-default'], claim_id: duetClaim.claim_id });
    assert.equal(refusedWorkspace.ok, false);
    assert.match(refusedWorkspace.error, /capability_not_enabled/);
    assert.deepEqual(fs.readdirSync(worktrees), worktreesBefore, 'default-denied Duet workspace call created a worktree');
    console.log('PASS per-worker workspace default deny: Duet gets capability_not_enabled and creates no workspace');

    const token = sessions.get('dot').access;
    const wrongHost = await rawRequest({
      host: 'evil.example',
      path: `/${secret}/mcp`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'host-check', method: 'tools/list', params: {} }),
    });
    assert.equal(wrongHost.status, 421, `configured Host check returned ${wrongHost.status}`);
    console.log('PASS MCP request with an unconfigured public Host was refused with 421');

    const serviceProbe = async (nonce, host = exactHost) => {
      const response = await rawRequest({ host, method: 'GET', path: `/.well-known/gozar/service?nonce=${nonce}` });
      return { ...response, value: response.text ? JSON.parse(response.text) : null };
    };
    const nonceA = randomBytes(32).toString('hex');
    const nonceB = randomBytes(32).toString('hex');
    const probeA = await serviceProbe(nonceA);
    assert.equal(probeA.status, 200, `service probe A returned ${probeA.status}`);
    assert.equal(probeA.value.schemaVersion, 1);
    assert.equal(probeA.value.nonce, nonceA);
    assert.match(probeA.value.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(probeA.value.proof, /^[0-9a-f]{64}$/, 'Gozar verifier response needs a 256-bit hex proof');
    const probeARepeat = await serviceProbe(nonceA);
    assert.equal(probeARepeat.status, 200);
    assert.equal(probeARepeat.value.instanceId, probeA.value.instanceId);
    assert.equal(probeARepeat.value.proof, probeA.value.proof, 'same verifier and nonce must produce the same proof');
    const probeB = await serviceProbe(nonceB);
    assert.equal(probeB.status, 200, `service probe B returned ${probeB.status}`);
    assert.equal(probeB.value.nonce, nonceB);
    assert.equal(probeB.value.instanceId, probeA.value.instanceId, 'service instance ID changed between verifier requests');
    assert.match(probeB.value.proof, /^[0-9a-f]{64}$/);
    assert.notEqual(probeB.value.proof, probeA.value.proof, 'different nonce unexpectedly reused a proof');
    assert.equal((await serviceProbe('invalid')).status, 400, 'malformed Gozar verifier nonce was accepted');
    assert.equal((await serviceProbe(nonceA, 'evil.example')).status, 421, 'Gozar verifier ignored the configured public Host');
    console.log('PASS unauthenticated Gozar verifier echoes valid nonces, keeps one instance ID, binds deterministic proofs to nonce, rejects bad nonce, and enforces Host');
  } finally {
    if (socketActivator && socketActivator.exitCode === null && socketActivator.signalCode === null) {
      const exited = new Promise(resolve => socketActivator.once('exit', resolve));
      socketActivator.kill('SIGTERM');
      await exited;
    }
    for (const socket of forwardedSockets) socket.destroy();
    if (forwarder) await new Promise(resolve => forwarder.close(resolve));
    await stop();
    if (process.env.KEEP_TEST_FIXTURES !== '1') fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL one bridge four-worker gate: ${error.stack ?? error}`);
  if (stderr) console.error(`bridge stderr: ${stderr}`);
  process.exitCode = 1;
});
