#!/usr/bin/env node
// `dalan apply` and the adapter's read-only applied check: digest, base ancestry, git apply --check, then the applied decision.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, baseProblem, detectPresentPatches, listPatchFiles, patchMatchesWorktree, readMaterializeGrant } from '../src/patch-apply.mjs';
import { startAdapter } from './acp-client.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
const git = (dir, ...a) => { const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const repo = name => { const d = path.join(base, name); fs.mkdirSync(d); git(d, 'init', '-q', '-b', 'main'); return d; };
const write = (d, f, text) => fs.writeFileSync(path.join(d, f), text);
const commit = (d, msg) => { git(d, 'add', '-A'); git(d, 'commit', '-qm', msg); return git(d, 'rev-parse', 'HEAD'); };
const sha = b => createHash('sha256').update(b).digest('hex');

// A checkout at BASE, and the patch the worker would build there (a.txt one -> uno, plus a new file).
const main = repo('main'); write(main, 'a.txt', 'one\ntwo\n'); const BASE = commit(main, 'base');
write(main, 'a.txt', 'uno\ntwo\n'); write(main, 'new.txt', 'hello\n'); git(main, 'add', '-A');
const PATCH = Buffer.from(git(main, 'diff', '--cached', '--binary') + '\n'); git(main, 'reset', '-q', '--hard');
assert.match(PATCH.toString(), /diff --git a\/a.txt b\/a.txt/);

// A benign rename must record both sides so rollback can restore the old file.
const renameRepo = repo('rename-snapshot');
write(renameRepo, 'before name.txt', 'fixture content\n');
commit(renameRepo, 'original');
git(renameRepo, 'mv', 'before name.txt', 'after name.txt');
const renamePatch = Buffer.from(git(renameRepo, 'diff', '--cached', '-M') + '\n');
assert.deepEqual(listPatchFiles(renameRepo, renamePatch).sort(), ['after name.txt', 'before name.txt']);

// Simulate extra permission flags in stat metadata only; no special mode is set on disk.
if (typeof process.getuid === 'function') {
  const grant = path.join(renameRepo, 'fixture-grant.json');
  fs.writeFileSync(grant, JSON.stringify({ grant: ['repo:fixture/repo'], mode: 'standing' }), { mode: 0o600 });
  assert.equal(readMaterializeGrant(grant).mode, 'standing');
  const stat = fs.fstatSync;
  try {
    for (const bit of [0o4000, 0o2000, 0o1000]) {
      fs.fstatSync = fd => {
        const info = stat(fd);
        return { size: info.size, uid: info.uid, mode: info.mode | bit, isFile: () => info.isFile() };
      };
      assert.throws(() => readMaterializeGrant(grant), { local_code: 'materialize_grant_unsafe' });
    }
  } finally {
    fs.fstatSync = stat;
  }
}

// Root-relative patches must work even when the caller is inside the checkout.
const nested = repo('nested'); write(nested, 'a.txt', 'one\ntwo\n'); const NBASE = commit(nested, 'base');
const subdir = path.join(nested, 'sub', 'deep'); fs.mkdirSync(subdir, { recursive: true });
const nestedBuilds = [{ rid: 'req_nested', observed: false }];
const nestedHooks = { fetchPatch: async () => PATCH };
const beforeApplied = patchMatchesWorktree(subdir, PATCH);
const beforeDetected = await detectPresentPatches(nestedBuilds, subdir, nestedHooks);
const nestedFiles = applyPatch({ dir: subdir, patch: PATCH, sha256: sha(PATCH), baseSha: NBASE });
assert.deepEqual({
  beforeApplied, beforeDetected,
  rootContent: fs.readFileSync(path.join(nested, 'a.txt'), 'utf8'),
  newContent: fs.existsSync(path.join(nested, 'new.txt')) ? fs.readFileSync(path.join(nested, 'new.txt'), 'utf8') : null,
  files: nestedFiles.sort(),
}, {
  beforeApplied: false, beforeDetected: [],
  rootContent: 'uno\ntwo\n', newContent: 'hello\n', files: ['a.txt', 'new.txt'],
}, 'subdirectory calls must not report skipped root-relative paths as applied');
assert.equal(patchMatchesWorktree(subdir, PATCH), true);
assert.deepEqual(await detectPresentPatches(nestedBuilds, subdir, nestedHooks), ['req_nested']);
assert.deepEqual(await detectPresentPatches(nestedBuilds, subdir, nestedHooks), []);

// ---- module
assert.equal(patchMatchesWorktree(main, PATCH), false, 'not applied yet');
assert.equal(patchMatchesWorktree(main, Buffer.alloc(0)), false, 'an empty patch is never applied');
assert.throws(() => applyPatch({ dir: main, patch: PATCH, sha256: sha('other'), baseSha: BASE }), /sha256 does not match/);
assert.equal(fs.readFileSync(path.join(main, 'a.txt'), 'utf8'), 'one\ntwo\n', 'a digest mismatch touches nothing');
assert.throws(() => applyPatch({ dir: main, patch: PATCH, sha256: sha(PATCH), baseSha: null }), /no base commit/);
// a descendant of the base is fine; a divergent or unrelated checkout is refused with the reason
const desc = repo('desc'); write(desc, 'a.txt', 'one\ntwo\n'); commit(desc, 'desc base'); write(desc, 'later.txt', 'x\n'); const DESC_HEAD = commit(desc, 'later');
const forked = git(desc, 'rev-parse', 'HEAD~1'); // desc's own base has the same tree but is another commit than BASE
assert.match(baseProblem(desc, BASE) ?? '', /not in this checkout/, 'unknown base');
git(main, 'fetch', '-q', desc, 'main'); // now both lines are in main's object store
git(main, 'checkout', '-q', '-b', 'other', forked); write(main, 'o.txt', 'o\n'); commit(main, 'other line');
assert.match(baseProblem(main, DESC_HEAD) ?? '', /not an ancestor of HEAD/, 'divergent history');
assert.throws(() => applyPatch({ dir: main, patch: PATCH, sha256: sha(PATCH), baseSha: DESC_HEAD }), /not applied: base .* is not an ancestor/);
git(main, 'checkout', '-q', 'main');
const stack = repo('stack'); write(stack, 'a.txt', 'one\ntwo\n'); const SBASE = commit(stack, 'base'); write(stack, 'b.txt', 'b\n'); commit(stack, 'descendant');
const files = applyPatch({ dir: stack, patch: PATCH, sha256: sha(PATCH), baseSha: SBASE });
assert.deepEqual(files.sort(), ['a.txt', 'new.txt']); assert.equal(fs.readFileSync(path.join(stack, 'a.txt'), 'utf8'), 'uno\ntwo\n');
assert.equal(patchMatchesWorktree(stack, PATCH), true, 'the reverse check sees the applied patch');
git(stack, 'checkout', '-q', '--', '.'); git(stack, 'clean', '-fdq'); assert.equal(patchMatchesWorktree(stack, PATCH), false);
// a patch that no longer applies cleanly is refused before anything changes
const clash = repo('clash'); write(clash, 'a.txt', 'one\ntwo\n'); const CBASE = commit(clash, 'base'); write(clash, 'a.txt', 'ONE\ntwo\n'); commit(clash, 'conflicting edit');
assert.throws(() => applyPatch({ dir: clash, patch: PATCH, sha256: sha(PATCH), baseSha: CBASE }), /git apply --check failed/);
assert.equal(fs.existsSync(path.join(clash, 'new.txt')), false, 'a failed check applies nothing');

// A write that fails part-way leaves the tree byte-identical: a.txt is written first, then sub/b.txt cannot be (a read-only
// directory). Without the snapshot-and-restore, a.txt keeps its new content and the tree is half applied.
if (process.getuid?.() !== 0) {
  const half = repo('half'); fs.mkdirSync(path.join(half, 'sub')); write(half, 'a.txt', 'one\n'); write(half, 'sub/b.txt', 'bee\n'); write(half, 'z.txt', 'zed\n'); const HBASE = commit(half, 'base');
  write(half, 'a.txt', 'uno\n'); write(half, 'sub/b.txt', 'abeja\n'); write(half, 'sub/c.txt', 'new\n'); fs.rmSync(path.join(half, 'z.txt')); git(half, 'add', '-A');
  const HPATCH = Buffer.from(git(half, 'diff', '--cached', '--binary') + '\n'); git(half, 'reset', '-q', '--hard');
  const treeBytes = d => spawnSync('sh', ['-c', 'cd "$1" && find . -path ./.git -prune -o -type f -print | sort | xargs sha256sum', 'sh', d], { encoding: 'utf8' }).stdout;
  const before = treeBytes(half);
  fs.chmodSync(path.join(half, 'sub'), 0o555);
  try {
    assert.throws(() => applyPatch({ dir: half, patch: HPATCH, sha256: sha(HPATCH), baseSha: HBASE }), /git apply failed.*restored/s);
  } finally { fs.chmodSync(path.join(half, 'sub'), 0o755); }
  assert.equal(treeBytes(half), before, 'a failed write leaves every file byte-identical');
  assert.equal(git(half, 'status', '--porcelain'), '', 'and git sees no change');
  assert.equal(fs.existsSync(path.join(half, 'sub/c.txt')), false);
  assert.equal(applyPatch({ dir: half, patch: HPATCH, sha256: sha(HPATCH), baseSha: HBASE }).length > 0, true, 'the same patch applies once the cause is gone');
}

// Patch presence is an observation, including equivalent preexisting changes.
const mine = repo('mine'); write(mine, 'a.txt', 'one\ntwo\n'); commit(mine, 'base');
const builds = [{ rid: 'req_build_aaaa', artifact_id: 'art_aaaaaaaa1', observed: false }];
const hooks = { fetchPatch: async () => PATCH };
assert.deepEqual(await detectPresentPatches(builds, mine, hooks), []);
applyPatch({ dir: mine, patch: PATCH, sha256: sha(PATCH), baseSha: git(mine, 'rev-parse', 'HEAD') });
assert.deepEqual(await detectPresentPatches(builds, mine, hooks), ['req_build_aaaa']);
assert.equal(builds[0].observed, true);
assert.deepEqual(await detectPresentPatches(builds, mine, hooks), [], 'notify once');
const failing = [{rid:'req_build_bbbb',observed:false}], errors = [];
assert.deepEqual(await detectPresentPatches(failing, mine, {fetchPatch:async()=>{throw Error('artifact unavailable');},onError:(b,e)=>errors.push(e.message)}), []);
assert.equal(failing[0].observed,false); assert.deepEqual(errors,['artifact unavailable']);
assert.deepEqual(await detectPresentPatches([{rid:'req_build_cccc'}], mine, {fetchPatch:async()=>null}), []);

// ---- CLI against a fake bridge
const home = path.join(base, 'home'), root = path.join(home, '.local/share/dot-bridge'), receipts = path.join(root, 'receipts');
fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
const RID = 'req_applycli0001', ART = 'art_applycli0001';
fs.writeFileSync(path.join(receipts, createHash('sha256').update(RID).digest('hex') + '.json'), JSON.stringify({ request_id: RID, token: 't'.repeat(32), body: 'x', delivery: 'none' }) + '\n');
let evidenceSha = sha(PATCH), served = PATCH, decided = [], getStatus = 'finished', correctionLandsDuringDownload = false, corrected = false;
// The fake bridge's apply reservation: null, 'applying', 'applied' or 'released'. dropConfirm loses the confirm; the other flags break one step.
let reservation = null, dropConfirm = false, correctionAfterReserve = false, releaseReasons = [], attemptNo = 0, currentAttempt = null, takeoverAfterReserve = false, artifactGate = null, artifactSeen = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/get') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ request_id: RID, status: getStatus, assignment: { inputs: [{ base_sha: 'f'.repeat(40), github_repo: 'example-owner/example-repo' }] }, ...(reservation ? { apply: { state: reservation === 'applying' ? 'applying' : reservation, uncertain: reservation === 'applying' } } : {}), ...(corrected && reservation !== 'applying' ? { revised_by: { request_id: 'req_correction1' } } : {}), report: { workspace_evidence: { base_sha: CLI_BASE, patch_artifact: { artifact_id: ART, size: PATCH.length, sha256: evidenceSha } } } })); }
  if (url.pathname === '/artifact') { if (artifactSeen) artifactSeen(); if (artifactGate) return artifactGate.then(() => { if (correctionLandsDuringDownload) corrected = true; res.setHeader('x-artifact-sha256', sha(served)); res.setHeader('content-type', 'application/octet-stream'); res.end(served); }); if (correctionLandsDuringDownload) corrected = true; res.setHeader('x-artifact-sha256', sha(served)); res.setHeader('content-type', 'application/octet-stream'); return res.end(served); }
  if (url.pathname === '/decide') { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const body = JSON.parse(b), json = (code, value) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const refuse = () => json(400, { error: 'stale_revision: ' + RID + ' was revised by req_correction1; its result is kept as evidence and cannot be accepted or applied.', stale: { request_id: RID, revised_by: 'req_correction1', recorded: true } });
    const log = () => decided.push({ ...body, token: req.headers['x-owner-capability'] });
    // Like the real bridge: every reserve mints a token and does the stale check (an open reservation is taken over unless a
    // correction exists, even when the tree already holds the patch); confirm and release need it.
    if (body.phase === 'reserve') {
      if (corrected) return refuse();
      if (reservation === 'applied') return json(200, { request_id: RID, state: 'applied' });
      const open = reservation === 'applying';
      if (corrected) return refuse();
      log(); reservation = 'applying'; currentAttempt = 'tok' + (++attemptNo); if (correctionAfterReserve) corrected = true;
      const mine = currentAttempt; if (takeoverAfterReserve) currentAttempt = 'tok-other-run';
      return json(200, { request_id: RID, state: 'applying', resumed: open, attempt: mine });
    }
    if (body.phase === 'confirm') {
      if (dropConfirm) return req.socket.destroy();
      if (reservation !== 'applying') return json(400, { error: 'no open apply reservation for ' + RID });
      if (body.attempt !== currentAttempt) return json(400, { error: 'superseded apply attempt for ' + RID + ': not the current attempt; reserve again' });
      log(); reservation = 'applied'; return json(200, { request_id: RID, decision: 'applied' });
    }
    if (body.phase === 'release') {
      if (!body.force && body.attempt !== currentAttempt) return json(400, { error: 'superseded apply attempt for ' + RID + ': not the current attempt' });
      log(); releaseReasons.push(body.reason); reservation = 'released'; return json(200, { request_id: RID, state: 'released' });
    }
    if (corrected) return refuse();
    decided.push({ ...body, token: req.headers['x-owner-capability'] }); json(200, { request_id: RID, decision: body.decision });
  }); return; }
  res.statusCode = 404; res.end('{"error":"nope"}');
});
await new Promise(r => server.listen(path.join(root, 'admin.sock'), r));
const run = (...argv) => new Promise(resolve => {
  const child = spawn(process.execPath, [new URL('../bin/dot-worker.mjs', import.meta.url).pathname, ...argv], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
const clone = name => { const d = path.join(base, name); const r = spawnSync('git', ['clone', '-q', cli, d]); assert.equal(r.status, 0, String(r.stderr)); return d; };
const cli = repo('cli'); write(cli, 'a.txt', 'one\ntwo\n'); const CLI_BASE = commit(cli, 'base');
try {
  // Materialize is a dry-run even when the fixture owner has a standing grant.
  const fixtureConfig = path.join(home, '.config/dot-bridge/materialize.json');
  fs.mkdirSync(path.dirname(fixtureConfig), {recursive: true});
  const grantFile = (text, mode=0o600) => {
    fs.writeFileSync(fixtureConfig, text, {mode});
    fs.chmodSync(fixtureConfig, mode);
  };
  const preview = (...args) => run('materialize', RID, '--dry-run', '--json', ...args);
  const ungranted = await preview();
  assert.equal(ungranted.code, 0, ungranted.stderr);
  assert.equal(JSON.parse(ungranted.stdout).decision.push, false);
  for (const key of ['org:EXAMPLE-OWNER', 'repo:example-owner/EXAMPLE-REPO', 'repo:example-owner/other-repo', 'org:example-owne']) {
    grantFile(JSON.stringify({grant:[key],mode:'standing'}));
    const trial = await preview();
    assert.equal(trial.code, 0, trial.stderr);
    const result = JSON.parse(trial.stdout);
    assert.equal(result.repo, 'example-owner/example-repo');
    assert.equal(result.base_sha, CLI_BASE);
    assert.ok(result.files.includes('new.txt'));
    assert.equal(result.decision.branch, 'dalan/' + RID);
    assert.equal(result.decision.push, key === 'org:EXAMPLE-OWNER' || key === 'repo:example-owner/EXAMPLE-REPO');
  }
  grantFile(JSON.stringify({grant:['repo:example-owner/example-repo'],mode:'per_pr'}));
  const prompted = await preview();
  assert.equal(prompted.code, 0, prompted.stderr);
  assert.deepEqual(JSON.parse(prompted.stdout).decision, {
    push:false, draft_pr:false, needs_approval:true, branch:'dalan/'+RID, reason:'per_pr_approval_required',
  });
  grantFile('{invalid');
  assert.notEqual((await preview()).code, 0);
  grantFile(JSON.stringify({grant:['org:example-owner'],mode:'standing'}), 0o644);
  const wide = await preview();
  assert.notEqual(wide.code, 0);
  assert.match(wide.stdout + wide.stderr, /materialize_grant_unsafe/);
  fs.unlinkSync(fixtureConfig);
  assert.equal(decided.length, 0);
  assert.equal(reservation, null);
  assert.equal(fs.existsSync(path.join(cli, 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'artifact-index')), false);

  // digest in the evidence does not match the bytes served: refused, nothing applied, nothing recorded
  evidenceSha = sha('lie'); let r = await run('apply', RID, '--dir', cli);
  assert.notEqual(r.code, 0); assert.match(r.stderr, /sha256 does not match/); assert.equal(decided.length, 0); assert.equal(fs.existsSync(path.join(cli, 'new.txt')), false);
  evidenceSha = sha(PATCH);
  // base not an ancestor of HEAD: refused with the reason
  const elsewhere = repo('elsewhere'); write(elsewhere, 'a.txt', 'one\ntwo\n'); commit(elsewhere, 'unrelated');
  r = await run('apply', RID, '--dir', elsewhere);
  assert.notEqual(r.code, 0); assert.match(r.stderr, /not in this checkout|not an ancestor/); assert.equal(decided.length, 0);
  // success: applies, then records applied through the owner capability
  r = await run('apply', RID, '--dir', cli, '--json');
  assert.equal(r.code, 0, r.stderr); const out = JSON.parse(r.stdout);
  assert.equal(out.applied, true); assert.deepEqual(out.files.sort(), ['a.txt', 'new.txt']); assert.equal(out.decision, 'applied');
  assert.equal(fs.readFileSync(path.join(cli, 'a.txt'), 'utf8'), 'uno\ntwo\n');
  assert.deepEqual(decided.map(d => [d.id, d.decision, d.phase, d.via, d.token]), [[RID, 'applied', 'reserve', 'apply', 't'.repeat(32)], [RID, 'applied', 'confirm', 'apply', 't'.repeat(32)]], 'reserve, then write, then confirm');
  assert.equal(reservation, 'applied');
  // A correction that commits after the initial get, while the artifact is still downloading, must stop the apply before the
  // patch touches the directory. The bridge records the decision first (its stale check shares that transaction) and the
  // patch is written only after the bridge accepts it.
  git(cli, 'reset', '--hard'); git(cli, 'clean', '-fdq');
  reservation = null; const decidedBefore = decided.length; correctionLandsDuringDownload = true;
  r = await run('apply', RID, '--dir', cli);
  correctionLandsDuringDownload = false; corrected = false;
  assert.notEqual(r.code, 0); assert.match(r.stderr, /stale_revision.*revised by req_correction1/);
  assert.equal(fs.readFileSync(path.join(cli, 'a.txt'), 'utf8'), 'one\ntwo\n', 'a correction that lands during the download leaves the directory unchanged');
  assert.equal(fs.existsSync(path.join(cli, 'new.txt')), false, 'no file of the stale patch was written');
  assert.equal(decided.length, decidedBefore, 'the refused decision is not recorded by the fake bridge');
  // Human output must succeed after the mutation, just as JSON output does.
  git(cli, 'reset', '--hard'); git(cli, 'clean', '-fdq');
  r = await run('apply', RID, '--dir', cli);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /applied 2 files/);
  assert.equal(fs.readFileSync(path.join(cli, 'a.txt'), 'utf8'), 'uno\ntwo\n');
  assert.equal(decided.length, decidedBefore + 2, 'each explicit application reserves once and confirms once');
  assert.equal(reservation, 'applied');
  // Applying a job that is already applied, into another checkout, writes the patch and records nothing more.
  const again = clone('again'); const n = decided.length;
  r = await run('apply', RID, '--dir', again); assert.equal(r.code, 0, r.stderr); assert.equal(decided.length, n, 'an already applied job is not reserved or confirmed again');
  assert.equal(fs.readFileSync(path.join(again, 'a.txt'), 'utf8'), 'uno\ntwo\n');
  // ---- Two-phase: the reservation, the write and the confirm are separate steps, each with its own failure.
  const phases = from => decided.slice(from).map(d => d.phase);
  // A correction that lands after the reservation is new work: the apply goes on and the bridge confirms.
  reservation = null; correctionAfterReserve = true; let at = decided.length; const lateFix = clone('late-fix');
  r = await run('apply', RID, '--dir', lateFix); correctionAfterReserve = false; corrected = false;
  assert.equal(r.code, 0, r.stderr); assert.deepEqual(phases(at), ['reserve', 'confirm']); assert.equal(fs.readFileSync(path.join(lateFix, 'a.txt'), 'utf8'), 'uno\ntwo\n');
  // A write that fails part-way: the tree is byte-identical, the reservation is released with the reason, nothing is confirmed.
  if (process.getuid?.() !== 0) {
    const sub = clone('mid-write'); fs.mkdirSync(path.join(sub, 'sub')); write(sub, 'sub/b.txt', 'bee\n'); commit(sub, 'sub'); write(sub, 'a.txt', 'uno\ntwo\n'); write(sub, 'sub/b.txt', 'abeja\n'); git(sub, 'add', '-A');
    const SUBPATCH = Buffer.from(git(sub, 'diff', '--cached', '--binary') + '\n'); git(sub, 'reset', '-q', '--hard');
    const stash = served; served = SUBPATCH; evidenceSha = sha(SUBPATCH);
    reservation = null; at = decided.length; fs.chmodSync(path.join(sub, 'sub'), 0o555);
    try { r = await run('apply', RID, '--dir', sub); } finally { fs.chmodSync(path.join(sub, 'sub'), 0o755); }
    assert.notEqual(r.code, 0); assert.match(r.stderr, /apply_failed|not applied/); assert.match(r.stderr, /unchanged|restored/);
    assert.equal(git(sub, 'status', '--porcelain'), '', 'the tree is byte-identical after a failed write');
    assert.deepEqual(phases(at), ['reserve', 'release']); assert.equal(reservation, 'released'); assert.match(releaseReasons.at(-1), /write failed|git apply failed/);
    // The cause is gone: the same command now applies.
    r = await run('apply', RID, '--dir', sub); assert.equal(r.code, 0, r.stderr); assert.deepEqual(phases(at), ['reserve', 'release', 'reserve', 'confirm']);
    served = stash; evidenceSha = sha(PATCH);
  }
  // A crash after the write and before the confirm: the response is lost, the tree has the patch, the reservation is uncertain.
  // A re-run sees the patch in the tree, does not write again, and confirms.
  const crashed = clone('crash-after-write'); reservation = null; at = decided.length; dropConfirm = true;
  r = await run('apply', RID, '--dir', crashed); dropConfirm = false;
  assert.notEqual(r.code, 0); assert.match(r.stderr, /patch is in .*did not confirm/); assert.match(r.stderr, /dalan apply/);
  assert.equal(fs.readFileSync(path.join(crashed, 'a.txt'), 'utf8'), 'uno\ntwo\n'); assert.equal(reservation, 'applying'); assert.deepEqual(phases(at), ['reserve']);
  r = await run('apply', RID, '--dir', crashed); assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /already in|already present/);
  assert.deepEqual(phases(at), ['reserve', 'reserve', 'confirm'], 'the re-run reserves again (a new token and a stale check), confirms and writes nothing'); assert.equal(reservation, 'applied');
  // A crash after the reservation and before the write: a re-run resumes the reservation, writes and confirms.
  const early = clone('crash-before-write'); reservation = 'applying'; currentAttempt = 'crashed-run'; at = decided.length;
  r = await run('apply', RID, '--dir', early); assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(phases(at), ['reserve', 'confirm'], 'an open reservation is taken over with a new token, never written without one'); assert.equal(fs.readFileSync(path.join(early, 'a.txt'), 'utf8'), 'uno\ntwo\n');
  // Crash after the write, then a correction, then a re-run: the tree holds the patch of a job that is now revised. The re-run is
  // refused, records nothing, leaves the reservation open, and says what the tree contains and how to undo it.
  const superseded = clone('superseded-in-tree'); write(superseded, 'a.txt', 'uno\ntwo\n'); write(superseded, 'new.txt', 'hello\n'); reservation = 'applying'; currentAttempt = 'crashed-run'; at = decided.length; corrected = true;
  r = await run('apply', RID, '--dir', superseded); corrected = false;
  assert.notEqual(r.code, 0); assert.match(r.stderr, /stale_revision/);
  assert.match(r.stderr, new RegExp('working tree contains the superseded patch from request ' + RID)); assert.match(r.stderr, /the correction is req_correction1/);
  assert.match(r.stderr, /git -C .* apply -R /); assert.match(r.stderr, /dalan apply .*--release/);
  const undo = /apply -R (\S+)/.exec(r.stderr)?.[1]; assert.ok(undo && fs.existsSync(undo), 'the undo patch file exists: ' + undo);
  assert.deepEqual(phases(at), [], 'nothing is recorded'); assert.equal(reservation, 'applying');
  assert.equal(spawnSync('git', ['-C', superseded, 'apply', '-R', undo]).status, 0, 'the printed command undoes the patch'); assert.equal(git(superseded, 'status', '--porcelain'), '');
  fs.rmSync(undo, { force: true });
  // An already applied job: a correction lands between the get (which showed no correction) and the reserve. The stale check comes
  // before the already-applied shortcut, so the run is refused and writes nothing.
  const appliedBefore = clone('applied-then-corrected'); reservation = 'applied'; at = decided.length; correctionLandsDuringDownload = true;
  r = await run('apply', RID, '--dir', appliedBefore); correctionLandsDuringDownload = false; corrected = false;
  assert.notEqual(r.code, 0); assert.match(r.stderr, /stale_revision/); assert.equal(fs.readFileSync(path.join(appliedBefore, 'a.txt'), 'utf8'), 'one\ntwo\n'); assert.deepEqual(phases(at), []);
  // A stale GET: run A saw an open reservation, then waits in the download. Meanwhile B fails and releases and a correction lands.
  // A must still reserve (the stale check), which is refused, so A writes nothing.
  const stalled = clone('stale-get'); reservation = 'applying'; currentAttempt = 'crashed-run'; at = decided.length;
  let openGate; artifactGate = new Promise(r => { openGate = r; }); const seen = new Promise(r => { artifactSeen = r; });
  const runA = run('apply', RID, '--dir', stalled); await seen;
  reservation = 'released'; corrected = true; openGate(); r = await runA; artifactGate = null; artifactSeen = null; corrected = false;
  assert.notEqual(r.code, 0); assert.match(r.stderr, /stale_revision.*revised by req_correction1/);
  assert.equal(fs.readFileSync(path.join(stalled, 'a.txt'), 'utf8'), 'one\ntwo\n', 'a run that read a stale open reservation writes nothing after the correction');
  assert.deepEqual(phases(at), [], 'and records nothing');
  // A takeover during the write: another run took the reservation, so this run\'s confirm is refused and says so.
  const taken = clone('taken-over'); reservation = null; at = decided.length; takeoverAfterReserve = true;
  r = await run('apply', RID, '--dir', taken); takeoverAfterReserve = false;
  assert.notEqual(r.code, 0); assert.match(r.stderr, /superseded/); assert.deepEqual(phases(at), ['reserve']); assert.equal(reservation, 'applying');
  // Half-written tree: an open reservation, and the checkout matches neither the patch nor the base. The reservation stays
  // uncertain; the message names the request and the files, and gives the recovery steps. --release gives it up on purpose.
  const dirty = clone('dirty'); write(dirty, 'a.txt', 'changed\ntwo\n'); reservation = 'applying'; currentAttempt = 'crashed-run'; at = decided.length;
  r = await run('apply', RID, '--dir', dirty); assert.notEqual(r.code, 0);
  assert.match(r.stderr, /may be partly changed/); assert.ok(r.stderr.includes(RID)); assert.match(r.stderr, /a\.txt/); assert.match(r.stderr, /new\.txt/);
  assert.match(r.stderr, /git -C .*diff -- a\.txt new\.txt/); assert.match(r.stderr, /git -C .*checkout -- a\.txt new\.txt/); assert.match(r.stderr, /dalan apply .*--release/); assert.match(r.stderr, /git apply --check failed/);
  assert.deepEqual(phases(at), []); assert.equal(reservation, 'applying');
  r = await run('apply', RID, '--release', '--json'); assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).released, true);
  assert.deepEqual(phases(at), ['release']); assert.equal(decided.at(-1).force, true); assert.equal(reservation, 'released'); assert.equal(fs.readFileSync(path.join(dirty, 'a.txt'), 'utf8'), 'changed\ntwo\n', '--release touches no file');
  r = await run('apply', RID, '--release'); assert.notEqual(r.code, 0); assert.match(r.stderr, /no apply in progress/);
  reservation = 'applied';
  // A prior build can match the working tree even though the owner rejected it.
  // Drive the real next-prompt path with persisted session state and a fake bridge.
  for (const ownerDecision of ['not_useful', null]) {
    let latest = ownerDecision;
    const before = decided.length;
    const agent = startAdapter({ HOME: home }, cli);
    try {
      await agent.init();
      const { sessionId } = await agent.newSession(cli);
      const stateDir = path.join(home, '.local/state/dot-bridge/acp');
      fs.mkdirSync(stateDir, {recursive:true});
      fs.writeFileSync(path.join(stateDir, sessionId + '.json'), JSON.stringify({id:sessionId,cwd:cli,pending:null,builds:[{rid:RID,artifact_id:ART,recorded:false}]}), {mode:0o600});
      // The fake bridge refuses the unrelated next request after processing observations.
      const turn = await agent.prompt(sessionId, '[dot-build] a.txt\nInspect this trial change.');
      assert.ok(turn.error, 'the fixture must not submit another job');
      assert.match(agent.rawText('agent_message_chunk'), /matches the working tree; no owner decision recorded/);
      if (decided.length > before) latest = decided.at(-1).decision;
      assert.equal(latest, ownerDecision, 'reverse applicability must not create or overwrite an owner decision');
      assert.equal(decided.length, before, 'the adapter must not post an owner-applied decision');
    } finally {
      agent.kill('SIGTERM');
      await agent.exited;
    }
  }
  // decide: vocabulary check is local; the word goes to the bridge with the capability
  r = await run('decide', RID, 'maybe'); assert.notEqual(r.code, 0); assert.match(r.stderr, /unknown decision 'maybe'/);
  r = await run('decide', RID, 'useful_no_change', '--note', 'confirmed the design', '--json'); assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(decided.at(-1), { id: RID, decision: 'useful_no_change', note: 'confirmed the design', token: 't'.repeat(32) });
  // get (human output) ends with the decide line on stderr for a finished result
  r = await run('get', RID); assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr.trim().split('\n').at(-1), `decide: node '${fs.realpathSync(new URL('../bin/dot-worker.mjs', import.meta.url).pathname)}' decide ${RID} accepted|applied|useful_no_change|useful_negative|not_useful`);
  r = await run('get', RID, '--json'); assert.doesNotMatch(r.stderr, /decide:/, '--json keeps stderr clean');
  getStatus = 'queued'; r = await run('get', RID); assert.doesNotMatch(r.stderr, /decide:/, 'only a finished result asks for a decision');
  console.log('apply-test ok');
} finally { server.close(); fs.rmSync(base, { recursive: true, force: true }); }
