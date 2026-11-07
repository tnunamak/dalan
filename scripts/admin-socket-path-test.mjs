// A bridge home whose admin socket path exceeds the Unix socket limit: the server and every client that connects say
// so in one plain message (no bare EINVAL, no stack trace), and the server creates nothing in that home.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adminSocketPathError, SOCKET_PATH_LIMIT } from '../src/admin-socket.mjs';
import { bridgeHealth } from '../src/host-health.mjs';
import { adminRequest, transient } from '../src/acp-bridge.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sock-'));
const longHome = path.join(scratch, 'h'.repeat(120 - Buffer.byteLength(scratch) - 1));
assert.equal(Buffer.byteLength(longHome), 120);
fs.mkdirSync(longHome, { mode: 0o700 });
const longSocket = path.join(longHome, '.local/share/dalan/admin.sock');
const message = /the bridge home path is too long for the admin socket: .*admin\.sock is \d+ bytes, and the limit on this system is \d+/;
const env = { ...process.env, HOME: longHome };
for (const key of Object.keys(env)) if (/^(DALAN_|DOT_BRIDGE_|DOT_ACP_)/.test(key)) delete env[key];
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('the server refuses a 120-byte home with one plain message and creates nothing', () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'src/server.mjs')], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, message);
  assert.match(r.stderr, /fix: use a bridge home with a shorter path \(DALAN_HOME\)/);
  assert.doesNotMatch(r.stderr, /EINVAL|\n\s+at /);
  assert.deepEqual(fs.readdirSync(longHome), []);
});

test('the dalan CLI says the same when DALAN_HOME is too long', () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'bin/dalan.mjs'), 'status'], { env: { ...env, HOME: os.homedir(), DALAN_HOME: longHome }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, message);
  assert.doesNotMatch(r.stderr, /EINVAL/);
});

test('the health check and the ACP adapter report it, and the adapter does not retry it', async () => {
  await assert.rejects(bridgeHealth({ socketPath: longSocket }), message);
  const error = await adminRequest(longSocket, '/status').then(() => null, e => e);
  assert.match(error?.message ?? '', message);
  assert.equal(error.code, 'ADMIN_SOCKET_PATH_TOO_LONG');
  assert.equal(transient(error), false);
});

test('default homes fit: a 32-byte user name on Linux and macOS, for a bridge and for the trial', () => {
  const name = 'u'.repeat(32);
  const limits = { linux: 107, darwin: 103 };
  for (const [platform, home] of [['linux', `/home/${name}`], ['darwin', `/Users/${name}`]]) {
    for (const socket of [`${home}/.local/share/dalan/admin.sock`, `${home}/.local/share/dalan-trial/.local/share/dalan/admin.sock`]) {
      assert.ok(Buffer.byteLength(socket) <= limits[platform] - 8, `${platform}: ${socket} (${Buffer.byteLength(socket)} bytes) leaves less than 8 bytes`);
    }
  }
  assert.equal(SOCKET_PATH_LIMIT, limits[process.platform] ?? SOCKET_PATH_LIMIT);
  assert.equal(adminSocketPathError(`/home/${name}/.local/share/dalan/admin.sock`), null);
});
