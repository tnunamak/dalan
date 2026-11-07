import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { waitForAdminSocket, run } from './worker-bridge-setup.mjs';

// `--start` must not report success until the bridge answers on its admin socket. These tests use a fake socket
// and never call systemctl or launchctl.
const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sw-'));
const listen = socketPath => new Promise(resolve => { const server = net.createServer(); server.listen(socketPath, () => resolve(server)); });

test('returns true once something accepts connections on the socket', async () => {
  const socketPath = path.join(dir, 'a.sock');
  const server = await listen(socketPath);
  try { assert.equal(waitForAdminSocket({ socketPath, timeoutMs: 5000, intervalMs: 20 }), true); }
  finally { server.close(); }
});

test('waits for a socket that appears after a delay', async () => {
  const socketPath = path.join(dir, 'late.sock');
  const late = spawn(process.execPath, ['-e', `setTimeout(()=>require('node:net').createServer().listen(${JSON.stringify(socketPath)}),700);setTimeout(()=>process.exit(0),8000)`], { stdio: 'ignore' });
  try {
    const started = Date.now();
    assert.equal(waitForAdminSocket({ socketPath, timeoutMs: 6000, intervalMs: 50 }), true);
    assert.ok(Date.now() - started >= 500, 'it polled until the socket existed');
  } finally { late.kill(); }
});

test('gives up after the timeout when nothing listens', () => {
  const started = Date.now();
  assert.equal(waitForAdminSocket({ socketPath: path.join(dir, 'none.sock'), timeoutMs: 400, intervalMs: 50 }), false);
  assert.ok(Date.now() - started < 3000);
});

test('--start fails with the socket path and log command when the bridge never answers', () => {
  const home = path.join(dir, 'h');
  const unitHome = path.join(dir, 'xdg');
  // checkStartReadiness calls systemctl itself, so shim it on PATH as well as in the spawn seam.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['systemctl', 'loginctl', 'launchctl']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const calls = [];
  const spawnStub = (cmd, args) => { calls.push(cmd); return { status: 0, stdout: '', stderr: '' }; }; // no real systemctl
  assert.throws(() => run(['--worker', 'waiter', '--public-url', 'https://waiter.example.test', '--port', '18871', '--home', home, '--start'], {
    platform: 'linux', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: unitHome, DALAN_SETUP_LOCK_DIR: path.join(dir, 'locks') },
    spawn: spawnStub, log: () => {}, waitForSocket: () => false,
  }), error => error.message.includes('admin.sock') && error.message.includes('journalctl --user -u dot-bridge-waiter.service'));
  assert.ok(calls.length > 0 && calls.every(cmd => cmd === 'systemctl' || cmd === 'loginctl'));
});
