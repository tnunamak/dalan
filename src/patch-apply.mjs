// Apply a worker build patch to a checkout, or observe a matching tree. Used by `dalan apply` and by the ACP
// adapter's read-only check. Nothing here talks to the bridge.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const git = (dir, args, input, env) => spawnSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });

// git apply from a subdirectory can silently skip root-relative paths.
function worktreeRoot(dir, env) {
  const root = git(dir, ['rev-parse', '--show-toplevel'], undefined, env);
  return root.status === 0 ? root.stdout.replace(/\r?\n$/, '') : null;
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

// Checks the digest, the base and `git apply --check`, then applies. Preflight failures touch nothing; a failed apply
// process may have partially changed the checkout. Returns Git's NUL-delimited list of touched file names.
export function applyPatch({ dir, patch, sha256, baseSha, env }) {
  const body = Buffer.from(patch);
  if (sha256 && createHash('sha256').update(body).digest('hex') !== sha256) throw new Error('patch sha256 does not match the recorded evidence; not applied');
  const problem = baseProblem(dir, baseSha, env);
  if (problem) throw new Error(`not applied: ${problem}`);
  dir = worktreeRoot(dir, env);
  if (!dir) throw new Error('not applied: could not resolve the repository worktree top level');
  const check = git(dir, ['apply', '--check', '-'], body, env);
  if (check.status !== 0) throw new Error(`not applied: git apply --check failed: ${(check.stderr || '').trim().slice(0, 300)}`);
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
  const run = git(dir, ['apply', '-'], body, env);
  if (run.status !== 0) throw new Error(`git apply failed after a clean check; the checkout may be partially changed: ${(run.stderr || '').trim().slice(0, 300)}`);
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
