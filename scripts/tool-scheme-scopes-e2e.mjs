#!/usr/bin/env node
// Scopes advertised per tool in tools/list (`securitySchemes`) must match the scopes the protected-resource
// metadata advertises, in external-issuer mode. Checked for the default legacy names, the neutral opt-in,
// and the frozen legacy-v46 catalog profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { reservedPort } from '../src/test-support/port.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const audience = 'https://dalan.example.test';
const subject = 'fixture-subject';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };

const jwksPort = await reservedPort();
const issuer = `http://127.0.0.1:${jwksPort}/realms/fake`;
const jwks = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise(resolve => jwks.listen(jwksPort, '127.0.0.1', resolve));

function mintToken() {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 300, sub: subject, scope: 'dalan.read dalan.work' })).toString('base64url');
  const input = `${head}.${claims}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const homes = [];
async function run({ extraEnv = '', env = {} }) {
  const home = fs.mkdtempSync(path.join(tempRoot, 'tool-scheme-scopes-'));
  homes.push(home);
  const configDir = path.join(home, '.config/dot-bridge');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=http://127.0.0.1:${jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=${subject}\n${extraEnv}`, { mode: 0o600 });
  let output = '', errors = '';
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', ...env },
  });
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { errors += c; });
  try {
    for (let i = 0; i < 200 && !output.includes('MCP listening') && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(child.exitCode, null, errors);
    const port = /MCP listening on 0\.0\.0\.0:(\d+)/.exec(output)[1];
    const secret = fs.readFileSync(path.join(configDir, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const origin = `http://127.0.0.1:${port}`;
    const list = await fetch(`${origin}/${secret}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mintToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: {} }),
    });
    assert.equal(list.status, 200, `tools/list status ${list.status}: ${errors}`);
    const tools = (await list.json()).result.tools;
    const toolScopes = [...new Set(tools.flatMap(tool => (tool.securitySchemes ?? []).flatMap(scheme => scheme.scopes ?? [])))].sort();
    const metadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource/${secret}/mcp`)).json();
    return { toolScopes, metadataScopes: metadata.scopes_supported };
  } finally {
    if (child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
  }
}

try {
  // Tools advertise only the read and work scopes; the metadata also lists the T3 scopes, which no tool uses.
  const requireToolScopesMatchMetadata = (result, label) => {
    const metadataToolScopes = result.metadataScopes.filter(scope => !scope.startsWith('t3.')).sort();
    assert.deepEqual(result.toolScopes, metadataToolScopes, `${label}: tools/list securitySchemes scopes differ from protected-resource metadata`);
  };

  const defaults = await run({});
  requireToolScopesMatchMetadata(defaults, 'external default');
  assert.deepEqual(defaults.toolScopes, ['dot-bridge.read', 'dot-bridge.work'], 'external default advertises the legacy names');
  console.log('PASS external issuer: tools/list securitySchemes scopes match the metadata (legacy names)');

  const neutral = await run({ extraEnv: 'OAUTH_SCOPE_NAMES=neutral\n' });
  requireToolScopesMatchMetadata(neutral, 'OAUTH_SCOPE_NAMES=neutral');
  assert.deepEqual(neutral.toolScopes, ['dalan.read', 'dalan.work'], 'neutral opt-in advertises the neutral names');
  console.log('PASS OAUTH_SCOPE_NAMES=neutral: tools/list securitySchemes scopes match the metadata (neutral names)');

  const frozen = await run({ env: { DALAN_CATALOG_PROFILE: 'legacy-v46' } });
  requireToolScopesMatchMetadata(frozen, 'legacy-v46');
  assert.deepEqual(frozen.toolScopes, ['dot-bridge.read', 'dot-bridge.work'], 'legacy-v46 advertises the legacy names');
  console.log('PASS legacy-v46 profile: tools/list securitySchemes scopes match the metadata (legacy names)');
} finally {
  await new Promise(resolve => jwks.close(resolve));
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
}
