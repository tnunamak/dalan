#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { freeLoopbackPort, processCommand, readManifest, REPO, sleep } from './common.mjs';
import { disableAndVerifyFunnel } from './exposure.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-'));
const fakeBin = path.join(root, 'bin');
const stateFile = path.join(root, 'tailscale-state.json');
const logFile = path.join(root, 'tailscale-calls.jsonl');
const operatorHome = path.join(root, 'operator-home');
const socket = path.join(root, 'second-node', 'tailscaled.sock');
const fakeTailscale = path.join(fakeBin, 'tailscale');
const fixtures = [];
fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
fs.mkdirSync(operatorHome, { recursive: true, mode: 0o700 });

fs.writeFileSync(fakeTailscale, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args.findIndex(value => value === 'funnel' || value === 'serve');
if (command < 0) process.exit(2);
const mode = args[command];
const action = args.includes('status') ? 'status' : args.includes('off') ? 'off' : 'unknown';
const statePath = process.env.FAKE_TAILSCALE_STATE_FILE;
const logPath = process.env.FAKE_TAILSCALE_LOG;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
let bridgeAlive = false;
try { process.kill(Number(state.bridgePid), 0); bridgeAlive = true; } catch {}
const call = { args, mode, action, bridgeAliveAtCall: bridgeAlive, funnel: state.funnel };
fs.appendFileSync(logPath, JSON.stringify(call) + '\\n');
if (action === 'status') {
  if (!args.includes('--json')) process.exit(2);
  process.stdout.write(JSON.stringify(state[mode] ?? {}));
} else if (action === 'off' && mode === 'funnel') {
  if (process.env.FAKE_TAILSCALE_STUCK !== '1') {
    state.funnel = {};
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
} else {
  process.exit(2);
}
`, { mode: 0o700 });
fs.chmodSync(fakeTailscale, 0o700);

const baseEnv = {
  HOME: os.homedir(),
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
  NODE_ENV: 'test',
  DOT_BRIDGE_LIVE_TRIAL_TESTING: '1',
  FAKE_TAILSCALE_STATE_FILE: stateFile,
  FAKE_TAILSCALE_LOG: logFile,
};

function run(script, args, { env = {}, input = '', timeout = 30_000 } = {}) {
  return spawnSync(process.execPath, [path.join(REPO, 'scripts/live-trial', `${script}.mjs`), ...args], {
    cwd: REPO,
    env: { ...baseEnv, ...env },
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024,
  });
}

function calls() {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function clearCalls() {
  fs.writeFileSync(logFile, '', { mode: 0o600 });
}

function writeState(manifest, funnel) {
  fs.writeFileSync(stateFile, JSON.stringify({ bridgePid: manifest.pid, serve: {}, funnel }), { mode: 0o600 });
}

function activeFunnel(port, webConfig = { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } }) {
  return {
    TCP: { '443': { HTTPS: true } },
    Web: { 'trial.example.ts.net:443': webConfig },
    AllowFunnel: { 'trial.example.ts.net:443': true },
  };
}

function assertOk(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message ?? ''}`);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
}

function funnelStatus(proxy) {
  return {
    TCP: { '443': { HTTPS: true } },
    Web: { 'trial.example.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } },
    AllowFunnel: { 'trial.example.ts.net:443': true },
  };
}

function statusSpawn(status) {
  return (_command, args) => args.includes('status')
    ? { status: 0, stdout: JSON.stringify(status) }
    : { status: 0, stdout: '' };
}

// freeLoopbackPort releases the port before the bridge binds it, so another process can take it in between.
// When setup reports that, start this fixture again on a new port (setup has already removed the home).
const portTaken = result => /bridge did not start: port \d+ is already in use/.test(result.stderr ?? '');

async function setup(home, cutoffSeconds) {
  let port, result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    port = await freeLoopbackPort();
    result = run('setup', [
      '--worker', 'fixture-a',
      '--public-url', 'https://trial.example.ts.net',
      '--port', String(port),
      '--home', home,
      '--exposure', 'linux-second-node',
      '--tailscale-socket', socket,
      '--cutoff-seconds', String(cutoffSeconds),
    ]);
    if (result.status === 0 || !portTaken(result)) break;
  }
  assertOk(result, 'setup');
  const manifest = readManifest(home);
  fixtures.push({ home, manifest });
  assert.equal(manifest.exposure.mode, 'linux-second-node');
  assert.equal(manifest.exposure.tailscale_socket, socket);
  assert.equal(manifest.exposure.public_port, 443);
  assert.equal(manifest.exposure.local_port, port);
  assert.ok(Number.isInteger(manifest.exposure.cutoff.pid));
  assert.ok(manifest.exposure.cutoff.deadline_at);
  return manifest;
}

async function waitForCutoff(logFile, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let log = '';
  while (Date.now() < deadline) {
    log = fs.readFileSync(logFile, 'utf8');
    if (log.includes('cutoff verified clear')) return log;
    if (log.includes('cutoff failed:')) throw new Error(log);
    await sleep(50);
  }
  throw new Error(`timed out waiting for cutoff completion: ${log}`);
}

async function main() {
  const unixExposure = { mode: 'mac-funnel', tailscale_socket: null, public_port: 443, local_port: 80 };
  assert.doesNotThrow(() => disableAndVerifyFunnel(unixExposure, root, {
    spawn: statusSpawn(funnelStatus('unix:/tmp/unrelated.sock')),
  }), 'a valid Unix socket proxy does not match the trial TCP port');
  const remoteTcpStatus = {
    TCP: { '443': { TCPForward: 'remote.example:443' } },
    Web: {},
    AllowFunnel: { 'trial.example.ts.net:443': true },
  };
  assert.doesNotThrow(() => disableAndVerifyFunnel({ ...unixExposure, local_port: 443 }, root, {
    spawn: statusSpawn(remoteTcpStatus),
  }), 'a remote TCP target does not match the same-numbered trial port');

  clearCalls();
  const firstHome = path.join(root, 'fail');
  const first = await setup(firstHome, 60);
  assert.deepEqual(calls(), [], 'setup records exposure without invoking Tailscale');
  writeState(first, activeFunnel(first.port));

  const failed = run('teardown', ['--home', firstHome, '--test-operator-home', operatorHome], {
    env: { FAKE_TAILSCALE_STUCK: '1' },
  });
  assert.notEqual(failed.status, 0, 'a still-active Funnel route makes teardown fail');
  assert.match(failed.stderr, /status still shows the trial port forwarding/);
  assert.match(failed.stderr, /bridge and trial home are still running/);
  assert.ok(fs.existsSync(firstHome), 'failed exposure proof retains the trial home');
  assert.doesNotThrow(() => process.kill(first.pid, 0), 'failed exposure proof keeps the bridge alive');

  const firstCalls = calls();
  assert.equal(firstCalls.length, 2);
  assert.deepEqual(firstCalls.map(call => call.mode), ['funnel', 'funnel']);
  assert.equal(firstCalls[0].action, 'off');
  assert.equal(firstCalls[1].action, 'status');
  for (const call of firstCalls) {
    assert.equal(call.args[0], '--socket');
    assert.equal(call.args[1], socket, 'second-node calls use the recorded socket');
    assert.equal(call.bridgeAliveAtCall, true, 'Funnel is disabled and checked while the bridge is alive');
  }

  writeState(first, activeFunnel(first.port, { Handlers: { '/': { Proxy: String(first.port) } } }));
  const numericProxy = run('teardown', ['--home', firstHome, '--test-operator-home', operatorHome], {
    env: { FAKE_TAILSCALE_STUCK: '1' },
  });
  assert.notEqual(numericProxy.status, 0, 'a numeric Tailscale proxy target still identifies the trial port');
  assert.match(numericProxy.stderr, /status still shows the trial port forwarding/);
  assert.deepEqual(calls().slice(2, 4).map(call => [call.mode, call.action]), [['funnel', 'off'], ['funnel', 'status']]);

  const tcpForwardState = activeFunnel(first.port, { Handlers: { '/': { Text: 'unrelated web content' } } });
  tcpForwardState.TCP['443'] = { TCPForward: `127.0.0.1:${first.port}` };
  writeState(first, tcpForwardState);
  const tcpForward = run('teardown', ['--home', firstHome, '--test-operator-home', operatorHome], {
    env: { FAKE_TAILSCALE_STUCK: '1' },
  });
  assert.notEqual(tcpForward.status, 0, 'a TCP Funnel target still identifies the trial port');
  assert.match(tcpForward.stderr, /status still shows the trial port forwarding/);
  assert.deepEqual(calls().slice(4, 6).map(call => [call.mode, call.action]), [['funnel', 'off'], ['funnel', 'status']]);

  const malformedCases = [
    ['missing Handlers', {}, /omitted or malformed Handlers/],
    ['empty handler', { Handlers: { '/': {} } }, /incomplete handler shape/],
    ['unknown handler', { Handlers: { '/': { Unexpected: 'shape' } } }, /unrecognized handler shape/],
  ];
  for (let index = 0; index < malformedCases.length; index++) {
    const [label, webConfig, error] = malformedCases[index];
    writeState(first, activeFunnel(first.port, webConfig));
    const malformed = run('teardown', ['--home', firstHome, '--test-operator-home', operatorHome], {
      env: { FAKE_TAILSCALE_STUCK: '1' },
    });
    assert.notEqual(malformed.status, 0, `${label} cannot prove exposure is clear`);
    assert.match(malformed.stderr, error);
    assert.match(malformed.stderr, /bridge and trial home are still running/);
    assert.ok(fs.existsSync(firstHome), `${label} retains the trial home`);
    assert.doesNotThrow(() => process.kill(first.pid, 0), `${label} keeps the bridge alive`);
    const offset = 6 + index * 2;
    assert.deepEqual(calls().slice(offset, offset + 2).map(call => [call.mode, call.action]), [['funnel', 'off'], ['funnel', 'status']]);
  }

  const retried = run('teardown', ['--home', firstHome, '--test-operator-home', operatorHome, '--check-tailscale']);
  assertOk(retried, 'verified teardown retry');
  assert.ok(!fs.existsSync(firstHome), 'verified teardown removes the trial home');
  assert.equal(processCommand(first.exposure.cutoff.pid), null, 'teardown cancels the independent cutoff process');
  assert.deepEqual(calls().slice(12).map(call => [call.mode, call.action]), [
    ['funnel', 'off'], ['funnel', 'status'], ['serve', 'status'], ['funnel', 'status'],
  ]);

  clearCalls();
  const remoteHome = path.join(root, 'remote');
  const remote = await setup(remoteHome, 60);
  writeState(remote, funnelStatus(`https://other.example:${remote.port}`));
  const remoteCleanup = run('teardown', ['--home', remoteHome, '--test-operator-home', operatorHome], {
    env: { FAKE_TAILSCALE_STUCK: '1' },
  });
  assertOk(remoteCleanup, 'unrelated remote proxy with the same numeric port');
  assert.ok(!fs.existsSync(remoteHome), 'a same-port remote proxy does not block trial teardown');
  assert.deepEqual(calls().map(call => [call.mode, call.action]), [['funnel', 'off'], ['funnel', 'status']]);
  assert.ok(calls().every(call => call.bridgeAliveAtCall), 'remote proxy check still runs before bridge shutdown');

  clearCalls();
  const timerHome = path.join(root, 'timer');
  const timer = await setup(timerHome, 3);
  writeState(timer, activeFunnel(timer.port));
  const cutoffLog = await waitForCutoff(timer.exposure.cutoff.log_file);
  const timerCalls = calls();
  assert.deepEqual(timerCalls.slice(0, 2).map(call => call.action), ['off', 'status']);
  assert.equal(timerCalls[0].args[0], '--socket');
  assert.equal(timerCalls[0].args[1], socket);
  assert.equal(timerCalls[0].bridgeAliveAtCall, true, 'timer removes exposure while the bridge remains available');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).funnel, {});
  assert.match(cutoffLog, /cutoff verified clear/);

  const timerCleanup = run('teardown', ['--home', timerHome, '--test-operator-home', operatorHome]);
  assertOk(timerCleanup, 'teardown after cutoff fired');
  assert.ok(!fs.existsSync(timerHome));
  console.log('PASS setup records exposure without running Tailscale');
  console.log('PASS second-node Funnel off and status use --socket before bridge shutdown');
  console.log('PASS a still-forwarding status fails and retains the bridge and home');
  console.log('PASS numeric proxy targets are matched to the recorded local port');
  console.log('PASS TCP Funnel targets are matched to the recorded local port');
  console.log('PASS malformed active Funnel status fails closed and retains the bridge and home');
  console.log('PASS remote and Unix socket proxies do not match a same-numbered local port');
  console.log('PASS cutoff timer disables and verifies Funnel when teardown does not run');
}

main().catch(error => {
  console.error(`exposure-test failed: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const fixture of fixtures) {
    if (!fs.existsSync(fixture.home)) continue;
    try {
      const manifest = readManifest(fixture.home);
      process.kill(manifest.pid, 'SIGTERM');
      process.kill(manifest.exposure.cutoff.pid, 'SIGTERM');
    } catch { /* fixture cleanup is best effort after assertions */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});
