import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

test('a dead owner is stale and is taken over', async () => {
  const dir = tmp(), file = path.join(dir, 's.lock');
  plant(file, { pid: await deadPid(), start_time: 'x' });
  const lock = await acquireLock(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, lock.token);
  lock.release(); fs.rmSync(dir, { recursive: true });
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
