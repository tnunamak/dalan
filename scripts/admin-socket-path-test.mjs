// A bridge home whose standard admin socket path exceeds the Unix socket limit: the socket path is short by construction.
// The server and every client compute the same short path from the home, and the server alone makes its private directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { adminSocketPath, adminSocketPathError, ensureAdminSocketDir, socketPathLimit, SOCKET_PATH_LIMIT } from '../src/admin-socket.mjs';
import { bridgeHealth } from '../src/host-health.mjs';
import { adminRequest } from '../src/acp-bridge.mjs';

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sk-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const longData = path.join(scratch, 'h'.repeat(120 - Buffer.byteLength(scratch) - 1), '.local/share/dalan');

test('a data directory that fits keeps the standard path; a long one gets a short path', () => {
  assert.equal(adminSocketPath('/home/u/.local/share/dalan'), '/home/u/.local/share/dalan/admin.sock');
  for (const platform of ['linux', 'darwin']) {
    const limit = socketPathLimit(platform);
    const edge = '/' + 'a'.repeat(limit - '/admin.sock'.length - 1);
    assert.equal(Buffer.byteLength(path.join(edge, 'admin.sock')), limit);
    assert.equal(adminSocketPath(edge, { platform }), path.join(edge, 'admin.sock'), `${platform}: at the limit is kept`);
    const over = adminSocketPath(edge + 'a', { platform, uid: 501 });
    assert.match(over, /^\/tmp\/dalan-501\/[0-9a-f]{16}\.sock$/, `${platform}: over the limit moves`);
    assert.ok(Buffer.byteLength(over) < 50);
  }
  const a = adminSocketPath(longData), b = adminSocketPath(longData + 'x');
  assert.equal(a, adminSocketPath(longData), 'the same home always gets the same path');
  assert.notEqual(a, b, 'different homes get different paths');
  assert.equal(adminSocketPathError(a), null);
});

test('a client reaches a server on the short path for a 120-byte home', async () => {
  const dir = path.join(scratch, 's');
  const socket = adminSocketPath(longData, { dir });
  fs.mkdirSync(dir, { mode: 0o700 });
  // Not the short dir under /tmp, so only the length matters here.
  assert.ok(Buffer.byteLength(socket) <= SOCKET_PATH_LIMIT);
  const server = net.createServer(connection => { connection.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}'); });
  await new Promise(resolve => server.listen(socket, resolve));
  try {
    await adminRequest(socket, '/status');
    await bridgeHealth({ socketPath: socket }).catch(error => assert.doesNotMatch(error.message, /too long|EINVAL/));
  } finally { server.close(); }
});

test('the short socket directory is made private, and a link or a foreign mode is refused', () => {
  const dir = path.join(scratch, 'priv'), socket = path.join(dir, 'x.sock');
  ensureAdminSocketDir(socket, { dir });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  ensureAdminSocketDir(socket, { dir }); // again: fine
  fs.chmodSync(dir, 0o755);
  assert.throws(() => ensureAdminSocketDir(socket, { dir }), error => error.code === 'ADMIN_SOCKET_DIR_UNSAFE');
  const link = path.join(scratch, 'link');
  fs.symlinkSync(dir, link);
  assert.throws(() => ensureAdminSocketDir(path.join(link, 'x.sock'), { dir: link }), error => error.code === 'ADMIN_SOCKET_DIR_UNSAFE');
  assert.throws(() => ensureAdminSocketDir(socket, { dir, uid: (process.getuid?.() ?? 0) + 1 }), error => error.code === 'ADMIN_SOCKET_DIR_UNSAFE');
  ensureAdminSocketDir('/elsewhere/admin.sock', { dir }); // the standard path: nothing to make
});

test('a path that is too long even so is still reported plainly', () => {
  const error = adminSocketPathError('/' + 'z'.repeat(150) + '/admin.sock');
  assert.equal(error.code, 'ADMIN_SOCKET_PATH_TOO_LONG');
  assert.match(error.message, /the bridge home path is too long for the admin socket: .*admin\.sock is \d+ bytes, and the limit on this system is \d+/);
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
});

test('a real bridge started under a 120-byte home listens on the short path and answers its clients', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = path.join(scratch, 'real', 'r'.repeat(120 - Buffer.byteLength(path.join(scratch, 'real')) - 1));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, NODE_ENV: 'test' };
  for (const key of Object.keys(env)) if (/^(DALAN_|DOT_BRIDGE_)/.test(key)) delete env[key];
  // The statechart HTTP test starts real bridges under its HOME and talks to each over the admin socket.
  const run = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-timeout=60000', path.join(repo, 'scripts/claim-statechart-http-test.mjs')], { cwd: repo, env, encoding: 'utf8', timeout: 150_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout + run.stderr, /too long for the admin socket/);
});
