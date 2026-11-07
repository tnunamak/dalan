#!/usr/bin/env node
// Forced process interleavings for the four rejected ownership defects. Hooks live only in this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as files from '../src/as-files.mjs';
import { createAs } from '../src/as.mjs';
import { barrierPreload, armStartBarrier, releaseStartBarrier } from './as-start-barrier.mjs';
import { createLocalJWKSet, jwtVerify } from 'jose';

const self = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const acquire = files.acquireAsOwner ?? files.acquireAsLock; // The older lock-based export name keeps these regressions runnable against earlier code.
if (process.argv[2] === 'child') {
  const [dir, mode] = process.argv.slice(3);
  const block = name => {
    fs.writeFileSync(path.join(dir, name + '.ready'), '');
    while (!fs.existsSync(path.join(dir, name + '.go'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  };
  if (mode === 'rotation-a') {
    const rename = fs.renameSync;
    let held = false;
    fs.renameSync = function (from, to) {
      if (!held && to === files.asFiles(dir).jwks) { held = true; block(mode); } // A has read and computed its prospective write.
      return rename(from, to);
    };
  }
  try {
    if (mode.startsWith('rotation')) { const out = files.rotateKeys(dir); process.send({ rotated: out }); process.exit(0); }
    if (mode === 'server') {
      const as = createAs({ dir, resource: 'http://127.0.0.1:9999/secret/mcp', allowHttp: true, workerNames: () => [] });
      process.send({ owner: true });
      process.on('message', async message => {
        if (message === 'listen') { as.afterListen?.(); process.send({ listened: true }); }
        if (message.issueAt) {
          Date.now = () => message.issueAt;
          const client = new as.provider.Client({ client_id: 'regression', redirect_uris: ['https://vendor.example/cb'], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'ES256' });
          const id = new as.provider.IdToken({ sub: 'owner' }, { client }); id.scope = 'openid';
          process.send({ token: await id.issue({ use: 'idtoken' }) });
        }
      });
    } else {
      const lock = acquire(dir);
      process.send({ owner: true });
      process.on('message', message => { if (message === 'release') { lock.release(); process.exit(0); } });
    }
  } catch (error) { process.send({ refused: error.message }); process.exit(1); }
} else {
  const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'dbowner-'));
  const only = process.env.AS_OWNER_ONLY;
  const children = new Set(), failures = []; let passed = 0;
  const init = name => { const dir = path.join(root, name); files.initAsFiles(dir, { publicUrl: 'http://127.0.0.1:9999', allowHttp: true }); return dir; };
  const bytes = dir => [files.asFiles(dir).jwks, files.asFiles(dir).cookies].map(file => fs.readFileSync(file));
  function child(dir, mode = 'lock', gate) {
    const c = fork(self, ['child', dir, mode], { ...(gate ? { execArgv: ['--import', barrierPreload], env: { ...process.env, AS_START_GATE: gate } } : {}), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.add(c);
    if (gate) armStartBarrier(c);
    c.messages = []; c.stderrText = ''; c.stderr.on('data', b => { c.stderrText += b; });
    c.on('message', message => { if (!message.asStartReady) c.messages.push(message); }); c.on('exit', () => children.delete(c));
    return c;
  }
  async function until(predicate, label) { for (let i = 0; i < 500; i++) { if (predicate()) return; await sleep(10); } throw new Error('timeout: ' + label); }
  const result = async c => { await until(() => c.messages.length || c.exitCode !== null, 'child result'); return c.messages[0] ?? { refused: c.stderrText }; };
  const stop = async (c, signal = 'SIGKILL') => { if (c.exitCode === null && c.signalCode === null) { const done = new Promise(resolve => c.once('exit', resolve)); c.kill(signal); await done; } };
  const go = (dir, name) => fs.writeFileSync(path.join(dir, name + '.go'), '');
  async function check(id, name, fn) { if (only && !only.split(',').includes(id)) return; try { await fn(); passed++; console.log(`PASS ${id} ${name}`); } catch (error) { failures.push(id); console.log(`FAIL ${id} ${name}: ${error.message}`); } }
  try {
    await check('O1', 'startup racing rotation cannot retire the loaded live signer (r3 defect 1)', async () => {
      const dir = init('startup'), oldKid = files.loadKeys(dir).signingKid;
      const a = child(dir, 'server'); assert.equal((await result(a)).owner, true);
      const before = bytes(dir), b = child(dir, 'rotation'); const outcome = await result(b);
      if (outcome.rotated) {
        a.send('listen'); await until(() => a.messages.some(m => m.listened), 'afterListen');
        const stamp = JSON.parse(fs.readFileSync(files.asFiles(dir).jwks)).retired[oldKid];
        // Advance only the test child's clock. It really issues with its loaded signer just before retention ends.
        const issueAt = Math.ceil((stamp + files.JWKS_RETAIN_MS) / 1000) * 1000 - 1000;
        a.send({ issueAt }); await until(() => a.messages.some(m => m.token), 'live ID token');
        const token = a.messages.find(m => m.token).token, pruneAt = issueAt + 1000;
        const verified = await jwtVerify(token, createLocalJWKSet({ keys: files.loadKeys(dir).jwks.keys.map(({ d, ...publicKey }) => publicKey) }), { currentDate: new Date(pruneAt) });
        assert.equal(verified.payload.exp - verified.payload.iat, 600);
        assert.equal(verified.payload.exp - pruneAt / 1000, 599);
        await stop(a);
        files.pruneKeys(dir, pruneAt);
        const retained = files.loadKeys(dir).jwks.keys.some(k => k.kid === oldKid);
        assert.equal(retained, true, 'live signer pruned with 599 seconds of ID-token lifetime left');
      }
      assert.match(outcome.refused, /stop the bridge, rotate, start/);
      assert.deepEqual(bytes(dir), before); await stop(a);
    });
    await check('O2', 'shared start barrier gives exactly one owner in every trial', async () => {
      const trials = Number(process.env.AS_OWNER_TRIALS ?? 4), count = Number(process.env.AS_STARTERS ?? 2);
      const totals = { trials, starters: count, zero: 0, one: 0, multiple: 0 };
      for (let trial = 0; trial < trials; trial++) {
        const dir = init('takeover-' + trial), gate = path.join(dir, 'start.go'), before = bytes(dir);
        fs.writeFileSync(path.join(dir, 'as.lock'), JSON.stringify({ pid: 2147483647, started_at: '2000-01-01T00:00:00Z' }), { mode: 0o600 });
        const contenders = Array.from({ length: count }, () => child(dir, 'lock', gate));
        try {
          await releaseStartBarrier(contenders, gate);
          const outcomes = await Promise.all(contenders.map(result));
          const owners = outcomes.filter(r => r.owner).length;
          totals[owners === 0 ? 'zero' : owners === 1 ? 'one' : 'multiple']++;
          for (const outcome of outcomes.filter(r => r.refused)) assert.match(outcome.refused, /ownership unavailable|already owns/);
          assert.deepEqual(bytes(dir), before);
        } finally { for (const c of contenders) await stop(c); }
      }
      console.log('BARRIER O2 ' + JSON.stringify(totals));
      assert.equal(totals.one, trials, JSON.stringify(totals));
    });
    await check('O3', 'a paused rotation cannot lose another completed rotation key (r3 defect 3)', async () => {
      const dir = init('rotation'), a = child(dir, 'rotation-a');
      await until(() => fs.existsSync(path.join(dir, 'rotation-a.ready')), 'rotation A prospective write');
      const before = bytes(dir);
      // Force the old 10s expiry without slowing the suite or depending on scheduler luck.
      const oldLock = path.join(dir, 'as-keys.lock'); if (fs.existsSync(oldLock)) fs.utimesSync(oldLock, new Date(0), new Date(0));
      const b = child(dir, 'rotation-b'), outcome = await result(b);
      go(dir, 'rotation-a'); const aResult = await result(a); assert.ok(aResult.rotated);
      if (outcome.rotated) assert.ok(files.loadKeys(dir).jwks.keys.some(k => k.kid === outcome.rotated.signing_kid), 'completed rotation B key lost when paused A resumed');
      assert.match(outcome.refused, /stop the bridge, rotate, start/);
      assert.equal(JSON.parse(before[0]).keys.length, 1); assert.equal(files.loadKeys(dir).jwks.keys.length, 2);
    });
    await check('O4', 'a reused pid cannot block recovery (r3 defect 4)', async () => {
      const dir = init('pid-reuse');
      fs.writeFileSync(path.join(dir, 'as.lock'), JSON.stringify({ pid: process.pid, started_at: '2000-01-01T00:00:00Z' }), { mode: 0o600 });
      const a = child(dir); assert.equal((await result(a)).owner, true, JSON.stringify(a.messages)); await stop(a);
    });
    for (const signal of ['SIGKILL', 'SIGTERM']) await check('O5-' + signal, `${signal} releases ownership for the next starter`, async () => {
      const dir = init(signal), a = child(dir); assert.equal((await result(a)).owner, true);
      await stop(a, signal);
      assert.equal(fs.existsSync(path.join(dir, 'as.lock')), false, 'terminated owner left a pid lock behind');
      const b = child(dir); assert.equal((await result(b)).owner, true); await stop(b);
    });
    await check('O7', 'failed same-process acquisition cannot release the existing kernel lock', async () => {
      const dir = init('same-process'), owner = acquire(dir);
      try {
        for (let i = 0; i < 3; i++) {
          const began = performance.now();
          assert.throws(() => acquire(dir), /ownership unavailable/);
          assert.ok(performance.now() - began >= 450, 'contention must wait for the busy timeout');
        }
        const other = child(dir); assert.match((await result(other)).refused, /ownership unavailable|already owns/);
        assert.equal(fs.statSync(path.join(dir, 'as-owner.sqlite')).mode & 0o777, 0o600);
      } finally { owner.release(); }
      assert.throws(() => owner.pruneKeys(), /released/);
      const next = child(dir); assert.equal((await result(next)).owner, true); await stop(next);
    });
    await check('O8', 'only acquireAsOwner may access the owner path; no pid locks or lifecycle stamps remain', async () => {
      const sourceRoot = new URL('../', import.meta.url);
      for (const folder of ['src', 'bin']) {
        for (const name of fs.readdirSync(new URL(folder, sourceRoot), { recursive: true }).filter(name => /\.(mjs|js|c|py|sh)$/.test(name))) {
          let source = fs.readFileSync(new URL(folder + '/' + name, sourceRoot), 'utf8');
          if (folder === 'src' && name === 'as-files.mjs') {
            const start = source.indexOf('export function acquireAsOwner('), end = source.indexOf('\n}\n', start) + 3;
            assert.ok(start >= 0 && end > start + 3);
            source = source.slice(0, start) + source.slice(end);
          }
          assert.doesNotMatch(source, /as-owner\.sqlite|asFiles\([^)]*\)\.owner/, folder + '/' + name);
          if (folder === 'src' && ['as-files.mjs', 'as.mjs', 'server.mjs'].includes(name)) assert.doesNotMatch(source, /process\.kill|as\.lock|as-keys\.lock|withKeyFiles|stampRetired|afterListen|acquireAsLock/, name);
        }
      }
      assert.equal(Object.hasOwn(files.asFiles(root), 'owner'), false, 'owner path must not escape in the public file map');
    });
    await check('O10', 'Linux rejects NFS, SMB/CIFS and FUSE before opening or changing files', async () => {
      if (process.platform !== 'linux') { console.log('NOTE O10 Linux statfs guard only; macOS local-filesystem requirement is documented'); return; }
      const dir = init('filesystem'), statfs = fs.statfsSync, before = fs.readdirSync(dir).sort();
      try {
        for (const type of [0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546]) {
          fs.statfsSync = () => ({ type });
          assert.throws(() => acquire(dir), /local filesystem/);
          assert.deepEqual(fs.readdirSync(dir).sort(), before);
        }
      } finally { fs.statfsSync = statfs; }
    });
    await check('O11', 'closing descriptors in a launcher child preserves the bridge parent ownership', async () => {
      const dir = init('child-fds'), owner = acquire(dir);
      try {
        const closed = spawnSync(process.execPath, ['--input-type=module', '-e', "import fs from 'node:fs'; for(let fd=3;fd<256;fd++) try { fs.closeSync(fd); } catch {} process.kill(process.pid,'SIGKILL');"], { stdio: 'ignore' });
        assert.equal(closed.signal, 'SIGKILL');
        const other = child(dir); assert.match((await result(other)).refused, /ownership unavailable/);
      } finally { owner.release(); }
      const next = child(dir); assert.equal((await result(next)).owner, true); await stop(next);
    });
    await check('O12', '8-key refusal identifies legacy null entries and manual recovery preserves retention', async () => {
      const dir = init('legacy'), names = files.asFiles(dir);
      for (let i = 0; i < 7; i++) files.rotateKeys(dir);
      const j = JSON.parse(fs.readFileSync(names.jwks)), c = JSON.parse(fs.readFileSync(names.cookies));
      for (const kid of Object.keys(j.retired)) j.retired[kid] = null;
      c.keys.forEach((e, i) => { if (i) e.retired_at = null; });
      fs.writeFileSync(names.jwks, JSON.stringify(j)); fs.writeFileSync(names.cookies, JSON.stringify(c));
      const before = bytes(dir), kid = Object.keys(j.retired)[0];
      assert.throws(() => files.rotateKeys(dir, { cookies: false }), error => error.message.includes('legacy unstamped signing kids:') && error.message.includes(kid));
      assert.throws(() => files.rotateKeys(dir, { jwks: false }), /legacy unstamped cookie positions: 1, 2/);
      assert.deepEqual(bytes(dir), before);
      // The operations guide's recovery: under ownership, start a fresh conservative retention window for null stamps.
      const owner = acquire(dir), at = Date.now();
      try {
        files.loadKeys(dir);
        for (const kid of Object.keys(j.retired)) j.retired[kid] ??= at;
        c.keys.forEach((e, i) => { if (i) e.retired_at ??= at; });
        files.writeAtomic(names.jwks, JSON.stringify(j)); files.writeAtomic(names.cookies, JSON.stringify(c));
        owner.pruneKeys(at + files.COOKIE_RETAIN_MS - 1);
        assert.equal(files.loadKeys(dir).cookieKeys.length, 8);
        owner.pruneKeys(at + files.COOKIE_RETAIN_MS);
        assert.equal(files.loadKeys(dir).cookieKeys.length, 1);
      } finally { owner.release(); }
    });
    await check('O9', 'rotation samples retirement only after acquiring ownership', async () => {
      const dir = init('rotation-clock'), old = files.loadKeys(dir), at = Date.now();
      const realNow = Date.now, stat = fs.lstatSync;
      let clock = at;
      try {
        Date.now = () => clock;
        fs.lstatSync = function (file, ...args) {
          const value = stat.call(this, file, ...args);
          if (file === path.join(dir, 'as-owner.sqlite')) clock = at + 1200000;
          return value;
        };
        files.rotateKeys(dir);
      } finally { Date.now = realNow; fs.lstatSync = stat; }
      assert.equal(JSON.parse(bytes(dir)[0]).retired[old.signingKid], at + 1200000);
      assert.equal(JSON.parse(bytes(dir)[1]).keys[1].retired_at, at + 1200000);
    });
    await check('O6', 'retention starts at rotation and prunes exactly at each full lifetime plus skew', async () => {
      const dir = init('retention'), old = files.loadKeys(dir), at = Date.now();
      files.rotateKeys(dir, {}, at);
      const j = JSON.parse(fs.readFileSync(files.asFiles(dir).jwks)), c = JSON.parse(fs.readFileSync(files.asFiles(dir).cookies));
      assert.equal(j.retired[old.signingKid], at); assert.equal(c.keys[1].retired_at, at);
      const owner = acquire(dir);
      try {
        const prune = now => owner.pruneKeys(now);
        prune(at + files.JWKS_RETAIN_MS - 1); assert.equal(files.loadKeys(dir).jwks.keys.length, 2);
        prune(at + files.JWKS_RETAIN_MS); assert.equal(files.loadKeys(dir).jwks.keys.length, 1); assert.equal(files.loadKeys(dir).cookieKeys.length, 2);
        prune(at + files.COOKIE_RETAIN_MS - 1); assert.equal(files.loadKeys(dir).cookieKeys.length, 2);
        prune(at + files.COOKIE_RETAIN_MS); assert.equal(files.loadKeys(dir).cookieKeys.length, 1);
      } finally { owner.release(); }
    });
  } finally { for (const c of [...children]) await stop(c); fs.rmSync(root, { recursive: true, force: true }); }
  console.log(`RESULT ${JSON.stringify({ PASS: passed, FAIL: failures.length })}`);
  process.exitCode = failures.length ? 1 : 0;
}
