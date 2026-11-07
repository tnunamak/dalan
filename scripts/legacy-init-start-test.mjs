#!/usr/bin/env node
// First start with no workers.json: `dalan init --legacy` is an explicit choice and the server accepts it without an
// environment variable; a zero-byte or schema-less bridge.db does not count as an existing install. Real CLI, real server.
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
const failures = [];
const homes = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${String(error.message).split('\n')[0]}`); }
}

async function makeHome(name) {
  const home = fs.mkdtempSync(path.join(tempRoot, `lis-${name}-`));
  homes.push(home);
  const port = await reservedPort();
  const env = { ...process.env, HOME: home, DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_AUTH_MODE: 'builtin', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', NODE_ENV: 'test' };
  delete env.DALAN_LEGACY_PROFILE; delete env.DOT_BRIDGE_LEGACY_PROFILE;
  const pub = `http://127.0.0.1:${port}`;
  const cli = args => { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  // Returns { ready, code, stderr } once the server is listening or has exited.
  const start = async () => {
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false, stderr = '';
    child.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; });
    child.stderr.on('data', b => { stderr += b; });
    for (let i = 0; i < 400 && !ready && child.exitCode === null; i++) await sleep(50);
    const code = child.exitCode;
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    return { ready, code, stderr };
  };
  return { home, cli, start, pub, config: path.join(home, '.config/dalan'), data: path.join(home, '.local/share/dalan') };
}
const dbDir = h => fs.existsSync(h.data) ? h.data : path.join(h.home, '.local/share/dot-bridge');

try {
  await check('init --legacy then a first start works with no environment variable, and a restart keeps working', async () => {
    const h = await makeHome('legacy');
    const r = h.cli(['init', '--legacy', '--public-url', h.pub, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).legacy_profile, /legacy-profile$/);
    const first = await h.start();
    assert.ok(first.ready, `first start refused: ${first.stderr}`);
    const second = await h.start();
    assert.ok(second.ready, `second start refused: ${second.stderr}`);
  });

  await check('a fresh home without init --legacy is refused and the message names every way forward', async () => {
    const h = await makeHome('fresh');
    assert.equal(h.cli(['init', '--worker', 'lark', '--public-url', h.pub, '--json']).code, 0);
    fs.rmSync(path.join(h.config, 'workers.json'));
    const r = await h.start();
    assert.equal(r.ready, false);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /dalan init --worker NAME/);
    assert.match(r.stderr, /dalan init --legacy/);
    assert.match(r.stderr, /DALAN_LEGACY_PROFILE=1/);
  });

  await check('a zero-byte bridge.db is not an existing install: the start refuses like a fresh home and the file stays empty', async () => {
    const h = await makeHome('empty-db');
    assert.equal(h.cli(['init', '--worker', 'lark', '--public-url', h.pub, '--json']).code, 0);
    fs.rmSync(path.join(h.config, 'workers.json'));
    const dir = dbDir(h);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = path.join(dir, 'bridge.db');
    fs.writeFileSync(db, '');
    const r = await h.start();
    assert.equal(r.ready, false, 'started on an empty bridge.db');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no worker is configured/);
    assert.equal(fs.statSync(db).size, 0, 'the check modified bridge.db');
  });

  await check('a bridge.db with a table but no schema version is not an existing install', async () => {
    const h = await makeHome('no-version');
    assert.equal(h.cli(['init', '--worker', 'lark', '--public-url', h.pub, '--json']).code, 0);
    fs.rmSync(path.join(h.config, 'workers.json'));
    const dir = dbDir(h);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'bridge.db'));
    db.exec('CREATE TABLE stray (x INTEGER)');
    db.close();
    const r = await h.start();
    assert.equal(r.ready, false);
    assert.match(r.stderr, /no worker is configured/);
  });

  await check('a real existing install (database with a schema version) keeps starting in legacy mode without a marker', async () => {
    const h = await makeHome('existing');
    assert.equal(h.cli(['init', '--legacy', '--public-url', h.pub, '--json']).code, 0);
    assert.ok((await h.start()).ready);
    fs.rmSync(path.join(h.config, 'legacy-profile'));
    const again = await h.start();
    assert.ok(again.ready, `existing install refused: ${again.stderr}`);
  });
} finally {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
}
if (failures.length) { console.log(`\n${failures.length} FAILED`); process.exit(1); }
console.log('\nlegacy init and first start OK');
