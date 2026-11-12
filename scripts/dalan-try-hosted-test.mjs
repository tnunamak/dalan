// `dalan try --public`: the hosted path through the Gozar route contract. No real tunnel, no real Gozar runtime, no ChatGPT or claude.ai account.
// A contract-faithful fake Gozar (src/test-support/gozar-fake.mjs) answers the route questions; a relay on its own port stands behind the
// fake's HTTPS origin so the public address is not the bridge's bind address, and a scripted hosted client signs in through it. The bridge,
// its OAuth server, its MCP tools and the CLI are the real ones. Real Gozar integration is not exercised here.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { beginPairing, openSession, workJob } from '../src/demo-worker.mjs';
import { parseTryArgs, runTry, tryInternals } from '../src/try.mjs';
import * as tryHostedInternals from '../src/try-hosted.mjs';
import { acquireHomeLock, handoffText, hostedPrompt } from '../src/try-hosted.mjs';
import { uaToken } from '../src/mcp-outcome.mjs';
import { mcpResponseText } from '../src/mcp-sse.mjs';
import { runSelfCheck } from '../src/try-selfcheck.mjs';
import { createGate, authorizationServerMetadataUrl, verifyPublicReady, watchPublicIdentity } from '../src/try-exposure.mjs';
import { registerChild, sweepChildren } from '../src/child-registry.mjs';
import { writeRouteSetting } from '../src/route-setting.mjs';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const { chooseMode } = tryHostedInternals;
const repo = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tempRoot, 'dhost-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const URL_LINE = /^(https:\/\/fake-\d+\.route\.invalid\/[0-9a-f]{64}\/mcp)$/m;
const virtualClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };

// ---- fakes -------------------------------------------------------------------------------------------------------------
// The fake Gozar hands out https://fake-N.route.invalid origins. A relay on its own port stands behind each one: the test process's
// fetch sends that host to the relay, which sets the Host header and forwards to the gate port Dalan gave Gozar.
const relays = new Map(); // host -> relay port
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const port = relays.get(url.host);
  if (!port) return realFetch(input, init);
  return realFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers: { ...(init.headers ?? {}), host: url.host } });
};

function fakeRoute({ legacyOnExpose } = {}) {
  const gozar = createFakeGozar();
  const record = { gatePort: null, origin: null, servers: [], get started() { return gozar.fake.state.effects.filter(e => e.type === 'expose' || e.type === 'ensure').length; },
    get stopped() { return gozar.fake.state.effects.filter(e => e.type === 'close').length; }, id: null, die() { gozar.fake.change(record.id, { state: 'lost', published: null }); } };
  const relayFor = async (origin, target) => {
    const gatePort = Number(target.split(':').pop());
    record.gatePort = gatePort; record.origin = origin;
    const relay = http.createServer((req, res) => {
      const forward = http.request({ host: '127.0.0.1', port: gatePort, method: req.method, path: req.url, headers: { ...req.headers, host: new URL(origin).host } }, answer => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res); });
      forward.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(forward);
    });
    await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
    record.servers.push(relay);
    relays.set(new URL(origin).host, relay.address().port);
  };
  for (const name of ['expose', 'ensureRoute']) {
    const original = gozar[name];
    gozar[name] = async request => {
      const view = await original(request);
      if (name === 'expose' || !relays.has(new URL(view.origin).host)) await relayFor(view.origin, request.target);
      record.id = view.handle.id;
      return view;
    };
  }
  const closeAll = async () => { for (const server of record.servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
  return { gozar, record, closeAll };
}

// ---- a hosted run ------------------------------------------------------------------------------------------------------
async function hostedRun(name, { argv = [], gozar, clock, fetchImpl, route: savedRoute, trialMs, noHome, consentAnswer = 'y\n', watchPublicIdentity: watchIdentity } = {}) {
  const home = path.join(tmp, name);
  const port = await reservedPort();
  const route = fakeRoute();
  if (savedRoute) writeRouteSetting(savedRoute, { XDG_CONFIG_HOME: path.join(tmp, `cfg-${name}`) });
  const run = { out: '', input: new PassThrough(), controller: new AbortController(), home, route: route.record, errorContext: { started: false, shellCli: `'${path.join(repo, 'bin/dalan.mjs')}'` } };
  const out = { write: text => {
    run.out += text;
    if (consentAnswer !== null && /Use this route\? \[y\/N\]/.test(text)) setImmediate(() => run.input.write(consentAnswer));
  } };
  run.finished = runTry({
    argv: ['--public', ...(noHome ? [] : ['--home', home]), '--port', String(port), ...argv], env: { PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(tmp, `cfg-${name}`), XDG_STATE_HOME: path.join(tmp, `state-${name}`) },
    out, input: run.input, signal: run.controller.signal, errorContext: run.errorContext, clock,
    hosted: { interactive: true, gozar: gozar ?? route.gozar, serverEnv: { DALAN_TEST_OAUTH: '1' }, fetchImpl, ...(watchIdentity ? { watchPublicIdentity: watchIdentity } : {}), ...(trialMs ? { trialMs } : {}) },
  }).then(() => ({}), error => ({ error })).finally(() => route.closeAll());
  run.gozar = route.gozar;
  run.until = async (pattern, ms = 60_000) => {
    for (let waited = 0; !pattern.test(run.out); waited += 50) {
      if (waited > ms) throw new Error(`never saw ${pattern}\n${run.out.replace(/[0-9a-f]{64}/g, '<secret>')}`);
      await sleepMs(50);
    }
    return run.out.match(pattern);
  };
  run.close = async () => { run.controller.abort(); return run.finished; };
  // Sign-in needs only the URL; the job prompt becomes available after approval.
  run.handoff = async () => ({ url: (await run.until(URL_LINE))[1] });
  run.prompt = async () => {
    const requestId = (await run.until(/claim only (req_[0-9a-f-]+),/))[1];
    const phrase = (await run.until(/requested report \((bridge first report [0-9a-f]{8})\)/))[1];
    return { requestId, phrase };
  };
  return run;
}
// The same run with the terminal answers and the raw output a few tests read directly.
async function directRun(name, { argv = [], env = {} } = {}) {
  const home = path.join(tmp, name);
  const route = fakeRoute();
  const input = new PassThrough(), controller = new AbortController();
  const state = { out: '' };
  const finished = runTry({ argv: ['--public', '--home', home, '--port', String(await reservedPort()), ...argv], env: { PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(tmp, `cfg-${name}`), ...env },
    out: { write: t => { state.out += t; if (/Use this route\? \[y\/N\]/.test(t)) setImmediate(() => input.write('y\n')); } }, input, signal: controller.signal, errorContext: {},
    hosted: { interactive: true, gozar: route.gozar, serverEnv: { DALAN_TEST_OAUTH: '1' } } }).catch(error => error).finally(() => route.closeAll());
  for (let i = 0; i < 400 && !URL_LINE.test(state.out); i++) await sleepMs(50);
  return { home, route, input, controller, state, finished, url: URL_LINE.exec(state.out)?.[1] };
}
const approveAs = async (run, { callback = CHATGPT_CALLBACK, answer = 'y\n' } = {}) => {
  const { url } = await run.handoff();
  const pairing = await beginPairing(url, { redirect: callback, clientName: 'ChatGPT' });
  return { url, pairing, ...(answer ? { answered: (async () => { await run.until(/Approve this connection\? \[y\/N\] /); assert.match(run.out, new RegExp(`code        ${pairing.code}`)); run.input.write(answer); })() } : {}) };
};

let secretPath = null;
const filesHolding = (root, needle) => {
  const hits = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.isFile() && fs.readFileSync(f).includes(needle)) hits.push(path.relative(root, f)); } };
  walk(root); return hits;
};
const closed = port => new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); });
const answerMode = async lines => {
  const input = new PassThrough();
  let out = '';
  const pending = chooseMode({ input, out: { write: t => { out += t; } }, signal: undefined });
  for (const line of lines) { await sleepMs(20); input.write(line); }
  return { choice: await pending, out };
};
async function liveSelfCheck(wrapFetch) {
  const run = await directRun(`sc-${Math.random().toString(16).slice(2, 8)}`);
  try {
    const lines = [], sent = [];
    const fetchImpl = wrapFetch((u, init) => { sent.push({ url: String(u), init }); return fetch(u, init); });
    const checking = runSelfCheck({ url: run.url, client: 'claude', fetchImpl, approveWaitMs: 30_000, say: l => lines.push(l) });
    for (let i = 0; i < 400 && !/Approve this connection\? \[y\/N\] /.test(run.state.out) && !/FAIL/.test(lines.join()); i++) await sleepMs(50);
    run.input.write('y\n');
    return { result: await checking, lines, sent, url: run.url };
  } finally { run.controller.abort(); await run.finished; }
}

test('a bare `try --public`: end to end with a stand-in hosted client through a session route', async () => {
  const run = await hostedRun('e2e');
  try {
    const { url } = await run.handoff();
    // Every value is filled in: no placeholder, and the handoff names the connector and the sign-in steps.
    const handoff = run.out.slice(run.out.indexOf('Connector name:'));
    assert.doesNotMatch(handoff, /<[A-Za-z _-]+>|PATTERN|NAME|PORT|HOME_PATH|YOUR_/, 'the handoff has no placeholder');
    assert.match(handoff, /Connector name: Dalan Trial/);
    for (const step of ['add a custom MCP server', 'paste the URL above, choose OAuth', 'approve the matching code in this terminal']) assert.ok(handoff.includes(step), step);
    assert.doesNotMatch(handoff, /Paste this into the chat:|claim only req_|bridge first report/);
    const origin = new URL(url).origin;
    assert.notEqual(Number(new URL(origin).port), run.errorContext.bindPort, 'the public origin is not the bridge bind address');
    assert.match(run.out, /Public HTTPS, OAuth discovery and the authorization server's metadata verified\./);
    assert.match(run.out, /^Temporary demo link\. It can change or stop without warning\. Run `dalan setup` to choose a stable route\./m);
    assert.ok(run.out.indexOf('Temporary demo link.') < run.out.indexOf('Paste this URL'));
    assert.equal(run.out.match(/Temporary demo link/g).length, 1);
    // The scripted client signs in through the public origin, the owner approves, the client works the job.
    const pairing = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Connection waiting for your approval/);
    await run.until(/Approve this connection\? \[y\/N\] /);
    assert.match(run.out, new RegExp(`code        ${pairing.code}`));
    assert.match(run.out, new RegExp(`resource    "${origin}/<secret>/mcp"`));
    run.input.write('y\n');
    const token = await pairing.complete();
    await run.until(/Connection approved\./);
    const { requestId, phrase } = await run.prompt();
    assert.ok(run.out.indexOf('Connection approved.') < run.out.indexOf('Paste this into the chat:'));
    // Approval alone is not a finished job.
    assert.doesNotMatch(run.out, /Hosted worker completed/);
    await workJob(url, token, requestId, { claimant: 'ChatGPT', report: phrase });
    await run.until(/Hosted worker completed the demo\./);
    assert.match(run.out, new RegExp(`Report: ${phrase}`));
    await run.until(/Accept this result\? \[y\/N\] /);
    run.input.write('y\n');
    await run.until(/Recorded as accepted\. The trial stays available until you press Ctrl-C\./);
    // The URL is a credential: it is on the terminal handoff once, and in the private file, nowhere else.
    const secret = secretPath = new URL(url).pathname.split('/')[1];
    assert.equal(run.out.split(secret).length - 1, 1, 'the secret path is printed exactly once');
    const urlFile = path.join(run.home, 'resource-url');
    assert.equal(fs.statSync(urlFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(urlFile, 'utf8').trim(), url);
    assert.ok(!fs.readFileSync(path.join(run.home, 'server.log'), 'utf8').includes(secret), 'server log never holds the secret');
    // An unauthenticated request is challenged and owner routes are absent on the public address.
    const challenge = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(challenge.status, 401);
    for (const owner of ['/admin', '/connect/pending', '/connect/approve']) assert.notEqual((await fetch(`${origin}${owner}`)).status, 200, owner);
    // Hosted trials keep an accepted MCP stream alive with heartbeats until its reply arrives.
    const call = await openSession(url, token);
    await assert.doesNotReject(call('list_pending', {}));
    const raw = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
    assert.match(raw.headers.get('content-type'), /^text\/event-stream/);
    const reply = JSON.parse(mcpResponseText(await raw.text()));
    assert.equal(reply.id, 9, 'the event-stream response matches this request');
    assert.ok(reply.result?.tools?.some(tool => tool.name === 'list_pending'), 'the response contains the Dalan tools list');
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405, 'the optional GET stream is refused');
  } finally {
    const result = await run.close();
    assert.equal(result.error, undefined, String(result.error?.message));
  }
  assert.match(run.out, /Public route removed\. Bridge stopped\./);
  assert.match(run.out, new RegExp(`Trial history kept at ${run.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(run.route.stopped, 1, 'the route was stopped exactly once');
  assert.match(run.out, /To run it again: .*try --public --home '([^']+)'\n/, 'the restart command selects a fresh home');
  const restartHome = /To run it again: .*--home '([^']+)'/.exec(run.out)?.[1];
  assert.ok(restartHome && restartHome !== run.home, 'a temporary address uses a fresh home on restart');
  // After a normal stop no credential is left in the trial home.
  assert.equal(fs.existsSync(path.join(run.home, 'resource-url')), false, 'the connector URL file is removed');
  assert.deepEqual(filesHolding(run.home, secretPath), [], 'the secret path is in no file after the stop');
  assert.equal(await closed(run.route.gatePort), true, 'the gate is closed');
});

test('a wrong phrase, a blocked outcome or an unapproved worker is not counted as the demo finishing', async () => {
  const run = await hostedRun('proof');
  try {
    const { url } = await run.handoff();
    const pairing = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Approve this connection\? \[y\/N\] /);
    run.input.write('y\n');
    const token = await pairing.complete();
    await run.until(/Connection approved/);
    const { requestId, phrase } = await run.prompt();
    const call = await openSession(url, token);
    const { claim_id } = await call('claim', { request_id: requestId, claimant: 'dalan-demo' });
    await call('finish', { request_id: requestId, claim_id, outcome: 'completed', summary: 'x', result: 'bridge first report 00000000' });
    await run.until(/not as the demo asked/);
    assert.doesNotMatch(run.out, /Hosted worker completed the demo/);
    assert.doesNotMatch(run.out, /Accept this result\?/);
    assert.ok(phrase !== 'bridge first report 00000000');
  } finally { await run.close(); }
});

test('a blocked report with the right phrase is not a completed demo', async () => {
  const run = await hostedRun('blocked');
  try {
    const { url } = await run.handoff();
    const pairing = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Approve this connection\? \[y\/N\] /);
    run.input.write('y\n');
    const token = await pairing.complete();
    const { requestId, phrase } = await run.prompt();
    const call = await openSession(url, token);
    const { claim_id } = await call('claim', { request_id: requestId, claimant: 'x' });
    await call('finish', { request_id: requestId, claim_id, outcome: 'blocked', summary: phrase, result: phrase }).catch(() => null);
    await sleepMs(3500);
    assert.doesNotMatch(run.out, /Hosted worker completed the demo/);
  } finally { await run.close(); }
});

test('a hosted client\'s order: challenge, discovery from the challenge, registration, sign-in, token, then an MCP call; every step is in the log by name', async () => {
  const run = await directRun('hostedflow');
  const { input, controller, finished, state } = run, home = run.home, url = run.url;
  const out = () => state.out;
  try {
    const origin = new URL(url).origin, secret = new URL(url).pathname.split('/')[1];
    // 1. The tokenless request is answered with a challenge that names the discovery document.
    const challenge = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-ai","version":"0.1.0"}}}' });
    assert.equal(challenge.status, 401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate'))[1];
    assert.equal(metadataUrl, `${origin}/.well-known/oauth-protected-resource/${secret}/mcp`);
    // 2. Discovery that needs no secret is not served at the origin root; the challenge is the only way in, and it is enough.
    for (const root of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/register', '/authorize', '/token']) {
      assert.equal((await fetch(`${origin}${root}`, { redirect: 'manual' })).status, 404, root);
    }
    // 3. Sign-in from that document: registration, the owner's approval, the token.
    const prm = await (await fetch(metadataUrl)).json();
    assert.equal(prm.resource, url);
    const pairing = await beginPairing(url, { redirect: CLAUDE_CALLBACK, clientName: 'Claude' });
    for (let i = 0; i < 400 && !/Approve this connection\? \[y\/N\] /.test(out()); i++) await sleepMs(50);
    input.write('y\n');
    const token = await pairing.complete();
    // 4. The first authenticated call is an MCP initialize.
    const call = await openSession(url, token);
    await assert.doesNotReject(call('list_pending', {}));
    assert.equal(fs.readFileSync(path.join(home, '.local/state/dalan/requests.jsonl'), 'utf8').includes('"as_error"'), false, 'the honest flow logs no OAuth error');
    // A caller can put any text in a User-Agent, a grant_type or a parameter name; none of it may reach the log verbatim.
    const SENTINEL = 'Zq8Lm3Vx9Tn2Rb7Kd4Hs6Pw1Yc5Jf0GH', SENTINEL_NAME = 'Ab3De5Gh7Jk9Mn1Pq2St4Vw6Xy8Zc0Fu';
    assert.equal(SENTINEL.length, 32);
    await fetch(`${origin}/${secret}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': SENTINEL }, body: `grant_type=${SENTINEL}&${SENTINEL_NAME}=${SENTINEL}&client_id=x` });
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `${SENTINEL}/1.0` }, body: '{}' });
    await fetch(`${origin}/${secret}/oauth/.well-known/other`, { headers: { 'user-agent': `Mozilla/5.0 ${SENTINEL}` } });
    // Every step is in the request log by route name and status, with no path, query or secret.
    const log = fs.readFileSync(path.join(home, '.local/state/dalan/requests.jsonl'), 'utf8');
    assert.ok(!log.includes(secret), 'the log never holds the secret path');
    const steps = log.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.kind === 'as_request').map(e => `${e.route}:${e.status}`);
    for (const expected of ['discovery:200', 'registration:201', 'authorize:303', 'interaction:200', 'token:200']) assert.ok(steps.includes(expected), `${expected} in ${steps.join(' ')}`);
    assert.equal(log.includes(SENTINEL), false, 'no caller-chosen text in the log');
    assert.equal(log.includes(SENTINEL_NAME), false, 'no caller-chosen parameter name in the log');
    const detail = log.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.kind === 'as_token_detail');
    assert.ok(detail.some(e => e.grant_type === 'other' && e.unknown_params === 1 && e.request_params.includes('client_id')), JSON.stringify(detail));
    assert.ok(detail.every(e => ['authorization_code', 'refresh_token', 'client_credentials', 'other', null].includes(e.grant_type)));
    assert.ok(log.split('\n').filter(Boolean).map(l => JSON.parse(l)).some(e => e.kind === 'mcp_received' && e.ua === 'other'));
    for (const line of log.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.kind === 'as_request')) assert.ok(['node', 'other', 'Mozilla'].includes(line.ua), `ua on ${line.route}: ${line.ua}`);
    assert.match(log, /"kind":"mcp_inbound","status":200,"route":"resource_metadata"/);
  } finally { controller.abort(); await finished; }
});

test('the self-check walks a live trial as a real client: every step passes, and no token, code, secret or URL is printed', async () => {
  const run = await directRun('selfcheck');
  const { input, controller, finished, state, url } = run;
  const out = () => state.out;
  try {
    const secret = new URL(url).pathname.split('/')[1];
    const lines = [];
    const checking = runSelfCheck({ url, client: 'claude', approveWaitMs: 30_000, say: l => lines.push(l) });
    for (let i = 0; i < 400 && !/Approve this connection\? \[y\/N\] /.test(out()); i++) await sleepMs(50);
    input.write('y\n');
    const result = await checking;
    assert.equal(result.ok, true, lines.join('\n'));
    const text = lines.join('\n');
    assert.deepEqual(lines.filter(l => /^(PASS|FAIL|SKIP)/.test(l)).map(l => l.split(':')[0].split(' ')[0] + ' ' + l.split(' ')[1].replace(':', '')),
      ['PASS challenge', 'PASS discovery', 'PASS metadata', 'PASS registration', 'PASS authorize', 'PASS approval', 'PASS callback', 'PASS token', 'PASS mcp', 'PASS mcp', 'PASS mcp', 'PASS mcp']);
    assert.equal(lines.at(-1), 'RESULT PASS');
    assert.ok(!text.includes(secret) && !text.includes(url), 'no secret path or URL');
    assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9_-]{32,}/, 'no token or code');
    // The check does not leave the trial unusable: its registered client is one of the limited ones, nothing else changed.
    assert.match(text, /PASS token: .*(audience is this resource|opaque token)/);
  } finally { controller.abort(); await finished; }
});

test('the self-check stops at the first failing step, skips the rest and says FAIL', async () => {
  const secret = randomBytes(32).toString('hex');
  const url = `https://demo.example/${secret}/mcp`;
  const lines = [];
  const fetchImpl = async (u, init = {}) => {
    if (init.method === 'POST' && String(u) === url) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://demo.example/.well-known/oauth-protected-resource/x/mcp"' } });
    return Response.json({ resource: url, authorization_servers: [] });
  };
  const result = await runSelfCheck({ url, client: 'chatgpt', fetchImpl, say: l => lines.push(l) });
  assert.equal(result.ok, false);
  assert.match(lines.join('\n'), /PASS challenge[^\n]*\nFAIL discovery[^\n]*no authorization server\nSKIP metadata[^\n]*\nSKIP registration/);
  assert.equal(lines.at(-1), 'RESULT FAIL');
  assert.ok(!lines.join('\n').includes(secret), 'the secret path is not printed');
});

test('the self-check registers as an explicit public client and accepts only the exact registered callback', async () => {
  const ok = await liveSelfCheck(f => f);
  assert.equal(ok.result.ok, true, ok.lines.join('\n'));
  const reg = ok.sent.find(s => s.init?.method === 'POST' && /\/oauth\/reg/.test(s.url));
  assert.equal(JSON.parse(reg.init.body).token_endpoint_auth_method, 'none', 'the outbound registration asks for a public client');
  // A redirect to the registered callback plus an extra path is not the registered callback.
  const wrong = await liveSelfCheck(f => async (u, init) => {
    const res = await f(u, init), location = res.headers.get('location');
    if (location?.startsWith(CLAUDE_CALLBACK)) return new Response(null, { status: res.status, headers: { location: location.replace(CLAUDE_CALLBACK, `${CLAUDE_CALLBACK}/wrong`) } });
    return res;
  });
  assert.equal(wrong.result.ok, false);
  assert.match(wrong.lines.join('\n'), /FAIL callback: .*not to the registered callback/);
  assert.ok(!wrong.sent.some(s => /\/oauth\/token/.test(s.url)), 'no code was exchanged');
});

test('the self-check refuses a malformed URL with a fixed message, and a failing request never echoes the URL or secret', async () => {
  const lines = [];
  const malformedSecret = randomBytes(32).toString('hex');
  const bad = await runSelfCheck({ url: `https://exa mple.test/${malformedSecret}/mcp`, say: l => lines.push(l) });
  assert.equal(bad.ok, false);
  assert.deepEqual(lines, ['FAIL input: the trial URL is not a valid web address', 'RESULT FAIL']);
  assert.equal(JSON.stringify(bad).includes(malformedSecret), false);
  const text = [];
  const secret = randomBytes(32).toString('hex');
  const url = `https://demo.example/${secret}/mcp`;
  const leaky = await runSelfCheck({ url, fetchImpl: async () => { throw new Error(`connect failed for ${url} with ${secret}`); }, say: l => text.push(l) });
  assert.equal(leaky.ok, false);
  assert.ok(!JSON.stringify(leaky).includes(secret) && !text.join().includes(secret), 'neither the lines nor the returned detail carry the secret');
  // A server that never finishes answering ends at the request deadline, not at the approval wait.
  const started = Date.now();
  const hung = await runSelfCheck({ url, requestMs: 100, fetchImpl: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), say() {} });
  assert.equal(hung.ok, false);
  assert.ok(Date.now() - started < 3000, 'bounded');
  // The CLI prints a fixed line for a malformed credential and never the credential.
  const cli = spawnSync(process.execPath, [path.join(repo, 'scripts/dalan-try-selfcheck.mjs'), '--client', 'claude'], { env: { PATH: process.env.PATH, DALAN_TRY_URL: `https://exa mple.test/${malformedSecret}/mcp` }, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.ok(!(cli.stdout + cli.stderr).includes(malformedSecret));
});

test('the printed restart command: the same home only where the address is stable; a new home otherwise', () => {
  const base = { cli: 'dalan', home: '/h', freshHome: '/fresh-trial', shellQuote: x => x };
  assert.equal(tryHostedInternals.restartCommand({ ...base, stable: true }), 'dalan try --public --home /h');
  assert.equal(tryHostedInternals.restartCommand({ ...base, stable: false }), 'dalan try --public --home /fresh-trial');
  assert.equal(tryHostedInternals.restartCommand({ ...base, stable: false, route: 'zq-invented-7' }), 'dalan try --public --route zq-invented-7 --home /fresh-trial', 'the route name is carried verbatim');
});

test('a route Gozar cannot start names the next step Gozar gave, and never falls back to another route', async () => {
  const home = path.join(tmp, 'routefail');
  const gozar = createFakeGozar();
  gozar.expose = async () => { throw Object.assign(new Error('provider is down'), { code: 'provider_unavailable' }); };
  const context = { shellCli: `'x'`, cli: 'dalan', shellHome: `'${home}'`, logFile: '/none', shellLog: '/none' };
  const input = new PassThrough();
  const out = { write: text => { if (/Use this route\? \[y\/N\]/.test(text)) setImmediate(() => input.write('y\n')); } };
  const error = await runTry({ argv: ['--public', '--home', home], env: { PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(tmp, 'cfg-routefail') }, out, input, errorContext: context, hosted: { interactive: true, gozar } }).catch(e => e);
  assert.equal(error.tryKind, 'route_start');
  const text = tryInternals.formatTryError(error, context, { home: '/other', port: 1 });
  assert.match(text, /The route provider is unavailable right now\./);
  assert.doesNotMatch(text, /new home|Fix the problem above/);
  assert.equal(gozar.fake.state.effects.length, 0, 'nothing was exposed and no other route was tried');
});

test('a public trial without a terminal fails before any route or file exists', async () => {
  const home = path.join(tmp, 'noterm');
  const route = fakeRoute();
  await assert.rejects(runTry({ argv: ['--public', '--home', home], env: { PATH: process.env.PATH }, out: { write() {} }, input: new PassThrough(), errorContext: { shellCli: `'x'` }, hosted: { gozar: route.gozar } }),
    /Hosted setup needs an interactive terminal for the URL and connection approval\. Run this in an interactive terminal:\n  node 'x' try --public/);
  assert.equal(route.record.started, 0);
  assert.equal(fs.existsSync(home), false);
});

test('a bare `try` with no terminal runs the local self-check and never opens a route', async () => {
  const route = fakeRoute();
  const input = new PassThrough();
  input.end();
  let out = '';
  await runTry({ argv: ['--home', path.join(tmp, 'localpipe'), '--port', String(await reservedPort())], env: { PATH: process.env.PATH }, out: { write: t => { out += t; } }, input, errorContext: {}, hosted: { gozar: route.gozar } });
  assert.match(out, /Self-check passed/);
  assert.equal(route.record.started, 0);
  assert.deepEqual(route.gozar.fake.state.calls, [], 'Gozar was not asked anything');
});

test('a route that is lost stops the trial, with the route closed and the restart command printed', async () => {
  const run = await hostedRun('routedies');
  try {
    await run.handoff();
    run.route.die();
    const result = await run.finished;
    assert.match(result.error?.message ?? '', /The temporary demo link stopped responding\. The connector cannot use this URL; the trial is stopping\./);
    const formatted = tryInternals.formatTryError(result.error, run.errorContext);
    assert.match(formatted, /The old connector URL cannot be used\. Remove that connector, add the new URL from the fresh trial, then sign in and approve it again\./);
    const restartHome = /Start fresh with:\n\s*.*try --public --home '([^']+)'/.exec(formatted)?.[1];
    assert.ok(restartHome && restartHome !== run.home && path.basename(restartHome).startsWith('dalan-hosted-'), 'the restart command selects a fresh home for the temporary address');
    assert.equal(run.route.stopped, 1);
  } finally { await run.close(); }
});

test('a public address that never answers as this bridge stops the trial before any URL is shown', async () => {
  const clock = virtualClock();
  const run = await hostedRun('notready', { clock, fetchImpl: async () => { throw new Error('fetch failed'); } });
  const result = await run.finished;
  assert.match(result.error?.message ?? '', /The public route is not ready \(.*\); the trial is stopping\./);
  assert.doesNotMatch(run.out, /Connector name:/);
  assert.equal(run.route.stopped, 1);
});

test('a home set up for another public address is refused, not re-issued', async () => {
  const home = path.join(tmp, 'moved');
  fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dalan-trial'), 'x');
  fs.writeFileSync(path.join(home, '.config/dot-bridge/workers.json'), JSON.stringify({ workers: { hosted: {} } }));
  fs.writeFileSync(path.join(home, '.config/dot-bridge/as.json'), JSON.stringify({ version: 1, public_url: 'https://old.example.com' }));
  const route = fakeRoute();
  const input = new PassThrough();
  const out = { write: text => { if (/Use this route\? \[y\/N\]/.test(text)) setImmediate(() => input.write('y\n')); } };
  const run = await runTry({ argv: ['--public', '--home', home], env: { PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(tmp, 'cfg-moved') }, out, input, errorContext: {}, hosted: { interactive: true, gozar: route.gozar } }).catch(e => e);
  assert.match(run?.message ?? '', /this home was set up for https:\/\/old\.example\.com/);
  assert.equal(route.record.stopped, 1);
});

test('option parsing: local and public modes, routes and conflicts; no client enum, no callback gate', () => {
  assert.deepEqual(parseTryArgs(['--public', '--route', 'zq-invented-7']), { home: null, port: null, callbacks: [], mode: 'public', route: 'zq-invented-7' });
  assert.equal(parseTryArgs(['--local']).mode, 'local');
  assert.equal(parseTryArgs(['--route', 'anything-at-all']).mode, 'public', '--route implies public mode');
  for (const bad of [['--local', '--route', 'x'], ['--client', 'chatgpt'], ['--public', '--callback', 'x'], ['--public', '--client', 'claude'], ['--route']]) assert.throws(() => parseTryArgs(bad), Error, bad.join(' '));
  assert.deepEqual(parseTryArgs([]), { home: null, port: null, callbacks: [] });
  assert.equal(parseTryArgs(['--public', '--route', 'brand-x']).route, 'brand-x', 'any name is just a name; Gozar judges it');
});

test('the mode question: Enter chooses a hosted MCP client; no route and no client are asked', async () => {
  const enter = await answerMode(['\n']);
  assert.deepEqual(enter.choice, { mode: 'public' });
  assert.doesNotMatch(enter.out, /route|ChatGPT|Claude/i, 'progressive disclosure: no route or client question');
  assert.deepEqual((await answerMode(['2\n'])).choice, { mode: 'local' });
  const retyped = await answerMode(['9\n', '\n']);
  assert.deepEqual(retyped.choice, { mode: 'public' });
  assert.match(retyped.out, /Type 1 to 2, or press Enter for 1\./);
});

test('the mode question: an input that ends chooses the local path, never a public route', async () => {
  const input = new PassThrough();
  const pending = chooseMode({ input, out: { write() {} } });
  input.end();
  assert.deepEqual(await pending, { mode: 'local' });
});

test('handoff text: the same text for the same inputs, with no unfilled value and no client name', () => {
  const text = handoffText({ url: 'https://x.example/s/mcp' });
  assert.doesNotMatch(text, /<[^>]+>|PATTERN|NAME\b|PORT\b|undefined|null/);
  assert.ok(text.includes('https://x.example/s/mcp'));
  assert.doesNotMatch(text, /ChatGPT|Claude|Paste this into the chat:|claim only|bridge first report|prompt below/);
  assert.equal(handoffText({ url: 'https://x.example/s/mcp' }), text);
  assert.match(hostedPrompt('req_1', 'bridge first report abcd1234'), /claim only req_1,.*\(bridge first report abcd1234\)/);
});

test('a trial states its local shutdown limit and attempts route cleanup when the limit expires; a saved route has no timer', async () => {
  const run = await hostedRun('trial-time', { trialMs: 2 * 60_000, clock: virtualClock() });
  const done = await run.finished;
  assert.match(run.out, /^This trial has a local shutdown limit of 2 min; the temporary link can stop earlier or without warning\./m);
  assert.ok(run.out.indexOf('local shutdown limit') < run.out.indexOf('Connector name:'));
  assert.match(done.error?.message ?? '', /The temporary trial reached its 2 min shutdown limit\. Route cleanup will be attempted\./);
  assert.match(run.out, /Local shutdown limit: \d+ (h \d+ )?min\./, 'reminders show the local shutdown limit');
  assert.equal(run.route.stopped, 1, 'cleanup closes the session route exactly once');
  const real = await hostedRun('real-no-timer', { route: savedSetting('real-no-timer'), clock: virtualClock(), fetchImpl: async () => { throw new Error('fetch failed'); } });
  await real.finished;
  assert.doesNotMatch(real.out, /shutdown limit|Temporary trial/);
});

const savedSetting = name => ({ version: 2, requirements: {}, gozarHome: path.join(tmp, `gozar-${name}`), routeName: null, routeId: 'dalan-main', origin: 'https://fake-90.route.invalid', bridgeHome: null });

test('a saved durable route reuses one home, so its address and sign-in survive a restart; a session trial gets a new home each run', async () => {
  const oldHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dfh-')); // short: the admin socket path has a length limit
  process.env.HOME = fakeHome;
  try {
    const homes = [];
    for (const [saved, name] of [[true, 'rh1'], [true, 'rh2'], [false, 'th1'], [false, 'th2']]) {
      const gozar = createFakeGozar();
      gozar.ensureRoute = async () => { throw new Error('test stops after home selection'); };
      gozar.catalogRoutes = async () => { throw new Error('test stops after home selection'); };
      const run = await hostedRun(name, { noHome: true, route: saved ? savedSetting(name) : undefined, gozar });
      await run.finished;
      assert.ok(run.errorContext.home, 'the home is chosen before anything else happens');
      homes.push(run.errorContext.home);
    }
    assert.equal(homes[0], homes[1]);
    assert.equal(path.basename(homes[0]), 'dalan-hosted');
    assert.notEqual(homes[2], homes[3]);
    assert.notEqual(path.basename(homes[2]), 'dalan-hosted');
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; fs.rmSync(fakeHome, { recursive: true, force: true }); }
});

test('the shutdown limit also ends an unanswered approval question and attempts cleanup', async () => {
  const run = await hostedRun('expire-prompt', { trialMs: 6000 });
  await approveAs(run, { answer: null });
  await run.until(/Approve this connection\? \[y\/N\] /);
  const done = await run.finished;
  assert.match(done.error?.message ?? '', /The temporary trial reached its .* shutdown limit\. Route cleanup will be attempted/);
  assert.equal(run.route.stopped, 1);
});

test('a run that loses the home lock removes nothing of the winner', async () => {
  const home = path.join(tmp, 'lost');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.dalan-trial'), 'created by `dalan try`\n');
  fs.writeFileSync(path.join(home, 'resource-url'), 'winner');
  fs.writeFileSync(path.join(home, '.hosted-lock'), `${process.pid} winner`);
  const run = await hostedRun('lost');
  const done = await run.finished;
  assert.match(done.error?.message ?? '', /another trial is using this home/);
  assert.equal(fs.readFileSync(path.join(home, 'resource-url'), 'utf8'), 'winner');
  assert.equal(run.route.started, 0);
});

// ---- the route contract in a hosted run ------------------------------------------------------------------------------------------------
test('unknown-origin bootstrap: a session route is allocated first, the gate answers 503 until the bridge is up, then Dalan verifies the address itself', async () => {
  const run = await hostedRun('bootstrap');
  try {
    await run.handoff();
    const calls = run.gozar.fake.state.calls;
    const exposes = calls.filter(name => name === 'expose');
    assert.equal(exposes.length, 1);
    assert.match(run.out, /Public HTTPS, OAuth discovery and the authorization server's metadata verified\./);
    assert.ok(run.out.indexOf('Public route ready.') < run.out.indexOf('Starting isolated trial'), 'the route exists before the bridge starts');
    assert.ok(run.out.indexOf('Starting isolated trial') < run.out.indexOf('verified.'), 'the address is verified after the bridge starts');
  } finally { await run.close(); }
});

test('--route NAME is passed to Gozar exactly as typed; an invented unknown name is Gozar\'s route_not_found and nothing is exposed', async () => {
  const run = await hostedRun('invented', { argv: ['--route', 'zq-invented-7'] });
  const done = await run.finished;
  assert.match(done.error?.message ?? '', /no route named|route_not_found|not found/i);
  assert.equal(done.error.tryKind, 'route_start');
  assert.equal(run.gozar.fake.state.effects.length, 0);
  assert.match(tryInternals.formatTryError(done.error, run.errorContext), /--route/);
});

test('a session stop closes exactly its handle; a saved durable route is left in place by the same stop', async () => {
  const session = await hostedRun('stop-session');
  await session.handoff();
  await session.close();
  assert.equal(session.route.stopped, 1, 'the session route is closed once');
  const durable = await hostedRun('stop-durable', { route: savedSetting('stop-durable') });
  try { await durable.handoff(); } finally { await durable.close(); }
  assert.equal(durable.gozar.fake.state.effects.filter(e => e.type === 'close-durable' || e.type === 'close').length, 0, 'an app exit never closes a durable route');
  assert.equal(durable.gozar.fake.state.pins.has('dalan-main'), true, 'the durable route is still pinned');
});

test('consent shows the disclosure Gozar returned and waits for yes before exposing anything', async () => {
  const run = await hostedRun('consent-yes', { consentAnswer: null });
  try {
    await run.until(/Use this route\? \[y\/N\]/);
    assert.match(run.out, /disclosure/i, 'the text shown is the one Gozar returned');
    assert.equal(run.gozar.fake.state.calls.includes('expose'), false, 'nothing is exposed before consent');
    run.input.write('y\n');
    await run.until(/Waiting for sign-in/);
    assert.equal(run.gozar.fake.state.calls.filter(name => name === 'expose').length, 1, 'yes permits one exposure');
  } finally { assert.equal((await run.close()).error, undefined); }
  assert.equal(run.route.stopped, 1);
});

test('denial or input EOF never exposes a route', async () => {
  for (const [name, answer] of [['deny', 'n\n'], ['eof', null]]) {
    const run = await hostedRun(`consent-${name}`, { consentAnswer: null });
    await run.until(/Use this route\? \[y\/N\]/);
    if (answer) run.input.write(answer); else run.input.end();
    const done = await run.finished;
    assert.match(done.error?.message ?? '', /No public route was started because consent was not given/);
    assert.equal(done.error.tryKind, 'consent');
    assert.equal(run.gozar.fake.state.calls.includes('expose'), false, `${name}: no route is exposed`);
    assert.equal(run.gozar.fake.state.effects.length, 0, `${name}: no route cleanup is needed`);
  }
});

test('route loss during approval revokes connections and closes bridge and gate', async () => {
  const run = await hostedRun('approval-loss');
  try {
    await run.until(/Waiting for sign-in/);
    const url = fs.readFileSync(path.join(run.home, 'resource-url'), 'utf8').trim();
    const first = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Approve this connection\? \[y\/N\]/);
    run.input.write('y\n');
    await first.complete();
    await run.until(/Connection approved/);
    await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    for (let i = 0; (run.out.match(/Approve this connection\?/g) ?? []).length < 2; i++) { assert.ok(i < 200); await sleepMs(25); }
    run.route.die();
    const result = await Promise.race([run.finished, sleepMs(5000).then(() => { throw new Error('hosted run stayed alive'); })]);
    assert.match(result.error?.message ?? '', /The temporary demo link stopped responding\. The connector cannot use this URL; the trial is stopping\./);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(run.home, '.config/dalan/as.sqlite'), { readOnly: true });
    try {
      assert.ok(db.prepare('SELECT count(*) AS total FROM connections').get().total > 0);
      assert.equal(db.prepare('SELECT count(*) AS active FROM connections WHERE revoked_at IS NULL').get().active, 0);
    } finally { db.close(); }
    for (const port of [run.route.gatePort, run.errorContext.bindPort]) await assert.rejects(realFetch(`http://127.0.0.1:${port}`));
  } finally { await run.close(); }
});

test('a route whose address changes ends the trial as changed and prints a fresh-home command', async () => {
  const run = await hostedRun('rotated');
  try {
    await run.handoff();
    run.gozar.fake.change(run.route.id, { published: 'https://fake-777.route.invalid', state: 'address_changed' });
    const done = await Promise.race([run.finished, sleepMs(5000).then(() => { throw new Error('the trial stayed alive after the address changed'); })]);
    assert.match(done.error?.message ?? '', /The temporary demo link changed its address\./);
    assert.match(tryInternals.formatTryError(done.error, run.errorContext), /Start fresh with:/);
    assert.equal(run.route.stopped, 1);
  } finally { await run.close(); }
});

test('two public identity failures interrupt an unanswered approval and ignore late yes', async () => {
  let failIdentity = false, failedChecks = 0;
  const fetchImpl = async (...args) => {
    if (failIdentity) { failedChecks++; return new Response('', { status: 502 }); }
    return fetch(...args);
  };
  const run = await hostedRun('route-loss', {
    fetchImpl,
    watchPublicIdentity: options => watchPublicIdentity({ ...options, intervalMs: 10, retryMs: 10, timeoutMs: 500 }),
  });
  try {
    const { url } = await run.handoff();
    const pairing = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Approve this connection\? \[y\/N\] /);
    failIdentity = true;
    const done = await Promise.race([run.finished, sleepMs(5000).then(() => { throw new Error('identity loss did not interrupt the approval question'); })]);
    assert.match(done.error?.message ?? '', /temporary demo link stopped responding/);
    assert.equal(failedChecks, 2, 'two consecutive 502 identity checks mark the route lost');
    assert.equal(run.route.stopped, 1, 'the lost route is cleaned up once');
    assert.doesNotMatch(run.out, /Connection approved\.|Paste this into the chat:|claim only req_|bridge first report/);
    const outputAtLoss = run.out;
    run.input.write('y\n');
    await sleepMs(30);
    assert.equal(run.out, outputAtLoss, 'late yes creates no approval or demo prompt');
    assert.ok(pairing.code, 'a matching approval question was presented before route loss');
  } finally { await run.close(); }
});

test('the gate restores the public Host and keeps the Origin header intact', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.headers.host !== 'fake-1.route.invalid') { res.writeHead(421); res.end(); return; }
    res.writeHead(req.headers.origin === 'https://evil.example' ? 403 : 200);
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gate = await createGate();
  try {
    gate.open(upstream.address().port, { publicOrigin: 'https://fake-1.route.invalid' });
    const target = `http://127.0.0.1:${gate.port}/mcp`;
    assert.equal((await realFetch(target)).status, 200, 'Gozar rewrites Host to the loopback target; restore the configured public host');
    const wrongHost = await new Promise((resolve, reject) => {
      const request = http.get(target, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(wrongHost, 421, 'an unrelated host is still rejected');
    assert.equal((await realFetch(target, { headers: { origin: 'https://evil.example' } })).status, 403, 'Origin is preserved for Dalan to check');
  } finally { await gate.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('a session route asks Gozar for the trial lifetime and for allocation only', async () => {
  const run = await hostedRun('lifetime');
  try {
    await run.handoff();
    const exposed = run.gozar.fake.state.effects.find(e => e.type === 'expose');
    assert.ok(exposed.lifetimeMs > 0 && exposed.lifetimeMs <= 3 * 60 * 60 * 1000, `bounded lifetime, got ${exposed.lifetimeMs}`);
    assert.equal(exposed.target, `127.0.0.1:${run.route.gatePort}`, 'the target is the gate, never the bridge bind address');
  } finally { await run.close(); }
});

test('the gate answers 503 until the bridge port is set, forwards to that one port, and refuses again when shut', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'x-saw': req.url }); res.end('bridge'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gate = await createGate();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${gate.port}/x`)).status, 503);
    gate.open(upstream.address().port);
    const through = await fetch(`http://127.0.0.1:${gate.port}/a/b`);
    assert.equal(through.status, 200);
    assert.equal(through.headers.get('x-saw'), '/a/b');
    gate.shut();
    assert.equal((await fetch(`http://127.0.0.1:${gate.port}/x`)).status, 503);
  } finally { await gate.close(); upstream.close(); }
  assert.equal(await closed(gate.port), true);
});

test('public readiness: wrong resource, wrong issuer, an unauthenticated 200 or an exposed owner route is not ready', async () => {
  const origin = 'https://demo.example', secret = randomBytes(32).toString('hex');
  const issuer = `${origin}/${secret}/oauth`;
  const good = {
    meta: { resource: `${origin}/${secret}/mcp`, authorization_servers: [issuer] },
    as: { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/reg` },
  };
  const asPath = `/.well-known/oauth-authorization-server/${secret}/oauth`;
  const respond = (overrides = {}) => async (url, init = {}) => {
    const u = new URL(url);
    if (overrides[u.pathname]) return overrides[u.pathname]();
    if (u.pathname === asPath) return Response.json(good.as);
    if (u.pathname.startsWith('/.well-known/')) return Response.json(good.meta);
    if (u.pathname === `/${secret}/mcp`) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="x"' } });
    return new Response('', { status: 404 });
  };
  const check = async overrides => verifyPublicReady({ origin, secret, fetchImpl: respond(overrides), clock: virtualClock(), timeoutMs: 6000 });
  assert.equal((await check({})).ready, true);
  assert.match((await check({ [`/.well-known/oauth-protected-resource/${secret}/mcp`]: () => Response.json({ resource: 'https://other/x', authorization_servers: [] }) })).last, /different resource/);
  assert.match((await check({ [`/.well-known/oauth-protected-resource/${secret}/mcp`]: () => Response.json({ resource: good.meta.resource, authorization_servers: ['https://elsewhere.example/o'] }) })).last, /outside this origin.*trial constraint/);
  assert.match((await check({ [`/${secret}/mcp`]: () => new Response('{}', { status: 200 }) })).last, /not an OAuth challenge/);
  // The discovery chain is checked to its end: a non-empty list, the issuer's own metadata with the exact issuer, and https endpoints on this origin.
  const prm = authorization_servers => ({ [`/.well-known/oauth-protected-resource/${secret}/mcp`]: () => Response.json({ resource: good.meta.resource, authorization_servers }) });
  assert.match((await check(prm([]))).last, /no authorization server/);
  assert.match((await check({ [asPath]: () => Response.json({ ...good.as, issuer: `${issuer}/` }) })).last, /issuer.*does not match/);
  assert.match((await check({ [asPath]: () => Response.json({ ...good.as, token_endpoint: `http://demo.example.test/${secret}/oauth/token` }) })).last, /token_endpoint/);
  assert.match((await check({ [asPath]: () => Response.json({ ...good.as, authorization_endpoint: 'https://elsewhere.example/auth' }) })).last, /authorization_endpoint/);
  const { registration_endpoint, ...noReg } = good.as;
  assert.match((await check({ [asPath]: () => Response.json(noReg) })).last, /registration_endpoint/);
  assert.match((await check({ [asPath]: () => new Response('', { status: 404 }) })).last, /authorization-server metadata returned HTTP 404/);
  // RFC 8414 section 3.1: a terminal slash of the issuer's path is dropped from the well-known URL, the issuer stays exact; a bare root issuer works.
  const slashIssuer = `${issuer}/`, slashPath = `/.well-known/oauth-authorization-server/${secret}/oauth`;
  const asSlash = { ...good.as, issuer: slashIssuer };
  const lookups = [];
  const viaSlash = fetchImpl => verifyPublicReady({ origin, secret, fetchImpl, clock: virtualClock(), timeoutMs: 6000 });
  const slashFetch = async (url, init) => { const u = new URL(url); lookups.push(u.pathname); return u.pathname === slashPath ? Response.json(asSlash) : u.pathname.startsWith('/.well-known/oauth-protected') ? Response.json({ ...good.meta, authorization_servers: [slashIssuer] }) : respond()(url, init); };
  assert.equal((await viaSlash(slashFetch)).ready, true, 'a trailing-slash issuer is looked up without the slash and compared exactly');
  assert.ok(lookups.includes(slashPath) && !lookups.some(l => l.endsWith('/oauth/')), lookups.join(' '));
  const bareFetch = async (url, init) => { const u = new URL(url); return u.pathname === '/.well-known/oauth-authorization-server' ? Response.json({ ...good.as, issuer: origin, authorization_endpoint: `${origin}/auth`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/reg` }) : u.pathname.startsWith('/.well-known/oauth-protected') ? Response.json({ ...good.meta, authorization_servers: [origin] }) : respond()(url, init); };
  assert.equal((await viaSlash(bareFetch)).ready, true, 'a bare root issuer is accepted');
  const lastOf = fetchImpl => viaSlash(fetchImpl).then(r => r.last);
  assert.match(await lastOf(async (url, init) => new URL(url).pathname === slashPath ? Response.json({ ...asSlash, issuer }) : slashFetch(url, init)), /does not match/, 'issuer equality stays exact, slash included');
  for (const bad of [`${issuer}?x=1`, `${issuer}#frag`]) {
    const seen = [];
    const r = await viaSlash(async (url, init) => { const u = new URL(url); seen.push(u.pathname); return u.pathname.startsWith('/.well-known/oauth-protected') ? Response.json({ ...good.meta, authorization_servers: [bad] }) : respond()(url, init); });
    assert.match(r.last, /not a plain address/);
    assert.ok(!seen.some(p => p.startsWith('/.well-known/oauth-authorization-server')), 'the issuer is not mapped to a lookup');
  }
  assert.match(authorizationServerMetadataUrl('https://x.example/tenant/'), /oauth-authorization-server\/tenant$/);
  assert.equal(authorizationServerMetadataUrl('https://x.example'), 'https://x.example/.well-known/oauth-authorization-server');
  assert.match((await check({ '/connect/pending': () => new Response('{}', { status: 200 }) })).last, /\/connect\/pending answers on the public address/);
  assert.match((await check({ [`/.well-known/oauth-protected-resource/${secret}/mcp`]: () => new Response('', { status: 503 }) })).last, /HTTP 503/);
});

test('uaToken names a known caller class and never echoes the caller\'s own text', () => {
  const of = ua => uaToken({ headers: ua === undefined ? {} : { 'user-agent': ua } });
  for (const [ua, want] of [['Claude-User/1.0 (+Anthropic)', 'Claude-User'], ['ClaudeBot/1.0', 'ClaudeBot'], ['anthropic-ai/1.0', 'anthropic-ai'], ['ChatGPT-User/1.0', 'ChatGPT-User'], ['OAI-SearchBot/1.0', 'OAI-SearchBot'],
    ['node', 'node'], ['undici', 'undici'], ['curl/8.5', 'curl'], ['python-httpx/0.27', 'python'], ['Python-urllib/3.12', 'python'], ['Mozilla/5.0 (X11)', 'Mozilla'], ['Zq8Lm3Vx9Tn2Rb7Kd4Hs6Pw1Yc5Jf0GH', 'other'], ['Zq8Lm3Vx9Tn2Rb7Kd4Hs6Pw1Yc5Jf0GH/1.0', 'other'], ['', null], [undefined, null]]) {
    assert.equal(of(ua), want, String(ua));
  }
});

test('a second run on a home that is in use leaves its files alone; a lock whose owner is gone is taken over', () => {
  const home = path.join(tmp, 'lockhome');
  fs.mkdirSync(home, { recursive: true });
  const release = acquireHomeLock(home);
  assert.throws(() => acquireHomeLock(home), /another trial is using this home/);
  release();
  assert.equal(fs.existsSync(path.join(home, '.hosted-lock')), false);
  fs.writeFileSync(path.join(home, '.hosted-lock'), '2147483646 stale');
  acquireHomeLock(home)();
  fs.writeFileSync(path.join(home, '.hosted-lock'), 'not a pid');
  assert.throws(() => acquireHomeLock(home), /another trial is using this home/, 'an unreadable lock is not taken over');
});

test('children of a trial that was killed are ended by the next trial, only when the process still matches', async () => {
  const registry = path.join(tmp, 'children');
  const live = new Map([[111, 'ssh -R x'], [222, 'ssh -R y'], [999, 'node bin/dalan.mjs try']]);
  const processCmd = pid => live.has(pid) ? { state: 'present', command: live.get(pid), start: `start-${pid}` } : { state: 'absent' };
  const killed = [];
  const kill = (pid, signal) => { killed.push([pid, signal]); live.delete(pid); };
  registerChild({ registry, child: { pid: 111 }, processCmd, owner: 998 }); // owner 998 is gone
  registerChild({ registry, child: { pid: 222 }, processCmd, owner: 999 }); // owner 999 still runs
  fs.writeFileSync(path.join(registry, '333.json'), JSON.stringify({ pid: 333, cmd: 'ssh -R z', owner: 998, ownerStart: 'old-owner' })); // pid 333 now belongs to another process
  live.set(333, 'vim notes.txt');
  const ended = await sweepChildren({ registry, processCmd, kill, clock: { sleep: async () => {} } });
  assert.deepEqual(ended, [111]);
  assert.deepEqual(killed, [[111, 'SIGTERM']]);
  assert.ok(live.has(222) && live.has(333), 'a live owner and a reused PID are left alone');
  assert.deepEqual(fs.readdirSync(registry).sort(), ['222.json']);
});
