#!/usr/bin/env node
// --exclude-sensitive: a directory scope drops the sensitive files it holds (and says why) instead of failing the whole submit.
// A file the submitter named is never dropped quietly, and without the option the old refusal stands.
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { narrowScope, validateSubmission, scanGit } from '../src/submission-policy.mjs';

const files = ['codex-rs/app-server/src/lib.rs', 'codex-rs/app-server/src/auth_recovery_policy.yaml', 'codex-rs/app-server/schema/ChatgptAuthTokensRefreshParams.json', 'codex-rs/app-server/schema/Other.json', 'codex-rs/core/src/main.rs', 'codex-rs/core/.env', 'README.md', 'docs/guide.md'];
const scan = () => ({ files, diffFiles: [], diff: '', symlinks: [] });
const task = (scope, extra = {}) => ({ schema_version: 1, request_id: 'req_scope_0001', brief: 'Read the app server and summarize its lifecycle.', expected_output: 'A summary', execution_scope: 'read-only', inputs: [{ github_repo: 'o/codex', base_sha: 'a'.repeat(40) }], scope_paths: scope, ...extra });

// Overflow is a plain client error, through the same git helper used by scanInput.
for (const operation of ['diff', 'ls-tree']) {
  for (const code of ['ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
    const overflow = () => scanGit('fixture', [operation], (cmd, argv, options) => {
      assert.equal(cmd, 'git'); assert.deepEqual(argv, ['-C', 'fixture', operation]);
      assert.equal(options.maxBuffer, 32 * 1024 * 1024);
      return { error: Object.assign(new Error('overflow'), { code }), status: null };
    });
    assert.throws(() => validateSubmission(task(['docs']), { scanInput: overflow }), error => {
      assert.equal(error.constructor, Error);
      assert.equal(error.code, undefined, 'oversize is not an infrastructure failure');
      assert.equal(error.message, 'PR diff too large to scan: more than 32 MiB; split the review or name fewer files');
      return true;
    });
  }
}
assert.throws(() => scanGit('fixture', ['diff'], () => ({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), status: null })), { code: 'DOT_BRIDGE_INFRASTRUCTURE' });
assert.throws(() => scanGit('fixture', ['diff'], () => ({ status: 1 })), { code: 'DOT_BRIDGE_INFRASTRUCTURE' });
assert.equal(scanGit('fixture', ['diff'], () => ({ status: 0, stdout: 'ok' })), 'ok');

// unit: without the option the whole submit fails, as before
assert.throws(() => validateSubmission(task(['codex-rs']), { scanInput: scan }), /(?:sensitive scope path|hard sensitive path exclusion): /);
// a code file named for what it handles is not sensitive by name (auth_session.rs, credential-setup.test.ts); config and images still are
{ const code = ['src/auth_session.rs', 'src/logout-cancels-credential-setup.test.ts', 'docs/agent-authored/design.md', 'img/auth.png', 'src/auth.json', 'scripts/secrets.sh'];
  const r = validateSubmission(task(['src', 'docs', 'img', 'scripts']), { scanInput: () => ({ files: code, diffFiles: [], diff: '', symlinks: [] }), excludeSensitive: true });
  assert.deepEqual(r.scope_excluded.map(d => d.path).sort(), ['img/auth.png', 'scripts/secrets.sh', 'src/auth.json'], JSON.stringify(r.scope_excluded)); }
// Secret-material ancestor directories remain hard sensitive even for code extensions.
{
  const hard = ['secrets/config.ts', 'src/credentials/client.py', 'src/SECRET/config.ts', 'Credential/client.py'];
  const safe = ['src/auth_session.rs', 'src/logout-cancels-credential-setup.test.ts'];
  const tree = [...hard, ...safe], scanInput = () => ({ files: tree, diffFiles: [], diff: '', symlinks: [] });
  for (const f of hard) assert.throws(() => validateSubmission(task([f]), { scanInput }), /hard sensitive path exclusion/, f);
  for (const f of safe) assert.doesNotThrow(() => validateSubmission(task([f]), { scanInput }), f);
}
// Precise secret words in a code file's name, extensionless secret names and password stores stay
// sensitive; images are not exempt; growth is capped; secret-shaped values refuse, local fixture URLs do not
{ const tree = ['src/config/credentials.ts', 'src/secrets.py', 'src/keys/private-key.ts', 'src/owner-credential.ts', 'src/service-account.ts', 'config/jwt_secret', 'config/client_secret', 'auth/passwords.txt', 'auth/htpasswd', 'img/recovery-key.png', 'src/logout-cancels-credential-setup.test.ts', 'docs/secrets.md', 'src/ok.ts'];
  const one = f => () => validateSubmission(task([f]), { scanInput: () => ({ files: tree, diffFiles: [], diff: '', symlinks: [] }) });
  for (const f of tree.filter(f => !['src/logout-cancels-credential-setup.test.ts', 'src/ok.ts', 'img/recovery-key.png'].includes(f))) assert.throws(one(f), /sensitive/, f);
  for (const f of ['src/logout-cancels-credential-setup.test.ts', 'src/ok.ts']) assert.doesNotThrow(one(f), f);
  const many = Array.from({ length: 201 }, (_, i) => `src/f${i}.ts`);
  assert.throws(() => validateSubmission(task(['docs'], { brief: `Review ${many.join(', ')}.` }), { scanInput: () => ({ files: ['docs/a.md', ...many], diffFiles: [], diff: '', symlinks: [] }) }), /scope growth limit/);
  const withDiff = diff => () => validateSubmission(task(['src'], { inputs: [{ github_repo: 'o/r', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) }] }), { scanInput: () => ({ files: ['src/ok.ts'], diffFiles: ['src/ok.ts'], diff, symlinks: [] }) });
  assert.throws(withDiff('+const url = "postgres://admin:' + 'hunter2pw' + '@database.example.test:5432/app";'), /hard sensitive patch content/);
  assert.throws(withDiff('+const slack = "' + 'xoxb-' + '123456789012-abcdefghij";'), /hard sensitive patch content/);
  assert.doesNotThrow(withDiff('+const url = "postgres://postgres:postgres@localhost:5432/test";')); }
// with it, the sensitive files leave the scope and the rest stays
const warnings = [], out = validateSubmission(task(['codex-rs']), { scanInput: scan, excludeSensitive: true, warnings });
assert.deepEqual(out.scope_paths, ['codex-rs/app-server/schema/Other.json', 'codex-rs/app-server/src/lib.rs', 'codex-rs/core/src']);
assert.deepEqual(out.scope_excluded.map(d => d.path).sort(), ['codex-rs/app-server/schema/ChatgptAuthTokensRefreshParams.json', 'codex-rs/app-server/src/auth_recovery_policy.yaml', 'codex-rs/core/.env']);
assert.ok(out.scope_excluded.every(d => d.reason && !d.reason.includes('undefined')), JSON.stringify(out.scope_excluded));
assert.match(out.scope_excluded.find(d => d.path.endsWith('.env')).reason, /hard sensitive/);
assert.match(out.scope_excluded.find(d => d.path.endsWith('auth_recovery_policy.yaml')).reason, /lint/);
assert.match(out.brief, /Bridge scope note: 3 sensitive file\(s\) are outside scope_paths; do not read them/);
assert.ok(warnings.some(w => /3 sensitive file\(s\) dropped/.test(w)), warnings.join('|'));
// read_paths and read_list follow the narrowed scope, or they would still name the dropped files' directory
const withReads = validateSubmission(task(['codex-rs'], { read_paths: ['codex-rs'], read_list: ['codex-rs'] }), { scanInput: scan, excludeSensitive: true });
assert.deepEqual(withReads.read_paths, withReads.scope_paths); assert.deepEqual(withReads.read_list, withReads.scope_paths);
// a directory with no sensitive file below it stays whole
assert.deepEqual(validateSubmission(task(['codex-rs', 'docs']), { scanInput: scan, excludeSensitive: true }).scope_paths.includes('docs'), true);
assert.deepEqual(narrowScope(['codex-rs/core'], files, ['codex-rs/core/.env']), ['codex-rs/core/src']);
// nothing sensitive: the payload is untouched
const clean = task(['docs']), cleanOut = validateSubmission(clean, { scanInput: scan, excludeSensitive: true });
assert.deepEqual({ ...cleanOut, brief: clean.brief }, clean);
// a free-form brief gets the full scope_paths list in its text (the worker's reviewer judges reads by the prose), once
assert.equal(cleanOut.brief, `${clean.brief}\n\nRead allow-list (scope_paths; every path below, and everything under a listed directory, may be read):\ndocs`);
assert.equal(validateSubmission(cleanOut, { scanInput: scan, excludeSensitive: true }).brief, cleanOut.brief, 'allow-list appended twice');
assert.match(out.brief, /Read allow-list \(scope_paths[^\n]*\n(?:[^\n]+\n)*[^\n]+$/, 'narrowed scope also listed');
assert.ok(out.brief.indexOf('Bridge scope note') < out.brief.indexOf('Read allow-list (scope_paths'), 'note, then list');
// a long list is cut to fit the brief limit and says the rest stays readable
{ const many = Array.from({ length: 300 }, (_, i) => `docs/f${i}-${'x'.repeat(40)}.md`), big = task(['docs'], { brief: 'y'.repeat(6000) });
  const r = validateSubmission({ ...big, scope_paths: many }, { scanInput: () => ({ files: many, diffFiles: [], diff: '', symlinks: [] }) });
  assert.ok(Buffer.byteLength(r.brief) <= 16384 && /\n\.\.\.and \d+ more paths in scope_paths, all readable$/.test(r.brief), 'truncated allow-list'); }
// an unnamed excluded file in the brief warns
{ const w = []; validateSubmission(task(['docs'], { brief: 'Review it. [excluded file] is excluded by policy.' }), { scanInput: scan, warnings: w });
  assert.ok(w.some(x => /excluded file without naming it/.test(x)), w.join('|')); }
// a path the submitter named is not dropped: explicit scope entry, brief mention
assert.throws(() => validateSubmission(task(['codex-rs/core/.env']), { scanInput: scan, excludeSensitive: true }), /hard sensitive path exclusion/);
assert.throws(() => validateSubmission(task(['codex-rs'], { brief: 'Read codex-rs/app-server/src/auth_recovery_policy.yaml first.' }), { scanInput: scan, excludeSensitive: true }), /sensitive scope path/);
// a deleted file in a PR diff stays covered by the narrowed scope; a sensitive file in the diff is refused, not dropped
{
  const withDiff = { files, diffFiles: ['codex-rs/core/old.rs'], diff: '', symlinks: [] };
  const review = task(['codex-rs'], { inputs: [{ github_repo: 'o/codex', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) }] });
  const narrowed = validateSubmission(review, { scanInput: () => withDiff, excludeSensitive: true }).scope_paths;
  assert.ok(narrowed.some(p => 'codex-rs/core/old.rs'.startsWith(p)), `a deleted diff file is covered by ${narrowed}`);
  assert.throws(() => validateSubmission(review, { scanInput: () => ({ ...withDiff, diffFiles: ['codex-rs/core/auth_old.yaml'] }), excludeSensitive: true }), /sensitive scope path: codex-rs\/core\/auth_old\.yaml/);
}
// a named path in the brief's read list is refused, not dropped
assert.throws(() => validateSubmission(task(['codex-rs'], { brief: 'Read the code.\nRead allow-list: codex-rs/app-server/src/auth_recovery_policy.yaml' }), { scanInput: scan, excludeSensitive: true }), /sensitive scope path/);
// implementation work is not narrowed: a file list would forbid new files
assert.throws(() => validateSubmission(task(['codex-rs'], { execution_scope: 'implementation' }), { scanInput: scan, excludeSensitive: true }), /applies to read-only work/);
// the narrowed scope obeys the instruction size limit like a hand-written one
{
  const dirs = Array.from({ length: 190 }, (_, i) => `big/${'d'.repeat(90)}${String(i).padStart(3, '0')}/x.js`), bigFiles = [...dirs, 'big/auth_token.json'];
  const bigTask = task(['big'], { expected_output: 'e'.repeat(8000) });
  assert.throws(() => validateSubmission(bigTask, { scanInput: () => ({ files: bigFiles, diffFiles: [], diff: '', symlinks: [] }), excludeSensitive: true }), /task instructions: \d+ UTF-8 bytes exceeds/);
}
// a sibling with a name scope_paths cannot hold fails with the real reason
assert.throws(() => validateSubmission(task(['web']), { scanInput: () => ({ files: ['web/what?.md', 'web/auth_helper.json', 'web/a.js'], diffFiles: [], diff: '', symlinks: [] }), excludeSensitive: true }), /cannot narrow the scope: web\/what\?\.md has a name that scope_paths cannot hold/);
// everything sensitive, or too many entries to name: refuse rather than send an empty or sprawling scope
assert.throws(() => narrowScope(['x'], ['x/.env'], ['x/.env']), /every file in the scope is sensitive/);
const many = Array.from({ length: 300 }, (_, i) => `big/d${i}/auth-token.json`).concat(Array.from({ length: 300 }, (_, i) => `big/d${i}/ok.js`));
assert.throws(() => narrowScope(['big'], many, many.filter(f => f.endsWith('auth-token.json'))), /would need \d+ scope entries.*submit a narrower scope/s);
// at submit, a scope too sprawling to narrow is refused, not kept broad: an exact-path exclusion can miss a case alias on macOS
assert.throws(() => validateSubmission(task(['big']), { scanInput: () => ({ files: many, diffFiles: [], diff: '', symlinks: [] }), excludeSensitive: true }), /too many files to exclude from "big".*submit a narrower scope/s);
// a symlink in a directory scope is dropped (the workspace never follows it) under excludeSensitive; refused without it
{ const linkScan = () => ({ files: ['web/a.js', 'web/link'], diffFiles: [], diff: '', symlinks: ['web/link'] });
  const r = validateSubmission(task(['web']), { scanInput: linkScan, excludeSensitive: true });
  assert.deepEqual(r.scope_paths, ['web/a.js']); assert.match(r.scope_excluded[0].reason, /symlink/);
  assert.throws(() => validateSubmission(task(['web']), { scanInput: linkScan }), /symlink in repository scope: web\/link/); }
console.log('PASS scope narrowing: sensitive files drop from a directory scope with reasons; named paths and empty scopes still refuse; a sprawling scope is refused');

// ---- e2e through the server and CLI, on a fixture repository: the flag, the recorded reason, a retry of the same request
const repo = resolve(new URL('..', import.meta.url).pathname), home = fs.mkdtempSync(join(tmpdir(), 'dalan-bridge-scope-'));
const root = join(home, '.local/share/dalan'), fixture = join(home, 'fixture');
const freePort = () => new Promise((done, fail) => { const probe = net.createServer(); probe.once('error', fail); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); }); });
const env = { ...process.env, HOME: home, DOT_BRIDGE_PORT: '0', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_T3_DRY_RUN: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '0', DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE: fixture, PATH: `${join(home, 'bin')}:${process.env.PATH}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const git = args => { const r = spawnSync('git', args, { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const cli = (args, input = '') => new Promise(done => { const c = spawn(process.execPath, ['bin/dalan.mjs', ...args, ...(args[0] === 'submit' ? ['--execution', 'none'] : [])], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => err += b); c.on('close', code => done({ code, out, err })); c.stdin.end(input); });
// Wait for every child to close; escalate if it ignores SIGTERM.
const trackChild = child => {
  const state = { child, closed: false };
  state.done = new Promise(resolve => child.once('close', () => { state.closed = true; resolve(); }));
  return state;
};
const waitBounded = async (promise, ms) => {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
};
const stopChild = async state => {
  if (state.closed) return;
  if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill('SIGTERM');
  if (await waitBounded(state.done, 500)) return;
  state.child.kill('SIGKILL');
  if (!await waitBounded(state.done, 2000)) throw new Error('fixture child did not close after SIGKILL');
};
// Reproduce a failed startup that stays alive, including one that ignores SIGTERM.
{
  const attempts = [];
  try {
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.error('EADDRINUSE'); setInterval(() => {}, 1000)"]);
      const state = trackChild(child); attempts.push(state);
      await new Promise((resolve, reject) => { child.stderr.once('data', resolve); child.once('error', reject); });
      await stopChild(state);
    }
  } finally {
    for (const state of attempts) await stopChild(state);
  }
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(state => state.closed), 'every failed startup must close before retry');
}
let service = null;
const attempted = [];
try {
  fs.mkdirSync(join(home,'.config/dalan'),{recursive:true});
  fs.writeFileSync(join(home,'.config/dalan/workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}],repos:['test/fixture']}}}),{mode:0o600});
  fs.mkdirSync(join(home, 'bin'), { recursive: true }); fs.writeFileSync(join(home, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (const [name, text] of [['web/app.js', 'a'], ['web/auth_helper.json', 'b'], ['web/ok/x.js', 'c'], ['docs/guide.md', 'd']]) { fs.mkdirSync(join(fixture, name, '..'), { recursive: true }); fs.writeFileSync(join(fixture, name), text); }
  git(['init', fixture]); git(['-C', fixture, 'config', 'user.name', 'F']); git(['-C', fixture, 'config', 'user.email', 'f@example.test']); git(['-C', fixture, 'add', '.']); git(['-C', fixture, 'commit', '-m', 'fixture']);
  const base = git(['-C', fixture, 'rev-parse', 'HEAD']);
  let ready = false, stderr = '';
  for (let attempt = 0; attempt < 5 && !ready; attempt++) {
    env.DOT_BRIDGE_PORT = String(await freePort());
    service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = trackChild(service); attempted.push(state);
    stderr = ''; service.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; }); service.stderr.on('data', b => stderr += b);
    for (let i = 0; i < 200 && !ready && service.exitCode === null; i++) await sleep(25);
    if (!ready && service.exitCode !== null) await state.done;
    if (!ready && !stderr.includes('EADDRINUSE')) break;
    if (!ready) await stopChild(state);
  }
  assert(ready, stderr);
  const id = `req_${randomUUID()}`, body = JSON.stringify({ schema_version: 1, request_id: id, brief: 'Read the web app and summarize it.', expected_output: 'A summary', execution_scope: 'read-only', inputs: [{ github_repo: 'test/fixture', base_sha: base }], scope_paths: ['web'] });
  const plain = await cli(['submit', '--stdin', '--json'], body);
  assert.equal(plain.code, 2); assert.equal(JSON.parse(plain.err).verdict,'reject'); assert.match(plain.out + plain.err, /sensitive scope path: web\/auth_helper\.json/, 'without the flag the submit is a typed rejection');
  // a refused submit leaves no local receipt, and the bridge logs the refusal with its reason
  const receiptFor = rid => join(root, 'receipts', createHash('sha256').update(rid).digest('hex') + '.json');
  assert.ok(!fs.existsSync(receiptFor(id)), 'a refused submit kept its local receipt');
  const logLines = () => fs.readFileSync(join(home, '.local/state/dalan/requests.jsonl'), 'utf8').split('\n').filter(l => l.includes('"submit_rejected"')).map(l => JSON.parse(l));
  assert.ok(logLines().some(l => l.request_id === id && /sensitive scope path: web\/auth_helper\.json/.test(l.reason) && l.status === 400), 'refusal not logged: ' + JSON.stringify(logLines()));
  // a corrected retry under the same request ID is accepted even when an old receipt survives (written by an older CLI)
  { const rid = `req_${randomUUID()}`, bad = { ...JSON.parse(body), request_id: rid, brief: 'Read the web app and docs/missing-dir/x.md.' };
    fs.mkdirSync(join(root, 'receipts'), { recursive: true });
    fs.writeFileSync(receiptFor(rid), JSON.stringify({ request_id: rid, token: 'f'.repeat(64), body: JSON.stringify(bad), delivery: 'none' }), { mode: 0o600 });
    const fixed = await cli(['submit', '--stdin', '--json'], JSON.stringify({ ...bad, brief: 'Read the web app.', scope_paths: ['web/app.js'] }));
    assert.equal(fixed.code, 0, 'stale receipt blocked a corrected retry: ' + fixed.out + fixed.err);
    // once the bridge stored the request, a different body is still a conflict
    const changed = await cli(['submit', '--stdin', '--json'], JSON.stringify({ ...bad, brief: 'Something else.', scope_paths: ['web/app.js'] }));
    assert.equal(changed.code, 1); assert.match(changed.out + changed.err, /request_id conflict with local receipt/); }
  { const r = await cli(['rejections', '--json']); assert.equal(r.code, 0, r.err); const j = JSON.parse(r.out);
    assert.ok(j.refused >= 1 && j.accepted >= 1 && j.classes.some(c => c.reason === 'sensitive scope path'), 'rejections summary: ' + r.out); }
  const first = await cli(['submit', '--stdin', '--json', '--exclude-sensitive'], body);
  assert.equal(first.code, 0, first.err); const result = JSON.parse(first.out);
  assert.deepEqual(result.scope_paths, ['web/app.js', 'web/ok']);
  assert.deepEqual(result.scope_excluded.map(d => d.path), ['web/auth_helper.json']);
  assert.match(result.scope_excluded[0].reason, /lint/);
  assert.ok(result.submission_warnings.some(w => /1 sensitive file\(s\) dropped/.test(w)));
  // the reason is recorded with the assignment the worker receives
  const stored = JSON.parse(await new Promise((done, fail) => { const q = http.request({ socketPath: join(root, 'admin.sock'), path: `/get?id=${id}`, headers: { 'x-owner-capability': JSON.parse(fs.readFileSync(receiptFor(id), 'utf8')).token } }, res => { let t = ''; res.on('data', b => t += b); res.on('end', () => done(t)); }); q.on('error', fail); q.end(); }));
  assert.deepEqual(stored.assignment.scope_paths, ['web/app.js', 'web/ok']);
  assert.deepEqual(stored.assignment.scope_excluded.map(d => d.path), ['web/auth_helper.json']);
  assert.match(stored.assignment.brief, /Bridge scope note: 1 sensitive file/);
  // a retry of the same request is a duplicate, not a conflict
  const retry = await cli(['submit', '--stdin', '--json', '--exclude-sensitive'], body);
  assert.equal(retry.code, 0, retry.err); assert.equal(JSON.parse(retry.out).duplicate, true);
  assert.deepEqual(JSON.parse(retry.out).scope_excluded.map(d => d.path), ['web/auth_helper.json'], 'a retry repeats what was dropped');
  const forged = await cli(['submit', '--stdin', '--json', '--exclude-sensitive'], JSON.stringify({ ...JSON.parse(body), request_id: `req_${randomUUID()}`, scope_paths: ['web/app.js'], scope_excluded: [{ path: 'web/x', reason: 'made up' }] }));
  assert.equal(forged.code, 2); assert.match(forged.out + forged.err, /declares scope_excluded/);
  const retryPlain = await cli(['submit', '--stdin', '--json'], body);
  assert.equal(retryPlain.code, 0, retryPlain.err); assert.equal(JSON.parse(retryPlain.out).duplicate, true, 'the flag is not part of the request identity');
  // an explicit sensitive scope entry still fails even with the flag
  const named = await cli(['submit', '--stdin', '--json', '--exclude-sensitive'], JSON.stringify({ ...JSON.parse(body), request_id: `req_${randomUUID()}`, scope_paths: ['web/auth_helper.json'] }));
  assert.equal(named.code, 2); assert.match(named.out + named.err, /sensitive scope path/);
  // Scope changes are never silent: an implementation brief naming repository files outside scope_paths, or a scope path the tree lacks,
  // is refused with the exact fix and nothing stored; --allow-scope-prune (old spelling --fix-scope) applies the suggestion once.
  { const impl = (extra = {}) => ({ schema_version: 1, request_id: `req_${randomUUID()}`, brief: 'Edit docs/guide.md; also read web/app.js and web/ok/x.js.', expected_output: 'A patch', execution_scope: 'implementation', inputs: [{ github_repo: 'test/fixture', base_sha: base }], scope_paths: ['docs/guide.md'], ...extra });
    const a = impl(), refused = await cli(['submit', '--stdin', '--json'], JSON.stringify(a));
    assert.equal(refused.code, 3, refused.out + refused.err); const j = JSON.parse(refused.err || refused.out);assert.equal(j.verdict,'clarify');
    assert.match(j.error, /^undeclared instruction path: web\/app\.js, web\/ok\/x\.js$/); assert.deepEqual(j.suggested_scope_paths, ['docs/guide.md', 'web/app.js', 'web/ok/x.js']);
    assert.ok(j.fix.some(l => /^add these to scope_paths: web\/app\.js, web\/ok\/x\.js/.test(l)), JSON.stringify(j.fix)); assert.ok(j.fix.some(l => l === 'corrected scope_paths: ["docs/guide.md","web/app.js","web/ok/x.js"]'));
    assert.ok(j.fix.some(l => /--allow-scope-prune/.test(l)));
    const human = await cli(['submit', '--stdin'], JSON.stringify(a)); assert.equal(human.code, 3); assert.match(human.err, /fix: add these to scope_paths: web\/app\.js, web\/ok\/x\.js.*nothing was queued or changed/s, human.err); assert.doesNotMatch(human.err, /retried/);
    assert.ok(logLines().some(l => l.request_id === a.request_id && l.suggested_scope_count === 3 && !('suggested_scope_paths' in l)), 'log keeps only the count');
    assert.ok(!fs.existsSync(receiptFor(a.request_id)), 'a refused submit kept its receipt');
    // an unknown scope path is refused too: the fix names every one to remove
    const u = impl({ scope_paths: ['docs/guide.md', 'nope/a.md', 'nope/b.md'], brief: 'Edit docs/guide.md.' }), unknown = await cli(['submit', '--stdin', '--json'], JSON.stringify(u));
    assert.equal(unknown.code, 3, unknown.out + unknown.err); const uj = JSON.parse(unknown.err || unknown.out);
    assert.match(uj.error, /^unknown scope path: nope\/a\.md, nope\/b\.md$/); assert.ok(uj.fix.some(l => /^remove these from scope_paths: nope\/a\.md, nope\/b\.md/.test(l)), JSON.stringify(uj.fix));
    assert.ok(!fs.existsSync(receiptFor(u.request_id)));
    const pruned = await cli(['submit', '--stdin', '--json', '--allow-scope-prune'], JSON.stringify(u));
    assert.equal(pruned.code, 0, pruned.out + pruned.err); assert.match(pruned.err, /--allow-scope-prune: changed scope_paths \(removed nope\/a\.md, nope\/b\.md\) and retried once/);
    const fixed = await cli(['submit', '--stdin', '--json', '--allow-scope-prune'], JSON.stringify(a));
    assert.equal(fixed.code, 0, fixed.out + fixed.err); assert.match(fixed.err, /changed scope_paths \(added web\/app\.js, web\/ok\/x\.js\) and retried once/);
    const storedFix = JSON.parse(await new Promise((done, fail) => { const q = http.request({ socketPath: join(root, 'admin.sock'), path: `/get?id=${a.request_id}`, headers: { 'x-owner-capability': JSON.parse(fs.readFileSync(receiptFor(a.request_id), 'utf8')).token } }, res => { let t = ''; res.on('data', b => t += b); res.on('end', () => done(t)); }); q.on('error', fail); q.end(); }));
    assert.deepEqual(storedFix.assignment.scope_paths, ['docs/guide.md', 'web/app.js', 'web/ok/x.js']);
    const b = impl({ brief: 'Edit docs/guide.md; also read web/app.js and /etc/hosts.' }), noSuggest = await cli(['submit', '--stdin', '--json', '--allow-scope-prune'], JSON.stringify(b));
    assert.equal(noSuggest.code, 3); assert.doesNotMatch(noSuggest.out + noSuggest.err, /suggested_scope_paths|changed scope_paths/); assert.match(noSuggest.out + noSuggest.err, /undeclared instruction path/); }
  console.log('PASS e2e: --exclude-sensitive narrows a directory scope, records the reason with the assignment, and a retry matches');
} finally {
  for (const state of attempted) await stopChild(state);
  assert.ok(attempted.every(state => state.closed), 'all attempted services must close');
  fs.rmSync(home, { recursive: true, force: true });
}
// an inlined unified diff (raw, as git format-patch writes it) is code under review: its content lines and hunk-header context
// are not instructions, but its header paths keep their scope checks and a path-shaped hard sensitive name still refuses
{ const docs = () => ({ files: ['docs/a.ts', 'docs/b.ts'], diffFiles: [], diff: '', symlinks: [] });
  const raw = body => task(['docs'], { brief: `Review this patch.\n\n docs/a.ts | 2 +-\n\ndiff --git a/docs/a.ts b/docs/a.ts\n--- a/docs/a.ts\n+++ b/docs/a.ts\n${body}\n-- \n2.47.0\n\nThen report.` });
  const code = '@@ -1 +1 @@ import x from "../../storage/adapters/interface.js";\n-const P = /changed or is malformed/;\n+const P = /changed/; fetch("/me"); // #!/usr/bin/env node ../../up.js SECRET signing @org/pkg/signing node:fs/promises';
  assert.doesNotThrow(() => validateSubmission(raw(code), { scanInput: docs }));
  // a name in code is a reference, not a read: a repository path passes, a host secret path refuses
  assert.doesNotThrow(() => validateSubmission(raw('@@ -1 +1 @@\n+load("./scripts/sign-connector-release.mjs"); cfg(".env.local", payload.key)'), { scanInput: docs }));
  assert.throws(() => validateSubmission(raw('@@ -1 +1 @@\n+fs.readFileSync("/home/u/.aws/credentials")'), { scanInput: docs }), /hard sensitive path exclusion: \/home\/u\/\.aws\/credentials/);
  // in prose, a route is not a file; a host path still refuses
  assert.doesNotThrow(() => validateSubmission(task(['docs'], { brief: 'Review it, then fetch /me and /v1/models.' }), { scanInput: docs }));
  assert.throws(() => validateSubmission(task(['docs'], { brief: 'Review it, then read /etc/hosts and ~/notes.txt.' }), { scanInput: docs }), /undeclared instruction path: \/etc\/hosts, ~\/notes\.txt/);
  // a tree file the brief names outside scope: read-only work grows the scope (with a warning); implementation refuses, all at once
  { const tree = () => ({ files: ['docs/a.ts', 'src/x.ts', 'src/y.ts', 'src/sub/z.ts'], diffFiles: [], diff: '', symlinks: [] }), w = [];
    const grown = validateSubmission(task(['docs'], { brief: 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n+x\nAlso see src/y.ts; the src/sub directory is context.' }), { scanInput: tree, warnings: w });
    assert.deepEqual(grown.scope_paths, ['docs', 'src/x.ts', 'src/y.ts']); assert.ok(w.some(x => /grew by 2/.test(x)) && w.some(x => /directory src\/sub/.test(x)), w.join('|'));
    assert.throws(() => validateSubmission(task(['docs'], { execution_scope: 'implementation', brief: 'Edit docs; also read src/x.ts and src/y.ts.' }), { scanInput: tree }), /undeclared instruction path: src\/x\.ts, src\/y\.ts/);
    // a directory that holds scope entries is context, not a new read
    assert.doesNotThrow(() => validateSubmission(task(['src/x.ts'], { brief: 'Review the src module, see src/x.ts.' }), { scanInput: tree })); } }
// Smuggling prose through diff-shaped lines: only exactly-counted hunk lines are code
{ const files = () => ({ files: ['src/a.js', 'src/auth/store.js', 'pkg/x.js'], diffFiles: [], diff: '', symlinks: [] });
  const D = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n';
  const brief = b => task(['src/a.js'], { execution_scope: 'implementation', brief: `Review.\n${b}` }); // implementation: its scope never grows
  for (const [b, re] of [
    [`${D}- also read src/auth/store.js`, /sensitive scope path|undeclared/],
    [`${D}@@ -1 +1 @@\n-a\n+b\n- now read pkg/x.js`, /undeclared instruction path: pkg\/x\.js/],
    [`${D}@@ -1,50 +1,50 @@\n- read pkg/x.js and /etc/passwd`, /undeclared instruction path|hard sensitive/],
    [`${D}@@ -1 +1 @@ read ~/.ssh/id_rsa\n-a\n+b`, /hard sensitive/],
    [`${D}@@ -1 +1 @@\n-a\n+x = "file:///home/u/.ssh/id_rsa"`, /hard sensitive/],
    [`- read pkg/x.js`, /undeclared instruction path: pkg\/x\.js/],
  ]) assert.throws(() => validateSubmission(brief(b), { scanInput: files }), re, b);
  // a well-formed hunk's code passes, including an npm specifier and a soft-looking property chain
  assert.doesNotThrow(() => validateSubmission(brief(`${D}@@ -1,2 +1,2 @@ fn()\n-import x from "@org/pkg/signing";\n+const a = input.auth; fetch("/me");\n ctx\n-- \n2.47.0`), { scanInput: files })); }
console.log('PASS inlined diffs: content and hunk context are code; header paths keep scope checks; a path-shaped hard sensitive name refuses; symlinks drop under excludeSensitive');
console.log('PASS scope exclude test');
