#!/usr/bin/env node
// Public wake signal (GET /signal/<token>), offline. A real built-in-mode bridge on loopback, the real `dot-worker connect
// signal-token` CLI over the owner socket, and a fake vendor that claims a job. No vendor traffic. Takes about a minute
// because the endpoint's own 10 s cache and 5 s per-IP rate are not shortened for the test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CALLBACK, Vendor } from './live-trial/fake-vendor.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = reservedPort;
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${String(error.message).split('\n')[0]}`); }
}

class Bridge {
  constructor(name, authMode, workers = ['lark']) { this.name = name; this.authMode = authMode; this.workers = workers; this.home = fs.mkdtempSync(path.join(tempRoot, `sig-${name}-`)); this.config = path.join(this.home, '.config/dot-bridge'); }
  get env() { return { ...process.env, HOME: this.home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: String(this.port), DOT_BRIDGE_AUTH_MODE: this.authMode, DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', NODE_ENV: 'test' }; }
  cli(args, input) { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env: this.env, input, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }
  async init() {
    this.port = await freePort(); this.pub = `http://127.0.0.1:${this.port}`;
    fs.mkdirSync(this.config, { recursive: true });
    if (this.authMode === 'builtin') fs.writeFileSync(path.join(this.config, 'workers.json'), JSON.stringify({ workers: Object.fromEntries(this.workers.map(w => [w, {}])) }), { mode: 0o600 });
    if (this.authMode === 'oauth') fs.writeFileSync(path.join(this.config, 'oauth.env'), `OAUTH_ISSUER=http://127.0.0.1:1/iss\nOAUTH_AUDIENCE=https://example.invalid/mcp\nOAUTH_JWKS_URI=http://127.0.0.1:1/jwks\nOAUTH_ALLOWED_SUBJECTS=nobody\n`, { mode: 0o600 });
    if (this.authMode === 'builtin') assert.equal(this.cli(['as-init', '--public-url', this.pub]).code, 0);
    return this;
  }
  async start() {
    this.log = '';
    this.child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false;
    this.child.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; });
    this.child.stderr.resume();
    for (let i = 0; i < 300 && !ready && this.child.exitCode === null; i++) await sleep(50);
    assert.ok(ready, 'bridge startup');
    this.secret = fs.readFileSync(path.join(this.config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    this.resource = `${this.pub}/${this.secret}/mcp`; this.oauth = `${this.pub}/${this.secret}/oauth`;
  }
  async stop() { if (this.child && this.child.exitCode === null && this.child.signalCode === null) { this.child.kill('SIGTERM'); await new Promise(resolve => this.child.once('exit', resolve)); } }
  logLines() { try { return fs.readFileSync(path.join(this.home, '.local/state/dot-bridge/requests.jsonl'), 'utf8'); } catch { return ''; } }
  start_window(worker) { this.cli(['connect', 'stop', '--json']); const r = this.cli(['connect', 'start', '--worker', worker, '--json']); assert.equal(r.code, 0, r.stderr); }
  approve(code, worker, replace = true) { const r = this.cli(['connect', 'approve', code, '--worker', worker, ...(replace ? ['--replace'] : []), '--json']); return { ...r, json: () => JSON.parse(r.stdout) }; }
  async tool(bearer, name, args = {}) {
    const res = await fetch(this.resource, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
    const body = await res.json();
    return body.result.isError ? { ok: false, error: body.result.content[0].text } : { ok: true, value: JSON.parse(body.result.content[0].text) };
  }
  submit(id, worker = 'lark') { return this.cli(['submit', '--stdin', '--json', '--worker', worker], JSON.stringify({ schema_version: 1, request_id: id, brief: `signal-test ${id}`, inputs: [{ revision: 'abc' }], expected_output: 'one result', execution_scope: 'read-only' })); }
}

const main = await new Bridge('main', 'builtin').init();
const pair = await new Bridge('pair', 'builtin', ['alpha', 'beta']).init();
const oauthMode = await new Bridge('oauth', 'oauth').init();
const legacyMode = await new Bridge('legacy', '').init();
const roots = [pair.home, main.home, oauthMode.home, legacyMode.home];
const cleanup = async () => { await main.stop(); await pair.stop(); await oauthMode.stop(); await legacyMode.stop(); for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); };

const signalUrl = (base, token) => `${base}/signal/${token}`;
// One request every 5.5 s keeps a single client inside the per-IP rate (about 1 per 5 s).
let lastValid = 0;
async function valid(url) {
  const wait = lastValid + 5500 - Date.now();
  if (wait > 0) await sleep(wait);
  lastValid = Date.now();
  return fetch(url);
}
async function until(url, expected, limitMs = 25000) {
  const stop = Date.now() + limitMs; let last;
  while (Date.now() < stop) {
    const res = await valid(url);
    assert.equal(res.status, 200, `status ${res.status}`);
    last = (await res.json()).work;
    if (last === expected) return Date.now();
  }
  throw new Error(`work stayed ${last}, expected ${expected}`);
}

try {
  await main.start();
  const signalFile = path.join(main.config, 'signal-token.lark');
  const urlFile = path.join(main.config, 'signal-url.lark');
  let url, token, oldToken;
  const tokenOf = u => u.split('/signal/')[1];

  await check('404 before any token exists (a plausible token path)', async () => {
    assert.equal(fs.existsSync(signalFile), false);
    assert.equal((await fetch(signalUrl(main.pub, 'a'.repeat(64)))).status, 404);
    assert.equal((await fetch(signalUrl(main.pub, ''))).status, 404);
  });
  await check('owner command creates a 256-bit token (mode 0600) and prints only the private URL file path', async () => {
    const r = main.cli(['connect', 'signal-token']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), urlFile);
    url = fs.readFileSync(urlFile, 'utf8').trim(); token = tokenOf(url);
    assert.equal(fs.statSync(urlFile).mode & 0o777, 0o600);
    assert.equal(url, signalUrl(main.pub, token));
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.notEqual(token, main.secret, 'signal token must not be the MCP path secret');
    assert.equal(fs.readFileSync(signalFile, 'utf8').trim(), token);
    assert.equal(fs.statSync(signalFile).mode & 0o777, 0o600);
    const again = main.cli(['connect', 'signal-token', '--json']);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(Object.keys(JSON.parse(again.stdout)).sort(), ['path', 'poll_interval_seconds', 'rotated', 'worker']);
    assert.equal(JSON.parse(again.stdout).path, urlFile);
    for (const output of [r.stdout + r.stderr, again.stdout + again.stderr]) {
      assert.ok(!output.includes(token) && !output.includes(url) && !output.includes(main.secret), 'credential leaked by connect output');
    }
    assert.equal(tokenOf(fs.readFileSync(urlFile, 'utf8').trim()), token, 'a second call must keep the token');
    const victim = path.join(main.home, 'owner-file');
    fs.writeFileSync(victim, 'unchanged', { mode: 0o600 });
    fs.rmSync(urlFile); fs.symlinkSync(victim, urlFile);
    assert.equal(main.cli(['connect', 'signal-token']).code, 0);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unchanged', 'URL write followed a symlink');
    assert.equal(fs.lstatSync(urlFile).isSymbolicLink(), false);
    fs.chmodSync(urlFile, 0o644);
    assert.equal(main.cli(['connect', 'signal-token']).code, 0);
    assert.equal(fs.statSync(urlFile).mode & 0o777, 0o600, 'existing permissive file not replaced privately');
    // Poll interval: 60 s with no exposure record, 300 s when the recorded exposure is ngrok. stdout stays the private file path.
    const plain = main.cli(['connect', 'signal-token']);
    assert.match(plain.stderr, /Hook poll interval: 60 s/);
    const ngrokRecord = path.join(main.home, 'dot-bridge-lark.exposure.json');
    fs.writeFileSync(ngrokRecord, JSON.stringify({ mode: 'ngrok', worker: 'lark' }), { mode: 0o600 });
    assert.match(main.cli(['connect', 'signal-token']).stderr, /Hook poll interval: 300 s/);
    fs.rmSync(ngrokRecord);
  });
  await check('work false with an empty queue; headers and body are exact', async () => {
    const res = await valid(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(await res.text(), '{"work":false}');
  });
  // The cache holds the answer up to 10 s, so the next flip shows within about 10 s plus one poll interval.
  const reqId = `req_sig_${randomUUID().slice(0, 8)}`;
  await check('submitting a job for the worker makes work true within 10 s', async () => {
    assert.equal(main.submit(reqId).code, 0);
    const t0 = Date.now();
    const at = await until(url, true);
    assert.ok(at - t0 <= 10000 + 5600, `took ${at - t0} ms`);
  });
  await check('claiming it makes work false within 10 s', async () => {
    const vendor = new Vendor(main);
    assert.equal(main.cli(['connect', 'allow-callback', CALLBACK]).code, 0);
    main.start_window('lark');
    assert.equal((await vendor.register()).status, 201);
    const lark = await vendor.connect('lark', { windowOpen: true });
    const claim = await main.tool(lark.access, 'claim', { request_id: reqId, claimant: 'lark' });
    assert.equal(claim.ok, true, JSON.stringify(claim));
    const t0 = Date.now();
    const at = await until(url, false);
    assert.ok(at - t0 <= 10000 + 5600, `took ${at - t0} ms`);
  });
  await check('wrong, missing and look-alike tokens answer 404 with an empty body', async () => {
    for (const bad of ['b'.repeat(64), token.slice(0, 63), `${token}0`, token.toUpperCase(), `${token}/x`, 'x']) {
      const res = await fetch(signalUrl(main.pub, bad));
      assert.equal(res.status, 404, bad.length + ' chars');
      assert.equal(await res.text(), '');
    }
    assert.equal((await fetch(`${main.pub}/signal`)).status, 404);
  });
  await check('POST with the right token is refused (405); wrong token with POST is 404', async () => {
    await sleep(5500);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(signalUrl(main.pub, 'c'.repeat(64)), { method: 'POST' })).status, 404);
  });
  await check('a Host header other than the public host is refused (421)', async () => {
    const status = await new Promise((resolve, reject) => {
      import('node:http').then(({ default: http }) => {
        const req = http.request({ host: '127.0.0.1', port: main.port, path: `/signal/${token}`, headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
    });
    assert.equal(status, 421);
  });
  await check('rotate: old URL 404 at once, new URL works, file replaced', async () => {
    const r = main.cli(['connect', 'signal-token', '--rotate']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), urlFile);
    const fresh = fs.readFileSync(urlFile, 'utf8').trim(), freshToken = tokenOf(fresh);
    assert.match(freshToken, /^[a-f0-9]{64}$/); assert.notEqual(freshToken, token);
    assert.equal((await fetch(url)).status, 404, 'old URL still works');
    const res = await valid(fresh);
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(signalFile, 'utf8').trim(), freshToken);
    assert.equal(fs.statSync(signalFile).mode & 0o777, 0o600);
    oldToken = token; url = fresh; token = freshToken;
  });
  await check('burst from one address: 429 with Retry-After; a wrong token is still 404, not 429', async () => {
    await sleep(16000); // bucket refills to full
    const statuses = [];
    let retry = null;
    for (let i = 0; i < 8; i++) { const res = await fetch(url); statuses.push(res.status); if (res.status === 429) retry = res.headers.get('retry-after'); await res.text(); }
    assert.equal(statuses[0], 200);
    assert.ok(statuses.includes(429), statuses.join(','));
    assert.ok(statuses.filter(s => s === 200).length <= 4, statuses.join(','));
    assert.match(retry ?? '', /^\d+$/);
    assert.equal((await fetch(signalUrl(main.pub, 'd'.repeat(64)))).status, 404);
  });
  await check('log lines have kind signal, status and work, and never the token or the path secret', async () => {
    const text = main.logLines();
    const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.kind === 'signal');
    assert.ok(lines.length >= 10, `${lines.length} signal lines`);
    assert.ok(lines.some(e => e.status === 200 && e.work === true) && lines.some(e => e.status === 200 && e.work === false));
    assert.ok(lines.some(e => e.status === 404) && lines.some(e => e.status === 429) && lines.some(e => e.status === 405));
    for (const e of lines) assert.deepEqual(Object.keys(e).filter(k => !['at', 'kind', 'status', 'work'].includes(k)), []);
    assert.ok(!text.includes(token) && !text.includes(oldToken), 'token in log');
    assert.ok(!text.includes('/signal/'), 'signal path in log');
  });

  // Per-worker tokens: a hook for one worker learns nothing about another worker's queue.
  const tokenFile = (b, w) => path.join(b.config, `signal-token.${w}`);
  let aUrl, bUrl;
  await check('two workers: signal-token needs --worker, creates signal-token.<worker> (0600), unknown worker refused', async () => {
    await pair.start();
    const bare = pair.cli(['connect', 'signal-token']);
    assert.notEqual(bare.code, 0);
    assert.match(bare.stderr, /--worker NAME/);
    assert.notEqual(pair.cli(['connect', 'signal-token', '--worker', 'nobody']).code, 0);
    pair.cli(['connect', 'signal-token', '--worker', 'alpha']);
    pair.cli(['connect', 'signal-token', '--worker', 'beta']);
    aUrl = fs.readFileSync(path.join(pair.config, 'signal-url.alpha'), 'utf8').trim();
    bUrl = fs.readFileSync(path.join(pair.config, 'signal-url.beta'), 'utf8').trim();
    assert.notEqual(tokenOf(aUrl), tokenOf(bUrl));
    for (const [w, u] of [['alpha', aUrl], ['beta', bUrl]]) {
      assert.equal(fs.readFileSync(tokenFile(pair, w), 'utf8').trim(), tokenOf(u));
      assert.equal(fs.statSync(tokenFile(pair, w)).mode & 0o777, 0o600);
    }
    assert.equal(fs.existsSync(path.join(pair.config, 'signal-token')), false);
  });
  await check("work for beta only: alpha's URL stays false, beta's turns true", async () => {
    assert.equal(pair.submit(`req_sig_${randomUUID().slice(0, 8)}`, 'beta').code, 0);
    await until(bUrl, true);
    const res = await valid(aUrl);
    assert.equal(await res.text(), '{"work":false}');
  });
  await check("rotating alpha's token leaves beta's URL and file untouched", async () => {
    const before = fs.readFileSync(tokenFile(pair, 'beta'), 'utf8');
    pair.cli(['connect', 'signal-token', '--worker', 'alpha', '--rotate']);
    const fresh = fs.readFileSync(path.join(pair.config, 'signal-url.alpha'), 'utf8').trim();
    assert.notEqual(tokenOf(fresh), tokenOf(aUrl));
    assert.equal((await fetch(aUrl)).status, 404, 'old alpha URL still works');
    assert.equal(fs.readFileSync(tokenFile(pair, 'beta'), 'utf8'), before);
    assert.equal(await (await valid(bUrl)).text(), '{"work":true}');
    assert.equal(await (await valid(fresh)).text(), '{"work":false}');
  });
  await pair.stop();

  // Migration: the live single-worker host has one legacy signal-token file and a hook already polling its URL.
  await check('a legacy single signal-token file keeps answering for the one configured worker; no new file on a repeat call', async () => {
    const solo = await new Bridge('solo', 'builtin', ['lark']).init();
    roots.push(solo.home);
    const legacyToken = 'f'.repeat(64);
    fs.writeFileSync(path.join(solo.config, 'signal-token'), `${legacyToken}\n`, { mode: 0o600 });
    try {
      await solo.start();
      const privateUrl = path.join(solo.config, 'signal-url.lark');
      assert.equal(solo.cli(['connect', 'signal-token']).stdout.trim(), privateUrl);
      assert.equal(solo.cli(['connect', 'signal-token', '--worker', 'lark']).stdout.trim(), privateUrl);
      assert.equal(fs.readFileSync(privateUrl, 'utf8').trim(), signalUrl(solo.pub, legacyToken), 'legacy URL changed');
      assert.equal(fs.existsSync(tokenFile(solo, 'lark')), false);
      assert.equal(await (await valid(signalUrl(solo.pub, legacyToken))).text(), '{"work":false}');
      assert.equal(solo.cli(['connect', 'signal-token', '--rotate']).stdout.trim(), privateUrl);
      const rotated = fs.readFileSync(privateUrl, 'utf8').trim();
      assert.notEqual(tokenOf(rotated), legacyToken);
      assert.equal((await fetch(signalUrl(solo.pub, legacyToken))).status, 404, 'legacy token must die on rotate');
      assert.equal((await valid(rotated)).status, 200);
      assert.equal(fs.existsSync(path.join(solo.config, 'signal-token')), false);
    } finally { await solo.stop(); }
  });
  await main.stop();

  await check('catalog golden test still passes', async () => {
    const r = spawnSync(process.execPath, ['scripts/catalog-golden-test.mjs'], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  // The route does not exist outside built-in mode: even a token file in the config dir changes nothing.
  for (const mode of [oauthMode, legacyMode]) {
    await check(`route absent in ${mode.name} mode (404 even with a token file present)`, async () => {
      fs.writeFileSync(path.join(mode.config, 'signal-token'), `${'e'.repeat(64)}\n`, { mode: 0o600 });
      await mode.start().catch(() => { throw new Error(`${mode.name} bridge did not start`); });
      assert.equal((await fetch(signalUrl(mode.pub, 'e'.repeat(64)))).status, 404);
      const r = mode.cli(['connect', 'signal-token']);
      assert.notEqual(r.code, 0, 'owner command must fail without the built-in server');
      await mode.stop();
    });
  }
} finally {
  await cleanup();
}
if (failures.length) { console.log(`\n${failures.length} FAILED: ${failures.join('; ')}`); process.exit(1); }
console.log('\nsignal endpoint: all checks passed');
