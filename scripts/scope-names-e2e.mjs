#!/usr/bin/env node
// Scope names a client sees in the 401 challenge and the protected-resource metadata, in external-issuer mode.
// Default: the legacy `dot-bridge.*` names, so an issuer that defines only those keeps working with no edit.
// OAUTH_SCOPE_NAMES=neutral in oauth.env opts in to `dalan.*`. The frozen legacy-v46 catalog always uses the legacy names.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { authConfig, challenge, protectedResource } from '../src/auth.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const homes = [];
const LEGACY = ['dot-bridge.read', 'dot-bridge.work', 't3.read', 't3.write'];
const NEUTRAL = ['dalan.read', 'dalan.work', 't3.read', 't3.write'];

async function run({ extraEnv = '', env = {} }) {
  const home = fs.mkdtempSync(path.join(tempRoot, 'scope-names-'));
  homes.push(home);
  const configDir = path.join(home, '.config/dot-bridge');
  fs.mkdirSync(configDir, { recursive: true });
  const issuer = 'http://127.0.0.1:9';
  fs.writeFileSync(path.join(configDir, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=https://bridge.example\nOAUTH_JWKS_URI=${issuer}/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture-subject\n${extraEnv}`, { mode: 0o600 });
  let output = '', errors = '';
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', ...env } });
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { errors += c; });
  try {
    for (let i = 0; i < 200 && !output.includes('MCP listening') && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(child.exitCode, null, errors);
    const port = /MCP listening on 0\.0\.0\.0:(\d+)/.exec(output)[1];
    const secret = fs.readFileSync(path.join(configDir, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const origin = `http://127.0.0.1:${port}`;
    const challenge = await fetch(`${origin}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(challenge.status, 401);
    const header = challenge.headers.get('www-authenticate');
    const rootMetadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json();
    const pathMetadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource/${secret}/mcp`)).json();
    return { scope: /scope="([^"]*)"/.exec(header)[1], rootScopes: rootMetadata.scopes_supported, pathScopes: pathMetadata.scopes_supported };
  } finally {
    if (child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
  }
}

try {
  const external = await run({});
  assert.equal(external.scope, 'dot-bridge.read', 'external issuer: default challenge keeps the legacy name');
  assert.deepEqual(external.rootScopes, LEGACY);
  assert.deepEqual(external.pathScopes, LEGACY);
  console.log('PASS external issuer defaults to the legacy scope names in the challenge and metadata');

  const optIn = await run({ extraEnv: 'OAUTH_SCOPE_NAMES=neutral\n' });
  assert.equal(optIn.scope, 'dalan.read');
  assert.deepEqual(optIn.rootScopes, NEUTRAL);
  assert.deepEqual(optIn.pathScopes, NEUTRAL);
  console.log('PASS OAUTH_SCOPE_NAMES=neutral opts in to the neutral names');

  const frozen = await run({ extraEnv: 'OAUTH_SCOPE_NAMES=neutral\n', env: { DOT_BRIDGE_CATALOG_PROFILE: 'legacy-v46' } });
  assert.equal(frozen.scope, 'dot-bridge.read', 'legacy-v46 profile challenge matches its securitySchemes');
  assert.deepEqual(frozen.rootScopes, LEGACY);
  assert.deepEqual(frozen.pathScopes, LEGACY);
  console.log('PASS the frozen legacy-v46 catalog profile uses the legacy names even with the opt-in');

  // Only `legacy` and `neutral` are accepted; any other value stops startup instead of silently keeping the legacy names.
  const configHome = fs.mkdtempSync(path.join(tempRoot, 'scope-names-config-'));
  homes.push(configHome);
  const oauthFile = path.join(configHome, 'oauth.env');
  const base = 'OAUTH_ISSUER=https://issuer.example\nOAUTH_AUDIENCE=https://bridge.example\nOAUTH_JWKS_URI=https://issuer.example/jwks\nOAUTH_ALLOWED_SUBJECTS=fixture-subject\n';
  for (const value of ['legacy', 'neutral']) {
    fs.writeFileSync(oauthFile, `${base}OAUTH_SCOPE_NAMES=${value}\n`, { mode: 0o600 });
    assert.equal(authConfig(oauthFile, false).OAUTH_SCOPE_NAMES, value);
  }
  for (const value of ['Neutral', 'dalan', '']) {
    fs.writeFileSync(oauthFile, `${base}OAUTH_SCOPE_NAMES=${value}\n`, { mode: 0o600 });
    assert.throws(() => authConfig(oauthFile, false), /OAUTH_SCOPE_NAMES must be legacy or neutral/, `OAUTH_SCOPE_NAMES=${value} is refused`);
  }
  console.log('PASS an unknown OAUTH_SCOPE_NAMES value stops startup');

  // Built-in mode uses the neutral names, and the frozen profile switches it to the legacy names too.
  const builtin = { builtin: true, OAUTH_AUDIENCE: 'https://bridge.example/s/mcp', OAUTH_ISSUER: 'https://bridge.example', OAUTH_CHALLENGE_SCOPE: 'dalan.read dalan.work' };
  assert.match(challenge(builtin), /scope="dalan\.read dalan\.work"/);
  assert.deepEqual(protectedResource(builtin).scopes_supported, NEUTRAL);
  const frozenBuiltin = { ...builtin, legacyScopeNames: true };
  assert.match(challenge(frozenBuiltin), /scope="dot-bridge\.read dot-bridge\.work"/);
  assert.match(challenge(frozenBuiltin, 'dalan.work'), /scope="dot-bridge\.work"/);
  assert.deepEqual(protectedResource(frozenBuiltin).scopes_supported, LEGACY);
  console.log('PASS built-in mode uses the neutral names; the frozen profile switches the built-in challenge and metadata to the legacy names');
} finally {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
}
