#!/usr/bin/env node
// Real public HTTP + owner-socket CLI; no vendor traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'as-exposure-'));
const config = path.join(root, '.config/dot-bridge');
const port = await reservedPort();
const pub = `http://127.0.0.1:${port}`;
const env = { ...process.env, HOME: root, DOT_BRIDGE_AUTH_MODE: 'builtin', DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_TEST_OAUTH: '1', NODE_ENV: 'test' };
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify({ workers: { lark: {} } }), { mode: 0o600 });
const cli = (...args) => spawnSync(process.execPath, ['bin/dot-worker.mjs', 'connect', ...args, '--json'], { cwd: repo, env, encoding: 'utf8' });
const owner = (...args) => { const r = cli(...args); assert.equal(r.status, 0, 'owner command failed'); return JSON.parse(r.stdout); };
assert.equal(spawnSync(process.execPath, ['bin/dot-worker.mjs', 'as-init', '--public-url', pub], { cwd: repo, env, stdio: 'ignore' }).status, 0);
const child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false;
child.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; });
child.stderr.resume();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];
async function check(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); } }
try {
  for (let i = 0; i < 300 && !ready && child.exitCode === null; i++) await sleep(50);
  assert.ok(ready, 'bridge startup');
  const secret = fs.readFileSync(path.join(config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const resource = `${pub}/${secret}/mcp`, issuer = `${pub}/${secret}/oauth`;
  // Legacy fallback only isolates admission findings on the vulnerable revision; discovery check never uses it.
  const legacy = (await fetch(`${pub}/oauth/jwks`)).status === 200;
  const base = legacy ? `${pub}/oauth` : issuer;
  const callback = 'https://claude.ai/api/mcp/auth_callback';
  const register = (extra = {}, endpoint = `${base}/reg`) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none', client_name: 'Exposure test', ...extra }) });
  const start = () => { owner('stop'); owner('start', '--worker', 'lark'); };
  const authUrl = (client, endpoint = `${base}/auth`, challenge = randomBytes(32).toString('base64url'), requestedResource = resource) => `${endpoint}?${new URLSearchParams({ client_id: client, response_type: 'code', redirect_uri: callback, scope: 'dot-bridge.read', resource: requestedResource, code_challenge_method: 'S256', code_challenge: challenge, state: 'exposure-test' })}`;
  await check('P1-1 registration outside window refused', async () => { assert.equal((await register()).status, 403, 'anonymous DCR was admitted outside a window'); });
  await check('P1-1 registration flood bounded; reset restores admission', async () => {
    start();
    const results = await Promise.all(Array.from({ length: 8 }, () => register()));
    assert.equal(results.filter(r => r.status === 201).length, 5, 'window must admit exactly five clients');
    assert.ok(results.filter(r => r.status === 429).length === 3, 'excess clients must be refused');
    owner('start', '--worker', 'lark');
    assert.equal((await register()).status, 429, 'extending a window reset its budget');
    owner('reset');
    assert.equal((await register()).status, 201, 'reset did not restore registration');
    // Hold a real DCR body after its budget reservation, then reset before releasing it.
    const body = JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none' });
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request(`${base}/reg`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      request.on('error', reject); request.write(body.slice(0, 1));
    });
    try {
      const db = new DatabaseSync(path.join(config, 'as.sqlite'));
      try {
        for (let i = 0; i < 100; i++) {
          if (db.prepare('SELECT registrations FROM windows WHERE id=1').get()?.registrations === 2) break;
          await sleep(10);
        }
        assert.equal(db.prepare('SELECT registrations FROM windows WHERE id=1').get()?.registrations, 2, 'held DCR did not reach the parser');
      } finally { db.close(); }
      owner('reset'); request.end(body.slice(1));
      assert.equal(await response, 403, 'a pre-reset registration recreated cleared state');
      assert.equal((await register()).status, 201, 'stale request consumed the new budget');
    } finally { request.destroy(); await response.catch(() => {}); }

  });
  await check('P1-1 oversized client metadata refused', async () => {
    start();
    assert.equal((await register({ client_name: 'x'.repeat(40960) })).status, 413, '40 KiB client body was accepted');
    for (const extra of [
      { client_name: 'x'.repeat(129) },
      { client_uri: `https://vendor.example/${'x'.repeat(5000)}` },
      { redirect_uris: Array.from({ length: 9 }, (_, i) => `https://chatgpt.com/connector/oauth/client${i}`) },
      { redirect_uris: [`https://chatgpt.com/connector/oauth/${'x'.repeat(513)}`] },
    ]) {
      assert.ok(Buffer.byteLength(JSON.stringify(extra)) < 8000, 'metadata case must fit the HTTP body limit');
      const r = await register(extra); assert.equal(r.status, 400, 'metadata size limit was bypassed');
      assert.match((await r.json()).error_description, /size limit/, 'wrong rejection: metadata policy was not exercised');
    }
  });
  await check('P1-2 interaction flood bounded; reset restores admission', async () => {
    start(); const r = await register(); assert.equal(r.status, 201); const client = (await r.json()).client_id;
    const results = await Promise.all(Array.from({ length: 8 }, () => fetch(authUrl(client), { redirect: 'manual' })));
    assert.equal(results.filter(r => r.status === 303).length, 5, 'window must admit exactly five live interactions');
    const busy = results.find(r => r.status === 503); assert.ok(busy); assert.match(await busy.text(), /connect reset/);
    owner('reset');
    // reset deletes this unapproved client too: a fresh client must work.
    const fresh = (await (await register()).json()).client_id;
    assert.equal((await fetch(authUrl(fresh), { redirect: 'manual' })).status, 303);
  });
  await check('P2-4 root discovery never contains secret', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/openid-configuration', '/.well-known/openid-configuration/oauth', '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/oauth', '/oauth/.well-known/openid-configuration', '/oauth/reg']) {
      const r = await fetch(pub + p); const body = await r.text(); assert.ok(!body.includes(secret), 'root discovery leaked path secret'); assert.equal(r.status, 404, 'root OAuth surface remains public');
    }
  });
  await check('P2-4 suffixed discovery DCR -> approve -> token -> MCP initialize', async () => {
    start();
    const protectedResponse = await fetch(`${pub}/.well-known/oauth-protected-resource/${secret}/mcp`);
    assert.equal(protectedResponse.status, 200); assert.equal(protectedResponse.headers.get('cache-control'), 'no-store');
    const metadata = await protectedResponse.json(); assert.equal(metadata.resource, resource);
    const discoveredIssuer = new URL(metadata.authorization_servers[0]);
    assert.equal(discoveredIssuer.href, issuer);
    const response = await fetch(`${discoveredIssuer.origin}/.well-known/oauth-authorization-server${discoveredIssuer.pathname}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const discovery = await response.json();
    for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'jwks_uri']) assert.ok(discovery[k].startsWith(issuer + '/'), 'endpoint escaped secret namespace');
    const r = await register({}, discovery.registration_endpoint); assert.equal(r.status, 201); const client = (await r.json()).client_id;
    const verifier = randomBytes(32).toString('base64url');
    const cookies = new Map();
    const browser = async url => {
      const res = await fetch(url, { redirect: 'manual', headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const c of res.headers.getSetCookie()) { const pair = c.split(';')[0], i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
      return res;
    };
    let res = await browser(authUrl(client, discovery.authorization_endpoint, createHash('sha256').update(verifier).digest('base64url'), metadata.resource));
    assert.equal(res.status, 303); const interaction = new URL(res.headers.get('location'), discoveredIssuer).href;
    res = await browser(interaction); assert.equal(res.status, 200);
    const code = (await res.text()).match(/class="code">([A-Z0-9-]+)</)?.[1]; assert.ok(code, 'missing pairing code');
    owner('approve', code, '--worker', 'lark', '--replace');
    owner('reset'); // Preserve an approved attempt before the interaction completes.
    res = await browser(interaction); assert.equal(res.status, 303);
    owner('reset'); // Preserve its provider resume record until the browser consumes it.
    res = await browser(new URL(res.headers.get('location'), discoveredIssuer)); assert.equal(res.status, 303, 'approved resume was lost after reset');
    const returned = new URL(res.headers.get('location')); assert.equal(returned.origin + returned.pathname, callback);
    res = await fetch(discovery.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client, grant_type: 'authorization_code', code: returned.searchParams.get('code'), redirect_uri: callback, code_verifier: verifier, resource: metadata.resource }) });
    assert.equal(res.status, 200); const token = await res.json(); assert.ok(token.access_token);
    // Reset preserves approved clients, grants and access tokens.
    owner('reset');
    res = await fetch(metadata.resource, { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'exposure-test', version: '1' } } }) });
    assert.equal(res.status, 200); assert.ok((await res.json()).result.serverInfo);
  });
  const slow = (kind, deadline) => new Promise((resolve, reject) => {
    const began = performance.now();
    const socket = net.connect(port, '127.0.0.1'); let drip;
    const timer = setTimeout(() => { clearInterval(drip); socket.destroy(); reject(new Error(`${kind} still open past ${deadline}ms deadline`)); }, deadline);
    socket.on('connect', () => {
      socket.write(kind === 'header' ? 'POST / HTTP/1.1\r\nHost: ' : `POST ${new URL(base).pathname}/reg HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n`);
      drip = setInterval(() => socket.write(' '), 200);
    });
    socket.on('data', () => {}); socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer); clearInterval(drip);
      const elapsed = Math.round(performance.now() - began);
      if (elapsed < (kind === 'header' ? 8000 : 28000)) return reject(new Error(`${kind} closed early; deadline was not exercised`));
      console.log(`NOTE ${kind} closed in ${elapsed}ms while bytes arrived every 200ms`);
      resolve();
    });
  });
  await check('P2-5 slow headers closed by deadline', async () => {
    await slow('header', 13000);
    // Exercise the same listener policy with a real, silent SSE response. Shorten only this socket's
    // inactivity timer so the regression is deterministic without holding a test connection for three minutes.
    const { createBuiltinHttpServer } = await import('../src/builtin-http.mjs');
    const timers = new Set();
    const streaming = createBuiltinHttpServer((req, res) => {
      res.setTimeout(50);
      // Cover both Node writeHead header formats and setHeader; explicit headers must override stored ones.
      if (req.url === '/object') { res.setHeader('content-type', 'application/json'); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); }
      else if (req.url === '/array') res.writeHead(200, ['Content-Type', 'text/event-stream']);
      else if (req.url === '/stored') { res.setHeader('content-type', 'text/event-stream'); res.writeHead(200); }
      else res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      const timer = setTimeout(() => { timers.delete(timer); res.end(req.url === '/json' ? '{}' : 'data: alive\n\n'); }, 200);
      timers.add(timer);
    });
    try {
      assert.equal(streaming.headersTimeout, 10000); assert.equal(streaming.requestTimeout, 30000);
      assert.equal(streaming.keepAliveTimeout, 5000); assert.equal(streaming.maxConnections, 128); assert.equal(streaming.timeout, 180000);
      await new Promise(resolve => streaming.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${streaming.address().port}`;
      for (const suffix of ['/object', '/array', '/stored']) assert.equal(await (await fetch(base + suffix)).text(), 'data: alive\n\n', 'silent SSE was cut off');
      await assert.rejects(async () => (await fetch(base + '/json')).text(), 'ordinary stalled response did not expire');
    } finally { for (const timer of timers) clearTimeout(timer); streaming.closeAllConnections(); await new Promise(resolve => streaming.close(resolve)); }
  });
  await check('P2-5 slow body closed by deadline', async () => { start(); await slow('body', 33000); });
} finally {
  child.kill('SIGTERM'); if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`RESULT ${failures.length ? 'FAIL' : 'PASS'} (${failures.length} failures)`);
process.exitCode = failures.length ? 1 : 0;
