#!/usr/bin/env node
// Repository and artifact tools with no sandbox: a built-in-auth bridge with workspace on and NO host executor (no bwrap, any platform).
// Patch, artifact and workspace_result work; run_check is refused with a clear message. Local fixture repo only, no network.
// Run: node scripts/workspace-nosandbox-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';
import './runtime-loopback-guard.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

process.umask(0o077);
assert.throws(() => net.connect({ host: '198.51.100.1', port: 9 }), /forbids non-loopback network/);
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const temp = path.join(os.homedir(), '.tmp');
fs.mkdirSync(temp, { recursive: true });
const root = fs.mkdtempSync(path.join(temp, 'portable-runtime-'));
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
    this.env = fixtureEnv(this.home, { NODE_ENV: 'test', NODE_OPTIONS: `--import=${guard}`, DOT_BRIDGE_AUTH_MODE: 'builtin', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_TEST_HIDE_BWRAP: '1', DOT_BRIDGE_MIN_FREE_BYTES: '0', DOT_BRIDGE_PORT: String(this.port), DOT_BRIDGE_WORKSPACE_ROOT: path.join(this.home, 'work') });
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
  async rpc(access, method, params = {}) { const r = await fetch(this.resource, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null }; }
  async tool(access, name, args = {}) { const r = await this.rpc(access, 'tools/call', { name, arguments: args }); if (r.status !== 200 || r.body?.error || r.body?.result?.isError) return { ok: false, status: r.status, error: r.body?.error?.message ?? r.body?.result?.content?.[0]?.text }; return { ok: true, value: JSON.parse(r.body.result.content[0].text) }; }
  submit(worker, { execution = 'none', implementation = false, base } = {}) {
    const request = id(); const assignment = { schema_version: 1, request_id: request, brief: 'Review the local fixture and report security observations.', inputs: base ? [{ github_repo: 'test/runtime', base_sha: base }] : [{ revision: 'local-fixture' }], expected_output: 'A report for owner review', execution_scope: implementation ? 'implementation' : 'read-only', ...(base ? { scope_paths: ['hello.txt'] } : {}) };
    const r = this.cli(['submit', '--stdin', '--json', '--worker', worker, '--execution', execution], JSON.stringify(assignment));
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
  const a = new Vendor(bridge);
  must(await a.register() === 201, 'registration failed');

  await check('repository_and_artifact_tools_work_without_a_host_executor', async () => {
    const A = await a.connect('dot');
    // execution=none is the built-in-auth recommended profile; the executor is also hidden, so nothing could run a check.
    const job = bridge.submit('dot', { execution: 'none', implementation: true, base: fixtureBase });
    const claim = await bridge.tool(A.access, 'claim', { request_id: job, claimant: 'nosandbox' }); must(claim.ok, 'claim failed');
    const args = { request_id: job, claim_id: claim.value.claim_id };
    const names = (await bridge.rpc(A.access, 'tools/list')).body.result.tools.map(t => t.name);
    for (const n of ['read_file', 'list_files', 'apply_patch', 'workspace_result', 'artifact_chunk', 'run_check']) must(names.includes(n), `tools/list lacks ${n}`);
    const listed = await bridge.tool(A.access, 'list_files', args); must(listed.ok && listed.value.files.includes('hello.txt'), 'list_files failed');
    const read = await bridge.tool(A.access, 'read_file', { ...args, path: 'hello.txt' }); must(read.ok && read.value.text === 'local runtime fixture\n', 'read_file failed');
    const patch = 'diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-local runtime fixture\n+patched without a sandbox\n';
    const applied = await bridge.tool(A.access, 'apply_patch', { ...args, patch }); must(applied.ok, `apply_patch failed: ${applied.error}`);
    const refused = await bridge.tool(A.access, 'run_check', { ...args, check_id: 'default' });
    const refusalText = JSON.stringify(refused); must(refused.ok && refused.value.status === 'capability_not_available' && /execution=none; run_check needs execution=host/.test(refused.value.reason), `run_check refusal unclear: ${refusalText}`);
    const result = await bridge.tool(A.access, 'workspace_result', args); must(result.ok, 'workspace_result failed');
    must(JSON.stringify(result.value).includes('patched without a sandbox'), 'workspace_result does not show the diff');
    const bytes = Buffer.from(patch), artifact = `art_${randomUUID()}`, digest = createHash('sha256').update(bytes).digest('hex');
    const chunk = await bridge.tool(A.access, 'artifact_chunk', { ...args, artifact_id: artifact, offset: 0, data_base64: bytes.toString('base64'), final: true, sha256: digest }); must(chunk.ok, `artifact_chunk failed: ${chunk.error}`);
    const finished = await bridge.tool(A.access, 'finish', { ...args, outcome: 'completed', summary: 'patched', result: 'patch attached', artifact_ids: [artifact] }); must(finished.ok, `finish failed: ${finished.error}`);
    // `wait` alone must record the artifact owner: no `get` runs before `artifact`.
    const waited = bridge.cli(['wait', job, '--timeout', '5', '--json']); must(waited.code === 0, `owner wait failed: ${waited.stderr.slice(0, 200)}`);
    const waitedIds = JSON.parse(waited.stdout).artifact_ids ?? []; must(waitedIds.length > 0, 'wait output lists no artifact');
    const digests = waitedIds.map((id, i) => {
      const file = path.join(root, `fetched-${i}.patch`), fetched = bridge.cli(['artifact', id, '--output', file]);
      must(fetched.code === 0, `owner could not fetch ${id} after wait only: ${fetched.stderr.slice(0, 200)}`);
      return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    });
    must(digests.includes(digest), 'no fetched artifact matches the upload');
    const owner = bridge.cli(['get', job, '--json']); must(owner.code === 0 && JSON.parse(owner.stdout).report, 'owner cannot read the finished report');
  });
} finally {
  for (const bridge of bridges) await bridge.stop();
  for (const server of receivers) await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
process.exitCode = results.length === 1 && results.every(r => r.status === 'PASS') ? 0 : 1;
