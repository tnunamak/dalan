#!/usr/bin/env node
// A worker that opts in with `finish_handoff` gets its next job inside the reply to `finish`: claimed through the normal
// claim path, or, when the queue is empty, after a bounded wait for work. Everything runs against a real server over HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';
import { parseWorkers } from '../src/workers.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const root = process.env.DOT_BRIDGE_TEST_TMP || path.join(os.homedir(), '.tmp');
fs.mkdirSync(root, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WAIT_MS = 1500;
const assignment = request_id => ({ schema_version: 1, request_id, brief: `Synthetic fixture ${request_id}`, inputs: [], expected_output: 'One line', execution_scope: 'read-only' });

async function startBridge(label, workerExtra, limits) {
  const home = fs.mkdtempSync(path.join(root, `finish-handoff-${label}-`));
  const env = fixtureEnv(home, { DOT_BRIDGE_PORT: '0', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_RESUME_IDLE_MS: '0' });
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
  return { rpc, ok, submit, admin, operator, stop, claimNew, finish, queuedIds };
}
const pass = message => console.log(`PASS ${message}`);

// Config: finish_handoff is off unless set, and rejects anything that is not true, false or {wait_ms: 0..45000}.
{
  const parse = finish_handoff => parseWorkers({ workers: { dot: { connections: [{ issuer: 'i', subject: 's', client_id: 'c' }], ...(finish_handoff === undefined ? {} : { finish_handoff }) } } }).workers.get('dot').finishHandoff;
  assert.equal(parse(undefined), undefined);
  assert.equal(parse(false), undefined);
  assert.deepEqual(parse(true), { waitMs: 20000 });
  assert.deepEqual(parse({}), { waitMs: 20000 });
  assert.deepEqual(parse({ wait_ms: 0 }), { waitMs: 0 });
  assert.deepEqual(parse({ wait_ms: 45000 }), { waitMs: 45000 });
  for (const bad of ['yes', 1, null, [], { wait_ms: -1 }, { wait_ms: 45001 }, { wait_ms: 1.5 }, { wait_ms: null }, { wait_ms: '20' }, { extra: 1 }])
    assert.throws(() => parse(bad), /finish_handoff|expected object|wait_ms/, `rejects ${JSON.stringify(bad)}`);
  pass('finish_handoff config: off by default; true, {} and {wait_ms 0..45000} accepted; everything else refused');
}

const bridges = [];
const start = async (...args) => { const b = await startBridge(...args); bridges.push(b); return b; };
try {
  const b = await start('on', { finish_handoff: { wait_ms: WAIT_MS } });

  // 1. Work is queued: the finish reply carries the oldest queued job, already claimed through the normal claim path.
  {
    const first = await b.claimNew('req_handoff_first');
    for (const id of ['req_handoff_q1', 'req_handoff_q2']) await b.submit(id);
    const started = Date.now();
    const done = await b.finish(first);
    assert.ok(Date.now() - started < 1000, 'no wait when a job is queued');
    assert.equal(done.next_job?.request_id, 'req_handoff_q1', JSON.stringify(done));
    assert.ok(done.next_job.claim_id, 'next_job is a real claim result');
    assert.equal(done.next_job.assignment.request_id, 'req_handoff_q1');
    assert.equal(done.next_queued, undefined, 'a claimed job is no longer advertised as queued');
    const got = await b.ok('get', { request_id: 'req_handoff_q1' });
    assert.equal(got.status, 'claimed', 'the handed-off job is claimed');
    assert.deepEqual(await b.queuedIds(), ['req_handoff_q2'], 'the handed-off job left the queue; the other stays queued');
    // The worker uses one claimant name for all its lanes. A rival finish by that name, which would otherwise count as an
    // exact retry of this claim, must be refused the same job: the handoff claim is keyed to the finish that made it.
    for (const extra of [{}, { acquisition_id: 'handoff-claim_rival' }]) {
      const rival = await b.rpc('claim', { request_id: 'req_handoff_q1', claimant: 'fixture-worker', ...extra });
      assert.equal(rival.isError, true, `a rival claim ${JSON.stringify(extra)} must be refused: ${JSON.stringify(rival)}`);
    }
    // The worker can finish it with the claim_id it was handed, the proof the claim is the real thing.
    const second = await b.finish(done.next_job);
    assert.equal(second.next_job?.request_id, 'req_handoff_q2');
    const last = await b.finish(second.next_job);
    assert.equal(last.queue_empty, true, JSON.stringify(last));
    pass('finish hands the oldest queued job as a normal claim; the handed claim_id finishes it; the queue drains in order');
  }

  // 2. Nothing queued: finish waits for the bound, then answers queue_empty.
  {
    const job = await b.claimNew('req_handoff_empty');
    const started = Date.now();
    const done = await b.finish(job);
    const waited = Date.now() - started;
    assert.equal(done.queue_empty, true, JSON.stringify(done));
    assert.equal(done.next_job, undefined);
    assert.ok(waited >= WAIT_MS - 100, `waited the bound, not less: ${waited} ms`);
    assert.ok(waited < WAIT_MS + 6000, `returned at the bound, not long after: ${waited} ms`);
    assert.ok(done.receipt_id, 'the report is stored whatever the wait does');
    pass(`empty queue: finish waited ${waited} ms (bound ${WAIT_MS} ms), then queue_empty`);
  }

  // 3. A job that arrives during the wait is handed out. The bound is long here: only a hand-out on arrival can beat it.
  {
    const b = await start('arrives', { finish_handoff: { wait_ms: 20000 } });
    const job = await b.claimNew('req_handoff_arrives');
    const started = Date.now();
    const pending = b.finish(job);
    await sleep(500);
    await b.submit('req_handoff_late');
    const done = await pending;
    const waited = Date.now() - started;
    assert.equal(done.next_job?.request_id, 'req_handoff_late', JSON.stringify(done));
    assert.ok(waited < 15000, `handed out on arrival, not at the bound: ${waited} ms`);
    pass(`a job submitted mid-wait is handed out after ${waited} ms (bound 20000 ms)`);
  }

  // 4. Concurrent finishes receive different jobs. (The fixture serializes requests, so the race itself is fenced by the
  // rival-claim check in scenario 1; this scenario pins the visible outcome.)
  {
    const b = await start('concurrent', { finish_handoff: { wait_ms: WAIT_MS } }, { max_claimed_outer_assignments: 4 });
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await b.claimNew(`req_handoff_c${i}`));
    for (let i = 0; i < 4; i++) await b.submit(`req_handoff_p${i}`);
    const results = await Promise.all(held.map(job => b.finish(job)));
    const handed = results.map(r => r.next_job?.request_id);
    assert.ok(handed.every(Boolean), `every finish got a job: ${JSON.stringify(handed)}`);
    assert.equal(new Set(handed).size, 3, `three different jobs: ${JSON.stringify(handed)}`);
    assert.equal(new Set(results.map(r => r.next_job.claim_id)).size, 3, 'three different claims');
    assert.equal((await b.queuedIds()).length, 1, 'the fourth stays queued');
    for (const r of results) await b.finish(r.next_job);
    await b.ok('list_pending');
    pass('three concurrent finishes over four queued jobs: three distinct jobs, one left queued');
  }

  // 5. A repeated finish returns the job it already handed out; it does not take a second one.
  {
    const b = await start('retry', { finish_handoff: { wait_ms: WAIT_MS } });
    const job = await b.claimNew('req_handoff_idem');
    for (const id of ['req_handoff_i1', 'req_handoff_i2']) await b.submit(id);
    const one = await b.finish(job);
    const two = await b.finish(job);
    assert.equal(two.duplicate, true);
    assert.equal(two.next_job?.request_id, one.next_job.request_id, 'same job on retry');
    assert.equal(two.next_job.claim_id, one.next_job.claim_id, 'same claim on retry');
    assert.equal((await b.queuedIds()).length, 1, 'the retry took no extra job');
    // Once the handed job is finished, a late retry of the first finish must not take another queued job.
    const chained = await b.finish(one.next_job);
    assert.equal(chained.next_job?.request_id, 'req_handoff_i2', 'finishing the handed job hands out the next one');
    await b.submit('req_handoff_i3');
    const late = await b.finish(job);
    assert.equal(late.next_job, undefined, `a late retry took a second job: ${JSON.stringify(late)}`);
    assert.deepEqual(await b.queuedIds(), ['req_handoff_i3'], 'the late retry took no job');
    pass('a repeated finish returns the same next_job and takes no second job, even after the first one finished');
  }

  // 6. Paused bridge: nothing is handed out, and finish does not wait, with or without queued work.
  {
    const b = await start('paused', { finish_handoff: { wait_ms: WAIT_MS } }, { max_claimed_outer_assignments: 2 });
    const [one, two] = [await b.claimNew('req_handoff_paused_1'), await b.claimNew('req_handoff_paused_2')];
    assert.equal((await b.admin('/pause', { reason: 'synthetic maintenance' }, b.operator)).status, 200);
    let started = Date.now();
    const empty = await b.finish(one);
    assert.ok(Date.now() - started < 1000, 'no wait while paused with an empty queue');
    assert.equal(empty.queue_empty, undefined);
    await b.submit('req_handoff_paused_q');
    started = Date.now();
    const queued = await b.finish(two);
    assert.equal(queued.next_job, undefined, JSON.stringify(queued));
    assert.ok(Date.now() - started < 1000, 'no wait while paused with queued work');
    assert.equal((await b.admin('/resume', {}, b.operator)).status, 200);
    assert.deepEqual(await b.queuedIds(), ['req_handoff_paused_q'], 'the queued job was not claimed');
    pass('paused: no handoff, no wait');
  }

  // 7. A client that leaves during the wait gets no claim: a job that arrives later stays queued.
  {
    const b = await start('abort', { finish_handoff: { wait_ms: WAIT_MS } });
    const job = await b.claimNew('req_handoff_abort');
    const abort = new AbortController();
    const pending = b.finish(job, {}, abort.signal).catch(error => error);
    await sleep(300);
    abort.abort();
    assert.ok((await pending) instanceof Error, 'the client call was aborted');
    await b.submit('req_handoff_after_abort');
    await sleep(WAIT_MS + 500);
    assert.ok((await b.queuedIds()).includes('req_handoff_after_abort'), 'the job that arrived after the client left is still queued');
    pass('an aborted wait claims nothing');
  }

  // 8. Opt-in: a worker without the flag gets today's hint and no claim.
  {
    const off = await start('off', {});
    const job = await off.claimNew('req_off_first');
    await off.submit('req_off_q1');
    const done = await off.finish(job);
    assert.equal(done.next_job, undefined);
    assert.equal(done.next_queued?.[0]?.request_id, 'req_off_q1', JSON.stringify(done));
    assert.match(done.guidance, /Claim req_off_q1/);
    assert.deepEqual(await off.queuedIds(), ['req_off_q1'], 'the job is still queued');
    pass('without finish_handoff the reply is the old hint and nothing is claimed');
  }
} finally {
  await Promise.all(bridges.map(b => b.stop()));
}
console.log('PASS finish-handoff');
