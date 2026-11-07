#!/usr/bin/env node
// Claim-authority build (compatible immediate rule + worker-get redaction).
// Part 1 pins the legacy claim matrix at Store level with a fake clock:
// exact nonempty retries return the grant; omitted/different acquisitions
// against a stored nonempty grant, and newly supplied acquisitions against a
// stored unkeyed grant, are refused while the grant is live; unkeyed-to-
// unkeyed retries still return the grant; post-expiry admissions start a new
// epoch (a new admission, not a retry). Part 2 runs the real server and
// asserts worker `get` exposes none of claim_id, origin_claim_id or
// acquisition_id outside the assignment, while the assignment itself and the
// stored owner evidence stay intact. A worker `claim` reply lists an inherited
// upload without origin_claim_id. Owner `get` bypasses the worker
// projection in server.mjs by construction (it calls withAvailableChecks on
// store.get directly), so Part 2 checks stored evidence rather than the
// owner HTTP endpoint. Question answers are not exercised here: answering
// needs the owner endpoint, and question projection is already covered by
// question-projection-test.mjs. Every check is independent and reports
// PASS/FAIL, so a failure in one does not hide the rest.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_ISOLATION_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'cmr-'));
const failures = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}: ${String(error.stack ?? error).split('\n').slice(0, 12).join(' | ')}`); }
}
const rid = label => `req_${label}_${randomUUID().slice(0, 8)}`;
const HIDDEN = new Set(['claim_id', 'origin_claim_id', 'acquisition_id']);
function hiddenOutsideAssignment(value, pathSoFar = '$') {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((child, i) => found.push(...hiddenOutsideAssignment(child, `${pathSoFar}[${i}]`)));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (HIDDEN.has(key)) found.push(`${pathSoFar}.${key}`);
      else if (key !== 'assignment') found.push(...hiddenOutsideAssignment(child, `${pathSoFar}.${key}`));
    }
  }
  return found;
}

// ---------------------------------------------------------------- Part 1: the Store, with a fake clock
const MIN = 60000;
let now = Date.parse('2026-10-08T00:00:00.000Z');
const openStore = (name, options = {}) => new Store(path.join(root, `${name}.db`), {
  now: () => now, capacity: 6,
  limits: { intervalMs: 10 * MIN, maxCount: 3, silenceMs: 20 * MIN, leaseMs: 60 * MIN },
  resumeIdleMs: 120000, ...options,
});
const payload = id => ({ schema_version: 1, request_id: id, brief: `redaction ${id}`, inputs: [], expected_output: 'one result', execution_scope: 'read-only' });
const claimRow = (s, id) => s.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id);
const claimIt = (s, id, claimant, acquisitionId, leaseMs = 60 * MIN) => s.claim(id, claimant, 'subject_a', 6, null, 'dot', acquisitionId, leaseMs);

await check('exact nonempty acquisition retry returns the same grant and refreshes activity', async () => {
  const s = openStore('exact');
  const id = rid('exact');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const first = claimIt(s, id, 'holder', 'acq-1');
  assert.equal(first.duplicate, false); assert.equal(first.epoch, 1);
  now += 5000;
  const again = claimIt(s, id, 'holder', 'acq-1');
  assert.equal(again.duplicate, true); assert.equal(again.claim_id, first.claim_id); assert.equal(again.epoch, 1);
  assert.equal(claimRow(s, id).last_claim_activity_at, new Date(now).toISOString());
  s.db.close();
});

await check('omitted acquisition against a stored nonempty grant is refused and changes nothing', async () => {
  const s = openStore('omitted');
  const id = rid('omitted');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const first = claimIt(s, id, 'holder', 'acq-1');
  const before = JSON.stringify(claimRow(s, id));
  assert.throws(() => claimIt(s, id, 'holder', null), /claim_busy/);
  assert.equal(JSON.stringify(claimRow(s, id)), before);
  assert.equal(claimRow(s, id).claim_id, first.claim_id);
  s.db.close();
});

await check('different acquisition against a stored nonempty grant is refused and changes nothing', async () => {
  const s = openStore('different');
  const id = rid('different');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const first = claimIt(s, id, 'holder', 'acq-1');
  const before = JSON.stringify(claimRow(s, id));
  assert.throws(() => claimIt(s, id, 'holder', 'acq-2'), /claim_busy/);
  assert.equal(JSON.stringify(claimRow(s, id)), before);
  assert.equal(claimRow(s, id).claim_id, first.claim_id);
  s.db.close();
});

await check('newly supplied acquisition against a stored unkeyed grant is refused, never adopted', async () => {
  const s = openStore('keyed-against-unkeyed');
  const id = rid('unkeyed');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const first = claimIt(s, id, 'holder', null);
  assert.equal(claimRow(s, id).acquisition_id, null);
  const before = JSON.stringify(claimRow(s, id));
  assert.throws(() => claimIt(s, id, 'holder', 'acq-new'), /claim_busy/);
  assert.equal(JSON.stringify(claimRow(s, id)), before);
  assert.equal(claimRow(s, id).claim_id, first.claim_id);
  assert.equal(claimRow(s, id).acquisition_id, null);
  s.db.close();
});

await check('unkeyed-to-unkeyed legacy retry still returns the existing grant', async () => {
  const s = openStore('legacy');
  const id = rid('legacy');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const first = claimIt(s, id, 'holder', null);
  const again = claimIt(s, id, 'holder', null);
  assert.equal(again.duplicate, true); assert.equal(again.claim_id, first.claim_id); assert.equal(again.epoch, 1);
  s.db.close();
});

await check('rival claimant with the same acquisition is refused while the grant is live', async () => {
  const s = openStore('rival');
  const id = rid('rival');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const first = claimIt(s, id, 'holder', 'acq-1');
  const before = JSON.stringify(claimRow(s, id));
  assert.throws(() => claimIt(s, id, 'rival', 'acq-1'), /claim_busy/);
  assert.equal(JSON.stringify(claimRow(s, id)), before);
  assert.equal(claimRow(s, id).claim_id, first.claim_id);
  s.db.close();
});

await check('with idle rotation disabled, a live-grant acquisition mismatch is already claimed, not claim_busy', async () => {
  const s = openStore('disabled-idle', { resumeIdleMs: 0 });
  const id = rid('disabled');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  claimIt(s, id, 'holder', 'acq-1');
  assert.throws(() => claimIt(s, id, 'holder', 'acq-2'), /already claimed by another claimant/);
  s.db.close();
});

await check('post-expiry idle rotation starts a new epoch under the caller acquisition (new admission, not a retry)', async () => {
  const s = openStore('rotate');
  const id = rid('rotate');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const first = claimIt(s, id, 'holder', 'acq-old', MIN);
  now += 200000; // past the 60s lease and the 120s idle threshold, no running check
  const next = claimIt(s, id, 'holder', 'acq-new');
  assert.equal(next.duplicate, false); assert.equal(next.resumed, true);
  assert.equal(next.epoch, first.epoch + 1); assert.notEqual(next.claim_id, first.claim_id);
  assert.equal(claimRow(s, id).acquisition_id, 'acq-new');
  s.db.close();
});

await check('post-expiry admission with idle rotation disabled still starts a new epoch', async () => {
  const s = openStore('takeover', { resumeIdleMs: 0 });
  const id = rid('takeover');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const first = claimIt(s, id, 'holder', 'acq-old', MIN);
  now += 120000; // past the 60s lease
  const next = claimIt(s, id, 'holder', 'acq-new');
  assert.equal(next.duplicate, false); assert.equal(next.epoch, first.epoch + 1);
  assert.notEqual(next.claim_id, first.claim_id);
  s.db.close();
});

await check('Store-level get keeps capability evidence (server projection removes it, not the Store)', async () => {
  const s = openStore('evidence');
  const id = rid('evidence');
  s.submit(payload(id), { mode: 'none' }, null, 'owner');
  claimIt(s, id, 'holder', 'acq-1');
  const got = s.get(id);
  assert.equal(got.claim.activity.acquisition_id, 'acq-1');
  assert.equal(Object.hasOwn(got.claim, 'acquisition_id'), false);
  s.db.close();
});

// ---------------------------------------------------------------- Part 2: the real server, OAuth mode, one subject
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
const jwks = http.createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${jwks.address().port}/realm`, audience = 'https://dot-bridge.example.test';
const token = (azp, extra = {}) => {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 600, sub: 'owner', scope: 'dot-bridge.read dot-bridge.work', ...(azp ? { azp } : {}), ...extra })).toString('base64url');
  return `${head}.${claims}.${sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url')}`;
};
const ntfy = http.createServer(async (req, res) => { for await (const chunk of req); res.end('ok'); });
await new Promise(resolve => ntfy.listen(0, '127.0.0.1', resolve));

async function startServer(name, workers) {
  const home = path.join(root, name), config = path.join(home, '.config/dot-bridge');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true }); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=${issuer.replace('/realm', '/jwks')}\nOAUTH_ALLOWED_SUBJECTS=owner\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'limits.json'), JSON.stringify({ max_claimed_outer_assignments: 10 }), { mode: 0o600 }); // claiming checks below each keep their claim open; 10 is the largest allowed cap
  fs.writeFileSync(path.join(config, 'alerts.env'), `NTFY_URL=http://127.0.0.1:${ntfy.address().port}/alert\n`, { mode: 0o600 });
  if (workers) fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify(workers), { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'bin/t3code'), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,data:{threads:[]}}));\n`, { mode: 0o755 });
  // the stable catalog hides ask_question; questions-v1 adds only ask_question and consume_answer
  const env = { ...process.env, DALAN_ENABLE_T3_TOOLS: '1', DALAN_CATALOG_PROFILE: 'questions-v1', HOME: home, DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1', DOT_BRIDGE_WORKSPACE_ROOT: path.join(home, 'work'), PATH: `${path.join(home, 'bin')}:${process.env.PATH}` };
  delete env.DOT_BRIDGE_WORKERS_FILE;
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let port = null, stderr = '', done = false;
  child.stdout.on('data', b => { const m = /MCP listening on 0\.0\.0\.0:(\d+)/.exec(String(b)); if (m) port = Number(m[1]); });
  child.stderr.on('data', b => { stderr += b; });
  child.once('exit', () => { done = true; });
  for (let i = 0; i < 200 && port === null && !done; i++) await sleep(50);
  const server = { name, home, env, child, get stderr() { return stderr; }, port };
  server.stop = async () => { if (done) return; child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); };
  if (port === null) return server;
  const secret = fs.readFileSync(path.join(config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  server.dbPath = path.join(home, '.local/share/dot-bridge/bridge.db');
  server.rpc = async (bearer, method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  server.tool = async (bearer, name, args = {}) => {
    const { status, body } = await server.rpc(bearer, 'tools/call', { name, arguments: args });
    if (status !== 200) return { ok: false, status, error: JSON.stringify(body) };
    const text = body.result.content[0].text;
    return body.result.isError ? { ok: false, error: text } : { ok: true, value: JSON.parse(text) };
  };
  server.cli = (args, input) => { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env, input, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  server.submit = (id, extraInput = {}) => server.cli(['submit', '--stdin', '--json', '--worker', 'lark'], JSON.stringify({
    schema_version: 1, request_id: id, brief: `redaction ${id}`, inputs: [{ revision: 'abc', ...extraInput }],
    expected_output: 'one result', execution_scope: 'read-only',
  }));
  return server;
}
const dbRead = (server, sql, ...args) => { const db = new DatabaseSync(server.dbPath, { readOnly: true }); try { return db.prepare(sql).all(...args); } finally { db.close(); } };

const profile = { workers: {
  dot: { connections: [{ issuer, subject: 'owner', client_id: 'client-dot' }] },
  lark: { connections: [{ issuer, subject: 'owner', client_id: 'client-lark' }] },
} };
const T = { lark: token('client-lark') };
let server = null;
try {
  server = await startServer('main', profile);
  await check('real server starts', async () => {
    assert.notEqual(server.port, null, `server did not start: ${server.stderr}`);
  });
  if (server.port !== null) {
    const workerGet = async id => {
      const got = await server.tool(T.lark, 'get', { request_id: id });
      assert.equal(got.ok, true, got.error);
      return got.value;
    };

    await check('worker get of an active claim hides claim_id and activity acquisition_id, keeps epoch/state/lease', async () => {
      const id = rid('active');
      assert.equal(server.submit(id).code, 0);
      const claim = await server.tool(T.lark, 'claim', { request_id: id, claimant: 'redaction-worker', acquisition_id: 'acq-server-1' });
      assert.equal(claim.ok, true, claim.error);
      const got = await workerGet(id);
      assert.ok(got.claim, 'worker get has no claim');
      assert.equal(Object.hasOwn(got.claim, 'claim_id'), false);
      assert.equal(Object.hasOwn(got.claim.activity ?? {}, 'acquisition_id'), false);
      assert.equal(typeof got.claim.epoch, 'number');
      assert.equal(got.claim.state, 'active');
      assert.equal(typeof got.claim.lease_expires_at, 'string');
      assert.equal(typeof (got.claim.activity ?? {}).tool_calls, 'number');
      assert.deepEqual(hiddenOutsideAssignment(got), []);
    });

    await check('worker get hides sealed-upload origin_claim_id while the stored row keeps it', async () => {
      const id = rid('upload');
      assert.equal(server.submit(id).code, 0);
      const claim = await server.tool(T.lark, 'claim', { request_id: id, claimant: 'redaction-worker', acquisition_id: 'acq-server-2' });
      assert.equal(claim.ok, true, claim.error);
      const data = Buffer.from('redaction fixture');
      const up = await server.tool(T.lark, 'artifact_chunk', { request_id: id, claim_id: claim.value.claim_id, artifact_id: 'art_redaction_1', offset: 0, data_base64: data.toString('base64'), final: true, sha256: createHash('sha256').update(data).digest('hex') });
      assert.equal(up.ok, true, up.error);
      const got = await workerGet(id);
      assert.ok(Array.isArray(got.artifacts) && got.artifacts.length >= 1, 'worker get has no sealed upload');
      for (const artifact of got.artifacts) assert.equal(Object.hasOwn(artifact, 'origin_claim_id'), false);
      assert.deepEqual(hiddenOutsideAssignment(got), []);
      const rows = dbRead(server, "SELECT origin_claim_id FROM artifacts WHERE request_id=? AND kind='upload' AND sealed=1", id);
      assert.ok(rows.length >= 1 && rows[0].origin_claim_id, 'stored upload lost its origin claim id');
    });

    await check('worker claim reply lists an inherited upload without origin_claim_id; the stored row keeps it', async () => {
      const id = rid('inherit');
      assert.equal(server.submit(id).code, 0);
      const runA = await server.tool(T.lark, 'claim', { request_id: id, claimant: 'redaction-worker', acquisition_id: 'acq-run-a', lease_ms: 1000 });
      assert.equal(runA.ok, true, runA.error);
      const data = Buffer.from('inherited fixture');
      const up = await server.tool(T.lark, 'artifact_chunk', { request_id: id, claim_id: runA.value.claim_id, artifact_id: 'art_inherit_1', offset: 0, data_base64: data.toString('base64'), final: true, sha256: createHash('sha256').update(data).digest('hex') });
      assert.equal(up.ok, true, up.error);
      await sleep(1500); // run A's 1 s lease has ended
      const runB = await server.tool(T.lark, 'claim', { request_id: id, claimant: 'redaction-worker', acquisition_id: 'acq-run-b' });
      assert.equal(runB.ok, true, runB.error);
      assert.notEqual(runB.value.claim_id, runA.value.claim_id);
      const listed = runB.value.artifacts;
      assert.ok(Array.isArray(listed) && listed.length >= 1, 'claim reply lists no inherited upload');
      assert.equal(listed[0].inherited, true);
      for (const artifact of listed) assert.equal(Object.hasOwn(artifact, 'origin_claim_id'), false);
      assert.equal(JSON.stringify(listed).includes(runA.value.claim_id), false, 'claim reply names run A claim id');
      const rows = dbRead(server, "SELECT origin_claim_id FROM artifacts WHERE request_id=? AND kind='upload' AND sealed=1", id);
      assert.equal(rows[0]?.origin_claim_id, runA.value.claim_id, 'stored upload lost its origin claim id');
      // The owner surface keeps origin_claim_id: owner get uses the submit receipt's capability, not the worker projection.
      const owner = server.cli(['get', id, '--json']);
      assert.equal(owner.code, 0, owner.stderr);
      assert.ok(JSON.parse(owner.stdout).artifacts.some(artifact => artifact.origin_claim_id === runA.value.claim_id && artifact.inherited === true), 'owner get dropped origin_claim_id');
    });

    await check('worker get without a claim still sanitizes metadata and keeps the assignment', async () => {
      const id = rid('noclaim');
      assert.equal(server.submit(id).code, 0);
      const got = await workerGet(id);
      assert.ok(got.claim === null || got.claim === undefined, 'unclaimed job unexpectedly has a claim');
      assert.equal(got.assignment.brief, `redaction ${id}`);
      assert.deepEqual(hiddenOutsideAssignment(got), []);
    });

    await check('worker get returns same-named assignment keys unchanged', async () => {
      const id = rid('samekeys');
      const provenance = { claim_id: 'ordinary-claim', origin_claim_id: 'ordinary-origin', acquisition_id: 'ordinary-acq' };
      assert.equal(server.submit(id, { provenance }).code, 0);
      const claim = await server.tool(T.lark, 'claim', { request_id: id, claimant: 'redaction-worker', acquisition_id: 'acq-server-3' });
      assert.equal(claim.ok, true, claim.error);
      const got = await workerGet(id);
      assert.deepEqual(got.assignment.inputs[0].provenance, provenance);
      assert.equal(got.assignment.brief, `redaction ${id}`);
      assert.deepEqual(hiddenOutsideAssignment(got), []);
    });

    await check('successful claim returns its grant and legitimate progress with that grant succeeds', async () => {
      const id = rid('grant');
      assert.equal(server.submit(id).code, 0);
      const claim = await server.tool(T.lark, 'claim', { request_id: id, claimant: 'redaction-worker', acquisition_id: 'acq-server-4' });
      assert.equal(claim.ok, true, claim.error);
      assert.equal(typeof claim.value.claim_id, 'string');
      assert.ok(claim.value.claim_id.length > 0);
      const progress = await server.tool(T.lark, 'progress', { request_id: id, claim_id: claim.value.claim_id, note: 'grant delivery probe' });
      assert.equal(progress.ok, true, progress.error);
    });

    await check('worker get question record lacks subject/claim_id but keeps its question id', async () => {
      const id = rid('question');
      assert.equal(server.submit(id).code, 0);
      const claim = await server.tool(T.lark, 'claim', { request_id: id, claimant: 'redaction-worker', acquisition_id: 'acq-server-5' });
      assert.equal(claim.ok, true, claim.error);
      const asked = await server.tool(T.lark, 'ask_question', { request_id: id, claim_id: claim.value.claim_id, question_id: 'q_redaction_1', text: 'redaction probe?' });
      assert.equal(asked.ok, true, asked.error);
      const got = await workerGet(id);
      const question = (got.questions ?? []).find(q => q.question_id === 'q_redaction_1');
      assert.ok(question, 'worker get has no question record');
      assert.equal(Object.hasOwn(question, 'claim_id'), false);
      assert.equal(Object.hasOwn(question, 'subject'), false);
      assert.deepEqual(hiddenOutsideAssignment(got), []);
    });

    await check('worker get of a finished job hides capability keys and stored owner evidence is unchanged', async () => {
      const id = rid('finished');
      assert.equal(server.submit(id).code, 0);
      const claim = await server.tool(T.lark, 'claim', { request_id: id, claimant: 'redaction-worker', acquisition_id: 'acq-server-6' });
      assert.equal(claim.ok, true, claim.error);
      const finished = await server.tool(T.lark, 'finish', { request_id: id, claim_id: claim.value.claim_id, outcome: 'completed', summary: 'redaction fixture finish', result: 'fixture' });
      assert.equal(finished.ok, true, finished.error);
      const got = await workerGet(id);
      assert.deepEqual(hiddenOutsideAssignment(got), []);
      const rows = dbRead(server, 'SELECT acquisition_id FROM claims WHERE request_id=?', id);
      assert.equal(rows[0]?.acquisition_id, 'acq-server-6');
    });
  }
} finally {
  if (server) await server.stop();
  jwks.close(); ntfy.close();
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nPASS claim metadata redaction');
process.exit(0);
