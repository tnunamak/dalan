#!/usr/bin/env node
// Built-in authorization server (S5a), offline. A real bridge process, a real oidc-provider, the real SQLite adapter and the real
// `dot-worker connect` CLI. The vendor is a fake Node client: DCR, PKCE S256, a browser leg with a cookie jar, token, refresh, then MCP calls.
// Tests 1-11 are the profile's negative conformance tests. Tests 12-16 are the groups from review r3. Each assertion prints one PASS or FAIL line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn, spawnSync } from 'node:child_process';
import { barrierPreload, armStartBarrier, releaseStartBarrier } from './as-start-barrier.mjs';
import Keygrip from 'keygrip';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { loadKeys, COOKIE_RETAIN_MS } from '../src/as-files.mjs';
import { connectCommand } from '../src/connect-cli.mjs';
import { createHash, createHmac, createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { CALLBACK, Jar, Vendor, form, hit, pkce } from './live-trial/fake-vendor.mjs';
import { DatabaseSync } from 'node:sqlite';
import { fetchFresh as fetch } from '../src/test-support/fetch.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'dbas-'));
// Startup refuses a worker with the t3 capability when t3code is not on PATH (intended). This suite never calls t3code, so
// a stub on PATH keeps it hermetic whether or not the host (or a sandbox) has the real binary.
const stubBin = path.join(root, 'stub-bin');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 't3code'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
// Test-only wall clock: exercise real provider expiry checks without waiting an hour.
const clockModule = path.join(root, 'clock.mjs');
fs.writeFileSync(clockModule, `import fs from 'node:fs';
const RealDate = Date;
const now = () => Number(fs.readFileSync(process.env.AS_TEST_CLOCK, 'utf8'));
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now()])); }
  static now() { return now(); }
};`);
const failures = [], results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const only = process.env.AS_E2E_ONLY ? new Set(process.env.AS_E2E_ONLY.split(',')) : null; // developer aid: run a few checks
async function check(id, name, fn) {
  if (only && !only.has(id)) return;
  try { await fn(); results.push([id, 'PASS']); console.log(`PASS ${id} ${name}`); }
  catch (error) {
    failures.push(id); results.push([id, 'FAIL']);
    console.log(`FAIL ${id} ${name}: ${String(error.stack ?? error)}`);
    console.error('error details:', { code: error.code, cause: error.cause });
    console.error('bridge state:', { main: { exitCode: main.exited, stderr: main.stderr }, second: { exitCode: second.exited, stderr: second.stderr } });
  }
}
const note = text => console.log(`NOTE ${text}`);
const freePort = reservedPort;

async function eventReceiver({ holdVerification = false } = {}) {
  const events = [];
  let announceVerification, releaseVerification;
  const verificationSeen = new Promise(resolve => { announceVerification = resolve; });
  const verificationGate = new Promise(resolve => { releaseVerification = resolve; });
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.type === 'verification') {
      announceVerification();
      if (holdVerification) await verificationGate;
      return res.end(JSON.stringify({ challenge: message.challenge }));
    }
    events.push(message.data?.request_id ?? null);
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, events, verificationSeen, releaseVerification, url: `http://127.0.0.1:${server.address().port}/events`, close: () => new Promise(resolve => server.close(resolve)) };
}
// A raw request: lets a test set the Host header (fetch forbids it).
function raw(port, { path: p, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text })); });
    req.on('error', reject); req.end(body);
  });
}
const keysOf = async srv => (await (await fetch(`${srv.oauth}/jwks`)).json()).keys;
const verifyJwt = (jwt, keys) => {
  const [h, p, sig] = jwt.split('.'); const kid = JSON.parse(Buffer.from(h, 'base64url')).kid; const key = keys.find(k => k.kid === kid);
  return { kid, ok: !!key && cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')) };
};

// ---------------------------------------------------------------- a bridge process in built-in mode
class Bridge {
  constructor(name, { workers = { dot: { capabilities: ['t3'] }, lark: {}, duet: {} }, rawWorkers = null, authMode = 'builtin' } = {}) {
    this.name = name; this.home = path.join(root, name); this.config = path.join(this.home, '.config/dot-bridge');
    this.rawWorkers = rawWorkers ?? JSON.stringify({ workers });
    this.authMode = authMode;
  }
  get env() { const e = { ...process.env, PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: this.home, DOT_BRIDGE_PORT: String(this.port), DOT_BRIDGE_AUTH_MODE: this.authMode, DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1', NODE_ENV: 'test' }; if (this.noTestFlag) delete e.DOT_BRIDGE_TEST_OAUTH; return e; }
  async init() {
    this.port = await freePort();
    this.pub = `http://127.0.0.1:${this.port}`;
    fs.mkdirSync(this.config, { recursive: true });
    fs.writeFileSync(path.join(this.config, 'workers.json'), this.rawWorkers, { mode: 0o600 });
    const r = this.cli(['as-init', '--public-url', this.pub]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const asConfig = path.join(this.config, 'as.json');
    const config = JSON.parse(fs.readFileSync(asConfig, 'utf8'));
    config.limits = { registrations: 100, interactions: 25 };
    fs.writeFileSync(asConfig, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    this.secret = null;
    return this;
  }
  async start(gate) {
    this.exited = null; this.stderr = '';
    const child = gate
      ? armStartBarrier(fork('src/server.mjs', [], { cwd: repo, env: { ...this.env, AS_START_GATE: gate }, execArgv: ['--import', barrierPreload], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
      : spawn(process.execPath, [...(this.clockFile ? ['--import', clockModule] : []), 'src/server.mjs'], { cwd: repo, env: { ...this.env, ...(this.clockFile ? { AS_TEST_CLOCK: this.clockFile } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let ready = false;
    child.stdout.on('data', b => { if (/MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):\d+/.test(String(b))) ready = true; });
    child.stderr.on('data', b => { this.stderr += b; });
    child.once('exit', code => { this.exited = code; });
    for (let i = 0; i < 300 && !ready && this.exited === null; i++) await sleep(50);
    if (!ready) return false;
    this.secret = fs.readFileSync(path.join(this.config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    this.resource = `${this.pub}/${this.secret}/mcp`;
    this.oauth = `${this.pub}/${this.secret}/oauth`;
    return true;
  }
  async stop() { if (this.child && this.child.exitCode === null && this.child.signalCode === null) { this.child.kill('SIGTERM'); await new Promise(resolve => this.child.once('exit', resolve)); } }
  cli(args, input) { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env: this.env, input, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr, json() { return JSON.parse(r.stdout); } }; }
  cliAsync(args) { return new Promise(resolve => { const c = spawn(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env: this.env }); let stdout = '', stderr = ''; c.stdout.on('data', b => { stdout += b; }); c.stderr.on('data', b => { stderr += b; }); c.on('exit', code => resolve({ code, stdout, stderr })); }); }
  tokenId(model, token) {
    return createHmac('sha256', fs.readFileSync(path.join(this.config, 'as-storage.key'))).update(`id:${model}`).update('\0').update(token).digest('base64url');
  }
  changeToken(token, changes) {
    const id = this.tokenId('AccessToken', token), context = `oidc:AccessToken:${id}`;
    const row = this.sql("SELECT payload FROM oidc WHERE model='AccessToken' AND id=?", id)[0];
    const payload = { ...JSON.parse(this.decrypt(row.payload, context)), ...changes };
    this.sql("UPDATE oidc SET payload=? WHERE model='AccessToken' AND id=?", this.encrypt(JSON.stringify(payload), context), id);
  }
  encrypt(value, context) {
    const key = fs.readFileSync(path.join(this.config, 'as-storage.key'));
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }
  decrypt(value, context) {
    const [, iv, tag, data] = value.split('.');
    const cipher = createDecipheriv('aes-256-gcm', fs.readFileSync(path.join(this.config, 'as-storage.key')), Buffer.from(iv, 'base64url'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url')); cipher.setAAD(Buffer.from(context));
    return Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8');
  }
  sql(query, ...args) { const db = new DatabaseSync(path.join(this.config, 'as.sqlite')); db.exec('PRAGMA busy_timeout=5000'); try { return /^\s*select/i.test(query) ? db.prepare(query).all(...args) : db.prepare(query).run(...args); } finally { db.close(); } }
  bridgeDb(query, ...args) { const db = new DatabaseSync(path.join(this.home, '.local/share/dot-bridge/bridge.db')); db.exec('PRAGMA busy_timeout=5000'); try { return /^\s*select/i.test(query) ? db.prepare(query).all(...args) : db.prepare(query).run(...args); } finally { db.close(); } }
  async rpc(bearer, method, params = {}) {
    const res = await fetch(this.resource, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }
  async tool(bearer, name, args = {}) {
    const { status, body } = await this.rpc(bearer, 'tools/call', { name, arguments: args });
    if (status !== 200) return { ok: false, status };
    const text = body.result.content[0].text;
    return body.result.isError ? { ok: false, error: text } : { ok: true, value: JSON.parse(text) };
  }
  submit(id, worker) { return this.cli(['submit', '--stdin', '--json', '--queue-anyway', ...(worker ? ['--worker', worker] : [])], JSON.stringify({ schema_version: 1, request_id: id, brief: `as-e2e ${id}`, inputs: [{ revision: 'abc' }], expected_output: 'one result', execution_scope: 'read-only' })); }
  // `connect start` itself drops unapproved attempts left from earlier windows.
  start_window(worker, minutes) { this.stop_window(); const r = this.cli(['connect', 'start', '--worker', worker, ...(minutes ? ['--minutes', String(minutes)] : []), '--json']); assert.equal(r.code, 0, r.stderr + r.stdout); return r.json(); }
  repeat_window(worker) { const r = this.cli(['connect', 'start', '--worker', worker, '--json']); assert.equal(r.code, 0, r.stderr + r.stdout); return r.json(); }
  stop_window() { return this.cli(['connect', 'stop', '--json']); }
  pending() { const r = this.cli(['connect', 'pending', '--json']); assert.equal(r.code, 0, r.stderr); return r.json(); }
  approve(code, worker, replace = true) {
    const pairing = this.pending().pending.find(item => item.code === code);
    return this.cli(['connect', 'approve', code, '--worker', worker, ...(pairing?.native ? ['--confirm-redirect', pairing.redirect_uri] : []), ...(replace ? ['--replace'] : []), '--json']);
  }
  list() { return this.cli(['connect', 'list', '--json']).json(); }
  async metadata() { return (await fetch(`${this.pub}/.well-known/oauth-authorization-server/${this.secret}/oauth`)).json(); }
}

// ---------------------------------------------------------------- setup
const main = await new Bridge('main').init();
const second = await new Bridge('second').init(); // bounded-storage and fail-closed tests that must not disturb the main run
const sink = http.createServer((req, res) => { sinkHits.push(`${req.method} ${req.url}`); res.end('{}'); }); // SSRF canary
const sinkHits = [];
await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
const sinkUrl = `http://127.0.0.1:${sink.address().port}`;
const stopAll = async () => { await main.stop(); await second.stop(); sink.close(); };
process.on('exit', () => { if (process.env.KEEP_TEST_FIXTURES !== '1') try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

try {
  assert.equal(await main.start(), true, `main bridge did not start: ${main.stderr}`);
  assert.equal(await second.start(), true, `second bridge did not start: ${second.stderr}`);
  for (const srv of [main, second]) { const r = srv.cli(['connect', 'allow-callback', CALLBACK]); assert.equal(r.code, 0, r.stderr); }
  assert.equal(main.cli(['connect', 'allow-callback', 'https://vendor.example/other/*']).code, 0);
  const vendor = new Vendor(main), vendorB = new Vendor(main, 'https://vendor.example/other/b');
  main.start_window('lark');
  assert.equal((await vendor.register()).status, 201);
  assert.equal((await vendorB.register()).status, 201);

  // ---- baseline: discovery, the positive flow, worker resolution -------------------------------------------------------------
  await check('P0', 'discovery: issuer and endpoints come from configuration; PRM names the single resource; client auth is none only', async () => {
    const meta = await main.metadata();
    assert.equal(meta.issuer, `${main.oauth}`);
    assert.equal(meta.token_endpoint, `${main.oauth}/token`);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(meta.response_types_supported, ['code']);
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(meta.authorization_response_iss_parameter_supported, true);
    for (const off of ['pushed_authorization_request_endpoint', 'userinfo_endpoint', 'introspection_endpoint', 'device_authorization_endpoint', 'end_session_endpoint']) assert.equal(meta[off], undefined, off);
    assert.ok(meta.registration_endpoint && meta.revocation_endpoint);
    const openid = await (await fetch(`${main.oauth}/.well-known/openid-configuration`)).json();
    assert.equal(openid.issuer, meta.issuer);
    const prm = await (await fetch(`${main.pub}/.well-known/oauth-protected-resource/${main.secret}/mcp`)).json();
    assert.equal(prm.resource, main.resource); assert.deepEqual(prm.authorization_servers, [meta.issuer]);
    const jwks = await (await fetch(meta.jwks_uri)).json();
    assert.ok(jwks.keys.length && jwks.keys.every(k => k.d === undefined && k.kty === 'EC'), 'JWKS must hold public keys only');
    const unauth = await main.rpc(null, 'tools/list');
    assert.equal(unauth.status, 401); assert.match(unauth.headers.get('www-authenticate'), /resource_metadata=.*oauth-protected-resource/);
  });

  await check('P0b', 'registration agrees with the metadata: an omitted or unsupported token_endpoint_auth_method is registered as none, with no client_secret (RFC 7591 s2, s3.2.1)', async () => {
    const reg = body => fetch(`${main.oauth}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], ...body }) });
    for (const [label, extra] of [['omitted', {}], ['client_secret_basic', { token_endpoint_auth_method: 'client_secret_basic' }], ['client_secret_post with a secret', { token_endpoint_auth_method: 'client_secret_post', client_secret: 'x' }], ['none', { token_endpoint_auth_method: 'none' }]]) {
      const res = await reg(extra); const doc = await res.json();
      assert.equal(res.status, 201, `${label}: ${JSON.stringify(doc)}`);
      assert.equal(doc.token_endpoint_auth_method, 'none', label);
      assert.equal(Object.hasOwn(doc, 'client_secret'), false, `${label}: no client_secret is issued`);
      assert.equal(Object.hasOwn(doc, 'client_secret_expires_at'), false, label);
    }
    assert.equal((await fetch(`${main.oauth}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })).status, 400, 'a body that is not JSON is still refused');
    const raw = (body, type = 'application/json') => fetch(`${main.oauth}/reg`, { method: 'POST', headers: { 'content-type': type }, body });
    const inner = JSON.stringify({ redirect_uris: [CALLBACK] });
    for (const [label, body] of [['a JSON string holding serialized JSON', JSON.stringify(inner)], ['an array', '[]'], ['null', 'null'], ['a number', '1']]) {
      const res = await raw(body); const doc = await res.json();
      assert.equal(res.status, 400, `${label} is refused, not parsed a second time: ${JSON.stringify(doc)}`); assert.equal(doc.error, 'invalid_request', label);
    }
    assert.equal((await raw(inner, 'application/json; charset=latin1')).status, 400, 'a declared charset other than UTF-8 is refused');
    assert.equal((await raw(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).status, 400, 'bytes that are not UTF-8 are refused');
    assert.equal((await raw(inner, 'application/json; charset=UTF-8')).status, 201, 'a declared UTF-8 charset is accepted');
  });

  let lark, duet;
  await check('P1', 'positive flow: DCR, PKCE, CLI approval, token, worker resolution, only that worker\'s job, refresh, revoke, next call refused', async () => {
    lark = await vendor.connect('lark');
    duet = await vendorB.connect('duet');
    const ids = { lark: `req_m_${randomUUID().slice(0, 8)}`, duet: `req_d_${randomUUID().slice(0, 8)}`, legacy: `req_t_${randomUUID().slice(0, 8)}` };
    assert.equal(main.submit(ids.lark, 'lark').code, 0); assert.equal(main.submit(ids.duet, 'duet').code, 0); assert.equal(main.submit(ids.legacy, 'dot').code, 0);
    const seen = async bearer => (await main.tool(bearer, 'list_pending')).value;
    const asText = value => JSON.stringify(value);
    const m = asText(await seen(lark.access)), d = asText(await seen(duet.access));
    assert.ok(m.includes(ids.lark) && !m.includes(ids.duet) && !m.includes(ids.legacy), `lark sees: ${m}`);
    assert.ok(d.includes(ids.duet) && !d.includes(ids.lark) && !d.includes(ids.legacy), `duet sees: ${d}`);
    const crossClaim = await main.tool(lark.access, 'claim', { request_id: ids.duet, claimant: 'lark' });
    assert.equal(crossClaim.ok, false, 'lark claimed duet\'s job');
    const own = await main.tool(lark.access, 'claim', { request_id: ids.lark, claimant: 'lark' });
    assert.equal(own.ok, true, JSON.stringify(own));
    assert.equal(main.bridgeDb('SELECT execution FROM assignments WHERE request_id=?', ids.lark)[0].execution, 'none', 'repo-free worker onboarding must keep execution disabled');
    const finished = await main.tool(lark.access, 'finish', { request_id: ids.lark, claim_id: own.value.claim_id, outcome: 'completed', summary: 'local onboarding smoke', result: 'fixture result for owner' });
    assert.equal(finished.ok, true, JSON.stringify(finished));
    const ownerResult = main.cli(['get', ids.lark, '--json']);
    assert.equal(ownerResult.code, 0, ownerResult.stderr);
    assert.equal(ownerResult.json().report.result, 'fixture result for owner', 'owner CLI did not receive the worker result');
    assert.equal(main.bridgeDb("SELECT count(*) n FROM subscriptions WHERE state='active'")[0].n, 0, 'manual onboarding created a recurring subscription');
    const names = async bearer => (await main.rpc(bearer, 'tools/list')).body.result.tools.map(t => t.name);
    assert.ok(!(await names(lark.access)).includes('notify_owner'), 'a worker without the t3 capability sees T3 tools');
    const refreshed = await vendor.refresh(lark.refresh);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.refresh_token, lark.refresh); lark.refresh = refreshed.body.refresh_token; lark.access = refreshed.body.access_token;
    assert.equal((await main.rpc(lark.access, 'tools/list')).status, 200);
    const revoked = main.cli(['connect', 'revoke', 'lark', '--json']); assert.equal(revoked.code, 0, revoked.stderr);
    assert.equal((await main.rpc(lark.access, 'tools/list')).status, 401, 'revoked connection must be refused at once');
    assert.equal((await main.rpc(duet.access, 'tools/list')).status, 200, 'revoking one worker must not touch another');
  });

  await check('P1b', 'a refresh token outlives the browser session (clients without offline_access): refresh twice after the Session expires', async () => {
    main.cli(['connect', 'revoke', 'lark', '--json']);
    const conn = await vendor.connect('lark');
    // The browser session lasts LIFETIMES.session (1 h); the purge then deletes it. Simulate that expiry directly.
    const removed = main.sql("DELETE FROM oidc WHERE model='Session'").changes;
    assert.ok(removed >= 1, 'the connect flow should have left a Session record');
    let refresh = conn.refresh;
    for (const round of [1, 2]) {
      const res = await vendor.refresh(refresh);
      assert.equal(res.status, 200, `refresh ${round} after session expiry: ${JSON.stringify(res.body)}`);
      refresh = res.body.refresh_token;
      assert.equal((await main.rpc(res.body.access_token, 'tools/list')).status, 200, `access token from refresh ${round} works`);
    }
    main.cli(['connect', 'revoke', 'lark', '--json']);
  });

  // ---- 1. PKCE ----------------------------------------------------------------------------------------------------------------
  await check('1a', 'authorization without PKCE is refused and creates nothing', async () => {
    main.start_window('lark');
    const before = main.sql("SELECT count(*) n FROM oidc WHERE model='Interaction'")[0].n;
    const res = await hit(vendor.authUrl({ challenge: null }), { jar: new Jar() });
    const location = res.headers.get('location') ?? '';
    assert.ok(res.status === 400 || new URL(location, main.pub).searchParams.get('error'), `status ${res.status} ${location}`);
    assert.ok(!location.includes(`/${main.secret}/oauth/interaction/`), 'an interaction was created');
    assert.ok(!new URL(location || main.pub, main.pub).searchParams.get('code'));
    assert.equal(main.sql("SELECT count(*) n FROM oidc WHERE model='Interaction'")[0].n, before);
  });
  await check('1b', 'code_challenge_method=plain (and an unknown method) is refused', async () => {
    for (const method of ['plain', 'S512']) {
      const p = pkce();
      const res = await hit(vendor.authUrl({ challenge: p.verifier, method }), { jar: new Jar() });
      const location = res.headers.get('location') ?? '';
      assert.ok(res.status === 400 || new URL(location, main.pub).searchParams.get('error'), `${method}: ${res.status} ${location}`);
      assert.ok(!location.includes(`/${main.secret}/oauth/interaction/`), `${method} created an interaction`);
    }
  });

  // ---- 2. code and verifier --------------------------------------------------------------------------------------------------
  await check('2a', 'a code used twice: the second use is refused (and the family is revoked)', async () => {
    const c = await vendor.connect('lark');
    const again = await vendor.exchange(c.callback.code, c.flow.pkce.verifier);
    assert.equal(again.status, 400); assert.equal(again.body.error, 'invalid_grant');
    const after = await main.rpc(c.access, 'tools/list');
    note(`2a code replay: second exchange invalid_grant; the access token issued from the first use is now HTTP ${after.status}; connection revoked_reason=${main.list().connections.find(x => x.connection_id === c.approval.connection_id)?.revoked_reason}`);
    assert.equal(after.status, 401, 'replay must end the connection (fail closed)');
  });
  await check('2b', 'a code with the wrong verifier, a different redirect, or a different client is refused', async () => {
    const c = await vendor.connect('lark', {}).catch(e => { throw e; });
    // Use a fresh flow so that the code is unused.
    main.start_window('duet');
    const flow = await vendor.begin(); const approved = main.approve(flow.code, 'duet'); assert.equal(approved.code, 0, approved.stderr);
    assert.ok(!approved.stdout.includes(main.secret), 'approval output must not disclose the resource secret');
    const cb = await vendor.finish(flow); assert.equal(cb.stage, 'callback');
    const wrongVerifier = await vendor.exchange(cb.code, pkce().verifier); assert.equal(wrongVerifier.body.error, 'invalid_grant');
    const wrongRedirect = await vendor.exchange(cb.code, flow.pkce.verifier, { redirect_uri: `${CALLBACK}/` }); assert.equal(wrongRedirect.body.error, 'invalid_grant');
    const other = await vendorB.token({ client_id: vendorB.client_id, grant_type: 'authorization_code', code: cb.code, redirect_uri: vendorB.redirect, code_verifier: flow.pkce.verifier, resource: main.resource });
    assert.equal(other.body.error, 'invalid_grant');
    const noVerifier = await vendor.token({ grant_type: 'authorization_code', code: cb.code, redirect_uri: CALLBACK, resource: main.resource }); assert.ok(noVerifier.status >= 400 && !noVerifier.body.access_token);
    assert.ok(c.access);
  });

  // ---- 3. redirect URI exactness ---------------------------------------------------------------------------------------------
  await check('3', 'a redirect URI that differs in any byte is refused with no redirect (path, port, query, slash, scheme, suffix host, case, userinfo)', async () => {
    main.start_window('lark');
    const variants = [`${CALLBACK}/`, `${CALLBACK}x`, 'https://vendor.example:444/oauth/callback', `${CALLBACK}?a=1`, 'http://vendor.example/oauth/callback', 'https://vendor.example.evil.test/oauth/callback', 'https://VENDOR.example/oauth/callback', 'https://x@vendor.example/oauth/callback', `${CALLBACK}#f`, 'https://evil.test/oauth/callback'];
    for (const redirect of variants) {
      const res = await hit(vendor.authUrl({ challenge: pkce().challenge, redirect }), { jar: new Jar() });
      assert.equal(res.status, 400, `${redirect} -> ${res.status} ${res.headers.get('location')}`);
      assert.equal(res.headers.get('location'), null, `${redirect} redirected`);
    }
    // Registration of any of them is refused too (callback allowlist), and so is a second URI that is not on the list.
    for (const redirect of variants.slice(0, 6)) assert.equal((await new Vendor(main, redirect).register()).status, 400, redirect);
    assert.equal((await vendor.register({ redirect_uris: [CALLBACK, 'https://evil.test/cb'] })).status, 400);
    assert.equal((await vendor.register({ application_type: 'native', redirect_uris: ['http://127.0.0.1:9999/cb'] })).status, 400);
    assert.equal((await vendor.register({ redirect_uris: [] })).status, 400);
    assert.equal((await vendor.register({ redirect_uris: undefined })).status, 400);
    const none = await hit(vendor.authUrl({ challenge: pkce().challenge, omit: ['redirect_uri'] }), { jar: new Jar() });
    assert.equal(none.status, 400, 'an omitted redirect_uri must not default to the registered one');
  });

  // ---- 4. resource -----------------------------------------------------------------------------------------------------------
  await check('4a', 'a resource other than the configured one, or none, is refused at authorization', async () => {
    main.start_window('lark');
    for (const resource of ['https://other.example/mcp', `${main.resource}/`, main.pub, null]) {
      const res = await hit(vendor.authUrl({ challenge: pkce().challenge, resource }), { jar: new Jar() });
      const location = res.headers.get('location') ?? '';
      if (res.status === 303 && location.startsWith(`/${main.secret}/oauth/interaction/`)) {
        const jar = new Jar(); // follow to the page: it must refuse to make a pairing
        const r2 = await hit(vendor.authUrl({ challenge: pkce().challenge, resource }), { jar }); const page = await hit(main.pub + r2.headers.get('location'), { jar });
        assert.ok(page.status >= 400, `resource ${resource} got a pairing page (${page.status})`);
      } else assert.ok(res.status >= 400 || new URL(location, main.pub).searchParams.get('error'), `resource ${resource}: ${res.status} ${location}`);
    }
    const two = await hit(`${vendor.authUrl({ challenge: pkce().challenge })}&resource=${encodeURIComponent('https://other.example/mcp')}`, { jar: new Jar() });
    const p = two.headers.get('location') ?? '';
    if (p.startsWith(`/${main.secret}/oauth/interaction/`)) { const jar = new Jar(); const r = await hit(`${vendor.authUrl({ challenge: pkce().challenge })}&resource=${encodeURIComponent('https://other.example/mcp')}`, { jar }); const page = await hit(main.pub + r.headers.get('location'), { jar }); assert.ok(page.status >= 400, 'two resources got a pairing page'); }
  });
  await check('4b', 'a resource other than the configured one at the token endpoint is refused', async () => {
    const c = await vendor.connect('lark');
    const refreshed = await vendor.refresh(c.refresh, { resource: 'https://other.example/mcp' });
    assert.equal(refreshed.status, 400); assert.equal(refreshed.body.error, 'invalid_target');
    main.start_window('duet');
    const flow = await vendor.begin(); assert.equal(main.approve(flow.code, 'duet').code, 0);
    const cb = await vendor.finish(flow);
    const wrong = await vendor.exchange(cb.code, flow.pkce.verifier, { resource: 'https://other.example/mcp' });
    assert.equal(wrong.status, 400); assert.ok(['invalid_target', 'invalid_grant'].includes(wrong.body.error), wrong.body.error);
    assert.equal(wrong.body.access_token, undefined);
  });
  await check('4c', 'a token whose aud is a different resource is rejected by the bridge', async () => {
    const c = await vendor.connect('lark');
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 200);
    main.changeToken(c.access, { aud: 'https://other.example/mcp' });
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401);
  });

  // ---- 5. pairing codes ------------------------------------------------------------------------------------------------------
  await check('5a', 'approval with an unknown, consumed or expired pairing code is refused', async () => {
    main.start_window('lark');
    assert.notEqual(main.approve('ZZZZ-ZZZZ', 'lark').code, 0);
    assert.notEqual(main.approve('nonsense', 'lark').code, 0);
    const used = await vendor.begin(); assert.equal(main.approve(used.code, 'lark').code, 0);
    const second = main.approve(used.code, 'lark'); assert.notEqual(second.code, 0); assert.match(second.stderr + second.stdout, /start the sign-in again in the client, then compare codes with dalan connect pending/i);
    const old = await vendor.begin();
    main.sql('UPDATE pairings SET expires_at=? WHERE code=?', Date.now() - 1000, old.code.replace('-', ''));
    const expired = main.approve(old.code, 'lark'); assert.notEqual(expired.code, 0); assert.match(expired.stderr + expired.stdout, /start the sign-in again in the client, then compare codes with dalan connect pending/i);
    assert.ok(!main.pending().pending.some(p => p.code === old.code), 'an expired code is still listed');
  });
  await check('5b', 'crossed interactions stay isolated and an exact code selects one pending pairing', async () => {
    main.start_window('lark');
    // Only the newest attempt of a worker can be approved, so A is begun last.
    const b = await vendorB.begin(), a = await vendor.begin();
    assert.notEqual(a.code, b.code);
    const wrongPath = await hit(main.pub + b.loc, { jar: a.jar }); // A's browser asks for B's page
    assert.equal(wrongPath.status, 400);
    const wrongPath2 = await hit(main.pub + a.loc, { jar: b.jar }); // B's browser asks for A's page
    assert.equal(wrongPath2.status, 400);
    assert.equal((await hit(main.pub + a.loc, { jar: a.jar })).status, 200);
    const stillWaiting = await hit(main.pub + b.loc, { jar: b.jar }); assert.equal(stillWaiting.status, 200);
    const approved = main.approve(a.code, 'lark'); assert.equal(approved.code, 0, approved.stderr + approved.stdout);
    assert.ok(main.pending().pending.some(p => p.code === b.code), 'approving A by code leaves B pending');
    assert.equal(main.sql('SELECT state FROM pairings WHERE uid=?', a.uid)[0].state, 'approved');
    assert.equal(main.sql('SELECT state FROM pairings WHERE uid=?', b.uid)[0].state, 'pending');
    main.stop_window(); main.start_window('lark');
  });

  await check('5c', 'approval refuses a code that matches multiple pending entries', async () => {
    const pending = ['ABCD-EFGH', 'ABCDEFGH'].map((code, index) => ({
      code, worker: 'lark', client_id: `client-${index}`, client_name: 'test', redirect_uri: 'http://127.0.0.1:1234/callback',
      resource: 'https://bridge.example/mcp', scopes: ['read'], age_seconds: 0, expires_in_seconds: 60, native: true,
    }));
    const request = async route => route === '/connect/pending' ? { window: { worker: 'lark', expires_at: 'later' }, pending } : assert.fail(`unexpected request ${route}`);
    const options = new Map([['--worker', 'lark'], ['--confirm-redirect', pending[0].redirect_uri]]);
    await assert.rejects(connectCommand(['approve', 'ABCD-EFGH', '--worker', 'lark', '--confirm-redirect', pending[0].redirect_uri], {
      request, operator: () => 'key', option: name => options.get(name) ?? null, json: false,
    }), /more than one pending pairing matches this code.*dalan connect pending.*compare codes/i);
  });

  // ---- 6. DCR without approval -----------------------------------------------------------------------------------------------
  await check('6', 'a registered client with no approval gets no token and no access', async () => {
    main.start_window('lark');
    const fresh = new Vendor(main); assert.equal((await fresh.register()).status, 201);
    const flow = await fresh.begin(); // never approved
    assert.ok(flow.code);
    const waiting = await hit(main.pub + flow.loc, { jar: flow.jar }); assert.equal(waiting.status, 200);
    const forged = await fresh.exchange('x'.repeat(43), flow.pkce.verifier); assert.equal(forged.status, 400); assert.equal(forged.body.access_token, undefined);
    const cc = await fresh.token({ grant_type: 'client_credentials', resource: main.resource }); assert.ok(cc.status >= 400 && !cc.body.access_token, 'client_credentials must not work');
    const pw = await fresh.token({ grant_type: 'password', username: 'owner', password: 'x' }); assert.ok(pw.status >= 400 && !pw.body.access_token);
    assert.equal((await main.rpc(null, 'tools/list')).status, 401);
    assert.equal((await main.rpc(fresh.client_id, 'tools/list')).status, 401, 'a client_id is not a bearer token');
    assert.ok(!main.list().connections.some(c => c.client_id === fresh.client_id));
  });

  // ---- 7. refresh rotation and reuse -----------------------------------------------------------------------------------------
  await check('7', 'a duplicate refresh returns the same live successor', async () => {
    const c = await vendor.connect('lark');
    const first = await vendor.refresh(c.refresh); assert.equal(first.status, 200);
    assert.notEqual(first.body.refresh_token, c.refresh);
    const replay = await vendor.refresh(c.refresh); assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    assert.equal((await main.rpc(first.body.access_token, 'tools/list')).status, 200);
  });

  await check('8', 'after connect revoke: a still-valid token is refused and refresh is refused', async () => {
    const c = await vendor.connect('lark');
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 200);
    assert.equal(main.cli(['connect', 'revoke', 'lark', '--json']).code, 0);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401);
    const r = await vendor.refresh(c.refresh); assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_grant');
    assert.notEqual(main.cli(['connect', 'revoke', 'lark', '--json']).code, 0, 'revoking a worker without a connection must fail');
  });

  // ---- 9. restart, keys, files -----------------------------------------------------------------------------------------------
  await check('9a', 'after a restart existing tokens still verify and the keys are unchanged', async () => {
    const c = await vendor.connect('lark');
    const hash = f => createHash('sha256').update(fs.readFileSync(path.join(main.config, f))).digest('hex');
    const before = { jwks: hash('as-jwks.json'), cookies: hash('as-cookie-keys.json') };
    const kid = (await (await fetch(`${main.oauth}/jwks`)).json()).keys[0].kid;
    await main.stop(); assert.equal(await main.start(), true, main.stderr);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 200);
    const again = await vendor.refresh(c.refresh); assert.equal(again.status, 200);
    assert.deepEqual({ jwks: hash('as-jwks.json'), cookies: hash('as-cookie-keys.json') }, before);
    assert.equal((await (await fetch(`${main.oauth}/jwks`)).json()).keys[0].kid, kid);
  });
  await check('9b', 'offline rotation retains real ID tokens and every captured cookie for their full lifetimes; new artifacts use the new keys', async () => {
    const jwksFile = path.join(main.config, 'as-jwks.json'), cookieFile = path.join(main.config, 'as-cookie-keys.json');
    await main.stop();
    main.clockFile = path.join(root, 'clock');
    const issuedAt = Math.floor(Date.now() / 1000) * 1000;
    const clock = ms => fs.writeFileSync(main.clockFile, String(ms));
    clock(issuedAt);
    try {
      assert.equal(await main.start(), true, main.stderr);
      const before = await keysOf(main); assert.equal(before.length, 1);
      const old = await vendor.connect('lark', { scope: 'openid dot-bridge.read dot-bridge.work' });
      const claims = JSON.parse(Buffer.from(old.tokens.id_token.split('.')[1], 'base64url'));
      assert.equal(claims.exp - claims.iat, 600);
      main.start_window('duet');
      const pre = await vendorB.begin({ scope: 'openid dot-bridge.read dot-bridge.work' }); assert.ok(pre.code);
      // Save all signed browser cookies before stop, including interaction and session cookies when present.
      const savedCookies = [old.flow.jar, pre.jar].flatMap(jar => [...jar.map].filter(([name]) => name.endsWith('.sig') && jar.map.has(name.slice(0, -4))).map(([name, signature]) => ({ data: name.slice(0, -4) + '=' + jar.map.get(name.slice(0, -4)), signature })));
      assert.ok(savedCookies.length > 0);
      await main.stop();
      const t0 = Date.now(), rotated = main.cli(['as-rotate-keys', '--json']), t1 = Date.now();
      assert.equal(rotated.code, 0, rotated.stderr);
      const newKid = rotated.json().signing_kid; assert.notEqual(newKid, before[0].kid);
      const stamp = JSON.parse(fs.readFileSync(jwksFile)).retired[before[0].kid];
      assert.ok(stamp >= t0 && stamp <= t1, 'retirement must be the rotation time');
      assert.equal(JSON.parse(fs.readFileSync(cookieFile)).keys[1].retired_at, stamp);
      for (const file of [jwksFile, cookieFile]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      // A real browser finishes its old-cookie interaction in the last second of its full 600s lifetime.
      clock((claims.exp - 1) * 1000);
      assert.equal(await main.start(), true, main.stderr);
      const both = await keysOf(main); assert.deepEqual(new Set(both.map(k => k.kid)), new Set([before[0].kid, newKid]));
      assert.ok(both.every(k => k.d === undefined));
      await jwtVerify(old.tokens.id_token, createLocalJWKSet({ keys: both }), { algorithms: ['ES256'], issuer: main.oauth, audience: vendor.client_id, currentDate: new Date((claims.exp - 1) * 1000) });
      assert.equal((await main.rpc(old.access, 'tools/list')).status, 200);
      assert.equal((await vendor.refresh(old.refresh)).status, 200);
      assert.equal(main.approve(pre.code, 'duet').code, 0);
      const done = await vendorB.finish(pre); assert.equal(done.stage, 'callback', JSON.stringify(done));
      const fresh = await vendorB.exchange(done.code, pre.pkce.verifier); assert.equal(fresh.status, 200);
      assert.equal(verifyJwt(fresh.body.id_token, both).kid, newKid);
      assert.equal(verifyJwt(fresh.body.id_token, both).ok, true);
      const currentKeys = loadKeys(main.config).cookieKeys;
      let newCookies = 0;
      for (const [name, signature] of pre.jar.map) if (name.endsWith('.sig') && pre.jar.map.has(name.slice(0, -4))) {
        newCookies++;
        const data = name.slice(0, -4) + '=' + pre.jar.map.get(name.slice(0, -4));
        assert.equal(Keygrip(currentKeys).index(data, signature), 0, 'new cookie must use the new signing key: ' + name);
      }
      assert.ok(newCookies > 0, 'browser completion must issue a new signed cookie');
      await main.stop();
      // Before session retention ends, every saved signature still verifies with the retained cookie key.
      clock(stamp + COOKIE_RETAIN_MS - 1);
      assert.equal(await main.start(), true, main.stderr);
      assert.deepEqual((await keysOf(main)).map(k => k.kid), [newKid]);
      const retained = Keygrip(loadKeys(main.config).cookieKeys);
      for (const cookie of savedCookies) assert.equal(retained.verify(cookie.data, cookie.signature), true);
      await main.stop(); clock(stamp + COOKIE_RETAIN_MS);
      assert.equal(await main.start(), true, main.stderr);
      assert.equal(loadKeys(main.config).cookieKeys.length, 1);
      for (const cookie of savedCookies) assert.equal(Keygrip(loadKeys(main.config).cookieKeys).verify(cookie.data, cookie.signature), false);
      assert.equal(verifyJwt(old.tokens.id_token, await keysOf(main)).ok, false);
      assert.equal(verifyJwt(fresh.body.id_token, await keysOf(main)).ok, true);
      await main.stop();
      assert.equal(main.cli(['as-rotate-keys', '--cookies-only', '--json']).json().cookie_key_rotated, true);
      assert.equal(JSON.parse(fs.readFileSync(jwksFile)).signing_kid, newKid);
    } finally { await main.stop(); main.clockFile = null; assert.equal(await main.start(), true, main.stderr); }
  });
  await check('9e', 'simultaneous bridge starters have one owner; loser and live rotation touch no files; both termination signals permit restart', async () => {
    const snap = () => Object.fromEntries(fs.readdirSync(main.config).sort().map(name => [name, fs.readFileSync(path.join(main.config, name))]));
    await main.stop();
    const trials = Number(process.env.AS_BRIDGE_TRIALS ?? 4), count = Number(process.env.AS_STARTERS ?? 2);
    const totals = { trials, starters: count, zero: 0, one: 0, multiple: 0 };
    for (let trial = 0; trial < trials; trial++) {
      const contenders = [main];
      for (let i = 1; i < count; i++) {
        const contender = new Bridge('contender-' + i);
        Object.assign(contender, { home: main.home, config: main.config, port: await freePort(), pub: main.pub });
        contenders.push(contender);
      }
      const gate = path.join(root, 'bridge-start-' + trial + '.go');
      try {
        const starts = contenders.map(c => c.start(gate));
        await releaseStartBarrier(contenders.map(c => c.child), gate);
        const started = await Promise.all(starts), owners = started.filter(Boolean).length;
        totals[owners === 0 ? 'zero' : owners === 1 ? 'one' : 'multiple']++;
        if (owners !== 1) continue;
        const winner = contenders[started.indexOf(true)], loser = contenders[started.indexOf(false)];
        assert.match(loser.stderr, /ownership unavailable|already owns/);
        if (trial === trials - 1) {
          const before = snap();
          assert.equal(await loser.start(), false); assert.match(loser.stderr, /ownership unavailable|already owns/);
          assert.deepEqual(snap(), before, 'a refused starter changed files');
          for (const args of [[], ['--jwks-only'], ['--cookies-only']]) {
            const rotated = winner.cli(['as-rotate-keys', ...args, '--json']);
            assert.notEqual(rotated.code, 0); assert.match(rotated.stderr, /stop the bridge, rotate, start/);
            assert.deepEqual(snap(), before, 'live rotation changed files');
          }
          const killed = new Promise(resolve => winner.child.once('exit', resolve)); winner.child.kill('SIGKILL'); await killed;
          assert.equal(await main.start(), true, main.stderr);
          await main.stop(); // SIGTERM
          assert.equal(await main.start(), true, main.stderr);
        }
      } finally { for (const c of contenders) await c.stop(); }
    }
    console.log('BARRIER 9e ' + JSON.stringify(totals));
    assert.equal(await main.start(), true, main.stderr);
    assert.equal(totals.one, trials, JSON.stringify(totals));
    // Binding failure also releases ownership, without a startup-derived retirement write.
    await main.stop();
    const taken = net.createServer(); await new Promise(resolve => taken.listen(main.port, '127.0.0.1', resolve));
    const before = snap();
    try { assert.equal(await main.start(), false); assert.deepEqual(snap()['as-jwks.json'], before['as-jwks.json']); assert.deepEqual(snap()['as-cookie-keys.json'], before['as-cookie-keys.json']); }
    finally { await main.stop(); await new Promise(resolve => taken.close(resolve)); }
    assert.equal(await main.start(), true, main.stderr);
  });
  await check('9f', 'rotation never leaves an unloadable state: the 8-key cap refuses the rotation and the files stay byte-identical', async () => {
    const rot = await new Bridge('rot').init();
    const files = ['as-jwks.json', 'as-cookie-keys.json'].map(f => path.join(rot.config, f));
    const bytes = () => files.map(f => fs.readFileSync(f));
    let ok = 0, refused = 0;
    for (let i = 0; i < 12; i++) {
      const before = bytes(), r = rot.cli(['as-rotate-keys', '--json']);
      if (r.code === 0) ok++;
      else { refused++; assert.match(r.stderr + r.stdout, /too many retained/); assert.deepEqual(bytes(), before, 'a refused rotation changed the files'); }
      assert.doesNotThrow(() => loadKeys(rot.config), `unloadable after rotation ${i + 1}`);
      assert.ok(JSON.parse(fs.readFileSync(files[0])).keys.length <= 8 && JSON.parse(fs.readFileSync(files[1])).keys.length <= 8);
    }
    assert.equal(ok, 7); assert.equal(refused, 5);
    // The cookie keys alone hit the same cap, and expired entries are pruned inside the same validated write.
    for (const [file, edit] of [[files[0], j => { for (const kid of Object.keys(j.retired)) j.retired[kid] = Date.now() - 3600 * 1000; }], [files[1], j => { j.keys.forEach((e, i) => { if (i) e.retired_at = Date.now() - 8 * 3600 * 1000; }); }]]) { const j = JSON.parse(fs.readFileSync(file)); edit(j); fs.writeFileSync(file, JSON.stringify(j)); }
    const again = rot.cli(['as-rotate-keys', '--json']); assert.equal(again.code, 0, again.stderr + again.stdout);
    assert.doesNotThrow(() => loadKeys(rot.config));
    assert.equal(JSON.parse(fs.readFileSync(files[0])).keys.length, 2); assert.equal(JSON.parse(fs.readFileSync(files[1])).keys.length, 2);
  });
  await check('9c', 'files: directory 0700; keys, config and the database with its WAL files are 0600; a missing or damaged key stops the start', async () => {
    const mode = f => fs.statSync(f).mode & 0o777;
    assert.equal(mode(main.config), 0o700);
    for (const f of ['as.json', 'as-jwks.json', 'as-cookie-keys.json', 'as.sqlite', 'as-owner.sqlite']) assert.equal(mode(path.join(main.config, f)), 0o600, f);
    for (const f of ['as.sqlite-wal', 'as.sqlite-shm']) if (fs.existsSync(path.join(main.config, f))) assert.equal(mode(path.join(main.config, f)), 0o600, f);
    assert.equal(main.sql('SELECT journal_mode FROM pragma_journal_mode')[0].journal_mode, 'wal');
    const sock = path.join(main.home, '.local/share/dot-bridge/admin.sock'); assert.equal(mode(sock), 0o600);
    // Damage the second bridge's keys one way at a time; each start must fail and listen on nothing.
    await second.stop();
    const jwks = path.join(second.config, 'as-jwks.json'), cookies = path.join(second.config, 'as-cookie-keys.json');
    const saved = { jwks: fs.readFileSync(jwks), cookies: fs.readFileSync(cookies) };
    const variants = [
      ['missing jwks', () => fs.rmSync(jwks)], ['corrupt jwks', () => fs.writeFileSync(jwks, '{not json', { mode: 0o600 })],
      ['jwks without private part', () => fs.writeFileSync(jwks, JSON.stringify({ keys: [{ ...JSON.parse(saved.jwks).keys[0], d: undefined }] }), { mode: 0o600 })],
      ['swapped private scalar (well formed, wrong key)', () => { const saved0 = JSON.parse(saved.jwks); saved0.keys[0].d = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }).d; fs.writeFileSync(jwks, JSON.stringify(saved0), { mode: 0o600 }); }],
      ['jwks mode 0644', () => { fs.writeFileSync(jwks, saved.jwks, { mode: 0o600 }); fs.chmodSync(jwks, 0o644); }],
      ['missing cookie keys', () => { fs.writeFileSync(jwks, saved.jwks, { mode: 0o600 }); fs.rmSync(cookies); }],
      ['corrupt cookie keys', () => { fs.writeFileSync(cookies, '[1]', { mode: 0o600 }); }],
    ];
    for (const [label, damage] of variants) {
      for (const [f, data] of [[jwks, saved.jwks], [cookies, saved.cookies]]) { fs.writeFileSync(f, data, { mode: 0o600 }); fs.chmodSync(f, 0o600); }
      damage();
      const ok = await second.start(); await second.stop();
      assert.equal(ok, false, `${label}: the bridge started`);
      assert.match(second.stderr, /as: /, `${label}: no clear error: ${second.stderr.slice(0, 200)}`);
    }
    for (const [f, data] of [[jwks, saved.jwks], [cookies, saved.cookies]]) { fs.writeFileSync(f, data, { mode: 0o600 }); fs.chmodSync(f, 0o600); }
    assert.equal(await second.start(), true, second.stderr);
    // init never overwrites keys
    const reinit = second.cli(['as-init', '--public-url', second.pub]); assert.equal(reinit.code, 0, reinit.stderr);
    assert.deepEqual(fs.readFileSync(jwks), saved.jwks);
    assert.notEqual(second.cli(['as-init', '--public-url', 'http://127.0.0.1:1']).code, 0, 'changing the public URL must need a deliberate step');
  });
  await check('9d', 'a builtin workers.json that lists connections is refused; plain http public URL needs the test flag', async () => {
    const bad = await new Bridge('badworkers', { rawWorkers: JSON.stringify({ workers: { lark: { connections: [{ issuer: 'x', subject: 'y', client_id: 'z' }] } } }) }).init();
    assert.equal(await bad.start(), false); await bad.stop();
    assert.match(bad.stderr, /connections must be absent/);
    const noFlag = new Bridge('noflag'); await noFlag.init(); noFlag.noTestFlag = true;
    assert.equal(await noFlag.start(), false); await noFlag.stop();
    assert.match(noFlag.stderr, /explicit test flag|https/);
  });

  // ---- 10. spoofed headers ---------------------------------------------------------------------------------------------------
  await check('10', 'X-Forwarded-Host, X-Forwarded-Proto, Forwarded and a foreign Host do not change the issuer, endpoints or resource', async () => {
    const plain = await main.metadata();
    const spoofHeaders = [{ 'x-forwarded-host': 'evil.test' }, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.test:8443' }, { forwarded: 'host=evil.test;proto=https' }, { 'x-real-ip': '10.1.1.1', 'x-forwarded-for': '10.1.1.1' }];
    for (const headers of spoofHeaders) {
      const r = await raw(main.port, { path: `/.well-known/oauth-authorization-server/${main.secret}/oauth`, headers: { host: `127.0.0.1:${main.port}`, ...headers } });
      assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.text), plain, JSON.stringify(headers));
      const prm = await raw(main.port, { path: `/.well-known/oauth-protected-resource/${main.secret}/mcp`, headers: { host: `127.0.0.1:${main.port}`, ...headers } });
      assert.equal(JSON.parse(prm.text).resource, main.resource);
    }
    for (const host of ['evil.test', `127.0.0.1:${main.port + 1}`, 'localhost', `evil.test:${main.port}`]) {
      for (const p of [`/.well-known/oauth-authorization-server/${main.secret}/oauth`, `/${main.secret}/oauth/auth`, `/${main.secret}/oauth/reg`, `/${main.secret}/mcp`, '/']) {
        const r = await raw(main.port, { path: p, headers: { host } }); assert.equal(r.status, 421, `${host} ${p} -> ${r.status}`);
      }
    }
    const flow = await vendor.begin(); // a Host-spoofed authorization request is refused above; the real one keeps real URLs
    assert.ok(flow.res.headers.get('location').startsWith(`/${main.secret}/oauth/interaction/`));
  });

  await check('10b', 'with an https public URL (no test flag) cookies are Secure and every URL is https; plain http needs the explicit flag', async () => {
    const tls = new Bridge('tls'); tls.port = await freePort(); fs.mkdirSync(tls.config, { recursive: true });
    fs.writeFileSync(path.join(tls.config, 'workers.json'), tls.rawWorkers, { mode: 0o600 });
    tls.pub = `https://127.0.0.1:${tls.port}`; // the listener is plain http on loopback; the tunnel in front would speak https
    tls.noTestFlag = true;
    const init = tls.cli(['as-init', '--public-url', tls.pub]); assert.equal(init.code, 0, init.stderr);
    assert.equal(tls.cli(['as-init', '--public-url', `http://127.0.0.1:${tls.port}`]).code === 0 && fs.readFileSync(path.join(tls.config, 'as.json'), 'utf8').includes('http://'), false, 'an http URL must not be accepted without the test flag');
    assert.equal(await tls.start(), true, tls.stderr);
    try {
      const base = `http://127.0.0.1:${tls.port}`;
      const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server/${tls.secret}/oauth`)).json();
      assert.equal(meta.issuer, `${tls.pub}/${tls.secret}/oauth`); assert.ok(meta.token_endpoint.startsWith('https://'));
      assert.equal(tls.cli(['connect', 'allow-callback', CALLBACK]).code, 0);
      tls.start_window('lark');
      const reg = await (await fetch(`${base}/${tls.secret}/oauth/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) })).json();
      const res = await fetch(`${base}/${tls.secret}/oauth/auth?${form({ client_id: reg.client_id, response_type: 'code', redirect_uri: CALLBACK, scope: 'dot-bridge.read', state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: `${tls.pub}/${tls.secret}/mcp` })}`, { redirect: 'manual' });
      assert.equal(res.status, 303);
      const cookies = res.headers.getSetCookie(); assert.ok(cookies.length >= 2);
      for (const cookie of cookies) assert.match(cookie, /; secure/i, cookie); for (const cookie of cookies) assert.match(cookie, /httponly/i);
      for (const cookie of cookies) assert.match(cookie, /samesite=lax/i);
      { const allow = tls.cli(['connect', 'allow-callback', 'http://127.0.0.1/callback']); assert.equal(allow.code, 0, allow.stderr + allow.stdout); }
      { const allow = tls.cli(['connect', 'allow-callback', 'http://[::1]/callback']); assert.equal(allow.code, 0, allow.stderr + allow.stdout); }
      assert.equal(tls.cli(['connect', 'allow-callback', 'http://localhost/callback']).code, 0);
      const realFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(input);
        if (url.origin === tls.pub) url.protocol = 'http:';
        return realFetch(url, init);
      };
      const native = new Vendor(tls, 'http://127.0.0.1:43210/callback');
      const unregistered = await native.register();
      assert.equal(unregistered.status, 201, JSON.stringify(unregistered));
      const nativeB = new Vendor(tls, 'http://127.0.0.1:43211/callback');
      const registrationB = await nativeB.register();
      assert.equal(registrationB.status, 201);
      assert.notEqual(unregistered.body.client_id, registrationB.body.client_id, 'same client name has distinct client IDs');
      assert.equal((await new Vendor(tls, 'http://localhost:43210/callback').register()).status, 201, 'explicit localhost allowlist');
      const ipv6 = new Vendor(tls, 'http://[::1]:43212/callback');
      assert.equal((await ipv6.register()).status, 201, 'allowlisted IPv6 loopback registration');
      tls.start_window('duet');
      const ipv6Flow = await ipv6.begin();
      assert.ok(ipv6Flow.code, ipv6Flow.page);
      assert.equal(tls.approve(ipv6Flow.code, 'duet').code, 0);
      const ipv6Callback = await ipv6.finish(ipv6Flow);
      assert.equal(ipv6Callback.stage, 'callback');
      assert.equal((await ipv6.exchange(ipv6Callback.code, ipv6Flow.pkce.verifier)).status, 200, 'IPv6 native flow completes through token exchange');
      // Every native PKCE rejection uses a new browser transaction so one failure cannot mask another.
      const nativeRejected = async (label, authOptions) => {
        tls.start_window('duet');
        const proof = pkce();
        const response = await hit(ipv6.authUrl({ challenge: proof.challenge, ...authOptions }), { jar: new Jar() });
        const location = response.headers.get('location') ?? '';
        assert.ok(response.status === 400 || new URL(location || tls.pub, tls.pub).searchParams.get('error'), `${label}: ${response.status} ${location}`);
        assert.ok(!location.includes(`/${tls.secret}/oauth/interaction/`), `${label} created an interaction`);
      };
      await nativeRejected('native authorization without PKCE', { challenge: null });
      await nativeRejected('native plain PKCE', { method: 'plain' });
      const nativeTokenRefusal = async (label, exchange) => {
        tls.start_window('duet');
        const fresh = await ipv6.begin();
        assert.ok(fresh.code, fresh.page);
        assert.equal(tls.approve(fresh.code, 'duet').code, 0);
        const returned = await ipv6.finish(fresh);
        assert.equal(returned.stage, 'callback');
        const rejected = await exchange(returned, fresh);
        assert.equal(rejected.status, 400, label);
        assert.equal(rejected.body.error, 'invalid_grant', label);
      };
      await nativeTokenRefusal('native wrong verifier', (returned, fresh) => ipv6.exchange(returned.code, pkce().verifier));
      await nativeTokenRefusal('native missing verifier', returned => ipv6.token({ grant_type: 'authorization_code', code: returned.code, redirect_uri: ipv6.redirect, resource: tls.resource }));
      tls.start_window('lark');
      // Native attempts are approved by their own code, whatever order they began in.
      const flowB = await nativeB.begin();
      let flow = await native.begin();
      assert.ok(flow.code, flow.page);
      assert.ok(flowB.code, flowB.page);
      assert.notEqual(flow.code, flowB.code, 'same-name clients have distinct pairing codes');
      assert.match(flow.page, /identity not verified/i);
      const pending = tls.pending().pending.find(item => item.code === flow.code);
      assert.equal(pending.redirect_uri, native.redirect);
      assert.equal(pending.native, true);
      assert.ok(!tls.list().connections.some(connection => connection.client_id === unregistered.body.client_id), 'DCR native client has no connection before exact owner confirmation');
      const pendingText = tls.cli(['connect', 'pending']).stdout;
      assert.match(pendingText, /identity not verified/i);
      assert.doesNotMatch(pendingText, /--confirm-redirect/, 'pending output must not present the typo check as proof of identity');
      assert.match(flow.page, /pairing code/i);
      assert.doesNotMatch(flow.page, /--confirm-redirect/, 'the interaction page must not present a copyable confirmation flag');
      const compactCode = flow.code.replace('-', '');
      const unconfirmed = tls.cli(['connect', 'approve', compactCode, '--worker', 'lark']);
      assert.notEqual(unconfirmed.code, 0, 'native approval proceeded without an explicit redirect confirmation');
      assert.match(unconfirmed.stderr + unconfirmed.stdout, /http:\/\/127\.0\.0\.1:43210\/callback/, 'missing-confirmation error must show the full callback');
      for (const detail of [flow.code, pending.client_id, 'lark', ...pending.scopes]) assert.ok((unconfirmed.stderr + unconfirmed.stdout).includes(detail), `approval review must show ${detail}`);
      assert.match(unconfirmed.stderr + unconfirmed.stdout, /identity not verified: host and name prove nothing/i);
      const unknownCode = tls.cli(['connect', 'approve', 'ZZZZ-ZZZZ', '--worker', 'lark', '--confirm-redirect', native.redirect]);
      assert.notEqual(unknownCode.code, 0, 'an unknown code was approved');
      assert.match(unknownCode.stderr + unknownCode.stdout, /start the sign-in again in the client, then compare codes with dalan connect pending/i);
      assert.ok((unknownCode.stderr + unknownCode.stdout).includes(flow.code) && (unknownCode.stderr + unknownCode.stdout).includes(flowB.code));
      const lookalikePort = tls.cli(['connect', 'approve', flow.code, '--worker', 'lark', '--confirm-redirect', 'http://127.0.0.1:43211/callback']);
      assert.notEqual(lookalikePort.code, 0, 'a look-alike callback port was accepted');
      const nativeApproval = tls.cli(['connect', 'approve', flow.code, '--worker', 'lark', '--confirm-redirect', native.redirect, '--replace', '--json']);
      assert.equal(nativeApproval.code, 0, nativeApproval.stderr + nativeApproval.stdout);
      assert.ok(tls.pending().pending.some(item => item.code === flowB.code), 'approving A by its code must leave B pending');
      tls.stop_window(); tls.start_window('lark');
      flow = await native.begin();
      assert.ok(flow.code);
      const secondApproval = tls.cli(['connect', 'approve', flow.code.replace('-', ''), '--worker', 'lark', '--confirm-redirect', native.redirect, '--replace', '--json']);
      assert.equal(secondApproval.code, 0, secondApproval.stderr + secondApproval.stdout);
      assert.ok(!tls.list().connections.some(connection => connection.client_id === registrationB.body.client_id), 'approval of client A creates no connection for client B');
      const callback = await native.finish(flow);
      assert.equal(callback.stage, 'callback');
      const tokens = await native.exchange(callback.code, flow.pkce.verifier);
      assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
      const nativeReplay = await native.exchange(callback.code, flow.pkce.verifier);
      assert.equal(nativeReplay.status, 400);
      assert.equal(nativeReplay.body.error, 'invalid_grant', `native replay with the original verifier must be refused as replay, not verifier mismatch: ${JSON.stringify(nativeReplay.body)}`);
      const replayedConnection = tls.list().connections.find(item => item.connection_id === secondApproval.json().connection_id);
      assert.equal(replayedConnection?.revoked_reason, 'replay', 'native replay must trip the replay guard while its grant is live');
      assert.equal((await tls.rpc(tokens.body.access_token, 'tools/list')).status, 401, 'native code replay must revoke the live grant');
      assert.ok(replayedConnection?.revoked_at, 'native code replay must revoke the approved connection');
      // A late registrant on the same allowlisted path, with its own port, cannot displace the teammate's pending pairing.
      tls.stop_window(); tls.start_window('lark');
      const teammate = new Vendor(tls, 'http://127.0.0.1:43220/callback'), intruder = new Vendor(tls, 'http://127.0.0.1:43221/callback');
      assert.equal((await teammate.register()).status, 201);
      assert.equal((await intruder.register()).status, 201);
      const teammateFlow = await teammate.begin();
      const intruderFlow = await intruder.begin(); // newer than the teammate's attempt
      assert.ok(teammateFlow.code && intruderFlow.code, 'both native attempts reach a pairing page');
      // The server compares the redirect confirmation itself; the CLI check is not the only one. Call the owner socket directly.
      const ownerPost = (route, payload) => new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const request = http.request({ socketPath: path.join(tls.home, '.local/share/dot-bridge/admin.sock'), path: route, method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-operator-key': fs.readFileSync(path.join(tls.config, 'operator.key'), 'utf8').trim() } },
        res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text })); });
        request.on('error', reject); request.end(body);
      });
      for (const confirm of [{}, { confirm_redirect: 'http://127.0.0.1:43221/callback' }, { confirm_redirect: 'http://127.0.0.1:43220/other' }]) {
        const refused = await ownerPost('/connect/approve', { code: teammateFlow.code, worker: 'lark', replace: true, ...confirm });
        assert.notEqual(refused.status, 200, `the server approved a native code with confirmation ${JSON.stringify(confirm)}: ${refused.text}`);
        assert.match(refused.text, /exact redirect confirmation/, 'the refusal names the missing redirect confirmation');
      }
      assert.ok(tls.pending().pending.some(item => item.code === teammateFlow.code), 'the refused direct approvals left the code pending');
      const teammateApproval = tls.cli(['connect', 'approve', teammateFlow.code, '--worker', 'lark', '--confirm-redirect', teammate.redirect, '--replace', '--json']);
      assert.equal(teammateApproval.code, 0, 'the older native code is approvable: ' + teammateApproval.stderr + teammateApproval.stdout);
      const teammateReturn = await teammate.finish(teammateFlow);
      assert.equal(teammateReturn.stage, 'callback');
      assert.equal((await teammate.exchange(teammateReturn.code, teammateFlow.pkce.verifier)).status, 200, 'the teammate gets the token');
      const intruderReturn = await intruder.finish(intruderFlow);
      assert.notEqual(intruderReturn.stage, 'callback', 'the later registrant gets no authorization code');
      assert.ok(!tls.list().connections.some(connection => connection.client_id === intruder.client_id), 'approving the teammate creates no connection for the later registrant');
      assert.ok(tls.pending().pending.some(item => item.code === intruderFlow.code), 'the later registrant stays pending, unapproved');
      // `connect pending` lists every pending native attempt with its own code, redirect and approve command.
      const retry = await teammate.begin();
      assert.ok(retry.code, retry.page);
      assert.ok(tls.pending().pending.every(item => !item.superseded), 'a newer native attempt supersedes no other attempt');
      const shownText = tls.cli(['connect', 'pending']).stdout;
      assert.doesNotMatch(shownText, /SUPERSEDED|approve the newest/i, 'native entries are never superseded');
      for (const [flowShown, vendorShown] of [[intruderFlow, intruder], [retry, teammate]]) {
        assert.ok(shownText.includes(`approve ${flowShown.code} --worker lark`), `pending shows the approve command for ${flowShown.code}`);
        assert.ok(shownText.includes(vendorShown.redirect), `pending shows the full redirect ${vendorShown.redirect}`);
        assert.doesNotMatch(shownText, /--confirm-redirect/, 'the typo check is never offered as a copyable flag');
      }
      // Approving one native code approves no other.
      const retryApproval = tls.cli(['connect', 'approve', retry.code, '--worker', 'lark', '--confirm-redirect', teammate.redirect, '--replace']); assert.equal(retryApproval.code, 0); assert.match(retryApproval.stdout, /Replaced connection .*every queued and future job for worker "lark"/s, 'replacement output names the worker and the hand-over');
      assert.ok(tls.pending().pending.some(item => item.code === intruderFlow.code), 'approving another native code leaves the later registrant pending');
      assert.ok(!tls.list().connections.some(connection => connection.client_id === intruder.client_id), 'no connection for the later registrant');
      for (const changedRedirect of ['http://127.0.0.1:43211/callback', 'http://127.0.0.1:43210/other']) {
        const changedFlow = await native.begin();
        assert.ok(changedFlow.code, changedFlow.page);
        assert.equal(tls.approve(changedFlow.code, 'lark').code, 0);
        const changedCallback = await native.finish(changedFlow);
        assert.equal(changedCallback.stage, 'callback');
        const rejectedExchange = await native.exchange(changedCallback.code, changedFlow.pkce.verifier, { redirect_uri: changedRedirect });
        assert.equal(rejectedExchange.status, 400, `changed approved redirect ${changedRedirect}`);
      }
      for (const redirect of ['http://127.0.0.2:43210/callback', 'http://127.0.0.1:43210/other', 'http://[::1]:43210/other']) {
        const invalid = new Vendor(tls, redirect);
        assert.equal((await invalid.register()).status, 400, redirect);
      }
      globalThis.fetch = realFetch;
    } finally { await tls.stop(); }
  });

  // ---- 11. two connections, two workers, one subject --------------------------------------------------------------------------
  await check('11', 'two connections for two workers, one subject and two clients: each resolves only to its own worker', async () => {
    const a = await vendor.connect('lark'), b = await vendorB.connect('duet');
    assert.notEqual(a.approval.connection_id, b.approval.connection_id);
    const ia = `req_a_${randomUUID().slice(0, 8)}`, ib = `req_b_${randomUUID().slice(0, 8)}`;
    assert.equal(main.submit(ia, 'lark').code, 0); assert.equal(main.submit(ib, 'duet').code, 0);
    const la = JSON.stringify((await main.tool(a.access, 'list_pending')).value), lb = JSON.stringify((await main.tool(b.access, 'list_pending')).value);
    assert.ok(la.includes(ia) && !la.includes(ib)); assert.ok(lb.includes(ib) && !lb.includes(ia));
    assert.equal((await main.tool(a.access, 'get', { request_id: ib })).ok, false);
    assert.equal((await main.tool(b.access, 'claim', { request_id: ia, claimant: 'duet' })).ok, false);
    const rows = main.sql('SELECT worker,client_id FROM connections WHERE revoked_at IS NULL ORDER BY worker');
    assert.deepEqual(rows.map(r => r.worker), ['duet', 'lark']);
    // One active connection per worker is enforced by the database itself.
    assert.throws(() => main.sql("INSERT INTO connections VALUES('dup','lark','grant-dup','c','https://x','r','dot-bridge.read',1,NULL,NULL)"), /UNIQUE/);
    // A second approval for a worker that has a connection needs --replace.
    main.start_window('lark');
    const flow = await vendor.begin(); const refused = main.approve(flow.code, 'lark', false); assert.notEqual(refused.code, 0); assert.match(refused.stderr + refused.stdout, /--replace/); assert.match(refused.stderr + refused.stdout, /every queued and future job for worker lark, including briefs approved before the switch/);
    const replaced = main.approve(flow.code, 'lark', true); assert.equal(replaced.code, 0); assert.equal(replaced.json().replaced, a.approval.connection_id);
    assert.equal((await main.rpc(a.access, 'tools/list')).status, 401, 'the replaced connection must end');
  });

  // ---- 12. approval attacks --------------------------------------------------------------------------------------------------
  await check('12a', 'a lookalike or wrong worker name is refused', async () => {
    main.start_window('lark');
    const flow = await vendor.begin();
    for (const name of ['duet', 'Lark', 'lark ', 'l4rk', 'lark​', 'muѕe']) {
      const r = main.approve(flow.code, name); assert.notEqual(r.code, 0, `worker ${JSON.stringify(name)} was accepted`);
    }
    assert.equal(main.sql('SELECT state FROM pairings WHERE uid=?', flow.uid)[0].state, 'pending');
  });
  await check('12b', 'a foreign callback is refused at registration, at the page, and at approval', async () => {
    main.start_window('lark');
    assert.equal((await new Vendor(main, 'https://evil.example/cb').register()).status, 400);
    // A client that was registered earlier (before the allowlist changed, or planted in storage) still cannot get a pairing page.
    const planted = new Vendor(main); assert.equal((await planted.register()).status, 201);
    const row = main.sql("SELECT payload FROM oidc WHERE model='Client' AND id=?", planted.client_id)[0];
    const payload = JSON.parse(main.decrypt(row.payload, `oidc:Client:${planted.client_id}`)); payload.redirect_uris = ['https://evil.example/cb'];
    main.sql("UPDATE oidc SET payload=? WHERE model='Client' AND id=?", main.encrypt(JSON.stringify(payload), `oidc:Client:${planted.client_id}`), planted.client_id);
    const res = await hit(planted.authUrl({ challenge: pkce().challenge, redirect: 'https://evil.example/cb' }), { jar: new Jar() });
    const jar = new Jar();
    const r2 = await hit(planted.authUrl({ challenge: pkce().challenge, redirect: 'https://evil.example/cb' }), { jar });
    if (r2.status === 303) { const page = await hit(main.pub + r2.headers.get('location'), { jar }); assert.equal(page.status, 400); assert.ok(!/class="code"/.test(await page.text())); }
    assert.ok(res.status === 303 || res.status === 400);
    assert.ok(!main.pending().pending.some(p => p.redirect_uri === 'https://evil.example/cb'));
  });
  await check('12c', 'a closed window: authorization, the page and approval all refuse', async () => {
    main.start_window('lark');
    const flow = await vendor.begin(); assert.ok(flow.code);
    assert.equal(main.stop_window().code, 0);
    const auth = await hit(vendor.authUrl({ challenge: pkce().challenge }), { jar: new Jar() }); assert.equal(auth.status, 403); assert.match(await auth.text(), /Not accepting connections/); assert.equal(auth.headers.get('location'), null);
    const page = await hit(main.pub + flow.loc, { jar: flow.jar }); assert.equal(page.status, 403); assert.match(await page.text(), /Not accepting connections/);
    const approve = main.approve(flow.code, 'lark'); assert.notEqual(approve.code, 0); assert.match(approve.stderr + approve.stdout, /start the sign-in again in the client, then compare codes with dalan connect pending/i);
    assert.equal(main.pending().pending.length, 0, 'pending must be empty outside a window');
    // an expired window behaves like a closed one
    main.start_window('lark'); main.sql('UPDATE windows SET expires_at=?', Date.now() - 1000);
    assert.equal((await hit(vendor.authUrl({ challenge: pkce().challenge }), { jar: new Jar() })).status, 403);
    assert.notEqual(main.cli(['connect', 'start', '--worker', 'nobody', '--json']).code, 0);
    main.start_window('duet'); assert.notEqual(main.cli(['connect', 'start', '--worker', 'lark', '--json']).code, 0, 'a second window for another worker needs the first one stopped');
    main.stop_window();
  });
  await check('12c2', 'an attempt that expired says so, with the limit and the recovery; a closed window keeps the old wording', async () => {
    main.start_window('lark');
    const flow = await vendor.begin(); assert.ok(flow.code);
    // The window ran out while the attempt waited.
    main.sql('UPDATE windows SET expires_at=?', Date.now() - 1000);
    const expiredWindow = await hit(main.pub + flow.loc, { jar: flow.jar }); const windowText = await expiredWindow.text();
    assert.equal(expiredWindow.status, 403);
    assert.match(windowText, /This connection attempt expired\. Attempts last 10 minutes\. Ask the bridge owner to start a new one\./);
    assert.doesNotMatch(windowText, /not accepting new connections/i);
    // The attempt itself ran out while the window stayed open.
    main.start_window('lark');
    const second = await vendor.begin(); assert.ok(second.code);
    main.sql('UPDATE pairings SET expires_at=? WHERE code=?', Date.now() - 1000, second.code.replace('-', ''));
    const expiredPairing = await hit(main.pub + second.loc, { jar: second.jar }); const pairingText = await expiredPairing.text();
    assert.equal(expiredPairing.status, 403);
    assert.match(pairingText, /This connection attempt expired\. Attempts last 10 minutes/);
    main.stop_window();
  });
  await check('12d', 'a pairing code selects one of several pending attempts', async () => {
    main.start_window('lark');
    const one = await vendor.begin(), two = await vendorB.begin();
    const listed = main.pending().pending; assert.ok(listed.some(p => p.code === one.code) && listed.some(p => p.code === two.code));
    const approved = main.approve(two.code, 'lark'); assert.equal(approved.code, 0, approved.stderr + approved.stdout);
    assert.ok(main.pending().pending.some(p => p.code === one.code) && !main.pending().pending.some(p => p.code === two.code));
    main.stop_window(); main.start_window('lark');
    const only = await vendor.begin(); assert.ok(only.code);
    assert.equal(main.approve(only.code, 'lark').code, 0);
    assert.equal((await vendor.finish(only)).stage, 'callback');
  });
  await check('12e', 'concurrent approvals create one connection (same code twice; by code for one worker)', async () => {
    main.start_window('lark');
    const flow = await vendor.begin();
    const both = await Promise.all([main.cliAsync(['connect', 'approve', flow.code, '--worker', 'lark', '--replace', '--json']), main.cliAsync(['connect', 'approve', flow.code, '--worker', 'lark', '--replace', '--json'])]);
    assert.equal(both.filter(r => r.code === 0).length, 1, JSON.stringify(both.map(r => r.stderr + r.stdout)));
    assert.equal(main.sql("SELECT count(*) n FROM connections WHERE worker='lark' AND grant_id IN (SELECT grant_id FROM pairings WHERE uid=?)", flow.uid)[0].n, 1);
    main.cli(['connect', 'revoke', 'lark', '--json']);
    const f1 = await vendor.begin(), f2 = await vendorB.begin();
    const race = await Promise.all([main.cliAsync(['connect', 'approve', f1.code, '--worker', 'lark', '--json']), main.cliAsync(['connect', 'approve', f2.code, '--worker', 'lark', '--json'])]);
    assert.equal(race.filter(r => r.code === 0).length, 1, JSON.stringify(race.map(r => r.stderr + r.stdout)));
    assert.equal(main.sql("SELECT count(*) n FROM connections WHERE worker='lark' AND revoked_at IS NULL")[0].n, 1);
    main.stop_window(); main.start_window('lark');
    const only = await vendor.begin(); assert.ok(only.code);
    assert.equal(main.approve(only.code, 'lark').code, 0);
    assert.equal(main.sql("SELECT count(*) n FROM connections WHERE worker='lark' AND revoked_at IS NULL")[0].n, 1);
    const failed = main.sql("SELECT count(*) n FROM pairings WHERE state='approving'")[0].n; assert.equal(failed, 0, 'no pairing may stay half approved');
  });
  await check('12f', 'a change of client metadata after the code was shown stops the approval', async () => {
    main.start_window('lark');
    const v = new Vendor(main); assert.equal((await v.register({ redirect_uris: [CALLBACK, 'https://vendor.example/other/z'] })).status, 201);
    const flow = await v.begin(); assert.ok(flow.code);
    const row = main.sql("SELECT payload FROM oidc WHERE model='Client' AND id=?", v.client_id)[0];
    const payload = JSON.parse(main.decrypt(row.payload, `oidc:Client:${v.client_id}`)); payload.redirect_uris = ['https://vendor.example/other/z'];
    main.sql("UPDATE oidc SET payload=? WHERE model='Client' AND id=?", main.encrypt(JSON.stringify(payload), `oidc:Client:${v.client_id}`), v.client_id);
    const refused = main.approve(flow.code, 'lark'); assert.notEqual(refused.code, 0); assert.match(refused.stderr + refused.stdout, /changed/);
    // and a change between approval and browser completion
    main.stop_window(); main.start_window('lark');
    const f2 = await vendor.begin(); assert.equal(main.approve(f2.code, 'lark').code, 0);
    main.sql("UPDATE pairings SET redirect_uri='https://vendor.example/other/tampered' WHERE uid=?", f2.uid);
    const done = await vendor.finish(f2); assert.notEqual(done.stage, 'callback'); assert.equal(done.status, 409);
  });
  await check('12g', 'browser completion needs the interaction cookie as well as the recorded approval', async () => {
    main.start_window('lark');
    const flow = await vendor.begin();
    assert.equal(main.approve(flow.code, 'lark').code, 0);
    const missing = await hit(main.pub + flow.loc, { jar: new Jar() }); assert.equal(missing.status, 400); assert.equal(missing.headers.get('location'), null);
    const tampered = new Jar(); tampered.map.set('_interaction', flow.uid); const t = await hit(main.pub + flow.loc, { jar: tampered }); assert.equal(t.status, 400, 'an unsigned cookie must not count');
    assert.equal(main.sql('SELECT state FROM pairings WHERE uid=?', flow.uid)[0].state, 'approved');
    assert.equal((await vendor.finish(flow)).stage, 'callback');
  });
  await check('12h', 'hostile text: terminal escapes, bidi and HTML in a client name never reach the terminal or the page raw', async () => {
    main.start_window('lark');
    const evil = '\u001b[31mRED\u001b[0m‮evil\n<script>alert(1)</script>\u0007';
    const v = new Vendor(main); const reg = await v.register({ client_name: evil }); assert.equal(reg.status, 201);
    const flow = await v.begin(); assert.ok(flow.code);
    assert.ok(!flow.page.includes('<script>') && !flow.page.includes('RED'), 'the page must not show the vendor name');
    const text = main.cli(['connect', 'pending']).stdout;
    assert.ok(text.includes(flow.code) && text.includes('untrusted'));
    assert.ok(!/[\u001b\u0007‮]/.test(text), 'control or bidi characters reached the terminal output');
    const json = JSON.stringify(main.pending());
    assert.ok(!/\\u001b|\\u0007|\\u202e/i.test(json) && !json.includes('\n<script'));
    main.stop_window();
  });

  await check('12h2', 'pending shows the pairing resource with the path secret redacted', async () => {
    main.start_window('lark');
    const flow = await vendor.begin(); assert.ok(flow.code);
    const shown = `${main.pub}/<secret>/mcp`;
    assert.equal(main.pending().pending.find(p => p.code === flow.code)?.resource, shown);
    const text = main.cli(['connect', 'pending']).stdout;
    assert.ok(text.includes(`resource    ${JSON.stringify(shown)}`), 'the text form names the resource');
    assert.ok(!text.includes(main.secret) && !JSON.stringify(main.pending()).includes(main.secret), 'pending must not disclose the path secret');
    main.stop_window();
  });

  await check('12i', 'a code pending for lark cannot be approved as duet after the window moved to duet', async () => {
    main.start_window('lark');
    const flow = await vendor.begin(); assert.ok(flow.code);
    main.sql("UPDATE windows SET worker='duet'"); // the window moves without `connect start` (which would purge the attempt): the worker check must hold alone
    const refused = main.approve(flow.code, 'duet'); assert.notEqual(refused.code, 0); assert.match(refused.stderr + refused.stdout, /start the sign-in again in the client, then compare codes with dalan connect pending/i);
    assert.equal(main.sql('SELECT state FROM pairings WHERE uid=?', flow.uid)[0].state, 'pending');
  });
  await check('12j', 'with the window closed no route spelling persists anything', async () => {
    main.stop_window();
    const count = () => main.sql('SELECT (SELECT count(*) FROM oidc) a, (SELECT count(*) FROM pairings) b, (SELECT count(*) FROM connections) c')[0];
    const before = count();
    const q = new URLSearchParams({ client_id: vendor.client_id, response_type: 'code', redirect_uri: CALLBACK, scope: 'dot-bridge.read', state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: main.resource }).toString();
    for (const p of [`/${main.secret}/oauth/auth`, `/${main.secret}/oauth/auth/`, `/${main.secret}/oauth/AUTH`, `/${main.secret}/oauth/Auth/`, `/${main.secret}/oauth/aUtH//`, `/${main.secret}/oauth//auth`, `/${main.secret}/oauth/auth/.`, `/${main.secret}/oauth/%61uth`, `/${main.secret}/oauth/auth%2F`]) {
      for (const method of ['GET', 'POST']) {
        const res = await hit(`${main.pub}${p}?${q}`, { jar: new Jar(), method, ...(method === 'POST' ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q } : {}) });
        const loc = res.headers.get('location') ?? '';
        assert.ok(!loc.includes('/interaction/') && !loc.includes('code='), `${method} ${p} -> ${res.status} ${loc}`);
        assert.deepEqual(count(), before, `${method} ${p} persisted rows`);
      }
    }
  });
  await check('12k', 'only response_mode=query is supported: form_post, fragment, jwt and repeats are refused', async () => {
    main.start_window('lark');
    for (const mode of ['form_post', 'fragment', 'jwt', 'query.jwt', 'web_message', '']) {
      const res = await hit(vendor.authUrl({ challenge: pkce().challenge, extra: { response_mode: mode } }), { jar: new Jar() });
      assert.equal(res.status, 400, `${mode} -> ${res.status} ${res.headers.get('location')}`); assert.equal(res.headers.get('location'), null);
    }
    const repeated = await hit(`${vendor.authUrl({ challenge: pkce().challenge, extra: { response_mode: 'query' } })}&response_mode=form_post`, { jar: new Jar() }); assert.equal(repeated.status, 400);
    const spelled = await hit(vendor.authUrl({ challenge: pkce().challenge, extra: { response_mode: 'form_post' } }).replace('/' + main.secret + '/oauth/auth?', '/' + main.secret + '/oauth/AUTH/?'), { jar: new Jar() }); assert.equal(spelled.status, 400);
    const ok = await vendor.begin({ extra: { response_mode: 'query' } }); assert.ok(ok.code, 'response_mode=query must still work');
  });

  await check('12l', 'every response_type other than code is refused with the 400 page, and discovery says so', async () => {
    main.start_window('lark');
    for (const response_type of ['token', 'id_token', 'code id_token', 'code token', 'id_token token', 'code id_token token', 'none', 'CODE', 'code code', '']) {
      for (const spelling of ['/' + main.secret + '/oauth/auth', '/' + main.secret + '/oauth/AUTH/']) {
        const res = await hit(vendor.authUrl({ challenge: pkce().challenge, extra: { response_type } }).replace('/' + main.secret + '/oauth/auth?', spelling + '?'), { jar: new Jar() });
        assert.equal(res.status, 400, 'response type rejected'); assert.equal(res.headers.get('location'), null);
      }
    }
    const none = await hit(vendor.authUrl({ challenge: pkce().challenge, omit: ['response_type'] }), { jar: new Jar() }); assert.equal(none.status, 400);
    for (const url of ['/.well-known/oauth-authorization-server/' + main.secret + '/oauth', '/.well-known/openid-configuration/' + main.secret + '/oauth', '/' + main.secret + '/oauth/.well-known/openid-configuration']) {
      const d = await (await fetch(main.pub + url)).json();
      assert.deepEqual(d.response_modes_supported, ['query'], url); assert.deepEqual(d.response_types_supported, ['code'], url); assert.equal(d.issuer, main.oauth);
    }
    assert.ok((await vendor.begin()).code, 'response_type=code must still work');
  });

  // ---- 13. authorization bypass ----------------------------------------------------------------------------------------------
  await check('13a', 'an existing browser session does not authorize a new request', async () => {
    const c = await vendor.connect('lark');
    const jar = c.flow.jar; // same browser, session cookie present
    main.start_window('lark');
    const again = await vendor.begin({ jar });
    assert.equal(again.res.status, 303); assert.ok(again.loc.startsWith(`/${main.secret}/oauth/interaction/`), 'a second request skipped the interaction');
    assert.ok(again.code, 'a second request needs its own pairing code');
    assert.ok(!again.res.headers.get('location').includes('code='));
  });
  await check('13b', 'prompt=none never issues a code', async () => {
    const c = await vendor.connect('lark');
    const res = await hit(vendor.authUrl({ challenge: pkce().challenge, extra: { prompt: 'none' } }), { jar: c.flow.jar });
    const location = new URL(res.headers.get('location'), main.pub);
    assert.equal(location.searchParams.get('code'), null); assert.ok(location.searchParams.get('error'), `no error: ${res.status} ${location}`);
    const fresh = await hit(vendor.authUrl({ challenge: pkce().challenge, extra: { prompt: 'none' } }), { jar: new Jar() });
    assert.equal(new URL(fresh.headers.get('location'), main.pub).searchParams.get('code'), null);
  });
  await check('13c', 'a repeated authorization with an old interaction state or a reused resume URL gives no code', async () => {
    const c = await vendor.connect('lark');
    const resume = c.flow.loc; // the interaction page was consumed; the browser asks again
    const r = await hit(main.pub + resume, { jar: c.flow.jar }); assert.ok(r.status >= 400 || !(r.headers.get('location') ?? '').includes('code='), 'the finished interaction can be replayed');
    assert.equal(main.sql('SELECT state FROM pairings WHERE uid=?', c.flow.uid)[0].state, 'done');
  });
  await check('13d', 'reconnect after revocation needs a new approval; the old grant is not reused', async () => {
    const c = await vendor.connect('lark');
    assert.equal(main.cli(['connect', 'revoke', 'lark', '--json']).code, 0);
    main.start_window('lark');
    const again = await vendor.begin({ jar: c.flow.jar });
    assert.ok(again.code, 'a revoked connection must start over with a new pairing code');
    const resumeOld = await hit(main.pub + `/${main.secret}/oauth/auth/${c.flow.uid}`, { jar: c.flow.jar }); assert.ok(resumeOld.status >= 400 || !(resumeOld.headers.get('location') ?? '').includes('code='));
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401);
    assert.equal(main.sql("SELECT count(*) n FROM connections WHERE worker='lark' AND revoked_at IS NULL")[0].n, 0);
  });

  // ---- 14. token boundaries --------------------------------------------------------------------------------------------------
  await check('14a', 'forged, unknown, alg=none and JWT-shaped bearers are refused', async () => {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const bearers = ['x', 'a'.repeat(43), `${b64({ alg: 'none' })}.${b64({ iss: main.oauth, aud: main.resource, sub: 'owner', exp: 9999999999, scope: 'dot-bridge.read' })}.`, `${b64({ alg: 'HS256', kid: 'k' })}.${b64({ iss: 'x' })}.${randomBytes(32).toString('base64url')}`, '', 'Bearer', randomBytes(300).toString('base64url')];
    for (const bearer of bearers) assert.equal((await main.rpc(bearer || null, 'tools/list')).status, 401, bearer.slice(0, 30));
  });
  await check('14b', 'an expired access token is refused', async () => {
    const c = await vendor.connect('lark');
    main.changeToken(c.access, { exp: Math.floor(Date.now() / 1000) - 60 });
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401);
    main.sql("UPDATE oidc SET expires_at=? WHERE model='AccessToken' AND id=?", Date.now() - 1000, main.tokenId('AccessToken', c.access));
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401);
  });
  await check('14c', 'an ID token, a refresh token or an authorization code used as a bearer is refused', async () => {
    const c = await vendor.connect('lark', { scope: 'openid dot-bridge.read dot-bridge.work' });
    assert.ok(c.tokens.id_token, 'openid scope should yield an id_token'); assert.ok(c.tokens.scope.includes('dot-bridge.work'));
    for (const bearer of [c.tokens.id_token, c.refresh, c.callback.code]) assert.equal((await main.rpc(bearer, 'tools/list')).status, 401);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 200);
  });
  await check('14d', 'unknown, conflicting or mismatched connection records fail closed', async () => {
    let c = await vendor.connect('lark');
    main.sql('UPDATE connections SET client_id=? WHERE grant_id=?', 'other-client', c.approval.grant_id);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401, 'client mismatch');
    c = await vendor.connect('lark');
    main.sql('UPDATE connections SET revoked_at=? WHERE grant_id=?', Date.now(), c.approval.grant_id);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401, 'connection marked revoked while the grant is still alive');
    c = await vendor.connect('lark');
    main.sql('DELETE FROM connections WHERE grant_id=?', c.approval.grant_id);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401, 'unknown connection');
    c = await vendor.connect('lark');
    main.sql("UPDATE connections SET worker='nobody' WHERE grant_id=?", c.approval.grant_id);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 403, 'a connection naming a worker that does not exist gets no worker');
    c = await vendor.connect('lark');
    main.sql("UPDATE connections SET resource=? WHERE grant_id=?", main.encrypt('https://other.example/mcp', `connections:${c.approval.connection_id}`), c.approval.grant_id);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401, 'resource mismatch');
    c = await vendor.connect('lark');
    main.sql("UPDATE connections SET scopes='dot-bridge.read' WHERE grant_id=?", c.approval.grant_id);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401, 'token scope wider than the connection');
    c = await vendor.connect('lark');
    main.sql("DELETE FROM oidc WHERE model='Grant' AND id=?", c.approval.grant_id);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401, 'grant gone');
  });
  await check('14e', 'refresh with another client, wider scope or another resource is refused', async () => {
    const c = await vendor.connect('lark');
    const other = await vendorB.refresh(c.refresh); assert.equal(other.status, 400); assert.equal(other.body.error, 'invalid_grant');
    const wider = await vendor.refresh(c.refresh, { scope: 'dalan.read dalan.work t3.write' }); assert.equal(wider.status, 400); assert.ok(['invalid_scope', 'invalid_grant'].includes(wider.body.error), wider.body.error);
    const narrower = await vendor.refresh(c.refresh, { scope: 'dalan.read' }); assert.equal(narrower.status, 200);
    assert.equal(narrower.body.scope, 'dalan.read');
    const claim = await main.tool(narrower.body.access_token, 'claim', { request_id: 'req_none_0000', claimant: 'x' });
    assert.equal(claim.ok, false); assert.match(claim.error, /insufficient_scope/);
    // A wrong resource is refused, but the library has already rotated the token by then, so the presented token is spent.
    const elsewhere = await vendor.refresh(narrower.body.refresh_token, { resource: 'https://other.example/mcp' }); assert.equal(elsewhere.body.error, 'invalid_target');
    const spent = await vendor.refresh(narrower.body.refresh_token);
    assert.equal(spent.status, 400); assert.equal(spent.body.error, 'invalid_grant');
    assert.equal((await main.rpc(narrower.body.access_token, 'tools/list')).status, 401);
  });

  await check('14f', 'neutral scopes are issued to new grants, legacy names keep the same permissions, unknown scopes are dropped', async () => {
    const neutral = await vendor.connect('lark', { scope: 'dalan.read dalan.work' });
    assert.deepEqual(neutral.tokens.scope.split(' ').sort(), ['dalan.read', 'dalan.work']);
    assert.deepEqual(neutral.approval.scopes.sort(), ['dalan.read', 'dalan.work']);
    assert.equal((await main.rpc(neutral.access, 'tools/list')).status, 200);
    const readOnly = await vendor.connect('lark', { scope: 'dalan.read' });
    const denied = await main.tool(readOnly.access, 'claim', { request_id: 'req_none_0000', claimant: 'x' });
    assert.equal(denied.ok, false); assert.match(denied.error, /insufficient_scope/);
    const legacy = await vendor.connect('lark', { scope: 'dot-bridge.read dot-bridge.work' });
    assert.deepEqual(legacy.tokens.scope.split(' ').sort(), ['dot-bridge.read', 'dot-bridge.work']);
    assert.equal((await main.rpc(legacy.access, 'tools/list')).status, 200);
    const legacyNarrow = await vendor.refresh(legacy.refresh, { scope: 'dot-bridge.read' });
    assert.equal(legacyNarrow.status, 200); assert.equal(legacyNarrow.body.scope, 'dot-bridge.read');
    const legacyNarrowDenied = await main.tool(legacyNarrow.body.access_token, 'claim', { request_id: 'req_none_0000', claimant: 'x' });
    assert.match(legacyNarrowDenied.error, /insufficient_scope/);
    const legacyRead = await vendor.connect('lark', { scope: 'dot-bridge.read' });
    const legacyDenied = await main.tool(legacyRead.access, 'claim', { request_id: 'req_none_0000', claimant: 'x' });
    assert.equal(legacyDenied.ok, false); assert.match(legacyDenied.error, /insufficient_scope/);
    const mixed = await vendor.connect('lark', { scope: 'dalan.read bogus.admin' });
    assert.equal(mixed.tokens.scope, 'dalan.read');
  });

  // ---- 15. revocation and concurrency ----------------------------------------------------------------------------------------
  await check('15a', 'simultaneous redemption of one code never yields two sessions', async () => {
    main.start_window('lark');
    const flow = await vendor.begin(); assert.equal(main.approve(flow.code, 'lark').code, 0);
    const cb = await vendor.finish(flow);
    const results = await Promise.all([vendor.exchange(cb.code, flow.pkce.verifier), vendor.exchange(cb.code, flow.pkce.verifier), vendor.exchange(cb.code, flow.pkce.verifier)]);
    const wins = results.filter(r => r.status === 200);
    note(`15a ${wins.length} of 3 simultaneous redemptions succeeded; statuses ${results.map(r => r.status).join(',')}`);
    assert.ok(wins.length <= 1, `${wins.length} redemptions succeeded`);
    for (const w of wins) assert.equal((await main.rpc(w.body.access_token, 'tools/list')).status, 401, 'a replayed code must end the connection');
    assert.equal(main.sql("SELECT count(*) n FROM connections WHERE worker='lark' AND revoked_at IS NULL")[0].n, 0);
  });
  await check('15b', 'simultaneous use of one refresh token never yields two live sessions', async () => {
    const c = await vendor.connect('lark');
    const results = await Promise.all([vendor.refresh(c.refresh), vendor.refresh(c.refresh), vendor.refresh(c.refresh)]);
    const wins = results.filter(r => r.status === 200);
    note(`15b ${wins.length} of 3 simultaneous refreshes succeeded; statuses ${results.map(r => r.status).join(',')}`);
    assert.equal(wins.length, 3);
    for (const w of wins) {
      assert.deepEqual(w.body, wins[0].body);
      assert.equal((await main.rpc(w.body.access_token, 'tools/list')).status, 200);
    }
  });
  await check('15c', 'a restart cannot resurrect a revoked connection, a used code, or a consumed approval', async () => {
    const c = await vendor.connect('lark');
    const used = c.flow.code;
    assert.equal(main.cli(['connect', 'revoke', 'lark', '--json']).code, 0);
    await main.stop(); assert.equal(await main.start(), true, main.stderr);
    assert.equal((await main.rpc(c.access, 'tools/list')).status, 401);
    assert.equal((await vendor.refresh(c.refresh)).status, 400);
    main.start_window('lark');
    const again = main.approve(used, 'lark'); assert.notEqual(again.code, 0); assert.match(again.stderr + again.stdout, /start the sign-in again in the client, then compare codes with dalan connect pending/i);
    const replay = await hit(main.pub + c.flow.loc, { jar: c.flow.jar }); assert.ok(replay.status >= 400, 'a finished interaction came back to life');
  });

  // ---- 16. public-surface abuse ----------------------------------------------------------------------------------------------
  await check('16a', 'bounded storage: anonymous registrations and pending pairings stop at their limits', async () => {
    const v = new Vendor(second); const registered = [];
    second.start_window('lark');
    for (let i = 0; i < 104; i++) { const r = await v.register({ client_name: `c${i}` }); if (r.status === 201) registered.push(r.body.client_id); else { assert.equal(r.status, 429); assert.match(r.body.error_description, /limit|Busy/i); break; } }
    assert.ok(registered.length <= 100 && registered.length >= 90, `registered ${registered.length}`);
    assert.ok(second.sql("SELECT count(*) n FROM oidc WHERE model='Client'")[0].n <= 100);
    second.start_window('lark');
    v.client_id = registered[0];
    const flows = [];
    for (let i = 0; i < 40; i++) flows.push(await v.begin());
    const pairs = second.sql('SELECT count(*) n FROM pairings')[0].n, inter = second.sql("SELECT count(*) n FROM oidc WHERE model='Interaction'")[0].n;
    note(`16a registrations stopped at ${registered.length}; ${pairs} pairings and ${inter} interactions stored for 40 attempts`);
    assert.ok(pairs <= 25 && inter <= 25, `pairings ${pairs} interactions ${inter}`);
    assert.ok(flows.some(f => f.res.status >= 400 || f.pageStatus >= 400 || !f.code), 'the 26th attempt must be refused');
    assert.ok(second.child && second.exited === null, 'the bridge must stay up');
    // stale clients are purged
    second.sql("UPDATE oidc SET created_at=? WHERE model='Client'", Date.now() - 3 * 86400000);
    await second.stop(); assert.equal(await second.start(), true);
    assert.ok(second.sql("SELECT count(*) n FROM oidc WHERE model='Client'")[0].n < registered.length, 'unused clients were not purged');
    const reset = second.cli(['connect', 'reset', '--json']); assert.equal(reset.code, 0, reset.stderr);
    assert.equal(second.sql("SELECT count(*) n FROM oidc WHERE model='Client'")[0].n, 0, 'reset did not purge unapproved clients');
    assert.equal((await v.register({ client_name: 'after-reset' })).status, 201, 'reset did not restore the registration budget');
  });
  await check('16e', 'capacity: a full cap answers with an explicit busy page (never 500); connect start drops unapproved attempts and keeps approved ones', async () => {
    const cap = await new Bridge('cap').init(); assert.equal(await cap.start(), true, cap.stderr);
    try {
      assert.equal(cap.cli(['connect', 'allow-callback', CALLBACK]).code, 0);
      cap.start_window('lark');
      const v = new Vendor(cap); assert.equal((await v.register()).status, 201);
      const approved = await v.begin(); assert.ok(approved.code);
      assert.equal(cap.approve(approved.code, 'lark').code, 0);
      const flows = [];
      for (let i = 0; i < 24; i++) flows.push(await v.begin());
      assert.ok(flows.every(f => f.code), 'the remaining 24 attempts must get codes');
      const over = await hit(v.authUrl({ challenge: pkce().challenge }), { jar: new Jar() });
      assert.equal(over.status, 503); assert.match(await over.text(), /Busy/); assert.ok(over.headers.get('retry-after'));
      // The owner then starts a window for another worker.
      cap.stop_window();
      assert.equal(cap.cli(['connect', 'start', '--worker', 'duet', '--json']).code, 0);
      assert.equal(cap.sql("SELECT count(*) n FROM pairings WHERE state='pending'")[0].n, 0, 'pending attempts survived connect start');
      assert.equal(cap.sql("SELECT count(*) n FROM oidc WHERE model='Interaction'")[0].n, 1, 'only the approved attempt keeps its interaction');
      assert.equal((await v.finish(approved)).stage, 'callback', 'the approved attempt must still complete');
      const fresh = await v.begin(); assert.ok(fresh.code, 'a new attempt must work after the purge');
      cap.repeat_window('duet');
      assert.ok(cap.pending().pending.some(p => p.code === fresh.code), 'repeating start must keep its attempts');
      const approvedPairing = cap.sql("SELECT uid,state FROM pairings WHERE code=?", approved.code.replace('-', ''))[0];
      const unapproved = new Vendor(cap); assert.equal((await unapproved.register()).status, 201);
      const unapprovedFlow = await unapproved.begin(); assert.ok(unapprovedFlow.code);
      const approvedConnection = cap.list().connections.find(c => c.worker === 'lark'); assert.ok(approvedConnection);
      const reset = cap.cli(['connect', 'reset', '--json']); assert.equal(reset.code, 0, reset.stderr);
      assert.equal(cap.pending().pending.length, 0, 'reset left pending attempts');
      assert.equal(cap.sql("SELECT count(*) n FROM oidc WHERE model='Client' AND id=?", unapproved.client_id)[0].n, 0, 'reset kept an unapproved client');
      assert.equal(cap.sql("SELECT state FROM pairings WHERE uid=?", approvedPairing.uid)[0].state, 'done', 'reset removed the completed approved attempt');
      assert.ok(cap.list().connections.some(c => c.connection_id === approvedConnection.connection_id), 'reset removed an approved connection');
      assert.equal((await new Vendor(cap).register()).status, 201, 'reset did not restore the registration budget');
    } finally { await cap.stop(); }
  });
  await check('16b', 'request size: oversized bodies are refused on registration, token and MCP routes', async () => {
    // Observe early HTTP refusals even if fetch would fail while still uploading the oversized body.
    const post = (url, headers, body) => raw(main.port, { path: new URL(url).pathname, method: 'POST', headers, body });
    const big = JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'x'.repeat(200000) });
    const reg = await post(`${main.oauth}/reg`, { 'content-type': 'application/json' }, big); assert.ok(reg.status >= 400 && reg.status < 500, `reg ${reg.status}`);
    const tok = await post(`${main.oauth}/token`, { 'content-type': 'application/x-www-form-urlencoded' }, `grant_type=authorization_code&code=${'a'.repeat(200000)}`); assert.ok(tok.status >= 400 && tok.status < 500, `token ${tok.status}`);
    const mcp = await post(main.resource, { 'content-type': 'application/json', authorization: 'Bearer ' + 'a'.repeat(43) }, 'x'.repeat(2 * 1024 * 1024)); assert.ok(mcp.status >= 400 && mcp.status < 500, `mcp ${mcp.status}`);
    assert.equal((await fetch(`${main.oauth}/jwks`)).status, 200, 'the server must survive');
    const longUrl = await fetch(`${main.oauth}/auth?client_id=${'a'.repeat(20000)}`); assert.ok(longUrl.status >= 400 && longUrl.status < 500);
  });
  await check('16c', 'SSRF: client metadata URLs and request_uri are never fetched', async () => {
    main.start_window('lark');
    sinkHits.length = 0;
    for (const meta of [{ jwks_uri: `${sinkUrl}/jwks` }, { sector_identifier_uri: `${sinkUrl}/sector` }, { request_uris: [`${sinkUrl}/req`] }, { jwks: { keys: [] } }, { initiate_login_uri: `${sinkUrl}/login` }, { post_logout_redirect_uris: [`${sinkUrl}/out`] }]) {
      const r = await new Vendor(main).register(meta);
      if (r.status === 201) { for (const key of Object.keys(meta)) assert.equal(r.body[key], undefined, `${key} was stored`); } else assert.equal(r.status, 400, JSON.stringify(meta));
    }
    const benign = new Vendor(main); assert.equal((await benign.register({ logo_uri: `${sinkUrl}/logo`, client_uri: `${sinkUrl}/home`, policy_uri: `${sinkUrl}/policy`, tos_uri: `${sinkUrl}/tos` })).status, 201);
    for (const extra of [{ request_uri: `${sinkUrl}/par` }, { request: [Buffer.from('{}').toString('base64url'), Buffer.from('{}').toString('base64url'), ''].join('.') }, { claims: '{}' }]) { await hit(benign.authUrl({ challenge: pkce().challenge, extra }), { jar: new Jar() }); }
    const flow = await benign.begin(); assert.equal(main.approve(flow.code, 'lark').code, 0);
    const cb = await benign.finish(flow); await benign.exchange(cb.code, flow.pkce.verifier);
    const cimd = await hit(`${main.oauth}/auth?${form({ client_id: `${sinkUrl}/client.json`, response_type: 'code', redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: main.resource })}`, { jar: new Jar() });
    assert.ok(cimd.status >= 400 || new URL(cimd.headers.get('location'), main.pub).searchParams.get('error'), 'a URL client_id must not be accepted (CIMD is off)');
    await sleep(300);
    assert.deepEqual(sinkHits, [], `outbound requests happened: ${sinkHits.join(', ')}`);
  });
  await check('16d', 'owner approval is unreachable through the public listener; the owner socket needs the operator key and is mode 0600', async () => {
    for (const p of ['/connect/approve', '/connect/list', '/connect/pending', '/connect/start', '/connect/revoke', '/connect/reset', '/oauth/connect/approve', `/${main.secret}/oauth/interaction/aaaaaaaaaaaa/approve`, '/submit', '/status', '/admin']) {
      for (const method of ['GET', 'POST']) { const r = await raw(main.port, { path: p, method, headers: { host: `127.0.0.1:${main.port}`, 'content-type': 'application/json', 'content-length': '2' }, body: '{}' }); assert.ok([404, 405, 403].includes(r.status) && !/approved|connections/.test(r.text), `${method} ${p} -> ${r.status} ${r.text.slice(0, 80)}`); }
    }
    const sock = path.join(main.home, '.local/share/dot-bridge/admin.sock');
    const viaSocket = (p, method, headers = {}, body = '{}') => new Promise((resolve, reject) => { const req = http.request({ socketPath: sock, path: p, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); }); req.on('error', reject); req.end(body); });
    for (const [p, method] of [['/connect/list', 'GET'], ['/connect/approve', 'POST'], ['/connect/start', 'POST'], ['/connect/revoke', 'POST'], ['/connect/reset', 'POST'], ['/connect/allow-callback', 'POST']]) {
      const r = await viaSocket(p, method); assert.equal(r.status, 400, `${p} without the operator key -> ${r.status}`); assert.match(r.text, /invalid operator key/);
      const bad = await viaSocket(p, method, { 'x-operator-key': 'wrong' }); assert.equal(bad.status, 400);
    }
    if (process.platform === 'linux') {
      const bound = main.child.pid; assert.ok(bound);
      const listeners = spawnSync('ss', ['-ltnp'], { encoding: 'utf8' }).stdout.split('\n').filter(l => l.includes(`pid=${bound},`));
      if (listeners.length) assert.ok(listeners.every(l => l.includes('127.0.0.1:')), `the public listener is not loopback only: ${listeners.join(' | ')}`);
    } else console.log('SKIP listener process inspection: ss is Linux-specific');
  });

  await check('17a', 'revoking a built-in connection retires its webhook before future assignments are queued', async () => {
    const bridge = await new Bridge('event-revoke').init(), receiver = await eventReceiver();
    try {
      assert.equal(await bridge.start(), true, 'isolated bridge did not start');
      assert.equal(bridge.cli(['connect', 'allow-callback', CALLBACK, '--json']).code, 0);
      bridge.start_window('lark');
      const vendor = new Vendor(bridge); assert.equal((await vendor.register()).status, 201);
      const connected = await vendor.connect('lark');
      const sub = await bridge.rpc(connected.access, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: receiver.url, secret: `whsec_${randomBytes(32).toString('base64')}` } });
      assert.equal(sub.status, 200);
      const subscriptionId = sub.body.result.id;
      const revoked = bridge.cli(['connect', 'revoke', 'lark', '--json']);
      assert.equal(revoked.code, 0);
      const request = `req_revoked_${randomUUID().slice(0, 8)}`;
      assert.equal(bridge.submit(request, 'lark').code, 0);
      await sleep(1200);
      assert.equal(receiver.events.length, 0, 'revoked callback received a future assignment event');
      assert.equal(bridge.bridgeDb('SELECT state FROM subscriptions WHERE id=?', subscriptionId)[0].state, 'revoked');
      assert.equal(bridge.bridgeDb("SELECT count(*) n FROM notifications WHERE kind='event' AND subscription_id=? AND request_id=? AND state IN ('pending','failed')", subscriptionId, request)[0].n, 0);
    } finally { await bridge.stop(); await receiver.close(); }
  });

  await check('17b', 'replacing a built-in connection prevents the old callback from receiving future assignments', async () => {
    const bridge = await new Bridge('event-replace').init(), receiver = await eventReceiver();
    try {
      assert.equal(await bridge.start(), true, 'isolated bridge did not start');
      assert.equal(bridge.cli(['connect', 'allow-callback', CALLBACK, '--json']).code, 0);
      bridge.start_window('lark');
      const oldVendor = new Vendor(bridge); assert.equal((await oldVendor.register()).status, 201);
      const oldConnection = await oldVendor.connect('lark');
      const sub = await bridge.rpc(oldConnection.access, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: receiver.url, secret: `whsec_${randomBytes(32).toString('base64')}` } });
      assert.equal(sub.status, 200);
      const subscriptionId = sub.body.result.id;
      const newVendor = new Vendor(bridge); assert.equal((await newVendor.register()).status, 201);
      const newConnection = await newVendor.connect('lark');
      assert.notEqual(newConnection.approval.connection_id, oldConnection.approval.connection_id);
      const request = `req_replaced_${randomUUID().slice(0, 8)}`;
      assert.equal(bridge.submit(request, 'lark').code, 0);
      await sleep(1200);
      assert.equal(receiver.events.length, 0, 'replaced callback received a future assignment event');
      assert.equal(bridge.bridgeDb('SELECT state FROM subscriptions WHERE id=?', subscriptionId)[0].state, 'revoked');
      assert.equal(bridge.bridgeDb("SELECT count(*) n FROM notifications WHERE kind='event' AND subscription_id=? AND request_id=? AND state IN ('pending','failed')", subscriptionId, request)[0].n, 0);
    } finally { await bridge.stop(); await receiver.close(); }
  });

  await check('17f', 'revocation suppresses an already queued webhook before the bridge resumes', async () => {
    const bridge = await new Bridge('event-revoke-pending').init(), receiver = await eventReceiver();
    try {
      assert.equal(await bridge.start(), true, 'isolated bridge did not start');
      assert.equal(bridge.cli(['connect', 'allow-callback', CALLBACK, '--json']).code, 0);
      bridge.start_window('lark');
      const vendor = new Vendor(bridge); assert.equal((await vendor.register()).status, 201);
      const connected = await vendor.connect('lark');
      const sub = await bridge.rpc(connected.access, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: receiver.url, secret: `whsec_${randomBytes(32).toString('base64')}` } });
      assert.equal(sub.status, 200);
      const subscriptionId = sub.body.result.id;
      bridge.bridgeDb("UPDATE operator_state SET paused_at=?,reason='test' WHERE id=1", new Date().toISOString());
      const request = `req_revoked_pending_${randomUUID().slice(0, 8)}`;
      assert.equal(bridge.submit(request, 'lark').code, 0);
      assert.equal(bridge.bridgeDb("SELECT count(*) n FROM notifications WHERE kind='event' AND subscription_id=? AND request_id=? AND state='pending'", subscriptionId, request)[0].n, 1, 'test did not queue a pending webhook');
      assert.equal(bridge.cli(['connect', 'revoke', 'lark', '--json']).code, 0);
      assert.equal(bridge.bridgeDb('SELECT state FROM subscriptions WHERE id=?', subscriptionId)[0].state, 'revoked');
      assert.equal(bridge.bridgeDb("SELECT state FROM notifications WHERE kind='event' AND subscription_id=? AND request_id=?", subscriptionId, request)[0].state, 'suppressed');
      bridge.bridgeDb("UPDATE operator_state SET paused_at=NULL,reason=NULL WHERE id=1");
      await sleep(1200);
      assert.equal(receiver.events.length, 0, 'revoked callback received a previously queued event');
    } finally { await bridge.stop(); await receiver.close(); }
  });

  await check('17d', 'a grant expiry is detected after restart and retires its old webhook subscription', async () => {
    const bridge = await new Bridge('event-expiry').init(), receiver = await eventReceiver();
    try {
      assert.equal(await bridge.start(), true, 'isolated bridge did not start');
      assert.equal(bridge.cli(['connect', 'allow-callback', CALLBACK, '--json']).code, 0);
      bridge.start_window('lark');
      const vendor = new Vendor(bridge); assert.equal((await vendor.register()).status, 201);
      const connected = await vendor.connect('lark');
      const sub = await bridge.rpc(connected.access, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: receiver.url, secret: `whsec_${randomBytes(32).toString('base64')}` } });
      assert.equal(sub.status, 200);
      const subscriptionId = sub.body.result.id;
      await bridge.stop();
      const connection = bridge.sql('SELECT grant_id FROM connections WHERE connection_id=?', connected.approval.connection_id)[0];
      assert.ok(connection);
      bridge.sql("UPDATE oidc SET expires_at=? WHERE model='Grant' AND id=?", Date.now() - 1, connection.grant_id);
      assert.equal(await bridge.start(), true, 'bridge did not restart');
      const request = `req_expired_${randomUUID().slice(0, 8)}`;
      assert.equal(bridge.submit(request, 'lark').code, 0);
      await sleep(1200);
      assert.equal(receiver.events.length, 0, 'expired grant callback received a future assignment event');
      assert.equal(bridge.bridgeDb('SELECT state FROM subscriptions WHERE id=?', subscriptionId)[0].state, 'revoked');
      assert.equal(bridge.bridgeDb("SELECT count(*) n FROM notifications WHERE kind='event' AND subscription_id=? AND request_id=? AND state IN ('pending','failed')", subscriptionId, request)[0].n, 0);
    } finally { await bridge.stop(); await receiver.close(); }
  });

  await check('17e', 'a revoke during callback verification cannot create a stale subscription', async () => {
    const bridge = await new Bridge('event-subscribe-race').init(), receiver = await eventReceiver({ holdVerification: true });
    let subscribePromise;
    try {
      assert.equal(await bridge.start(), true, 'isolated bridge did not start');
      assert.equal(bridge.cli(['connect', 'allow-callback', CALLBACK, '--json']).code, 0);
      bridge.start_window('lark');
      const vendor = new Vendor(bridge); assert.equal((await vendor.register()).status, 201);
      const connected = await vendor.connect('lark');
      subscribePromise = bridge.rpc(connected.access, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: receiver.url, secret: `whsec_${randomBytes(32).toString('base64')}` } });
      await receiver.verificationSeen;
      assert.equal(bridge.cli(['connect', 'revoke', 'lark', '--json']).code, 0);
      receiver.releaseVerification();
      await subscribePromise;
      assert.equal(bridge.bridgeDb("SELECT count(*) n FROM subscriptions WHERE state='active'")[0].n, 0, 'revoked connection retained a subscription');
      const request = `req_race_${randomUUID().slice(0, 8)}`;
      assert.equal(bridge.submit(request, 'lark').code, 0);
      await sleep(1200);
      assert.equal(receiver.events.length, 0, 'revoked connection race delivered an assignment event');
    } finally { receiver.releaseVerification(); await subscribePromise?.catch(() => {}); await bridge.stop(); await receiver.close(); }
  });

  await check('17c', 'the 33rd callback pattern is refused without changing disk or runtime config', async () => {
    const bridge = await new Bridge('callback-cap').init();
    try {
      assert.equal(await bridge.start(), true, 'isolated bridge did not start');
      const configFile = path.join(bridge.config, 'as.json');
      const startingCount = JSON.parse(fs.readFileSync(configFile, 'utf8')).callbacks.length;
      for (let i = startingCount; i < 32; i++) {
        const added = bridge.cli(['connect', 'allow-callback', `https://cap.vendor.example/cb-${i}`, '--json']);
        assert.equal(added.code, 0, 'could not add a valid callback pattern');
      }
      const beforeBytes = fs.readFileSync(configFile), beforeCallbacks = bridge.list().callbacks;
      assert.equal(beforeCallbacks.length, 32);
      const refused = bridge.cli(['connect', 'allow-callback', 'https://cap.vendor.example/cb-32', '--json']);
      assert.notEqual(refused.code, 0, 'the 33rd callback pattern was accepted');
      assert.deepEqual(fs.readFileSync(configFile), beforeBytes, 'failed callback addition changed as.json');
      assert.deepEqual(bridge.list().callbacks, beforeCallbacks, 'failed callback addition changed runtime config');
      assert.match(refused.stderr + refused.stdout, /callbacks/i);
    } finally { await bridge.stop(); }
  });

  await check('17g', 'external OAuth restart retires a built-in callback but keeps external worker delivery', async () => {
    const bridge = await new Bridge('event-auth-mode-transition').init();
    const oldReceiver = await eventReceiver(), externalReceiver = await eventReceiver();
    let jwks = null;
    try {
      assert.equal(await bridge.start(), true, bridge.stderr || 'isolated bridge did not start');
      assert.equal(bridge.cli(['connect', 'allow-callback', CALLBACK, '--json']).code, 0);
      bridge.start_window('lark');
      const vendor = new Vendor(bridge); assert.equal((await vendor.register()).status, 201);
      const connected = await vendor.connect('dot');
      const oldSubscription = await bridge.rpc(connected.access, 'events/subscribe', {
        name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: oldReceiver.url, secret: `whsec_${randomBytes(32).toString('base64')}` },
      });
      assert.equal(oldSubscription.status, 200);
      const oldSubscriptionId = oldSubscription.body.result.id;

      bridge.bridgeDb("UPDATE operator_state SET paused_at=?,reason='test' WHERE id=1", new Date().toISOString());
      const oldRequest = `req_mode_old_${randomUUID().slice(0, 8)}`;
      assert.equal(bridge.submit(oldRequest, 'dot').code, 0);
      assert.equal(bridge.bridgeDb("SELECT state FROM notifications WHERE kind='event' AND subscription_id=? AND request_id=?", oldSubscriptionId, oldRequest)[0].state, 'pending');
      await bridge.stop();

      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'external-test', alg: 'RS256', use: 'sig' };
      jwks = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
      await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
      const jwksBase = `http://127.0.0.1:${jwks.address().port}`;
      const issuer = `${jwksBase}/realms/external`, audience = 'https://external.example/mcp';
      const subject = 'external-worker', clientId = 'external-client', connectionId = 'external-connection';
      fs.writeFileSync(path.join(bridge.config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=${jwksBase}/jwks\nOAUTH_ALLOWED_SUBJECTS=${subject}\n`, { mode: 0o600 });
      fs.writeFileSync(path.join(bridge.config, 'workers.json'), JSON.stringify({ workers: { dot: {
        connections: [{ issuer, subject, client_id: clientId, connection_id: connectionId }], capabilities: ['t3'],
      } } }), { mode: 0o600 });
      bridge.authMode = 'oauth';
      const externalStarted = await bridge.start();
      const startupReason = bridge.stderr.includes('invalid OAuth origins') ? 'invalid OAuth origins'
        : bridge.stderr.includes('OAuth config') ? 'OAuth configuration error'
          : bridge.stderr.includes('worker') ? 'worker profile error'
            : bridge.exited === null ? 'startup timeout' : `process exited ${bridge.exited}`;
      assert.equal(externalStarted, true, `external OAuth bridge did not start on the existing database (${startupReason})`);

      const token = () => {
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'external-test' })).toString('base64url');
        const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 300,
          sub: subject, client_id: clientId, connection_id: connectionId, scope: 'dot-bridge.read dot-bridge.work' })).toString('base64url');
        const input = `${header}.${claims}`;
        return `${input}.${cryptoSign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
      };
      const externalSubscription = await bridge.rpc(token(), 'events/subscribe', {
        name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: externalReceiver.url, secret: `whsec_${randomBytes(32).toString('base64')}` },
      });
      assert.equal(externalSubscription.status, 200, 'external OAuth worker can subscribe after restart');

      const externalRequest = `req_mode_external_${randomUUID().slice(0, 8)}`;
      assert.equal(bridge.submit(externalRequest, 'dot').code, 0);
      bridge.bridgeDb('UPDATE operator_state SET paused_at=NULL,reason=NULL WHERE id=1');
      // Older queued jobs may still exist; the submit wake then names the oldest of them, so any event counts.
      for (let i = 0; i < 50 && !externalReceiver.events.length; i++) await sleep(100);

      assert.ok(externalReceiver.events.length > 0, 'external-mode worker subscription received its event');
      assert.deepEqual(oldReceiver.events, [], 'the old built-in callback received no event after the mode change');
      assert.equal(bridge.bridgeDb('SELECT state FROM subscriptions WHERE id=?', oldSubscriptionId)[0].state, 'revoked');
      assert.equal(bridge.bridgeDb("SELECT state FROM notifications WHERE kind='event' AND subscription_id=? AND request_id=?", oldSubscriptionId, oldRequest)[0].state, 'suppressed');
    } finally {
      await bridge.stop();
      await oldReceiver.close(); await externalReceiver.close();
      if (jwks) await new Promise(resolve => jwks.close(resolve));
    }
  });
} finally {
  await stopAll();
}
const counts = results.reduce((a, [, r]) => (a[r] = (a[r] ?? 0) + 1, a), {});
console.log(`\nRESULT ${JSON.stringify(counts)}${failures.length ? ` failed: ${failures.join(', ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
