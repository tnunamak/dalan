import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, LockBusyError, ownerAlive } from '../src/lock.mjs';
import { readJsonPrivate, writeJsonPrivate } from '../src/session-store.mjs';

import { CANCEL_BUDGET_MS, REFUSE_CODE, cancelBudgetMs, createRefuse } from '../src/errors.mjs';

test('bad cancel budgets fall back to the bounded default', () => {
  for (const value of [undefined, '', 'not numeric', 0, -1, Infinity, NaN]) {
    assert.equal(cancelBudgetMs(value), CANCEL_BUDGET_MS);
  }
  assert.equal(cancelBudgetMs('2500'), 2500);
});

test('refusal preserves explicit diagnostic data without inventing data for an omitted argument', () => {
  class FixtureRequestError extends Error {
    constructor(...args) { super(args[1]); this.args = args; }
  }
  const refuse = createRefuse(FixtureRequestError);
  assert.deepEqual(refuse('fixture rejected').args, [REFUSE_CODE, 'fixture rejected']);
  assert.deepEqual(refuse('fixture rejected', null).args, [REFUSE_CODE, 'fixture rejected', null]);
  assert.deepEqual(refuse('fixture rejected', false).args, [REFUSE_CODE, 'fixture rejected', false]);
});

test('an unreadable saved session returns a recovery message and keeps its bytes', {skip: process.platform === 'win32'}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-session-read-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'fixture.json');
  fs.writeFileSync(file, '{broken', {mode: 0o600});
  assert.throws(() => readJsonPrivate(file), {
    code: 'invalid_session_state',
    message: 'Saved session is unreadable; start a new session or restore the saved state.',
  });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('sessionPath preserves a valid emitted UUID and an explicit sidecar suffix', async () => {
  const { sessionPath } = await import('../src/session-store.mjs');
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(sessionPath('fixture dir', id), path.join('fixture dir', id + '.json'));
  assert.equal(sessionPath('fixture dir', id, '.lock'), path.join('fixture dir', id + '.lock'));
});

test('a failed session promotion removes its temporary file and preserves the destination', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-session-rename-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const destination = path.join(dir, 'session.json');
  fs.mkdirSync(destination);
  const existing = path.join(destination, 'keep.txt');
  fs.writeFileSync(existing, 'fixture already present');
  assert.throws(() => writeJsonPrivate(destination, { marker: 'fixture' }));
  assert.equal(fs.readFileSync(existing, 'utf8'), 'fixture already present');
  assert.deepEqual(fs.readdirSync(dir), ['session.json']);
});

test('a partial session write removes its temporary file and preserves the destination', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-session-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const destination = path.join(dir, 'session.json');
  writeJsonPrivate(destination, { marker: 'committed' });
  const temporary = `${destination}.${process.pid}.tmp`;
  const full = new Error('fixture ran out of space');
  full.code = 'ENOSPC';
  const write = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (file, contents, options) => {
    if (file !== temporary) return write(file, contents, options);
    write(file, '{', options);
    throw full;
  });
  try {
    assert.throws(() => writeJsonPrivate(destination, { marker: 'replacement' }), error => error === full);
  } finally {
    mocked.mock.restore();
  }
  assert.deepEqual(readJsonPrivate(destination), { marker: 'committed' });
  assert.deepEqual(fs.readdirSync(dir), ['session.json']);
});

const tmp = () => fs.mkdtempSync(path.join(os.homedir(), '.tmp-acpkit-'));
const worker = path.join(import.meta.dirname, 'lock-worker.mjs');
const deadPid = async () => {
  const c = spawn(process.execPath, ['-e', '']);
  await new Promise(r => c.once('exit', r));
  return c.pid;
};
const plant = (file, record) => fs.writeFileSync(file, JSON.stringify({ token: 'ab'.repeat(8), host: 'x', ...record }), { mode: 0o600 });
const run = (args) => new Promise(resolve => { const c = spawn(process.execPath, [worker, ...args], { stdio: 'inherit' }); c.once('exit', code => resolve(code)); });

test('busy lock names a known synthetic owner without echoing its metadata', () => {
  const error = new LockBusyError({ pid: 314, token: 'fixture-token', start_time: 'fixture-start' });
  assert.equal(error.name, 'LockBusyError');
  assert.equal(error.code, 'session_busy');
  assert.equal(error.pid, 314);
  assert.equal(error.message, 'this session is active in another adapter (pid 314)');
});

test('busy lock with no readable owner keeps the busy code and names no pid', () => {
  const error = new LockBusyError(null);
  assert.equal(error.code, 'session_busy');
  assert.equal(error.pid, null);
  assert.equal(error.message, 'this session is active in another adapter (pid unknown)');
});

test('private JSON pretty mode round-trips and replaces the previous object', async t => {
  const { readJsonPrivate, writeJsonPrivate } = await import('../src/session-store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'subdir', 'session.json');
  writeJsonPrivate(target, { previous: true });
  writeJsonPrivate(target, { fixture: [1, 2] }, { pretty: true });
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify({ fixture: [1, 2] }, null, 2));
  assert.deepEqual(readJsonPrivate(target), { fixture: [1, 2] });
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['session.json']);
});

test('removing private JSON twice leaves the missing-state sentinel', async t => {
  const { readJsonPrivate, removePrivate, writeJsonPrivate } = await import('../src/session-store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'session.json');
  assert.equal(readJsonPrivate(target), null);
  writeJsonPrivate(target, { fixture: true });
  removePrivate(target);
  removePrivate(target);
  assert.equal(readJsonPrivate(target), null);
});

test('acquire writes the record; release removes only our own token', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock');
  const a = await acquireLock(file);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.pid, process.pid); assert.equal(rec.token, a.token); assert.equal(typeof rec.host, 'string');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await assert.rejects(acquireLock(file), LockBusyError);
  fs.writeFileSync(file, JSON.stringify({ ...rec, token: 'cd'.repeat(8) })); // someone else holds it now
  a.release();
  assert.ok(fs.existsSync(file), 'release must not remove a lock that holds another token');
  fs.rmSync(file);
  fs.rmSync(dir, { recursive: true });
});

test('private state reports unreadable JSON without echoing its contents or replacing the file', { skip: process.platform === 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-unreadable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.json');
  const damaged = '{"fixturePrivateText":';
  fs.writeFileSync(file, damaged, { mode: 0o600 });
  assert.throws(() => readJsonPrivate(file), error => {
    assert.equal(error.code, 'invalid_session_state');
    assert.match(error.message, /start a new session or restore/);
    assert.doesNotMatch(error.message, /fixturePrivateText/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
});

test('valid saved state still refuses a nonprivate file and leaves it unchanged', { skip: process.platform === 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-unsafe-mode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.json');
  const saved = '{"fixture":true}';
  fs.writeFileSync(file, saved);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readJsonPrivate(file), { code: 'state_permissions' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
});

test('release frees the lock for the next acquirer', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock');
  (await acquireLock(file)).release();
  assert.ok(!fs.existsSync(file));
  (await acquireLock(file)).release();
  fs.rmSync(dir, { recursive: true });
});

test('an ordinary file in place of the lock parent is left untouched', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-lock-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const obstacle = path.join(dir, 'not-a-directory');
  fs.writeFileSync(obstacle, 'synthetic fixture');
  await assert.rejects(acquireLock(path.join(obstacle, 's.lock')), error =>
    error?.code === 'EEXIST' || error?.code === 'ENOTDIR');
  assert.equal(fs.readFileSync(obstacle, 'utf8'), 'synthetic fixture');
  assert.deepEqual(fs.readdirSync(dir), ['not-a-directory']);
});

test('a stale directory at the lock path remains intact and reports a busy session', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-lock-directory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 's.lock');
  fs.mkdirSync(lock);
  const sentinel = path.join(lock, 'keep.txt');
  fs.writeFileSync(sentinel, 'fixture');
  fs.utimesSync(lock, new Date(0), new Date(0));

  await assert.rejects(acquireLock(lock), error =>
    error instanceof LockBusyError && error.code === 'session_busy' && error.pid === null);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'fixture');
  assert.deepEqual(fs.readdirSync(dir), ['s.lock'], 'no takeover guard is left behind');
});

test('releasing twice leaves the temporary lock directory empty', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-lock-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = await acquireLock(path.join(dir, 's.lock'));
  lock.release();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.doesNotThrow(() => lock.release());
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a serialization error leaves the committed session readable and untouched', {skip: process.platform === 'win32'}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-session-serialize-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'session.json');
  const old = {step: 'saved'};
  writeJsonPrivate(file, old);
  const bytes = fs.readFileSync(file);
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeJsonPrivate(file, circular), TypeError);
  assert.deepEqual(readJsonPrivate(file), old);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(dir), ['session.json']);
});

test('a leftover partial temp file does not change the committed session', {skip: process.platform === 'win32'}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-session-staged-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'session.json');
  const partial = `${file}.${process.pid}.tmp`;
  const committed = {step: 'confirmed'};
  writeJsonPrivate(file, committed);
  fs.writeFileSync(partial, '{"step":', {mode: 0o600});
  assert.deepEqual(readJsonPrivate(file), committed);
  assert.equal(fs.readFileSync(partial, 'utf8'), '{"step":');
  const next = {step: 'continued'};
  writeJsonPrivate(file, next);
  assert.deepEqual(readJsonPrivate(file), next);
  assert.deepEqual(fs.readdirSync(dir), ['session.json']);
});

test('a dead owner is stale and is taken over', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock');
  plant(file, { pid: await deadPid(), start_time: 'x' });
  const lock = await acquireLock(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, lock.token);
  lock.release(); fs.rmSync(dir, { recursive: true });
});

test('owner probes ignore absent or noninteger process references', () => {
  for (const record of [null, {}, {pid:'42'}, {pid:1.5}, {pid:NaN}]) {
    assert.equal(ownerAlive(record), false);
  }
});

test('the current process is live for an older record without a start time', () => {
  assert.equal(ownerAlive({pid:process.pid}), true);
});

test('pid reuse: a live pid with a different start_time is stale; the same start_time is busy', async () => {
  if (!['linux', 'darwin'].includes(process.platform)) return;
  const dir = tmp(), file = path.join(dir, 's.lock');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  try {
    await new Promise(r => setTimeout(r, 100));
    const mine = await acquireLock(path.join(dir, 'probe')); // learn the format for our own pid
    const format = JSON.parse(fs.readFileSync(path.join(dir, 'probe'), 'utf8')).start_time;
    mine.release();
    assert.ok(format, 'start_time must be available on this platform');
    plant(file, { pid: holder.pid, start_time: 'recycled-start' });
    assert.equal(ownerAlive(JSON.parse(fs.readFileSync(file, 'utf8'))), false);
    (await acquireLock(file)).release();
    // The true start time of the live holder: busy.
    const probeFile = path.join(dir, 'holder-probe');
    const rec = await new Promise(resolve => { // ask the holder's start time through a lock it takes itself
      const c = spawn(process.execPath, ['-e', `import('${path.join(import.meta.dirname, '../src/lock.mjs')}').then(async m=>{await m.acquireLock(${JSON.stringify(probeFile)});setTimeout(()=>{},30000)})`]);
      const poll = setInterval(() => { try { const r = JSON.parse(fs.readFileSync(probeFile, 'utf8')); clearInterval(poll); resolve({ r, c }); } catch {} }, 20);
    });
    plant(file, { pid: rec.r.pid, start_time: rec.r.start_time });
    await assert.rejects(acquireLock(file), LockBusyError);
    rec.c.kill();
  } finally { holder.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock contention exposes the owning PID in a stable retry diagnostic', () => {
  const error = new LockBusyError({pid: 2468});
  assert.equal(error.name, 'LockBusyError');
  assert.equal(error.code, 'session_busy');
  assert.equal(error.pid, 2468);
  assert.equal(error.message, 'this session is active in another adapter (pid 2468)');
});

test('lock contention without a readable owner reports busy with an unknown PID', () => {
  const error = new LockBusyError(null);
  assert.equal(error.code, 'session_busy');
  assert.equal(error.pid, null);
  assert.equal(error.message, 'this session is active in another adapter (pid unknown)');
});

test('a fresh partial record reports busy and preserves the incomplete bytes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-partial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.lock');
  const partial = '{"pid":';
  fs.writeFileSync(file, partial);
  await assert.rejects(acquireLock(file), { name: 'LockBusyError', code: 'session_busy', pid: null });
  assert.equal(fs.readFileSync(file, 'utf8'), partial);
  assert.deepEqual(fs.readdirSync(dir), ['session.lock']);
});

test('a lock target that is a fresh directory reports busy without touching it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-directory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.lock');
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'keep.txt'), 'owned test fixture');
  await assert.rejects(acquireLock(file), { name: 'LockBusyError', code: 'session_busy', pid: null });
  assert.deepEqual(fs.readdirSync(file), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(file, 'keep.txt'), 'utf8'), 'owned test fixture');
});

test('an empty file from the old flock adapter is stale; a fresh empty file is busy', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock');
  fs.writeFileSync(file, '', { mode: 0o600 });
  await assert.rejects(acquireLock(file), LockBusyError); // may be mid-write
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  (await acquireLock(file)).release();
  fs.rmSync(dir, { recursive: true });
});

test('a crashed taker leaves a guard; the next taker uses the next guard name', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock');
  const dead = await deadPid(), token = 'ab'.repeat(8);
  plant(file, { pid: dead, start_time: 'x', token });
  fs.writeFileSync(`${file}.takeover.${token}.0`, JSON.stringify({ pid: dead, start_time: 'x', token: 'ee' }), { mode: 0o600 });
  const lock = await acquireLock(file);
  lock.release();
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('takeover')), [], 'dead guards are cleaned after a takeover');
  fs.rmSync(dir, { recursive: true });
});

test('RACE: many processes take over one stale lock at once; never two owners', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock'), log = path.join(dir, 'log');
  const ROUNDS = 6, CHILDREN = 8;
  let winners = 0;
  for (let round = 0; round < ROUNDS; round++) {
    fs.rmSync(log, { force: true });
    plant(file, { pid: await deadPid(), start_time: 'x', token: randomToken() });
    const startAt = Date.now() + 300;
    const codes = await Promise.all(Array.from({ length: CHILDREN }, () => run([file, log, String(startAt), '350'])));
    assert.ok(codes.every(c => c === 0 || c === 3), `unexpected exit codes ${codes}`);
    // Each child tries once and holds 350 ms, longer than the spread of start times: exactly one can win.
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    let inside = 0;
    for (const line of lines) {
      inside += line.startsWith('enter') ? 1 : -1;
      assert.ok(inside <= 1, `two owners at once in round ${round}: ${lines.join(' | ')}`);
    }
    const entered = lines.filter(l => l.startsWith('enter')).length;
    assert.equal(entered, codes.filter(c => c === 0).length);
    assert.ok(entered >= 1, `no taker won in round ${round}`);
    winners += entered;
    assert.ok(!fs.existsSync(file), 'released');
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('takeover')), []);
  }
  console.log(`race: ${ROUNDS} rounds x ${CHILDREN} processes, ${winners} total owners, no overlap`);
  fs.rmSync(dir, { recursive: true });
});

test('RACE: concurrent fresh acquire (no lock file) admits exactly one', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock'), log = path.join(dir, 'log');
  const startAt = Date.now() + 300;
  const codes = await Promise.all(Array.from({ length: 8 }, () => run([file, log, String(startAt), '350'])));
  assert.equal(codes.filter(c => c === 0).length, 1, `codes ${codes}`);
  fs.rmSync(dir, { recursive: true });
});

test('SIGKILL of the owner leaves a lock that the next acquirer takes over', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock'), log = path.join(dir, 'log');
  const c = spawn(process.execPath, [worker, file, log, '0', '30000']);
  await new Promise(r => { const t = setInterval(() => { if (fs.existsSync(log)) { clearInterval(t); r(); } }, 20); });
  await assert.rejects(acquireLock(file), LockBusyError);
  c.kill('SIGKILL'); await new Promise(r => c.once('exit', r));
  (await acquireLock(file)).release();
  fs.rmSync(dir, { recursive: true });
});

const randomToken = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

test('a live lock reports a stable busy code and owner pid', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.lock');
  const lock = await acquireLock(file);
  try {
    await assert.rejects(acquireLock(file), error => {
      assert.ok(error instanceof LockBusyError);
      assert.equal(error.code, 'session_busy');
      assert.equal(error.pid, process.pid);
      return true;
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, lock.token);
  } finally { lock.release(); }
});

test('a fresh truncated lock is protected, then recoverable after the grace window', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-lock-truncated-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.lock');
  const partial = '{"pid":';
  fs.writeFileSync(file, partial, { mode: 0o600 });
  await assert.rejects(acquireLock(file), { code: 'session_busy', pid: null });
  assert.equal(fs.readFileSync(file, 'utf8'), partial);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  const acquired = await acquireLock(file);
  try {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, acquired.token);
    assert.deepEqual(fs.readdirSync(dir), ['session.lock']);
  } finally { acquired.release(); }
});

test('a waiting acquirer gets the lock after the live takeover guard releases', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-lock-guard-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.lock');
  const stale = await deadPid();
  plant(file, { pid: stale });
  const guard = `${file}.takeover.${'ab'.repeat(8)}.0`;
  plant(guard, { pid: process.pid });
  const pending = acquireLock(file, { guardWaitMs: 1000 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, stale);
  assert.ok(fs.existsSync(guard));
  fs.unlinkSync(guard);
  const acquired = await pending;
  try {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, acquired.token);
    assert.deepEqual(fs.readdirSync(dir), ['session.lock']);
  } finally { acquired.release(); }
});

test('a normal adapter exit releases a forgotten lock without a takeover', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-exit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.lock');
  const moduleUrl = new URL('../src/lock.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquireLock } from ${JSON.stringify(moduleUrl)};
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const file = ${JSON.stringify(file)};
    await acquireLock(file);
    assert.ok(fs.existsSync(file));
  `], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(file), false, 'normal exit removes its own lock');
});

test('acquire reports a non-directory ancestor without replacing it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'ordinary-file');
  const file = path.join(blocker, 'nested', 'session.lock');
  fs.writeFileSync(blocker, 'keep this file');

  await assert.rejects(acquireLock(file), { code: 'ENOTDIR' });
  assert.deepEqual(fs.readdirSync(dir), ['ordinary-file']);
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'keep this file');
});

test('new lock directories and files are private on POSIX', {skip: process.platform === 'win32'}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-mode-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const parent = path.join(dir, 'nested');
  const file = path.join(parent, 'session.lock');
  const lock = await acquireLock(file);
  try {
    assert.equal(fs.statSync(parent).mode & 0o077, 0);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally { lock.release(); }
});

test('two session lock paths can be acquired independently by one process', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-paths-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const first = path.join(dir, 'first.lock');
  const second = path.join(dir, 'second.lock');
  const one = await acquireLock(first);
  try {
    const two = await acquireLock(second);
    try {
      assert.ok(fs.existsSync(first));
      assert.ok(fs.existsSync(second));
      one.release();
      assert.equal(fs.existsSync(first), false);
      assert.ok(fs.existsSync(second));
    } finally { two.release(); }
  } finally { one.release(); }
});

test('acquire and release preserve a session path containing spaces and Unicode', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-name-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'résumé α.lock');
  const lock = await acquireLock(file, {attempts: 1});
  try {
    assert.deepEqual(fs.readdirSync(dir), ['résumé α.lock']);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, lock.token);
  } finally { lock.release(); }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('zero installation attempts leave an existing lock owner unchanged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-budget-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'session.lock');
  const lock = await acquireLock(file);
  try {
    const before = fs.readFileSync(file);
    await assert.rejects(acquireLock(file, {attempts: 0}),
      {name: 'LockBusyError', code: 'session_busy'});
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(dir), ['session.lock']);
  } finally { lock.release(); }
});

test('release succeeds when the temporary lock file is already absent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.lock');
  const lock = await acquireLock(file);
  assert.ok(fs.existsSync(file), 'the fixture starts with a real temporary file');
  fs.unlinkSync(file);

  assert.doesNotThrow(() => lock.release());
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('release leaves a replacement of the original fixture directory alone', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-moved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const parent = path.join(dir, 'session');
  const moved = path.join(dir, 'moved');
  const file = path.join(parent, 'session.lock');
  const lock = await acquireLock(file);
  fs.renameSync(parent, moved);
  fs.writeFileSync(parent, 'ordinary replacement file');

  assert.doesNotThrow(() => lock.release());
  assert.equal(fs.readFileSync(parent, 'utf8'), 'ordinary replacement file');
  assert.equal(JSON.parse(fs.readFileSync(path.join(moved, 'session.lock'), 'utf8')).token, lock.token);
});

test('acquire creates missing fixture directories and release keeps the directories', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-nested-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const parent = path.join(dir, 'one', 'two');
  const file = path.join(parent, 'session.lock');
  assert.equal(fs.existsSync(parent), false);
  const lock = await acquireLock(file);
  try {
    assert.deepEqual(fs.readdirSync(parent), ['session.lock']);
  } finally { lock.release(); }
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('a released handle cannot remove a newly acquired lock at the same path', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-reacquire-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.lock');
  const old = await acquireLock(file);
  old.release();

  const current = await acquireLock(file);
  try {
    old.release();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, current.token);
  } finally { current.release(); }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('reusing an existing fixture directory preserves its POSIX mode', { skip: process.platform === 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-lock-mode-existing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const parent = path.join(dir, 'existing');
  fs.mkdirSync(parent);
  fs.chmodSync(parent, 0o750);
  const lock = await acquireLock(path.join(parent, 'session.lock'));
  try { assert.equal(fs.statSync(parent).mode & 0o777, 0o750); }
  finally { lock.release(); }
  assert.equal(fs.statSync(parent).mode & 0o777, 0o750);
});

test('a malformed saved session reports recovery guidance and leaves bytes alone', {skip: process.platform === 'win32'}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-session-malformed-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'session.json');
  const partial = '{"display":"fixture"';
  fs.writeFileSync(file, partial, {mode: 0o600});
  assert.throws(() => readJsonPrivate(file), {
    code: 'invalid_session_state',
    message: 'Saved session is unreadable; start a new session or restore the saved state.',
  });
  assert.equal(fs.readFileSync(file, 'utf8'), partial);
});

test('a saved session with broad access reports the mode and does not return its contents', {skip: process.platform === 'win32'}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpkit-session-permissions-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, '{"display":"fixture"}', {mode: 0o600});
  fs.chmodSync(file, 0o644);
  assert.throws(() => readJsonPrivate(file), {code: 'state_permissions', message: /must be mode 0600 \(found 644\)/});
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});
