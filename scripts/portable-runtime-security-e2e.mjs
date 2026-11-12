#!/usr/bin/env node
// Seven live-process security properties. No production HOME, external IdP, tunnel, or remote repository.
// Run: node scripts/portable-runtime-security-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';
import './runtime-loopback-guard.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

process.umask(0o077);
assert.throws(() => net.connect({ host: '198.51.100.1', port: 9 }), /forbids non-loopback network/);
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
const guard = path.join(repo, 'scripts/runtime-loopback-guard.mjs');
const results = [], bridges = [], receivers = [];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = () => `req_${randomUUID()}`;
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
const callback = 'https://runtime-vendor.example/callback'; // Never fetched: only parse Location.
const must = (value, message) => assert.ok(value, message);
async function check(property, fn) {
  try { await fn(); results.push({ property, status: 'PASS' }); }
  catch (e) { results.push({ property, status: 'FAIL', error: e.message, location: e.stack?.split('\n').filter(x => x.includes('portable-runtime-security-e2e.mjs:')).filter(x => !x.includes('at must ')).slice(0, 2).map(x => x.trim()).join(' | ') }); }
  console.log(`${results.at(-1).status} ${property}${results.at(-1).error ? `: ${results.at(-1).error}` : ''}`);
}
const port = reservedPort;
function sql(file, query, ...args) { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout=5000'); try { const stmt = db.prepare(query); return /^\s*select/i.test(query) ? stmt.all(...args) : stmt.run(...args); } finally { db.close(); } }
class Bridge {
  constructor(name) { this.home = path.join(root, name); this.config = path.join(this.home, '.config/dot-bridge'); bridges.push(this); }
  async init() {
    this.port = await port(); this.url = `http://127.0.0.1:${this.port}`;
    this.env = fixtureEnv(this.home, { NODE_ENV: 'test', NODE_OPTIONS: `--import=${guard}`, DOT_BRIDGE_AUTH_MODE: 'builtin', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_MIN_FREE_BYTES: '0', DOT_BRIDGE_PORT: String(this.port), DOT_BRIDGE_WORKSPACE_ROOT: path.join(this.home, 'work') });
    delete this.env.DALAN_LEGACY_PROFILE; // these tests exercise the missing-profile refusal; the shared fixture env opts in
    fs.mkdirSync(this.config, { recursive: true });
    fs.writeFileSync(path.join(this.config, 'workers.json'), JSON.stringify({ workers: { dot: {workspaceAllowed:true,repos:['test/runtime']}, lark: {workspaceAllowed:true,repos:['test/runtime']}, duet: {workspaceAllowed:true,repos:['test/runtime']} } }), { mode: 0o600 });
    must(this.cli(['as-init', '--public-url', this.url]).code === 0, 'as-init failed (output withheld)');
    this.secret = randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(this.config, 'env'), `BRIDGE_PATH_SECRET=${this.secret}\n`, { mode: 0o600 });
    this.resource = `${this.url}/${this.secret}/mcp`;
    return this;
  }
  cli(args, input) { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env: this.env, input, encoding: 'utf8', timeout: 30000 }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }
  async start() {
    let ready = false; this.stderr = '';
    this.child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', b => { if (String(b).includes(`MCP listening on 127.0.0.1:${this.port}`)) ready = true; });
    this.child.stderr.on('data', b => this.stderr += b);
    for (let i = 0; i < 200 && !ready && this.child.exitCode === null; i++) await delay(25);
    if (ready) await this.discover();
    return ready;
  }
  async discover() {
    const protectedResponse = await fetch(`${this.url}/.well-known/oauth-protected-resource/${this.secret}/mcp`);
    must(protectedResponse.status === 200, 'protected-resource discovery failed');
    const protectedMetadata = await protectedResponse.json();
    must(protectedMetadata.resource === this.resource, 'protected-resource discovery changed the resource');
    const issuer = new URL(protectedMetadata.authorization_servers[0]);
    const response = await fetch(new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer.origin));
    must(response.status === 200, 'authorization-server discovery failed');
    this.oauth = await response.json();
    this.oauthBase = new URL(this.oauth.authorization_endpoint).pathname.replace(/\/auth$/, '');
  }
  async stop() { if (this.child && this.child.exitCode === null && this.child.signalCode === null) { const done = once(this.child, 'exit'); this.child.kill('SIGTERM'); await done; } }
  openFreshPairingWindow(worker = 'dot') {
    must(this.cli(['connect', 'stop', '--json']).code === 0, 'closing prior pairing window failed');
    must(this.cli(['connect', 'start', '--worker', worker, '--json']).code === 0, 'pairing window failed');
  }
  db(query, ...args) { return sql(path.join(this.home, '.local/share/dot-bridge/bridge.db'), query, ...args); }
  asdb(query, ...args) { return sql(path.join(this.config, 'as.sqlite'), query, ...args); }
  asTokenId(model, token) { return createHmac('sha256', fs.readFileSync(path.join(this.config, 'as-storage.key'))).update(`id:${model}`).update('\0').update(token).digest('base64url'); }
  asPayload(model, token) {
    const id = this.asTokenId(model, token), context = `oidc:${model}:${id}`;
    const row = this.asdb('SELECT payload FROM oidc WHERE model=? AND id=?', model, id)[0];
    must(row, 'encrypted AS token fixture missing');
    const [, nonce, tag, data] = row.payload.split('.');
    const decipher = createDecipheriv('aes-256-gcm', fs.readFileSync(path.join(this.config, 'as-storage.key')), Buffer.from(nonce, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url')); decipher.setAAD(Buffer.from(context));
    return { id, context, value: JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')) };
  }
  setAsPayload(model, id, context, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', fs.readFileSync(path.join(this.config, 'as-storage.key')), iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    this.asdb('UPDATE oidc SET payload=? WHERE model=? AND id=?', ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.'), model, id);
  }
  async rpc(access, method, params = {}) { const r = await fetch(this.resource, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null }; }
  async tool(access, name, args = {}) { const r = await this.rpc(access, 'tools/call', { name, arguments: args }); if (r.status !== 200 || r.body?.error || r.body?.result?.isError) return { ok: false, status: r.status, error: r.body?.error?.message ?? r.body?.result?.content?.[0]?.text }; return { ok: true, value: JSON.parse(r.body.result.content[0].text) }; }
  submit(worker, { execution = 'none', implementation = false, base, queueAnyway = false } = {}) {
    const request = id(); const assignment = { schema_version: 1, request_id: request, brief: 'Review the local fixture and report security observations.', inputs: base ? [{ github_repo: 'test/runtime', base_sha: base }] : [{ revision: 'local-fixture' }], expected_output: 'A report for owner review', execution_scope: implementation ? 'implementation' : 'read-only', ...(base ? { scope_paths: ['hello.txt'] } : {}) };
    const r = this.cli(['submit', '--stdin', '--json', '--worker', worker, '--execution', execution, ...(queueAnyway ? ['--queue-anyway'] : [])], JSON.stringify(assignment));
    must(r.code === 0, `submit failed for ${worker} (output withheld)`); return request;
  }
}
class Vendor {
  constructor(bridge, redirect = callback) { this.bridge = bridge; this.redirect = redirect; }
  async register(redirects = [this.redirect]) { this.bridge.openFreshPairingWindow(); const r = await fetch(this.bridge.oauth.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: redirects, client_name: 'Runtime fixture', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) }); const body = await r.json(); if (r.status === 201) this.client = body.client_id; return r.status; }
  async hit(url, flow) { must(new URL(url).origin === this.bridge.url, 'attempt to follow external redirect'); const r = await fetch(url, { redirect: 'manual', headers: { cookie: [...flow.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }); for (const c of r.headers.getSetCookie()) { const p = c.split(';')[0], n = p.indexOf('='); flow.cookies.set(p.slice(0, n), p.slice(n + 1)); } return r; }
  async begin(extra = {}) {
    const flow = { ...pkce(), cookies: new Map() };
    const p = { client_id: this.client, response_type: 'code', redirect_uri: this.redirect, scope: 'dot-bridge.read dot-bridge.work', resource: this.bridge.resource, code_challenge: flow.challenge, code_challenge_method: 'S256', state: randomUUID(), ...extra };
    for (const k of Object.keys(p)) if (p[k] === null) delete p[k];
    const r = await this.hit(`${this.bridge.oauth.authorization_endpoint}?${new URLSearchParams(p)}`, flow);
    flow.status = r.status; flow.location = r.headers.get('location');
    if (flow.location?.startsWith(`${this.bridge.oauthBase}/interaction/`)) { const page = await this.hit(this.bridge.url + flow.location, flow); flow.pairing = (await page.text()).match(/class="code">([A-Z0-9-]+)</)?.[1]; }
    return flow;
  }
  async token(fields) { const r = await fetch(this.bridge.oauth.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.client, ...fields }) }); return { status: r.status, body: await r.json() }; }
  refresh(token, extra = {}) { return this.token({ grant_type: 'refresh_token', refresh_token: token, ...extra }); }
  async authorize(worker) {
    must(this.bridge.cli(['connect', 'stop', '--json']).code === 0, 'closing prior pairing window failed');
    must(this.bridge.cli(['connect', 'start', '--worker', worker, '--json']).code === 0, 'pairing window failed');
    const flow = await this.begin(); must(flow.pairing, 'S256 flow did not reach pairing');
    must(this.bridge.cli(['connect', 'approve', flow.pairing, '--worker', worker, '--replace', '--json']).code === 0, 'owner approval failed');
    const resume = await this.hit(this.bridge.url + flow.location, flow); must(resume.status === 303, 'approved interaction did not redirect');
    const done = await this.hit(new URL(resume.headers.get('location'), this.bridge.url).href, flow);
    const callbackUrl = new URL(done.headers.get('location')); must(callbackUrl.origin === new URL(this.redirect).origin, 'wrong callback');
    const code = callbackUrl.searchParams.get('code'); must(code, 'authorization code absent');
    const fields = { grant_type: 'authorization_code', code, redirect_uri: this.redirect, code_verifier: flow.verifier, resource: this.bridge.resource };
    return fields;
  }
  async connect(worker) {
    const fields = await this.authorize(worker);
    const tokens = await this.token(fields); must(tokens.status === 200 && tokens.body.access_token && tokens.body.refresh_token, 'code exchange failed');
    return { access: tokens.body.access_token, refresh: tokens.body.refresh_token, fields };
  }
}
async function receiver() {
  const events = [];
  const server = http.createServer(async (req, res) => { let body = ''; for await (const b of req) body += b; const parsed = JSON.parse(body); if (parsed.type === 'verification') return res.end(JSON.stringify({ challenge: parsed.challenge })); events.push(parsed); res.end('ok'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); receivers.push(server); return { events, url: `http://127.0.0.1:${server.address().port}/events` };
}
async function eventually(fn, message) { for (let i = 0; i < 120; i++) { if (await fn()) return; await delay(50); } assert.fail(message); }

try {
  const bridge = await new Bridge('main').init();
  const fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: fixture, env: bridge.env, encoding: 'utf8' }); must(r.status === 0, 'local fixture git operation failed'); return r.stdout.trim(); };
  git('init', '-q'); git('config', 'user.email', 'runtime@example.invalid'); git('config', 'user.name', 'Runtime Test');
  fs.writeFileSync(path.join(fixture, 'hello.txt'), 'local runtime fixture\n');
  fs.writeFileSync(path.join(fixture, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: ['/runtime/node', '-e', 'console.log(\"RUNTIME_CHECK_ACTUALLY_RAN\")'], timeout_ms: 10000, output_bytes: 65536 } } }));
  git('add', '.'); git('commit', '-qm', 'Local offline runtime fixture'); const fixtureBase = git('rev-parse', 'HEAD');
  bridge.env.DOT_BRIDGE_GITHUB_URL_TEST_RUNTIME = fixture;
  must(await bridge.start(), 'bridge did not start on loopback');
  must(bridge.cli(['connect', 'allow-callback', callback]).code === 0, 'allow-callback failed');
  const a = new Vendor(bridge), b = new Vendor(bridge);
  must(await a.register() === 201 && await b.register() === 201, 'allowlisted registration failed');
  let A, B;
  await check('oauth_redirect_allowlist_and_pkce_s256', async () => {
    for (const redirect of ['https://evil.example/callback', `${callback}/`, 'http://runtime-vendor.example/callback', 'https://runtime-vendor.example.evil/callback', `${callback}?extra=1`, 'https://runtime-vendor.example:444/callback']) must(await new Vendor(bridge, redirect).register() === 400, 'unallowlisted callback accepted');
    must(await new Vendor(bridge).register([callback, 'https://evil.example/callback']) === 400, 'mixed redirect list accepted');
    must(bridge.cli(['connect', 'start', '--worker', 'dot', '--json']).code === 0, 'window failed');
    for (const extra of [{ code_challenge: null, code_challenge_method: null }, { code_challenge_method: 'plain' }, { redirect_uri: `${callback}/` }]) {
      const denied = await a.begin(extra); must(!denied.pairing, 'invalid PKCE or redirect reached owner pairing');
      if (denied.location && !denied.location.startsWith('/')) must(!new URL(denied.location).searchParams.has('code'), 'invalid flow issued code');
    }
    A = await a.connect('dot'); B = await b.connect('lark');
    must((await bridge.tool(A.access, 'list_pending')).ok, 'S256 positive control failed');
    must((await a.token(A.fields)).status === 400, 'authorization code reuse accepted');
    A = await a.connect('dot');
  });
  // Independent setup if a preceding assertion failed; properties must still execute.
  A ??= await a.connect('dot'); B ??= await b.connect('lark');
  await check('token_audience_resource_refresh_and_revocation', async () => {
    must(bridge.cli(['connect', 'stop', '--json']).code === 0, 'stop window failed');
    must(bridge.cli(['connect', 'start', '--worker', 'dot', '--json']).code === 0, 'window failed');
    must(!(await a.begin({ resource: `${bridge.url}/wrong-resource` })).pairing, 'wrong resource authorization accepted');
    must((await a.refresh(A.refresh, { resource: `${bridge.url}/wrong-resource` })).status === 400, 'refresh resource escalation accepted');
    const codeFields = await a.authorize('dot');
    const deniedExchange = await a.token({ ...codeFields, resource: `${bridge.url}/wrong-resource` });
    must(deniedExchange.status === 400 && !deniedExchange.body.access_token, 'code exchange resource escalation accepted');
    A = await a.connect('dot');
    const refreshed = await a.refresh(A.refresh); must(refreshed.status === 200 && refreshed.body.refresh_token !== A.refresh, 'refresh rotation failed');
    const duplicate = await a.refresh(A.refresh); must(duplicate.status === 200, 'refresh retry inside grace refused');
    assert.deepEqual(duplicate.body, refreshed.body, 'refresh retry issued a different successor');
    must((await bridge.tool(refreshed.body.access_token, 'list_pending')).ok, 'refreshed token unusable');
    // The real provider issues opaque tokens only for the one resource. Owner-only fixture mutation
    // creates a wrong-audience record to exercise the live MCP verifier, without a fake verifier.
    const selected = bridge.asPayload('AccessToken', refreshed.body.access_token);
    const opaque = selected.value.jti ?? selected.id;
    must((await bridge.rpc(opaque, 'tools/list')).status === 200, 'audience fixture token was not initially valid');
    const wrong = { ...selected.value, aud: `${bridge.url}/wrong-resource` };
    bridge.setAsPayload('AccessToken', selected.id, selected.context, wrong);
    try {
      // Same previously-valid bearer, altered audience only; never print it.
      must((await bridge.rpc(opaque, 'tools/list')).status === 401, 'wrong audience accepted by MCP');
    } finally { bridge.setAsPayload('AccessToken', selected.id, selected.context, selected.value); }
    await delay(5100); // Cross the fixed five-second grace; retries must not extend it.
    must((await a.refresh(A.refresh)).status === 400, 'refresh replay outside grace accepted');
    must((await bridge.rpc(refreshed.body.access_token, 'tools/list')).status === 401, 'refresh replay did not revoke family');
    A = await a.connect('dot');
    must(bridge.cli(['connect', 'revoke', 'dot', '--json']).code === 0, 'revoke failed');
    must((await bridge.rpc(A.access, 'tools/list')).status === 401, 'revoked access token accepted');
    must((await a.refresh(A.refresh)).status === 400, 'revoked refresh token accepted');
    A = await a.connect('dot');
  });
  await check('worker_a_cannot_access_worker_b_jobs_or_messages', async () => {
    const jobA = bridge.submit('dot'), jobB = bridge.submit('lark');
    const msg = bridge.cli(['tell', 'private worker B message', '--worker', 'lark', '--json']); must(msg.code === 0, 'message fixture failed'); const message = JSON.parse(msg.stdout).message_id;
    const listed = await bridge.tool(A.access, 'list_pending'); must(listed.ok, 'A list failed');
    must(listed.value.assignments.some(x => x.request_id === jobA), 'own job missing');
    must(!listed.value.assignments.some(x => [jobB, message].includes(x.request_id)), 'B job/message leaked in list');
    const claimB = await bridge.tool(B.access, 'claim', { request_id: jobB, claimant: 'lark' }); must(claimB.ok, 'B cannot claim own job');
    for (const [name, args] of [['claim', { request_id: jobB, claimant: 'dot' }], ['get', { request_id: jobB }], ['finish', { request_id: jobB, claim_id: claimB.value.claim_id, outcome: 'completed', summary: 'stolen', result: 'stolen' }], ['get', { request_id: message }], ['ack_message', { message_id: message }], ['claim', { request_id: message, claimant: 'dot' }]]) {
      const denied = await bridge.tool(A.access, name, args);
      const absentArgs = { ...args, ...(args.request_id ? { request_id: id() } : { message_id: `msg_${randomUUID()}` }) };
      const absent = await bridge.tool(A.access, name, absentArgs);
      must(!denied.ok && !absent.ok && denied.error === absent.error, `cross-worker ${name} differs from an unknown ID`);
    }
    must((await bridge.tool(B.access, 'get', { request_id: message })).ok, 'B cannot read own message');
    must((await bridge.tool(B.access, 'ack_message', { message_id: message })).ok, 'B cannot acknowledge own message');
    must((await bridge.tool(B.access, 'finish', { request_id: jobB, claim_id: claimB.value.claim_id, outcome: 'completed', summary: 'B done', result: 'B result' })).ok, 'B finish failed');
  });
  await check('revoked_connection_stops_webhook_notifications', async () => {
    const sink = await receiver();
    const sub = await bridge.rpc(B.access, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: sink.url, secret: `whsec_${randomBytes(32).toString('base64')}` } });
    must(sub.status === 200 && sub.body.result?.id, 'webhook subscribe failed'); const subscription = sub.body.result.id;
    const before = bridge.submit('lark');
    await eventually(() => sink.events.some(e => e.data?.request_id === before), 'positive webhook not delivered');
    bridge.db("UPDATE operator_state SET paused_at=?,reason='runtime webhook test' WHERE id=1", new Date().toISOString());
    const queued = bridge.submit('lark', { queueAnyway: true });
    must(bridge.db("SELECT id FROM notifications WHERE subscription_id=? AND request_id=? AND state='pending'", subscription, queued).length === 1, 'queued webhook fixture missing');
    must(bridge.cli(['connect', 'revoke', 'lark', '--json']).code === 0, 'connection revoke failed');
    must(bridge.db("SELECT state FROM notifications WHERE subscription_id=? AND request_id=?", subscription, queued)[0].state === 'suppressed', 'queued webhook survived revocation');
    bridge.db("UPDATE operator_state SET paused_at=NULL,reason=NULL WHERE id=1");
    must(bridge.db('SELECT state FROM subscriptions WHERE id=?', subscription)[0].state === 'revoked', 'subscription remained active');
    const count = sink.events.length; const after = bridge.submit('lark'); await delay(1700);
    must(sink.events.length === count && !sink.events.some(e => e.data?.request_id === after), 'revoked connection received webhook');
    must((await bridge.rpc(B.access, 'tools/list')).status === 401, 'revoked connection retained MCP access');
  });
  await check('lease_takeover_and_epoch_fence_stale_finishes', async () => {
    const job = bridge.submit('dot'); const first = await bridge.tool(A.access, 'claim', { request_id: job, claimant: 'holder-one' }); must(first.ok, 'initial claim failed');
    must(!(await bridge.tool(A.access, 'claim', { request_id: job, claimant: 'holder-two' })).ok, 'unexpired lease stolen');
    // Age only the isolated claim; avoids sleeping the production one-hour lease.
    bridge.db('UPDATE claims SET last_claim_activity_at=?,last_progress_at=?,lease_deadline_at=?,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', job);
    const next = await bridge.tool(A.access, 'claim', { request_id: job, claimant: 'holder-two' }); must(next.ok, 'expired lease takeover failed');
    must(next.value.epoch === first.value.epoch + 1 && next.value.claim_id !== first.value.claim_id, 'takeover failed to advance epoch and claim');
    const finish = claim => ({ request_id: job, claim_id: claim, outcome: 'completed', summary: 'done', result: 'done' });
    must(!(await bridge.tool(A.access, 'finish', finish(first.value.claim_id))).ok, 'stale finish accepted');
    must(bridge.db('SELECT request_id FROM reports WHERE request_id=?', job).length === 0, 'stale finish wrote report');
    must((await bridge.tool(A.access, 'finish', finish(next.value.claim_id))).ok, 'new epoch finish failed');
    must(!(await bridge.tool(A.access, 'finish', finish(first.value.claim_id))).ok, 'stale finish overwrote completed report');
  });
  await check('missing_workers_json_refuses_startup_after_profile_use_without_legacy_opt_in', async () => {
    const isolated = await new Bridge('missing-profile').init(); must(await isolated.start(), 'profile-mode positive startup failed'); await isolated.stop();
    fs.unlinkSync(path.join(isolated.config, 'workers.json'));
    must(!await isolated.start(), 'missing workers.json started after profile use');
    must(/worker profile.*missing/.test(isolated.stderr), 'refused for unrelated reason'); await isolated.stop();
    isolated.env.DOT_BRIDGE_LEGACY_PROFILE = '1';
    must(await isolated.start(), 'explicit legacy opt-in did not permit startup'); await isolated.stop();
    // Compatibility rule: an install that has a database but never loaded a profile keeps legacy mode, so today's
    // single-worker installs start unchanged. A home with no database must name its worker.
    const old = await new Bridge('old-missing-profile').init();
    fs.unlinkSync(path.join(old.config, 'workers.json'));
    fs.mkdirSync(path.join(old.home, '.local/share/dot-bridge'), { recursive: true }); { const fixture = new DatabaseSync(path.join(old.home, '.local/share/dot-bridge/bridge.db')); fixture.exec('PRAGMA user_version=1'); fixture.close(); }
    const oldStarted = await old.start(); await old.stop();
    must(oldStarted, 'an existing never-profiled install without workers.json must keep legacy startup: ' + old.stderr.slice(-400));
    const fresh = await new Bridge('fresh-missing-profile').init();
    fs.unlinkSync(path.join(fresh.config, 'workers.json'));
    const started = await fresh.start(); const freshErr = fresh.stderr; await fresh.stop();
    must(!started && /no worker is configured/.test(freshErr), 'a fresh home without workers.json must refuse and name the fix');
  });
  await check('check_evidence_and_receipts_cannot_be_forged_by_tool_arguments', async () => {
    const job = bridge.submit('dot', { execution: 'worker' }); const held = await bridge.tool(A.access, 'claim', { request_id: job, claimant: 'dot' }); must(held.ok, 'evidence fixture claim failed');
    const base = { request_id: job, claim_id: held.value.claim_id };
    const finish = { ...base, outcome: 'completed', summary: 'worker report', result: 'worker says tests passed' };
    for (const field of ['evidence', 'workspace_evidence', 'checks', 'trust', 'receipt_id', 'worker', 'subject']) {
      const forged = field === 'trust' ? 'bridge_verified' : field === 'receipt_id' ? 'report_forged' : { trust: 'bridge_verified', exit_code: 0 };
      must(!(await bridge.tool(A.access, 'finish', { ...finish, [field]: forged })).ok, `finish accepted forged ${field}`);
    }
    for (const name of ['run_check', 'workspace_result']) must(!(await bridge.tool(A.access, name, { ...base, ...(name === 'run_check' ? { check_id: 'default' } : {}), evidence: { trust: 'bridge_verified' }, receipt_id: 'forged' })).ok, `${name} accepted forged evidence`);
    must(bridge.db('SELECT request_id FROM reports WHERE request_id=?', job).length === 0, 'forgery wrote report');
    must(bridge.db('SELECT id FROM check_runs WHERE request_id=?', job).length === 0, 'forgery wrote check evidence');
    must((await bridge.tool(A.access, 'finish', finish)).ok, 'valid finish failed');
    const shown = await bridge.tool(A.access, 'get', { request_id: job }); must(shown.ok, 'finished report unreadable');
    must(shown.value.report.trust === 'worker_attested', 'worker report promoted to bridge_verified');
    must(shown.value.report.receipt_id.startsWith('report_') && shown.value.report.receipt_id !== 'report_forged', 'receipt not generated by bridge');
    must(shown.value.checks.length === 0, 'worker report fabricated check receipts');
    // New host jobs are refused at admission (execution-capability-test). Model
    // a previously admitted host job to keep the check/receipt forgery guards covered.
    const hostJob = bridge.submit('dot', { execution: 'none', implementation: true, base: fixtureBase });
    bridge.db("UPDATE assignments SET execution='host' WHERE request_id=?", hostJob);
    const hostClaim = await bridge.tool(A.access, 'claim', { request_id: hostJob, claimant: 'host-check' }); must(hostClaim.ok, 'host check claim failed');
    const hostArgs = { request_id: hostJob, claim_id: hostClaim.value.claim_id };
    for (const field of ['trust', 'exit_code', 'evidence', 'receipt_id', 'argv']) {
      must(!(await bridge.tool(A.access, 'run_check', { ...hostArgs, check_id: 'default', [field]: 'forged' })).ok, `run_check accepted forged ${field}`);
    }
    must(bridge.db('SELECT id FROM check_runs WHERE request_id=?', hostJob).length === 0, 'forged check wrote a receipt');
    const started = await bridge.tool(A.access, 'run_check', { ...hostArgs, check_id: 'default' });
    must(started.ok && started.value.status === 'capability_not_available', 'uncontained host execution was not refused');
    must(/scope_paths|resource_limits_unavailable/.test(started.value.reason), 'host refusal lacks its boundary');
    must(bridge.db('SELECT id FROM check_jobs WHERE request_id=?', hostJob).length === 0, 'refused check wrote a run');
    const actual = await bridge.tool(A.access, 'workspace_result', hostArgs); must(actual.ok, 'workspace result failed');
    must(actual.value.checks.length === 0, 'refused check acquired bridge evidence');
    must((await bridge.tool(A.access, 'finish', { ...hostArgs, outcome: 'completed', summary: 'host check unavailable', result: 'no check ran' })).ok, 'finish after refusal failed');
    const owner = bridge.cli(['get', hostJob, '--json']); must(owner.code === 0, 'owner cannot retrieve refused-check job');
    must(JSON.parse(owner.stdout).checks.length === 0, 'owner view fabricated a check receipt');
  });
} finally {
  for (const bridge of bridges) await bridge.stop();
  for (const server of receivers) await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  if (process.env.RUNTIME_RESULTS) fs.writeFileSync(process.env.RUNTIME_RESULTS, JSON.stringify(results, null, 2) + '\n');
}
process.exitCode = results.length === 7 && results.every(r => r.status === 'PASS') ? 0 : 1;
