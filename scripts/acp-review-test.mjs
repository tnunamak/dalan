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
      if (url.pathname === '/cancel') {
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
        if (url.pathname !== '/cancel') return false;
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
  await waitFor(() => c.rawText('agent_message_chunk').includes('re-attached'), 'lock released after crash');
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
    // The cap counts only the submission's own priority: ten queued normal jobs do not refuse a capped background job,
    // and queued background jobs do not refuse a capped normal job.
    const bgArgs = id => { const x = args(id); x[6] = 'background'; return x; };
    assert.equal(store.submit(...bgArgs('review_cap_bg')).duplicate, false, 'normal rows do not fill a background cap');
    assert.throws(() => store.submit(...args('review_cap_over')), /queue is full \(10 queued/, 'normal rows still fill a normal cap');
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
  assert.equal(cap, 3, 'adapter forwards its cap to atomic admission (which counts only same-priority work)');
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
  const counts = [{ status: 'queued', count: 17 }];
  const scoped = (row) => ({ counts, by_worker: { dot: row } });
  assert.equal(bridge.bridgeRefusal(scoped({ queued_live: 12, queued_normal: 2 }), 10, 'dot'), null);
  assert.match(bridge.bridgeRefusal(scoped({ queued_live: 12, queued_normal: 10 }), 10, 'dot'), /queue is full \(10 queued/);
  assert.match(bridge.bridgeRefusal(scoped({ queued_live: 12 }), 10, 'dot'), /queue is full \(12 queued/);
  assert.match(bridge.bridgeRefusal(scoped({ queued_live: 12, queued_normal: 2 }), 10), /queue is full \(17 queued/);
  assert.equal(bridge.bridgeRefusal(scoped({ queued_live: 12, queued_normal: 0 }), 10, 'dot'), null);
});
// P5: ACP form elicitation mirrors T3's acp_titled_multiselect fixture at 3dbefda28.
cases.set(11, async () => fixture(async f => {
  let answer, answered = false;
  f.hook(async ({url, res, json, body}) => {
    if (url.pathname === '/questions') { json(res,{questions:answered?[]:[{question_id:'format',text:'Which format?',purpose:'clarification'}]}); return true; }
    if (url.pathname === '/answer') {
      answer = body; answered = true;
      const journal = JSON.parse(await readFile(join(f.home,'state','answers','review_question.answers','format.json'),'utf8'));
      assert.equal(journal.state,'prepared');
      assert.equal(body.command_key,'answer:format');
      json(res,{answered:true}); return true;
    }
    if (url.pathname === '/wait' && !answered) { await sleep(20); json(res,{status:'question'}); return true; }
    return false;
  });
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  let settled = false;
  const p = a.prompt(sid,'[dot-decision:review_question]\npriority: background\nrequires: identified_questions, shell\nAnswer a question').then(r => {settled=true;return r;});
  await waitFor(() => a.requests.length,'elicitation');
  const req = a.requests[0];
  assert.equal(req.method,'elicitation/create');
  assert.equal(req.params.mode,'form');
  assert.deepEqual(req.params.requestedSchema.required,['answer']);
  assert.match(req.params.message,/"work_id":"review_question".*"question_id":"format".*"expected_respondent":"parent_agent"/);
  assert.equal(settled,false);
  assert.match(a.rawText('agent_message_chunk'),/^Work review_question\. Admission:/);
  a.respond(req.id + 1000,{action:'accept',content:{answer:'wrong id'}});
  await sleep(50); assert.equal(answer,undefined);
  a.respond(req.id,{action:'accept',content:{answer:'JSON'}});
  await waitFor(() => answered,'answer written');
  await waitFor(async () => JSON.parse(await readFile(join(f.home,'state','answers','review_question.answers','format.json'),'utf8')).state === 'committed','receipt committed');
  assert.equal(answer.text,'JSON'); assert.equal(settled,false);
  f.finish('review_question','ANSWER RESULT');
  assert.equal((await bounded(p)).result.stopReason,'end_turn');
}));
cases.set(12, async () => fixture(async f => {
  let cancelBody;
  f.hook(async ({url, body, res, json}) => {
    if (url.pathname !== '/cancel') return false;
    cancelBody=body; json(res,{status:'cancelled',compute_stopped:false}); return true;
  });
  const a=await f.adapter(),sid=(await a.newSession(f.cwd)).sessionId;
  const p=a.prompt(sid,'[dot-decision:review_claimed]\nClaimed task');
  await waitFor(() => f.rows.has('review_claimed'),'submitted');
  f.rows.get('review_claimed').status='claimed';
  a.cancel(sid);
  assert.equal((await bounded(p)).result.stopReason,'cancelled');
  assert.equal(cancelBody.id,'review_claimed');
  assert.match(a.rawText('agent_message_chunk'),/requester_interrupted: true; worker_state: stop_requested; work_id: review_claimed/);
}));
cases.set(13, async () => fixture(async f => {
  let polls=0;
  f.hook(async ({url,res,json}) => {
    if (url.pathname !== '/wait') return false;
    await sleep(30);
    json(res,++polls===1?{status:'worker_break',notice:'usage reset',until:'2099-01-01T00:00:00Z'}:{status:'timeout'}); return true;
  });
  const a=await f.adapter({DOT_ACP_OUTAGE_MS:'50'}),sid=(await a.newSession(f.cwd)).sessionId;
  let settled=false;const p=a.prompt(sid,'[dot-decision:review_long_break]\nWait through break').then(r=>{settled=true;return r;});
  await waitFor(()=>polls>6,'wait beyond old break limit');
  assert.equal(settled,false);assert.match(a.rawText('agent_message_chunk'),/usage reset; expected end: 2099/);
  f.hook(async()=>false);f.finish('review_long_break','AFTER BREAK');
  assert.equal((await bounded(p)).result.stopReason,'end_turn');
}));
cases.set(14, async () => fixture(async f => {
  let submits=0;
  f.hook(async({url})=>{if(url.pathname==='/submit')submits++;return false;});
  const a=await f.adapter(),sid=(await a.newSession(f.cwd)).sessionId;
  a.prompt(sid,'[dot-decision:review_recovery]\nOriginal task');
  await waitFor(async()=> (await f.state(sid))?.pending?.work_id,'identity persisted');
  const original=(await f.state(sid)).pending.original_prompt_request_id;
  a.kill('SIGKILL');await a.exited;
  f.finish('review_recovery','STORED TERMINAL');
  f.rows.get('review_recovery').delivery=[{id:'terminal-1',kind:'result'}];
  const b=await f.adapter();await b.loadSession(sid,f.cwd);
  assert.equal((await bounded(b.prompt(sid,bridge.CONTINUE_PROMPT))).result.stopReason,'end_turn');
  const saved=(await f.state(sid)).completed[0];
  assert.equal(saved.original_prompt_request_id,original);assert.equal(saved.terminal_event_id,'terminal-1');
  assert.equal(saved.work_id,'review_recovery');
  assert.equal(submits,1);
  const c=await f.adapter();await c.loadSession(sid,f.cwd);
  assert.equal((await bounded(c.prompt(sid,'Retrieve review_recovery'))).result.stopReason,'end_turn');
  assert.equal(c.text('agent_message_chunk'),'STORED TERMINAL');assert.equal(submits,1);
}));
cases.set(15, async () => fixture(async f => {
  let submitted;
  f.hook(async({url,body,res,json})=>{
    if(url.pathname==='/submit')submitted=body;
    if(url.pathname==='/questions'){json(res,{questions:[{question_id:'consent',purpose:'human_decision',text:'Approve?'}]});return true;}
    if(url.pathname==='/wait'){await sleep(20);json(res,{status:'question'});return true;}
    return false;
  });
  const a=await f.adapter(),sid=(await a.newSession(f.cwd)).sessionId;
  const p=a.prompt(sid,'[dot-decision:review_human]\npriority: background\nrequires: shell, internet\nTask');
  await waitFor(()=>a.rawText('agent_message_chunk').includes('human owner'),'human message');
  assert.equal(a.requests.length,0);assert.equal(submitted.delivery,'none');
  assert.equal(submitted.background,true);assert.deepEqual(submitted.required_capabilities,['shell','internet']);
  assert.throws(()=>parsePrompt('priority: critical\nTask'),/normal or background/);
  a.cancel(sid);await bounded(p);
}));
cases.set(16, async () => fixture(async f => {
  let polls=0;
  f.hook(async({url,res,json})=>{
    if(url.pathname !== '/wait')return false;
    await sleep(20);
    json(res,++polls===1?{status:'progress',note:'Working now'}:polls===2?{status:'ack_message',text:'Read your brief'}:{status:'timeout'});return true;
  });
  const a=await f.adapter(),sid=(await a.newSession(f.cwd)).sessionId;
  let settled=false;const p=a.prompt(sid,'[dot-decision:review_progress]\nTask').then(r=>{settled=true;return r;});
  await waitFor(()=>a.rawText('agent_message_chunk').includes('Read your brief'),'progress relay');
  assert.match(a.rawText('agent_message_chunk'),/Working now/);assert.equal(settled,false);
  f.rows.get('review_progress').progress=[{note:'Stored progress',created_at:'2026-01-01T00:00:00Z'}];
  await waitFor(()=>a.rawText('agent_message_chunk').includes('Stored progress'),'stored progress relay');
  await sleep(100);
  assert.equal(a.rawText('agent_message_chunk').match(/Stored progress/g).length,1);
  f.hook(async()=>false);f.finish('review_progress','DONE');await bounded(p);
}));
cases.set(17, async () => fixture(async f => {
  const a=await f.adapter(),sid=(await a.newSession(f.cwd)).sessionId;
  const p=a.send('session/prompt',{sessionId:sid,_meta:{delegatedTaskId:'original-host-task'},prompt:[{type:'text',text:'[dot-decision:review_host_ids]\nTask'}]});
  await waitFor(async()=> (await f.state(sid))?.pending?.original_host_task_id,'host identity persisted');
  f.finish('review_host_ids','TERMINAL');await bounded(p);
  const b=await f.adapter();await b.loadSession(sid,f.cwd);
  assert.equal((await bounded(b.prompt(sid,bridge.CONTINUE_PROMPT))).result.stopReason,'end_turn');
  await bounded(b.send('session/prompt',{sessionId:sid,_meta:{delegatedTaskId:'later-host-task'},prompt:[{type:'text',text:'Read review_host_ids'}]}));
  const saved=(await f.state(sid)).completed[0];
  assert.equal(saved.original_host_task_id,'original-host-task');
  assert.deepEqual(saved.later_host_task_ids,['later-host-task']);
  assert.equal(f.rows.size,1);
}));
cases.set(18, async () => fixture(async f => {
  f.hook(async({url,res,json})=>{
    if(url.pathname!=='/cancel')return false;
    json(res,{error:'temporary outage'},503);return true;
  });
  const a=await f.adapter(),sid=(await a.newSession(f.cwd)).sessionId;
  const p=a.prompt(sid,'[dot-decision:review_cancel_outage]\nTask');
  await waitFor(async()=> (await f.state(sid))?.pending?.rid,'work saved');
  a.cancel(sid);
  assert.equal((await bounded(p)).result.stopReason,'cancelled');
  assert.match(a.rawText('agent_message_chunk'),/requester_interrupted: true; worker_state: still_running; work_id: review_cancel_outage/);
  assert.equal((await f.state(sid)).pending.rid,'review_cancel_outage');
}));
// Worker questions must never end the child turn, and an answer must reach only a live, unanswered question.
const questionFixture = (f, rid, questions, { onAnswer } = {}) => {
  const answers = [];
  f.hook(async ({ url, res, json, body }) => {
    const row = f.rows.get(rid);
    if (url.pathname === '/questions') { json(res, { questions: questions() }); return true; }
    if (url.pathname === '/answer') { answers.push(body); if (onAnswer) return onAnswer({ res, json, body }); json(res, { answered: true }); return true; }
    if (url.pathname === '/wait' && row && row.status !== 'finished') { await sleep(20); json(res, { status: 'question' }); return true; }
    return false;
  });
  return answers;
};
// Muse 1127 defect 2: the job finished while the parent deliberated; the late answer is not posted and the result arrives.
cases.set(19, async () => fixture(async f => {
  const rid = 'review_q_late';
  const answers = questionFixture(f, rid, () => f.rows.get(rid)?.status === 'finished' ? [] : [{ question_id: 'late', text: 'Which?', purpose: 'clarification' }]);
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  const p = a.prompt(sid, `[dot-decision:${rid}]\nAsk late`);
  await waitFor(() => a.requests.length, 'elicitation');
  f.finish(rid, 'LATE RESULT');
  a.respond(a.requests[0].id, { action: 'accept', content: { answer: 'too late' } });
  assert.equal((await bounded(p)).result.stopReason, 'end_turn');
  assert.equal(answers.length, 0, 'no answer is posted to a finished job');
  assert.match(a.rawText('agent_message_chunk'), /LATE RESULT/);
}));
// Muse 1127 defect 1: a refused answer (the bridge says the question is already answered) does not end the turn.
cases.set(20, async () => fixture(async f => {
  const rid = 'review_q_refused';
  let refused = false;
  questionFixture(f, rid, () => refused ? [] : [{ question_id: 'dup', text: 'Which?', purpose: 'clarification' }],
    { onAnswer: ({ res, json }) => { refused = true; json(res, { error: 'question already has an answer', code: 'ALREADY_ANSWERED' }, 409); return true; } });
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  let settled = false;
  const p = a.prompt(sid, `[dot-decision:${rid}]\nAsk refused`).then(r => { settled = true; return r; });
  await waitFor(() => a.requests.length, 'elicitation');
  a.respond(a.requests[0].id, { action: 'accept', content: { answer: 'mine' } });
  await waitFor(() => refused, 'answer refused');
  await sleep(200);
  assert.equal(settled, false, 'the child turn stays held after a refused answer');
  f.finish(rid, 'REFUSED RESULT');
  assert.equal((await bounded(p)).result.stopReason, 'end_turn');
  assert.match(a.rawText('agent_message_chunk'), /REFUSED RESULT/);
  assert.doesNotMatch(a.rawText('agent_message_chunk'), /worker adapter error/);
}));
// Muse 1127 defect 3: a second question answered while the parent deliberates on the first is not asked.
cases.set(21, async () => fixture(async f => {
  const rid = 'review_q_two';
  let firstAsked = false;
  const answers = questionFixture(f, rid, () => [
    { question_id: 'one', text: 'First?', purpose: 'clarification', ...(answers.length ? { answer: 'A', answered_at: 't' } : {}) },
    { question_id: 'two', text: 'Second?', purpose: 'clarification', ...(firstAsked ? { answer: 'other', answered_at: 't' } : {}) },
  ]);
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  const p = a.prompt(sid, `[dot-decision:${rid}]\nAsk two`);
  await waitFor(() => a.requests.length, 'first elicitation');
  firstAsked = true;
  a.respond(a.requests[0].id, { action: 'accept', content: { answer: 'A' } });
  await waitFor(() => answers.length, 'first answer');
  await sleep(300);
  assert.equal(a.requests.length, 1, 'the already answered second question is not asked');
  f.finish(rid, 'TWO RESULT');
  assert.equal((await bounded(p)).result.stopReason, 'end_turn');
}));
// Muse 1127 defect 4: after a restart, a saved but unsent answer is re-sent from the journal, not asked again.
cases.set(22, async () => fixture(async f => {
  const rid = 'review_q_saved';
  const dir = join(f.home, 'state', 'answers', `${rid}.answers`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'kept.json'), JSON.stringify({ v: 1, job: rid, question_id: 'kept', key: 'answer:kept', text: 'SAVED', expected_revision: null, state: 'prepared' }) + '\n', { mode: 0o600 });
  let done = false;
  const answers = questionFixture(f, rid, () => done ? [] : [{ question_id: 'kept', text: 'Kept?', purpose: 'clarification' }],
    { onAnswer: ({ res, json }) => { done = true; json(res, { answered: true }); return true; } });
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  const p = a.prompt(sid, `[dot-decision:${rid}]\nResume saved`);
  await waitFor(() => answers.length, 'saved answer re-sent');
  assert.equal(answers[0].text, 'SAVED');
  assert.equal(a.requests.length, 0, 'the parent is not asked again');
  f.finish(rid, 'SAVED RESULT');
  assert.equal((await bounded(p)).result.stopReason, 'end_turn');
}));
// Muse 1127 defect 5: a declined question is reported to the parent; the job keeps waiting and the turn stays held.
cases.set(23, async () => fixture(async f => {
  const rid = 'review_q_nope';
  questionFixture(f, rid, () => [{ question_id: 'nope', text: 'Which?', purpose: 'clarification' }]);
  const a = await f.adapter(), sid = (await a.newSession(f.cwd)).sessionId;
  let settled = false;
  const p = a.prompt(sid, `[dot-decision:${rid}]\nAsk declined`).then(r => { settled = true; return r; });
  await waitFor(() => a.requests.length, 'elicitation');
  a.respond(a.requests[0].id, { action: 'decline' });
  await waitFor(() => /declined/.test(a.rawText('agent_message_chunk')), 'decline reported');
  assert.match(a.rawText('agent_message_chunk'), /question nope.*still open|still open.*question nope/s);
  assert.equal(settled, false);
  f.finish(rid, 'DECLINED RESULT');
  assert.equal((await bounded(p)).result.stopReason, 'end_turn');
}));
const only = process.argv[2] ? Number(process.argv[2]) : null;
for (const [finding, test] of cases) {
  if (only && finding !== only) continue;
  await test(); console.log(`PASS ACP review finding ${finding}`);
}
