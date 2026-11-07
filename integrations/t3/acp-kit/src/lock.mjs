// Single-owner session lock that works on Linux and macOS without flock.
//
// The lock is a file created with O_EXCL (open 'wx', mode 0600) that holds JSON { pid, start_time, token, host }.
//   start_time  an opaque string for the owner process's start (Linux: boot id + /proc/<pid>/stat field 22;
//               macOS: `ps -o lstart=`). Two processes with one pid have different start_time values.
//   token       random; release removes the file only while it still holds our token.
//   host        os.hostname(), for messages. Liveness is judged on this machine; the state directory must be local.
// A lock is STALE when its pid is not alive, or the pid is alive with a different start_time (pid reuse). A record that
// cannot be read is stale only when its file is older than UNREADABLE_GRACE_MS (it may be mid-write, or be an empty file
// left by the earlier flock-based adapter).
//
// Race-safe takeover. Naive "unlink the stale file, then create" lets a slow taker unlink a lock that a fast taker just
// created. So a taker first creates a guard file `<lock>.takeover.<key>.<n>` with O_EXCL, where <key> names the stale
// generation it saw (the stale record's token). Under the guard it re-reads the lock; it unlinks only if the file is still
// that same stale generation. Then it creates the lock with O_EXCL. Why this holds:
//  - Only a guard holder deletes a stale lock, and a guard name is created by one process at a time (O_EXCL); a guard is
//    removed only by its creator when done, so two takers are never inside the section for one (key, n).
//  - A guard whose creator is dead is never removed by others; takers move on to n+1. A late taker that reuses a name after
//    the first taker finished re-reads the lock, sees a different generation and backs off.
//  - Lock creation is always O_EXCL, so if a third process creates the lock first, the taker loses and reports busy.
//  - A live owner is never stale, so nobody deletes a live owner's lock; the owner's own release checks the token.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UNREADABLE_GRACE_MS = 3000;

export class LockBusyError extends Error {
  constructor(owner) {
    super(`this session is active in another adapter (pid ${owner?.pid ?? 'unknown'})`);
    this.name = 'LockBusyError';
    this.code = 'session_busy';
    this.pid = owner?.pid ?? null;
  }
}

// ------------------------------------------------------------ process identity
let bootId;
function processStartTime(pid) {
  try {
    if (process.platform === 'linux') {
      bootId ??= fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm may contain spaces and parentheses: fields restart after the last ')'. Field 22 is starttime, the 20th after comm.
      return `${bootId}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    }
  } catch { /* process gone, or no /proc */ }
  return null;
}
const own = { start: undefined };
const ownStartTime = () => own.start === undefined ? (own.start = processStartTime(process.pid)) : own.start;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// Alive and still the same process. An unknown start time on either side falls back to liveness alone.
export function ownerAlive(record) {
  if (!Number.isInteger(record?.pid) || !pidAlive(record.pid)) return false;
  if (!record.start_time) return true;
  const now = processStartTime(record.pid);
  return now === null || now === record.start_time;
}

// ------------------------------------------------------------ reading a lock
// { record, key } for a readable record; { record: null, key } for an unreadable one; null when the file is absent.
// `stale` is decided here so that the caller's re-check under the guard uses the same rule.
function inspect(file) {
  let st;
  try { st = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let record = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed?.token === 'string' && /^[0-9a-f]{8,64}$/.test(parsed.token)) record = parsed;
  } catch { /* unreadable */ }
  if (record) return { record, key: record.token, stale: !ownerAlive(record) };
  return { record: null, key: `u${st.ino}`, stale: Date.now() - st.mtimeMs > UNREADABLE_GRACE_MS };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const held = new Set();
process.once('exit', () => { for (const release of [...held]) release(); });

function createExclusive(file, record) {
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { fs.writeSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
  return true;
}

// Returns true when we removed the stale generation `seen`; false when it changed or a live taker is working on it.
async function takeOver(file, seen, guardWaitMs) {
  const deadline = Date.now() + guardWaitMs;
  const guardBase = `${file}.takeover.${seen.key}`;
  const me = { pid: process.pid, start_time: ownStartTime(), token: randomBytes(8).toString('hex') };
  for (let n = 0; ; n++) {
    const guard = `${guardBase}.${n}`;
    if (!createExclusive(guard, me)) {
      let g = null;
      try { g = JSON.parse(fs.readFileSync(guard, 'utf8')); } catch { /* being written */ }
      const deadGuard = g ? !ownerAlive(g) : Date.now() - (fs.statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > UNREADABLE_GRACE_MS;
      if (deadGuard) continue; // a crashed taker's guard stays; use the next name
      if (Date.now() >= deadline) return false;
      await sleep(5);
      n--; // wait on this guard name until it is released or the deadline passes
      continue;
    }
    try {
      const now = inspect(file);
      if (now && now.key === seen.key && now.stale) fs.rmSync(file, { force: true });
      return true; // the generation we saw is gone (by us, or already replaced); the caller retries creation
    } finally {
      fs.rmSync(guard, { force: true });
    }
  }
}

function cleanupGuards(file, key) {
  const prefix = `${path.basename(file)}.takeover.${key}.`;
  for (const name of fs.readdirSync(path.dirname(file))) {
    if (!name.startsWith(prefix)) continue;
    const guard = path.join(path.dirname(file), name);
    try { if (!ownerAlive(JSON.parse(fs.readFileSync(guard, 'utf8')))) fs.rmSync(guard, { force: true }); } catch { /* leave it */ }
  }
}

// Acquire the lock at `file`. Resolves { token, release } or rejects with LockBusyError while a live owner holds it.
export async function acquireLock(file, { attempts = 8, guardWaitMs = 2000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString('hex');
  const record = { pid: process.pid, start_time: ownStartTime(), token, host: os.hostname() };
  let lastOwner = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (createExclusive(file, record)) {
      const release = () => {
        held.delete(release);
        const now = inspect(file);
        if (now?.record?.token === token) fs.rmSync(file, { force: true });
      };
      held.add(release);
      return { token, release };
    }
    const seen = inspect(file);
    if (!seen) continue; // removed between our create and read: try again
    lastOwner = seen.record;
    if (!seen.stale) throw new LockBusyError(seen.record);
    if (!(await takeOver(file, seen, guardWaitMs))) throw new LockBusyError(seen.record);
    cleanupGuards(file, seen.key);
  }
  throw new LockBusyError(lastOwner);
}
