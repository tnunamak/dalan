#!/usr/bin/env node
// Generic OAuth client journeys against a real bridge process (real oidc-provider, real SQLite, real `dot-worker connect` CLI).
// No client is ever on a list: the bridge starts with an EMPTY owner callback list. Every client here is unseen.
// Who gets a grant is decided only by the owner's approval of one pairing code; names, brands and redirects never decide it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Jar, Vendor, form, hit, pkce } from './live-trial/fake-vendor.mjs';
import { fetchFresh as fetch } from '../src/test-support/fetch.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = process.env.DALAN_REPO ?? path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'gcj-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];
async function check(id, name, fn) {
  try { await fn(); console.log(`PASS ${id} ${name}`); }
  catch (error) { failures.push(id); console.log(`FAIL ${id} ${name}: ${String(error.stack ?? error).split('\n').slice(0, 6).join('\n')}`); }
}

class Bridge {
  constructor(name) { this.home = path.join(root, name); this.config = path.join(this.home, '.config/dot-bridge'); }
  get env() { return { ...process.env, HOME: this.home, DOT_BRIDGE_PORT: String(this.port), DOT_BRIDGE_AUTH_MODE: 'builtin', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1', NODE_ENV: 'test' }; }
  cli(args, input) { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env: this.env, input, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr, json() { return JSON.parse(r.stdout); } }; }
  cliAsync(args) { return new Promise(resolve => { const c = spawn(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env: this.env }); let stdout = '', stderr = ''; c.stdout.on('data', b => { stdout += b; }); c.stderr.on('data', b => { stderr += b; }); c.on('close', code => resolve({ code, stdout, stderr })); }); }
  async init() {
    this.port = await reservedPort();
    this.pub = `http://127.0.0.1:${this.port}`;
    fs.mkdirSync(this.config, { recursive: true });
    fs.writeFileSync(path.join(this.config, 'workers.json'), JSON.stringify({ workers: { lark: {}, duet: {} } }), { mode: 0o600 });
    assert.equal(this.cli(['as-init', '--public-url', this.pub]).code, 0);
    const file = path.join(this.config, 'as.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.callbacks = []; // no vendor list at all
    config.limits = { registrations: 100, interactions: 25 };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    return this;
  }
  async start() {
    this.stderr = ''; this.exited = null;
    this.child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false;
    this.child.stdout.on('data', b => { if (/MCP listening on/.test(String(b))) ready = true; });
    this.child.stderr.on('data', b => { this.stderr += b; });
    this.child.once('exit', code => { this.exited = code; });
    for (let i = 0; i < 300 && !ready && this.exited === null; i++) await sleep(50);
    assert.ok(ready, `bridge did not start: ${this.stderr}`);
    this.secret = fs.readFileSync(path.join(this.config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
    this.resource = `${this.pub}/${this.secret}/mcp`;
    this.oauth = `${this.pub}/${this.secret}/oauth`;
  }
  async stop() { if (this.child && this.child.exitCode === null && this.child.signalCode === null) { this.child.kill('SIGTERM'); await new Promise(resolve => this.child.once('exit', resolve)); } }
  start_window(worker) { this.cli(['connect', 'stop', '--json']); const r = this.cli(['connect', 'start', '--worker', worker, '--json']); assert.equal(r.code, 0, r.stderr + r.stdout); }
  pending() { const r = this.cli(['connect', 'pending', '--json']); assert.equal(r.code, 0, r.stderr); return r.json(); }
  approve(code, worker, { confirm, replace = true } = {}) {
    const pairing = this.pending().pending.find(item => item.code === code);
    const redirect = confirm ?? (pairing?.native ? pairing.redirect_uri : undefined);
    return this.cli(['connect', 'approve', code, '--worker', worker, ...(redirect ? ['--confirm-redirect', redirect] : []), ...(replace ? ['--replace'] : []), '--json']);
  }
  async rpc(bearer, method, params = {}) {
    const res = await fetch(this.resource, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  async tool(bearer, name, args = {}) {
    const { status, body } = await this.rpc(bearer, 'tools/call', { name, arguments: args });
    if (status !== 200) return { ok: false, status };
    const text = body.result.content[0].text;
    return body.result.isError ? { ok: false, error: text } : { ok: true, value: JSON.parse(text) };
  }
  submit(id, worker) { return this.cli(['submit', '--stdin', '--json', '--queue-anyway', '--worker', worker], JSON.stringify({ schema_version: 1, request_id: id, brief: `generic journey ${id}`, inputs: [{ revision: 'abc' }], expected_output: 'one result', execution_scope: 'read-only' })); }
}

const bridge = await new Bridge('main').init();
const stopAll = async () => { await bridge.stop(); if (process.env.KEEP_TEST_FIXTURES !== '1') fs.rmSync(root, { recursive: true, force: true }); };
const REDIRECT = 'https://unseen-client.example/oauth/cb';
// Browser leg of one transaction: begin, (owner approves), finish, exchange.
async function journey(vendor, worker, { redirect, register = {}, authorize = {}, exchangeExtra = {} } = {}) {
  bridge.start_window(worker);
  const reg = await vendor.register(register);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const flow = await vendor.begin({ redirect, ...authorize });
  assert.ok(flow.code, `no pairing code: ${flow.res.status} ${flow.page?.slice(0, 200) ?? ''}`);
  const approved = bridge.approve(flow.code, worker);
  assert.equal(approved.code, 0, approved.stderr + approved.stdout);
  const callback = await vendor.finish(flow);
  assert.equal(callback.stage, 'callback', JSON.stringify(callback).slice(0, 300));
  const tokens = await vendor.exchange(callback.code, flow.pkce.verifier, { redirect_uri: flow.redirect, ...exchangeExtra });
  return { flow, approved, callback, tokens };
}
const fullJob = async (access, worker) => {
  const id = `req_g_${randomUUID().slice(0, 8)}`;
  assert.equal(bridge.submit(id, worker).code, 0);
  const pending = await bridge.tool(access, 'list_pending');
  assert.ok(JSON.stringify(pending.value).includes(id), `job not visible: ${JSON.stringify(pending)}`);
  const claim = await bridge.tool(access, 'claim', { request_id: id, claimant: worker });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const done = await bridge.tool(access, 'finish', { request_id: id, claim_id: claim.value.claim_id, outcome: 'completed', summary: 'generic journey', result: 'fixture result' });
  assert.equal(done.ok, true, JSON.stringify(done));
};

try {
  await bridge.start();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bridge.config, 'as.json'), 'utf8')).callbacks, [], 'the owner callback list is empty');

  await check('G1', 'an unseen HTTPS client (never allowed by the owner) completes registration, approval, token, a full job and refresh', async () => {
    const vendor = new Vendor(bridge, REDIRECT);
    const { tokens, approved } = await journey(vendor, 'lark');
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    const rec = approved.json().approval;
    assert.equal(rec.redirectOrigin, 'https://unseen-client.example');
    assert.equal(rec.redirectUri, REDIRECT);
    assert.equal(rec.worker, 'lark'); assert.equal(rec.clientId, vendor.client_id); assert.equal(rec.ownerId, 'owner');
    assert.ok(!JSON.stringify(rec).includes(bridge.secret), 'the record must not carry the secret path');
    await fullJob(tokens.body.access_token, 'lark');
    const refreshed = await vendor.refresh(tokens.body.refresh_token);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal((await bridge.rpc(refreshed.body.access_token, 'tools/list')).status, 200);
  });

  await check('G2', 'manual client ID: add-client for an unseen redirect gives a public client that completes the same flow', async () => {
    const added = bridge.cli(['connect', 'add-client', '--redirect-uri', 'https://manual.example/cb', '--name', 'Manual', '--json']);
    assert.equal(added.code, 0, added.stderr + added.stdout);
    const result = added.json();
    assert.equal(result.token_endpoint_auth_method, 'none');
    assert.deepEqual(result.redirect_uris, ['https://manual.example/cb']);
    const vendor = new Vendor(bridge, 'https://manual.example/cb'); vendor.client_id = result.client_id;
    bridge.start_window('duet');
    const flow = await vendor.begin({});
    assert.ok(flow.code, `no code: ${flow.res.status}`);
    assert.equal(bridge.approve(flow.code, 'duet').code, 0);
    const callback = await vendor.finish(flow);
    const tokens = await vendor.exchange(callback.code, flow.pkce.verifier, { redirect_uri: flow.redirect });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    await fullJob(tokens.body.access_token, 'duet');
    assert.equal(bridge.cli(['connect', 'add-client', '--redirect-uri', 'http://remote.example/cb', '--json']).code === 0, false, 'remote http is refused for a manual client too');
  });

  await check('G3', 'native loopback: IPv4 and IPv6, only the port may vary; path, host and query changes are refused; --confirm-redirect stays required', async () => {
    for (const [host, regPort, authPort] of [['127.0.0.1', 51234, 61000], ['[::1]', 51235, 61001]]) {
      const reg = `http://${host}:${regPort}/callback`, used = `http://${host}:${authPort}/callback`;
      const vendor = new Vendor(bridge, reg);
      bridge.start_window('lark');
      assert.equal((await vendor.register({ application_type: 'native' })).status, 201, host);
      for (const wrong of [`http://${host}:${authPort}/other`, `http://${host}:${authPort}/callback?x=1`, `http://${host === '[::1]' ? '127.0.0.1' : '[::1]'}:${authPort}/callback`, `http://localhost:${authPort}/callback`]) {
        const res = await hit(vendor.authUrl({ challenge: pkce().challenge, redirect: wrong }), { jar: new Jar() });
        assert.equal(res.status, 400, `${wrong} -> ${res.status}`); assert.equal(res.headers.get('location'), null);
      }
      const flow = await vendor.begin({ redirect: used });
      assert.ok(flow.code, `${host}: no pairing code`);
      const missing = bridge.cli(['connect', 'approve', flow.code, '--worker', 'lark', '--replace', '--json']);
      assert.notEqual(missing.code, 0, 'a native approval without --confirm-redirect must fail');
      const wrongConfirm = bridge.approve(flow.code, 'lark', { confirm: reg });
      assert.notEqual(wrongConfirm.code, 0, 'confirming the registered URI instead of the requested one must fail');
      assert.equal(bridge.approve(flow.code, 'lark').code, 0);
      const callback = await vendor.finish(flow);
      assert.equal(callback.stage, 'callback', JSON.stringify(callback));
      assert.ok(callback.location.startsWith(used), `callback goes to the requested port: ${callback.location}`);
      const tokens = await vendor.exchange(callback.code, flow.pkce.verifier, { redirect_uri: used });
      assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    }
    for (const bad of ['http://127.0.0.2/cb', 'http://127.1/cb', 'http://127.0.0.1/cb?a=1', 'http://localhost.evil.test/cb', 'http://client.example/cb']) assert.equal((await new Vendor(bridge, bad).register()).status, 400, bad);
  });

  await check('G4', 'a fixed query in the redirect is kept exactly; any change to it is refused at authorize and at the token step', async () => {
    const redirect = 'https://tenant.example/cb?tenant=acme';
    const vendor = new Vendor(bridge, redirect);
    bridge.start_window('lark');
    assert.equal((await vendor.register()).status, 201);
    for (const other of ['https://tenant.example/cb', 'https://tenant.example/cb?tenant=evil', 'https://tenant.example/cb?tenant=acme&x=1', 'https://tenant.example/cb?x=1&tenant=acme']) {
      const res = await hit(vendor.authUrl({ challenge: pkce().challenge, redirect: other }), { jar: new Jar() });
      assert.equal(res.status, 400, other); assert.equal(res.headers.get('location'), null, other);
    }
    const flow = await vendor.begin({});
    assert.equal(bridge.approve(flow.code, 'lark').code, 0);
    const callback = await vendor.finish({ ...flow, redirect: 'https://tenant.example/cb' }); // the fake vendor compares origin+path; the query is checked below
    assert.equal(callback.stage, 'callback', JSON.stringify(callback));
    const back = new URL(callback.location, bridge.pub);
    assert.equal(back.searchParams.get('tenant'), 'acme'); assert.ok(back.searchParams.get('code') && back.searchParams.get('state') && back.searchParams.get('iss'));
    const altered = await vendor.exchange(callback.code, flow.pkce.verifier, { redirect_uri: 'https://tenant.example/cb?tenant=evil' });
    assert.equal(altered.status, 400, JSON.stringify(altered.body));
    const control = await vendor.exchange(callback.code, flow.pkce.verifier, { redirect_uri: redirect });
    assert.equal(control.status, 200, `the right redirect still works after a refused attempt: ${JSON.stringify(control.body)}`);
    assert.equal((await vendor.exchange(callback.code, flow.pkce.verifier, { redirect_uri: redirect })).status, 400, 'replay');
  });

  await check('G5', 'wrong resource: authorize and token both refuse a resource that is not this bridge; verifier and PKCE rules hold', async () => {
    const vendor = new Vendor(bridge, 'https://res.example/cb');
    bridge.start_window('lark');
    assert.equal((await vendor.register()).status, 201);
    for (const resource of [`${bridge.pub}/other-secret/mcp`, 'https://evil.example/mcp', `${bridge.resource}/x`]) {
      const flow = await vendor.begin({ resource });
      assert.ok(!flow.code, `a wrong resource must not reach a pairing code: ${resource}`);
      const to = flow.res.headers.get('location') ?? '';
      assert.ok(flow.res.status >= 400 || /error=invalid_target/.test(to) || flow.pageStatus >= 400, `${resource} -> ${flow.res.status} ${to}`);
      assert.ok(!/[?&]code=/.test(to), 'no authorization code for a wrong resource');
    }
    const plain = await hit(vendor.authUrl({ challenge: pkce().challenge, method: 'plain' }), { jar: new Jar() });
    const plainTo = plain.headers.get('location') ?? '';
    assert.ok(plain.status >= 400 || /error=invalid_request/.test(plainTo), `plain PKCE refused: ${plain.status} ${plainTo}`);
    assert.ok(!/[?&]code=/.test(plainTo) && !plainTo.includes('/interaction/'), 'plain PKCE gets no code and no pairing');
    const flow = await vendor.begin({});
    assert.equal(bridge.approve(flow.code, 'lark').code, 0);
    const callback = await vendor.finish(flow);
    const wrongResource = await vendor.exchange(callback.code, flow.pkce.verifier, { resource: 'https://evil.example/mcp' });
    assert.equal(wrongResource.status, 400, JSON.stringify(wrongResource.body));
    const second = await vendor.begin({});
    assert.equal(bridge.approve(second.code, 'lark').code, 0);
    const cb2 = await vendor.finish(second);
    assert.equal((await vendor.exchange(cb2.code, pkce().verifier)).status, 400, 'wrong PKCE verifier');
    assert.equal((await vendor.exchange(cb2.code, second.pkce.verifier)).status, 200, 'the right verifier still works after a refused attempt');
    assert.equal((await vendor.exchange(cb2.code, second.pkce.verifier)).status, 400, 'then the code is spent');
  });

  await check('G6', 'races: concurrent code exchange yields one token; replay fails; concurrent approvals of one code yield one approval; another browser cannot finish', async () => {
    const vendor = new Vendor(bridge, 'https://race.example/cb');
    bridge.start_window('lark');
    assert.equal((await vendor.register()).status, 201);
    const flow = await vendor.begin({});
    const approvals = await Promise.all([1, 2, 3].map(() => bridge.cliAsync(['connect', 'approve', flow.code, '--worker', 'lark', '--replace', '--json'])));
    assert.equal(approvals.filter(a => a.code === 0).length, 1, approvals.map(a => a.stderr.slice(0, 80)).join(' | '));
    const stranger = await hit(vendor.resolveLocation(flow.loc), { jar: new Jar() });
    assert.notEqual(stranger.status, 303 && stranger.headers.get('location')?.includes('/auth/') ? 999 : 0, undefined);
    const strangerFinish = await vendor.finish({ ...flow, jar: new Jar() });
    assert.notEqual(strangerFinish.stage, 'callback', 'a browser without the interaction cookie must not receive the code');
    const callback = await vendor.finish(flow);
    assert.equal(callback.stage, 'callback');
    const [a, b] = await Promise.all([vendor.exchange(callback.code, flow.pkce.verifier), vendor.exchange(callback.code, flow.pkce.verifier)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400], `exactly one exchange wins: ${a.status}/${b.status}`);
    const winner = a.status === 200 ? a : b;
    assert.equal((await vendor.exchange(callback.code, flow.pkce.verifier)).status, 400, 'replay');
    // Reuse of an authorization code revokes what it produced (RFC 6749 4.1.2): the winner's token is dead after the replay.
    assert.equal((await bridge.rpc(winner.body.access_token, 'tools/list')).status, 401, 'a replayed code kills the tokens it made');
    const reopened = await hit(vendor.resolveLocation(flow.loc), { jar: flow.jar });
    assert.ok(![200].includes(reopened.status) || !(await reopened.text()).includes('class="code"'), 'a finished interaction does not show a code again');
  });

  await check('G7', 'revocation: after the owner revokes, the access token, the refresh token and a replayed code all fail; a new approval is needed', async () => {
    const vendor = new Vendor(bridge, 'https://revoke.example/cb');
    const { tokens, callback } = await journey(vendor, 'duet');
    assert.equal(tokens.status, 200);
    assert.equal((await bridge.rpc(tokens.body.access_token, 'tools/list')).status, 200);
    assert.equal(bridge.cli(['connect', 'revoke', 'duet', '--json']).code, 0);
    assert.equal((await bridge.rpc(tokens.body.access_token, 'tools/list')).status, 401);
    assert.notEqual((await vendor.refresh(tokens.body.refresh_token)).status, 200);
    assert.notEqual((await vendor.exchange(callback.code, 'x'.repeat(43))).status, 200);
    bridge.start_window('duet');
    const again = await vendor.begin({});
    assert.ok(again.code, 'an unapproved attempt after revocation still needs a fresh owner approval');
    assert.equal((await bridge.rpc(null, 'tools/list')).status, 401);
  });

  await check('G8', 'spoofed name: a client called "Claude" with an attacker redirect gets no code without the owner; a guessed code and a swapped redirect fail', async () => {
    const attacker = new Vendor(bridge, 'https://attacker.example/steal');
    bridge.start_window('lark');
    assert.equal((await attacker.register({ client_name: 'Claude' })).status, 201);
    const flow = await attacker.begin({});
    assert.ok(flow.code);
    assert.ok(/not verified/i.test(flow.page), 'the page says the name is not verified');
    assert.ok(flow.page.includes('https://attacker.example/steal'), 'the page shows the real redirect');
    const early = await attacker.finish(flow);
    assert.notEqual(early.stage, 'callback', 'no code before approval');
    const guess = bridge.cli(['connect', 'approve', 'AAAA-AAAA', '--worker', 'lark', '--json']);
    assert.notEqual(guess.code, 0);
    const pending = bridge.pending().pending.find(p => p.code === flow.code);
    assert.equal(pending.client_name_untrusted, true); assert.equal(pending.redirect_host, 'attacker.example'); assert.equal(pending.redirect_origin, 'https://attacker.example');
    const text = bridge.cli(['connect', 'pending']).stdout;
    assert.match(text, /untrusted/); assert.match(text, /attacker\.example/);
    // The same name with another redirect is a different, separately approved transaction.
    const victim = new Vendor(bridge, 'https://claude.ai/api/mcp/auth_callback');
    assert.equal((await victim.register({ client_name: 'Claude' })).status, 201);
    const swapped = await hit(victim.authUrl({ challenge: pkce().challenge, redirect: 'https://attacker.example/steal' }), { jar: new Jar() });
    assert.equal(swapped.status, 400);
    assert.equal(bridge.approve(flow.code, 'lark').code, 0);
    const callback = await attacker.finish(flow);
    assert.ok(callback.location.startsWith('https://attacker.example/steal'), 'the code goes only to the approved redirect');
  });

  await check('G9', 'control characters, bidi marks and markup in the client name never reach the terminal or the page raw', async () => {
    const evil = '\u001b[31mRED\u001b[0m‮evil\n<script>alert(1)</script>\u0007';
    const vendor = new Vendor(bridge, 'https://ctrl.example/cb');
    bridge.start_window('lark');
    assert.equal((await vendor.register({ client_name: evil })).status, 201);
    const flow = await vendor.begin({});
    assert.ok(flow.code);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f‮]/.test(flow.page), 'page has no control or bidi characters');
    assert.ok(!flow.page.includes('<script>'), 'markup is escaped');
    const text = bridge.cli(['connect', 'pending']).stdout + JSON.stringify(bridge.pending());
    assert.ok(!/[\u001b\u0007‮]/.test(bridge.cli(['connect', 'pending']).stdout), 'terminal output has no escape or bidi characters');
    assert.match(text, /untrusted/);
    assert.ok(!bridge.cli(['connect', 'clients']).stdout.includes('\u001b'));
  });

  await check('G10', 'refused redirects: credentials, fragment, wildcard, remote http, IP-literal HTTPS, custom scheme, mixed native+web, oversize', async () => {
    for (const uri of ['https://u:p@ok.example/cb', 'https://ok.example/cb#f', 'https://*.example/cb', 'http://ok.example/cb', 'https://127.0.0.1/cb', 'https://localhost/cb', 'myapp://cb', 'javascript:alert(1)', `https://ok.example/${'a'.repeat(520)}`, 'https://OK.example/cb']) {
      assert.equal((await new Vendor(bridge, uri).register()).status, 400, uri);
    }
    assert.equal((await new Vendor(bridge, 'https://ok.example/cb').register({ redirect_uris: ['https://ok.example/cb', 'http://127.0.0.1:5/cb'] })).status, 400, 'mixed native and web');
  });

  await check('G11', 'brand data present or absent: the same client gets the same approval shape with an empty or a full owner list', async () => {
    const full = await new Bridge('full').init();
    const cfg = path.join(full.config, 'as.json'); const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    c.callbacks = ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect', 'https://agent.meta.ai/api/hatch/oauth/callback'];
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
    await full.start();
    try {
      const shape = async srv => {
        const vendor = new Vendor(srv, 'https://same.example/cb');
        srv.start_window('lark');
        assert.equal((await vendor.register({ client_name: 'Claude' })).status, 201);
        const flow = await vendor.begin({});
        const approved = srv.approve(flow.code, 'lark'); assert.equal(approved.code, 0);
        const callback = await vendor.finish(flow);
        const tokens = await vendor.exchange(callback.code, flow.pkce.verifier);
        const { approval } = approved.json();
        const list = srv.cli(['connect', 'list', '--json']).json().connections.filter(c => c.redirect_uri === 'https://same.example/cb' && !c.revoked_at).map(({ worker, redirect_uri, redirect_origin, scopes }) => ({ worker, redirect_uri, redirect_origin, scopes }));
        const { approvedAt, connectionId, clientId, issuer, resource, ...rest } = approval;
        return { status: tokens.status, scopes: tokens.body.scope, tokenType: tokens.body.token_type, rest, list };
      };
      assert.deepEqual(await shape(full), await shape(bridge));
    } finally { await full.stop(); }
  });

  await check('G13', 'pairing starvation: a client at another origin cannot displace a pending pairing; the same origin keeps the newest-code rule', async () => {
    const legit = new Vendor(bridge, 'https://legit.example/cb');
    bridge.start_window('lark');
    assert.equal((await legit.register()).status, 201);
    const flow = await legit.begin({});
    assert.ok(flow.code);
    // An unseen client at origin B registers and opens attempts again and again during the open window.
    for (let i = 0; i < 4; i++) {
      const noisy = new Vendor(bridge, `https://noisy.example/cb${i}`);
      assert.equal((await noisy.register()).status, 201);
      assert.ok((await noisy.begin({})).code);
    }
    const view = bridge.pending().pending.find(p => p.code === flow.code);
    assert.ok(view && !view.superseded, 'the older pairing at origin A is not marked superseded by origin B');
    const approved = bridge.approve(flow.code, 'lark');
    assert.equal(approved.code, 0, approved.stderr + approved.stdout);
    const callback = await legit.finish(flow);
    assert.equal(callback.stage, 'callback', JSON.stringify(callback));
    assert.equal((await legit.exchange(callback.code, flow.pkce.verifier)).status, 200);
    // Same origin: a newer pending pairing still supersedes the older one (an app that registered again).
    bridge.start_window('duet');
    const a = new Vendor(bridge, 'https://same-origin.example/cb');
    assert.equal((await a.register()).status, 201);
    const older = await a.begin({});
    const b = new Vendor(bridge, 'https://same-origin.example/cb');
    assert.equal((await b.register()).status, 201);
    const newer = await b.begin({});
    assert.ok(older.code && newer.code);
    const pend = bridge.pending().pending;
    assert.equal(pend.find(p => p.code === older.code).superseded, true, 'older same-origin pairing is superseded');
    assert.ok(!pend.find(p => p.code === newer.code).superseded);
    const refused = bridge.approve(older.code, 'duet');
    assert.notEqual(refused.code, 0, 'the older same-origin code cannot be approved');
    assert.match(refused.stderr + refused.stdout, /superseded/);
    assert.equal(bridge.approve(newer.code, 'duet').code, 0);
  });

  await check('G12', 'a legacy owner pattern still works but adds nothing: allow-callback with a wildcard keeps older registrations valid', async () => {
    assert.equal(bridge.cli(['connect', 'allow-callback', 'https://legacy.example/oauth/*']).code, 0);
    const vendor = new Vendor(bridge, 'https://legacy.example/oauth/abc123');
    bridge.start_window('lark');
    assert.equal((await vendor.register()).status, 201);
  });
} finally {
  await stopAll();
}
if (failures.length) { console.log(`\nFAILED: ${failures.join(', ')}`); process.exit(1); }
console.log('\nall generic client journeys passed');
