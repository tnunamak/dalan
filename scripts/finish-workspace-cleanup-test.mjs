#!/usr/bin/env node
// A finish removes the assignment's checkout at the moment the finish commits, not only in the hourly sweep:
// the report, patch and check evidence are already artifacts, and no reader touches the tree afterwards
// (Workspace.result refuses a finished assignment; owner /get, /wait and /artifact read the store and the
// artifacts). The rules under test: cleanup runs only after a committed finish (a refused or rolled-back
// finish keeps the tree), a repeated finish cleans nothing twice and recreates nothing, an active check
// keeps the tree for the sweep, a cleanup failure never fails or delays the finish reply (it logs and
// leaves the row), and finish_handoff still hands the same worker its next job with its own workspace.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { fetchForPublicHost } from '../src/test-support/public-host-fetch.mjs';
import { portFromListeningBanner } from '../src/test-support/port.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const scratch = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true });
const assert = (v, m) => { if (!v) throw new Error(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A local repository the bridge can mirror and check out.
const home = fs.mkdtempSync(path.join(scratch, 'dfc-'));
const repoDir = path.join(home, 'repo'), config = path.join(home, '.config/dot-bridge'), workRoot = path.join(home, 'work');
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
fs.mkdirSync(repoDir);
run('git', ['init', '-q'], repoDir);
run('git', ['config', 'user.email', 'test@example.com'], repoDir);
run('git', ['config', 'user.name', 'Test'], repoDir);
fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'before\n');
run('git', ['add', '.'], repoDir);
run('git', ['commit', '-qm', 'base'], repoDir);
const baseSha = run('git', ['rev-parse', 'HEAD'], repoDir);

// The bridge: OAuth fixture (workspace needs oauth), workspace enabled, finish_handoff for the handoff scenario.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig' };
const jwks = http.createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
await new Promise(r => jwks.listen(0, '127.0.0.1', r));
const issuer = `http://127.0.0.1:${jwks.address().port}/realm`, aud = 'https://dot-bridge.example.test';
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${aud}\nOAUTH_JWKS_URI=${issuer.replace('/realm', '/jwks')}\nOAUTH_ALLOWED_SUBJECTS=dot\n`, { mode: 0o600 });
fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify({ workers: { dot: {
  connections: [{ issuer, subject: 'dot', client_id: 'fixture' }], repos: ['example-owner/fixture'], workspaceAllowed: true, finish_handoff: { wait_ms: 0 } } }, default_execution: 'none' }), { mode: 0o600 });
const env = { ...process.env, HOME: home, DALAN_PORT: '0', DALAN_AUTH_MODE: 'oauth', DALAN_TEST_OAUTH: '1',
  DALAN_ENABLE_WORKSPACE: '1', DALAN_T3_DRY_RUN: '1', DALAN_WORKSPACE_ROOT: workRoot, DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE: repoDir };
const server = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
let port = null, serverStderr = '';
server.stdout.on('data', b => { port = portFromListeningBanner(String(b)) ?? port; });
server.stderr.on('data', b => { serverStderr += b; process.stderr.write(b); });
const dataDir = path.join(home, '.local/share/dot-bridge');
const { DatabaseSync } = await import('node:sqlite');
let db = null;
try {
  const deadline = Date.now() + 20000;
  while (!port && server.exitCode === null && Date.now() < deadline) await sleep(50);
  assert(port, `bridge did not start: ${serverStderr}`);
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dataDir, 'bridge.db')); i++) await sleep(50);
  db = new DatabaseSync(path.join(dataDir, 'bridge.db'));
  db.exec('PRAGMA busy_timeout=5000');

  const secret = fs.readFileSync(path.join(config, 'env'), 'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const fetchPub = fetchForPublicHost(new URL(aud).host);
  const token = () => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: issuer, aud, exp: Math.floor(Date.now() / 1000) + 300, sub: 'dot', client_id: 'fixture', scope: 'dot-bridge.read dot-bridge.work' })).toString('base64url');
    const body = h + '.' + p;
    return body + '.' + sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url');
  };
  const call = async (name, args) => {
    const r = await fetchPub(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token() },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { throw new Error(`${name} returned HTTP ${r.status}: ${text.slice(0, 300) || '(empty body)'}`); }
    return { isError: !!j.result.isError, text: j.result.content[0].text, data: j.result.isError ? null : JSON.parse(j.result.content[0].text) };
  };
  const ok = async (name, args) => { const r = await call(name, args); assert(!r.isError, `${name} failed: ${r.text}`); return r.data; };
  const socket = path.join(dataDir, 'admin.sock');
  const admin = (route, body) => new Promise((resolve, reject) => {
    const q = http.request({ socketPath: socket, path: route, method: 'POST', headers: { 'content-type': 'application/json' } },
      r => { let b = ''; r.on('data', x => b += x); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    q.on('error', reject); q.end(JSON.stringify(body));
  });
  const impl = id => ({ schema_version: 1, request_id: id, brief: `finish cleanup ${id}`, inputs: [{ github_repo: 'example-owner/fixture', base_sha: baseSha }], scope_paths: ['hello.txt'], expected_output: 'patch', execution_scope: 'implementation' });
  const submit = async assignment => { const r = await admin('/submit', { delivery: 'none', owner_token: 'fixture-owner', assignment }); assert(r.status === 200, `submit failed: ${JSON.stringify(r.body)}`); };
  const newJob = async () => { const id = `req_${randomUUID()}`; await submit(impl(id)); const claim = await ok('claim', { request_id: id, claimant: 'dot' }); await ok('list_files', { request_id: id, claim_id: claim.claim_id }); return { id, claimId: claim.claim_id }; };
  const tree = id => path.join(workRoot, 'worktrees', id);
  const row = id => !!db.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(id);
  const rowGone = async id => { for (let i = 0; i < 200; i++) { if (!row(id)) return true; await sleep(50); } return false; };
  const finishArgs = job => ({ request_id: job.id, claim_id: job.claimId, outcome: 'completed', summary: 'done', result: 'done' });
  const finish = job => ok('finish', finishArgs(job));

  // 1. The finish itself removes the tree: worktree, row, dependency cache and ignored-written record.
  {
    const job = await newJob();
    assert(fs.existsSync(tree(job.id)), 'claim must create the worktree');
    assert(row(job.id), 'claim must record the workspace row');
    fs.writeFileSync(path.join(workRoot, 'worktrees', `${job.id}.ignored-written.json`), JSON.stringify({ paths: ['secret.env'] }));
    fs.mkdirSync(path.join(workRoot, 'caches', job.id, 'npm'), { recursive: true });
    const receipt = await finish(job);
    assert(receipt.receipt_id && receipt.request_id === job.id, `finish receipt wrong: ${JSON.stringify(receipt)}`);
    assert(await rowGone(job.id), `the finished workspaces row must be removed once the finish commits: ${job.id}`);
    assert(!fs.existsSync(tree(job.id)), 'the finished worktree must be removed');
    assert(!fs.existsSync(path.join(workRoot, 'caches', job.id)), 'the finished assignment cache must be removed');
    assert(!fs.existsSync(path.join(workRoot, 'worktrees', `${job.id}.ignored-written.json`)), 'the ignored-written record must be removed');
    // The patch was captured inside the finish transaction, so the owner's evidence outlives the tree.
    const evidence = JSON.parse(db.prepare('SELECT workspace_evidence FROM reports WHERE request_id=?').get(job.id).workspace_evidence);
    assert(evidence.patch_artifact?.artifact_id && fs.existsSync(path.join(workRoot, 'artifacts', evidence.patch_artifact.artifact_id)), 'the patch artifact must survive the tree');
    // A repeated finish replays the same receipt and recreates nothing.
    const retry = await finish(job);
    assert(retry.duplicate === true && retry.receipt_id === receipt.receipt_id, `a repeated finish must replay the receipt: ${JSON.stringify(retry)}`);
    assert(!row(job.id) && !fs.existsSync(tree(job.id)), 'a repeated finish must not recreate the workspace');
    console.log('PASS a committed finish removes its worktree, row, cache and ignored-written record; the patch artifact stays; a repeated finish is a no-op');
  }

  // 2. A refused finish leaves the tree working in (rule: cleanup runs only after the finish commits).
  {
    const job = await newJob();
    const refused = await call('finish', { ...finishArgs(job), result: '' });
    assert(refused.isError, 'an empty result must be refused');
    const wrongClaim = await call('finish', { ...finishArgs(job), claim_id: `claim_${randomUUID()}` });
    assert(wrongClaim.isError, 'a wrong claim must be refused');
    assert(fs.existsSync(tree(job.id)) && row(job.id), 'a refused finish must leave the tree and the row');
    const receipt = await finish(job);
    assert(receipt.receipt_id, 'the valid finish must still work');
    assert(await rowGone(job.id) && !fs.existsSync(tree(job.id)), 'the valid finish removes the tree');
    console.log('PASS a refused or wrong-claim finish leaves the tree; the committed finish removes it');
  }

  // 3. A cleanup failure never fails the finish reply: it logs artifact_cleanup_error and leaves the row to the sweep.
  {
    const job = await newJob();
    fs.chmodSync(tree(job.id), 0o500); // git worktree remove cannot delete the files; reads still work, so the finish succeeds
    const receipt = await finish(job);
    assert(receipt.receipt_id, `a cleanup failure must not fail the finish reply: ${JSON.stringify(receipt)}`);
    await sleep(500);
    assert(row(job.id) && fs.existsSync(tree(job.id)), 'a failed cleanup must leave the row and the tree');
    const logText = fs.readFileSync(path.join(home, '.local/state/dot-bridge/requests.jsonl'), 'utf8');
    assert(logText.includes('"kind":"artifact_cleanup_error"') && logText.includes(job.id), 'the cleanup failure must be logged as artifact_cleanup_error');
    fs.chmodSync(tree(job.id), 0o700);
    console.log('PASS a failed cleanup logs artifact_cleanup_error and leaves the row; the finish reply is unaffected');
  }

  // 4. finish_handoff still hands the next job, and cleaning the finished row leaves the next claim's workspace alone.
  {
    const first = await newJob();
    const secondId = `req_${randomUUID()}`;
    await submit(impl(secondId));
    const done = await finish(first);
    assert(done.next_job?.request_id === secondId && done.next_job.claim_id, `the finish must hand the next job: ${JSON.stringify(done)}`);
    await ok('list_files', { request_id: secondId, claim_id: done.next_job.claim_id });
    assert(fs.existsSync(tree(secondId)) && row(secondId), 'the handed-off job must have its own workspace');
    assert(await rowGone(first.id) && !fs.existsSync(tree(first.id)), 'the finished tree must be removed while the next workspace lives');
    const second = { id: secondId, claimId: done.next_job.claim_id };
    const receipt = await finish(second);
    assert(receipt.receipt_id, `the handed-off job must finish: ${JSON.stringify(receipt)}`);
    assert(await rowGone(secondId) && !fs.existsSync(tree(secondId)), 'the second finish removes its own tree');
    console.log('PASS finish_handoff hands the next job; the next claim keeps its workspace; each finish cleans only its own tree');
  }

  // 5. Read-only and no-workspace assignments finish exactly as today: nothing to clean, no error.
  {
    const id = `req_${randomUUID()}`;
    await submit({ schema_version: 1, request_id: id, brief: 'read only', inputs: [], expected_output: 'one line', execution_scope: 'read-only' });
    const claim = await ok('claim', { request_id: id, claimant: 'dot' });
    const receipt = await ok('finish', { request_id: id, claim_id: claim.claim_id, outcome: 'completed', summary: 's', result: 'r' });
    assert(receipt.receipt_id && receipt.duplicate === false, `a read-only finish without a workspace must be unchanged: ${JSON.stringify(receipt)}`);
    assert(!row(id), 'a no-repo assignment has no workspace row');
    console.log('PASS a read-only assignment without a workspace finishes unchanged');
  }

  // In-process rules on the shared removal method: an active check defers to the sweep, and the sweep retries a row
  // a failed cleanup left behind. Uses the same Store/Workspace fixtures as the workspace disk tests.
  {
    const home2 = fs.mkdtempSync(path.join(scratch, 'dfc-unit-')), root2 = path.join(home2, 'work');
    process.env.HOME = home2;
    process.env.DALAN_WORKSPACE_ROOT = root2;
    process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repoDir;
    const { Store } = await import('../src/store.mjs');
    const { Workspace } = await import('../src/workspace.mjs');
    const { parseWorkers } = await import('../src/workers.mjs');
    const workers = parseWorkers({ workers: { dot: { capabilities: [] } }, default_execution: 'none' }, { builtin: true });
    const store = new Store(path.join(home2, 'bridge.db'), { workers });
    const ws = new Workspace(store, true, { freeBytes: async () => 100 * 2 ** 30 });
    const db2 = store.db;
    let sequence = 0;
    // A finished row past retention (7 h old), so the sweep treats it as removable.
    const makeFinished = () => {
      const id = `req_${randomUUID()}`;
      const payload = { schema_version: 1, request_id: id, brief: `cleanup rules ${++sequence}`, inputs: [{ github_repo: 'example-owner/fixture', base_sha: baseSha }], expected_output: 'patch', execution_scope: 'implementation' };
      store.submit(payload, 'thread', 'env', 'owner', false, null, 'normal', null, payload, null, 'dot');
      const claimId = store.claim(id, 'dot', 'subject', 99, null, 'dot').claim_id;
      ws.ensure(id, claimId, 'subject', false, 'dot');
      db2.prepare("UPDATE assignments SET status='finished' WHERE request_id=?").run(id);
      db2.prepare("INSERT INTO reports(request_id,claim_id,outcome,summary,result,receipt_id,created_at) VALUES(?,?,'completed','s','r',?,?)")
        .run(id, claimId, `rcpt_${randomUUID()}`, new Date(Date.now() - 7 * 3600000).toISOString());
      return id;
    };
    const tree2 = id => path.join(root2, 'worktrees', id);
    const row2 = id => !!db2.prepare('SELECT 1 FROM workspaces WHERE request_id=?').get(id);

    // A row that is not terminal keeps its tree: a finish recorded while another grant is live must not remove it.
    const live = makeFinished();
    db2.prepare("UPDATE assignments SET status='claimed' WHERE request_id=?").run(live);
    assert((await ws.removeTerminalWorkspace(live)) === null && (await ws.removeTerminalWorkspace(live, { cacheOnly: true })) === null, 'a non-terminal row must not be cleaned');
    assert(row2(live) && fs.existsSync(tree2(live)), 'a non-terminal row keeps its workspace row and tree');
    db2.prepare("UPDATE assignments SET status='finished' WHERE request_id=?").run(live);
    assert((await ws.removeTerminalWorkspace(live)) === 'removed' && !row2(live), 'the same row is removed once it is terminal');

    // An active check keeps the tree: neither the finish path nor the sweep touches it; the sweep takes it later.
    const checked = makeFinished();
    ws.activeChecks.add(checked);
    assert((await ws.removeTerminalWorkspace(checked)) === null, 'an active check must stop the finish-path removal');
    assert(row2(checked) && fs.existsSync(tree2(checked)), 'the tree and row must stay while a check runs');
    await ws.sweepExpired(() => {});
    assert(row2(checked) && fs.existsSync(tree2(checked)), 'the sweep must also spare an active check');
    ws.activeChecks.delete(checked);
    await ws.sweepExpired(() => {});
    assert(!row2(checked) && !fs.existsSync(tree2(checked)), 'the sweep must remove the tree once the check ends');

    // A terminal row can outlive its tree; the sidecar is still owed.
    const treeGone = makeFinished();
    const treeGoneSidecar = ws.ignoredWrittenFile(treeGone);
    fs.writeFileSync(treeGoneSidecar, '{}');
    fs.rmSync(tree2(treeGone), { recursive: true });
    assert((await ws.removeTerminalWorkspace(treeGone)) === 'removed', 'a missing terminal tree must not strand cleanup');
    assert(!row2(treeGone) && !fs.existsSync(treeGoneSidecar), 'missing-tree cleanup must remove the sidecar and row');

    // A sidecar failure after worktree removal leaves retryable bookkeeping.
    const sidecarFailed = makeFinished();
    const sidecar = ws.ignoredWrittenFile(sidecarFailed);
    fs.mkdirSync(sidecar);
    fs.writeFileSync(path.join(sidecar, 'fixture'), 'test');
    let sidecarError;
    try { await ws.removeTerminalWorkspace(sidecarFailed); } catch (error) { sidecarError = error; }
    assert(sidecarError?.path === sidecar && row2(sidecarFailed), 'the sidecar must be the failure and keep the row');
    assert(!fs.existsSync(tree2(sidecarFailed)), 'the tree must already be gone when sidecar removal fails');
    fs.unlinkSync(path.join(sidecar, 'fixture'));
    fs.rmdirSync(sidecar);
    assert((await ws.removeTerminalWorkspace(sidecarFailed)) === 'removed' && !row2(sidecarFailed), 'retry must remove the stranded row');
    console.log('PASS a missing worktree does not strand terminal sidecar or row cleanup');

    // A failed removal leaves the row; once the obstacle is gone, the sweep retries and removes it.
    const failed = makeFinished();
    fs.renameSync(tree2(failed), `${tree2(failed)}-moved`);
    db2.prepare('UPDATE workspaces SET path=? WHERE request_id=?').run(`${tree2(failed)}-moved`, failed);
    const errors = [];
    let integrityError = null;
    try { await ws.sweepExpired(e => errors.push(e)); } catch (error) { integrityError = error; }
    assert(integrityError && /workspace cleanup path mismatch/.test(integrityError.message), `a tampered row must abort the sweep as an integrity error, got ${integrityError?.message ?? 'no error'}`);
    assert(row2(failed), 'the failed removal must leave the row');
    fs.renameSync(`${tree2(failed)}-moved`, tree2(failed));
    db2.prepare('UPDATE workspaces SET path=? WHERE request_id=?').run(tree2(failed), failed);
    await ws.sweepExpired(e => errors.push(e));
    assert(!row2(failed) && !fs.existsSync(tree2(failed)), 'the sweep must retry and remove the repaired row');
    assert(errors.every(e => e.kind !== 'artifact_cleanup_error'), 'an integrity abort must not be logged as a per-row cleanup failure');
    console.log('PASS an active check defers removal to the sweep; a failed removal leaves the row and the sweep retries it');
  }
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise(r => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([stopped, sleep(5000).then(() => server.kill('SIGKILL'))]);
  }
  await new Promise(r => jwks.close(r));
  if (db) try { db.close(); } catch {}
  for (const dir of [workRoot, home]) { try { spawnSync('chmod', ['-R', 'u+w', dir]); } catch {} }
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('PASS finish-workspace-cleanup');
