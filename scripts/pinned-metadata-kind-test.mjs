#!/usr/bin/env node
// Pinned discovery must obey the same regular-file policy as discovery from a checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const temp = new URL('../.test-home/', import.meta.url);
fs.mkdirSync(temp, { recursive: true });
const home = fs.mkdtempSync(path.join(temp.pathname, 'pinned-metadata-'));
process.env.HOME = home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'work');
process.env.DOT_BRIDGE_CHECKS_FILE = path.join(home, 'owner-checks.json');
const { checkSpecsAt, availableChecks, withCheckMetadata } = await import('../src/projects.mjs');
const { gitEnv } = await import('../src/git-env.mjs');
const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
const git = args => {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv() });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
try {
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  const metadata = JSON.stringify({ checks: { fixture_check: { argv: ['/runtime/node', '-e', '0'] } } });
  fs.writeFileSync(path.join(repo, '.dot-bridge.json'), metadata);
  git(['add', '.']); git(['commit', '-qm', 'regular metadata']);
  const regular = git(['rev-parse', 'HEAD']);
  await test('pinned regular metadata loads and scratch is removed on success and callback failure', () => {
    assert.ok(checkSpecsAt('fixture/repo', repo, regular).fixture_check, 'regular pinned metadata remains usable');
    const scratch = () => fs.readdirSync(path.join(home, 'work/caches')).filter(name => name.startsWith('check-metadata-'));
    assert.deepEqual(scratch(), []);
    assert.throws(() => withCheckMetadata(repo, regular, () => { throw new Error('fixture callback failed'); }), /fixture callback failed/);
    assert.deepEqual(scratch(), [], 'throwing metadata consumer left no scratch directory');
  });
  fs.unlinkSync(path.join(repo, '.dot-bridge.json'));
  // A legal symlink target string can itself be JSON. No external file, network or race is needed.
  fs.symlinkSync(metadata, path.join(repo, '.dot-bridge.json'));
  git(['add', '.']); git(['commit', '-qm', 'symlink metadata']);
  const linked = git(['rev-parse', 'HEAD']);
  assert.match(git(['ls-tree', linked, '.dot-bridge.json']), /^120000 /, 'fixture really is a committed Git symlink');
  assert.throws(() => availableChecks('fixture/repo', repo), /symlinks are not allowed/, 'checkout reader enforces the policy');
  await test('pinned Git symlink metadata is refused before it becomes a regular scratch file', () => {
    assert.throws(() => checkSpecsAt('fixture/repo', repo, linked), /check metadata must be a regular file/);
  });
} finally { fs.rmSync(home, { recursive: true, force: true }); }
