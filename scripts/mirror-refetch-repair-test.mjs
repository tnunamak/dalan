#!/usr/bin/env node
// A mirror can hold a pinned commit and lack an object below it. A plain fetch of that pin transfers nothing, because
// the mirror claims to have it. prepareGithubRepo must notice the hole, refetch once and admit the repaired mirror.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

mkdirSync(join(process.env.HOME, '.tmp'), { recursive: true });
const home = mkdtempSync(join(process.env.HOME, '.tmp', 'dalan-bridge-mirror-refetch-'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const src = join(home, 'src');
  git('init', '-q', '-b', 'main', src);
  git('-C', src, 'config', 'user.email', 't@example.com'); git('-C', src, 'config', 'user.name', 't');
  writeFileSync(join(src, 'f.txt'), 'kept\n'); writeFileSync(join(src, 'g.txt'), 'lost\n');
  git('-C', src, 'add', '.'); git('-C', src, 'commit', '-qm', 'a');
  const a = git('-C', src, 'rev-parse', 'HEAD');
  process.env.DOT_BRIDGE_WORKSPACE_ROOT = join(home, 'ws');
  process.env.DOT_BRIDGE_GITHUB_URL_OWNER_REPO = 'file://' + src;
  const { prepareGithubRepo, verifyFetchedCommit, mirrorPath } = await import('../src/projects.mjs');
  const mirror = mirrorPath('owner/repo');
  // pre-create the mirror so the first fetch stores loose objects and one can be removed
  git('init', '-q', '--bare', mirror); git('-C', mirror, 'config', 'fetch.unpackLimit', '100000');
  prepareGithubRepo({ github_repo: 'owner/repo', base_sha: a });
  const blob = git('-C', src, 'rev-parse', 'HEAD:g.txt');
  const loose = join(mirror, 'objects', blob.slice(0, 2), blob.slice(2));
  assert(existsSync(loose), 'blob not loose');
  unlinkSync(loose);
  // the hole is real: verification alone refuses the mirror
  let refused = null;
  try { verifyFetchedCommit(mirror, a, 'base'); } catch (e) { refused = e; }
  assert(refused?.mirrorIncomplete === true && refused.code === 'DOT_BRIDGE_INFRASTRUCTURE', 'verification did not refuse the hole: ' + refused);
  // the same pin again: without a refetch the blob stays missing and admission would fail
  assert(prepareGithubRepo({ github_repo: 'owner/repo', base_sha: a }) === mirror, 'admission failed after refetch');
  assert(git('-C', mirror, 'cat-file', '-t', blob) === 'blob', 'lost blob not restored');
  verifyFetchedCommit(mirror, a, 'base');
  console.log('PASS a mirror missing an object under a pin is refetched once and admitted');
} finally { rmSync(home, { recursive: true, force: true }); }
