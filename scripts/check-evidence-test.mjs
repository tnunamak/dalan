#!/usr/bin/env node
// Evidence record of a host check: what the bridge observed (candidate tree, definition source, changed paths, backend, digests),
// the package.json counterexample (an unchanged command label must not read as "the original tests ran"), mutation refusal while a
// check runs, tree_mutated_by_check, omissions for oversized or unreadable untracked files, and capability_not_available.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-check-evidence-'));
process.env.HOME = home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'work');
const { Workspace, treeDigest } = await import('../src/workspace.mjs');
const run = (cmd, args, cwd) => { const x = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr || x.stdout); return x.stdout.trim(); };
const NODE = '/runtime/node', NPM = ['/runtime/node', '/runtime/npm/bin/npm-cli.js', 'test'];

const sourceRepo = path.join(home, 'source-repo'), repo = path.join(home, 'repo');
fs.mkdirSync(sourceRepo);
run('git', ['init', '-q'], sourceRepo); run('git', ['config', 'user.email', 't@example.com'], sourceRepo); run('git', ['config', 'user.name', 'T'], sourceRepo);
fs.writeFileSync(path.join(sourceRepo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node real-test.mjs' } }));
fs.writeFileSync(path.join(sourceRepo, 'real-test.mjs'), 'console.log("REAL_TESTS_RAN");\n');
fs.writeFileSync(path.join(sourceRepo, 'hello.txt'), 'before\n');
fs.writeFileSync(path.join(sourceRepo, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: NPM, timeout_ms: 30000, output_bytes: 65536 } } }));
run('git', ['add', '.'], sourceRepo); run('git', ['commit', '-qm', 'base'], sourceRepo);
fs.writeFileSync(path.join(sourceRepo, 'hello.txt'), 'tip\n');
run('git', ['add', 'hello.txt'], sourceRepo); run('git', ['commit', '-qm', 'tip'], sourceRepo);
run('git', ['clone', '--depth', '1', pathToFileURL(sourceRepo).href, repo], home);
assert.equal(run('git', ['rev-parse', '--is-shallow-repository'], repo), 'true', 'the check fixture is a shallow clone');
const parent = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD^'], { encoding: 'utf8' });
assert.notEqual(parent.status, 0, 'the shallow check fixture has no parent commit');
const base = run('git', ['rev-parse', 'HEAD'], repo);
// A current tree digest needs the shallow commit and worktree index, not its missing parent history.
const shallowTree = await treeDigest(repo);
assert.match(shallowTree.sha256, /^[0-9a-f]{40}$/, shallowTree.reason);
assert.equal(shallowTree.sha256, run('git', ['rev-parse', 'HEAD^{tree}'], repo));
console.log('PASS shallow clone tree digest does not require parent history');
process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
await import('./require-host-checks.mjs');
const { Store } = await import('../src/store.mjs');
const store = new Store(path.join(home, 'db.sqlite'));
const ws = new Workspace(store);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function assignment(execution = null) {
  const id = `req_${randomUUID()}`, payload = { schema_version: 1, request_id: id, brief: 'fixture', inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }], expected_output: 'patch', execution_scope: 'implementation' };
  store.submit(payload, 'thread', 'environment', 'owner', false, null, 'normal', null, payload, null, null, execution);
  const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
  ws.ensure(id, claim, 'subject');
  return { id, claim, dir: path.join(home, 'work/worktrees', id) };
}
async function check(a) {
  let r = await ws.check(a.id, a.claim, 'subject', 'default');
  for (let i = 0; i < 1200 && r.status === 'running'; i++) { await sleep(100); const j = store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(r.check_run_id); if (j.status !== 'running') r = { ...r, status: j.status }; }
  const row = store.db.prepare('SELECT * FROM check_runs WHERE id=?').get(r.check_run_id);
  return { r, row, evidence: row ? JSON.parse(row.evidence) : null, text: row ? ws.artifact(row.output_artifact_id, a.id).bytes.toString() : '' };
}
const setPackage = (a, script) => ws.apply(a.id, a.claim, 'subject', `diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-${fs.readFileSync(path.join(repo, 'package.json'), 'utf8')}\n\\ No newline at end of file\n+${JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: script } })}\n\\ No newline at end of file\n`);

try {
  // 1. An untouched candidate: bridge_verified, nothing differs, the definition is the base's, the tree does not change.
  const clean = assignment();
  const pre = await treeDigest(clean.dir);
  const c = await check(clean);
  assert.equal(c.evidence.execution, 'host'); assert.equal(c.evidence.trust, 'bridge_verified');
  assert.equal(c.evidence.base_sha, base); assert.equal(c.evidence.input_patch_sha256, null);
  assert.equal(c.evidence.input_tree_sha256, pre.sha256, 'digest of the tree the command started on');
  assert.equal(c.evidence.post_run_tree_sha256, (await treeDigest(clean.dir)).sha256, JSON.stringify({
    post_run_tree_unavailable: c.evidence.post_run_tree_unavailable,
    check_stop: c.evidence.sandbox_stop.check
  }));
  assert.equal(c.evidence.tree_mutated_by_check, false);
  assert.equal(c.evidence.candidate_differs_from_base, false); assert.deepEqual(c.evidence.changed_paths.preview, []); assert.equal(c.evidence.source_observation, 'observed');
  assert.equal(c.evidence.input_tree_sha256, c.evidence.base_tree_sha256, 'git tree of the candidate source equals the base tree');
  assert(c.evidence.not_identified.startsWith('Ignored files'), 'every receipt says what it does not identify');
  assert.doesNotMatch(JSON.stringify(c.evidence), /exact executed input|immutable snapshot of the executed/i);
  assert.equal(c.evidence.definition.source, 'base'); assert.match(c.evidence.definition.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(c.evidence.argv, NPM);
  assert.equal(c.evidence.backend.name, 'linux-bwrap-pasta'); assert.equal(typeof c.evidence.backend.version, 'string'); assert.equal(c.evidence.backend.capabilities.private_loopback, 'verified');
  assert.equal(c.evidence.exit_code, 0); assert.equal(c.evidence.timed_out, false); assert.equal(c.evidence.output_truncated, false);
  assert.equal(c.evidence.output_sha256, c.row.output_sha256); assert(c.text.includes('REAL_TESTS_RAN'));
  assert.equal(c.evidence.input_diff_sha256, c.row.diff_sha256);
  assert.equal(c.r.trust, 'bridge_verified', 'the run_check result carries the label');
  const shown = ws.result(clean.id, clean.claim, 'subject').checks[0];
  assert.equal(shown.trust, 'bridge_verified'); assert.deepEqual(shown.evidence, c.evidence, 'workspace_result shows the same evidence');
  assert.equal(shown.applies_to_current_diff, true);
  assert.equal(ws.result(clean.id, clean.claim, 'subject').not_identified, c.evidence.not_identified, 'workspace_result carries not_identified');
  const got = store.get(clean.id); assert.equal(got.execution, 'host');

  // 2. The counterexample: .dot-bridge.json and the command (`npm test`) are unchanged, but the worker rewrote package.json's test script.
  const tampered = assignment();
  setPackage(tampered, 'node -e "console.log(\'FAKE_TESTS_PASSED\')"');
  const t = await check(tampered);
  assert(t.text.includes('FAKE_TESTS_PASSED') && !t.text.includes('REAL_TESTS_RAN'), 'a different program ran under the same command');
  assert.equal(t.evidence.exit_code, 0);
  assert.equal(t.evidence.candidate_differs_from_base, true);
  assert(t.evidence.changed_paths.preview.includes('package.json'), JSON.stringify(t.evidence.changed_paths));
  assert.equal(t.evidence.definition.source, 'base', 'the definition file is unchanged from base');
  assert.equal(t.evidence.definition.sha256, c.evidence.definition.sha256, 'same definition hash as the clean run');
  assert.deepEqual(t.evidence.argv, NPM, 'same command label');
  assert.notEqual(t.evidence.input_tree_sha256, c.evidence.input_tree_sha256, 'but not the same candidate tree');
  assert.doesNotMatch(t.evidence.observed, /original|base tests|same tests|tests (?:ran|passed)|unmodified/i, 'the receipt claims nothing about which program ran');
  assert.match(t.evidence.observed, /candidate source differs from base in 1 path\(s\): package\.json/);
  assert.match(t.evidence.observed, /Not identified:/);
  assert.match(t.evidence.observed, /does not show which program the command ran/);

  // 3. A worker-edited definition file is flagged as modified.
  const redefined = assignment();
  fs.writeFileSync(path.join(redefined.dir, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: [NODE, '-e', 'console.log("OTHER")'], timeout_ms: 30000, output_bytes: 65536 } } }));
  const rd = await check(redefined);
  assert.equal(rd.evidence.definition.source, 'modified'); assert.notEqual(rd.evidence.definition.sha256, c.evidence.definition.sha256);
  assert(rd.evidence.changed_paths.preview.includes('.dot-bridge.json'));

  // 4. Mutations are refused while a check runs, and a command that changes the tree is flagged.
  const busy = assignment();
  fs.writeFileSync(path.join(busy.dir, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: [NODE, '-e', 'require("fs").writeFileSync("made-by-check.txt","x");setTimeout(()=>{},2500)'], timeout_ms: 30000, output_bytes: 65536 } } }));
  const started = ws.check(busy.id, busy.claim, 'subject', 'default');
  await sleep(300);
  assert.throws(() => setPackage(busy, 'true'), /check still running/, 'apply_patch is refused while a check runs');
  const done = await started;
  for (let i = 0; i < 100 && store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(done.check_run_id).status === 'running'; i++) await sleep(100);
  const bRow = store.db.prepare('SELECT * FROM check_runs WHERE id=?').get(done.check_run_id), bEv = JSON.parse(bRow.evidence);
  assert.equal(bEv.tree_mutated_by_check, true); assert.notEqual(bEv.post_run_tree_sha256, bEv.input_tree_sha256); assert.deepEqual(bEv.tree_mutated_paths.preview, ['made-by-check.txt']);
  assert.match(bEv.observed, /The command changed the candidate source/);
  assert.equal(ws.result(busy.id, busy.claim, 'subject').checks[0].applies_to_current_diff, false, 'the check changed the tree, so its evidence is about the diff it started on, not this one');
  setPackage(busy, 'true');
  assert.equal(ws.result(busy.id, busy.claim, 'subject').checks[0].applies_to_current_diff, false, 'a later patch makes the evidence stale');

  // 5. Oversized and unreadable untracked files: omitted with evidence, the result row is stored, the diff stays bounded.
  const big = assignment();
  fs.writeFileSync(path.join(big.dir, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: [NODE, '-e', 'const fs=require("fs");const fd=fs.openSync("big.bin","w");const b=Buffer.alloc(1<<20,65);for(let i=0;i<13;i++)fs.writeSync(fd,b);fs.closeSync(fd);fs.writeFileSync("small.txt","ok\\n")'], timeout_ms: 30000, output_bytes: 65536 } } }));
  const bg = await check(big);
  assert(bg.row, 'the check result row is stored'); assert.equal(bg.evidence.exit_code, 0);
  assert.deepEqual(bg.evidence.post_run_diff_omissions.preview, [{ path: 'big.bin', size: 13 << 20, reason: 'too_large' }]);
  const res = ws.result(big.id, big.claim, 'subject');
  assert.deepEqual(res.diff_omissions, [{ path: 'big.bin', size: 13 << 20, reason: 'too_large' }]);
  assert(res.diff_bytes < 100000 && res.diff_preview.includes('small.txt') && !res.diff_preview.includes('AAAA'), 'bounded; the small file is still in the diff');
  assert(ws.snapshot(big.id, big.claim, 'subject').patch_artifact.artifact_id, 'snapshot works');
  fs.writeFileSync(path.join(big.dir, 'locked.txt'), 'secret'); fs.chmodSync(path.join(big.dir, 'locked.txt'), 0);
  const locked = ws.diff(big.dir, base).omissions.find(o => o.path === 'locked.txt');
  assert.deepEqual(locked, { path: 'locked.txt', size: 6, reason: 'unreadable' });
  fs.chmodSync(path.join(big.dir, 'locked.txt'), 0o600);

  // 6. execution none or worker: run_check answers capability_not_available and runs nothing.
  for (const execution of ['none', 'worker']) {
    const n = assignment(execution);
    const r = await ws.check(n.id, n.claim, 'subject', 'default');
    assert.equal(r.status, 'capability_not_available'); assert.equal(r.capability, 'host_execution'); assert.match(r.reason, new RegExp(`execution=${execution}`));
    assert.equal(store.db.prepare('SELECT count(*) n FROM check_jobs WHERE request_id=?').get(n.id).n, 0, 'no job row');
    assert.equal(store.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type LIKE 'check_%'").get(n.id).n, 0, 'no check lifecycle events');
    assert.equal(fs.existsSync(path.join(home, 'work/caches', n.id)), false, 'no sandbox was prepared');
  }
  // A host job on a host with no executor behaves the same way and never falls back to an unconfined run.
  const noExec = assignment();
  process.env.DOT_BRIDGE_TEST_HIDE_BWRAP = '1';
  try {
    const r = await ws.check(noExec.id, noExec.claim, 'subject', 'default');
    assert.equal(r.status, 'capability_not_available'); assert.match(r.reason, /host_execution \(bwrap not found\)/);
    assert.equal(store.db.prepare('SELECT count(*) n FROM check_jobs WHERE request_id=?').get(noExec.id).n, 0);
  } finally { delete process.env.DOT_BRIDGE_TEST_HIDE_BWRAP; }
  console.log('check-evidence-test: PASS');
} finally { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); }
