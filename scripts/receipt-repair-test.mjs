#!/usr/bin/env node
import './require-host-checks.mjs';
// Receipts must identify what ran (repair round 1). Regressions: an ignored program the digest used to skip; tracked files under
// node_modules; excluded directories reported as incomplete coverage; an install that rewrites a tracked file before the check;
// pid reuse in the stop cleanup; 350 untracked files and the complete omission list in an artifact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { remainingProcesses, verifyStopped } from '../src/sandbox-supervisor.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-receipt-repair-'));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'work');
delete process.env.DOT_BRIDGE_ALLOW_SHARED_NET_INSTALL; // the install phase goes through pasta, as in production
const { Store } = await import('../src/store.mjs');
const { Workspace, boundedDetail, treeDigest, NOT_IDENTIFIED } = await import('../src/workspace.mjs');
const { gitEnv } = await import('../src/git-env.mjs');
const { hostGitEnv } = await import('../src/projects.mjs');
const run = (cmd, args, cwd) => { const x = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr || x.stdout); return x.stdout.trim(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NODE = '/runtime/node';
const def = spec => JSON.stringify({ checks: { default: { timeout_ms: 30000, output_bytes: 65536, ...spec } } });

fs.mkdirSync(path.join(home, '.config/git'), { recursive: true });
fs.writeFileSync(path.join(home, '.config/git/ignore'), 'CLAUDE.md\nsecret-*.cjs\n**/hidden/\n');
const repo = path.join(home, 'repo');
fs.mkdirSync(repo);
run('git', ['init', '-q'], repo); run('git', ['config', 'user.email', 't@example.com'], repo); run('git', ['config', 'user.name', 'T'], repo);
fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.cjs\n');
fs.writeFileSync(path.join(repo, 'run.cjs'), 'try{require("./ignored.cjs")}catch{console.log("BEFORE")}\nrequire("./node_modules/tracked.cjs");\n');
fs.mkdirSync(path.join(repo, 'node_modules'));
fs.writeFileSync(path.join(repo, 'node_modules/tracked.cjs'), 'console.log("TRACKED_V1");\n');
fs.mkdirSync(path.join(repo, 'locked')); fs.writeFileSync(path.join(repo, 'locked/data.txt'), 'tracked\n');
fs.mkdirSync(path.join(repo, 'libdir')); fs.writeFileSync(path.join(repo, 'libdir/data.txt'), 'tracked\n');
fs.writeFileSync(path.join(repo, '.dot-bridge.json'), def({ argv: [NODE, 'run.cjs'] }));
run('git', ['add', '-A', '-f'], repo); run('git', ['commit', '-qm', 'base'], repo);
const base = run('git', ['rev-parse', 'HEAD'], repo);
process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
const store = new Store(path.join(home, 'db.sqlite'));
const ws = new Workspace(store);
// Enabling the backend alone does not authorize this legacy fixture. Probe the
// real policy before expecting a check receipt, and prove refusal writes none.
const { hostCheckRefusal } = await import('../src/host-execution-policy.mjs');
const fixtureRefusal = hostCheckRefusal({}, 'example-owner/fixture', 'default');
if (fixtureRefusal) {
  try {
    const id = 'req_' + randomUUID();
    store.submit({ schema_version: 1, request_id: id, brief: 'fixture', inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }], expected_output: 'patch', execution_scope: 'implementation' }, 'thread', 'environment', 'owner');
    const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
    const refused = await ws.check(id, claim, 'subject', 'default');
    assert.equal(refused.status, 'capability_not_available');
    assert.equal(refused.reason, fixtureRefusal);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM check_runs').get().n, 0);
    console.log('SKIP receipt execution journeys: ' + fixtureRefusal + ' (refusal and absent receipt verified)');
    process.exitCode = 77;
  } finally { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); }
  process.exit(process.exitCode);
}

function assignment() {
  const id = `req_${randomUUID()}`, payload = { schema_version: 1, request_id: id, brief: 'fixture', inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }], expected_output: 'patch', execution_scope: 'implementation' };
  store.submit(payload, 'thread', 'environment', 'owner');
  const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
  ws.ensure(id, claim, 'subject');
  return { id, claim, dir: path.join(home, 'work/worktrees', id) };
}
async function check(a) {
  let r = await ws.check(a.id, a.claim, 'subject', 'default');
  for (let i = 0; i < 1200 && r.status === 'running'; i++) { await sleep(100); const j = store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(r.check_run_id); if (j.status !== 'running') r = { ...r, status: j.status }; }
  const row = store.db.prepare('SELECT * FROM check_runs WHERE id=?').get(r.check_run_id);
  assert(row, `no check_runs row: ${JSON.stringify(r)}`);
  return { row, ev: JSON.parse(row.evidence), text: ws.artifact(row.output_artifact_id, a.id).bytes.toString() };
}
const tree = ev => ev.input_tree_sha256 ?? ev.candidate_tree_sha256;
const names = x => (Array.isArray(x) ? x : x?.preview ?? []);

const results = [];
const section = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, `FAIL: ${String(e.message).split('\n')[0].slice(0, 160)}`]); } };
try {
  const noEquality = ev => {
    assert(ev.not_identified.startsWith('Ignored files, generated or dependency directories'), 'not_identified is present');
    assert.match(ev.observed, /Not identified: Ignored files/);
    assert.match(ev.observed, /candidate source/);
    for (const key of ['coverage', 'complete', 'identical', 'differs_from_base', 'applies_to_current_tree']) assert(!(key in ev), `no ${key} field`);
    assert.doesNotMatch(ev.observed, /identical|exact executed|same program|covered files|every file/i, 'no wording that implies equality or full coverage');
    assert.match(ev.claims.source_observation, /not proof of the executed bytes and not an immutable snapshot/);
  };
  // 1. A committed definition runs an ignored program. The receipt does not claim to identify it: the candidate source is the same for both runs.
  await section('1 ignored program is not claimed', async () => {
    const ig = assignment();
    fs.writeFileSync(path.join(ig.dir, 'ignored.cjs'), 'console.log("IGNORED_V1");\n');
    const v1 = await check(ig);
    fs.writeFileSync(path.join(ig.dir, 'ignored.cjs'), 'console.log("IGNORED_V2");\n');
    const v2 = await check(ig);
    assert(v1.text.includes('IGNORED_V1') && v2.text.includes('IGNORED_V2'), 'the output changed with the ignored program');
    assert.equal(tree(v1.ev), tree(v2.ev), 'git\'s view does not contain the ignored file');
    noEquality(v1.ev); noEquality(v2.ev);
  });

  // 2. A tracked file under node_modules is part of the candidate source; an untracked dependency directory is not identified.
  await section('2 excluded directory is not claimed; tracked file under it is observed', async () => {
    const a = assignment();
    const before = await check(a);
    assert(before.text.includes('BEFORE'));
    fs.mkdirSync(path.join(a.dir, 'pkg/node_modules/dep'), { recursive: true });
    fs.writeFileSync(path.join(a.dir, 'pkg/node_modules/dep/index.js'), 'x\n');
    const withDep = await check(a);
    assert.equal(tree(before.ev), tree(withDep.ev), 'an untracked dependency directory is outside the candidate source');
    noEquality(withDep.ev);
    fs.writeFileSync(path.join(a.dir, 'pkg/node_modules/dep/index.js'), 'changed\n');
    assert.equal(tree((await check(a)).ev), tree(withDep.ev), 'and a change in it is not seen');
    fs.writeFileSync(path.join(a.dir, 'node_modules/tracked.cjs'), 'console.log("TRACKED_V2");\n');
    const after = await check(a);
    assert(after.text.includes('TRACKED_V2'));
    assert.notEqual(tree(before.ev), tree(after.ev), 'a tracked file under node_modules is observed');
    assert(names(after.ev.changed_paths).includes('node_modules/tracked.cjs'));
  });

  // 3. Install rewrites a tracked file; the check receipt names the check input, which differs from the install input.
  await section('3 install rewrites tracked file', async () => {
    const a = assignment();
    fs.writeFileSync(path.join(a.dir, '.dot-bridge.json'), def({ install_argv: [NODE, '-e', 'require("fs").writeFileSync("run.cjs","console.log(\\"AFTER\\");\\n")'], argv: [NODE, 'run.cjs'] }));
    const r = await check(a);
    assert.equal(r.ev.phase, 'check'); assert(r.text.includes('AFTER'));
    assert(r.ev.install_input_tree_sha256, 'the install input has its own digest');
    assert.notEqual(r.ev.install_input_tree_sha256, tree(r.ev), 'the check input is not the install input');
    assert.equal(r.ev.check_input_differs_from_install_input, true);
    assert.deepEqual(r.ev.install_changed_paths.preview, ['run.cjs']);
    assert(names(r.ev.install_changed_paths).includes('run.cjs'));
    assert(names(r.ev.changed_paths).includes('run.cjs'), 'the diff in the receipt is taken after the install');
    assert.match(r.ev.observed, /install phase changed the candidate source before the check ran: run\.cjs/);
    assert.equal(r.ev.tree_mutated_by_check, false);
    assert.equal(ws.result(a.id, a.claim, 'subject').checks[0].applies_to_current_diff, true);
    // a later edit makes the receipt stale: its diff digest no longer matches
    fs.writeFileSync(path.join(a.dir, 'run.cjs'), 'console.log("LATER");\n');
    assert.equal(ws.result(a.id, a.claim, 'subject').checks[0].applies_to_current_diff, false);
  });

  // 3b. When git cannot produce an observation, the receipt says unavailable with a reason; the check row is kept; no clean digest is invented.
  const unavailable = (r, why) => {
    assert(r.row, 'the check result row is kept');
    assert.equal(r.ev.source_observation, 'unavailable', why);
    assert.equal(r.ev.input_tree_sha256, null); assert(r.ev.input_tree_unavailable, 'a reason is recorded');
    assert.notEqual(r.ev.candidate_differs_from_base, false, 'never reads as unchanged');
    noEquality(r.ev);
  };
  await section('3b unreadable tracked file', async () => {
    const a = assignment();
    fs.chmodSync(path.join(a.dir, 'libdir/data.txt'), 0);
    try { unavailable(await check(a), 'unreadable tracked file'); } finally { fs.chmodSync(path.join(a.dir, 'libdir/data.txt'), 0o600); }
  });
  await section('3c mode-000 directory with tracked content', async () => {
    const a = assignment();
    fs.chmodSync(path.join(a.dir, 'locked'), 0);
    try { unavailable(await check(a), 'mode-000 directory'); } finally { fs.chmodSync(path.join(a.dir, 'locked'), 0o700); }
  });
  await section('3d git failure and timeout', async () => {
    for (const mode of ['fail', 'timeout']) {
      process.env.DOT_BRIDGE_TEST_GIT_VIEW = mode;
      try { unavailable(await check(assignment()), `git ${mode}`); } finally { delete process.env.DOT_BRIDGE_TEST_GIT_VIEW; }
    }
  });
  // 3e. A symlink in place of a tracked directory is never followed: whatever the outside directory holds, the observation is the same.
  await section('3e intermediate symlink is not followed', async () => {
    const outside = path.join(home, 'outside'); fs.mkdirSync(outside);
    const digests = [];
    for (const content of ['OUTSIDE_ONE', 'OUTSIDE_TWO']) {
      fs.writeFileSync(path.join(outside, 'data.txt'), content);
      const a = assignment();
      fs.rmSync(path.join(a.dir, 'libdir'), { recursive: true }); fs.symlinkSync(outside, path.join(a.dir, 'libdir'));
      const r = await check(a);
      assert.equal(r.ev.source_observation, 'observed'); digests.push([tree(r.ev), JSON.stringify(r.ev.changed_paths.preview)]);
      assert(names(r.ev.changed_paths).includes('libdir/data.txt'), 'the tracked file is gone from git\'s view of the path');
    }
    assert.deepEqual(digests[0], digests[1], 'the observation does not depend on what the outside directory holds');
    // a FIFO behind the symlink would block any reader; the check above finished, so nothing opened it
    const fifoDir = path.join(home, 'outsideFifo'); fs.mkdirSync(fifoDir); spawnSync('mkfifo', [path.join(fifoDir, 'data.txt')]);
    const a = assignment(); fs.rmSync(path.join(a.dir, 'libdir'), { recursive: true }); fs.symlinkSync(fifoDir, path.join(a.dir, 'libdir'));
    let fifoTimer;
    const fifoTimeout = new Promise((_, reject) => { fifoTimer = setTimeout(() => reject(new Error('blocked on the outside FIFO')), 60000); });
    let r;
    try {
      r = await Promise.race([check(a), fifoTimeout]);
    } finally {
      clearTimeout(fifoTimer);
    }
    assert.equal(r.ev.source_observation, 'observed');
  });

  // 4. 350 untracked files: 150 are left out of the diff. The receipt counts them all, previews 100, and the artifact lists every one.
  await section('4 350 files, omission artifact', async () => {
    const a = assignment();
    fs.writeFileSync(path.join(a.dir, '.dot-bridge.json'), def({ argv: [NODE, '-e', 'const fs=require("fs");fs.mkdirSync("many");for(let i=0;i<350;i++)fs.writeFileSync("many/f"+String(i).padStart(3,"0")+".txt","x"+i+"\\n")'] }));
    const r = await check(a);
    const om = r.ev.post_run_diff_omissions;
    assert.equal(om.total, 150, JSON.stringify(om).slice(0, 200)); assert.equal(om.preview.length, 100); assert.equal(om.truncated, true);
    assert(r.ev.detail_artifact_id, 'the receipt names the artifact');
    const detail = JSON.parse(ws.artifact(r.ev.detail_artifact_id, a.id).bytes.toString());
    assert.equal(detail.lists.post_run_diff_omissions.length, 150, 'the artifact holds the complete list');
    assert.equal(new Set(detail.lists.post_run_diff_omissions.map(x => x.path)).size, 150);
    assert(detail.lists.post_run_diff_omissions.every(x => x.reason === 'too_many_untracked_files'));
    assert.deepEqual(detail.truncated, {}); assert.equal(r.ev.detail_artifact_truncated, undefined);
    assert.match(r.ev.observed, new RegExp(`left out of the diff; the complete list is in artifact ${r.ev.detail_artifact_id}`));
  });

  // 6. The detail artifact exists only when a list has content, counts its serialized bytes against the cap, and never calls a cut list complete.
  await section('6 detail artifact', async () => {
    assert.equal(boundedDetail({ a: [], b: [] }), null, 'nothing to say, no artifact');
    const big = Array.from({ length: 5000 }, (_, i) => ({ path: `dir/file-${String(i).padStart(5, '0')}.txt`, size: i, reason: 'too_large' }));
    const cut = boundedDetail({ omissions: big, paths: big.map(x => x.path) }, 20000);
    assert(cut.length <= 20000, `serialized size ${cut.length} within the cap`);
    const parsed = JSON.parse(cut.toString());
    assert.equal(parsed.complete, false); assert.match(parsed.note, /^PARTIAL/); assert.doesNotMatch(parsed.note, /complete lists|full list/i);
    assert(parsed.truncated.omissions.kept < 5000 && parsed.truncated.omissions.total === 5000);
    const whole = JSON.parse(boundedDetail({ paths: ['a', 'b'] }).toString());
    assert.equal(whole.complete, true); assert.deepEqual(whole.lists.paths, ['a', 'b']);
    const clean = await check(assignment());
    assert.equal(clean.ev.detail_artifact_id, null, 'a check with nothing to list writes no artifact');
    assert(Number.isInteger(clean.ev.evidence_ms) && clean.ev.evidence_ms >= 0, 'digesting time is reported apart from duration_ms');
  });

  // 7. The receipt sentence about the detail artifact is true when the artifact is cut (12,000 untracked files).
  await section('7 truncated artifact sentence', async () => {
    const a = assignment();
    fs.writeFileSync(path.join(a.dir, '.dot-bridge.json'), def({ argv: [NODE, '-e', 'const fs=require("fs");fs.mkdirSync("bulk");for(let i=0;i<12000;i++)fs.writeFileSync("bulk/file-"+String(i).padStart(6,"0")+".txt","x\\n")'] }));
    const r = await check(a);
    const detail = JSON.parse(ws.artifact(r.ev.detail_artifact_id, a.id).bytes.toString());
    assert.equal(detail.complete, false); assert.match(detail.note, /^PARTIAL/);
    assert(r.ev.detail_artifact_truncated, 'the receipt carries the truncation');
    assert.match(r.ev.observed, new RegExp(`artifact ${r.ev.detail_artifact_id} holds a partial list`));
    assert.doesNotMatch(r.ev.observed, /complete list/);
  });
  // 8. The host user's global ignore and attributes do not hide worker files (CLAUDE.md, secret-*.cjs, **/hidden/).
  await section('8 host global ignore does not hide worker files', async () => {
    const env = gitEnv();
    assert.equal(env.GIT_CONFIG_COUNT, '4'); assert.equal(env.GIT_CONFIG_KEY_2, 'core.excludesFile'); assert.equal(env.GIT_CONFIG_VALUE_2, '/dev/null');
    assert.equal(env.GIT_CONFIG_KEY_3, 'core.attributesFile'); assert.equal(env.GIT_CONFIG_VALUE_3, '/dev/null'); assert.equal(env.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME, 'the user\'s XDG config is not replaced');
    const a = assignment();
    const before = await check(a);
    fs.mkdirSync(path.join(a.dir, 'tests/hidden'), { recursive: true });
    fs.writeFileSync(path.join(a.dir, 'CLAUDE.md'), 'x\n'); fs.writeFileSync(path.join(a.dir, 'secret-evil.cjs'), 'x\n'); fs.writeFileSync(path.join(a.dir, 'tests/hidden/evil.test.cjs'), 'x\n');
    const after = await check(a);
    assert.notEqual(tree(before.ev), tree(after.ev), 'the digest changes');
    for (const f of ['CLAUDE.md', 'secret-evil.cjs', 'tests/hidden/evil.test.cjs']) assert(names(after.ev.changed_paths).includes(f), `${f} is in the changed paths`);
    assert(ws.diff(a.dir, base).patch.includes('secret-evil.cjs'), 'and in the diff');
    assert.equal(after.ev.candidate_differs_from_base, true);
  });
  // 9 and 10. The stop text follows the recorded stops; an unverified install stop means the check input is not recorded as observed.
  await section('9 stop text; 10 install stop unverified', async () => {
    const withInstall = () => { const a = assignment(); fs.writeFileSync(path.join(a.dir, '.dot-bridge.json'), def({ install_argv: [NODE, '-e', '0'], argv: [NODE, 'run.cjs'] })); return a; };
    const good = await check(withInstall());
    assert.match(good.ev.claims.trusted_bridge_execution, /Stop verified for every phase\./); assert.equal(good.ev.source_observation, 'observed');
    process.env.DOT_BRIDGE_TEST_STOP = 'unverified';
    try {
      const bad = await check(withInstall());
      assert(bad.row, 'the check row is kept');
      assert.match(bad.ev.claims.trusted_bridge_execution, /Stop NOT verified: install \(test_forced_unverified\)/); assert.doesNotMatch(bad.ev.claims.trusted_bridge_execution, /Stop verified/);
      assert.equal(bad.ev.source_observation, 'unavailable'); assert.equal(bad.ev.input_tree_sha256, null); assert.equal(bad.ev.input_tree_unavailable, 'install_stop_unverified');
      assert.equal(bad.ev.input_diff_sha256, null); assert.notEqual(bad.ev.candidate_differs_from_base, false);
    } finally { delete process.env.DOT_BRIDGE_TEST_STOP; }
  });
  // 11. matches_current_diff survives as a deprecated alias.
  await section('11 matches_current_diff alias', async () => {
    const a = assignment(); await check(a);
    const c = ws.result(a.id, a.claim, 'subject').checks[0];
    assert.equal(c.applies_to_current_diff, true); assert.equal(c.matches_current_diff, c.applies_to_current_diff);
    fs.writeFileSync(path.join(a.dir, 'new.txt'), 'x\n');
    const stale = ws.result(a.id, a.claim, 'subject').checks[0];
    assert.equal(stale.matches_current_diff, false); assert.equal(stale.applies_to_current_diff, false);
  });
  // 12. Index flags, a missing index, an unreadable untracked directory: unavailable, never a clean digest.
  await section('12 index flags, missing index, unreadable untracked dir', async () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const a = assignment(); run('git', ['-C', a.dir, 'update-index', flag, 'run.cjs']);
      const r = await check(a); assert.equal(r.ev.source_observation, 'unavailable'); assert.equal(r.ev.input_tree_unavailable, 'index_flags_present', flag);
    }
    const b = assignment(); const indexFile = path.resolve(b.dir, run('git', ['-C', b.dir, 'rev-parse', '--git-path', 'index']));
    fs.renameSync(indexFile, `${indexFile}.away`);
    try { const t = await treeDigest(b.dir); assert.equal(t.sha256, null); assert.match(t.reason, /^index_copy_failed/); } finally { fs.renameSync(`${indexFile}.away`, indexFile); }
    const c = assignment(); fs.mkdirSync(path.join(c.dir, 'private')); fs.writeFileSync(path.join(c.dir, 'private/x.txt'), 'x\n'); fs.chmodSync(path.join(c.dir, 'private'), 0);
    try { const r = await check(c); assert.equal(r.ev.source_observation, 'unavailable'); assert.equal(r.ev.input_tree_unavailable, 'partial_unreadable_untracked'); } finally { fs.chmodSync(path.join(c.dir, 'private'), 0o700); }
  });
  // 13. apply_patch lists ignored paths it wrote; scratch sweep; about 30k untracked files do not throw; the runtime is recorded.
  await section('13 ignored worker writes, scratch sweep, 30k files, runtime', async () => {
    const a = assignment();
    ws.apply(a.id, a.claim, 'subject', 'diff --git a/ignored.cjs b/ignored.cjs\nnew file mode 100644\n--- /dev/null\n+++ b/ignored.cjs\n@@ -0,0 +1 @@\n+console.log("WORKER_WROTE_IGNORED");\n');
    const r = await check(a);
    assert(r.text.includes('BEFORE') || r.text.includes('WORKER_WROTE_IGNORED'));
    assert.deepEqual(r.ev.worker_written_ignored_paths.preview, ['ignored.cjs']);
    assert.equal(r.ev.runtime.node, process.version); assert.match(r.ev.runtime.bwrap, /bubblewrap/);
    const stale = path.join(home, 'work/run/digest-stale'), fresh = path.join(home, 'work/run/digest-fresh');
    fs.mkdirSync(stale, { recursive: true }); fs.mkdirSync(fresh, { recursive: true }); const old = new Date(Date.now() - 2 * 3600000); fs.utimesSync(stale, old, old);
    assert.equal(ws.sweepDigestScratch(), 1); assert(!fs.existsSync(stale) && fs.existsSync(fresh)); fs.rmSync(fresh, { recursive: true });
    const big = assignment(); fs.mkdirSync(path.join(big.dir, 'lots'));
    for (let i = 0; i < 30000; i++) fs.writeFileSync(path.join(big.dir, 'lots', `f${i}.txt`), '');
    const d = ws.diff(big.dir, base); assert(d.omissions.length >= 29800, `omissions ${d.omissions.length}`);
    for (const word of ['eol', 'ident', 'nested repositories', 'submodule']) assert(NOT_IDENTIFIED.includes(word), `not_identified names ${word}`);
  });

  // 14. A same-size edit made in the same clock second as the index write is still seen once the clock moves on. Git's racy-stat rule needs
  // the index mtime kept on the copy; stamped "now" the copy makes the unchanged-looking entry trusted. Deterministic: the edit must land in the
  // index's own second (retried until it does), and the digest is taken 1.1 s later.
  await section('14 same-second same-size edit', async () => {
    let proven = 0;
    for (let i = 0; i < 25 && proven < 2; i++) {
      const a = assignment();
      const file = path.join(a.dir, 'node_modules/tracked.cjs'), indexFile = path.resolve(a.dir, run('git', ['-C', a.dir, 'rev-parse', '--git-path', 'index']));
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('TRACKED_V1', 'TRACKED_V2'));
      if (Math.floor(fs.statSync(file).mtimeMs / 1000) !== Math.floor(fs.statSync(indexFile).mtimeMs / 1000)) continue; // not the racy case: try again
      proven++;
      await sleep(1100);
      const t = await treeDigest(a.dir);
      assert.notEqual(t.sha256, run('git', ['-C', a.dir, 'rev-parse', `${base}^{tree}`]), `attempt ${i}: the edit is in the observation`);
    }
    assert(proven >= 1, 'the racy case was produced at least once');
  });

  // 15. The token lookup in the askpass still sees the user's XDG config (gh reads $XDG_CONFIG_HOME/gh/hosts.yml). Only status and length are checked.
  await section('15 askpass token lookup sees XDG config', async () => {
    const xdg = path.join(home, 'xdg-user'), bin = path.join(home, 'fakebin');
    fs.mkdirSync(path.join(xdg, 'gh'), { recursive: true }); fs.mkdirSync(bin, { recursive: true });
    const secret = 'fake-token-0123456789';
    fs.writeFileSync(path.join(xdg, 'gh/hosts.yml'), `github.com:\n  oauth_token: ${secret}\n`);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "auth token" ] || exit 2\nf="$XDG_CONFIG_HOME/gh/hosts.yml"\n[ -r "$f" ] || exit 1\nsed -n \'s/^ *oauth_token: *//p\' "$f"\n', { mode: 0o755 });
    const saved = { x: process.env.XDG_CONFIG_HOME, p: process.env.PATH };
    process.env.XDG_CONFIG_HOME = xdg; process.env.PATH = `${bin}:${process.env.PATH}`;
    try {
      const env = gitEnv(hostGitEnv());
      assert.equal(env.XDG_CONFIG_HOME, xdg, 'gitEnv leaves XDG_CONFIG_HOME alone');
      const r = spawnSync(env.GIT_ASKPASS, ['Password for github.com'], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, 'the lookup succeeded'); assert.equal(r.stdout.trim().length, secret.length, 'and returned a token of the expected length');
    } finally { if (saved.x === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.x; process.env.PATH = saved.p; }
  });
  // 16. The stop hook runs the real verification (and sweep) first; an unverified check stop makes the post-run observation unavailable;
  // a failed check-ignore is recorded, not read as "none ignored".
  await section('16 stop hook, check-phase stop, check-ignore failure', async () => {
    const a = assignment();
    fs.writeFileSync(path.join(a.dir, '.dot-bridge.json'), def({ install_argv: [NODE, '-e', '0'], argv: [NODE, '-e', 'const {spawn}=require("child_process");spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"ignore"}).unref();'] }));
    process.env.DOT_BRIDGE_TEST_STOP = 'check-unverified';
    try {
      const r = await check(a);
      assert.equal(r.ev.sandbox_stop.check.verified, false); assert.equal(r.ev.sandbox_stop.check.reason, 'test_forced_unverified');
      assert.equal(r.ev.sandbox_stop.install.verified, true);
      const leftover = spawnSync('ps', ['-eo', 'pid=,args=']).stdout.toString().split('\n').filter(l => l.includes('setTimeout(()=>{},30000)') && !l.includes('ps -eo'));
      assert.deepEqual(leftover, [], 'the real verification ran: the leftover process was not left alive');
      assert.equal(r.ev.source_observation, 'unavailable'); assert.equal(r.ev.post_run_tree_unavailable, 'check_stop_unverified'); assert.equal(r.ev.post_run_diff_error, 'check_stop_unverified');
      assert.equal(r.ev.tree_mutated_by_check, null); assert.match(r.ev.claims.trusted_bridge_execution, /Stop NOT verified: check \(test_forced_unverified\)/);
    } finally { delete process.env.DOT_BRIDGE_TEST_STOP; }
    const b = assignment();
    ws.noteIgnoredWritten(b.id, b.dir, ['../outside-the-repository']);
    const c = await check(b);
    assert.match(c.ev.worker_written_ignored_paths_unavailable, /^git_check_ignore_failed/); assert.deepEqual(c.ev.worker_written_ignored_paths.preview, []);
  });

  // 5. pid identity: a process outside both scopes is never counted or killed, even if it carries the recorded init pid number.
  await section('5 pid identity', async () => {
    const sleeper = spawn('/usr/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
    const text = fs.readFileSync(`/proc/${sleeper.pid}/stat`, 'utf8'), start = Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[19]);
    const kills = [];
    try {
      // recorded init has this pid number but another start time: the old pid-only rule counted it
      assert.deepEqual(remainingProcesses({ nsInode: null, pgid: null, initPid: sleeper.pid, init: { pid: sleeper.pid, start: start + 1000 } }), [], 'same pid number, different process');
      assert.equal(remainingProcesses({ nsInode: null, pgid: null, init: { pid: sleeper.pid, start } })[0]?.reason, 'namespace_init_alive', 'the exact recorded init is counted');
      // a process that started before the sandbox cannot belong to it
      assert.deepEqual(remainingProcesses({ nsInode: null, pgid: sleeper.pid, sandboxStart: start + 1000 }), [], 'older than the sandbox');
      assert.equal(remainingProcesses({ nsInode: null, pgid: sleeper.pid, sandboxStart: start }).length, 1, 'same group and not older: counted');
      // cleanup with a mismatched identity: nothing is counted or signalled
      const stopped = await verifyStopped({ nsInode: null, pgid: null, initPid: sleeper.pid, init: { pid: sleeper.pid, start: start + 1000 }, graceMs: 50, sweepMs: 50 });
      assert.equal(stopped.verified, true); assert.deepEqual(stopped.swept, []);
      assert.doesNotThrow(() => process.kill(sleeper.pid, 0), 'the unrelated process is alive');
      // a stale entry (found earlier under that pid) is re-checked before the kill: the start time must match
      const stale = await verifyStopped({ nsInode: null, pgid: sleeper.pid, graceMs: 20, sweepMs: 20, scan: () => [{ pid: sleeper.pid, start: start + 5, reason: 'in_process_group' }], signal: entries => { kills.push(...entries.map(entry => [entry.pid, 'SIGKILL'])); return entries.map(entry => entry.pid); } });
      assert.deepEqual(kills, [], 'no kill for an entry whose start time no longer matches'); assert.equal(stale.verified, false);
      assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
    } finally { try { process.kill(sleeper.pid, 'SIGKILL'); } catch {} }
  });
  for (const [name, status] of results) console.log(`${status.startsWith('PASS') ? 'PASS' : 'FAIL'} ${name}${status.startsWith('PASS') ? '' : ' -- ' + status}`);
  if (results.some(r => r[1] !== 'PASS')) process.exitCode = 1; else console.log('receipt-repair-test: PASS');
} finally { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); }
