#!/usr/bin/env node
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Deadman, createDeadmanFromEnv } from '../src/deadman.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';

const root = await mkdtemp(path.join(os.tmpdir(), 'dalan-deadman-test-'));
const token = 'test-token-'.padEnd(40, 'x');
const minute = 60_000;
let now = 1_800_000_000_000;
let elapsed = 0;
const advance = ms => { now += ms; elapsed += ms; };
const tick = async (monitor, ms = 0) => { advance(ms); await monitor.tick(); };
const heartbeat = async monitor => {
  const result = await monitor.heartbeat(token, { healthy: true });
  assert.equal(result.status, 202);
};
const recoverSteadily = async monitor => {
  for (let i = 0; i < 15; i++) {
    if (i) advance(minute);
    await heartbeat(monitor);
  }
};
function monitor(dbName, publisher, overrides = {}) {
  return new Deadman({ dbFile: path.join(root, dbName), token, publisher, now: () => now, elapsedNow: () => elapsed, deadlineMs: 5 * minute, clearMs: 15 * minute, reminderMs: 120 * minute, tickMs: 10_000, retryMs: minute, ...overrides });
}
const runHeartbeatCli = env => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['bin/dot-deadman.mjs', 'heartbeat'], { cwd: path.resolve(new URL('..', import.meta.url).pathname), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  child.once('error', reject);
  child.once('close', code => resolve({ code, stdout, stderr }));
});

try {
  const notices = [];
  const publisher = async (title, body) => { notices.push({ title, body }); return { accepted: true }; };
  let m = monitor('restart.sqlite', publisher);
  await tick(m, 5 * minute + 1);
  assert.equal(notices.length, 1, 'missed deadline sends initial alert');
  assert.equal(notices[0].title, 'Dalan host heartbeat missed');
  const episodeId = m.status().active_episode_id;
  await m.close();

  m = monitor('restart.sqlite', publisher);
  assert.equal(m.status().active_episode_id, episodeId, 'active episode survives restart');
  await tick(m, 119 * minute);
  assert.equal(notices.length, 1, 'no early reminder');
  await tick(m, minute);
  assert.equal(notices.length, 2, 'one reminder at two hours');
  await tick(m, minute);
  assert.equal(notices.length, 2, 'reminder is one-shot');

  await heartbeat(m);
  await recoverSteadily(m);
  await heartbeat(m);
  assert.equal(m.status().active_episode_id, episodeId, 'recovery requires full 15 minutes');
  advance(minute);
  await heartbeat(m);
  assert.equal(m.status().active_episode_id, null, '15 minutes of timely heartbeats clears episode');
  assert(m.status().episodes[0].closed_at);
  await m.close();

  const startupNotices = [];
  m = monitor('startup-grace.sqlite', async (...args) => { startupNotices.push(args); return { accepted: true }; });
  await tick(m, 4 * minute + 59_000);
  assert.equal(startupNotices.length, 0, 'startup grace prevents an early new episode');
  await m.close();
  now += 6 * minute; // receiver was stopped; monotonic elapsed does not advance while it is down
  m = monitor('startup-grace.sqlite', async (...args) => { startupNotices.push(args); return { accepted: true }; });
  await m.tick();
  assert.equal(startupNotices.length, 0, 'receiver restart gets a full heartbeat grace period');
  await tick(m, 5 * minute);
  assert.equal(startupNotices.length, 1, 'new episode opens when restarted receiver grace expires');
  await m.close();

  m = monitor('startup-heartbeat.sqlite', async (...args) => { startupNotices.push(args); return { accepted: true }; });
  await tick(m, 4 * minute);
  await heartbeat(m);
  assert.equal(m.status().active_episode_id, null, 'first heartbeat during grace prevents a false restart episode');
  await tick(m, 5 * minute + 1);
  assert(m.status().active_episode_id, 'first confirmed heartbeat starts normal deadline monitoring');
  await m.close();

  const flapNotices = [];
  m = monitor('flap.sqlite', async (...args) => { flapNotices.push(args); return { accepted: true }; });
  await tick(m, 5 * minute + 1);
  await heartbeat(m);
  await tick(m, 5 * minute + 1);
  assert.equal(m.status().recovery_since, null, 'a missed heartbeat resets recovery clock');
  await heartbeat(m);
  await recoverSteadily(m);
  assert(m.status().active_episode_id, 'recovery has not elapsed after 14 minutes');
  advance(minute);
  await heartbeat(m);
  assert.equal(m.status().active_episode_id, null, 'recovery starts again after flap');
  assert.equal(flapNotices.length, 1, 'flap does not duplicate initial alert');
  await m.close();

  m = monitor('late-heartbeat.sqlite', async () => ({ accepted: true }));
  await tick(m, 5 * minute + 1);
  await heartbeat(m);
  const firstRecovery = m.status().recovery_since;
  advance(6 * minute);
  await heartbeat(m);
  assert(m.status().recovery_since > firstRecovery, 'heartbeat after an unobserved deadline starts a new recovery window');
  assert.equal(m.status().active_episode_id !== null, true, 'late heartbeat does not erase the outage episode');
  await m.close();

  m = monitor('clock-regression.sqlite', async () => ({ accepted: true }));
  await tick(m, 5 * minute + 1);
  await heartbeat(m);
  await recoverSteadily(m);
  const recoveryAt = m.status().recovery_since;
  assert(m.status().active_episode_id, 'episode remains open after 14 minutes');
  now -= 10 * minute;
  await heartbeat(m);
  assert.equal(m.status().active_episode_id !== null, true, 'clock rollback does not clear an episode');
  assert.equal(m.status().recovery_since, recoveryAt, 'clock rollback does not move recovery forward');
  for (let i = 0; i < 15; i++) {
    advance(minute);
    await heartbeat(m);
  }
  assert.equal(m.status().active_episode_id, null, 'episode clears only after effective time advances through 15 minutes');
  await m.close();

  let attempts = 0;
  m = monitor('known-reject.sqlite', async () => (++attempts === 1 ? { status: 429 } : { accepted: true }));
  await tick(m, 5 * minute + 1);
  assert.equal(m.status().episodes[0].initial_state, 'pending', 'explicit 4xx remains safely retryable');
  await tick(m, minute);
  assert.equal(attempts, 2, 'known rejection retries after bounded delay');
  assert.equal(m.status().episodes[0].initial_state, 'sent');
  await m.close();

  let connectAttempts = 0;
  m = monitor('connect-retry.sqlite', async () => {
    connectAttempts++;
    const error = new Error('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  });
  await tick(m, 5 * minute + 1);
  assert.equal(m.status().episodes[0].initial_state, 'pending', 'known pre-send refusal remains retryable');
  assert.equal(m.status().episodes[0].last_error, 'publisher_connect_econnrefused');
  await tick(m, minute);
  assert.equal(connectAttempts, 2, 'connection refusal retries after backoff');
  await m.close();

  m = monitor('dns-retry.sqlite', async () => {
    const aggregate = new AggregateError([Object.assign(new Error('dns'), { code: 'ENOTFOUND' })], 'fetch failed');
    throw Object.assign(new Error('request failed'), { cause: aggregate });
  });
  await tick(m, 5 * minute + 1);
  assert.equal(m.status().episodes[0].initial_state, 'pending', 'nested DNS failure is a known pre-send retry');
  assert.equal(m.status().episodes[0].last_error, 'publisher_connect_enotfound');
  await m.close();

  for (const code of ['ENETUNREACH', 'EHOSTUNREACH']) {
    m = monitor(`${code.toLowerCase()}-retry.sqlite`, async () => { throw Object.assign(new Error('connect failed'), { cause: { code } }); });
    await tick(m, 5 * minute + 1);
    assert.equal(m.status().episodes[0].initial_state, 'pending', `${code} is a known pre-send retry`);
    assert.equal(m.status().episodes[0].last_error, `publisher_connect_${code.toLowerCase()}`);
    await m.close();
  }

  let redirectAttempts = 0;
  m = monitor('redirect.sqlite', async () => { redirectAttempts++; return { status: 307 }; });
  await tick(m, 5 * minute + 1);
  assert.equal(m.status().episodes[0].initial_state, 'configuration_error', 'redirect is retained as a configuration error');
  assert.equal(m.status().episodes[0].last_error, 'publisher_redirect_http_307');
  await tick(m, 10 * minute);
  assert.equal(redirectAttempts, 1, 'redirect configuration error is not repeatedly sent');
  await m.close();

  m = monitor('timeout-uncertain.sqlite', async () => { throw Object.assign(new Error('timeout'), { cause: { code: 'ETIMEDOUT' } }); });
  await tick(m, 5 * minute + 1);
  assert.equal(m.status().episodes[0].initial_state, 'uncertain', 'post-send timeout remains ambiguous');
  await m.close();

  m = monitor('http-5xx-uncertain.sqlite', async () => ({ status: 503 }));
  await tick(m, 5 * minute + 1);
  assert.equal(m.status().episodes[0].initial_state, 'uncertain', '5xx remains ambiguous');
  await m.close();

  let reminderAttempts = 0;
  m = monitor('reminder-backoff.sqlite', async title => {
    if (title === 'Dalan still unreachable' && ++reminderAttempts === 1) return { status: 429 };
    return { accepted: true };
  });
  await tick(m, 5 * minute + 1);
  await tick(m, 120 * minute);
  assert.equal(reminderAttempts, 1, 'first due reminder attempted once');
  assert.equal(m.status().episodes[0].reminder_state, 'waiting');
  await tick(m, 30_000);
  assert.equal(reminderAttempts, 1, 'safe reminder rejection respects retry delay');
  await tick(m, 30_000);
  assert.equal(reminderAttempts, 2, 'safe reminder rejection retries at next_attempt_at');
  assert.equal(m.status().episodes[0].reminder_state, 'sent');
  await m.close();

  let uncertainAttempts = 0;
  m = monitor('uncertain.sqlite', async () => { uncertainAttempts++; throw new Error('simulated ambiguous network outcome'); });
  await tick(m, 5 * minute + 1);
  assert.equal(m.status().episodes[0].initial_state, 'uncertain');
  assert(!JSON.stringify(m.status()).includes('simulated ambiguous'), 'publisher exception text is not persisted');
  await m.close();
  m = monitor('uncertain.sqlite', async () => { uncertainAttempts++; return { accepted: true }; });
  await tick(m, 3 * minute);
  assert.equal(uncertainAttempts, 1, 'ambiguous send is not repeated across restart');
  assert.equal(m.status().episodes[0].initial_state, 'uncertain');
  await m.close();

  m = monitor('crash.sqlite', null);
  await tick(m, 5 * minute + 1);
  m.db.prepare("UPDATE episodes SET initial_state='sending' WHERE id=1").run();
  await m.close();
  m = monitor('crash.sqlite', async () => { throw new Error('must not resend'); });
  assert.equal(m.status().episodes[0].initial_state, 'uncertain', 'restart reconciles interrupted publication as uncertain');
  await tick(m, minute);
  assert.equal(m.status().episodes[0].initial_state, 'uncertain', 'interrupted publication is not retried');
  await m.close();

  m = createDeadmanFromEnv({
    DOT_DEADMAN_TOKEN: token,
    DOT_DEADMAN_DB: path.join(root, 'ipv6-publisher.sqlite'),
    DOT_DEADMAN_NTFY_URL: 'http://[::1]:9123/test-topic'
  });
  await m.close();
  assert.throws(() => createDeadmanFromEnv({
    DOT_DEADMAN_TOKEN: token,
    DOT_DEADMAN_DB: path.join(root, 'invalid-publisher.sqlite'),
    DOT_DEADMAN_NTFY_URL: 'http://notify.example.test/topic'
  }), /must use HTTPS/, 'remote cleartext publisher URL rejected at startup');

  m = monitor('http.sqlite', null);
  const address = await m.start({ port: 0 });
  assert.equal(address.address, '127.0.0.1', 'default listener is loopback only');
  const url = `http://127.0.0.1:${address.port}/heartbeat`;
  const unauthorized = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer incorrect-token' }, body: '{"healthy":true}' });
  assert.equal(unauthorized.status, 401, 'wrong bearer rejected');
  const invalid = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"healthy":false}' });
  assert.equal(invalid.status, 400, 'unhealthy heartbeat rejected');
  await assert.rejects(fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ healthy: true, ignored: 'x'.repeat(1100) }) }), 'oversized heartbeat connection is rejected');
  const accepted = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"healthy":true}' });
  assert.equal(accepted.status, 202, 'authenticated healthy heartbeat accepted');
  const status = await fetch(url, { method: 'GET' });
  assert.equal(status.status, 404, 'no unauthenticated status surface');
  await m.close();

  let pingCalls = 0;
  const pingServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    pingCalls++;
    assert.equal(req.url, '/proxy/base/heartbeat', 'base URL path prefix is preserved');
    assert.equal(req.headers.authorization, `Bearer ${token}`, 'quoted token reaches receiver without quote characters');
    assert.equal(body, '{"healthy":true}');
    res.writeHead(202).end();
  });
  await new Promise(resolve => pingServer.listen(0, '127.0.0.1', resolve));
  const healthFile = path.join(root, 'health.json');
  const envFile = path.join(root, 'deadman.env');
  await writeFile(envFile, `DOT_DEADMAN_URL="http://127.0.0.1:${pingServer.address().port}/proxy/base"\nDOT_DEADMAN_TOKEN='${token}'\n`, { mode: 0o600 });
  await writeFile(healthFile, JSON.stringify({ healthy: true, observed_at: new Date().toISOString() }));
  const childEnv = { ...process.env, HOME: root, DOT_DEADMAN_ENV: envFile, DOT_BRIDGE_HEALTH_FILE: healthFile };
  delete childEnv.DOT_DEADMAN_URL;
  delete childEnv.DOT_DEADMAN_TOKEN;
  const ping = await runHeartbeatCli(childEnv);
  assert.equal(ping.code, 0, ping.stderr);
  assert.equal(ping.stdout, 'heartbeat accepted\n');
  assert.equal(pingCalls, 1);
  await writeFile(healthFile, JSON.stringify({ healthy: true, observed_at: new Date(Date.now() - 91_000).toISOString() }));
  const stalePing = await runHeartbeatCli(childEnv);
  assert.equal(stalePing.code, 1, 'stale health record blocks heartbeat');
  assert.equal(pingCalls, 1, 'stale health record sends no request');
  assert(!stalePing.stderr.includes(token), 'health gate error does not expose bearer');
  await new Promise(resolve => pingServer.close(resolve));

  const db = new DatabaseSync(path.join(root, 'uncertain.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM episodes').get().n, 1, 'one durable episode per outage');
  db.close();
  console.log('PASS dead-man deadline, persistence, two-hour reminder, 15-minute recovery, flap reset, auth, and send ambiguity');
} finally {
  await rm(root, { recursive: true, force: true });
}
