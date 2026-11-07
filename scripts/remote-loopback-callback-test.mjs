import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAsConfig, parseCallbackPattern, matchesCallback, parseAsConfig } from '../src/as-files.mjs';
import { formatPending } from '../src/connect-cli.mjs';

for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
  const pattern = parseCallbackPattern(`http://${host}/callback`);
  for (const port of [undefined, 1, 43210, 65535]) {
    const uri = `http://${host}${port ? `:${port}` : ''}/callback`;
    assert.equal(matchesCallback([pattern], uri), true, uri);
  }
  for (const uri of [
    `http://${host}:0/callback`, `http://${host}:65536/callback`, `http://${host}:01/callback`,
    `http://${host}/Callback`, `http://${host}/callback/`, `http://${host}/callback?`,
    `http://${host}/callback#`, `http://user@${host}/callback`, `http://${host}/a/../callback`,
    `http://${host}/%63allback`, `http://${host}/a%2fb`, `http://${host}/a//b`,
  ]) assert.equal(matchesCallback([pattern], uri), false, uri);
}
const ipPattern = parseCallbackPattern('http://127.0.0.1/callback');
for (const host of ['localhost.', '127.1', '127.0.0.2', '2130706433', '0x7f000001', '0.0.0.0', '127.0.0.1.evil']) {
  assert.equal(matchesCallback([ipPattern], `http://${host}:43210/callback`), false, host);
}
// The host compare in matchesCallback: an entry for one loopback spelling admits no other.
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
for (const allowed of loopbackHosts) {
  for (const requested of loopbackHosts) {
    assert.equal(matchesCallback([parseCallbackPattern(`http://${allowed}/callback`)], `http://${requested}:43210/callback`), allowed === requested, `${allowed} entry vs ${requested} request`);
  }
}
for (const host of ['[::ffff:127.0.0.1]', '[0:0:0:0:0:0:0:1]', '[::1%25lo0]']) {
  assert.equal(matchesCallback([parseCallbackPattern('http://[::1]/callback')], `http://${host}:43210/callback`), false, host);
}
for (const pattern of ['http://127.0.0.1:8080/callback', 'http://127.0.0.1/c*', 'http://127.0.0.1/a/../callback', 'http://127.0.0.1/a//b', 'http://127.0.0.1/callback?', 'http://127.0.0.1/callback/', 'http://127.0.0.1/a+b', 'http://127.0.0.1/a:b', 'http://127.0.0.1/a%2Fb']) {
  assert.throws(() => parseCallbackPattern(pattern), undefined, pattern);
}
assert.throws(() => parseCallbackPattern('http://example.test/callback'), /HTTP is only allowed for canonical native loopback callbacks/);
const https = parseCallbackPattern('https://vendor.example/callback');
assert.equal(matchesCallback([https], 'https://vendor.example/callback'), true);
assert.equal(matchesCallback([https], 'http://vendor.example/callback'), false);
// Existing profiles can contain the root callback from before strict native path parsing.
for (const host of ['127.0.0.1', '[::1]']) {
  const upgraded = parseAsConfig({ version: 1, public_url: 'https://bridge.example', callbacks: [`http://${host}/`] });
  assert.equal(upgraded.callbacks[0], `http://${host}/`);
  assert.equal(matchesCallback(upgraded.patterns, `http://${host}:43210/`), true);
  const fixture = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'dalan-as-root-upgrade-'));
  try {
    fs.chmodSync(fixture, 0o700);
    fs.writeFileSync(path.join(fixture, 'as.json'), JSON.stringify({ version: 1, public_url: 'https://bridge.example', callbacks: [`http://${host}/`] }), { mode: 0o600 });
    const loaded = loadAsConfig(fixture);
    assert.equal(matchesCallback(loaded.patterns, `http://${host}:43210/`), true, 'root callback in an existing config must keep working after upgrade');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
for (const callback of ['http://127.0.0.1/callback/', 'http://127.0.0.1/a+b', 'http://127.0.0.1/a:b', 'http://127.0.0.1/a%2Fb']) {
  const fixture = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'dalan-as-legacy-callback-'));
  try {
    fs.chmodSync(fixture, 0o700);
    fs.writeFileSync(path.join(fixture, 'as.json'), JSON.stringify({ version: 1, public_url: 'https://bridge.example', callbacks: [callback] }), { mode: 0o600 });
    const loaded = loadAsConfig(fixture);
    assert.equal(loaded.callbacks[0], callback);
    const withPort = callback.replace('://127.0.0.1/', '://127.0.0.1:43210/');
    assert.equal(matchesCallback(loaded.patterns, withPort), true, `stored callback must keep matching after upgrade: ${callback}`);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
const longRedirect = `http://127.0.0.1:43210/${'x'.repeat(240)}`;
const pendingText = formatPending({ window: { worker: 'acme', expires_at: 'soon' }, pending: [{
  code: 'ABCD-EFGH', worker: 'acme', client_id: 'client-1', client_name: 'Codex', redirect_uri: longRedirect,
  resource: 'https://bridge.example/<secret>/mcp', scopes: ['dot-bridge.read'], age_seconds: 1, expires_in_seconds: 90, native: true,
}] });
for (const expected of [longRedirect, 'client-1', 'ABCD-EFGH', 'acme', 'dot-bridge.read', 'identity not verified', 'typo check only']) assert.ok(pendingText.includes(expected), expected);
assert.doesNotMatch(pendingText, /--confirm-redirect/);
console.log('PASS remote loopback callback parser matrix');
