#!/usr/bin/env node
// Consumers are assigned by code, never claimed: unit rules, admin /submit refusals, and the drainer's manifest check.
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertNoDeclaredConsumer, consumerOf, declaredConsumerFields, systemConsumers, unprovenSource } from '../src/consumers.mjs';
import { drainerRequestId, fixLoopRequestId } from '../src/objectives.mjs';
import { legacyFixLoopName } from '../src/legacy-names.mjs';

const sha = c => c.repeat(40);
const pinned = { github_repo: 'o/r', base_sha: sha('a') };
const drainerMeta = { objective_key: 'audit:o/r:src:errors:0', revision: sha('a'), task_kind: 'audit-review', source: 'drainer' };
const drainerId = drainerRequestId('o/r', drainerMeta.objective_key, drainerMeta.revision, drainerMeta.task_kind);
const drainerPayload = id => ({ request_id: id, inputs: [pinned] });
const candidate = { repo: 'o/r', id: 'bug-1' }, fixMeta = { objective_key: `fix-loop:o/r#bug-1`, revision: sha('a'), task_kind: 'fix-loop', source: 'fix-loop' };
const fixId = fixLoopRequestId(candidate);

// ---- unit: the consumer follows from the proven code path
assert.deepEqual(consumerOf({ request_id: 'req_plain_1', payload: {}, meta: { source: 'agent' } }), { type: 'agent', tier: 0, proven: true });
assert.deepEqual(consumerOf({ request_id: 'req_plain_1', payload: {}, meta: {} }), { type: 'agent', tier: 0, proven: true }, 'no source is an agent');
assert.deepEqual(consumerOf({ request_id: drainerId, payload: drainerPayload(drainerId), meta: drainerMeta }), { type: 'reserve', tier: 5, proven: true });
assert.deepEqual(consumerOf({ request_id: fixId, payload: drainerPayload(fixId), meta: fixMeta }), { type: 'fix_pipeline', tier: 1, proven: true });
// a forged claim of a system source is not proven, and so is refused
for (const [meta, id] of [[drainerMeta, 'req_forged_0001'], [fixMeta, 'req_forged_0002']]) {
  assert.equal(consumerOf({ request_id: id, payload: drainerPayload(id), meta }).proven, false);
  assert.match(unprovenSource({ request_id: id, payload: drainerPayload(id), meta }, 'normal'), /is proven by the request id/);
}
assert.equal(unprovenSource({ request_id: drainerId, payload: drainerPayload(drainerId), meta: drainerMeta }, 'normal'), 'drainer work is always background priority');
assert.equal(unprovenSource({ request_id: drainerId, payload: drainerPayload(drainerId), meta: drainerMeta }, 'background'), null);
assert.equal(unprovenSource({ request_id: fixId, payload: drainerPayload(fixId), meta: fixMeta }, 'normal'), null);
// the reason travels with a refusal
assert.match(unprovenSource({ request_id: drainerId, payload: { request_id: drainerId, inputs: [{ github_repo: 'o/r', base_sha: sha('b') }] }, meta: drainerMeta }, 'background'), /revision differs from the pinned input/);
assert.match(unprovenSource({ request_id: 'req_x_00001', payload: {}, meta: { source: 'drainer' } }, 'background'), /incomplete tuple/);
assert.deepEqual([...systemConsumers].sort(), ['fix_pipeline', 'ledger', 'reserve']);
assert.deepEqual(declaredConsumerFields({ consumer: 1, severity: 'P0', brief: 'x' }, 'drainer'), ['consumer', 'severity']);
assert.deepEqual(declaredConsumerFields({ severity: 'P1', consumer: { type: 'thread', id: 'T1' } }), [], 'an agent may send a severity hint and name a requester');
assert.deepEqual(declaredConsumerFields({ consumer: 'ledger', value_tier: 0, tier: 0 }), ['value_tier', 'tier', 'consumer']);
assert.deepEqual(declaredConsumerFields({ consumer: { type: 'fix_pipeline' } }), ['consumer']);
assert.deepEqual(declaredConsumerFields(null), []);
assert.throws(() => assertNoDeclaredConsumer({ tier: 0 }, 'manifest'), /manifest declares tier/);
assert.throws(() => assertNoDeclaredConsumer({ severity: 'P0' }, 'manifest', 'drainer'), /manifest declares severity/);
console.log('PASS consumer rules: code assigns agent, fix_pipeline and reserve; forged system sources and declared fields are refused');

// ---- e2e: the server and the drainer enforce them
const repo = resolve(new URL('..', import.meta.url).pathname), home = fs.mkdtempSync(join(tmpdir(), 'dalan-bridge-consumers-'));
const root = join(home, '.local/share/dot-bridge'), directory = join(root, 'manifests');
const port = await new Promise((done, fail) => { const probe = net.createServer(); probe.once('error', fail); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fixture = join(home, 'fixture');
const env = { ...process.env, HOME: home, DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_T3_DRY_RUN: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '0', DOT_BRIDGE_GITHUB_URL_TEST_FIXTURE: fixture, PATH: `${join(home, 'bin')}:${process.env.PATH}` };
const git = args => { const r = spawnSync('git', args, { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
let fixtureSha = null;
const run = (argv, input = '') => new Promise(done => { const c = spawn(argv[0], argv.slice(1), { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => err += b); c.on('close', code => done({ code, out, err })); c.stdin.end(input); });
const admin = (route, method = 'GET', body = null) => new Promise((done, fail) => {
  const bytes = body ? JSON.stringify(body) : '';
  const req = http.request({ socketPath: join(root, 'admin.sock'), path: route, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } }, res => { let t = ''; res.on('data', b => t += b); res.on('end', () => done({ status: res.statusCode, value: JSON.parse(t) })); });
  req.on('error', fail); req.end(bytes);
});
const payload = (id, extra = {}) => ({ schema_version: 1, request_id: id, brief: 'consumers e2e', inputs: [], expected_output: 'one result', execution_scope: 'read-only', ...extra });
let service = null;
try {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.mkdirSync(join(home, '.config/dot-bridge'), { recursive: true });
  fs.writeFileSync(join(home,'.config/dot-bridge/workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}],repos:['test/fixture']}}}),{mode:0o600});
  fs.writeFileSync(join(home, '.config/dot-bridge/limits.json'), JSON.stringify({ max_claimed_outer_assignments: 10, background_max_in_flight: 10 }), { mode: 0o600 });
  fs.mkdirSync(join(home, 'bin'), { recursive: true }); fs.writeFileSync(join(home, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.mkdirSync(join(fixture, 'src'), { recursive: true }); fs.writeFileSync(join(fixture, 'src/a.js'), 'x');
  git(['init', fixture]); git(['-C', fixture, 'config', 'user.name', 'F']); git(['-C', fixture, 'config', 'user.email', 'f@example.test']); git(['-C', fixture, 'add', '.']); git(['-C', fixture, 'commit', '-m', 'fixture']);
  fixtureSha = git(['-C', fixture, 'rev-parse', 'HEAD']);
  service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; service.stdout.on('data', b => out += b); service.stderr.on('data', b => process.stderr.write(b));
  for (let i = 0; i < 100 && !(out.includes('MCP listening') && out.includes('admin socket')); i++) await sleep(100);
  assert.ok(out.includes('MCP listening') && out.includes('admin socket'), 'server did not start');
  const owner = 'o'.repeat(64), submit = (assignment, extra = {}) => admin('/submit', 'POST', { delivery: 'none', assignment, owner_token: owner, ...extra });

  // declared fields: refused with the reason, in the assignment, the meta and the request body
  for (const [label, call] of [
    ['assignment', () => submit(payload(`req_${randomUUID()}`, { value_tier: 0 }))],
    ['assignment', () => submit(payload(`req_${randomUUID()}`, { consumer: { type: 'fix_pipeline' } }))],
    ['meta', () => submit(payload(`req_${randomUUID()}`), { meta: { source: 'agent', consumer: 'ledger' } })],
    ['submit request', () => submit(payload(`req_${randomUUID()}`), { tier: 0 })],
  ]) { const r = await call(); assert.equal(r.status, 400, label); assert.match(r.value.error, new RegExp(`${label} declares`)); }
  // an agent's severity hint and a named requester pass: agent work is already first and nothing reads the requester yet
  assert.equal((await submit(payload(`req_${randomUUID()}`, { severity: 'P1', consumer: { type: 'thread', id: 'T1' } }))).status, 200);
  // a forged drainer or fix-loop identity: not proven by the request id
  const forged = await submit(payload(`req_${randomUUID()}`), { background: true, meta: drainerMeta });
  assert.equal(forged.status, 400); assert.match(forged.value.error, /source drainer is proven by the request id/);
  const forgedFix = await submit(payload(`req_${randomUUID()}`), { meta: fixMeta });
  assert.equal(forgedFix.status, 400); assert.match(forgedFix.value.error, /source fix-loop is proven by the request id/);
  // a proven drainer identity cannot take the agent-first queue
  const noInput = { ...drainerMeta };
  const idNoInput = drainerRequestId('', noInput.objective_key, noInput.revision, noInput.task_kind);
  const body = payload(idNoInput);
  assert.equal((await submit(body, { meta: noInput })).value.error, 'drainer work is always background priority');
  assert.equal((await submit(body, { meta: noInput, background: true })).status, 200, 'the same identity as background is accepted');
  // fix-loop with its proven identity may be normal (tier 1): same request, real pinned input from the fixture repository
  const fixCandidate = { repo: 'test/fixture', id: 'bug-1' }, realFixId = fixLoopRequestId(fixCandidate);
  const realFixMeta = { objective_key: 'fix-loop:test/fixture#bug-1', revision: fixtureSha, task_kind: 'fix-loop', source: 'fix-loop' };
  const fixBody = payload(realFixId, { inputs: [{ github_repo: 'test/fixture', base_sha: fixtureSha }], scope_paths: ['src'] });
  const fixed = await submit(fixBody, { meta: realFixMeta });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.value));
  assert.equal(fixed.value.status, 'queued');
  const prioritySource = id => { const db = new DatabaseSync(join(root, 'bridge.db'), { readOnly: true }); try { return { ...db.prepare('SELECT priority,source FROM assignments WHERE request_id=?').get(id) }; } finally { db.close(); } };
  assert.deepEqual(prioritySource(realFixId), { priority: 'normal', source: 'fix-loop' });
  assert.equal((await submit({ ...fixBody, severity: 'P0' }, { meta: realFixMeta })).value.error, 'assignment declares severity; the bridge assigns the consumer and tier from the code path, never from the submitter', 'a fix-loop submit cannot carry a severity');
  // a retry of an existing request is not judged again
  assert.equal((await submit(fixBody, { meta: realFixMeta })).value.duplicate, true);
  // a producer of an earlier release still sends the old spelling of the whole identity: it verifies, is stored, and its retry is the same request
  const legacyId = fixLoopRequestId({ repo: 'test/fixture', id: 'bug-2' });
  const legacyFixMeta = { objective_key: `${legacyFixLoopName}:test/fixture#bug-2`, revision: fixtureSha, task_kind: legacyFixLoopName, source: legacyFixLoopName };
  const legacyBody = payload(legacyId, { inputs: [{ github_repo: 'test/fixture', base_sha: fixtureSha }], scope_paths: ['src'] });
  const legacyFixed = await submit(legacyBody, { meta: legacyFixMeta });
  assert.equal(legacyFixed.status, 200, JSON.stringify(legacyFixed.value));
  assert.deepEqual(prioritySource(legacyId), { priority: 'normal', source: 'fix-loop' });
  assert.equal((await submit(legacyBody, { meta: legacyFixMeta })).value.duplicate, true, 'retry with the earlier spelling');
  assert.equal((await submit(legacyBody, { meta: { source: 'fix-loop' } })).value.duplicate, true, 'retry with the neutral spelling');
  const legacyForged = await submit(payload(`req_${randomUUID()}`), { meta: legacyFixMeta });
  assert.equal(legacyForged.status, 400); assert.match(legacyForged.value.error, /is proven by the request id of its own code path/, 'the earlier spelling cannot forge the identity either');
  // an ordinary agent submit is unaffected
  assert.equal((await submit(payload(`req_${randomUUID()}`), { meta: { source: 'agent', task_kind: 'review' } })).status, 200);
  console.log('PASS admin /submit refuses a declared tier or system consumer, forged system sources and non-background drainer work, and accepts a real fix-loop identity');

  console.log('PASS consumers test');
} catch (error) { console.error('FAIL', error); process.exitCode = 1; }
finally {
  if (service && service.exitCode === null) { const exited = new Promise(r => service.once('exit', r)); service.kill('SIGTERM'); await exited; }
  fs.rmSync(home, { recursive: true, force: true });
}
