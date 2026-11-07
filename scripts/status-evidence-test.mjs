#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { Store } from '../src/store.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const home = await mkdtemp(path.join(os.tmpdir(), 'dalan-status-evidence-'));
let now = Date.parse('2026-10-07T18:41:00.000Z');
const store = new Store(path.join(home, 'bridge.db'), { now: () => now });
const socket = path.join(home, '.local/share/dot-bridge/admin.sock');
const assignment = request_id => ({ schema_version: 1, request_id, brief: 'Check status', inputs: [], expected_output: 'Facts', execution_scope: 'read-only' });
const runCli = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['bin/dalan.mjs', 'status', ...args], { cwd: repo, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  child.once('error', reject);
  child.once('close', code => resolve({ code, stdout, stderr }));
});
let admin;
let legacyStatus = false;

try {
  await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
  // A pre-bridge Guardian report need not have a claim row.
  store.submit(assignment('req_denied_fixture'), { mode: 'none' }, null, 'owner-denied');
  store.db.prepare('INSERT INTO progress(request_id,note,created_at) VALUES(?,?,?)')
    .run('req_denied_fixture', 'Guardian auto-stop after repeated denials; direct confirmation requested. Bearer secret-value', store.stamp());

  now += 60_000;
  store.submit(assignment('req_report_fixture'), { mode: 'none' }, null, 'owner-report');
  const reportClaim = store.claim('req_report_fixture', 'worker', 'subject-report');
  store.finish('req_report_fixture', reportClaim.claim_id, 'completed', 'Auto-review denied a changed action. api-secret-value', 'stored result', 'subject-report');
  store.submit(assignment('req_later_claim_fixture'), { mode: 'none' }, null, 'owner-later');
  store.claim('req_later_claim_fixture', 'worker', 'subject-later');

  const evidenceBeforeAck = JSON.stringify({ denial: store.status().denial_suspected, wait: store.status().worker_reported_guardian_wait });
  store.ackDenialNotes(store.denialNotes());
  assert.equal(JSON.stringify({ denial: store.status().denial_suspected, wait: store.status().worker_reported_guardian_wait }), evidenceBeforeAck, 'status evidence is independent of alert cursors');

  admin = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/status') { res.writeHead(404).end(); return; }
    const fullStatus = { ...store.status(), max_claimed_outer_assignments: store.capacity };
    const status = legacyStatus
      ? (({ denial_suspected, worker_reported_guardian_wait, worker_pause, last_claim_at, ...legacy }) => legacy)(fullStatus)
      : fullStatus;
    const body = JSON.stringify(status);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve, reject) => { admin.once('error', reject); admin.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);

  const explained = await runCli(['--explain']);
  assert.equal(explained.code, 0, explained.stderr);
  assert.equal(explained.stderr, '');
  assert.equal(explained.stdout.trim().split('\n').length, 2, 'explain is one status line plus one metrics line');
  assert.match(explained.stdout, /^observed=2026-10-07T18:42:00\.000Z .* last_claim_at=2026-10-07T18:42:00\.000Z .* denial_suspected=2 .* guardian_wait=worker_reported\(1\) .* worker_pause=unknown calls=1h:0\/1000,24h:0\/10000 bytes=1h:0\/8000000,24h:0\/100000000\nmetrics=unavailable\n$/, 'a bridge without /metrics explains metrics as unavailable; bytes against both windows are always shown');
  assert(!/secret-value|api-secret-value|auto-stop|Auto-review/.test(explained.stdout), 'explain must not print worker text or secrets');

  legacyStatus = true;
  const legacyExplain = await runCli(['--explain']);
  assert.equal(legacyExplain.code, 0, legacyExplain.stderr);
  assert.equal(legacyExplain.stdout.trim().split('\n').length, 2, 'legacy status still explains on one status line');
  assert.match(legacyExplain.stdout, /last_claim_at=2026-10-07T18:42:00\.000Z/);
  assert.match(legacyExplain.stdout, /denial_suspected=unavailable.*denial_last_at=unknown guardian_wait=worker_reported\(unavailable\).*worker_pause=unknown/);
  assert(!/denial_suspected=0|guardian_wait=worker_reported\(0\)/.test(legacyExplain.stdout), 'missing legacy evidence must not be presented as zero');
  legacyStatus = false;

  const explainJson = await runCli(['--explain', '--json']);
  assert.equal(explainJson.code, 0, explainJson.stderr);
  assert.equal(JSON.parse(explainJson.stdout).explanation, explained.stdout.trim(), '--json keeps JSON and adds explanation');

  const jsonMode = await runCli(['--json']);
  assert.equal(jsonMode.code, 0, jsonMode.stderr);
  const status = JSON.parse(jsonMode.stdout);
  assert.equal(status.last_claim_at, '2026-10-07T18:42:00.000Z');
  assert.equal(status.last_claim, status.last_claim_at, 'legacy last_claim field remains');
  assert.equal(status.denial_suspected.count, 2);
  assert.equal(status.denial_suspected.evidence[0].source, 'report');
  assert.equal(status.denial_suspected.evidence[1].source, 'progress');
  assert.equal(status.worker_reported_guardian_wait.count, 1);
  assert.equal(status.worker_pause, 'unknown');
  assert.equal(status.subscription.last_claim_at, status.last_claim_at, 'nested legacy status field remains');
  assert(!JSON.stringify(status).includes('secret-value'), 'JSON evidence must not include raw worker text');
  assert(!JSON.stringify(status).includes('api-secret-value'), 'report contents must not enter evidence');

  const defaultMode = await runCli([]);
  assert.equal(defaultMode.code, 0, defaultMode.stderr);
  assert.match(defaultMode.stdout, /^Bridge: running/, 'without --json, status prints the human summary');
  assert(!defaultMode.stdout.includes('secret-value'), 'the summary must not include raw worker text');
  store.cancel('req_denied_fixture', 'fixture closed');
  const emptyQueue = await runCli(['--explain']);
  assert.equal(emptyQueue.code, 0, emptyQueue.stderr);
  assert.match(emptyQueue.stdout, /queued=0 /, 'an observed empty queue is zero, not unknown');
  assert.match(emptyQueue.stdout, /denial_suspected=2 /, 'cancellation does not erase past evidence');

  // Exercise the router budget through the CLI, using the same stored usage as throttle.
  const minute = Math.floor(now / 60_000);
  const usage = store.db.prepare("INSERT INTO worker_calls(worker,subject,minute,tool,count,bytes) VALUES('dot',?,?,?,?,?) ON CONFLICT(worker,subject,minute,tool) DO UPDATE SET count=excluded.count,bytes=excluded.bytes");
  const checkBudget = async (label, calls, bytes, callsCap, bytesCap, remaining) => {
    usage.run('budget-fixture', minute, 'list_pending', calls, bytes);
    const result = await runCli(['--json']);
    assert.equal(result.code, 0, result.stderr);
    const { budget, throttle } = JSON.parse(result.stdout);
    assert.deepEqual(budget, {
      window: 'rolling_24h', calls_used: calls, calls_cap: callsCap,
      bytes_used: bytes, bytes_cap: bytesCap, remaining_fraction: remaining,
    }, label);
    assert.deepEqual(throttle, store.rollingUsage(), `${label}: throttle unchanged`);
    assert.deepEqual([budget.calls_used, budget.calls_cap, budget.bytes_used, budget.bytes_cap],
      [throttle.tool_calls_last_24h, throttle.max_tool_calls_per_24h, throttle.response_bytes_last_24h, throttle.max_response_bytes_per_24h],
      `${label}: budget and throttle agree`);
  };
  await checkBudget('empty usage', 0, 0, 10000, 100000000, 1);
  await checkBudget('calls bind, rounded up', 3333, 10000000, 10000, 100000000, 0.667);
  await checkBudget('bytes bind, rounded down', 1000, 66666666, 10000, 100000000, 0.333);
  await checkBudget('calls over cap', 10001, 0, 10000, 100000000, 0);
  await checkBudget('bytes over cap', 0, 100000001, 10000, 100000000, 0);
  store.learnFromBreak(1, { '24h': { tool_calls: 10000, response_bytes: 100000000 } });
  await checkBudget('learned calls cap binds', 3500, 0, 7000, 70000000, 0.5);
  await checkBudget('learned bytes cap binds', 0, 52500000, 7000, 70000000, 0.25);
  now += 24 * 60 * 60_000;
  const rolled = await runCli(['--json']);
  assert.equal(rolled.code, 0, rolled.stderr);
  assert.deepEqual(JSON.parse(rolled.stdout).budget, {
    window: 'rolling_24h', calls_used: 0, calls_cap: 7000,
    bytes_used: 0, bytes_cap: 70000000, remaining_fraction: 1,
  }, 'usage leaves rolling window');
  console.log('PASS status budget: empty usage, calls/bytes binding, rounding, over-cap clamps, learned caps, and rolling window');
  console.log('PASS Store and CLI status preserve legacy JSON, explain old and new responses, keep cursor-independent denial clues, and omit report text/secrets');
} finally {
  if (admin) await new Promise(resolve => admin.close(resolve));
  store.db.close();
  await rm(home, { recursive: true, force: true });
}
