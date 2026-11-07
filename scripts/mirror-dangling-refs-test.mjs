#!/usr/bin/env node
// A mirror can hold refs whose objects are gone. Git then fails every fetch with "bad object refs/...", so affected submits can fail with HTTP 503. prepareGithubRepo must delete only direct missing refs, cap repair logging, still fetch
// and verify the pin the job needs, and still refuse a pin the source cannot supply.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

mkdirSync(join(process.env.HOME, '.tmp'), { recursive: true });
const home = mkdtempSync(join(process.env.HOME, '.tmp', 'dalan-mirror-dangling-'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
try {
  const src = join(home, 'source');
  git('init', '-q', '-b', 'main', src);
  git('-C', src, 'config', 'user.email', 't@example.com');
  git('-C', src, 'config', 'user.name', 't');
  writeFileSync(join(src, 'f.txt'), 'first\n');
  git('-C', src, 'add', '.'); git('-C', src, 'commit', '-qm', 'a');
  const a = git('-C', src, 'rev-parse', 'HEAD');
  writeFileSync(join(src, 'f.txt'), 'second\n');
  git('-C', src, 'commit', '-qam', 'b');
  const b = git('-C', src, 'rev-parse', 'HEAD');
  process.env.DOT_BRIDGE_WORKSPACE_ROOT = join(home, 'workspaces');
  process.env.DOT_BRIDGE_GITHUB_URL_OWNER_REPO = 'file://' + src;
  const { prepareGithubRepo, verifyFetchedCommit, mirrorPath } = await import('../src/projects.mjs');
  const mirror = mirrorPath('owner/repo');
  git('init', '-q', '--bare', mirror);
  git('-C', mirror, 'config', 'fetch.unpackLimit', '100000');
  prepareGithubRepo({ github_repo: 'owner/repo', base_sha: a, head_sha: b });

  const pin = sha => 'refs/dot-bridge/pins/' + sha;
  // Healthy refs of every kind the mirror carries. They must survive the repair untouched.
  const kept = ['refs/heads/kept', 'refs/pull/7/head', 'refs/tags/kept', 'refs/tags/z\u00a0', pin(b)];
  for (const ref of kept) git('-C', mirror, 'update-ref', ref, b);
  const tree = git('-C', mirror, 'rev-parse', b + '^{tree}');
  // A commit that exists only in the mirror, referenced by several refs, then deleted from the object store.
  const makeLost = () => {
    const oid = execFileSync('git', ['-C', mirror, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', tree],
      { input: 'mirror-only missing target\n', encoding: 'utf8', timeout: 30000 }).trim();
    const refs = [pin(oid), 'refs/heads/gone-a', 'refs/heads/gone-b', 'refs/pull/8/head', 'refs/pull/9/head'];
    for (const ref of refs) git('-C', mirror, 'update-ref', ref, oid);
    const file = join(mirror, 'objects', oid.slice(0, 2), oid.slice(2));
    assert(existsSync(file), 'fixture target must be a loose object');
    unlinkSync(file);
    return { oid, refs };
  };
  const lost = makeLost();
  // The pin this job needs is also missing from the mirror and present in the source.
  const aFile = join(mirror, 'objects', a.slice(0, 2), a.slice(2));
  assert(existsSync(aFile), 'needed pin commit must be loose');
  unlinkSync(aFile);

  // Negative control: the same real mirror refuses an ordinary pinned fetch, which reproduces the dangling-ref failure.
  let plain = null;
  try { git('-C', mirror, 'fetch', '--no-prune', '--no-tags', 'file://' + src, '+' + a + ':' + pin(a)); }
  catch (error) { plain = String(error.stderr); }
  assert(plain && /bad object|did not send all necessary objects/i.test(plain), 'expected missing-ref fetch failure: ' + plain);

  const notices = [];
  const oldError = console.error;
  console.error = (...args) => notices.push(args.join(' '));
  try { assert(prepareGithubRepo({ github_repo: 'owner/repo', base_sha: a, head_sha: b }) === mirror, 'preparation did not repair'); }
  finally { console.error = oldError; }
  const remaining = git('-C', mirror, 'for-each-ref', '--format=%(refname)').split('\n');
  for (const ref of lost.refs) {
    assert(!remaining.includes(ref), 'dangling ref survived: ' + ref);
    assert(notices.includes('mirror repair: deleted missing-object ref ' + JSON.stringify(ref)), 'missing deletion notice: ' + ref);
  }
  for (const ref of kept) assert(git('-C', mirror, 'rev-parse', ref) === b, 'healthy ref changed: ' + ref);
  for (const ref of kept) assert(!notices.some(line => line.includes(JSON.stringify(ref))), 'healthy ref was reported as deleted: ' + ref);
  assert(git('-C', mirror, 'rev-parse', pin(a)) === a, 'needed pin not restored exactly');
  assert(git('-C', mirror, 'cat-file', '-t', a) === 'commit', 'needed commit not refetched');
  verifyFetchedCommit(mirror, a, 'base'); verifyFetchedCommit(mirror, b, 'head');


  // A symbolic alias must not join its dangling target in the deletion transaction.
  // Parent code queues both and update-ref rejects the duplicate target.
  const alias = 'refs/heads/dangling-alias';
  git('-C', mirror, 'symbolic-ref', alias, pin(a));
  assert(existsSync(aFile), 'symbolic fixture pin must be loose');
  unlinkSync(aFile);
  notices.length = 0;
  console.error = (...args) => notices.push(args.join(' '));
  try { prepareGithubRepo({ github_repo: 'owner/repo', base_sha: a, head_sha: b }); }
  finally { console.error = oldError; }
  assert(git('-C', mirror, 'symbolic-ref', alias) === pin(a), 'repair changed symbolic alias');
  assert(!notices.some(line => line.includes(JSON.stringify(alias))), 'symbolic alias reported deleted');
  assert(git('-C', mirror, 'rev-parse', pin(a)) === a, 'symbolic fixture pin not restored');
  verifyFetchedCommit(mirror, a, 'base');
  // Healthy-alias staging/publication semantics are deliberately outside this repair test.
  git('-C', mirror, 'symbolic-ref', '--delete', alias);

  // Parent code logs all 128 names; repair must emit only 20 plus count and remainder.
  const many = Array.from({ length: 128 }, (_, i) => 'refs/heads/many-' + String(i).padStart(3, '0'));
  for (const ref of many) writeFileSync(join(mirror, ref), lost.oid + '\n');
  notices.length = 0;
  console.error = (...args) => notices.push(args.join(' '));
  try { prepareGithubRepo({ github_repo: 'owner/repo', base_sha: a, head_sha: b }); }
  finally { console.error = oldError; }
  assert(notices.includes('mirror repair: deleted 128 missing-object refs'), 'missing repair count');
  const names = notices.filter(line => line.startsWith('mirror repair: deleted missing-object ref '));
  assert(names.length === 20, 'repair log must contain exactly 20 ref names');
  for (let i = 0; i < 20; i++) assert(names[i] === 'mirror repair: deleted missing-object ref ' + JSON.stringify(many[i]), 'wrong logged ref');
  assert(notices.includes('mirror repair: ... and 108 more'), 'missing repair remainder');
  assert(notices.length === 22, 'repair log was not capped');
  const afterMany = git('-C', mirror, 'for-each-ref', '--format=%(refname)').split('\n');
  for (const ref of many) assert(!afterMany.includes(ref), 'bulk dangling ref survived');
  verifyFetchedCommit(mirror, a, 'base');

  // A pin absent from the source is still refused, never silently admitted after cleanup.
  const absent = makeLost();
  let refused = null;
  try { prepareGithubRepo({ github_repo: 'owner/repo', base_sha: absent.oid }); }
  catch (error) { refused = error; }
  assert(refused?.code === 'DOT_BRIDGE_INVALID_INPUT', 'unfetchable pin was not refused: ' + refused);
  const failedRefs = git('-C', mirror, 'for-each-ref', '--format=%(refname)').split('\n');
  for (const ref of absent.refs) assert(!failedRefs.includes(ref), 'missing ref not cleaned before refused fetch');
  for (const ref of kept) assert(git('-C', mirror, 'rev-parse', ref) === b, 'failed fetch changed healthy ref');
  console.log('PASS dangling pin, branch and PR refs repaired; healthy refs retained; needed pin refetched; unfetchable pin refused');
} finally { rmSync(home, { recursive: true, force: true }); }
