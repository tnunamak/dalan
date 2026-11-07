#!/usr/bin/env node
// test_paths: load-time rule (every entry named in argv), run-time fail-fast (check_test_path_missing), the run result's test_paths,
// and `dot-worker doctor --checks` (files each check names, warning when an id names a test file argv leaves out).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-check-test-paths-'));
process.env.HOME = home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'work');
const checksFile = path.join(home, 'checks.json');
process.env.DOT_BRIDGE_CHECKS_FILE = path.join(home, 'none.json');
const { availableChecks, detectCheck, argvNamesPath, argvTestFiles } = await import('../src/projects.mjs');
const { filesNamedById } = await import('../src/check-lint.mjs');
const { Store } = await import('../src/store.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const run = (cmd, args, cwd, env) => { const x = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env }); if (x.status !== 0) throw new Error(x.stderr || x.stdout); return x.stdout.trim(); };
const NODE = '/runtime/node';

try {
  // Load: a test_path must be named in argv, as an element or a word inside a bash -c script.
  assert.equal(argvNamesPath(['node', '--test', 'tests/a.test.mjs'], 'tests/a.test.mjs'), true);
  assert.equal(argvNamesPath(['bash', '-c', 'node --test tests/a.test.mjs tests/b.test.mjs'], 'tests/b.test.mjs'), true);
  assert.equal(argvNamesPath(['node', '--test', 'tests/a.test.mjs'], 'a.test.mjs'), false, 'a suffix of another path is not the path');
  assert.equal(argvNamesPath(['node', '--test', 'tests/a.test.mjs'], 'tests/b.test.mjs'), false);
  assert.equal(argvNamesPath(['node', '--test', 'tests/'], 'tests'), true, 'a directory argument names the directory');
  assert.deepEqual(argvTestFiles(['bash', '-c', 'f=tests/host.test.mjs; node --test "$f" ui/a.test.mjs test_x.py']), ['tests/host.test.mjs', 'ui/a.test.mjs', 'test_x.py']);
  const fixture = checks => { const dir = fs.mkdtempSync(path.join(home, 'repo-')); fs.writeFileSync(path.join(dir, '.dot-bridge.json'), JSON.stringify({ checks })); return dir; };
  const ok = fixture({ focused: { argv: [NODE, '--test', 'tests/a.test.mjs', 'tests/b.test.mjs'], test_paths: ['tests/a.test.mjs', 'tests/b.test.mjs'] } });
  assert.deepEqual(availableChecks('o/r', ok), ['focused']);
  assert.deepEqual(detectCheck('o/r', ok, 'focused').test_paths, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.deepEqual(availableChecks('o/r', fixture({ viascript: { argv: ['npm', 'run', 'test:x'], test_paths: ['scripts'] } })), ['viascript'], 'a directory entry is informational');
  const drifted = fixture({ focused: { argv: [NODE, '--test', 'tests/a.test.mjs'], test_paths: ['tests/a.test.mjs', 'tests/b.test.mjs'] } });
  assert.throws(() => availableChecks('o/r', drifted), /invalid check metadata/);
  assert.throws(() => detectCheck('o/r', drifted, 'focused'), /invalid check metadata/);
  await import('./require-host-checks.mjs');

  // Run: the declared file is missing from the checkout, so nothing runs.
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  run('git', ['init', '-q'], repo); run('git', ['config', 'user.email', 't@example.com'], repo); run('git', ['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'tests/a.test.mjs'), 'console.log("A_RAN");\n');
  fs.writeFileSync(path.join(repo, 'tests/sample-feature50.test.mjs'), 'console.log("SAMPLE_FEATURE_RAN");\n');
  fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: {
    focused: { argv: [NODE, 'tests/a.test.mjs'], test_paths: ['tests/a.test.mjs'], timeout_ms: 30000 },
    'sample-feature50': { argv: [NODE, 'tests/a.test.mjs'], timeout_ms: 30000 },
  } }));
  run('git', ['add', '.'], repo); run('git', ['commit', '-qm', 'base'], repo);
  const base = run('git', ['rev-parse', 'HEAD'], repo);
  process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
  const store = new Store(path.join(home, 'db.sqlite'));
  const ws = new Workspace(store);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const assignment = () => {
    const id = `req_${randomUUID()}`, payload = { schema_version: 1, request_id: id, brief: 'fixture', inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }], expected_output: 'patch', execution_scope: 'implementation' };
    store.submit(payload, 'thread', 'environment', 'owner', false, null, 'normal', null, payload, null, null, null);
    const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
    ws.ensure(id, claim, 'subject');
    return { id, claim, dir: path.join(home, 'work/worktrees', id) };
  };
  const check = async (a, checkId) => {
    let r = await ws.check(a.id, a.claim, 'subject', checkId);
    for (let i = 0; i < 1200 && r.status === 'running'; i++) { await sleep(100); const j = store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(r.check_run_id); if (j.status !== 'running') r = { ...r, status: j.status }; }
    return r;
  };
  let a = assignment();
  let r = await check(a, 'focused');
  assert.equal(r.status, 'completed', JSON.stringify(r));
  assert.deepEqual(r.test_paths, ['tests/a.test.mjs'], 'the result carries the declared test_paths');
  assert.deepEqual(r.evidence.test_paths, ['tests/a.test.mjs']);
  r = await check(a, 'sample-feature50');
  assert.deepEqual(r.test_paths, ['tests/a.test.mjs'], 'without test_paths the result carries the test files argv names');
  a = assignment();
  fs.rmSync(path.join(a.dir, 'tests/a.test.mjs'));
  r = await ws.check(a.id, a.claim, 'subject', 'focused');
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'check_test_path_missing: tests/a.test.mjs');
  assert.equal(r.blocker, 'check_test_path_missing');
  assert.equal(store.db.prepare('SELECT count(*) n FROM check_jobs WHERE request_id=?').get(a.id).n, 0, 'nothing ran, so no job row');

  // Doctor: id names a test file that argv leaves out.
  assert.deepEqual(filesNamedById('sample-feature50-adapter', ['tests/v1-sample-feature50-adapter.test.mjs', 'tests/v1-sample-helper.test.mjs']), ['tests/v1-sample-feature50-adapter.test.mjs']);
  assert.deepEqual(filesNamedById('sample-engine', ['tests/v1-sample-policy.test.mjs']), []);
  assert.deepEqual(filesNamedById('host', ['tests/host.test.mjs', 'tests/sample-repo-host.test.mjs']), ['tests/host.test.mjs']);
  const mirror = path.join(home, 'work/mirrors/o/r.git');
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  run('git', ['clone', '-q', '--bare', repo, mirror]);
  const work = path.join(home, 'tree');
  fs.mkdirSync(path.join(work, 'tests'), { recursive: true });
  run('git', ['init', '-q'], work); run('git', ['config', 'user.email', 't@example.com'], work); run('git', ['config', 'user.name', 'T'], work);
  for (const f of ['tests/v1-sample-feature50-adapter.test.mjs', 'tests/v1-sample-helper.test.mjs', 'tests/v1-sample-engine.test.mjs']) fs.writeFileSync(path.join(work, f), '\n');
  run('git', ['add', '.'], work); run('git', ['commit', '-qm', 'tree'], work);
  run('git', ['clone', '-q', '--bare', work, path.join(home, 'work/mirrors/o/r2.git')]);
  fs.writeFileSync(checksFile, JSON.stringify({
    'o/r2': { checks: {
      'sample-feature50-adapter': { argv: [NODE, '--test', 'tests/v1-sample-helper.test.mjs'] },
      'sample-engine': { argv: [NODE, '--test', 'tests/v1-sample-engine.test.mjs', 'tests/v1-sample-helper.test.mjs'], test_paths: ['tests/v1-sample-engine.test.mjs', 'tests/missing.test.mjs'].slice(0, 1) },
      broken: { argv: [NODE], test_paths: ['x/y.test.mjs'] },
    } },
    'o/nomirror': { checks: { a: { argv: [NODE, 'a.test.mjs'] } } },
  }), { mode: 0o600 });
  const env = { ...process.env, DOT_BRIDGE_CHECKS_FILE: checksFile };
  const doctor = (...flags) => spawnSync(process.execPath, ['bin/dot-worker.mjs', 'doctor', '--checks', ...flags], { encoding: 'utf8', env });
  let out = doctor();
  assert.equal(out.status, 1, 'an invalid definition is an error exit');
  assert.match(out.stdout, /o\/r2\n {2}sample-feature50-adapter: tests\/v1-sample-helper\.test\.mjs\n {4}WARNING: id suggests tests\/v1-sample-feature50-adapter\.test\.mjs, which argv does not run/);
  assert.match(out.stdout, / {2}sample-engine: tests\/v1-sample-engine\.test\.mjs\n/);
  assert.doesNotMatch(out.stdout, /sample-engine[^\n]*\n {4}WARNING/);
  assert.match(out.stdout, /broken: \(argv names no test files\)\n {4}ERROR: test_paths broken: x\/y\.test\.mjs is not named in argv/);
  assert.match(out.stdout, /o\/nomirror \(no local mirror: id\/file name lint skipped\)/);
  assert.match(out.stdout, /1 warning\(s\), 1 error\(s\)/);
  out = doctor('--json');
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.checks.find(x => x.repo === 'o/r2').checks[0].warnings.length, 1);
  console.log('check-test-paths-test ok');
} finally { fs.rmSync(home, { recursive: true, force: true }); }
