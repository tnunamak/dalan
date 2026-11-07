#!/usr/bin/env node
// Real bridge, fake worker, raw ACP: concurrent children, bridge restart and interrupt/steer.
// The default cap is a queued-count preflight, not an atomic reservation or a claimed-work cap.
// A simultaneous burst may admit 10..20 before submissions become visible to other status reads.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { startAdapter } from './acp-client.mjs';

const repo = resolve(new URL('..', import.meta.url).pathname);
const home = await mkdtemp(join(tmpdir(), 'dalan-acp-robustness-'));
const socket = join(home, '.local/share/dot-bridge/admin.sock');
const stateDir = join(home, '.local/state/dot-bridge/acp');
const secretFile = join(home, '.config/dot-bridge/acp-secret');
const noGit = join(home, 'plain');
// Blank inherited adapter/bridge settings, including any live socket or state directory override.
const cleanEnv = Object.fromEntries(Object.keys(process.env).filter(k => /^(DOT_|OAUTH_)/.test(k)).map(k => [k, '']));
const env = { ...process.env, ...cleanEnv, HOME: home, DALAN_LEGACY_PROFILE: '1', XDG_CONFIG_HOME: join(home, '.config'),
  XDG_STATE_HOME: join(home, '.local/state'), DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1',
  DOT_BRIDGE_AUTH_MODE: '', DOT_BRIDGE_PORT: '0', PATH: `${join(home, 'bin')}:${process.env.PATH}` };
const adapters = [];
let service, serviceExited, serviceOutput = '', port, bridgeSecret;
const started = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function within(promise, label, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}\n${serviceOutput.slice(-2000)}`)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function waitFor(test, label, ms = 10000) {
  const deadline = Date.now() + ms;
  do { if (await test()) return; await sleep(25); } while (Date.now() < deadline);
  throw new Error(`timed out: ${label}\n${serviceOutput.slice(-2000)}`);
}
function emergencyCleanup() {
  for (const a of adapters) a.kill('SIGKILL');
  service?.kill('SIGKILL');
}
process.once('exit', emergencyCleanup);
// Even a broken adapter or cleanup cannot leave this suite hanging indefinitely.
const watchdog = setTimeout(() => {
  console.error('FAIL ACP robustness exceeded 85 seconds');
  emergencyCleanup(); rmSync(home, { recursive: true, force: true }); process.exit(1);
}, 85000);

async function startBridge() {
  let ready = false;
  serviceOutput = '';
  service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serviceExited = new Promise(r => service.once('exit', (code, signal) => r({ code, signal })));
  service.stdout.on('data', b => {
    serviceOutput += b;
    const match = /MCP listening on 127\.0\.0\.1:(\d+)/.exec(serviceOutput);
    if (match) { port = Number(match[1]); ready = true; }
  });
  service.stderr.on('data', b => { serviceOutput += b; });
  await waitFor(() => {
    assert.equal(service.exitCode, null, serviceOutput);
    return ready && existsSync(socket);
  }, 'bridge startup');
  bridgeSecret = (await readFile(join(home, '.config/dot-bridge/env'), 'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
}
async function stopBridge() {
  service.kill('SIGKILL');
  await within(serviceExited, 'bridge exit');
  service = null;
}
async function rpc(name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/${bridgeSecret}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200, `${name}: HTTP error`);
  const body = await response.json();
  assert.ok(!body.error && !body.result?.isError, `${name}: ${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}
function rows(prefix = '') {
  const db = new DatabaseSync(join(home, '.local/share/dot-bridge/bridge.db'), { readOnly: true });
  try {
    return db.prepare('SELECT request_id,status,payload FROM assignments ORDER BY request_id').all()
      .filter(r => r.request_id.startsWith(prefix));
  } finally { db.close(); }
}
// Session ownership locks (finding 5) leave `<id>.json.lock` files behind by design; only `.json` files are session state.
const stateFiles = async () => (await readdir(stateDir)).filter(f => f.endsWith('.json'));
const stateFile = id => join(stateDir, `${id}.json`);
const frames = (a, id, type) => a.notifications.filter(n => n.sessionId === id && n.update.sessionUpdate === type);
// The closing 'decide:' line (asserted in acp-e2e) is stripped so these checks compare the worker's result.
const messages = (a, id) => frames(a, id, 'agent_message_chunk').map(n => n.update.content.text.replace(/\n\ndecide: (?:dalan|dot-worker) decide \S+ accepted\|applied\|useful_no_change\|useful_negative\|not_useful/, ''));
const thoughts = (a, id) => frames(a, id, 'agent_thought_chunk').map(n => n.update.content.text).join('');
async function adapter(cap) {
  const a = startAdapter({ ...env, DOT_ACP_SOCKET: socket, DOT_ACP_SECRET_FILE: secretFile,
    DOT_ACP_STATE_DIR: stateDir, DOT_ACP_INFLIGHT_CAP: cap === undefined ? '' : String(cap),
    DOT_ACP_HEARTBEAT_MS: '250' }, noGit);
  adapters.push(a);
  // Keep session IDs for cross-talk assertions; the shared raw client's updates array drops them.
  a.notifications = [];
  createInterface({ input: a.child.stdout }).on('line', line => {
    try { const frame = JSON.parse(line); if (frame.method === 'session/update') a.notifications.push(frame.params); } catch {}
  });
  assert.equal((await within(a.init(), 'ACP initialize')).protocolVersion, 1);
  return a;
}
async function newSession(a) { return (await within(a.newSession(noGit), 'ACP session/new')).sessionId; }
function prompt(a, id, rid, brief) {
  const turn = { reply: null };
  turn.done = a.prompt(id, `[dot-decision:${rid}]\n${brief}`).then(reply => { turn.reply = reply; return reply; });
  return turn;
}
async function claim(rid) {
  const result = await rpc('claim', { request_id: rid, claimant: 'fake-worker-robustness' });
  assert.ok(result.claim_id, JSON.stringify(result)); return result.claim_id;
}
async function finish(rid, claimId, result) {
  await rpc('finish', { request_id: rid, claim_id: claimId, outcome: 'completed', summary: 'done', result });
}
async function closeAdapters(list) {
  for (const a of list) a.child.stdin.end();
  for (const a of list) {
    assert.deepEqual(await within(a.exited, 'adapter EOF exit'), { code: 0, signal: null });
    assert.deepEqual(a.errors, [], 'stdout contains only protocol frames');
  }
}

async function concurrency(processCount, cap) {
  const prefix = `load_${processCount}_${cap ?? 'default'}_`;
  // Start all processes before any prompt; no sleeps between the 20 prompt writes.
  const pool = await Promise.all(Array.from({ length: processCount }, () => adapter(cap)));
  const children = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const a = pool[i % pool.length], id = await newSession(a);
    return { a, id, rid: `${prefix}${i}`, brief: `Distinct brief ${prefix}${i}`, result: `RESULT ${prefix}${i}` };
  }));
  assert.equal(new Set(children.map(c => c.id)).size, 20, 'unique ACP session IDs');
  for (const c of children) c.turn = prompt(c.a, c.id, c.rid, c.brief);
  await waitFor(() => {
    const queued = new Set(rows(prefix).map(r => r.request_id));
    return children.every(c => queued.has(c.rid) ? existsSync(stateFile(c.id)) : c.turn.reply !== null);
  }, 'all burst prompts admitted or refused');
  const queued = rows(prefix), admittedIds = new Set(queued.map(r => r.request_id));
  const admitted = children.filter(c => admittedIds.has(c.rid));
  const refused = children.filter(c => !admittedIds.has(c.rid));
  if (cap === 25) assert.equal(admitted.length, 20, 'cap 25 admits the entire burst');
  else {
    assert.equal(admitted.length, 10, `atomic admission cap (finding 7) admits exactly 10, got ${admitted.length}`);
    // Once the burst has settled, the default cap must reject further work, without queuing it.
    const extra = await newSession(pool[0]);
    const reply = await within(pool[0].prompt(extra, `[dot-decision:${prefix}overflow]\nAfter the burst`), 'queue refusal');
    assert.equal(reply.error?.code, -32000);
    assert.match(reply.error.message, /worker refused: worker queue is full.*in-flight cap 10/);
    assert.equal(rows(prefix).length, admitted.length);
    assert.ok(!existsSync(stateFile(extra)));
  }
  for (const c of refused) {
    assert.equal(c.turn.reply.error?.code, -32000);
    assert.match(c.turn.reply.error.message, /worker refused: worker queue is full.*in-flight cap 10/);
    assert.deepEqual(messages(c.a, c.id), []);
    assert.ok(!existsSync(stateFile(c.id)));
  }
  assert.equal((await stateFiles()).length, admitted.length, 'exactly one state file per admitted session');
  for (const c of admitted) {
    const row = queued.find(r => r.request_id === c.rid);
    assert.equal(row.status, 'queued');
    assert.equal(JSON.parse(row.payload).brief, c.brief);
    const saved = JSON.parse(readFileSync(stateFile(c.id), 'utf8'));
    assert.equal(saved.id, c.id); assert.equal(saved.pending.rid, c.rid);
    assert.equal(statSync(stateFile(c.id)).mode & 0o777, 0o600);
    assert.equal(c.turn.reply, null, 'admitted prompt still waiting');
  }
  // Finish in reverse order so result isolation cannot pass by depending on FIFO ordering.
  for (const c of admitted.toReversed()) await finish(c.rid, await claim(c.rid), c.result);
  await within(Promise.all(children.map(c => c.turn.done)), 'burst results');
  for (const c of admitted) {
    assert.equal(c.turn.reply.result?.stopReason, 'end_turn');
    assert.deepEqual(messages(c.a, c.id), [c.result], 'one correct result for this session, no cross-talk');
  }
  assert.equal(rows(prefix).length, admitted.length, 'no duplicate assignments');
  assert.ok(rows(prefix).every(r => r.status === 'finished'));
  assert.deepEqual(await stateFiles(), [], 'all delivered state files removed');
  await closeAdapters(pool);
  console.log(`PASS concurrency: 20 sessions / ${processCount} processes, cap ${cap ?? 'default 10'}: ${admitted.length} admitted, ${refused.length} refused; isolated results and state cleanup`);
}

try {
  await mkdir(join(home, '.config/dot-bridge'), { recursive: true });
  await mkdir(join(home, 'bin')); await mkdir(noGit);
  await writeFile(join(home, '.config/dot-bridge/limits.json'), JSON.stringify({ main_thread_ids: ['00000000-0000-4000-8000-000000000001'] }), { mode: 0o600 });
  // Delivery is none; any accidental T3 invocation stays inside the fixture PATH.
  await writeFile(join(home, 'bin/t3code'), '#!/bin/sh\necho "unexpected T3 invocation" >&2\nexit 1\n', { mode: 0o755 });
  await startBridge();
  for (const cap of [undefined, 25]) for (const processes of [1, 20]) await concurrency(processes, cap);

  const a = await adapter(), id = await newSession(a), rid = 'outage_queued_01';
  const turn = prompt(a, id, rid, 'Survive a bridge restart');
  await waitFor(() => thoughts(a, id).includes('worker queued'), 'queued heartbeat before outage');
  const before = rows(), savedState = readFileSync(stateFile(id), 'utf8');
  await stopBridge();
  const downAt = Date.now();
  await waitFor(() => thoughts(a, id).includes('bridge unreachable'), 'outage heartbeat');
  await sleep(Math.max(0, 5100 - (Date.now() - downAt)));
  assert.equal(turn.reply, null, 'prompt must keep waiting throughout the five-second outage');
  assert.deepEqual(messages(a, id), []);
  assert.equal(readFileSync(stateFile(id), 'utf8'), savedState, 'outage preserves pending assignment');
  await startBridge();
  assert.deepEqual(rows(), before, 'restart preserves the same database rows');
  await finish(rid, await claim(rid), 'RECOVERED RESULT');
  assert.equal((await within(turn.done, 'result after bridge restart')).result?.stopReason, 'end_turn');
  assert.deepEqual(messages(a, id), ['RECOVERED RESULT']);
  assert.equal(rows().length, before.length, 'outage never resubmits');
  assert.ok(!existsSync(stateFile(id)));
  console.log('PASS outage: queued prompt waits through 5 seconds down, then delivers once from the same assignment');

  const offlineId = await newSession(a), offlineRid = 'outage_submit_01';
  const beforeOffline = rows();
  await stopBridge();
  const offlineAt = Date.now();
  const offline = await within(a.prompt(offlineId, `[dot-decision:${offlineRid}]\nSubmit while bridge is down`), 'offline submit error', 5000);
  assert.equal(offline.error?.code, -32000);
  assert.match(offline.error.message, /worker adapter error:.*(?:ECONNREFUSED|ENOENT)/);
  assert.ok(Date.now() - offlineAt < 5000, 'offline submit fails promptly');
  assert.deepEqual(messages(a, offlineId), []);
  assert.ok(!existsSync(stateFile(offlineId)));
  await startBridge();
  assert.deepEqual(rows(), beforeOffline, 'failed submit leaves no queued assignment');
  console.log('PASS outage at submit: clear error within 5 seconds, no assignment or session state left behind');

  const steerId = await newSession(a), steerRid = 'steer_claimed_01';
  const first = prompt(a, steerId, steerRid, 'Original immutable brief');
  await waitFor(() => rows(steerRid)[0]?.status === 'queued' && existsSync(stateFile(steerId)), 'steer assignment queued');
  const claimId = await claim(steerRid), beforeSteer = rows().length;
  a.cancel(steerId);
  assert.equal((await within(first.done, 'cancel claimed turn', 9000)).result?.stopReason, 'cancelled');
  assert.equal(rows(steerRid)[0].status, 'claimed');
  assert.deepEqual(messages(a, steerId), [], 'cancelled turn delivers no result');
  const steerText = 'Also inspect the retry behavior';
  // Finding 3: tags inside an unwrapped follow-up are user text and are preserved, not stripped.
  const steerPrompt = `${steerText}\n<runtime_info>test runtime</runtime_info>`;
  const second = a.prompt(steerId, steerPrompt);
  await waitFor(() => thoughts(a, steerId).includes(`re-attached to ${steerRid}`), 'steer reattachment');
  assert.equal(rows().length, beforeSteer, 'steer did not submit another assignment');
  assert.equal(JSON.parse(rows(steerRid)[0].payload).brief, 'Original immutable brief');
  await finish(steerRid, claimId, 'ORIGINAL RESULT');
  assert.equal((await within(second, 'steered result')).result?.stopReason, 'end_turn');
  assert.deepEqual(messages(a, steerId), [`ORIGINAL RESULT\n\nnot sent to the worker: ${steerPrompt}`]);
  assert.equal(rows().length, beforeSteer, 'exactly one assignment across cancel and steer');
  assert.deepEqual(await stateFiles(), []);
  await closeAdapters([a]);
  console.log('PASS steer: claimed cancel/restart returns one result with unsent steer text and creates no second assignment');
  console.log(`ACP robustness completed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} finally {
  emergencyCleanup();
  await Promise.all(adapters.map(a => a.exited));
  if (service) await serviceExited;
  await rm(home, { recursive: true, force: true });
  clearTimeout(watchdog); process.removeListener('exit', emergencyCleanup);
}
