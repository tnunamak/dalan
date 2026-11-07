#!/usr/bin/env node
// Black-box crash fuzzing, not deterministic instruction-level crash coverage.
// Reproduce the schedule with SUBMIT_CRASH_SEED (OS scheduling can still vary).
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {cleanupFixture, createFixtureService, listeningPort} from './lib/fixture-service.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const seed = Number(process.env.SUBMIT_CRASH_SEED ?? 20261007);
assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'seed must be uint32');
let rng = seed;
function random() { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; }
const schedule = Array.from({ length: 30 }, (_, round) => ({
  round, delay: [0, 3, 15, 35, 80, 150][round % 6] + Math.floor(random() * 11),
  burst: 3 + Math.floor(random() * 5)
}));
console.log('SUBMIT_CRASH_SEED=' + seed + ' schedule=' + JSON.stringify(schedule));
const root = await mkdtemp(join(tmpdir(), 'dalan-bridge-submit-crash-'));
const thread = '11111111-2222-4333-8444-555555555555';
let service, startup, webhook, home, env, port, secret;
let attempt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = { kills: 0, acknowledged: 0, committedLostResponses: 0, absentLostResponses: 0 };
process.once('exit', () => { service?.kill('SIGKILL'); });
async function stop(signal = 'SIGTERM') {
  if (!startup) return;
  await startup.stop(signal);
  service = null;
}
async function start(round, phase) {
  port = null;
  startup = createFixtureService({attempt:++attempt, round, phase,
    spawnChild:()=>spawn(process.execPath, ['src/server.mjs'], {cwd:repo, env, stdio:['ignore','pipe','pipe']})});
  service = startup.child;
  port = await startup.ready();
}
assert.equal(listeningPort('MCP listening'), null);
assert.equal(listeningPort('MCP listening on 0.0.0.0:43'), null);
assert.equal(listeningPort('MCP listening on 0.0.0.0:43127'), null);
assert.equal(listeningPort('MCP listening on 0.0.0.0:43127\n'), 43127);
assert.equal(listeningPort('diagnostic MCP listening on 0.0.0.0:1\n'), null);
for (const invalid of [0, 65536]) assert.throws(() => listeningPort(`MCP listening on 0.0.0.0:${invalid}\n`));
async function rpc(method, params = {}) {
  const response = await fetch('http://127.0.0.1:' + port + '/' + secret + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert(!value.error, JSON.stringify(value));
  return value.result;
}
function submit(payload, discard = false) {
  // The discard case drops the entire response body after headers, guaranteeing
  // a committed-but-unacknowledged case without pretending a received JSON body was lost.
  return new Promise(resolve => {
    const body = JSON.stringify({ delivery: 't3:' + thread, assignment: payload, owner_token: 'test-owner-' + payload.request_id });
    const req = http.request({
      socketPath: join(home, '.local/share/dot-bridge/admin.sock'),
      path: '/submit', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, res => {
      if (discard) { res.destroy(); resolve({ lost: true, headersOnly: true }); return; }
      let text = '';
      res.on('data', data => { text += data; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, value: JSON.parse(text) }); }
        catch (error) { resolve({ invalid: error.message, text }); }
      });
      res.on('error', () => resolve({ lost: true }));
      res.on('aborted', () => resolve({ lost: true }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('submit timeout')));
    req.on('error', () => resolve({ lost: true }));
    req.end(body);
  });
}
function inspect(expected, acknowledged, subscriptions) {
  // Read the actual DB; do not instantiate Store or call recovery code in the oracle.
  const db = new DatabaseSync(join(home, '.local/share/dot-bridge/bridge.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    const active = db.prepare("SELECT id FROM subscriptions WHERE state='active' AND expires_at>?").all(new Date().toISOString());
    assert.deepEqual(active.map(row => row.id).sort(), [...subscriptions].sort());
    const rows = db.prepare('SELECT request_id,payload,status FROM assignments').all();
    const ids = new Set(rows.map(row => row.request_id));
    for (const id of acknowledged) assert(ids.has(id), 'acknowledged submit vanished: ' + id);
    for (const row of rows) {
      assert(expected.has(row.request_id), 'unexpected assignment: ' + row.request_id);
      assert.deepEqual(JSON.parse(row.payload), expected.get(row.request_id), 'immutable payload changed');
      assert.equal(row.status, 'queued');
      const notices = db.prepare("SELECT subscription_id,state,body FROM notifications WHERE request_id=? AND kind='event'").all(row.request_id);
      assert.equal(notices.length, subscriptions.length, 'outbox cardinality: ' + row.request_id);
      for (const sub of subscriptions) {
        const matching = notices.filter(notice => notice.subscription_id === sub);
        assert.equal(matching.length, 1, 'missing/duplicate outbox: ' + row.request_id + '/' + sub);
        assert(['pending', 'sending', 'delivered'].includes(matching[0].state), 'unexpected availability state');
        // A submit wake names the oldest queued assignment when older ones wait; it always names a known queued assignment.
        assert(expected.has(JSON.parse(matching[0].body).data.request_id), 'wake names an unknown assignment');
      }
    }
    return ids;
  } finally { db.close(); }
}
try {
  webhook = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    if (value.type === 'verification') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: value.challenge }));
    else res.writeHead(204).end();
  });
  await new Promise(resolve => webhook.listen(0, '127.0.0.1', resolve));
  for (const { round, delay, burst } of schedule) {
    home = join(root, String(round));
    await mkdir(join(home, 'bin'), { recursive: true });
    await mkdir(join(home, '.config/dot-bridge'), { recursive: true });
    await writeFile(join(home, '.config/dot-bridge/limits.json'), JSON.stringify({ max_claimed_outer_assignments: 1, assignment_reannounce_max_count: 0 }), { mode: 0o600 });
    await writeFile(join(home, 'bin/t3code'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,data:{runtime:{environmentId:"fake-environment"},thread:{id:"' + thread + '",status:"active",deletedAt:null}}}));\n', { mode: 0o755 });
    env = { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: '0',
      DOT_BRIDGE_AUTH_MODE: '', DOT_BRIDGE_ENABLE_WORKSPACE: '0',
      DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1', DOT_BRIDGE_T3_DRY_RUN: '1',
      DOT_BRIDGE_CRASH_AT: '', DOT_BRIDGE_CRASH_REQUEST_ID: '',
      PATH: join(home, 'bin') + ':' + process.env.PATH };
    await start(round, 'initial');
    secret = (await readFile(join(home, '.config/dot-bridge/env'), 'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    const subscriptions = [];
    for (let index = 0; index < 2; index++) {
      const subscription = await rpc('events/subscribe', {
        name: 'assignment.available', arguments: {}, ttlMs: 3600000,
        delivery: { mode: 'webhook', url: 'http://127.0.0.1:' + webhook.address().port + '/hook/' + index,
          secret: 'whsec_' + Buffer.alloc(32, index + 1).toString('base64') }
      });
      assert(subscription.id);
      subscriptions.push(subscription.id);
    }
    const expected = new Map(), acknowledged = new Set();
    function payload(index) {
      const value = { schema_version: 1, request_id: 'req_crash_' + seed + '_' + round + '_' + index,
        brief: 'submit crash round ' + round + ' item ' + index,
        inputs: [{ round, index, nested: { seed, unicode: 'durable λ' } }],
        expected_output: 'immutable result', execution_scope: 'read-only' };
      expected.set(value.request_id, value);
      return value;
    }
    const anchor = payload('anchor'), anchorResponse = await submit(anchor);
    assert.equal(anchorResponse.status, 200, JSON.stringify(anchorResponse));
    assert.equal(anchorResponse.value.duplicate, false);
    acknowledged.add(anchor.request_id);
    const unread = payload('unread');
    assert((await submit(unread, true)).headersOnly, 'lost-response fixture never reached response headers');
    const racing = Array.from({ length: burst }, (_, index) => payload(index));
    const pending = racing.map(async value => {
      const response = await submit(value);
      if (!response.lost) {
        assert.equal(response.status, 200, JSON.stringify(response));
        assert.equal(response.value.request_id, value.request_id);
        acknowledged.add(value.request_id);
      }
    });
    await sleep(delay);
    const child = service;
    await stop('SIGKILL');
    assert.equal(child.signalCode, 'SIGKILL', 'service was not killed');
    summary.kills++;
    await Promise.all(pending);
    const before = inspect(expected, acknowledged, subscriptions);
    assert(before.has(unread.request_id), 'committed unread response lost');
    await start(round, 'restart');
    assert.deepEqual(inspect(expected, acknowledged, subscriptions), before, 'restart changed durable assignments');
    for (const [id, value] of expected) {
      if (acknowledged.has(id)) continue;
      const retry = await submit(value);
      assert.equal(retry.status, 200, JSON.stringify(retry));
      assert.equal(retry.value.request_id, id);
      assert.equal(retry.value.duplicate, before.has(id), 'retry duplicate does not match durable acceptance');
      const twice = await submit(value);
      assert.equal(twice.status, 200);
      assert.equal(twice.value.duplicate, true, 'second retry created another assignment');
      if (before.has(id)) summary.committedLostResponses++; else summary.absentLostResponses++;
    }
    const allIds = inspect(expected, new Set(expected.keys()), subscriptions);
    assert.equal(allIds.size, expected.size);
    // Each isolated round stays below list_pending's documented 50-item limit.
    const pendingResult = await rpc('tools/call', { name: 'list_pending', arguments: {} });
    assert(!pendingResult.isError, JSON.stringify(pendingResult));
    const listed = JSON.parse(pendingResult.content[0].text).assignments;
    assert.deepEqual(new Set(listed.map(value => value.request_id)), allIds, 'list_pending omitted accepted queued work');
    summary.acknowledged += acknowledged.size;
    console.log('PASS round=' + round + ' kill_ms=' + delay + ' acknowledged=' + acknowledged.size + ' persisted_before_retry=' + before.size + ' total=' + allIds.size);
    await stop();
  }
  assert.equal(summary.kills, 30);
  assert(summary.committedLostResponses >= 30, 'no committed lost-response coverage');
  assert(summary.absentLostResponses > 0, 'no pre-commit loss coverage; retry this seed and investigate timing');
  console.log('PASS submit crash durability/outbox ' + JSON.stringify(summary));
} catch (error) {
  console.error('FAIL SUBMIT_CRASH_SEED=' + seed + ': ' + error.stack + '\nservice output:\n' + (startup?.output ?? ''));
  if (error.diagnostic) console.error('STARTUP_DIAGNOSTIC ' + JSON.stringify(error.diagnostic));
  process.exitCode = 1;
} finally {
  await cleanupFixture({
    stop:()=>stop('SIGKILL'),
    onStopError:error=>{
      // The primary failure has already been reported. Cleanup must not replace it.
      console.error('CLEANUP_DIAGNOSTIC ' + JSON.stringify(error.diagnostic ?? {classification:'cleanup-error'}));
      process.exitCode = 1;
    },
    closeWebhook:async()=>{
      if (webhook) { webhook.closeAllConnections(); await new Promise(resolve => webhook.close(resolve)); }
    },
    removeRoot:()=>rm(root, {recursive:true, force:true})
  });
}
