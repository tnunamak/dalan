#!/usr/bin/env node
// Two things stop a worker from using run_check: it cannot tell what a bare check id runs, and a check whose lockfile
// has not been prepared by hand fails with an owner-only recovery command. This test pins both fixes:
// - claim, get and workspace_result describe each runnable check (what it executes, its limit, where it runs);
// - run_check prepares the dependencies of an unchanged pinned lockfile once, and never installs a worker-changed one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'check-adoption-'));
process.env.HOME = home;
const { checkSummary } = await import('../src/projects.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const { resolvePreparedNodeModules, prepareNodeModulesInChild } = await import('../src/prepared-node-modules.mjs');

try {
  // What a check runs, in one line.
  assert.equal(checkSummary({ argv: ['/runtime/node', '--test', 'tests/a.test.mjs'], install_argv: null, timeout_ms: 120000 }), 'node --test tests/a.test.mjs (limit 120 s)');
  assert.equal(checkSummary({ argv: ['npm', 'test'], install_argv: ['npm', 'ci'], timeout_ms: 90500 }), 'npm ci && npm test (limit 91 s)');
  const long = checkSummary({ argv: ['x'.repeat(400)], install_argv: null, timeout_ms: 1000 });
  assert(long.length < 230 && long.includes('...') && long.endsWith('(limit 1 s)'), long);

  // checkDetails: one line per runnable id; an unreadable definition is described as such, never dropped.
  const assignment = { inputs: [{ github_repo: 'example-owner/fixture', base_sha: '0'.repeat(40) }] };
  const specs = { alpha: { argv: ['/runtime/node', 'a.js'], install_argv: null, timeout_ms: 5000 } };
  const base = { checkMetadataFor: () => specs };
  assert.deepEqual(Workspace.prototype.checkDetails.call(base, assignment, 'example-owner/fixture', ['alpha', 'beta'], null, 'dot'),
    { alpha: 'node a.js (limit 5 s)', beta: 'no summary available' });
  const broken = { checkMetadataFor: () => { throw new Error('invalid check metadata'); } };
  assert.deepEqual(Workspace.prototype.checkDetails.call(broken, assignment, 'example-owner/fixture', ['alpha'], null, 'dot'), { alpha: 'no summary available' });

  // Dependency preparation on demand.
  const git = (dir, ...args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, 'repo-')));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.test');
  const manifest = { name: 'adoption-fixture', version: '1.0.0' };
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ ...manifest, lockfileVersion: 3, packages: { '': manifest } }));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  const prepare = (dir) => Workspace.prototype.prepareDependencies.call({}, dir, baseSha);

  assert.throws(() => resolvePreparedNodeModules(repo), { code: 'dependencies_unprepared' }, 'nothing is prepared at first');

  // A worker-changed lockfile is never installed by the bridge.
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ ...manifest, lockfileVersion: 3, packages: { '': { ...manifest, description: 'changed' } } }));
  await prepare(repo);
  assert.throws(() => resolvePreparedNodeModules(repo), { code: 'dependencies_unprepared' }, 'a changed lockfile stays unprepared');
  // A changed manifest likewise.
  git(repo, 'checkout', '-q', '--', 'package-lock.json');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ ...manifest, description: 'changed' }));
  await prepare(repo);
  assert.throws(() => resolvePreparedNodeModules(repo), { code: 'dependencies_unprepared' }, 'a changed manifest stays unprepared');
  git(repo, 'checkout', '-q', '--', 'package.json');

  // The pinned lockfile is prepared once, even when two checks ask at the same moment.
  await Promise.all([prepare(repo), prepare(repo)]);
  const entry = resolvePreparedNodeModules(repo);
  assert(entry?.treePath && fs.existsSync(entry.treePath), 'the pinned lockfile is prepared');
  await prepare(repo); // already prepared: no second install
  assert.equal(resolvePreparedNodeModules(repo).treePath, entry.treePath);
  const store = path.dirname(path.dirname(path.dirname(entry.treePath))); // store/<lock hash>/<runtime key>/node_modules
  assert(store.startsWith(home), 'the store lives under this test home');
  const lockDirs = fs.readdirSync(store).filter(name => !name.startsWith('.'));
  assert.equal(lockDirs.length, 1, `one prepared entry, saw ${lockDirs}`);
  assert.deepEqual(fs.readdirSync(store).filter(name => name.startsWith('.stage-') || name.startsWith('.replaced-')), [], 'no staging or replaced directories remain');

  // Exact bytes, not decoded text: a manifest with U+FFFD in it and the same file with an invalid byte (0x80) in its place decode alike.
  const bytes = fs.realpathSync(fs.mkdtempSync(path.join(home, 'bytes-')));
  git(bytes, 'init', '-q'); git(bytes, 'config', 'user.name', 'Fixture'); git(bytes, 'config', 'user.email', 'fixture@example.test');
  const fffd = Buffer.from(`{"name":"bytes-fixture","version":"1.0.0","description":"\uFFFD"}`, 'utf8');
  const lock = JSON.stringify({ name: 'bytes-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'bytes-fixture', version: '1.0.0' } } });
  fs.writeFileSync(path.join(bytes, 'package.json'), fffd); fs.writeFileSync(path.join(bytes, 'package-lock.json'), lock);
  git(bytes, 'add', '.'); git(bytes, 'commit', '-qm', 'fixture');
  const bytesBase = git(bytes, 'rev-parse', 'HEAD');
  const at = fffd.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
  assert(at > 0);
  fs.writeFileSync(path.join(bytes, 'package.json'), Buffer.concat([fffd.subarray(0, at), Buffer.from([0x80]), fffd.subarray(at + 3)]));
  assert.equal(fs.readFileSync(path.join(bytes, 'package.json'), 'utf8'), fffd.toString('utf8'), 'the two files decode to the same text');
  await Workspace.prototype.prepareDependencies.call({}, bytes, bytesBase);
  assert.throws(() => resolvePreparedNodeModules(bytes), { code: 'dependencies_unprepared' }, 'different bytes are never prepared');

  // A stalled install is killed with its whole process tree and leaves no staging directory; a retry works.
  const stalled = http.createServer(() => {});
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  // The stalled server is the registry host. npm 12 refuses a tarball URL on any other host (allow-remote defaults to none), which would fail at
  // once instead of stalling; a tarball on the registry's own host is installed the same way by npm 11 and 12.
  const stalledRegistry = { ...process.env, npm_config_registry: `http://127.0.0.1:${stalled.address().port}/` };
  const slow = fs.realpathSync(fs.mkdtempSync(path.join(home, 'slow-')));
  const slowManifest = { name: 'slow-fixture', version: '1.0.0', dependencies: { stalled: '1.0.0' } };
  fs.writeFileSync(path.join(slow, 'package.json'), JSON.stringify(slowManifest));
  fs.writeFileSync(path.join(slow, 'package-lock.json'), JSON.stringify({ name: 'slow-fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': slowManifest, 'node_modules/stalled': { version: '1.0.0', resolved: `http://127.0.0.1:${stalled.address().port}/stalled.tgz`, integrity: 'sha512-AAAA' } } }));
  const survivors = () => fs.readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).filter(pid => { try { return fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(home); } catch { return false; } });
  const stages = () => fs.readdirSync(store).filter(name => name.startsWith('.stage-'));
  for (const attempt of [1, 2]) {
    await assert.rejects(prepareNodeModulesInChild(slow, { timeoutMs: 2500, env: stalledRegistry }), { code: 'dependencies_install_failed', message: /timed out/ }, `attempt ${attempt} times out`);
    assert.deepEqual(stages(), [], `attempt ${attempt} leaves no staging directory`);
    assert.deepEqual(survivors(), [], `attempt ${attempt} leaves no process running in the store`);
  }
  stalled.close();

  // No lockfile at all: nothing to prepare, nothing fails.
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(home, 'bare-')));
  await Workspace.prototype.prepareDependencies.call({}, bare, baseSha);
  console.log('PASS check-adoption: check summaries and on-demand pinned dependency preparation');
} finally { fs.chmodSync(home, 0o700); spawnSync('chmod', ['-R', 'u+w', home]); fs.rmSync(home, { recursive: true, force: true }); }
