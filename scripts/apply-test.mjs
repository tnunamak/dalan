#!/usr/bin/env node
// `dalan apply` and the adapter's read-only applied check: digest, base ancestry, git apply --check, then the applied decision.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, baseProblem, detectPresentPatches, patchMatchesWorktree } from '../src/patch-apply.mjs';
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
let evidenceSha = sha(PATCH), served = PATCH, decided = [], getStatus = 'finished';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/get') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ request_id: RID, status: getStatus, assignment: { inputs: [{ base_sha: 'f'.repeat(40) }] }, report: { workspace_evidence: { base_sha: CLI_BASE, patch_artifact: { artifact_id: ART, size: PATCH.length, sha256: evidenceSha } } } })); }
  if (url.pathname === '/artifact') { res.setHeader('x-artifact-sha256', sha(served)); res.setHeader('content-type', 'application/octet-stream'); return res.end(served); }
  if (url.pathname === '/decide') { let b = ''; req.on('data', c => b += c); req.on('end', () => { decided.push({ ...JSON.parse(b), token: req.headers['x-owner-capability'] }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ request_id: RID, decision: JSON.parse(b).decision })); }); return; }
  res.statusCode = 404; res.end('{"error":"nope"}');
});
await new Promise(r => server.listen(path.join(root, 'admin.sock'), r));
const run = (...argv) => new Promise(resolve => {
  const child = spawn(process.execPath, [new URL('../bin/dot-worker.mjs', import.meta.url).pathname, ...argv], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
const cli = repo('cli'); write(cli, 'a.txt', 'one\ntwo\n'); const CLI_BASE = commit(cli, 'base');
try {
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
  assert.deepEqual(decided.map(d => [d.id, d.decision, d.via, d.token]), [[RID, 'applied', 'apply', 't'.repeat(32)]]);
  // Human output must succeed after the mutation, just as JSON output does.
  git(cli, 'reset', '--hard'); git(cli, 'clean', '-fdq');
  r = await run('apply', RID, '--dir', cli);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /applied 2 files/);
  assert.equal(fs.readFileSync(path.join(cli, 'a.txt'), 'utf8'), 'uno\ntwo\n');
  assert.equal(decided.length, 2, 'each explicit application records exactly one decision');
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
