// Apply a worker build patch to a checkout, or observe a matching tree. Used by `dalan apply` and by the ACP
// adapter's read-only check. Nothing here talks to the bridge.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const git = (dir, args, input, env) => spawnSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });

const materializeName = '[A-Za-z0-9][A-Za-z0-9_.-]*';
const materializeRepo = new RegExp('^' + materializeName + '/' + materializeName + '$');
const materializeEntry = new RegExp('^(?:org:' + materializeName + '|repo:' + materializeName + '/' + materializeName + ')$');
const grantError = (local_code, message) => Object.assign(new Error(local_code + ': ' + message), {local_code});

export function readMaterializeGrant(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw grantError('materialize_grant_unsafe', 'cannot safely open the owner grant file');
  }
  try {
    const state = fs.fstatSync(fd);
    if (!state.isFile() || typeof process.getuid !== 'function' || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o600) {
      throw grantError('materialize_grant_unsafe', 'the owner grant must be a regular owner-owned mode 0600 file');
    }
    let parsed;
    try {
      if (state.size > 16 * 1024) throw new Error('too large');
      parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
      throw grantError('materialize_grant_invalid', 'expected a small JSON grant document');
    }
    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length !== 2 ||
        !['standing', 'per_pr'].includes(parsed.mode) || !Array.isArray(parsed.grant) ||
        !parsed.grant.every(entry => typeof entry === 'string' && materializeEntry.test(entry))) {
      throw grantError('materialize_grant_invalid', 'expected mode standing or per_pr and exact org: or repo: entries');
    }
    return parsed;
  } finally { fs.closeSync(fd); }
}

export function materializeDecision(grant, repo, requestId) {
  if (typeof repo !== 'string' || !materializeRepo.test(repo) || !/^[-\w]{8,128}$/.test(requestId)) {
    throw grantError('materialize_result_invalid', 'expected one exact repository and a valid request ID');
  }
  const [org] = repo.toLowerCase().split('/');
  const eligible = !!grant?.grant.some(entry => ['org:' + org, 'repo:' + repo.toLowerCase()].includes(entry.toLowerCase()));
  const push = eligible && grant.mode === 'standing';
  const needs_approval = eligible && grant.mode === 'per_pr';
  return { push, draft_pr: push, needs_approval, branch: 'dalan/' + requestId,
    reason: push ? 'standing_grant' : needs_approval ? 'per_pr_approval_required' : 'no_standing_grant' };
}


// git apply from a subdirectory can silently skip root-relative paths.
export function worktreeRoot(dir, env) {
  const root = git(dir, ['rev-parse', '--show-toplevel'], undefined, env);
  return root.status === 0 ? root.stdout.replace(/\r?\n$/, '') : null;
}

// What the patch can touch, read before it runs: each named file's bytes, mode or link target, or its absence, and the
// directories that do not exist yet (a new file may create them).
function snapshot(root, files) {
  const entries = [], newDirs = new Set();
  for (const file of new Set(files)) {
    const target = path.join(root, file);
    let stat = null;
    try { stat = fs.lstatSync(target); } catch {}
    if (!stat) {
      entries.push({ target, absent: true });
      for (let parent = path.dirname(target); parent.startsWith(root + path.sep) && !fs.existsSync(parent); parent = path.dirname(parent)) newDirs.add(parent);
    } else if (stat.isSymbolicLink()) entries.push({ target, link: fs.readlinkSync(target) });
    else if (stat.isFile()) entries.push({ target, data: fs.readFileSync(target), mode: stat.mode & 0o7777 });
    else entries.push({ target, opaque: true });
  }
  return { entries, newDirs: [...newDirs].sort((a, b) => b.length - a.length) };
}

// Puts every snapshotted file back. A file that already equals its snapshot is not rewritten, so a read-only directory
// that stopped the patch does not stop the restore. Returns the names it could not restore.
function restore(snap) {
  const failed = [];
  for (const entry of snap.entries) {
    try {
      let now = null;
      try { now = fs.lstatSync(entry.target); } catch {}
      if (entry.absent) { if (now) fs.rmSync(entry.target, { recursive: true, force: true }); }
      else if (entry.link !== undefined) {
        if (now?.isSymbolicLink() && fs.readlinkSync(entry.target) === entry.link) continue;
        if (now) fs.rmSync(entry.target, { force: true });
        fs.symlinkSync(entry.link, entry.target);
      } else if (entry.data) {
        if (now?.isFile() && (now.mode & 0o7777) === entry.mode && fs.readFileSync(entry.target).equals(entry.data)) continue;
        if (now) fs.rmSync(entry.target, { force: true });
        fs.mkdirSync(path.dirname(entry.target), { recursive: true });
        fs.writeFileSync(entry.target, entry.data, { mode: entry.mode }); fs.chmodSync(entry.target, entry.mode);
      }
    } catch { failed.push(path.basename(entry.target)); }
  }
  for (const dir of snap.newDirs) { try { fs.rmdirSync(dir); } catch {} }
  return failed;
}

// The patch must apply onto the job's base or a descendant of it, so HEAD has to contain base. Returns null when it does,
// else the reason in one sentence.
export function baseProblem(dir, baseSha, env) {
  if (!/^[0-9a-f]{40,64}$/.test(baseSha ?? '')) return 'the job records no base commit';
  const head = git(dir, ['rev-parse', '--verify', 'HEAD'], undefined, env);
  if (head.status !== 0) return `${dir} is not a git checkout with a HEAD`;
  const known = git(dir, ['cat-file', '-e', `${baseSha}^{commit}`], undefined, env);
  if (known.status !== 0) return `base ${baseSha.slice(0, 12)} is not in this checkout; use a checkout that already contains it`;
  const anc = git(dir, ['merge-base', '--is-ancestor', baseSha, 'HEAD'], undefined, env);
  if (anc.status === 1) return `base ${baseSha.slice(0, 12)} is not an ancestor of HEAD ${head.stdout.trim().slice(0, 12)}; the patch was built on a different line of history`;
  return anc.status === 0 ? null : `could not compare base and HEAD: ${anc.stderr.trim()}`;
}

// The files a patch names, renames as old and new, read from the patch alone (no check against the tree).
export function listPatchFiles(dir, body, env) {
  const numstat = git(dir, ['apply', '--numstat', '-z', '-'], body, env);
  if (numstat.error || numstat.status !== 0) throw new Error(`git apply --numstat failed: ${(numstat.stderr || numstat.error?.message || '').trim().slice(0, 300)}`);
  const records = numstat.stdout.split('\0');
  const files = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const firstTab = record.indexOf('\t'), secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error('git apply --numstat returned an invalid path record');
    const file = record.slice(secondTab + 1);
    if (file) files.push(file);
    else {
      const oldPath = records[index + 1], newPath = records[index + 2];
      if (!oldPath || !newPath) throw new Error('git apply --numstat returned an incomplete rename record');
      files.push(oldPath, newPath);
      index += 2;
    }
  }
  return files;
}

// Checks the digest, the base and `git apply --check`, then applies. Preflight failures touch nothing; a failed apply
// process restores the files it touched (a restore that itself fails is named in the error). Returns the list of touched file names. With checkOnly, it stops after
// the checks and the file list and writes nothing, so a caller can take an authorization between the check and the write.
export function applyPatch({ dir, patch, sha256, baseSha, env, checkOnly = false }) {
  const body = Buffer.from(patch);
  if (sha256 && createHash('sha256').update(body).digest('hex') !== sha256) throw new Error('patch sha256 does not match the recorded evidence; not applied');
  const problem = baseProblem(dir, baseSha, env);
  if (problem) throw new Error(`not applied: ${problem}`);
  dir = worktreeRoot(dir, env);
  if (!dir) throw new Error('not applied: could not resolve the repository worktree top level');
  const check = git(dir, ['apply', '--check', '-'], body, env);
  if (check.status !== 0) throw new Error(`not applied: git apply --check failed: ${(check.stderr || '').trim().slice(0, 300)}`);
  const files = listPatchFiles(dir, body, env);
  if (checkOnly) return files;
  // git apply checks everything first but writes file by file, so a write error can leave some files changed. Keep what it
  // may touch and put it back on any failure: the tree is the one it was, or the error names what could not be restored.
  const before = snapshot(dir, files);
  const run = git(dir, ['apply', '-'], body, env);
  if (run.status !== 0) {
    const failed = restore(before), reason = (run.stderr || run.error?.message || '').trim().slice(0, 300);
    throw new Error(failed.length
      ? `git apply failed after a clean check, and ${failed.join(', ')} could not be restored; the checkout is partially changed: ${reason}`
      : `git apply failed after a clean check; every touched file was restored to its earlier content: ${reason}`);
  }
  return files;
}

// Read-only reverse-applicability check. A match does not establish who applied
// the change, its origin or its value. Empty patches never count as a match.
export function patchMatchesWorktree(dir, patch) {
  const body = Buffer.from(patch);
  if (!body.length) return false;
  dir = worktreeRoot(dir);
  if (!dir) return false;
  return git(dir, ['apply', '--check', '--reverse', '-'], body).status === 0;
}

// Observe reverse applicability once per remembered patch. This cannot identify who
// applied a change or whether it was useful, and never records an owner decision.
export async function detectPresentPatches(builds, cwd, { fetchPatch, onError = () => {} }) {
  const done = [];
  for (const b of builds.filter(x => !x.observed)) {
    try {
      const patch = cwd ? await fetchPatch(b) : null;
      if (!patch || !patchMatchesWorktree(cwd, patch)) continue;
      b.observed = true;
      done.push(b.rid);
    } catch (e) { onError(b, e); }
  }
  return done;
}
