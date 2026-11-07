#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-bridge-metadata-'));
const configDir = path.join(home, '.config/dot-bridge');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'oauth.env'), [
  'OAUTH_ISSUER=https://id.example.test/realms/excluded-org',
  'OAUTH_AUDIENCE=https://dot-bridge.example.test',
  'OAUTH_JWKS_URI=https://id.example.test/realms/excluded-org/protocol/openid-connect/certs',
  'OAUTH_ALLOWED_SUBJECTS=test-subject',
  '',
].join('\n'), { mode: 0o600 });

let port;
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: path.resolve(new URL('..', import.meta.url).pathname),
  env: { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: '', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const closed = new Promise(resolve => child.once('close', resolve));
let stdout = '', stderr = '', spawnError;
child.on('error', error => { spawnError = error; });
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    const match = stdout.match(/^MCP listening on [^\r\n]+:(\d+)\r?\n/m);
    if (match) {
      port = Number(match[1]);
      assert(Number.isInteger(port) && port > 0 && port <= 65535, 'invalid bound port');
      break;
    }
    assert(child.exitCode === null && child.signalCode === null, 'server startup: ' + stderr);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(port, 'server startup: ' + stderr);
  const origin = `http://127.0.0.1:${port}`;
  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource`);
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, 'https://dot-bridge.example.test');
  const secret = fs.readFileSync(path.join(configDir, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc = await fetch(`${origin}/${secret}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(rpc.status, 200, 'path-secret mode remains available without a bearer token');
  assert.equal((await rpc.json()).result.tools[0].securitySchemes, undefined);
  console.log('PASS metadata available while path-secret mode stays active');
  // Fail closed: no OAuth configuration and no explicit insecure opt-in means the service refuses to start.
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const refuse = (name, extra, dir) => {
    const env = { ...process.env, HOME: dir, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: '', ...extra };
    delete env.DOT_BRIDGE_ALLOW_INSECURE_PUBLIC;
    const r = spawnSync(process.execPath, ['src/server.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(r.status, 0, `${name}: server must refuse to start`);
    assert.match(r.stderr, /refusing to start the public route without OAuth|OAuth config missing/, `${name}: ${r.stderr}`);
  };
  refuse('unset auth mode', {}, home);
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-bridge-failclosed-'));
  refuse('oauth mode without oauth.env', { DOT_BRIDGE_AUTH_MODE: 'oauth', DALAN_TRUST_PROXY: '1' }, emptyHome);
  fs.rmSync(emptyHome, { recursive: true, force: true });
  console.log('PASS public route fails closed without OAuth');
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await closed;
  fs.rmSync(home, { recursive: true, force: true });
}
