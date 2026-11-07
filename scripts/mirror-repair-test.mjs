#!/usr/bin/env node
// A mirror that lost an object fails every later fetch ("unresolved deltas left after unpacking": the server's thin pack
// deltas against the blob the mirror claims to have). prepareGithubRepo repairs it in place with --refetch, and a live
// worktree of the mirror keeps working.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

mkdirSync(join(process.env.HOME, '.tmp'), { recursive: true });
const home = mkdtempSync(join(process.env.HOME, '.tmp', 'dalan-bridge-mirror-repair-'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const src = join(home, 'src');
  git('init', '-q', '-b', 'main', src);
  git('-C', src, 'config', 'user.email', 't@example.com'); git('-C', src, 'config', 'user.name', 't');
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i} of a file large enough to be sent as a delta`).join('\n');
  writeFileSync(join(src, 'f.txt'), big + '\n'); git('-C', src, 'add', '.'); git('-C', src, 'commit', '-qm', 'a');
  const a = git('-C', src, 'rev-parse', 'HEAD');
  process.env.DOT_BRIDGE_WORKSPACE_ROOT = join(home, 'ws');
  process.env.DOT_BRIDGE_GITHUB_URL_OWNER_REPO = 'file://' + src;
  const { prepareGithubRepo, mirrorPath } = await import('../src/projects.mjs');
  const mirror = mirrorPath('owner/repo');
  // pre-create the mirror so the first fetch stores loose objects and one can be removed
  git('init', '-q', '--bare', mirror); git('-C', mirror, 'config', 'fetch.unpackLimit', '100000');
  prepareGithubRepo({ github_repo: 'owner/repo', base_sha: a });
  const blob = git('-C', src, 'rev-parse', 'HEAD:f.txt');
  const loose = join(mirror, 'objects', blob.slice(0, 2), blob.slice(2));
  assert(existsSync(loose), 'blob not loose');
  unlinkSync(loose);
  // a worktree of the mirror is live while it is broken and repaired
  const wt = join(home, 'wt'); git('-C', mirror, 'worktree', 'add', '-q', '--detach', '--no-checkout', wt, a);
  writeFileSync(join(src, 'f.txt'), big + '\nchanged\n'); git('-C', src, 'commit', '-qam', 'b');
  const b = git('-C', src, 'rev-parse', 'HEAD');
  // fail without the repair: a plain fetch into the broken mirror errors
  let plain = null;
  try { git('-C', mirror, 'fetch', '-q', 'file://' + src, '+refs/heads/*:refs/heads/*'); } catch (e) { plain = String(e.stderr); }
  assert(plain && /unresolved deltas|unpack-objects failed|index-pack failed|did not send all necessary objects|missing/i.test(plain), 'plain fetch did not fail as in production: ' + plain);
  prepareGithubRepo({ github_repo: 'owner/repo', base_sha: b });
  git('-C', mirror, 'fsck', '--connectivity-only');
  assert(git('-C', mirror, 'cat-file', '-t', blob) === 'blob', 'lost blob not restored');
  assert(git('-C', wt, 'rev-parse', 'HEAD') === a, 'worktree broken by the repair');
  // a mirror directory emptied of files (HEAD and config included) is not a repository to git: re-initialise it in place
  // Age-based temp cleaners delete every old file and leave the empty directory skeleton, so remove all files, not just two.
  const wipe = dir => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (lstatSync(p).isDirectory()) wipe(p); else unlinkSync(p); } };
  wipe(mirror);
  let notRepo = null;
  try { git('-C', mirror, 'config', '--local', 'gc.auto', '0'); } catch (e) { notRepo = String(e.stderr); }
  assert(notRepo && /not a git repository|inside a git repository/.test(notRepo), 'fixture is not a broken mirror: ' + notRepo);
  prepareGithubRepo({ github_repo: 'owner/repo', base_sha: b });
  assert(existsSync(join(mirror, 'HEAD')) && existsSync(join(mirror, 'config')), 'HEAD/config not restored');
  assert(git('-C', mirror, 'rev-parse', '--is-bare-repository') === 'true', 'mirror is not a bare repository after repair');
  assert(git('-C', mirror, 'cat-file', '-t', b) === 'commit', 'pinned revision missing after repair');
  console.log('PASS an emptied mirror directory is re-initialised in place and the fetch succeeds');
  console.log('PASS a mirror missing an object is refetched in place; the fetch succeeds and a live worktree survives');
} finally { rmSync(home, { recursive: true, force: true }); }
