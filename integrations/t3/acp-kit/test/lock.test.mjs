import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, LockBusyError, ownerAlive } from '../src/lock.mjs';

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

test('releasing twice leaves the temporary lock directory empty', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-lock-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = await acquireLock(path.join(dir, 's.lock'));
  lock.release();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.doesNotThrow(() => lock.release());
  assert.deepEqual(fs.readdirSync(dir), []);
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
