#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-check-discovery-'));
process.env.HOME = home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'work');

const { Store } = await import('../src/store.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const { availableChecks, detectCheckWithOrigin } = await import('../src/projects.mjs');
const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
};

try {
  const repo = path.join(home, 'repo');
  const outside = path.join(home, 'outside.json');
  fs.mkdirSync(repo);
  run('git', ['init', '-q'], repo);
  run('git', ['config', 'user.email', 'test@example.com'], repo);
  run('git', ['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'base\n');
  fs.writeFileSync(outside, JSON.stringify({ checks: { foreign_check: { argv: ['node', '-e', 'void 0'], timeout_ms: 1000, output_bytes: 1024 } } }));
  fs.symlinkSync(outside, path.join(repo, '.dot-bridge.json'));
  run('git', ['add', '.'], repo);
  run('git', ['commit', '-qm', 'base with out-of-checkout check metadata symlink'], repo);
  const base = run('git', ['rev-parse', 'HEAD'], repo);
  process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;

  const store = new Store(path.join(home, 'db.sqlite'));
  const workspace = new Workspace(store);
  const id = `req_${randomUUID()}`;
  const assignment = {
    schema_version: 1,
    request_id: id,
    brief: 'base-only check discovery',
    inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }],
    scope_paths: ['hello.txt'],
    expected_output: 'catalog',
    execution_scope: 'read-only',
  };
  store.submit(assignment, 'thread', 'environment', 'owner');
  const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
  const discoverForeign = fn => {
    try {
      const value = fn();
      return Array.isArray(value) ? value.includes('foreign_check') : value?.spec?.id === 'foreign_check';
    } catch (error) { return error.message.includes('foreign_check'); }
  };
  assert.equal(discoverForeign(() => availableChecks('example-owner/fixture', repo)), false, 'availableChecks must refuse the out-of-checkout symlink');
  assert.equal(discoverForeign(() => detectCheckWithOrigin('example-owner/fixture', repo, 'foreign_check')), false, 'detectCheckWithOrigin must refuse the symlink');
  assert.equal(discoverForeign(() => workspace.availableChecksFor(assignment)), false, 'pinned availableChecksFor must not expose symlink contents');
  let pinnedSpecs = {}, pinnedError = '';
  try { pinnedSpecs = workspace.checkMetadataFor(assignment); } catch (error) { pinnedError = error.message; }
  assert.equal(Object.hasOwn(pinnedSpecs, 'foreign_check'), false, 'pinned checkSpecsAt must not expose symlink contents');
  assert.equal(pinnedError.includes('foreign_check'), false, 'pinned metadata errors stay sanitized');
  let foreignCheckDiscovered = false;
  try {
    foreignCheckDiscovered = workspace.result(id, claim, 'subject').available_checks.includes('foreign_check');
  } catch (error) {
    foreignCheckDiscovered = error.message.includes('foreign_check');
  }
  assert.equal(foreignCheckDiscovered, false, 'out-of-checkout check IDs must not enter discovery or errors');

  // Workspace.result reads the checked-out worktree, not the original fixture repo.
  const { dir: checkout } = workspace.ensure(id, claim, 'subject', true);
  const checkoutMetadata = path.join(checkout, '.dot-bridge.json');
  fs.unlinkSync(checkoutMetadata);
  const marker = 'META_MARKER_NON_SECRET_NOT_JSON', excerpt = 'INPUT_EXCERPT_MARKER';
  const malformedMetadata = `${marker}\n${excerpt}`;
  fs.writeFileSync(checkoutMetadata, malformedMetadata);
  assert.equal(fs.lstatSync(checkoutMetadata).isFile(), true, 'malformed metadata must be a regular file in the checkout');
  assert.equal(fs.readFileSync(checkoutMetadata, 'utf8') === malformedMetadata, true, 'checkout contains the malformed fixture bytes');
  let parseError = null;
  try { workspace.result(id, claim, 'subject'); } catch (error) { parseError = error; }
  assert.equal(parseError !== null, true, 'malformed checked-out metadata must fail parsing');
  assert.equal(/invalid check metadata/.test(parseError.message), true, 'failure must be a sanitized metadata parse error');
  const diagnostic = `${parseError.message}\n${parseError.stack ?? ''}`;
  assert.equal(diagnostic.includes(marker), false, 'metadata parse diagnostics must not expose the marker');
  assert.equal(diagnostic.includes(excerpt), false, 'metadata parse diagnostics must not expose an input excerpt');
  fs.unlinkSync(checkoutMetadata);

  // Detected project metadata shares the same no-follow, bounded reader as .dot-bridge.json.
  const metadataTargets = {
    'package.json': JSON.stringify({ scripts: { test: 'node tests/run.mjs' } }),
    'pytest.ini': 'testpaths = tests\n',
    'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    Makefile: 'test:\n\t@true\n',
  };
  for (const [name, contents] of Object.entries(metadataTargets)) {
    const externalMetadata = path.join(home, `outside-${name.replaceAll('/', '_')}`);
    const metadataPath = path.join(repo, name);
    fs.writeFileSync(externalMetadata, contents);
    try { fs.unlinkSync(metadataPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.symlinkSync(externalMetadata, metadataPath);
    let returnedChecks = [];
    try { returnedChecks = availableChecks('example-owner/fixture', repo); } catch {}
    assert.equal(returnedChecks.includes('default'), false, `${name} symlink must not drive check discovery`);
    fs.unlinkSync(metadataPath);
  }

  fs.writeFileSync(path.join(repo, '.dot-bridge.json'), 'x'.repeat((1024 * 1024) + 1));
  let oversizedError = '';
  try { availableChecks('example-owner/fixture', repo); } catch (error) { oversizedError = error.message; }
  assert.equal(oversizedError.length > 0, true, 'oversized metadata must fail closed');
  assert.equal(oversizedError.length < 100, true, 'oversized metadata errors stay bounded');
  assert.equal(oversizedError.includes('x'.repeat(32)), false, 'oversized metadata errors do not include input text');
  store.db.close();
  console.log('check-discovery-symlink-test: PASS');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
