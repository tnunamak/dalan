#!/usr/bin/env node
// Generic profile defaults, offline: `init` creates a named worker profile, `--legacy` keeps the old behavior, and `submit`
// without --worker is refused in profile mode (unless the profile has one worker). Real bridge on loopback, real CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

class Host {
  constructor(name, authMode) { this.authMode = authMode; this.home = fs.mkdtempSync(path.join(tempRoot, `gp-${name}-`)); this.config = path.join(this.home, '.config/dalan'); this.workersFile = path.join(this.config, 'workers.json'); }
  get env() { return { ...process.env, HOME: this.home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: String(this.port), DOT_BRIDGE_AUTH_MODE: this.authMode, DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', NODE_ENV: 'test' }; }
  cli(args, input) { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env: this.env, input, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }
  async port_() { this.port = await freePort(); this.pub = `http://127.0.0.1:${this.port}`; }
  async start() {
    this.child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false;
    this.child.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; });
    this.child.stderr.resume();
    for (let i = 0; i < 300 && !ready && this.child.exitCode === null; i++) await sleep(50);
    assert.ok(ready, 'bridge startup');
  }
  async stop() { if (this.child && this.child.exitCode === null && this.child.signalCode === null) { this.child.kill('SIGTERM'); await new Promise(resolve => this.child.once('exit', resolve)); } }
  submit(id, worker) { return this.cli(['submit', '--stdin', '--json', ...(worker ? ['--worker', worker] : [])], JSON.stringify({ schema_version: 1, request_id: id, brief: `profile-test ${id}`, inputs: [{ revision: 'abc' }], expected_output: 'one result', execution_scope: 'read-only' })); }
}

const hosts = [];
const host = async (name, mode) => { const h = new Host(name, mode); await h.port_(); hosts.push(h); return h; };
try {
  const fresh = await host('fresh', 'builtin');
  await check('fresh init creates a generic profile (mode 0600, no capabilities, execution none)', async () => {
    const r = fresh.cli(['init', '--worker', 'lark', '--public-url', fresh.pub, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(fresh.workersFile, 'utf8')), { workers: { lark: { repos: [] } }, default_execution: 'none' });
    assert.equal(fs.statSync(fresh.workersFile).mode & 0o777, 0o600);
  });
  await check('a second init refuses to overwrite and leaves workers.json unchanged', async () => {
    const before = fs.readFileSync(fresh.workersFile, 'utf8');
    const r = fresh.cli(['init', '--worker', 'other', '--public-url', fresh.pub, '--json']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /already exists/);
    assert.equal(fs.readFileSync(fresh.workersFile, 'utf8'), before);
  });
  await check('init without --worker or --legacy is refused and writes nothing', async () => {
    const h = await host('noflag', 'builtin');
    const r = h.cli(['init', '--public-url', h.pub, '--json']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /--worker NAME/);
    assert.equal(fs.existsSync(h.workersFile), false);
    assert.equal(fs.existsSync(path.join(h.config, 'as.json')), false);
  });
  await check('init rejects an invalid worker name and writes nothing', async () => {
    const h = await host('badname', 'builtin');
    assert.notEqual(h.cli(['init', '--worker', 'Bad Name', '--public-url', h.pub, '--json']).code, 0);
    assert.equal(fs.existsSync(h.workersFile), false);
  });
  await check('init --legacy writes no workers.json, creates the AS files and says legacy is for older single-worker hosts', async () => {
    const h = await host('legacy-init', 'builtin');
    const r = h.cli(['init', '--legacy', '--public-url', h.pub, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(h.workersFile), false);
    assert.equal(fs.existsSync(path.join(h.config, 'as.json')), true);
    assert.match(r.stderr, /legacy mode .*is for older single-worker hosts/i);
    assert.equal(JSON.parse(r.stdout).workers_profile, null);
  });
  await check('init rejects --legacy together with --worker', async () => {
    const h = await host('both', 'builtin');
    assert.notEqual(h.cli(['init', '--legacy', '--worker', 'lark', '--public-url', h.pub, '--json']).code, 0);
  });

  await check('profile with one worker: submit without --worker defaults to it', async () => {
    await fresh.start();
    const r = fresh.submit('req_gp_single_01');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).worker ?? 'lark', 'lark');
    await fresh.stop();
  });
  const multi = await host('multi', 'builtin');
  await check('profile with two workers: submit without --worker is refused with one line listing them', async () => {
    assert.equal(multi.cli(['init', '--worker', 'a', '--public-url', multi.pub, '--json']).code, 0);
    fs.writeFileSync(multi.workersFile, JSON.stringify({ workers: { a: {}, b: {} }, default_execution: 'none' }), { mode: 0o600 });
    await multi.start();
    const r = multi.submit('req_gp_multi_001');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /use --worker NAME; configured: a, b/);
    assert.ok(!/unknown worker "dot"/.test(r.stderr), r.stderr);
    assert.equal(multi.submit('req_gp_multi_001', 'b').code, 0, 'explicit --worker still works');
    await multi.stop();
  });

  const legacy = await host('legacy-submit', '');
  await check('legacy mode (no workers.json): submit without --worker still defaults to worker', async () => {
    await legacy.start();
    const r = legacy.submit('req_gp_legacy_01');
    assert.equal(r.code, 0, r.stderr);
    await legacy.stop();
  });
} finally {
  for (const h of hosts) { await h.stop(); fs.rmSync(h.home, { recursive: true, force: true }); }
}
if (failures.length) { console.log(`\n${failures.length} FAILED: ${failures.join('; ')}`); process.exit(1); }
console.log('\ngeneric profile: all checks passed');
