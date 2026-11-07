#!/usr/bin/env node
import './require-host-sandbox.mjs';
// run_check executes repository code. It must not widen what the job may change or see. The budgeted host backend runs the check in a
// private copy and exports nothing back, so a check's writes never reach the job's worktree:
//   T1 implementation job: a check that writes or edits files outside scope_paths changes nothing in the worktree or the patch; the
//      scope guard still refuses workspace_result and finish with scope_violation for a stray out-of-scope change made directly.
//   T2 read-only job with output_paths: the restore applied to a dirtied worktree keeps only the output files.
//   T3 sensitive committed files (the submission-policy deny rules) read as empty inside the check, in the install and the check phase.
//   T4 the npm cache is private to each check run: nothing a check writes there reaches the host's shared cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeOwnerHostChecks } from './lib/owner-host-checks.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-check-scope-'));
process.env.HOME = home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'work');
const { Store } = await import('../src/store.mjs');
const { prepareGithubRepo } = await import('../src/projects.mjs');
const workspaceModule = await import('../src/workspace.mjs');
const { Workspace, treeDigest, writableScope, restoreOutsideWritable } = workspaceModule;
const run = (cmd, args, cwd) => { const x = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr || x.stdout); return x.stdout.trim(); };
const NODE = '/runtime/node', NODE_HOST = process.execPath;
const want = id => !process.env.ONLY || process.env.ONLY === id; // ONLY=T3 runs one block
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WRITER = `const fs=require('fs');
fs.mkdirSync('.github/workflows',{recursive:true});
fs.writeFileSync('.github/workflows/evil.yml','on: push\\n');
fs.appendFileSync('.github/workflows/ci.yml','# evil\\n');
fs.writeFileSync('package.json','{"scripts":{"postinstall":"evil"}}');
fs.unlinkSync('README.md');
fs.chmodSync('scripts/run.sh',0o644);
fs.rmSync('docs',{recursive:true});fs.symlinkSync('/etc','docs');
fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/generated.js','module.exports=1;\\n');
fs.mkdirSync('notes',{recursive:true});fs.writeFileSync('notes/out.md','output\\n');
console.log('WRITER_RAN');
`;
const BASE_FILES = {
  'package.json': '{"name":"fixture","scripts":{}}\n', 'README.md': 'readme\n', 'src/app.js': 'module.exports=0;\n', 'test/in-scope.test.js': 'console.log("base");\n',
  'test/write.test.js': WRITER, '.github/workflows/ci.yml': 'name: ci\n', 'docs/note.md': 'note\n', 'scripts/run.sh': '#!/bin/sh\necho hi\n',
  '.env': 'SECRET_A=abc\n', 'keys/server.pem': 'PEM-BODY\n', 'config/credentials.json': '{"k":"v"}\n', 'src/auth.js': 'module.exports="not sensitive: a code file";\n',
  '.dot-bridge.json': JSON.stringify({ checks: { default: { argv: [NODE, 'test/in-scope.test.js'], timeout_ms: 30000, output_bytes: 65536 }, write: { argv: [NODE, 'test/write.test.js'], timeout_ms: 30000, output_bytes: 65536 } } }),
};
const repo = path.join(home, 'repo');
fs.mkdirSync(repo);
run('git', ['init', '-q'], repo); run('git', ['config', 'user.email', 't@example.com'], repo); run('git', ['config', 'user.name', 'T'], repo);
for (const [file, text] of Object.entries(BASE_FILES)) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); }
fs.chmodSync(path.join(repo, 'scripts/run.sh'), 0o755);
run('git', ['add', '.'], repo); run('git', ['commit', '-qm', 'base'], repo);
const base = run('git', ['rev-parse', 'HEAD'], repo);
// A second base: tracked files under generated-directory names, and a tracked file whose name is not UTF-8.
const RAW_TRACKED = Buffer.from('trk\xe9.txt', 'latin1');
for (const [file, text] of Object.entries({ 'target/t.txt': 'tt\n', 'target/gone.txt': 'gone\n', 'vendor/node_modules/pkg/index.js': 'pkg\n', 'tools/__pycache__/x.py': 'x\n' })) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); }
fs.writeFileSync(Buffer.concat([Buffer.from(repo + '/'), RAW_TRACKED]), 'raw tracked\n');
const GEN_WRITER = 'const fs=require("fs");for(const f of ["target/t.txt","vendor/node_modules/pkg/index.js","tools/__pycache__/x.py"])if(fs.existsSync(f))fs.appendFileSync(f,"evil\\n");fs.unlinkSync("target/gone.txt");fs.mkdirSync("target/new",{recursive:true});fs.writeFileSync("target/new/out.txt","untracked build output\\n")';
const RAW_WRITER = 'const fs=require("fs");fs.writeFileSync(Buffer.from("lat\\xe9.txt","latin1"),"x");fs.appendFileSync(Buffer.from("trk\\xe9.txt","latin1"),"evil\\n")';
fs.mkdirSync(path.join(repo, 'ci'));
fs.writeFileSync(path.join(repo, 'ci/gen-writer.js'), GEN_WRITER); fs.writeFileSync(path.join(repo, 'ci/raw-writer.js'), RAW_WRITER);
fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: { gen: { argv: [NODE, 'ci/gen-writer.js'], timeout_ms: 30000, output_bytes: 65536 }, raw: { argv: [NODE, 'ci/raw-writer.js'], timeout_ms: 30000, output_bytes: 65536 } } }));
run('git', ['add', '-A'], repo); run('git', ['commit', '-qm', 'base2'], repo);
const base2 = run('git', ['rev-parse', 'HEAD'], repo);
process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
const OWNER_CHECKS = {
  default: { argv: [NODE, 'test/in-scope.test.js'], timeout_ms: 30000, output_bytes: 65536 }, write: { argv: [NODE, 'test/write.test.js'], timeout_ms: 30000, output_bytes: 65536 },
  gen: { argv: [NODE, 'ci/gen-writer.js'], timeout_ms: 30000, output_bytes: 65536 }, raw: { argv: [NODE, 'ci/raw-writer.js'], timeout_ms: 30000, output_bytes: 65536 },
};
const setOwnerChecks = overrides => writeOwnerHostChecks(home, 'example-owner/fixture', { ...OWNER_CHECKS, ...overrides });
setOwnerChecks({});
const store = new Store(path.join(home, 'db.sqlite'));
const ws = new Workspace(store);

function open(extra, review = false) {
  const id = `req_${randomUUID()}`, payload = { schema_version: 1, request_id: id, brief: 'fixture', inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }], expected_output: 'patch', execution_scope: 'implementation', ...extra };
  store.submit(payload, 'thread', 'environment', 'owner', review, null, 'normal', null, payload, null, null, null);
  const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
  // The local mirror holds the commits pinned so far; a job pinned to a later commit needs it fetched first.
  if (extra.inputs) prepareGithubRepo(extra.inputs[0], { worker: 'dot' });
  ws.ensure(id, claim, 'subject');
  return { id, claim, dir: path.join(home, 'work/worktrees', id) };
}
async function check(a, checkId = 'default') {
  let r = await ws.check(a.id, a.claim, 'subject', checkId);
  for (let i = 0; i < 1200 && r.status === 'running'; i++) { await sleep(100); const j = store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(r.check_run_id); if (j.status !== 'running') r = { ...r, status: j.status }; }
  const row = store.db.prepare('SELECT * FROM check_runs WHERE id=?').get(r.check_run_id);
  return { r, row, evidence: row ? JSON.parse(row.evidence) : null, text: row ? ws.artifact(row.output_artifact_id, a.id).bytes.toString() : '' };
}
// A one-hunk patch that replaces the whole of `file` (old text must be what the worktree holds).
function replaceFile(a, file, newText) {
  const old = fs.readFileSync(path.join(a.dir, file), 'utf8'), lines = t => t.split('\n').slice(0, -1);
  return ws.apply(a.id, a.claim, 'subject', `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${lines(old).length} +1,${lines(newText).length} @@\n${lines(old).map(l => `-${l}`).join('\n')}\n${lines(newText).map(l => `+${l}`).join('\n')}\n`);
}
const patchFiles = patch => [...patch.matchAll(/^diff --git a\/(.+) b\/\1$/gm)].map(m => m[1]).sort();
const read = (a, file) => fs.readFileSync(path.join(a.dir, file), 'utf8');
const exists = (a, file) => fs.existsSync(path.join(a.dir, file)) || (() => { try { fs.lstatSync(path.join(a.dir, file)); return true; } catch { return false; } })();

try {
  // T1. Implementation job, scope_paths src + test.
  if (want('T1')) {
    // A job with a narrow scope cannot run a host check at all: the executor exposes the whole checkout, so the check is refused
    // before any sandbox starts. The scope guard on result and finish is what protects the patch.
    const narrow = open({ scope_paths: ['src', 'test'] });
    replaceFile(narrow, 'test/in-scope.test.js', WRITER);
    const refused = await check(narrow);
    assert.equal(refused.r.status, 'capability_not_available'); assert.match(refused.r.reason, /scope_paths_read_isolation_unavailable/);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM check_jobs WHERE request_id=?').get(narrow.id).n, 0, 'a refused check starts no job');
    assert.equal(exists(narrow, '.github/workflows/evil.yml'), false);
    // A repo-wide job runs the same modified test in the sandbox.
    const a = open({ scope_paths: ['.'] });
    replaceFile(a, 'test/in-scope.test.js', WRITER);
    const before = ws.result(a.id, a.claim, 'subject');
    assert.deepEqual(patchFiles(before.diff_preview), ['test/in-scope.test.js']);
    const c = await check(a);
    assert.equal(c.evidence.exit_code, 0, JSON.stringify(c.r));
    assert(c.text.includes('WRITER_RAN'), c.text);
    // The check wrote and deleted files everywhere inside its private copy; the worktree still holds exactly the base state.
    assert.equal(exists(a, '.github/workflows/evil.yml'), false, 'an out-of-scope file created by the check never reaches the worktree');
    assert.equal(read(a, '.github/workflows/ci.yml'), 'name: ci\n'); assert.equal(read(a, 'package.json'), BASE_FILES['package.json']);
    assert.equal(read(a, 'README.md'), 'readme\n', 'a file the check deleted is still there');
    assert.equal(fs.statSync(path.join(a.dir, 'scripts/run.sh')).mode & 0o111, 0o111, 'a mode change by the check does not reach the worktree');
    assert.equal(fs.lstatSync(path.join(a.dir, 'docs')).isSymbolicLink(), false, 'a directory swapped for a symlink by the check does not reach the worktree');
    assert.equal(read(a, 'docs/note.md'), 'note\n');
    assert.equal(exists(a, 'notes/out.md'), false);
    assert.equal(exists(a, 'src/generated.js'), false, 'even an in-scope file the check created stays in the private copy');
    assert.equal(read(a, 'test/in-scope.test.js'), WRITER);
    // The patch is exactly what the job had before the check.
    assert.deepEqual(patchFiles(ws.result(a.id, a.claim, 'subject').diff_preview), ['test/in-scope.test.js']);
    assert.deepEqual(patchFiles(ws.snapshot(a.id, a.claim, 'subject').diff_preview), ['test/in-scope.test.js']);
    // Evidence: nothing needed restoring because nothing was exported.
    assert.equal(c.evidence.execution_storage, 'private_tmpfs_copy_not_exported');
    assert.deepEqual(c.evidence.restored_out_of_scope_paths.preview, []);
    assert.equal(c.evidence.scope_restore_error ?? null, null);
    // Backstop: a stray out-of-scope change that reaches the diff refuses result and snapshot (finish) with scope_violation.
    fs.writeFileSync(path.join(narrow.dir, 'stray.txt'), 'x\n'); fs.writeFileSync(path.join(narrow.dir, 'package.json'), '{"changed":true}\n');
    for (const fn of [() => ws.result(narrow.id, narrow.claim, 'subject'), () => ws.snapshot(narrow.id, narrow.claim, 'subject')]) {
      let err = null; try { fn(); } catch (e) { err = e; }
      assert(err, 'out-of-scope change must refuse');
      const body = JSON.parse(err.message);
      assert.equal(body.error, 'scope_violation'); assert.deepEqual(body.paths, ['package.json', 'stray.txt']); assert.match(body.message, /scope_paths/);
    }
    fs.rmSync(path.join(narrow.dir, 'stray.txt')); fs.writeFileSync(path.join(narrow.dir, 'package.json'), BASE_FILES['package.json']);
    assert.deepEqual(patchFiles(ws.result(narrow.id, narrow.claim, 'subject').diff_preview), ['test/in-scope.test.js'], 'refusal clears once the paths are back');
    // node_modules is generated output, not a scope violation.
    fs.mkdirSync(path.join(narrow.dir, 'node_modules/x'), { recursive: true }); fs.writeFileSync(path.join(narrow.dir, 'node_modules/x/i.js'), '1');
    ws.result(narrow.id, narrow.claim, 'subject');
  }

  // T1b. Repo-wide scope: the check's package.json rewrite stays in its private copy too.
  if (want('T1b')) {
    const a = open({ scope_paths: ['.'] });
    const c = await check(a, 'write');
    assert.equal(c.evidence.exit_code, 0, c.text);
    assert.equal(read(a, 'package.json'), BASE_FILES['package.json'], 'the check rewrote package.json only in its private copy');
    assert.deepEqual(c.evidence.restored_out_of_scope_paths.preview, []);
    assert.deepEqual(patchFiles(ws.result(a.id, a.claim, 'subject').diff_preview), []);
  }

  // T1c. A review's diff against base is the PR's files: the scope guard does not apply (finish is never blocked by diff state).
  if (want('T1c')) {
    const a = open({ scope_paths: ['src'] }, true);
    fs.writeFileSync(path.join(a.dir, 'package.json'), '{"pr":true}\n');
    assert(patchFiles(ws.result(a.id, a.claim, 'subject').diff_preview).includes('package.json'));
    ws.snapshot(a.id, a.claim, 'subject');
  }

  // T2. Read-only job with output_paths: run_check stays closed to it (docs/usage.md), and the writable set it would be held to is the
  // output files alone. The restore the check path uses is applied here to a worktree the writer script dirtied on the host.
  if (want('T2')) {
    const a = open({ execution_scope: 'read-only', scope_paths: ['src', 'test'], output_paths: ['notes/out.md'] });
    await assert.rejects(() => ws.check(a.id, a.claim, 'subject', 'write'), /read_only_assignment/);
    const writable = writableScope(store.get(a.id).assignment);
    assert.equal(writable('notes/out.md'), true); assert.equal(writable('src/app.js'), false); assert.equal(writable('package.json'), false);
    assert.equal(writableScope(store.get(open({ scope_paths: ['.'] }).id).assignment), null, 'repo-wide implementation scope is unrestricted');
    fs.mkdirSync(path.join(home, 'scratch'), { recursive: true });
    const scratch = fs.mkdtempSync(path.join(home, 'scratch', 'r-'));
    const pre = await treeDigest(a.dir, scratch);
    run(NODE_HOST, ['test/write.test.js'], a.dir);
    const restored = await restoreOutsideWritable({ dir: a.dir, scratch, preTree: pre.sha256, writable });
    assert.equal(restored.error, null);
    assert.equal(read(a, 'notes/out.md'), 'output\n', 'the declared output file survives');
    assert.equal(exists(a, 'src/generated.js'), false, 'read-only: even a path under scope_paths is not kept');
    assert.equal(exists(a, '.github/workflows/evil.yml'), false); assert.equal(read(a, 'package.json'), BASE_FILES['package.json']); assert.equal(read(a, 'README.md'), 'readme\n');
    assert.equal(fs.lstatSync(path.join(a.dir, 'docs')).isSymbolicLink(), false);
    assert(restored.paths.includes('src/generated.js') && restored.paths.includes('package.json') && !restored.paths.includes('notes/out.md'), restored.paths.join());
    assert.deepEqual(patchFiles(ws.result(a.id, a.claim, 'subject').diff_preview), ['notes/out.md'], 'only the output file reaches the patch');
  }

  // T5 (GAP-1). Tracked files under node_modules, target, .venv-style and __pycache__ names are still tracked files: a check that edits or
  // deletes them outside scope_paths is restored, and a stray change to one refuses with scope_violation. Only untracked output is exempt.
  if (want('T5')) {
    const a = open({ scope_paths: ['.'], inputs: [{ github_repo: 'example-owner/fixture', base_sha: base2 }] });
    const names = ['target/t.txt', 'target/gone.txt', 'vendor/node_modules/pkg/index.js', 'tools/__pycache__/x.py'];
    const c = await check(a, 'gen');
    assert.equal(c.evidence.exit_code, 0, c.text);
    assert.equal(read(a, 'target/t.txt'), 'tt\n'); assert.equal(read(a, 'target/gone.txt'), 'gone\n');
    assert.equal(read(a, 'vendor/node_modules/pkg/index.js'), 'pkg\n'); assert.equal(read(a, 'tools/__pycache__/x.py'), 'x\n');
    assert.deepEqual(c.evidence.restored_out_of_scope_paths.preview, [], 'the check edited these in its private copy; nothing was exported, so nothing needed restoring');
    assert.equal(c.evidence.scope_restore_error ?? null, null);
    assert.equal(exists(a, 'target/new/out.txt'), false, 'untracked build output stays in the private copy');
    assert.deepEqual(patchFiles(ws.result(a.id, a.claim, 'subject').diff_preview), [], 'the patch is empty');
    // Backstop on a narrow-scope job (which cannot run a check): modify and delete each of the four names directly.
    const n = open({ scope_paths: ['src', 'test'], inputs: [{ github_repo: 'example-owner/fixture', base_sha: base2 }] });
    for (const name of names) {
      fs.appendFileSync(path.join(n.dir, name), 'x\n');
      assert.throws(() => ws.result(n.id, n.claim, 'subject'), e => JSON.parse(e.message).error === 'scope_violation' && JSON.parse(e.message).paths.includes(name), `modify ${name}`);
      assert.throws(() => ws.snapshot(n.id, n.claim, 'subject'), /scope_violation/);
      fs.rmSync(path.join(n.dir, name));
      assert.throws(() => ws.result(n.id, n.claim, 'subject'), e => JSON.parse(e.message).paths.includes(name), `delete ${name}`);
      run('git', ['checkout', '--', name], n.dir);
    }
    ws.result(n.id, n.claim, 'subject');
  }

  // T6 (GAP-3). File names are bytes. A non-UTF-8 name, untracked or tracked, is restored; one that cannot be restored refuses.
  if (want('T6')) {
    const a = open({ scope_paths: ['.'], inputs: [{ github_repo: 'example-owner/fixture', base_sha: base2 }] });
    const c = await check(a, 'raw');
    assert.equal(c.evidence.exit_code, 0, c.text);
    const rawPath = name => Buffer.concat([Buffer.from(a.dir + '/'), Buffer.from(name, 'latin1')]);
    assert.equal(fs.existsSync(rawPath('lat\xe9.txt')), false, 'the untracked non-UTF-8 file is removed');
    assert.equal(fs.readFileSync(rawPath('trk\xe9.txt'), 'utf8'), 'raw tracked\n', 'the tracked non-UTF-8 file is restored');
    assert.equal(c.evidence.restored_out_of_scope_paths.total, 0, JSON.stringify(c.evidence.restored_out_of_scope_paths));
    assert.equal(c.evidence.scope_restore_error ?? null, null);
    ws.result(a.id, a.claim, 'subject');
    assert.equal(fs.readFileSync(rawPath('trk\xe9.txt'), 'utf8'), 'raw tracked\n');
    const n = open({ scope_paths: ['src', 'test'], inputs: [{ github_repo: 'example-owner/fixture', base_sha: base2 }] });
    const rawPathN = name => Buffer.concat([Buffer.from(n.dir + '/'), Buffer.from(name, 'latin1')]);
    // Never skipped silently: a stray untracked or modified non-UTF-8 name refuses result and finish.
    for (const touch of [() => fs.writeFileSync(rawPathN('stray\xff.txt'), 'x'), () => fs.appendFileSync(rawPathN('trk\xe9.txt'), 'x')]) {
      touch();
      for (const fn of [() => ws.result(n.id, n.claim, 'subject'), () => ws.snapshot(n.id, n.claim, 'subject')]) assert.throws(fn, e => { const b = JSON.parse(e.message); return b.error === 'scope_violation' && b.paths.length === 1; });
      fs.rmSync(rawPathN('stray\xff.txt'), { force: true }); fs.writeFileSync(rawPathN('trk\xe9.txt'), 'raw tracked\n');
    }
    // A job that is stuck says so and names the owner action.
    fs.writeFileSync(path.join(n.dir, 'stray.txt'), 'x');
    assert.throws(() => ws.result(n.id, n.claim, 'subject'), e => /stuck/.test(JSON.parse(e.message).message) && /cancel and resubmit/.test(JSON.parse(e.message).message));
  }

  // T3. Sensitive committed files read as empty, in both phases; other files and code files read normally.
  if (want('T3')) {
    const a = open({ scope_paths: ['.'] });
    const probe = `const fs=require('fs');const len=f=>fs.readFileSync(f).length;let w='ok';try{fs.writeFileSync('.env','changed')}catch(e){w=e.code}`;
    setOwnerChecks({ default: {
      install_argv: [NODE, '-e', `${probe};fs.writeFileSync('/cache/seen',['install',len('.env'),len('keys/server.pem'),len('config/credentials.json'),len('src/auth.js')>0].join(' '))`],
      argv: [NODE, '-e', `${probe};console.log(fs.readFileSync('/cache/seen','utf8'));console.log(['check',len('.env'),len('keys/server.pem'),len('config/credentials.json'),len('src/auth.js')>0,len('README.md')>0,'write:'+w].join(' '))`],
      timeout_ms: 30000, output_bytes: 65536 } });
    const c = await check(a);
    assert.equal(c.evidence.exit_code, 0, c.text);
    assert.match(c.text, /^install 0 0 0 true$/m, c.text);
    assert.match(c.text, /^check 0 0 0 true true write:(EROFS|EACCES|EBUSY|EPERM)$/m, c.text);
    assert.equal(read(a, '.env'), 'SECRET_A=abc\n', 'the host file is untouched');
    const masked = c.evidence.masked_sensitive_paths;
    assert.deepEqual(masked.preview, ['.env', 'config/credentials.json', 'keys/server.pem']); assert.equal(masked.total, 3);
    assert.match(c.evidence.observed, /3 sensitive path\(s\) were masked/);
  }

  // T4. The cache is private to one check run: the install phase can fill it for the check phase, and nothing reaches the host's shared cache.
  if (want('T4')) {
    const a = open({ scope_paths: ['.'] });
    setOwnerChecks({ default: {
      install_argv: [NODE, '-e', 'const fs=require("fs");fs.mkdirSync("/cache/npm/_cacache",{recursive:true});fs.writeFileSync("/cache/npm/_cacache/marker","ok")'],
      argv: [NODE, '-e', 'const fs=require("fs");fs.writeFileSync("/cache/npm/_cacache/second","y");console.log("marker="+fs.readFileSync("/cache/npm/_cacache/marker","utf8"))'],
      timeout_ms: 30000, output_bytes: 65536 } });
    const c = await check(a);
    assert.equal(c.evidence.exit_code, 0, c.text);
    assert.match(c.text, /marker=ok/, c.text);
    const shared = path.join(home, 'work/caches/shared/npm');
    assert.equal(fs.existsSync(shared) && fs.readdirSync(shared).some(dir => fs.existsSync(path.join(shared, dir, 'marker')) || fs.existsSync(path.join(shared, dir, 'second'))), false, 'nothing the check wrote reached a host cache');
  }
  console.log('check-scope-confinement-test: PASS');
} finally { fs.rmSync(home, { recursive: true, force: true }); }
