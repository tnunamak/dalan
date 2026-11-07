#!/usr/bin/env node
// Deterministic review reproductions: isolated adapters and a controllable admin socket, never the live service.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdapter } from './acp-client.mjs';
import { runtimeBlock, envelope } from './acp-t3-fixtures.mjs';
import { Store } from '../src/store.mjs';
import { competingWrites } from './store-competing-writers.mjs';
import * as bridge from '../src/acp-bridge.mjs';
const { promptText, parsePrompt, adminRequest, repoInputs, NO_REPO_NOTE } = bridge;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function waitFor(test, label, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await sleep(10); }
  throw new Error(`timed out: ${label}`);
}
async function bounded(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('request did not return in time')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(test) {
  const home = await mkdtemp(join(tmpdir(), 'dalan-acp-review-'));
  const socket = join(home, 'admin.sock'), stateDir = join(home, 'state'), cwd = join(home, 'plain');
  await mkdir(cwd);
  const rows = new Map(), adapters = [], sockets = new Set();
  let hook = async () => false;
  const json = (res, value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let bytes = ''; for await (const b of req) bytes += b;
      const body = bytes ? JSON.parse(bytes) : {}, rid = url.searchParams.get('id') ?? body.id ?? body.assignment?.request_id;
      if (await hook({ req, res, url, body, rid, json })) return;
      const row = rows.get(rid);
      if (url.pathname === '/get') return row ? json(res, row) : json(res, { error: 'assignment not found' }, 400);
      if (url.pathname === '/status') return json(res, { counts: [], throttle: {} });
      if (url.pathname === '/submit-preview') return json(res, { dry_run: true, stored: false, verdict: 'admissible', reasons: [] });
      if (url.pathname === '/submit') { rows.set(rid, { assignment: body.assignment, status: 'queued' }); return json(res, { status: 'queued' }); }
      if (url.pathname === '/cancel-if-queued') {
        if (row?.status === 'queued') row.status = 'cancelled';
        return json(res, { status: row?.status, cancelled: row?.status === 'cancelled' });
      }
      if (url.pathname === '/owner-states') return json(res, { states: body.items.map(i => ({ status: rows.get(i.id)?.status })) });
      if (url.pathname === '/wait') { await sleep(20); return json(res, { status: row?.status === 'queued' ? 'timeout' : row?.status }); }
      json(res, { error: 'unknown route' }, 400);
    } catch (e) { if (!res.destroyed) json(res, { error: e.message }, 500); }
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(socket, r));
  const adapter = async (extra = {}) => {
    const a = startAdapter({ HOME: home, DOT_ACP_SOCKET: socket, DOT_ACP_SECRET_FILE: join(home, 'secret'), DOT_ACP_STATE_DIR: stateDir, DOT_ACP_HEARTBEAT_MS: '50', DOT_ACP_CANCEL_BUDGET_MS: '50', ...extra });
    adapters.push(a); await a.init(); return a;
  };
  const state = async id => { try { return JSON.parse(await readFile(join(stateDir, `${id}.json`), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const finish = (rid, text) => { const row = rows.get(rid); row.status = 'finished'; row.report = { outcome: 'completed', result: text }; };
  try { await test({ home, socket, cwd, rows, adapter, state, finish, hook: fn => { hook = fn; } }); }
  finally {
    for (const a of adapters) a.kill('SIGKILL');
    await Promise.all(adapters.map(a => a.exited));
    for (const s of sockets) s.destroy();
    await new Promise(r => server.close(r));
    await rm(home, { recursive: true, force: true });
  }
}
const cases = new Map();
cases.set(1, async () => fixture(async f => {
  const held = deferred(), entered = deferred(); let first = true;
  f.hook(async ({ url, rid }) => {
    if (url.pathname === '/get' && rid === 'review_turn_a' && first) { first = false; entered.resolve(); await held.promise; }
    return false;
  });
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  const pa = a.prompt(sid, '[dot-decision:review_turn_a]\nold brief');
  await entered.promise; a.cancel(sid);
  assert.equal((await bounded(pa)).result?.stopReason, 'cancelled');
  const pb = a.prompt(sid, '[dot-decision:review_turn_b]\nnew brief');
  await waitFor(async () => (await f.state(sid))?.pending?.rid === 'review_turn_b', 'B persisted');
  held.resolve();
  await waitFor(() => f.rows.get('review_turn_a')?.status === 'cancelled', 'late A cancelled');
  assert.equal((await f.state(sid))?.pending?.rid, 'review_turn_b', 'stale A must not clear B');
  f.finish('review_turn_b', 'B RESULT');
  assert.equal((await bounded(pb)).result?.stopReason, 'end_turn');
  assert.equal(a.text('agent_message_chunk'), 'B RESULT');
}));
cases.set(2, async () => fixture(async f => {
  const shim = join(f.home, 'slowgit'), marker = join(f.home, 'git-started');
  await mkdir(shim);
  await writeFile(join(shim, 'git'), '#!/bin/sh\nprintf started > "$GIT_STARTED"\nsleep 12\nexit 1\n', { mode: 0o755 });
  const a = await f.adapter({ PATH: `${shim}:${process.env.PATH}`, GIT_STARTED: marker, DOT_ACP_CANCEL_BUDGET_MS: '5000' });
  const sid = (await a.newSession(f.cwd)).sessionId;
  const prompt = a.prompt(sid, '[dot-decision:review_slow_git]\nslow git acquisition');
  await waitFor(async () => { try { await readFile(marker); return true; } catch { return false; } }, 'git started');
  const start = Date.now(); a.cancel(sid);
  assert.equal((await bounded(prompt, 10000)).result?.stopReason, 'cancelled');
  assert.ok(Date.now() - start < 10000, 'cancel response must arrive before slow git returns');
  await waitFor(() => f.rows.get('review_slow_git')?.status === 'cancelled', 'late job cancelled', 15000);
}));
cases.set(3, async () => fixture(async f => {
  const user = '[dot-decision:review_tags_root]\nExplain <runtime_info> and this example:\n<user_request>\n[dot-decision:other_root]\nexample\n</user_request>\nKeep the surrounding text.';
  const block = text => ({ type: 'text', text });
  assert.equal(bridge.unwrapUserRequest(user), user, 'embedded tags cannot truncate bare user text');
  assert.equal(promptText([block(user)]), user);
  assert.equal(promptText([block(user), block(runtimeBlock)]), user);
  assert.equal(promptText([block(envelope(user)), block(runtimeBlock)]), user);
  assert.equal(promptText([block(user), block('<runtime_info>x</runtime_info>')]), `${user}\n<runtime_info>x</runtime_info>`);
  assert.equal(promptText([block(runtimeBlock)]), runtimeBlock, 'one user block is never discarded');
  assert.equal(parsePrompt(promptText([block(user)])).requestRoot, 'review_tags_root');
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  const p = a.promptBlocks(sid, [block(envelope(user)), block(runtimeBlock)]);
  await waitFor(() => f.rows.has('review_tags_root'), 'outer root queued');
  assert.equal(f.rows.get('review_tags_root').assignment.brief, parsePrompt(user).brief);
  assert.ok(!f.rows.has('other_root'));
  f.finish('review_tags_root', 'TAGS RESULT');
  assert.equal((await bounded(p)).result?.stopReason, 'end_turn');
  const followup = user.replaceAll('review_tags_root', 'review_tags_followup');
  const next = a.promptBlocks(sid, [block(followup), block(runtimeBlock)]);
  await waitFor(() => f.rows.has('review_tags_followup'), 'unwrapped follow-up submitted');
  assert.equal(f.rows.get('review_tags_followup').assignment.brief, parsePrompt(followup).brief);
  f.finish('review_tags_followup', 'FOLLOW-UP RESULT');
  assert.equal((await bounded(next)).result?.stopReason, 'end_turn');
}));
cases.set(4, async () => {
  for (const steer of [false, true]) await fixture(async f => {
    const root = steer ? 'review_expired_steer' : 'review_expired_restore';
    const brief = 'the original assignment', a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
    const original = a.prompt(sid, `[dot-decision:${root}]\n${brief}`);
    await waitFor(async () => (await f.state(sid))?.pending?.rid === root, 'original saved');
    let b;
    if (steer) {
      // A failed cancel leaves queued recovery state in the same process; expiry can precede the steer.
      f.hook(async ({ url, res, json }) => {
        if (url.pathname !== '/cancel-if-queued') return false;
        json(res, { error: 'temporary outage' }, 503); return true;
      });
      a.cancel(sid); assert.equal((await bounded(original)).result?.stopReason, 'cancelled');
      f.hook(async () => false); b = a;
    } else {
      a.kill('SIGKILL'); await a.exited;
      b = await f.adapter(); await b.loadSession(sid, f.cwd);
    }
    // State files have only the hash; the owner read must supply the original brief without its repository note.
    f.rows.get(root).assignment.brief = `${NO_REPO_NOTE}\n\n${brief}`;
    f.rows.get(root).status = 'cancelled'; f.rows.get(root).cancelled_reason = 'expired';
    const text = steer ? 'also check the follow-up' : 'Continue where you left off.';
    const p = b.prompt(sid, text);
    await waitFor(() => f.rows.has(`${root}_r2`), 'retry of original root');
    assert.equal(f.rows.get(`${root}_r2`).assignment.brief, brief);
    f.finish(`${root}_r2`, 'RETRIED RESULT');
    assert.equal((await bounded(p)).result?.stopReason, 'end_turn');
    assert.equal(b.text('agent_message_chunk'), steer ? `RETRIED RESULT\n\nnot sent to the worker: ${text}` : 'RETRIED RESULT');
  });
});
cases.set(5, async () => fixture(async f => {
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId, root = 'review_process_old';
  const pa = a.prompt(sid, `[dot-decision:${root}]\nold job`);
  await waitFor(async () => (await f.state(sid))?.pending?.rid === root, 'old job saved');
  const b = await f.adapter(); await b.loadSession(sid, f.cwd);
  const held = deferred(), entered = deferred(); let first = true;
  f.hook(async ({ url, rid }) => {
    if (url.pathname === '/get' && rid === root && f.rows.get(root).status === 'finished' && first) { first = false; entered.resolve(); await held.promise; }
    return false;
  });
  f.finish(root, 'OLD RESULT'); await entered.promise;
  const competing = await bounded(b.prompt(sid, 'Continue where you left off.'));
  assert.equal(competing.error?.code, -32000, 'a second process cannot own an active session');
  assert.match(competing.error.message, /session.*another adapter/);
  assert.equal((await f.state(sid)).pending.rid, root);
  held.resolve(); assert.equal((await bounded(pa)).result?.stopReason, 'end_turn');
  // B loaded stale state before A finished. On obtaining ownership it must read the latest state.
  const pb = b.prompt(sid, '[dot-decision:review_process_new]\nnew job');
  await waitFor(async () => (await f.state(sid))?.pending?.rid === 'review_process_new', 'new process state survives');
  f.finish('review_process_new', 'NEW RESULT');
  assert.equal((await bounded(pb)).result?.stopReason, 'end_turn');
  assert.equal(b.text('agent_message_chunk'), 'NEW RESULT');
  // A killed owner must leave a lock that the next adapter takes over and leave the saved assignment recoverable.
  const pc = b.prompt(sid, '[dot-decision:review_process_crash]\nsurvive owner crash');
  await waitFor(async () => (await f.state(sid))?.pending?.rid === 'review_process_crash', 'crash job saved');
  b.kill('SIGKILL'); await b.exited; await pc;
  const c = await f.adapter(); await c.loadSession(sid, f.cwd);
  const pd = c.prompt(sid, 'Continue where you left off.');
  await waitFor(() => c.text('agent_thought_chunk').includes('re-attached'), 'lock released after crash');
  f.finish('review_process_crash', 'CRASH RESULT');
  assert.equal((await bounded(pd)).result?.stopReason, 'end_turn');
  const earlySid = (await c.newSession(f.cwd)).sessionId;
  const early = c.prompt(earlySid, '[dot-decision:review_cancel_lock]\nstop before ownership');
  c.cancel(earlySid);
  assert.equal((await bounded(early, 2000)).result?.stopReason, 'cancelled');
  // The portable lock is taken in microseconds (the flock helper took a process spawn), so the cancel can arrive after the submit
  // started. Either nothing was submitted, or the row it created was cancelled: no live job may remain.
  assert.ok(!f.rows.has('review_cancel_lock') || f.rows.get('review_cancel_lock').status === 'cancelled', 'cancel around lock acquisition leaves no live job');
}));
cases.set(6, async () => fixture(async f => {
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  const p = a.prompt(sid, '[dot-decision:review_external_cancel]\nfirst job');
  await waitFor(async () => (await f.state(sid))?.pending?.rid === 'review_external_cancel', 'first job persisted');
  f.rows.get('review_external_cancel').status = 'cancelled';
  const terminal = await bounded(p);
  assert.equal(terminal.error?.code, -32000); assert.match(terminal.error.message, /was cancelled/);
  assert.equal(await f.state(sid), null, 'terminal cancellation removes matching pending state');
  const next = a.prompt(sid, '[dot-decision:review_after_cancel]\nsecond job');
  await waitFor(() => f.rows.has('review_after_cancel'), 'new root admitted');
  f.finish('review_after_cancel', 'NEXT RESULT');
  assert.equal((await bounded(next)).result?.stopReason, 'end_turn');
}));
cases.set(7, async () => fixture(async f => {
  const file = join(f.home, 'admission.db'), store = new Store(file);
  const payload = id => ({ schema_version: 1, request_id: id, brief: 'admission race', inputs: [], expected_output: 'test', execution_scope: 'read-only' });
  const args = id => [payload(id), { mode: 'none' }, '', 'owner', false, null, 'normal', { source: 'agent' }, payload(id), 10];
  try {
    const operations = Array.from({ length: 20 }, (_, i) => ({ method: 'submit', args: args(`review_cap_${i}`) }));
    operations[0].holdMs = 100;
    const results = await competingWrites(file, operations, { firstHoldsLock: true, busyTimeoutMs: 30000 });
    assert.equal(results.filter(r => r.result?.status === 'queued').length, 10, 'exactly ten competing submissions admitted');
    assert.equal(results.filter(r => /queue is full/.test(r.error)).length, 10);
    assert.equal(store.db.prepare("SELECT count(*) n FROM assignments WHERE status='queued'").get().n, 10);
    const existing = store.db.prepare('SELECT request_id FROM assignments LIMIT 1').get().request_id;
    const attaches = await competingWrites(file, Array.from({ length: 4 }, () => ({ method: 'submit', args: args(existing) })), { busyTimeoutMs: 30000 });
    assert.ok(attaches.every(r => r.result?.duplicate), 'duplicates attach at capacity');
    store.submit(payload('review_uncapped'), { mode: 'none' }, '', 'owner'); // existing callers keep their uncapped behavior
    const expired = store.db.prepare('SELECT request_id FROM assignments LIMIT 2').all();
    for (const row of expired) store.db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?').run('2000-01-01T00:00:00.000Z', row.request_id);
    assert.equal(store.submit(...args('review_live_only')).duplicate, false, 'expired rows do not consume admission');
    assert.throws(() => store.submit(...args('review_bad_cap').slice(0, -1), 0), /invalid max_queued/);
  } finally { store.db.close(); }
  let cap;
  f.hook(async ({ url, body }) => { if (url.pathname === '/submit') cap = body.max_queued; return false; });
  const a = await f.adapter({ DOT_ACP_INFLIGHT_CAP: '3' }), sid = (await a.newSession(f.cwd)).sessionId;
  const p = a.prompt(sid, '[dot-decision:review_cap_forward]\nforward the cap');
  await waitFor(() => f.rows.has('review_cap_forward'), 'adapter submission');
  assert.equal(cap, 3, 'adapter forwards its cap to atomic admission');
  a.cancel(sid); await bounded(p);
}));
cases.set(8, async () => fixture(async f => {
  // These requests connect successfully but receive no headers/body. Each route has an absolute deadline.
  f.hook(async () => true);
  for (const route of ['/status', '/get?id=missing', '/submit', '/owner-states', '/wait?id=missing&timeout=1']) {
    await assert.rejects(bounded(adminRequest(f.socket, route, { timeoutMs: 50 }), 500), e => e.kind === 'transport' && /deadline/.test(e.message));
  }
  let waits = 0;
  f.hook(async ({ url }) => { if (url.pathname === '/wait') { waits++; return true; } return false; });
  const a = await f.adapter({ DOT_ACP_OUTAGE_MS: '100', DOT_ACP_HTTP_TIMEOUT_MS: '50', DOT_ACP_HTTP_GRACE_MS: '50' });
  const sid = (await a.newSession(f.cwd)).sessionId;
  const start = Date.now(), p = a.prompt(sid, '[dot-decision:review_stalled_wait]\nbridge accepts but never responds');
  const result = await bounded(p, 4000);
  assert.equal(result.error?.code, -32000); assert.match(result.error.message, /bridge unreachable/);
  assert.ok(waits >= 2, 'deadline feeds the existing outage retry loop');
  assert.ok(Date.now() - start >= 1000, 'long poll gets its requested interval before timing out');
  assert.equal((await f.state(sid))?.pending.rid, 'review_stalled_wait', 'outage retains recovery state');
}));
cases.set(9, async () => fixture(async f => {
  const git = (...args) => {
    const r = spawnSync('git', ['-C', f.cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  await writeFile(join(f.cwd, 'a.txt'), 'one'); git('add', '.'); git('commit', '-qm', 'one');
  const head = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', 'https://github.com/example/selected.git');
  git('update-ref', 'refs/remotes/upstream/main', head);
  assert.deepEqual(await repoInputs(f.cwd), { inputs: [], note: NO_REPO_NOTE }, 'upstream cannot prove origin contains HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/upstream/main');
  assert.deepEqual(await repoInputs(f.cwd), { inputs: [], note: NO_REPO_NOTE }, 'symbolic remote HEAD is not an origin branch');
  git('update-ref', 'refs/remotes/origin/main', head);
  assert.deepEqual((await repoInputs(f.cwd)).inputs, [{ github_repo: 'example/selected', base_sha: head, head_sha: head }]);
}));
// bridgeRefusal holds only on evidence: a pause or an owner-confirmed break. An inferred break and reached usage estimates hold nothing.
cases.set(10, async () => {
  const brk = source => ({ active: true, since: '2026-10-11T00:00:00.000Z', source });
  assert.equal(bridge.bridgeRefusal({ counts: [] }, 5), null);
  assert.equal(bridge.bridgeRefusal({ counts: [], worker_break: brk('owner') }, 5), 'worker_break active since 2026-10-11T00:00:00.000Z');
  assert.equal(bridge.bridgeRefusal({ counts: [], worker_break: brk('inferred') }, 5), null, 'an inferred break refused work');
  assert.equal(bridge.bridgeRefusal({ counts: [], worker_break: { active: false, source: 'owner' } }, 5), null);
  assert.equal(bridge.bridgeRefusal({ counts: [], paused: true, pause_reason: 'ops' }, 5), 'worker paused: ops');
  // reached estimates (and the legacy flags an older bridge sent) do not refuse
  assert.equal(bridge.bridgeRefusal({ counts: [], throttle: { over_estimate: ['tool_calls_per_24h'], normal_rewake_throttled: false, rewake_throttled: false, holding: { rewake: [], submit: [] } } }, 5), null, 'a reached estimate refused work');
  assert.match(bridge.bridgeRefusal({ counts: [{ status: 'queued', count: 5 }], worker_break: brk('inferred') }, 5), /queue is full/);
});
const only = process.argv[2] ? Number(process.argv[2]) : null;
for (const [finding, test] of cases) {
  if (only && finding !== only) continue;
  await test(); console.log(`PASS ACP review finding ${finding}`);
}
