// A fetch owns a private object store. Publish complete objects before refs so
// reference clones and live worktrees never depend on disposable attempt files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { gitEnv } from './git-env.mjs';

const file = fileURLToPath(import.meta.url);
const guardianFile = fileURLToPath(new URL('./mirror-fetch-lock.py', import.meta.url));
let lockFd;
const inheritedLock = () => lockFd === undefined ? [] : Array.from({ length: lockFd - 2 }, (_, i) => i + 3 === lockFd ? lockFd : 'ignore');
const retention = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'gc.autoDetach=false'];
const corrupt = /unresolved deltas|unpack-objects failed|index-pack failed|missing (?:blob|tree|commit) object|did not send all necessary objects|bad object|is corrupt/i;

export function fetchMirror(mirror, url, env, timeoutMs = 900000, revisions = null, { refetch = false } = {}) {
  if(revisions!==null&&(!Array.isArray(revisions)||!revisions.length||revisions.some(sha=>typeof sha!=='string'||!/^[a-f0-9]{40}$/.test(sha)))) throw new Error('full pinned revisions required');
  const result = spawnSync(process.execPath, [file, '--fetch'], {
    input: JSON.stringify({ mirror, url, timeoutMs, revisions, refetch: refetch === true }), env: gitEnv(env), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  // Repair notices must survive a later fetch failure as well as success.
  for (const line of String(result.stderr || '').split('\n')) {
    if (line.startsWith('mirror repair: ')) console.error(line);
  }
  if (result.error || result.status !== 0) {
    const message = String(result.stderr || result.error?.message || 'fetch supervisor failed').replace(/https:\/\/[^/@\s]+@/g, 'https://<redacted>@');
    throw new Error(`git failed: ${message.slice(0, 1000)}`);
  }
}

function git(args, input) {
  const result = spawnSync('git', [...retention, ...args], { input, stdio: ['pipe', 'pipe', 'pipe', ...inheritedLock()], encoding: 'utf8', timeout: 30000, maxBuffer: 12 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'git failed');
  return result.stdout;
}

async function fetch(args, timeoutMs, state) {
  const mirror = path.dirname(args[1]).slice(0, -'.fetch-lock'.length);
  const child = spawn('python3', [guardianFile, '--anchor', mirror, String(timeoutMs), String(lockFd), 'git', ...retention, ...args], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe', ...inheritedLock()],
  });
  // Keep this pipe open for exactly Node's lifetime. Git cannot inherit it.
  child.stdin.on('error', () => {});
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors = (errors + data).slice(-8192); });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const barrier = spawnSync('python3', [guardianFile, '--settle', mirror], { timeout: 5000, encoding: 'utf8' });
  if (barrier.error || barrier.status !== 0) {
    state.settled = false;
    throw new Error('fetch writers still settling; attempt retained');
  }
  let result;
  try { result = JSON.parse(output); } catch { throw new Error(errors || 'fetch anchor failed'); }
  if (result.timedOut) throw new Error('mirror fetch timed out');
  if (result.code !== 0) throw new Error(result.stderr || `fetch exited ${result.code}`);
}

function publishObjects(source, target) {
  for (const dir of fs.readdirSync(source)) {
    if (dir !== 'pack' && !/^[a-f0-9]{2}$/.test(dir)) continue;
    fs.mkdirSync(path.join(target, dir), { recursive: true });
    for (const name of fs.readdirSync(path.join(source, dir))) {
      if (dir === 'pack' && !/^pack-[a-f0-9]+\.(pack|idx|rev)$/.test(name)) continue;
      if (dir !== 'pack' && !/^[a-f0-9]{38}$/.test(name)) continue;
      try { fs.linkSync(path.join(source, dir, name), path.join(target, dir, name)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
}

// Returns the listing of the refs that remain, in `for-each-ref` format.
function removeMissingRefs(mirror, refs) {
  const entries = refs.split('\n').filter(Boolean).map(line => {
    const match = /^([a-f0-9]{40}) (refs\/[^\t\n]+)\t([^\t\n]*)$/.exec(line);
    if (!match) throw new Error('invalid mirror ref listing');
    return { oid: match[1], ref: match[2], symbolic: Boolean(match[3]), line: match[1] + ' ' + match[2] };
  });
  if (!entries.length) return '';
  const result = git(['-C', mirror, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
    entries.map(entry => entry.oid).join('\n') + '\n').trimEnd().split('\n');
  if (result.length !== entries.length) throw new Error('incomplete mirror object check');
  const missing = new Set();
  const healthy = [];
  entries.forEach((entry, index) => {
    if (result[index] === entry.oid + ' missing') { if (!entry.symbolic) missing.add(entry.ref); }
    else if (new RegExp('^' + entry.oid + ' (commit|tree|blob|tag)$').test(result[index])) healthy.push(entry.line);
    else throw new Error('unexpected mirror object check result');
  });
  if (missing.size) {
    const commands = ['start'];
    for (const entry of entries) if (missing.has(entry.ref)) commands.push(`delete ${entry.ref} ${entry.oid}`);
    commands.push('prepare', 'commit', '');
    git(['-C', mirror, 'update-ref', '--stdin'], commands.join('\n'));
    console.error(`mirror repair: deleted ${missing.size} missing-object refs`);
    for (const ref of [...missing].slice(0, 20)) console.error('mirror repair: deleted missing-object ref ' + JSON.stringify(ref));
    if (missing.size > 20) console.error(`mirror repair: ... and ${missing.size - 20} more`);
  }
  return healthy.length ? healthy.join('\n') + '\n' : '';
}

async function prepare({ mirror, url, timeoutMs, revisions = null, refetch = false }) {
  if(revisions!==null&&(!Array.isArray(revisions)||!revisions.length||revisions.some(sha=>typeof sha!=='string'||!/^[a-f0-9]{40}$/.test(sha)))) throw new Error('full pinned revisions required');
  const deadline=performance.now()+timeoutMs;
  const remaining=()=>{const ms=Math.floor(deadline-performance.now());if(ms<=0)throw new Error('mirror fetch timed out');return ms;};
  const lock = mirror + '.fetch-lock';
  fs.mkdirSync(lock, { mode: 0o700 });
  const state = { settled: true };
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, guardian: process.ppid, mirror }), { mode: 0o600 });
    // A mirror directory that lost HEAD or config is not a repository to git, but its objects and refs are intact.
    // `git init --bare` on an existing directory only adds what is missing, so it repairs the mirror in place.
    if (!fs.existsSync(mirror) || !fs.existsSync(path.join(mirror, 'HEAD')) || !fs.existsSync(path.join(mirror, 'config'))) {
      const repairing = fs.existsSync(mirror);
      git(['init', '--bare', mirror]);
      if (repairing) console.error('mirror repair: re-initialised a mirror without HEAD or config');
    }
    if (git(['-C', mirror, 'remote']).trim().split('\n').includes('origin')) git(['-C', mirror, 'remote', 'remove', 'origin']);
    for (const [key, value] of [['gc.auto', '0'], ['maintenance.auto', 'false'], ['gc.autoDetach', 'false']]) git(['-C', mirror, 'config', '--local', key, value]);
    const stage = path.join(lock, 'repo.git');
    git(['init', '--bare', stage]);
    // Carry bridge-owned settings (notably fetch.unpackLimit) into the attempt.
    // Local retention settings also protect consumers between bridge invocations.
    fs.copyFileSync(path.join(mirror, 'config'), path.join(stage, 'config'));
    fs.writeFileSync(path.join(stage, 'objects/info/alternates'), path.join(mirror, 'objects') + '\n');
    // A ref whose object is missing makes every fetch fail connectivity checks with "bad object".
    // Delete only those refs, in the mirror itself and under the fetch lock: Git also advertises refs
    // from the alternate object store, not only the stage's packed-refs. The fetch below restores
    // whatever the caller needs.
    const refs = removeMissingRefs(mirror, git(['-C', mirror, 'for-each-ref', '--format=%(objectname) %(refname)%09%(symref)']));
    fs.writeFileSync(path.join(stage, 'packed-refs'), '# pack-refs with: sorted\n' + refs);
    // A job names immutable commits, not every branch/tag/PR in the repository.
    // Keep prior refs seeded above; only the requested pins may change here.
    const selection=revisions===null?['--prune',url,'+refs/heads/*:refs/heads/*','+refs/tags/*:refs/tags/*','+refs/pull/*/head:refs/pull/*/head']:['--no-tags',url,...[...new Set(revisions)].map(sha=>`+${sha}:refs/dot-bridge/pins/${sha}`)];
    // refetch: the caller proved the mirror lacks objects under a pin; ignore what it claims to have.
    const args = ['-C', stage, 'fetch', '--no-auto-maintenance', ...(refetch === true ? ['--refetch'] : []), ...selection];
    try { await fetch(args, remaining(), state); }
    catch (error) {
      if (!state.settled || refetch === true || !corrupt.test(error.message)) throw error;
      await fetch([...args.slice(0, 3), '--refetch', ...args.slice(3)], remaining(), state);
    }
    publishObjects(path.join(stage, 'objects'), path.join(mirror, 'objects'));
    const after = git(['-C', stage, 'for-each-ref', '--format=%(objectname) %(refname)']);
    const old = new Map(refs.split('\n').filter(Boolean).map(line => { const [sha, ref] = line.split(' '); return [ref, sha]; }));
    const commands = ['start'];
    for (const line of after.split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(' ');
      commands.push(`update ${ref} ${sha} ${old.get(ref) || '0'.repeat(40)}`); old.delete(ref);
    }
    for (const [ref, sha] of old) commands.push(`delete ${ref} ${sha}`);
    commands.push('prepare', 'commit', '');
    git(['-C', mirror, 'update-ref', '--stdin'], commands.join('\n'));
  } finally {
    if (state.settled) fs.rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] === file && process.argv[2] === '--fetch') {
  const check = spawnSync('python3', [guardianFile, '--check'], { encoding: 'utf8' });
  if (check.error || check.status !== 0) {
    console.error('Mirror fetch requires Python 3.8+ on Linux or macOS. Install Python 3 and put python3 on the bridge service PATH, then retry. ' + (check.stderr || check.error?.message || ''));
    process.exit(1);
  }
  const result = spawnSync('python3', [guardianFile, process.execPath, file], {
    input: fs.readFileSync(0), stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
if (process.argv[1] === file && process.argv[2] === '--owned-fetch') {
  lockFd = Number(process.argv[3]);
  try { await prepare(JSON.parse(fs.readFileSync(0, 'utf8'))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
