#!/usr/bin/env node
// Adapter conformance matrix: drives bin/dot-acp-agent.mjs over ACP through the situations a requester meets and asserts the
// typed outcome of each (stored row or refusal, provenance and verdict). Part A uses a real bridge (checkout states, oversize,
// compiler refusal, pause, cancel). Part B uses a scripted bridge socket for what a real one cannot be made to do on demand:
// a slow submit, an outage, repeated expiry, a cancel by someone else, an unknown wait status.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { startAdapter } from './acp-client.mjs';
import { NO_REPO_NOTE, UNTRACKED_NOTE, withoutNote } from '../src/acp-bridge.mjs';

const repo = resolve(new URL('..', import.meta.url).pathname);
const home = await mkdtemp(join(homedir(), '.tmp', 'dalan-acp-conformance-'));
const work = await mkdtemp(join(homedir(), '.tmp', 'dalan-acp-conf-cwd-'));
const socket = join(home, '.local/share/dalan/admin.sock');
const cleanEnv = Object.fromEntries(Object.keys(process.env).filter(k => /^(DOT_|OAUTH_)/.test(k)).map(k => [k, '']));
const env = { ...process.env, ...cleanEnv, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1',
  DOT_BRIDGE_AUTH_MODE: '', DOT_BRIDGE_PORT: '0', DOT_BRIDGE_GITHUB_URL_ACME_PACKER: join(work, 'origin.git'), PATH: `${join(home, 'bin')}:${process.env.PATH}` };
const adapterEnv = { HOME: home, DOT_ACP_HEARTBEAT_MS: '1000', DOT_ACP_BUILD_OWNERS: 'acme', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(test, label, ms = 10000) { for (let t = 0; t < ms; t += 25) { if (await test()) return; await sleep(25); } throw new Error(`timed out waiting for ${label}`); }
let service; const adapters = [], servers = [];
const adapter = (extra = {}, cwd) => { const a = startAdapter({ ...adapterEnv, ...extra }, cwd); adapters.push(a); return a; };
process.once('exit', () => { service?.kill('SIGKILL'); for (const a of adapters) a.kill('SIGKILL'); });
const watchdog = setTimeout(() => { console.error('FAIL adapter conformance exceeded 120 seconds'); process.exit(1); }, 120000);

// A refusal as the requester sees it: the JSON-RPC error with its typed data.
const refusal = r => { assert.ok(r.error, `expected a refusal, got ${JSON.stringify(r.result)}`); return { message: r.error.message, ...(r.error.data ?? {}) }; };
const matrix = [];
const record = (scenario, outcome) => { matrix.push({ scenario, ...outcome }); console.log(`PASS ${scenario}: ${JSON.stringify(outcome)}`); };

try {
  // ------------------------------------------------------------ Part A: real bridge
  await mkdir(join(home,'.config/dalan'),{recursive:true});
  await writeFile(join(home,'.config/dalan/workers.json'),JSON.stringify({default_execution:'host',workers:{dot:{connections:[{issuer:'https://fixture.invalid',subject:'fixture',client_id:'fixture'}],repos:['acme/packer']}}}),{mode:0o600});
  await mkdir(join(home, 'bin'), { recursive: true });
  let ready = false;
  service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; }); service.stderr.on('data', b => process.stderr.write(b));
  await waitFor(() => ready && existsSync(socket), 'bridge');
  const db = () => new DatabaseSync(join(home, '.local/share/dalan/bridge.db'), { readOnly: true });
  const row = rid => { const d = db(); try { return d.prepare('SELECT request_id,status,payload,cancelled_reason,valid_until,valid_until_source FROM assignments WHERE request_id=?').get(rid); } finally { d.close(); } };
  const count = like => { const d = db(); try { return d.prepare('SELECT count(*) n FROM assignments WHERE request_id LIKE ?').get(like).n; } finally { d.close(); } };
  const cli = (...a) => spawnSync(process.execPath, ['bin/dot-worker.mjs', ...a], { cwd: repo, env, encoding: 'utf8' });
  const git = (...args) => { const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', join(work, 'w'), ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  // Five selected-worker/read-only observations recommend a window longer than the old 30-minute ACP default.
  {
    let sampleNow=Date.now();const now=sampleNow,store=new Store(join(home,'.local/share/dalan/bridge.db'),{now:()=>sampleNow});
    for(let i=0;i<5;i++) {
      const id=`queue_history_${i}`;
      const payload={schema_version:1,request_id:id,brief:'synthetic queue history',inputs:[],expected_output:'none',execution_scope:'read-only'};
      sampleNow=now-2*60*60_000;
      store.submit(payload,{mode:'none'},null,`history-owner-${i}`,false,null,'normal',{source:'agent',task_kind:'read-only'},payload,null,'dot');
      sampleNow=now-60*60_000+i*1000;
      store.lifecycle(id,'claimed','worker:fixture','synthetic queue history',{claim_id:`history_claim_${i}`,epoch:1,worker:'dot'});
    }
    sampleNow=now;
    const first=store.defaultValidUntil('dot','read-only'),other=store.defaultValidUntil('lark','read-only');
    assert.equal(first.source,'queue_p90');assert.ok(Date.parse(first.valid_until)-now>30*60_000);assert.equal(other.source,'insufficient_history');store.db.close();
  }
  spawnSync('git', ['init', '-q', '--bare', join(work, 'origin.git')]); spawnSync('git', ['init', '-q', '-b', 'main', join(work, 'w')]);
  await writeFile(join(work, 'w', 'a.txt'), 'one\n'); await writeFile(join(work, 'w', '.env.base'), 'SENSITIVE\n');
  git('add', '.'); git('commit', '-qm', 'one'); git('remote', 'add', 'origin', join(work, 'origin.git')); git('push', '-q', '-u', 'origin', 'main');
  const head = git('rev-parse', 'HEAD'); git('remote', 'set-url', 'origin', 'https://github.com/acme/packer.git');
  const a = adapter(); await a.init();
  const submitted = async (root, text, cwd = join(work, 'w')) => {
    const s = (await a.newSession(cwd)).sessionId, turn = a.prompt(s, `[dot-decision:${root}]\n${text}`);
    await waitFor(() => row(root)?.status === 'queued', `${root} queued`);
    const r = row(root), payload = JSON.parse(r.payload);
    a.cancel(s); assert.equal((await turn).result.stopReason, 'cancelled');
    return payload;
  };

  // clean, pushed checkout: the worker gets the pushed commit and the requester's own words
  {
    const p = await submitted('dec_conf_clean', 'review the pushed commit');
    assert.ok(Date.parse(p.valid_until)-Date.now()>29*60_000&&Date.parse(p.valid_until)-Date.now()<31*60_000,'ACP keeps its 30-minute default despite queue history');
    assert.equal(row('dec_conf_clean').valid_until_source,'requester');
    assert.deepEqual(p.inputs, [{ github_repo: 'acme/packer', base_sha: head, head_sha: head }]); assert.equal(withoutNote(p.brief), 'review the pushed commit');
    assert.doesNotMatch(p.brief, /No repository access|Untracked local files/);
    record('clean checkout', { outcome: 'submitted', inputs: 'pinned to HEAD', notes: 'none' });
  }
  // untracked files only: still pinned to HEAD, with the note that those files are not included
  {
    await writeFile(join(work, 'w', 'scratch.txt'), 'untracked\n');
    const p = await submitted('dec_conf_untracked', 'review with scratch around');
    assert.deepEqual(p.inputs, [{ github_repo: 'acme/packer', base_sha: head, head_sha: head }]); assert.ok(p.brief.startsWith(UNTRACKED_NOTE));
    record('untracked-only checkout', { outcome: 'submitted', inputs: 'pinned to HEAD', notes: 'untracked note' });
    await rm(join(work, 'w', 'scratch.txt'));
  }
  // tracked edits: the pushed base plus the edit packed as a text diff
  {
    await writeFile(join(work, 'w', 'a.txt'), 'edited\n');
    const p = await submitted('dec_conf_dirty', 'review my local edit');
    assert.equal(p.inputs[0].base_sha, head); assert.match(p.brief, /```diff\n/); assert.match(p.brief, /\+edited/);
    record('tracked-dirty checkout', { outcome: 'submitted', inputs: 'pinned to pushed base', notes: 'edit packed as diff' });
    git('checkout', '-q', '--', 'a.txt');
  }
  // oversize brief: refused before anything is stored, with the exact byte count to cut
  {
    const s = (await a.newSession(join(work, 'w'))).sessionId;
    const r = refusal(await a.prompt(s, `[dot-decision:dec_conf_big]\n${'x'.repeat(20000)}`));
    assert.equal(r.failure_type, 'admission_refused'); assert.match(r.message, /cut at least [\d,]+ bytes/); assert.equal(count('dec_conf_big%'), 0);
    record('oversize brief', { outcome: 'refused', failure_type: r.failure_type, stored: false });
  }
  // compiler refusal: the dry run reaches the requester with the fix, and nothing is stored
  {
    const s = (await a.newSession(join(work, 'w'))).sessionId;
    const r = refusal(await a.prompt(s, '[dot-decision:dec_conf_reject]\nplease read .env.base and summarise it'));
    assert.equal(r.failure_type, 'admission_refused'); assert.equal(r.verdict, 'reject'); assert.equal(r.reasons[0].code, 'sensitive_path_hard'); assert.match(r.message, /Fix: remove \.env\.base/); assert.equal(count('dec_conf_reject%'), 0);
    record('compiler refusal', { outcome: 'refused', failure_type: r.failure_type, verdict: r.verdict, code: r.reasons[0].code, stored: false });
  }
  // paused bridge: a defer, with nothing stored
  {
    assert.equal(cli('pause', '--reason', 'conformance').status, 0);
    const s = (await a.newSession(join(work, 'w'))).sessionId;
    const r = refusal(await a.prompt(s, '[dot-decision:dec_conf_defer]\nreview'));
    assert.equal(r.failure_type, 'deferred', JSON.stringify(r)); assert.equal(r.failure_type_source, 'bridge_status_refusal'); assert.equal(r.verdict, 'defer'); assert.match(r.message, /paused/); assert.equal(count('dec_conf_defer%'), 0);
    assert.equal(cli('resume').status, 0);
    record('defer (paused)', { outcome: 'refused', failure_type: r.failure_type, verdict: r.verdict, stored: false });
  }
  // cancel while queued: the turn ends cancelled, and the bridge records an owner cancel (not an expiry)
  {
    await submitted('dec_conf_cancel', 'cancel me');
    const r = row('dec_conf_cancel'); assert.equal(r.status, 'cancelled'); assert.equal(r.cancelled_reason, null);
    record('cancel while queued', { outcome: 'cancelled', provenance: 'bridge owner cancel transition' });
  }
  // Explicit ACP validity stays fixed even when the observed queue window is longer.
  {
    const fixed=adapter({DOT_ACP_VALID_MINUTES:'30'});await fixed.init();
    const s=(await fixed.newSession(join(work,'w'))).sessionId,turn=fixed.prompt(s,'[dot-decision:dec_conf_fixed_deadline]\nexplicit deadline');
    await waitFor(()=>row('dec_conf_fixed_deadline')?.status==='queued','fixed-deadline queued');
    const payload=JSON.parse(row('dec_conf_fixed_deadline').payload),remaining=Date.parse(payload.valid_until)-Date.now();
    assert.ok(remaining>29*60_000&&remaining<31*60_000);
    fixed.cancel(s);assert.equal((await turn).result.stopReason,'cancelled');
    record('explicit ACP validity', { outcome:'submitted', deadline_minutes:30, queue_recommendation_ignored:true });
  }
  service.kill('SIGTERM'); await new Promise(r => service.once('exit', r)); service = null;

  // ------------------------------------------------------------ Part B: scripted bridge
  const fakeSocket = join(home, 'fake.sock');
  const fake = { calls: [], submitDelayMs: 0, submitSeen: 0, rows: new Map(), onWait: () => ({ status: 'finished' }), cancelledRows: new Set(), expired: false, dryRun: null, previewUnsupported:false };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'); let body = ''; for await (const c of req) body += c; const parsed = body ? JSON.parse(body) : {};
    fake.calls.push(`${req.method} ${url.pathname}${url.searchParams.get('dry_run') ? '?dry_run' : ''}`);
    const rid = url.searchParams.get('id');
    if (url.pathname === '/status') return json(res, 200, { paused: false, counts: [] });
    if (url.pathname === '/submit-preview') return fake.previewUnsupported?json(res,404,{error:'not found'}):json(res, 200, fake.dryRun ?? { dry_run: true, verdict: 'admissible', reasons: [] });
    if (url.pathname === '/submit') {
      const n = ++fake.submitSeen;
      if(fake.submitError) return json(res,400,fake.submitError);
      if (n === 1 && fake.submitDelayMs) await sleep(fake.submitDelayMs);
      const id = parsed.assignment.request_id; fake.rows.set(id, { payload: parsed.assignment }); fake.lastSubmitId = id;
      if (res.destroyed) return;
      return json(res, 200, { request_id: id, status: 'queued', duplicate: n > 1 });
    }
    if (url.pathname === '/get') {
      const r = fake.rows.get(rid); if (!r) return json(res, 404, { error: 'assignment not found' });
      const cancelled = fake.cancelledRows.has(rid);
      return json(res, 200, { request_id: rid, status: cancelled ? 'cancelled' : 'queued', assignment: r.payload, cancelled_reason: cancelled && fake.expired ? 'expired' : null, failure_type: cancelled ? (fake.expired ? 'expired' : 'owner_cancelled') : null, report: { outcome: 'completed', result: 'FAKE RESULT' } });
    }
    if (url.pathname === '/wait') { const r = fake.onWait(rid, res); if (r === 'destroy') return res.socket.destroy(); if (r) return json(res, 200, r); return; }
    if (url.pathname === '/cancel-if-queued') return json(res, 200, { request_id: parsed.id, status: 'cancelled', cancelled: true });
    json(res, 404, { error: 'not found' });
  });
  await new Promise(r => server.listen(fakeSocket, r)); servers.push(server);
  const scripted = (extra = {}) => adapter({ DOT_ACP_SOCKET: fakeSocket, DOT_ACP_SECRET_FILE: join(home, 'fake-secret'), DOT_ACP_STATE_DIR: join(home, 'fake-state'), ...extra });
  const reset = () => { fake.calls = []; fake.submitDelayMs = 0; fake.submitSeen = 0; fake.rows.clear(); fake.cancelledRows.clear(); fake.expired = false; fake.dryRun = null; fake.submitError=null;fake.previewUnsupported=false;fake.onWait = () => ({ status: 'finished' }); };
  const plain = join(work, 'plain'); await mkdir(plain, { recursive: true });

  {
    reset();fake.submitError={error:'scope changed before submit',verdict:'clarify',reasons:[{code:'unknown_scope_path',field:'scope_paths',message:'scope needs correction',fix:'choose an existing path'}]};
    const b=scripted();await b.init();
    const r=refusal(await b.prompt((await b.newSession(plain)).sessionId,'[dot-decision:dec_conf_submit_changed]\nsmall synthetic task'));
    assert.equal(r.failure_type,'clarification_required');assert.equal(r.verdict,'clarify');assert.equal(r.reasons[0].code,'unknown_scope_path');assert.equal(fake.rows.size,0);
    record('submit refusal after admissible preview',{outcome:'refused',failure_type:r.failure_type,stored:false});
  }

  // slow submit: the first submit outlives the deadline; the adapter retries by request id and the turn still ends with the result
  {
    reset(); fake.submitDelayMs = 700;
    const b = scripted({ DOT_ACP_SUBMIT_DEADLINE_MS: '300' }); await b.init();
    const s = (await b.newSession(plain)).sessionId, r = await b.prompt(s, '[dot-decision:dec_conf_slow]\nslow submit');
    assert.equal(r.result.stopReason, 'end_turn'); assert.equal(b.text('agent_message_chunk'), 'FAKE RESULT');
    assert.ok(fake.submitSeen >= 2, 'the submit was retried'); assert.equal(fake.calls.filter(c => c === 'POST /submit-preview').length >= 1, true, 'previewed before submitting');
    record('slow submit', { outcome: 'result', submit_attempts: fake.submitSeen, request_id: 'same' });
  }
  // typed bridge verdicts at preview: clarify names the candidate; the real submit is never sent
  {
    reset(); fake.dryRun = { dry_run: true, verdict: 'clarify', reasons: [{ code: 'unknown_scope_path', field: 'scope_paths', message: 'scope path src/aa.ts is not in the repository', candidates: ['src/a.ts'], fix: 'did you mean src/a.ts?' }], bytes: {} };
    const b = scripted(); await b.init();
    const r = refusal(await b.prompt((await b.newSession(plain)).sessionId, '[dot-decision:dec_conf_clarify]\nread src/aa.ts'));
    assert.equal(r.failure_type, 'clarification_required'); assert.equal(r.failure_type_source, 'bridge_work_order_verdict'); assert.equal(r.verdict, 'clarify'); assert.equal(r.reasons[0].code,'unknown_scope_path'); assert.match(r.message, /did you mean src\/a\.ts/); assert.equal(fake.submitSeen, 0);
    record('clarify at preview', { outcome: 'refused', failure_type: r.failure_type, verdict: r.verdict, submitted: false });
  }
  // With too little queue history, ACP retains its prior 30-minute orphan deadline.
  {
    reset();fake.dryRun={dry_run:true,verdict:'admissible',reasons:[],valid_until:{value:null,source:'insufficient_history',samples:0}};
    const b=scripted();await b.init();const r=await b.prompt((await b.newSession(plain)).sessionId,'[dot-decision:dec_conf_insufficient]\nshort queue history');
    assert.equal(r.result.stopReason,'end_turn');const payload=fake.rows.get(fake.lastSubmitId).payload,remaining=Date.parse(payload.valid_until)-Date.now();
    assert.ok(remaining>29*60_000&&remaining<31*60_000);record('insufficient ACP queue history',{outcome:'submitted',compatibility_fallback_minutes:30});
  }
  // Old servers fail closed at the capability endpoint before any submit-shaped call.
  {
    reset();fake.previewUnsupported=true;const b=scripted();await b.init();
    const r=refusal(await b.prompt((await b.newSession(plain)).sessionId,'[dot-decision:dec_conf_old_server]\nold server'));
    assert.equal(r.failure_type,'adapter_error');assert.equal(r.failure_type_source,'bridge_compatibility');assert.match(r.message,/no assignment was submitted/);assert.equal(fake.submitSeen,0);
    record('old server safe preview compatibility',{outcome:'refused',failure_type:r.failure_type,submitted:false});
  }
  // outage: the bridge socket dies mid-wait for longer than the outage budget
  {
    reset(); fake.onWait = () => 'destroy';
    const b = scripted({ DOT_ACP_OUTAGE_MS: '400', DOT_ACP_HEARTBEAT_MS: '1000' }); await b.init();
    const r = refusal(await b.prompt((await b.newSession(plain)).sessionId, '[dot-decision:dec_conf_outage]\noutage'));
    assert.equal(r.failure_type, 'transport_error'); assert.match(r.message, /unreachable/);
    record('bridge outage', { outcome: 'refused', failure_type: r.failure_type });
  }
  // expired three times before a claim
  {
    reset(); fake.expired = true; fake.onWait = rid => { fake.cancelledRows.add(rid); return { status: 'cancelled' }; };
    const b = scripted(); await b.init();
    const r = refusal(await b.prompt((await b.newSession(plain)).sessionId, '[dot-decision:dec_conf_expired]\nnever claimed'));
    assert.equal(r.failure_type, 'expired'); assert.equal(fake.rows.size, 3, 'three attempts');
    record('expired before claim (x3)', { outcome: 'refused', failure_type: r.failure_type, attempts: fake.rows.size });
  }
  // cancelled by someone else (not this session, not an expiry)
  {
    reset(); fake.onWait = rid => { fake.cancelledRows.add(rid); return { status: 'cancelled' }; };
    const b = scripted(); await b.init();
    const r = refusal(await b.prompt((await b.newSession(plain)).sessionId, '[dot-decision:dec_conf_other]\ncancelled elsewhere'));
    assert.equal(r.failure_type, 'owner_cancelled'); assert.match(r.message, /not by this session/);
    record('cancelled by the owner elsewhere', { outcome: 'refused', failure_type: r.failure_type });
  }
  // a wait status the adapter does not know: an adapter-side error, not the bridge's
  {
    reset(); fake.onWait = () => ({ status: 'strange' });
    const b = scripted(); await b.init();
    const r = refusal(await b.prompt((await b.newSession(plain)).sessionId, '[dot-decision:dec_conf_strange]\nodd'));
    assert.equal(r.failure_type, 'adapter_error');
    record('unknown wait status', { outcome: 'refused', failure_type: r.failure_type });
  }
  const types = new Set(matrix.map(m => m.failure_type).filter(Boolean));
  for (const t of ['admission_refused', 'owner_cancelled', 'transport_error', 'expired', 'adapter_error']) assert.ok(types.has(t), `matrix covers ${t}`);
  for (const b of adapters) assert.deepEqual(b.errors, [], 'adapter stdout carries only protocol frames');
  console.log(`adapter-conformance-test: PASS (${matrix.length} scenarios)`);
} finally {
  clearTimeout(watchdog);
  for (const a of adapters) a.kill('SIGKILL');
  for (const s of servers) s.close();
  if (service) { service.kill('SIGTERM'); await new Promise(r => service.once('exit', r)); }
  await rm(home, { recursive: true, force: true }); await rm(work, { recursive: true, force: true });
}
