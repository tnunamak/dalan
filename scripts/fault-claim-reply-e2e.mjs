#!/usr/bin/env node
// Inject lost HTTP claim replies, rather than discard an already parsed response.
// Like fault-cancel-finish's harness, isolate HOME, port and fake T3. Keep our own
// child handle because that harness's stop() exposes SIGTERM only.
// CLAIM_REPLY_SEED reproduces the timing schedule, not OS process scheduling.
// These are process-crash tests, not power-loss or instruction-level coverage.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const seed = Number(process.env.CLAIM_REPLY_SEED ?? 20261007);
assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'seed must be uint32');
let rng = seed;
function random() { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; }
const schedule = Array.from({ length: 24 }, (_, round) => ({
  round, delay: round % 3 === 0 ? 0 : [1, 3, 8, 20][round % 4] + Math.floor(random() * 4)
}));
console.log('CLAIM_REPLY_SEED=' + seed + ' schedule=' + JSON.stringify(schedule));
const home = await mkdtemp(join(tmpdir(), 'dalan-bridge-claim-reply-'));
const dbPath = join(home, '.local/share/dot-bridge/bridge.db');
const thread = '00000000-0000-4000-8000-000000000001';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let service, port, secret, output = '';
const summary = { committed: 0, precommit: 0, racingCommitted: 0, kills: 0, unreadRequests: 0 };
process.once('exit', () => service?.kill('SIGKILL'));
const env = { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_AUTH_MODE: '',
  DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1',
  DOT_BRIDGE_ENABLE_WORKSPACE: '0', DOT_BRIDGE_T3_DRY_RUN: '1',
  DOT_BRIDGE_CRASH_AT: '', DOT_BRIDGE_CRASH_REQUEST_ID: '',
  PATH: join(home, 'bin') + ':' + process.env.PATH };

async function stop(signal = 'SIGKILL') {
  const child = service;
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    assert(child.kill(signal), 'failed to signal test child');
    await exited;
    if (signal === 'SIGKILL') { assert.equal(child.signalCode, 'SIGKILL'); summary.kills++; }
  }
  service = null;
}
async function start() {
  output = '';
  service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', data => { output += data; });
  service.stderr.on('data', data => { output += data; });
  let spawnError;
  service.on('error', error => { spawnError = error; });
  const deadline = Date.now() + 10000;
  while (!output.includes('MCP listening')) {
    if (spawnError) throw spawnError;
    assert(service.exitCode === null && service.signalCode === null, 'server exited: ' + output);
    assert(Date.now() < deadline, 'server readiness timeout: ' + output);
    await sleep(10);
  }
  secret = (await readFile(join(home, '.config/dot-bridge/env'), 'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
}
function admin(path, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = http.request({ socketPath: join(home, '.local/share/dot-bridge/admin.sock'),
      path, method: payload ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, res => {
      let text = '';
      res.on('data', data => { text += data; });
      res.on('error', reject);
      res.on('end', () => {
        try { assert.equal(res.statusCode, 200, text); resolve(JSON.parse(text)); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('admin timeout')));
    req.end(body);
  });
}
async function tool(name, args) {
  const response = await fetch('http://127.0.0.1:' + port + '/' + secret + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert(!value.error, JSON.stringify(value));
  return value.result.isError ? { error: value.result.content[0].text } : JSON.parse(value.result.content[0].text);
}
async function submit(label) {
  const id = 'req_claim_reply_' + seed + '_' + label;
  const assignment = { schema_version: 1, request_id: id, brief: 'lost claim reply ' + label,
    inputs: [], expected_output: 'one report', execution_scope: 'read-only' };
  const result = await admin('/submit', { delivery: 't3:' + thread, owner_token: 'owner-' + id, assignment });
  assert.equal(result.duplicate, false);
  return id;
}
function inspect(id) {
  // Read-only oracle: do not construct Store or run its migrations/recovery.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    return {
      claims: db.prepare('SELECT claim_id,claimant FROM claims WHERE request_id=?').all(id),
      reports: db.prepare('SELECT claim_id,receipt_id,result FROM reports WHERE request_id=?').all(id),
      status: db.prepare('SELECT status FROM assignments WHERE request_id=?').get(id).status
    };
  } finally { db.close(); }
}
async function count() {
  const status = await admin('/status');
  assert(Number.isInteger(status.claimed_outer_count), JSON.stringify(status));
  return status.claimed_outer_count;
}
const acquisitionFor = id => `claim-reply-${id}`;
function unreadClaim(id, claimant, afterFlush = () => {}) {
  return new Promise((resolve, reject) => {
    // No HTTP parser, data/readable handlers, or reads. Pause before connecting.
    // Destroy immediately in the write callback, before waiting for any reply.
    const socket = new net.Socket();
    socket.pause();
    let flushed = false, failure;
    socket.on('error', error => { failure = error; });
    socket.setTimeout(5000, () => socket.destroy(new Error('claim flush timeout')));
    socket.once('close', () => {
      if (!flushed) reject(failure ?? new Error('claim closed before flush'));
    });
    socket.connect(port, '127.0.0.1', () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'claim', arguments: { request_id: id, claimant, acquisition_id: acquisitionFor(id) } } });
      socket.write('POST /' + secret + '/mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ' +
        Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body, error => {
        if (error) { socket.destroy(); reject(error); return; }
        flushed = true;
        assert.equal(socket.bytesRead, 0, 'claim response unexpectedly read');
        socket.destroy();
        summary.unreadRequests++;
        Promise.resolve().then(afterFlush).then(resolve, reject);
      });
    });
  });
}
async function recover(id, claimant, before, occupied) {
  await start();
  assert.deepEqual(inspect(id), before, 'restart changed durable claim/report state');
  assert.equal(await count(), occupied, 'restart changed claimed_outer_count');
  const retry = await tool('claim', { request_id: id, claimant, acquisition_id: acquisitionFor(id) });
  assert.ok(retry.claim_id, JSON.stringify(retry));
  assert.equal(retry.duplicate, before.claims.length === 1);
  if (before.claims.length) assert.equal(retry.claim_id, before.claims[0].claim_id);
  const after = inspect(id);
  assert.equal(after.claims.length, 1);
  assert.equal(after.claims[0].claim_id, retry.claim_id);
  assert.equal(after.claims[0].claimant, claimant);
  assert.equal(await count(), occupied + (before.claims.length ? 0 : 1));
  const twice = await tool('claim', { request_id: id, claimant, acquisition_id: acquisitionFor(id) });
  assert.equal(twice.claim_id, retry.claim_id);
  assert.equal(twice.duplicate, true);
  const rival = await tool('claim', { request_id: id, claimant: claimant + '-rival' });
  assert.match(rival.error || '', /"error":"claim_busy"/, 'a different active run must remain refused');
  assert.equal(await count(), 1, 'same claimant/rival changed capacity');
  const args = { request_id: id, claim_id: retry.claim_id, outcome: 'completed',
    summary: 'claim reply recovery', result: 'retained once ' + id };
  const report = await tool('finish', args);
  assert.ok(report.receipt_id, JSON.stringify(report));
  const duplicate = await tool('finish', args);
  assert.equal(duplicate.receipt_id, report.receipt_id);
  const finished = inspect(id);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.claims.length, 1);
  assert.equal(finished.reports.length, 1);
  assert.equal(finished.reports[0].claim_id, retry.claim_id);
  assert.equal(finished.reports[0].receipt_id, report.receipt_id);
  assert.equal(finished.reports[0].result, args.result);
  assert.equal(await count(), 0);
}
try {
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, 'bin/t3code'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,data:{runtime:{environmentId:"fake-environment"},thread:{id:"' +
    thread + '",status:"active",deletedAt:null}}}));\n', { mode: 0o755 });
  await mkdir(join(home, '.config/dot-bridge'), { recursive: true });
  await writeFile(join(home, '.config/dot-bridge/limits.json'),
    JSON.stringify({ max_claimed_outer_assignments: 1, assignment_reannounce_max_count: 0 }), { mode: 0o600 });
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  env.DOT_BRIDGE_PORT = String(port);
  await start();

  // Require committed evidence from the DB, never from a claim response.
  for (let round = 0; round < 3; round++) {
    const id = await submit('committed_' + round), claimant = 'unread-worker-' + round;
    let before, attempts = 0;
    do {
      await unreadClaim(id, claimant);
      await sleep(10);
      before = inspect(id);
    } while (!before.claims.length && ++attempts < 40);
    assert.equal(before.claims.length, 1, 'no committed unread claim observed');
    assert.equal(before.status, 'claimed');
    const occupied = await count();
    assert.equal(occupied, 1);
    await stop();
    assert.deepEqual(inspect(id), before);
    await recover(id, claimant, before, occupied);
    summary.committed++;
    console.log('PASS committed unread claim round=' + round + ' claim_id=' + before.claims[0].claim_id);
  }

  // Kill at seeded offsets from flush. Zero means signal synchronously, without
  // a timer turn; positive offsets allow races on both sides of the commit.
  // Fail if the OS schedule never produces an actually absent pre-commit row.
  for (const { round, delay } of schedule) {
    const id = await submit('race_' + round), claimant = 'race-worker-' + round;
    await unreadClaim(id, claimant, async () => {
      if (delay) await sleep(delay);
      await stop();
    });
    const before = inspect(id);
    assert(before.claims.length <= 1);
    const committed = before.claims.length === 1;
    assert.equal(before.status, committed ? 'claimed' : 'queued');
    assert.equal(before.reports.length, 0);
    await recover(id, claimant, before, committed ? 1 : 0);
    if (committed) summary.racingCommitted++; else summary.precommit++;
    console.log('PASS race round=' + round + ' kill_ms=' + delay + ' committed_before_restart=' + committed);
  }
  assert(summary.precommit > 0, 'no pre-commit coverage: rerun printed seed and investigate OS timing');
  assert.equal(summary.kills, 27);
  console.log('PASS lost claim reply / restart / rival refusal / capacity / one report ' + JSON.stringify(summary));
} catch (error) {
  console.error('FAIL CLAIM_REPLY_SEED=' + seed + ': ' + error.stack + '\nservice output:\n' + output);
  process.exitCode = 1;
} finally {
  await stop();
  await rm(home, { recursive: true, force: true });
}
