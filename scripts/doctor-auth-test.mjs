#!/usr/bin/env node
// `dalan doctor --auth` against real bridge processes (real oidc-provider, real SQLite, real owner socket, the real CLI).
// The bridge listens on loopback over HTTP in test-OAuth mode; the CLI reads its URL from the home's resource-url file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Vendor } from './live-trial/fake-vendor.mjs';
import { reservedPort } from '../src/test-support/port.mjs';
import { runAuthCheck } from '../src/auth-check.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
// A short root: the admin socket path must stay under the platform limit.
const scratchBase = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratchBase, { recursive: true });
const root = fs.mkdtempSync(path.join(scratchBase, 'a-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];
async function check(id, name, fn) {
  try { await fn(); console.log(`PASS ${id} ${name}`); }
  catch (error) { failures.push(id); console.log(`FAIL ${id} ${name}: ${String(error.stack ?? error).split('\n').slice(0, 6).join('\n')}`); }
}

class Bridge {
  constructor(name, workers) { this.home = path.join(root, name); this.config = path.join(this.home, '.config/dot-bridge'); this.workers = workers; }
  get env() { return { ...process.env, HOME: this.home, DALAN_HOME: '', DOT_BRIDGE_PORT: String(this.port), DOT_BRIDGE_AUTH_MODE: 'builtin', DOT_BRIDGE_TEST_OAUTH: '1', NODE_ENV: 'test' }; }
  cli(args) { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env: this.env, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr, json() { return JSON.parse(r.stdout); } }; }
  async init() {
    this.port = await reservedPort();
    this.pub = `http://127.0.0.1:${this.port}`;
    fs.mkdirSync(this.config, { recursive: true });
    fs.writeFileSync(path.join(this.config, 'workers.json'), JSON.stringify({ workers: Object.fromEntries(this.workers.map(w => [w, {}])) }), { mode: 0o600 });
    assert.equal(this.cli(['as-init', '--public-url', this.pub]).code, 0);
    return this;
  }
  async start() {
    let ready = false, stderr = '';
    this.child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', b => { if (/MCP listening on/.test(String(b))) ready = true; });
    this.child.stderr.on('data', b => { stderr += b; });
    for (let i = 0; i < 300 && !ready; i++) await sleep(50);
    assert.ok(ready, `bridge did not start: ${stderr}`);
    this.secret = fs.readFileSync(path.join(this.config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    this.resource = `${this.pub}/${this.secret}/mcp`;
    this.oauth = `${this.pub}/${this.secret}/oauth`;
  }
  publish() { fs.writeFileSync(path.join(this.home, 'resource-url'), `${this.resource}\n`, { mode: 0o600 }); }
  async stop() { if (this.child?.exitCode === null && this.child.signalCode === null) { this.child.kill('SIGTERM'); await new Promise(resolve => this.child.once('exit', resolve)); } }
  connections() { const r = this.cli(['connect', 'list']); assert.equal(r.code, 0, r.all); return r.json(); }
  active(worker) { return this.connections().connections.filter(c => c.worker === worker && c.revoked_at === null); }
}

const solo = await new Bridge('s', ['lark']).init();
const pair = await new Bridge('p', ['lark', 'duet']).init();
const bare = await new Bridge('b', ['lark']).init(); // never gets a resource-url file
const stopAll = async () => { for (const b of [solo, pair]) await b.stop(); if (process.env.KEEP_TEST_FIXTURES !== '1') fs.rmSync(root, { recursive: true, force: true }); };

// Nothing the walk learns may reach the output: the secret path, the URL, the pairing code, a token.
const assertClean = (bridge, text, extra = []) => {
  for (const needle of [bridge.secret, bridge.resource, ...extra].filter(Boolean)) assert.ok(!text.includes(needle), 'a secret value reached the output');
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9_-]{32,}/, 'no token or long secret in the output');
  assert.doesNotMatch(text, /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/, 'no pairing code in the output');
};

try {
  await solo.start(); await pair.start();

  await check('A1', 'no resource-url file: says so and exits 1', () => {
    const r = bare.cli(['doctor', '--auth']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.stdout, /no resource-url file/);
    assert.match(r.stdout, /RESULT FAIL/);
    const j = bare.cli(['doctor', '--auth', '--json']);
    assert.equal(j.code, 1);
    assert.equal(j.json().ok, false);
  });

  await check('A2', 'the full walk passes with the only worker, leaves zero active connections and no secret in the output', () => {
    solo.publish();
    assert.equal(solo.active('lark').length, 0);
    const r = solo.cli(['doctor', '--auth']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.stdout, /RESULT PASS/);
    for (const step of ['challenge', 'discovery', 'metadata', 'registration', 'authorize', 'approval', 'callback', 'token', 'mcp auth', 'mcp initialize', 'mcp tools/list', 'mcp tools/call']) assert.match(r.stdout, new RegExp(`^PASS ${step}`, 'm'), step);
    assert.deepEqual(solo.active('lark'), [], 'the self-check connection is revoked');
    const list = solo.connections();
    assert.equal(list.window, null, 'the pairing window it opened is closed');
    assert.equal(list.connections.length, 1);
    assert.equal(list.connections[0].revoked_reason, 'owner_revoked');
    assertClean(solo, r.all);
  });

  await check('A3', '--json prints {ok, results:[{name,status}]}, exit 0', () => {
    const r = solo.cli(['doctor', '--auth', '--json']);
    assert.equal(r.code, 0, r.all);
    const out = r.json();
    assert.equal(out.ok, true);
    assert.ok(out.results.length >= 12 && out.results.every(x => typeof x.name === 'string' && x.status === 'PASS'));
    assertClean(solo, r.all);
    assert.deepEqual(solo.active('lark'), []);
  });

  await check('A4', 'several workers and no --worker: refused with the names; unknown --worker refused; nothing changes', () => {
    pair.publish();
    const r = pair.cli(['doctor', '--auth']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.stdout, /choose one with --worker/);
    assert.equal(pair.cli(['doctor', '--auth', '--worker', 'nope']).code, 1);
    assert.equal(pair.connections().connections.length, 0);
  });

  // An open pairing window is never taken over, not even this worker's own. Before A5, which gives lark a connection.
  for (const [id, windowWorker, expected] of [
    ['A7same', 'lark', 'your own pairing window is already open (worker lark); doctor cannot check sign-in while it is open. Finish pairing the client, then run doctor again; or run dalan connect stop, then run doctor again'],
    ['A7other', 'duet', 'a pairing window is already open (worker duet); finish it or run dalan connect stop, then retry']
  ]) {
    await check(id, 'an open pairing window: the exact diagnostic, and the window and connections are unchanged', () => {
      assert.equal(pair.cli(['connect', 'start', '--worker', windowWorker]).code, 0);
      try {
        const before = pair.connections();
        const r = pair.cli(['doctor', '--auth', '--worker', 'lark']);
        assert.equal(r.code, 1, r.all);
        assert.ok(r.stdout.includes(`FAIL input: ${expected}\n`), r.stdout);
        assert.match(r.stdout, /RESULT FAIL/);
        const after = pair.connections();
        assert.deepEqual(after.window, before.window);
        assert.deepEqual(after.connections, before.connections);
        assertClean(pair, r.all);
      } finally { assert.equal(pair.cli(['connect', 'stop']).code, 0); }
    });
    await check(`${id}calls`, 'an open pairing window: only the connection listing is requested; no start, stop, approve, revoke or OAuth call', async () => {
      const calls = [], output = [];
      const result = await runAuthCheck({
        home: pair.home, workers: pair.workers, worker: 'lark', operator: () => 'test-operator',
        request: async (route, method, value) => { calls.push([route, method, value]); return { window: { worker: windowWorker }, connections: [] }; },
        fetchImpl: async () => { throw new Error('an open window must not start the OAuth walk'); },
        say: line => output.push(line)
      });
      assert.deepEqual(calls, [['/connect/list', 'GET', null]]);
      assert.deepEqual(result, { ok: false, results: [{ name: 'input', status: 'FAIL', detail: expected }] });
      assert.deepEqual(output, [`FAIL input: ${expected}`, 'RESULT FAIL']);
    });
  }

  await check('A5', 'a worker that already has a connection: SKIP, nothing approved or revoked, the other steps ran', async () => {
    const vendor = new Vendor(pair, 'https://existing.example/cb');
    pair.cli(['connect', 'start', '--worker', 'lark']);
    assert.equal((await vendor.register()).status, 201);
    const flow = await vendor.begin({ redirect: 'https://existing.example/cb' });
    assert.ok(flow.code);
    assert.equal(pair.cli(['connect', 'approve', flow.code, '--worker', 'lark']).code, 0);
    pair.cli(['connect', 'stop']);
    const before = pair.connections();
    const r = pair.cli(['doctor', '--auth', '--worker', 'lark']);
    assert.notEqual(r.code, 0);
    assert.notEqual(r.code, 1, 'a skip is not a FAIL');
    assert.match(r.stdout, /SKIP full walk: worker lark already has a connection \(it would be replaced\)/);
    for (const step of ['challenge', 'discovery', 'metadata']) assert.match(r.stdout, new RegExp(`^PASS ${step}`, 'm'));
    assert.doesNotMatch(r.stdout, /PASS registration|RESULT PASS/);
    const after = pair.connections();
    assert.deepEqual(after.connections, before.connections, 'the existing connection is untouched');
    assert.equal(pair.active('lark').length, 1);
    assert.equal(after.connections.length, 1, 'no new connection was approved');
    const j = pair.cli(['doctor', '--auth', '--worker', 'lark', '--json']).json();
    assert.equal(j.ok, false);
    assert.equal(j.results.at(-1).status, 'SKIP');
    assertClean(pair, r.all, [flow.code]);
    // The other worker on the same bridge still walks fully.
    const other = pair.cli(['doctor', '--auth', '--worker', 'duet']);
    assert.equal(other.code, 0, other.all);
    assert.equal(pair.active('duet').length, 0);
    assert.equal(pair.active('lark').length, 1, 'lark still holds its own connection');
  });

  await check('A7', 'a pairing window someone else opened is not taken over', () => {
    solo.cli(['connect', 'start', '--worker', 'lark']);
    const r = solo.cli(['doctor', '--auth']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.stdout, /pairing window is already open/);
    assert.ok(solo.connections().window, 'their window is still open');
    solo.cli(['connect', 'stop']);
  });

  await check('A6', 'a bridge that is not running: FAIL with exit 1', async () => {
    const dead = await new Bridge('d', ['lark']).init();
    dead.secret = 'x'.repeat(8); dead.resource = `${dead.pub}/${dead.secret}/mcp`; dead.publish();
    const r = dead.cli(['doctor', '--auth']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.stdout, /FAIL/);
  });
} finally { await stopAll(); }
if (failures.length) { console.log(`FAILED: ${failures.join(', ')}`); process.exit(1); }
console.log('doctor --auth: all checks passed');
