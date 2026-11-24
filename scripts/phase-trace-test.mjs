#!/usr/bin/env node
// The phase trace: where the time between "queued" and "claimed" goes, as log lines. Unit tests with a fake clock, then a real server over HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const root = process.env.DOT_BRIDGE_TEST_TMP || path.join(os.homedir(), '.tmp');
fs.mkdirSync(root, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assignment = request_id => ({ schema_version: 1, request_id, brief: `Synthetic fixture ${request_id}`, inputs: [], expected_output: 'One line', execution_scope: 'read-only' });
async function startBridge(label, workerExtra, limits, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(root, `finish-handoff-${label}-`));
  const env = fixtureEnv(home, { DOT_BRIDGE_PORT: '0', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_RESUME_IDLE_MS: '0', ...extraEnv });
  delete env.DALAN_LEGACY_PROFILE;
  if (limits) { fs.mkdirSync(path.join(home, '.config/dalan'), { recursive: true }); fs.writeFileSync(path.join(home, '.config/dalan/limits.json'), JSON.stringify(limits), { mode: 0o600 }); }
  const workersFile = path.join(home, 'workers.json');
  fs.writeFileSync(workersFile, JSON.stringify({ workers: { dot: {
    connections: [{ issuer: 'https://issuer.test', subject: 'local-principal', client_id: 'fixture' }], ...workerExtra } }, default_execution: 'none' }), { mode: 0o600 });
  env.DALAN_WORKERS_FILE = workersFile;
  const server = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', exited = false, port;
  server.once('exit', () => { exited = true; });
  server.stdout.on('data', b => { output += b; const m = /^MCP listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\r?\n/m.exec(output); if (m) port = Number(m[1]); });
  server.stderr.on('data', b => { errors += b; });
  const deadline = Date.now() + 15000;
  while (!port && !exited && Date.now() < deadline) await sleep(25);
  assert.ok(port, `bridge did not start: ${errors}`);
  const secretFile = [path.join(home, '.config/dalan/env'), path.join(home, '.config/dot-bridge/env')].find(file => fs.existsSync(file));
  const secret = fs.readFileSync(secretFile, 'utf8').match(/^BRIDGE_PATH_SECRET=(.+)$/m)[1];
  const operator = { 'x-operator-key': fs.readFileSync([path.join(home, '.config/dalan/operator.key'), path.join(home, '.config/dot-bridge/operator.key')].find(f => fs.existsSync(f)), 'utf8').trim() };
  const socketPath = [path.join(home, '.local/share/dalan/admin.sock'), path.join(home, '.local/share/dot-bridge/admin.sock')].find(f => fs.existsSync(f));
  const admin = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const q = http.request({ socketPath, path: route, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, r => { let b = ''; r.on('data', x => { b += x; }); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    q.on('error', reject); q.end(JSON.stringify(body));
  });
  let call = 0;
  const rpc = async (name, args = {}, signal) => {
    const r = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++call, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result;
  };
  const ok = async (name, args, signal) => { const r = await rpc(name, args, signal); assert.equal(r.isError, false, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
  const submit = async id => assert.equal((await admin('/submit', { delivery: 'none', owner_token: 'synthetic-owner-capability', assignment: assignment(id) })).status, 200);
  const stop = async () => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} fs.rmSync(home, { recursive: true, force: true }); };
  const claimNew = async id => { await submit(id); const c = await ok('claim', { request_id: id, claimant: 'fixture-worker' }); return c; };
  const finish = (job, extra = {}, signal) => ok('finish', { request_id: job.request_id, claim_id: job.claim_id, outcome: 'completed', summary: 'done', result: 'done', ...extra }, signal);
  const queuedIds = async () => (await ok('list_pending')).assignments.map(x => x.request_id);
  const requestLog = () => {
    const file = [path.join(home, '.local/state/dalan/requests.jsonl'), path.join(home, '.local/state/dot-bridge/requests.jsonl')].find(f => fs.existsSync(f));
    assert.ok(file, 'no request log in the bridge home');
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  };
  return { rpc, ok, submit, admin, operator, stop, claimNew, finish, queuedIds, requestLog };
}

const pass = message => console.log(`PASS ${message}`);
const { createPhaseTrace } = await import('../src/phase-trace.mjs');

// 1. The trace itself, with a fake clock and log.
{
  let t = Date.parse('2026-11-24T10:00:00.000Z');
  const lines = [];
  const trace = createPhaseTrace({ log: l => lines.push(l), now: () => t, max: 3 });
  const created = '2026-11-24T10:00:00.000Z';
  const item = id => ({ id: `evt_${id}`, request_id: id, wake_kind: 'submit', created_at: created });
  // Fresh claim: wake attempted at +200 ms, receiver answered in 50 ms, worker listed at +4 s, claimed at +6 s, first action at +9 s.
  t += 200; trace.wake({ item: item('a'), worker: 'dot', attemptAt: t, ackMs: 50, status: 204, state: 'delivered' });
  t += 3800; trace.listed(['a']);
  t += 2000; trace.claimed({ requestId: 'a', worker: 'dot', subject: 's1', claimId: 'c1', handoff: false, createdAt: created });
  const claim = lines.find(l => l.kind === 'claim_phase');
  assert.deepEqual([claim.submit_to_wake_ms, claim.wake_ack_ms, claim.wake_to_listed_ms, claim.listed_to_claim_ms, claim.submit_to_claim_ms], [200, 50, 3750, 2000, 6000]);
  assert.equal(claim.handoff, false);
  trace.action({ requestId: 'a', tool: 'get', subject: 's2' });
  assert.equal(lines.filter(l => l.kind === 'claim_first_action').length, 0, 'another subject is not the holder');
  t += 3000; trace.action({ requestId: 'a', tool: 'get', subject: 's1' }); trace.action({ requestId: 'a', tool: 'progress', subject: 's1' });
  const acts = lines.filter(l => l.kind === 'claim_first_action');
  assert.equal(acts.length, 1, 'only the first action is logged');
  assert.deepEqual([acts[0].tool, acts[0].after_claim_ms, acts[0].claim_id], ['get', 3000, 'c1']);
  // Handoff claim: no wake and no listing of its own, so those fields are null, never a made-up number.
  t += 1000; trace.claimed({ requestId: 'h', worker: 'dot', subject: 's1', claimId: 'c2', handoff: true, createdAt: created });
  const ho = lines.filter(l => l.kind === 'claim_phase').at(-1);
  assert.deepEqual([ho.handoff, ho.submit_to_wake_ms, ho.wake_ack_ms, ho.wake_to_listed_ms, ho.listed_to_claim_ms], [true, null, null, null, null]);
  assert.ok(ho.submit_to_claim_ms > 0);
  // A failed attempt leaves its wake and listing behind; the next claim is a finish handoff and must not log them.
  t += 100; trace.wake({ item: item('s'), worker: 'dot', attemptAt: t, ackMs: 10, status: 204, state: 'delivered' });
  trace.listed(['s']);
  t += 1000; trace.claimed({ requestId: 's', worker: 'dot', subject: 's1', claimId: 'c5', handoff: true, createdAt: created });
  const stale = lines.filter(l => l.kind === 'claim_phase').at(-1);
  assert.deepEqual([stale.first_listed_at, stale.wake_attempt_at, stale.wake_to_listed_ms, stale.listed_to_claim_ms], [null, null, null, null], 'a handoff claim ignores timings left by an earlier attempt');
  // Listed before the receiver's answer came back: the order of answer and listing is unknown, so the gap is null, never negative.
  t += 100; const sendAt = t; trace.listed(['o']); t += 25; trace.wake({ item: item('o'), worker: 'dot', attemptAt: sendAt, ackMs: 60, status: 204, state: 'delivered' });
  t += 500; trace.claimed({ requestId: 'o', worker: 'dot', subject: 's1', claimId: 'c6', handoff: false, createdAt: created });
  const early = lines.filter(l => l.kind === 'claim_phase').at(-1);
  assert.equal(early.wake_to_listed_ms, null, 'a listing before the answer has no known gap');
  assert.equal(early.wake_ack_ms, 60);
  // A delivered wake with no recorded answer time keeps the gap unknown instead of counting the answer as instant.
  t += 100; trace.wake({ item: item('n'), worker: 'dot', attemptAt: t, ackMs: null, status: 204, state: 'delivered' });
  t += 400; trace.listed(['n']); t += 100;
  trace.claimed({ requestId: 'n', worker: 'dot', subject: 's1', claimId: 'c7', handoff: false, createdAt: created });
  const noAck = lines.filter(l => l.kind === 'claim_phase').at(-1);
  assert.deepEqual([noAck.wake_ack_ms, noAck.wake_to_listed_ms], [null, null]);
  // A failed wake logs a null answer time and is not remembered as a delivery.
  trace.wake({ item: item('f'), worker: 'dot', attemptAt: t, ackMs: null, status: null, state: 'failed' });
  const failed = lines.at(-1);
  assert.deepEqual([failed.kind, failed.ack_ms, failed.state], ['wake_delivery', null, 'failed']);
  trace.claimed({ requestId: 'f', worker: 'dot', subject: 's1', claimId: 'c3', handoff: false, createdAt: created });
  assert.equal(lines.filter(l => l.kind === 'claim_phase').at(-1).submit_to_wake_ms, null);
  // The memory is bounded: with max 3, the oldest listing is dropped.
  trace.listed(['l1', 'l2', 'l3', 'l4']);
  trace.claimed({ requestId: 'l1', worker: 'dot', subject: 's1', claimId: 'c4', handoff: false, createdAt: created });
  assert.equal(lines.filter(l => l.kind === 'claim_phase').at(-1).first_listed_at, null, 'an evicted listing reads as unknown');
  pass('phase trace: gaps are exact, handoff and unknown steps are null, first action is logged once for the holder, memory is bounded');
}

// 2. Against a real server: list_pending, claim and the first call after it each leave their line in the request log.
const bridges = [];
try {
  const b = await startBridge('trace', { }, null);
  bridges.push(b);
  await b.submit('req_trace_a');
  await b.ok('list_pending');
  const job = await b.ok('claim', { request_id: 'req_trace_a', claimant: 'fixture-worker' });
  await sleep(300);
  await b.ok('get', { request_id: 'req_trace_a' });
  // A retried claim is not a new claim.
  await b.ok('claim', { request_id: 'req_trace_a', claimant: 'fixture-worker' });
  const lines = b.requestLog();
  const phase = lines.filter(l => l.kind === 'claim_phase' && l.request_id === 'req_trace_a');
  assert.equal(phase.length, 1, JSON.stringify(phase));
  assert.equal(phase[0].claim_id, job.claim_id);
  assert.equal(phase[0].handoff, false);
  assert.ok(phase[0].first_listed_at && phase[0].listed_to_claim_ms >= 0, JSON.stringify(phase[0]));
  assert.ok(phase[0].submit_to_claim_ms >= phase[0].listed_to_claim_ms);
  const first = lines.filter(l => l.kind === 'claim_first_action' && l.request_id === 'req_trace_a');
  assert.equal(first.length, 1, JSON.stringify(first));
  assert.equal(first[0].tool, 'get');
  assert.ok(first[0].after_claim_ms >= 250, JSON.stringify(first[0]));
  pass('server: list_pending, claim and the first call after it write claim_phase and claim_first_action once; a claim retry writes none');
} finally {
  await Promise.all(bridges.map(b => b.stop()));
}
console.log('PASS phase-trace');
