// dot-bridge adapter for the Job Protocol Fixture Profile v0 runner.
//
// Level reached: persistence-restart. Every command is a REAL bridge operation against a REAL server process
// (src/server.mjs) and a REAL SQLite store in an isolated temp HOME per trace:
//   owner  -> private admin socket, including durable protocol waiter routes, per-job owner capability
//   W1/W2  -> opted-in protocol MCP tools with distinct OAuth subjects (fake local issuer)
//   service-> native scheduler tick or private dispatcher/observer capability
// Clock: a frozen test clock is injected with `node --import clock-preload.mjs`; no product code is changed.
// restart = SIGKILL the server and start a new process on the same HOME/DB.
//
// Nothing is synthesized from the fixture. The adapter only (a) translates fixture arguments to bridge arguments,
// (b) projects the bridge's native replies and its own lifecycle_events journal into the fixture envelope, and
// (c) normalizes IDs bijectively (job->request_id, claim->C<n>, receipt->R:<job>:<n>, artifact->art_ alias).
// Receiver/executor outcomes are inert trusted dependencies; command replies,
// authorization, state and events always come from the real native service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { FIXTURE_PROFILE_VERSION } from './profile-version.mjs';
import { DatabaseSync } from 'node:sqlite';
import {protocolServiceCapability} from '../../src/protocol-services.mjs';
import {createInertProtocolFixtures} from '../../src/test-support/protocol-service-fixtures.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PRELOAD = path.join(path.dirname(new URL(import.meta.url).pathname), 'clock-preload.mjs');
const AUDIENCE = 'https://dot-bridge.example.test';
const LEASE_MS = 60000; // owner-configured maximum; each grant uses the requested native duration
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = b => createHash('sha256').update(b).digest('hex');
const SOURCE = 'urn:fixture:job-store';

export const OWNER_OPS = new Set(['submit', 'answer', 'cancel', 'get', 'wait', 'inbox', 'ack']);
export const WORKER_OPS = new Set(['claim', 'renew', 'progress', 'ask', 'consume', 'upload', 'seal', 'finish']);
export const SERVICE_OPS = new Set(['expire', 'dispatch', 'delivery_result', 'reconcile', 'observe_stop']);

// Native error text -> closed fixture code. Anything not listed becomes NATIVE:<text> and can never match.
export const ERROR_MAP = [
  [/^NO_QUESTION:/, 'NO_QUESTION'],
  [/^NO_ANSWER:/, 'NO_ANSWER'],
  [/^ALREADY_ANSWERED:/, 'ALREADY_ANSWERED'],
  [/^QUESTION_OPEN:/, 'QUESTION_OPEN'],
  [/^STALE_EPOCH:/, 'STALE_EPOCH'],
  [/^TERMINAL:/, 'TERMINAL'],
  [/^revision_conflict$/, 'REVISION'],
  [/^command_conflict$|^mutation_conflict$|^result_conflict$/, 'KEY_CONFLICT'],
  [/^binding_mismatch$/, 'BINDING'],
  [/^artifact_binding_mismatch$/, 'UNSEALED'],
  [/^TOMBSTONE$/, 'TOMBSTONE'],
  [/^lease_expired$/, 'LEASE_EXPIRED'],
  [/^stale_authority$/, 'STALE_EPOCH'],
  [/^claim_busy$/, 'BUSY'],
  [/^invalid_sealed_artifact$/, 'UNSEALED'],
  [/^invalid_input$/, 'INVALID'],
  [/^unauthorized$/, 'FORBIDDEN'],
  [/^DELIVERY_UNKNOWN$/, 'DELIVERY_UNKNOWN'],
  [/assignment not found/, 'NOT_FOUND'],
  [/^EXISTS:/, 'EXISTS'],
  [/^KEY_CONFLICT:/, 'KEY_CONFLICT'],
  [/request_id conflict/, 'KEY_CONFLICT'],
  [/contradictory report/, 'KEY_CONFLICT'],
  [/^invalid claim$/, 'STALE_EPOCH'],
  [/^\{"error":"lease_expired"/, 'LEASE_EXPIRED'],
  [/^\{"error":"assignment_cancelled"/, 'TERMINAL'],
  [/assignment is terminal|already finished|assignment finished|assignment cancelled/, 'TERMINAL'],
  [/already claimed by another claimant/, 'BUSY'],
  [/invalid sealed artifact/, 'UNSEALED'],
  [/artifact digest mismatch/, 'DIGEST'],
  [/^artifact sealed$/, 'EXISTS'],
  [/invalid owner capability|legacy request requires operator adoption/, 'FORBIDDEN'],
  [/^NOT_DUE:/, 'NOT_DUE'], // adapter-observed: the scheduler tick left an unexpired lease in place
];
const mapError = message => { for (const [re, code] of ERROR_MAP) if (re.test(message)) return { code, mapped: true }; return { code: `NATIVE:${message}`, mapped: false }; };

function request({ socketPath, port, method = 'GET', pathName, headers = {}, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, host: socketPath ? undefined : '127.0.0.1', port, method, path: pathName, headers, signal }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

export class DotBridgeAdapter {
  constructor({ clockScale = 1, keepHome = false, serverEnv = {} } = {}) {
    this.clockScale = clockScale; this.keepHome = keepHome; this.serverEnv = serverEnv;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'conf', use: 'sig', alg: 'RS256' };
    this.jwksServer = null; this.jwksPort = null; this.home = null; this.child = null;
    this.waits = new Map(); this.trace = []; this.logs = [];
  }
  async init() {
    this.jwksServer = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [this.jwk] })); });
    await new Promise(r => this.jwksServer.listen(0, '127.0.0.1', r));
    this.jwksPort = this.jwksServer.address().port;
  }
  async close() { await this.killServer(); this.abortWaits(); await new Promise(r => this.jwksServer?.close(r)); this.cleanupHome(); }
  cleanupHome() { if (this.home && !this.keepHome) fs.rmSync(this.home, { recursive: true, force: true }); this.home = null; }

  // ---- contract: reset / control ------------------------------------------------------------------------
  async reset() {
    await this.killServer(); this.abortWaits(); this.cleanupHome();
    fs.mkdirSync(path.join(os.homedir(), '.tmp'), { recursive: true });
    this.home = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'cf-'));
    const cfg = path.join(this.home, '.config/dot-bridge');
    fs.mkdirSync(cfg, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cfg, 'oauth.env'), `OAUTH_ISSUER=http://127.0.0.1:${this.jwksPort}/realms/fake\nOAUTH_AUDIENCE=${AUDIENCE}\nOAUTH_JWKS_URI=http://127.0.0.1:${this.jwksPort}/jwks\nOAUTH_ALLOWED_SUBJECTS=W1,W2,W3\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(cfg, 'limits.json'), JSON.stringify({ claim_lease_ms: LEASE_MS, max_claimed_outer_assignments: 10, worker_lane_capacity: 10 }), { mode: 0o600 });
    this.baseMs = Date.now(); this.clockFile = path.join(this.home, 'clock'); this.ackFile = path.join(this.home, 'tick-ack');
    fs.writeFileSync(this.clockFile, '0'); fs.writeFileSync(this.ackFile, '0');
    this.now = 0; this.tickCount = 0;
    this.maps = { job: new Map(), request: new Map(), claim: new Map(), claimRev: new Map(), receipt: new Map(), artifact: new Map(), artifactRev: new Map() };
    this.waiterPredicate = new Map(); this.prevCount = new Map(); this.knownTerminal = new Map(); this.finishArtifacts = new Map();
    this.trace = []; this.logs = [];
    await this.startServer();
    return { reset: true, home: this.home };
  }
  async control(c) {
    if (c.op === 'advance') {
      if (c.to < this.now) throw new Error('clock must be monotonic');
      this.now = c.to; fs.writeFileSync(this.clockFile, String(c.to * this.clockScale)); return { now: this.now };
    }
    if (c.op === 'restart') {
      // The inert receiver completes already-issued transits independently of
      // the dispatcher. No native delivery-result acknowledgement is supplied.
      createInertProtocolFixtures(this.home).completeIssuedTransits();
      this.abortWaits(); await this.killServer(); await this.startServer(); return { recovered: true };
    }
    throw new Error(`unknown control ${c.op}`);
  }
  abortWaits() { for (const w of this.waits.values()) w.abort.abort(); this.waits.clear(); }

  // ---- server process -----------------------------------------------------------------------------------
  async startServer(extraEnv = {}) {
    const env = {
      PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: this.home, DALAN_LEGACY_PROFILE: '1', LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: path.join(this.home, 'tmp'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      DOT_BRIDGE_CATALOG_PROFILE: 'protocol-v0',
      DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_T3_DRY_RUN: '1',
      DOT_BRIDGE_WORKSPACE_ROOT: path.join(this.home, 'work'),
      CONFORMANCE_CLOCK_FILE: this.clockFile, CONFORMANCE_TICK_ACK_FILE: this.ackFile, CONFORMANCE_BASE_MS: String(this.baseMs), ...this.serverEnv, ...extraEnv,
    };
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    const child = spawn(process.execPath, ['--import', PRELOAD, 'scripts/conformance/service-bootstrap.mjs'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; this.serverLog = '';
    let ready = 0; let port = null;
    child.stdout.on('data', b => { const s = String(b); this.serverLog += s; if (s.includes('admin socket')) ready |= 1; const m = /MCP listening on [^:]+:(\d+)/.exec(s); if (m) { port = Number(m[1]); ready |= 2; } });
    child.stderr.on('data', b => { this.serverLog += String(b); });
    child.exitCode === null && child.once('exit', () => { this.serverExited = true; });
    this.serverExited = false;
    for (let i = 0; i < 400 && ready !== 3; i++) { if (this.serverExited) throw new Error(`server exited during startup: ${this.serverLog.slice(-800)}`); await sleep(25); }
    if (ready !== 3) throw new Error(`server not ready: ${this.serverLog.slice(-800)}`);
    this.port = port;
    this.secret = fs.readFileSync(path.join(this.home, '.config/dot-bridge/env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    this.socket = path.join(this.home, '.local/share/dot-bridge/admin.sock');
    this.dbFile = path.join(this.home, '.local/share/dot-bridge/bridge.db');
  }
  async killServer() {
    const c = this.child; if (!c) return; this.child = null; this.logs.push(this.serverLog);
    if (c.exitCode === null && c.signalCode === null) { const done = new Promise(r => c.once('exit', r)); c.kill('SIGKILL'); await done; }
  }
  async tick() { // one manual scheduler pass (maintenance: lease and expiry sweeps; then delivery)
    const before = Number(fs.readFileSync(this.ackFile, 'utf8'));
    this.child.kill('SIGUSR2');
    for (let i = 0; i < 400; i++) { if (Number(fs.readFileSync(this.ackFile, 'utf8')) > before) return; await sleep(10); }
    throw new Error('scheduler tick not acknowledged');
  }

  // ---- real calls -----------------------------------------------------------------------------------------
  token(subject) {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'conf' })).toString('base64url');
    const exp = Math.floor(this.baseMs / 1000) + 10 * 365 * 86400;
    const claims = Buffer.from(JSON.stringify({ iss: `http://127.0.0.1:${this.jwksPort}/realms/fake`, aud: AUDIENCE, exp, sub: subject, scope: 'dot-bridge.read dot-bridge.work' })).toString('base64url');
    const input = `${head}.${claims}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), this.privateKey).toString('base64url')}`;
  }
  async mcp(subject, name, args, { signal } = {}) {
    const r = await request({ port: this.port, method: 'POST', pathName: `/${this.secret}/mcp`, signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token(subject)}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    let j; try { j = JSON.parse(r.text); } catch { return this.note({ kind: 'mcp', name, args, error: `http ${r.status}: ${r.text.slice(0, 200)}` }, { error: `http ${r.status}` }); }
    if (j.error) return this.note({ kind: 'mcp', name, args, error: j.error.message }, { error: j.error.message });
    if (j.result.isError) return this.note({ kind: 'mcp', name, args, error: j.result.content[0].text }, { error: j.result.content[0].text });
    const value = JSON.parse(j.result.content[0].text);
    return this.note({ kind: 'mcp', name, args, result: trim(value) }, { value });
  }
  async admin(method, pathName, body, capability, { signal,serviceRole } = {}) {
    const serviceCap=serviceRole?protocolServiceCapability(fs.readFileSync(path.join(this.home,'.config/dot-bridge/operator.key'),'utf8').trim(),serviceRole):null;
    const headers = { 'content-type': 'application/json', ...(capability ? { 'x-owner-capability': capability } : {}),...(serviceCap?{'x-protocol-service-capability':serviceCap}:{}) };
    const r = await request({ socketPath: this.socket, method, pathName, headers, body: body === undefined ? undefined : body, signal });
    let j; try { j = JSON.parse(r.text); } catch { j = { raw: r.text }; }
    if (r.status >= 400) return this.note({ kind: 'admin', method, path: pathName, status: r.status, error: j.error }, { error: j.error ?? r.text });
    return this.note({ kind: 'admin', method, path: pathName, status: r.status, result: trim(j) }, { value: j });
  }
  note(entry, ret) { this.trace.push(entry); return ret; }

  // ---- read-only instrumented store access -----------------------------------------------------------------
  db() { return new DatabaseSync(this.dbFile, { readOnly: true }); }
  q(sql, ...params) { const db = this.db(); try { return db.prepare(sql).all(...params); } finally { db.close(); } }
  q1(sql, ...params) { return this.q(sql, ...params)[0]; }

  // ---- id normalization (bijective) ------------------------------------------------------------------------
  requestId(job) { const id = `req_fixture_${job}`; this.maps.job.set(job, id); this.maps.request.set(id, job); return id; }
  jobOf(requestId) { return this.maps.request.get(requestId) ?? requestId; }
  ownerToken(job) { return `owner-token-${job}`; }
  claimAlias(nativeId) { if (!nativeId) return null; if (!this.maps.claim.has(nativeId)) { const a = `C${this.maps.claim.size + 1}`; this.maps.claim.set(nativeId, a); this.maps.claimRev.set(a, nativeId); } return this.maps.claim.get(nativeId); }
  nativeClaim(alias) { return this.maps.claimRev.get(alias) ?? `unissued_${alias}`; }
  receiptAlias(job, nativeId) { const key = `${job}:${nativeId}`; if (!this.maps.receipt.has(key)) this.maps.receipt.set(key, `R:${job}:${[...this.maps.receipt.keys()].filter(k => k.startsWith(`${job}:`)).length + 1}`); return this.maps.receipt.get(key); }
  artifactId(alias) { const id = `art_fixture_${alias}`; this.maps.artifact.set(alias, id); this.maps.artifactRev.set(id, alias); return id; }
  artifactAlias(clientId) { return this.maps.artifactRev.get(clientId) ?? clientId; }
  leaseUntilOf(iso) { return (Date.parse(iso) - this.baseMs) / this.clockScale; }
  fixtureTime(iso) { return (Date.parse(iso) - this.baseMs) / this.clockScale; }
  commandFields(ctx) {
    const command=ctx.command;
    return {command_key:command.key,...(command.revision===undefined?{}:{expected_revision:command.revision}),...(command.epoch===undefined?{}:{epoch:command.epoch})};
  }
  receiptRevision(reply) {
    if(!Number.isSafeInteger(reply?.value?.revision)) throw new Error('native protocol receipt lacks revision');
    return reply.value.revision;
  }
  protocolJob(requestId) {
    return !!this.q1("SELECT 1 present FROM sqlite_schema WHERE type='table' AND name='protocol_jobs'")&&!!this.q1('SELECT 1 present FROM protocol_jobs WHERE request_id=?',requestId);
  }

  // ---- journal projection ---------------------------------------------------------------------------------
  // The bridge's append-only lifecycle_events is its durable event journal. One row maps to one fixture event, except:
  // (abandoned + the requeue row that follows it) -> expired, and (completed + the blocked row of a blocked outcome) -> finished.
  // Rows with no fixture counterpart (consumed, accepted, delivery_*) pass through as native:<type> so they can never match.
  journal(job) {
    const requestId = this.maps.job.get(job) ?? this.requestId(job);
    if(this.protocolJob(requestId)) return this.q('SELECT * FROM protocol_events WHERE request_id=? ORDER BY seq',requestId).map(row=>{
      // These are persisted native command facts, not a count or synthetic event
      // derived from operational lifecycle rows. Missing facts fail the adapter.
      if(!Number.isSafeInteger(row.revision)||typeof row.state!=='string') throw new Error('native protocol event lacks persisted revision/state');
      return {v:0,source:SOURCE,id:`${job}:${row.seq}`,job,seq:row.seq,revision:row.revision,epoch:row.epoch,type:row.event_type,state:row.state};
    });
    const rows = this.q('SELECT id,claim_id,epoch,type,at,actor,reason FROM lifecycle_events WHERE request_id=? ORDER BY id', requestId);
    const claim = this.q1('SELECT epoch FROM claims WHERE request_id=?', requestId);
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; const prev = out[out.length - 1];
      if (r.type === 'queued' && prev?.native === 'abandoned' && r.reason === 'requeued') continue;
      if (r.type === 'blocked' && prev?.native === 'completed') continue;
      const action=/^question:(ask|answer|consume):/.exec(r.reason??'')?.[1];
      const questionAction=({ask:'waiting',answer:'waiting',consume:'working'}[action]===r.type)?action:null;
      const type = questionAction?{ask:'questioned',answer:'answered',consume:'consumed'}[questionAction]:({ queued: 'submitted', claimed: 'claimed', working: 'progressed', waiting: 'questioned', blocked: 'progressed', completed: 'finished', cancelled: 'cancelled', abandoned: 'expired' }[r.type] ?? `native:${r.type}`);
      out.push({ native: r.type, type, rowId: r.id, epoch: r.epoch ?? (r.type === 'queued' ? 0 : claim?.epoch ?? 0), at: r.at });
    }
    const state = this.deriveState(requestId);
    return out.map((e, idx) => ({
      v: 0, source: SOURCE, id: `${job}:${idx + 1}`, job, seq: idx + 1, revision: idx + 1, epoch: e.epoch, type: e.type,
      state: idx === out.length - 1 ? state : typeState(e.native),
    }));
  }
  // Fixture state label computed from bridge facts at this moment (the bridge itself has only queued/claimed/finished/cancelled).
  deriveState(requestId) {
    const a = this.q1('SELECT status FROM assignments WHERE request_id=?', requestId); if (!a) return 'queued';
    if (a.status === 'queued') return 'queued'; if (a.status === 'finished') return 'finished'; if (a.status === 'cancelled') return 'cancelled';
    const c = this.q1("SELECT claim_id,epoch,claimed_at,last_progress_at FROM claims WHERE request_id=? AND state='active'", requestId);
    if (!c) return 'queued';
    const identified=this.q('SELECT consumed_at FROM job_questions WHERE request_id=? AND claim_id=? AND epoch=?',requestId,c.claim_id,c.epoch);
    if(identified.some(question=>question.consumed_at===null)) return 'awaiting_input';
    // Legacy progress already emits native waiting facts; identified ask/answer facts have explicit reasons.
    const legacy = this.q1("SELECT at FROM lifecycle_events WHERE request_id=? AND claim_id=? AND type='waiting' AND reason IS NULL ORDER BY id DESC LIMIT 1", requestId, c.claim_id);
    const lastNote = this.q1('SELECT max(at) at FROM owner_notes WHERE request_id=?', requestId)?.at;
    if (legacy && (!lastNote || lastNote < legacy.at)) return 'awaiting_input';
    if (this.q1("SELECT 1 x FROM artifacts WHERE request_id=? AND kind='upload' AND sealed=1", requestId)) return 'result_staged';
    return c.last_progress_at ? 'running' : 'leased';
  }
  newEvents(job) {
    const all = this.journal(job); const prev = this.prevCount.get(job) ?? 0;
    this.prevCount.set(job, all.length); return { all, fresh: all.slice(prev) };
  }

  // ---- contract: invoke --------------------------------------------------------------------------------------
  async invoke(principal, command) {
    this.trace = [];
    if (command?.v !== FIXTURE_PROFILE_VERSION) return { status: 'OK', reply: { ok: false, code: 'INVALID' }, events: [], ignored: [], native: [], errorMapped: true, nativeError: 'invalid_input' };
    const { op, job } = command;
    this.requestId(job);
    const ctx = { principal, command, job, requestId: this.maps.job.get(job), ignored: [] };
    const ignore = (...fields) => { for (const f of fields) if (f.split('.').reduce((o, k) => o?.[k], command) !== undefined) ctx.ignored.push(f); };
    if(['get','inbox','ack','expire'].includes(op)) ignore('key');
    let res;
    try {
      if (OWNER_OPS.has(op) && principal !== 'owner' && op !== 'answer') res = unsupported(`${principal} cannot invoke owner operation ${op}: the bridge owner surface is a unix socket guarded by a per-request capability`);
      else if (WORKER_OPS.has(op) && !/^W\d$/.test(principal)) res = unsupported(`${principal} is not a worker principal`);
      else res = await this[`op_${op}`](ctx, ignore);
    } catch (e) { res = { error: `adapter exception: ${e.message}` , adapterError: true }; }
    return this.finalize(ctx, res);
  }
  finalize(ctx, res) {
    const base = { ignored: ctx.ignored, native: this.trace };
    if (res.unsupported) return { status: 'UNSUPPORTED', reason: res.unsupported, ...base };
    const { fresh } = this.newEvents(ctx.job);
    if (res.adapterError) return { status: 'ERROR', reply: { ok: false, code: `ADAPTER:${res.error}` }, events: fresh, ...base };
    if (res.error !== undefined) { const m = mapError(res.error); return { status: 'OK', reply: { ok: false, code: m.code }, events: fresh, errorMapped: m.mapped, nativeError: res.error, ...base }; }
    return { status: 'OK', reply: { ok: true, value: res.value }, events: fresh, ...base };
  }
  rev(job) {
    const requestId=this.maps.job.get(job)??this.requestId(job);
    return this.protocolJob(requestId)?this.q1('SELECT revision FROM claim_command_revisions WHERE job=?',requestId).revision:this.journal(job).length;
  }

  // owner ---------------------------------------------------------------------------------------------------
  async op_submit(ctx, ignore) {
    const b = ctx.command.body;
    const assignment = { schema_version: 1, request_id: ctx.requestId, brief: `Fixture job ${ctx.job}: inert conformance assignment`, inputs: [], expected_output: 'fixture result', execution_scope: 'read-only',protocol:{profile:'job-v0',source:b.source,scope:b.scope,policy:b.policy,destination:b.destination,retain_until_ms:this.baseMs+b.retainUntil*this.clockScale} };
    const r = await this.admin('POST', '/submit', { assignment, delivery: 'none', owner_token: this.ownerToken(ctx.job), command_key: ctx.command.key });
    if (r.error) return r;
    return { value: { revision: this.receiptRevision(r) } };
  }
  async op_cancel(ctx) {
    const r = await this.admin('POST', '/cancel', { id: ctx.requestId, reason: ctx.command.body.reason,...this.commandFields(ctx) }, this.ownerToken(ctx.job));
    if (r.error) return r;
    return { value: { revision: this.receiptRevision(r), stop: r.value.compute_stopped === true ? 'confirmed' : 'unverified' } };
  }
  async op_answer(ctx, ignore) {
    const cap = ctx.principal === 'owner' ? this.ownerToken(ctx.job) : undefined; // a worker holds no owner capability
    const r = await this.admin('POST', '/answer', { id: ctx.requestId, question_id:ctx.command.body.question, text: ctx.command.body.text,...this.commandFields(ctx) }, cap);
    if (r.error) return r;
    return { value: { revision: this.receiptRevision(r) } };
  }
  async op_get(ctx) {
    const r = await this.admin('GET', `/get?id=${ctx.requestId}&peek=1`, undefined, this.ownerToken(ctx.job));
    if (r.error) return r;
    return { value: { snapshot: this.snapshot(ctx.job, r.value) } };
  }
  snapshot(job, g) {
    const requestId = this.maps.job.get(job);
    const events = this.journal(job);
    const claim = g.claim?.state === 'active' ? g.claim : null;
    const protocol=g.assignment?.protocol;
    const binding = protocol?{source:protocol.source,scope:protocol.scope,policy:protocol.policy,destination:protocol.destination,retainUntil:(protocol.retain_until_ms-this.baseMs)/this.clockScale}:g.assignment?.inputs?.[0]?.fixture_binding??null;
    const arts = Object.fromEntries(this.q("SELECT id,client_artifact_id cid,claim_id,origin_epoch,size,sha256,sealed FROM artifacts WHERE request_id=? AND kind='upload' ORDER BY created_at", requestId).map(a => {
      const ep = a.origin_epoch??this.q1('SELECT epoch FROM claims WHERE claim_id=?', a.claim_id)?.epoch ?? this.q1('SELECT epoch FROM lifecycle_events WHERE claim_id=? AND epoch IS NOT NULL LIMIT 1', a.claim_id)?.epoch ?? null;
      // Retired staging has no live client alias; retain its native identity as audit inventory.
      return [a.cid===null?`native-retired:${a.id}`:this.artifactAlias(a.cid), { epoch: ep, sha256: a.sha256, size: a.size, sealed: !!a.sealed }];
    }));
    const questions = Object.fromEntries(this.q('SELECT question_id,epoch,text,answer,consumed_at FROM job_questions WHERE request_id=?',requestId).map(q=>[q.question_id,{epoch:q.epoch,text:q.text,answer:q.answer,consumed:q.consumed_at!==null}]));
    const nativeBinding=this.protocolJob(requestId)?this.q1('SELECT identity FROM immutable_result_bindings WHERE job=?',requestId):null;
    const bound=nativeBinding?JSON.parse(nativeBinding.identity):null;
    const resultArtifacts=bound?bound.artifacts.map(ref=>this.artifactAlias(this.q1('SELECT COALESCE(client_artifact_id,id) id FROM artifacts WHERE id=? AND request_id=?',ref.id,requestId)?.id??ref.id)):Object.entries(arts).filter(([,v])=>v.sealed).map(([key])=>key);
    const result = g.report ? { receipt: this.receiptAlias(job, g.report.receipt_id), outcome: g.report.outcome, summary: g.report.summary, artifacts: resultArtifacts, ...(bound?{source:bound.source,policy:bound.policy}:parseResult(g.report.result)) } : null;
    return {
      id: job, revision: this.rev(job), seq: events.at(-1)?.seq??0, epoch: g.claim?.epoch ?? 0, state: events.at(-1)?.state ?? 'queued',
      claim: claim ? this.claimAlias(claim.claim_id) : null, worker: claim ? claim.claimant : null,
      leaseUntil: claim ? this.leaseUntilOf(claim.lease_expires_at) : null, binding, questions, artifacts: arts, result,
      stop: g.protocol_stop?.stop??(g.compute_stopped === true ? 'confirmed' : 'unverified'), revoked: g.authority_revoked === true,
    };
  }
  async op_wait(ctx) {
    const body=ctx.command.body;
    const r=await this.admin('POST','/protocol/wait',{id:ctx.requestId,...this.commandFields(ctx),waiter:body.waiter,predicate:body.predicate,after_seq:body.afterSeq,expires_at:this.baseMs+body.expiresAt*this.clockScale},this.ownerToken(ctx.job));
    if(r.error) return r;
    return {value:{revision:this.receiptRevision(r),waiter:body.waiter,delivery:r.value.delivery?this.deliveryAlias(ctx.job,body.waiter,r.value.delivery):null}};
  }
  deliveryAlias(job,waiter,native) {
    if(!this.maps.delivery)this.maps.delivery=new Map();
    if(!this.maps.deliveryRev)this.maps.deliveryRev=new Map();
    const nativeKey=JSON.stringify([job,native]);
    if(this.maps.delivery.has(nativeKey))return this.maps.delivery.get(nativeKey);
    if(!this.maps.deliveryCounts)this.maps.deliveryCounts=new Map();
    const tuple=JSON.stringify([job,waiter]);
    let count=(this.maps.deliveryCounts.get(tuple)??0)+1,alias;
    do {alias=count===1?`D:${waiter}`:`D:${waiter}:${count}`;count++;}while(this.maps.deliveryRev.has(JSON.stringify([job,alias])));
    this.maps.deliveryCounts.set(tuple,count-1);
    this.maps.delivery.set(nativeKey,alias);this.maps.deliveryRev.set(JSON.stringify([job,alias]),native);return alias;
  }
  async op_inbox(ctx) {
    const waiter=ctx.command.body.waiter;
    const r=await this.admin('POST','/protocol/inbox',{id:ctx.requestId,waiter},this.ownerToken(ctx.job));
    if(r.error)return r;
    return {value:{deliveries:r.value.deliveries.map(row=>({...row,delivery:this.deliveryAlias(ctx.job,waiter,row.delivery),job:ctx.job,event:row.event.replace(ctx.requestId+':',ctx.job+':')}))}};
  }
  async op_ack(ctx) {
    const body=ctx.command.body,native=this.maps.deliveryRev?.get(JSON.stringify([ctx.job,body.delivery]))??'unissued_delivery';
    const r=await this.admin('POST','/protocol/ack',{id:ctx.requestId,waiter:body.waiter,delivery:native},this.ownerToken(ctx.job));
    if(r.error)return r;
    return {value:{delivery:body.delivery,state:r.value.state}};
  }

  // worker ----------------------------------------------------------------------------------------------------
  async op_claim(ctx, ignore) {
    const r = await this.mcp(ctx.principal, 'claim', { request_id: ctx.requestId, claimant: ctx.principal,...this.commandFields(ctx), ...(ctx.command.body.leaseMs === undefined ? {} : { lease_ms: ctx.command.body.leaseMs*this.clockScale }) });
    if (r.error) return r;
    const current=this.q1('SELECT claim_id,state,epoch FROM claims WHERE request_id=?',ctx.requestId);
    const active=this.q1('SELECT status FROM assignments WHERE request_id=?',ctx.requestId)?.status==='claimed';
    if(this.protocolJob(ctx.requestId)&&active&&current?.state==='active'&&current.claim_id===r.value.claim_id&&Date.parse(r.value.lease_expires_at)>this.baseMs+this.now*this.clockScale) {
      const enrolled=await this.admin('POST','/protocol/service/enroll',{id:ctx.requestId,execution:{claim:current.claim_id,epoch:current.epoch,invocation:ctx.requestId+':'+current.epoch,scope:'inert-test-execution'}},undefined,{serviceRole:'observer'});
      if(enrolled.error)return enrolled;
      createInertProtocolFixtures(this.home).enroll(enrolled.value);
    }
    return { value: { revision: this.receiptRevision(r), epoch: r.value.epoch, claim: this.claimAlias(r.value.claim_id), leaseUntil: this.leaseUntilOf(r.value.lease_expires_at) } };
  }
  async op_renew(ctx) {
    const r=await this.mcp(ctx.principal,'renew_claim',{request_id:ctx.requestId,claim_id:this.nativeClaim(ctx.command.claim),lease_ms:ctx.command.body.leaseMs*this.clockScale,...this.commandFields(ctx)});
    if(r.error)return r;
    return {value:{revision:this.receiptRevision(r),leaseUntil:this.leaseUntilOf(r.value.lease_expires_at)}};
  }

  async op_progress(ctx, ignore) {
    const r = await this.mcp(ctx.principal, 'progress', { request_id: ctx.requestId, claim_id: this.nativeClaim(ctx.command.claim), note: ctx.command.body.note,...this.commandFields(ctx) });
    if (r.error) return r;
    return { value: { revision: this.receiptRevision(r) } };
  }
  async op_ask(ctx, ignore) {
    const r = await this.mcp(ctx.principal, 'ask_question', { request_id: ctx.requestId, claim_id: this.nativeClaim(ctx.command.claim), question_id:ctx.command.body.question,text:ctx.command.body.text,...this.commandFields(ctx) });
    if (r.error) return r;
    return { value: { revision: this.receiptRevision(r) } };
  }
  async op_consume(ctx, ignore) {
    const r=await this.mcp(ctx.principal,'consume_answer',{request_id:ctx.requestId,claim_id:this.nativeClaim(ctx.command.claim),question_id:ctx.command.body.question,...this.commandFields(ctx)});
    if(r.error) return r;
    return { value: { revision: this.receiptRevision(r), answer:r.value.answer } };
  }
  async op_upload(ctx, ignore) {
    const b = ctx.command.body;
    const r = await this.mcp(ctx.principal, 'artifact_chunk', { request_id: ctx.requestId, claim_id: this.nativeClaim(ctx.command.claim), artifact_id: this.artifactId(b.artifact), offset: 0, data_base64: b.bytesBase64, final: false,...this.commandFields(ctx) });
    if (r.error) return r;
    return { value: { revision: this.receiptRevision(r) } };
  }
  async op_seal(ctx, ignore) {
    const b = ctx.command.body; const native = this.artifactId(b.artifact);
    const row = this.q1('SELECT size FROM artifacts WHERE request_id=? AND client_artifact_id=?', ctx.requestId, native);
    const r = await this.mcp(ctx.principal, 'artifact_chunk', { request_id: ctx.requestId, claim_id: this.nativeClaim(ctx.command.claim), artifact_id: native, offset: row?.size ?? 0, data_base64: '', final: true, sha256: b.sha256,size:b.size,...this.commandFields(ctx) });
    if (r.error) return r;
    return { value: { revision: this.receiptRevision(r) } };
  }
  async op_finish(ctx, ignore) {
    const b = ctx.command.body;
    const args = { request_id: ctx.requestId, claim_id: this.nativeClaim(ctx.command.claim), outcome: b.outcome, summary: b.summary, result: JSON.stringify({ source: b.source, policy: b.policy }),...this.commandFields(ctx) };
    if (b.artifacts.length) args.artifact_ids = b.artifacts.map(a => this.artifactId(a));
    const r = await this.mcp(ctx.principal, 'finish', args);
    if (r.error) return r;
    this.finishArtifacts.set(ctx.job, b.artifacts.map(a => this.maps.artifact.get(a)));
    return { value: { revision: this.receiptRevision(r), receipt: this.receiptAlias(ctx.job, r.value.receipt_id), acceptance:r.value.acceptance, ...(r.value.late ? { late: true } : {}) } };
  }

  // service ------------------------------------------------------------------------------------------------------
  async op_expire(ctx, ignore) {
    ignore('revision');
    const before = this.q1("SELECT status FROM assignments WHERE request_id=?", ctx.requestId)?.status;
    const claimBefore = this.q1("SELECT state FROM claims WHERE request_id=?", ctx.requestId)?.state;
    await this.tick();
    const claimAfter = this.q1("SELECT state FROM claims WHERE request_id=?", ctx.requestId)?.state;
    this.trace.push({ kind: 'scheduler', action: 'drain tick (lease sweep)', claimBefore, claimAfter, statusBefore: before });
    if (claimBefore === 'active' && claimAfter === 'abandoned') return { value: { revision: this.rev(ctx.job) } };
    if (before === 'claimed') return { error: 'NOT_DUE: scheduler tick left the lease in place' , notDue: true };
    return { error: `scheduler tick expired nothing (status ${before})` };
  }
  nativeDelivery(ctx,alias) {
    const known=this.maps.deliveryRev?.get(JSON.stringify([ctx.job,alias]));
    if(known)return known;
    for(const row of this.q('SELECT delivery_id,waiter FROM durable_waiter_deliveries WHERE job=? ORDER BY event_seq,delivery_id',ctx.requestId)) {
      if(this.deliveryAlias(ctx.job,row.waiter,row.delivery_id)===alias)return row.delivery_id;
    }
    return 'unissued_'+alias;
  }
  async deliveryCommand(ctx,operation) {
    const body=ctx.command.body,delivery=this.nativeDelivery(ctx,body.delivery);
    if(ctx.principal==='service'&&operation!=='dispatch')createInertProtocolFixtures(this.home).injectDelivery(delivery,body.receipt,body.outcome);
    const r=await this.admin('POST','/protocol/service/'+operation,{id:ctx.requestId,key:ctx.command.key,...body,delivery},undefined,{serviceRole:ctx.principal==='service'?'dispatcher':undefined});
    if(r.error)return r;
    return {value:{...r.value,delivery:this.maps.delivery.get(JSON.stringify([ctx.job,r.value.delivery]))??r.value.delivery}};
  }
  async op_dispatch(ctx) {return this.deliveryCommand(ctx,'dispatch');}
  async op_delivery_result(ctx) {return this.deliveryCommand(ctx,'delivery-result');}
  async op_reconcile(ctx) {return this.deliveryCommand(ctx,'reconcile');}
  async op_observe_stop(ctx) {
    if(ctx.principal==='service') {
      const row=this.q1('SELECT binding FROM protocol_stop_enrollments WHERE job=?',ctx.requestId);
      if(row)createInertProtocolFixtures(this.home).stop(JSON.parse(row.binding),ctx.command.body.evidence);
    }
    const r=await this.admin('POST','/protocol/service/observe-stop',{id:ctx.requestId,key:ctx.command.key,revision:ctx.command.revision,...ctx.command.body},undefined,{serviceRole:ctx.principal==='service'?'observer':undefined});
    return r.error?r:{value:r.value};
  }

  // ---- storage invariants (instrumented read-only) -------------------------------------------------------------
  invariants(job) {
    const out = []; const requestId = this.maps.job.get(job);
    const check = (name, ok, detail = '') => out.push({ name, status: ok ? 'ok' : 'violated', detail });
    const na = (name, detail) => out.push({ name, status: 'not_applicable', detail });
    try {
      check('one live claim per job', this.q("SELECT request_id FROM claims WHERE state='active' GROUP BY request_id HAVING count(*)>1").length === 0);
      if(this.protocolJob(requestId)) {
        check('unique successful idempotency key tuple',this.q('SELECT job,command_key,count(*) n FROM claim_command_receipts GROUP BY job,command_key HAVING count(*)>1').length===0);
        const facts=this.q('SELECT seq,revision FROM protocol_events WHERE request_id=? ORDER BY seq',requestId);
        check('protocol event sequence strictly increasing',facts.every((row,index)=>index===0||row.seq>facts[index-1].seq));
        check('native revision matches committed mutation facts',facts.length>0&&this.rev(job)===Math.max(...facts.map(row=>row.revision)));
      } else na('unique successful idempotency key tuple','legacy job has no protocol command ledger');
      const ids = this.q('SELECT id FROM lifecycle_events WHERE request_id=? ORDER BY id', requestId).map(r => r.id);
      check('event sequence strictly increasing', ids.every((x, i) => i === 0 || x > ids[i - 1]));
      check('no duplicate outbox identity', this.q("SELECT request_id,kind,body,count(*) n FROM notifications WHERE kind IN ('t3','wait','blocker') GROUP BY request_id,kind,COALESCE(body,'') HAVING n>1").length === 0);
      const a = requestId && this.q1('SELECT status FROM assignments WHERE request_id=?', requestId);
      const rep = requestId && this.q1('SELECT outcome,summary,receipt_id FROM reports WHERE request_id=?', requestId);
      const prev = this.knownTerminal.get(job);
      if (prev) check('no terminal overwrite', a?.status === prev.status && (!prev.report || (rep && rep.receipt_id === prev.report.receipt_id && rep.outcome === prev.report.outcome && rep.summary === prev.report.summary)), `was ${prev.status}`);
      else na('no terminal overwrite', 'not terminal yet');
      if (a && ['finished', 'cancelled'].includes(a.status)) this.knownTerminal.set(job, { status: a.status, report: rep ?? null });
      const refs = this.finishArtifacts.get(job);
      if (refs) check('no result reference to missing/unsealed artifact', refs.every(id => this.q1("SELECT 1 x FROM artifacts WHERE request_id=? AND client_artifact_id=? AND sealed=1", requestId, id)), 'checked against the artifact ids passed to finish; the bridge does not persist finish artifact references');
      else na('no result reference to missing/unsealed artifact', 'no successful finish with artifacts');
      na('no acknowledged delivery returned by inbox', 'checked per inbox step by the runner contract only when a delivery model exists');
    } catch (e) { out.push({ name: 'invariant query', status: 'violated', detail: e.message }); }
    return out;
  }
  logDigest() { return sha256([...this.logs, this.child ? this.serverLog : ''].join('\n--restart--\n')); }
  info() {
    const v = new DatabaseSync(':memory:'); const sqlite = v.prepare('select sqlite_version() v').get().v; v.close();
    return { storageEngine: `SQLite ${sqlite} (node:sqlite, WAL)`, node: process.version, serverEntry: 'src/server.mjs', level: 'persistence-restart', clockScale: this.clockScale, leaseMs: LEASE_MS };
  }
}

function typeState(native) { return { queued: 'queued', claimed: 'leased', working: 'running', waiting: 'awaiting_input', blocked: 'running', completed: 'finished', cancelled: 'cancelled', abandoned: 'queued' }[native] ?? 'queued'; }
const unsupported = reason => ({ unsupported: reason });
const safeJson = t => { try { return JSON.parse(t); } catch { return { raw: t }; } };
const parseResult = r => { try { const j = JSON.parse(r); return { source: j.source, policy: j.policy }; } catch { return {}; } };
function trim(v) { const s = JSON.stringify(v); if (s.length <= 600) return v; return { _trimmed: s.slice(0, 600) + '...' }; }
