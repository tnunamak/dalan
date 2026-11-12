// `dalan try --public`: the hosted-client path. No real tunnel, no real Tailscale, no ChatGPT or claude.ai account.
// A fake route (a relay on its own port, so the public address is not the bridge's bind address) and a scripted hosted client
// stand in for the outside. The bridge, its OAuth server, its MCP tools and the CLI are the real ones.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
const { chooseMode } = tryHostedInternals;
import { handoffText, hostedPrompt, CLIENTS } from '../src/try-hosted-clients.mjs';
import { uaToken } from '../src/mcp-outcome.mjs';
import { runSelfCheck } from '../src/try-selfcheck.mjs';
import { sweepTrialNodes, gozarProvider, localhostRunProvider, parseLocalhostRunOrigins, createGate, explainTailscale, authorizationServerMetadataUrl, processCommand, startRoute, tailscaleNodeProvider, tailscaleProvider, verifyPublicReady } from '../src/try-exposure.mjs';
import { acquireHomeLock } from '../src/try-hosted.mjs';
import { registerChild, sweepChildren } from '../src/child-registry.mjs';
import { writeRouteSetting } from '../src/route-setting.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tempRoot, 'dhost-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const virtualClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };

// ---- fakes -------------------------------------------------------------------------------------------------------------
// A route on its own port that relays to the gate it is given. `origin` is not the bridge's address.
function fakeRoute(name = 'localhost.run') {
  const record = { started: 0, stopped: 0, gatePort: null, server: null, origin: null };
  const provider = {
    name,
    probe: () => ({ ok: true, origin: 'http://127.0.0.1:0' }),
    async diagnose({ say }) { record.diagnosed = record.stopped; say('TLS certificate: error (fake)'); },
    async start({ gatePort }) {
      record.started++; record.gatePort = gatePort;
      const relay = http.createServer((req, res) => {
        const forward = http.request({ host: '127.0.0.1', port: gatePort, method: req.method, path: req.url, headers: req.headers }, answer => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res); });
        forward.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(forward);
      });
      await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
      record.server = relay;
      record.origin = `http://127.0.0.1:${relay.address().port}`;
      return { origin: record.origin, exited: new Promise(resolve => { record.die = resolve; }) };
    },
    async stop() { record.stopped++; record.server?.closeAllConnections(); await new Promise(resolve => record.server?.close(resolve) ?? resolve()); return { removed: true }; },
  };
  return { provider, record };
}
const unreadyTailscale = reason => ({ name: 'tailscale', probe: () => ({ ok: false, line: reason, fix: reason }), start: async () => { throw new Error('must not start'); }, stop: async () => ({ removed: true }) });

// ---- a hosted run ------------------------------------------------------------------------------------------------------
async function hostedRun(name, { argv = [], providers, clock, fetchImpl, route: savedRoute, trialMs, noHome } = {}) {
  const home = path.join(tmp, name);
  const port = await reservedPort();
  const route = fakeRoute();
  if (savedRoute) writeRouteSetting(savedRoute, { XDG_CONFIG_HOME: path.join(tmp, `cfg-${name}`) });
  const run = { out: '', input: new PassThrough(), controller: new AbortController(), home, route: route.record, errorContext: { started: false, shellCli: `'${path.join(repo, 'bin/dalan.mjs')}'` } };
  run.finished = runTry({
    argv: ['--public', '--client', 'chatgpt', ...(noHome ? [] : ['--home', home]), '--port', String(port), ...argv], env: { PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(tmp, `cfg-${name}`), XDG_CACHE_HOME: path.join(tmp, `cache-${name}`), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    out: { write: text => { run.out += text; } }, input: run.input, signal: run.controller.signal, errorContext: run.errorContext, clock,
    hosted: { interactive: true, providers: providers ?? [route.provider], serverEnv: { DALAN_TEST_OAUTH: '1' }, fetchImpl, ...(trialMs ? { trialMs } : {}) },
  }).then(() => ({}), error => ({ error }));
  run.until = async (pattern, ms = 60_000) => {
    for (let waited = 0; !pattern.test(run.out); waited += 50) {
      if (waited > ms) throw new Error(`never saw ${pattern}\n${run.out.replace(/[0-9a-f]{64}/g, '<secret>')}`);
      await sleepMs(50);
    }
    return run.out.match(pattern);
  };
  run.close = async () => { run.controller.abort(); return run.finished; };
  // Sign-in needs only the URL; the job prompt becomes available after approval.
  run.handoff = async () => ({ url: (await run.until(/^(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/mcp)$/m))[1] });
  run.prompt = async () => {
    const requestId = (await run.until(/claim only (req_[0-9a-f-]+),/))[1];
    const phrase = (await run.until(/requested report \((bridge first report [0-9a-f]{8})\)/))[1];
    return { requestId, phrase };
  };
  return run;
}
const approveAs = async (run, { callback = CHATGPT_CALLBACK, answer = 'y\n' } = {}) => {
  const { url } = await run.handoff();
  const pairing = await beginPairing(url, { redirect: callback, clientName: 'ChatGPT' });
  return { url, pairing, ...(answer ? { answered: (async () => { await run.until(/Approve this connection\? \[y\/N\] /); assert.match(run.out, new RegExp(`code        ${pairing.code}`)); run.input.write(answer); })() } : {}) };
};

test('Enter, Enter: the hosted ChatGPT path from a bare `try`, end to end with a stand-in hosted client', async () => {
  const run = await hostedRun('e2e');
  try {
    const { url } = await run.handoff();
    // Every value is filled in: no placeholder, and the handoff names the connector and the sign-in steps.
    const handoff = run.out.slice(run.out.indexOf('Connector name:'));
    assert.doesNotMatch(handoff, /<[A-Za-z _-]+>|PATTERN|NAME|PORT|HOME_PATH|YOUR_/, 'the handoff has no placeholder');
    assert.match(handoff, /Connector name: Dalan Trial/);
    for (const step of CLIENTS.chatgpt.steps) assert.ok(handoff.includes(step), step);
    assert.doesNotMatch(handoff, /Paste this into the chat:|claim only req_|bridge first report/);
    const origin = new URL(url).origin;
    assert.notEqual(Number(new URL(origin).port), run.errorContext.bindPort, 'the public origin is not the bridge bind address');
    assert.match(run.out, /Public HTTPS, OAuth discovery and the authorization server's metadata verified\./);
    assert.match(run.out, /^Trial link via localhost\.run, a third-party relay that can see this traffic; the address changes within hours\. For daily use: dalan setup$/m, 'one trial disclaimer before the URL');
    assert.ok(run.out.indexOf('Trial link via localhost.run') < run.out.indexOf('Paste this URL'));
    assert.equal(run.out.match(/Trial link via/g).length, 1);
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
    // The transport is JSON, never SSE: Quick Tunnel does not carry SSE.
    const call = await openSession(url, token);
    await assert.doesNotReject(call('list_pending', {}));
    const raw = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
    assert.match(raw.headers.get('content-type'), /^application\/json/);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405, 'the optional GET stream is refused');
  } finally {
    const result = await run.close();
    assert.equal(result.error, undefined, String(result.error?.message));
  }
  assert.match(run.out, /Public route removed\. Bridge stopped\./);
  assert.match(run.out, new RegExp(`Trial history kept at ${run.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(run.route.stopped, 1, 'the route was stopped exactly once');
  assert.match(run.out, /To run it again: .*try --public --client chatgpt --route localhost.run\n/, 'the restart command keeps every selection');
  assert.doesNotMatch(run.out.split('To run it again:')[1], /--home/, 'a new address needs a new home, so the restart command names none');
  // After a normal stop no credential is left in the trial home.
  assert.equal(fs.existsSync(path.join(run.home, 'resource-url')), false, 'the connector URL file is removed');
  assert.deepEqual(filesHolding(run.home, secretPath), [], 'the secret path is in no file after the stop');
  assert.equal(await closed(run.route.gatePort), true, 'the gate is closed');
});

let secretPath = null;
const filesHolding = (root, needle) => {
  const hits = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.isFile() && fs.readFileSync(f).includes(needle)) hits.push(path.relative(root, f)); } };
  walk(root); return hits;
};
const closed = port => new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); });

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

test('the default answer is No, and another client\'s callback is never offered for approval', async () => {
  const run = await hostedRun('refusals');
  try {
    const { url } = await run.handoff();
    // Claude's callback on a ChatGPT trial: shown, refused, and no question asked.
    await beginPairing(url, { redirect: CLAUDE_CALLBACK, clientName: 'claude' });
    await run.until(/Not approving: its callback is not ChatGPT's\./);
    assert.doesNotMatch(run.out, /Approve this connection\?/);
    // A blank answer does not approve.
    const pairing = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Approve this connection\? \[y\/N\] /);
    run.input.write('\n');
    await run.until(/Not approved\./);
    assert.doesNotMatch(run.out, /Approve later with:/);
    assert.match(run.out, /Start sign-in again in ChatGPT; approve the new matching code here to get the demo prompt\./);
    assert.doesNotMatch(run.out, /Connection approved|Paste this into the chat:|claim only req_|bridge first report/);
    assert.ok(pairing.code);
  } finally { await run.close(); }
});

test('the Claude profile uses its own callback and its own steps', async () => {
  const run = await hostedRun('claude', { argv: [] });
  run.controller.abort(); await run.finished;
  const claude = path.join(tmp, 'claude2');
  const route = fakeRoute();
  const input = new PassThrough(), controller = new AbortController();
  let out = '';
  const finished = runTry({ argv: ['--public', '--client', 'claude', '--home', claude, '--port', String(await reservedPort())], env: { PATH: process.env.PATH }, out: { write: t => { out += t; } }, input, signal: controller.signal, errorContext: { started: false },
    hosted: { interactive: true, providers: [route.provider], serverEnv: { DALAN_TEST_OAUTH: '1' } } }).catch(error => error);
  try {
    for (let i = 0; i < 400 && !/\/mcp$/m.test(out); i++) await sleepMs(50);
    const url = /^(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/mcp)$/m.exec(out)[1];
    assert.match(out, /Customize → Connectors/);
    assert.doesNotMatch(out, /Settings → Apps|Paste this into the chat:|claim only req_|bridge first report/);
    const pairing = await beginPairing(url, { redirect: CLAUDE_CALLBACK, clientName: 'claude' });
    for (let i = 0; i < 400 && !/Approve this connection\? \[y\/N\] /.test(out); i++) await sleepMs(50);
    input.write('y\n');
    await pairing.complete();
    for (let i = 0; i < 400 && !out.includes('Paste this into the chat:'); i++) await sleepMs(50);
    assert.ok(out.indexOf('Connection approved.') >= 0 && out.indexOf('Paste this into the chat:') > out.indexOf('Connection approved.'));
    assert.match(out, new RegExp(CLAUDE_CALLBACK.replace(/[./]/g, '\\$&')));
  } finally { controller.abort(); await finished; }
});

test('claude.ai\'s order: challenge, discovery from the challenge, registration, sign-in, token, then an MCP call; every step is in the log by name', async () => {
  const home = path.join(tmp, 'claudeflow');
  const route = fakeRoute();
  const input = new PassThrough(), controller = new AbortController();
  let out = '';
  const finished = runTry({ argv: ['--public', '--client', 'claude', '--home', home, '--port', String(await reservedPort())], env: { PATH: process.env.PATH }, out: { write: t => { out += t; } }, input, signal: controller.signal, errorContext: { started: false },
    hosted: { interactive: true, providers: [route.provider], serverEnv: { DALAN_TEST_OAUTH: '1' } } }).catch(error => error);
  try {
    for (let i = 0; i < 400 && !/\/mcp$/m.test(out); i++) await sleepMs(50);
    const url = /^(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/mcp)$/m.exec(out)[1];
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
    for (let i = 0; i < 400 && !/Approve this connection\? \[y\/N\] /.test(out); i++) await sleepMs(50);
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
  const home = path.join(tmp, 'selfcheck');
  const route = fakeRoute();
  const input = new PassThrough(), controller = new AbortController();
  let out = '';
  const finished = runTry({ argv: ['--public', '--client', 'claude', '--home', home, '--port', String(await reservedPort())], env: { PATH: process.env.PATH }, out: { write: t => { out += t; } }, input, signal: controller.signal, errorContext: {},
    hosted: { interactive: true, providers: [route.provider], serverEnv: { DALAN_TEST_OAUTH: '1' } } }).catch(error => error);
  try {
    for (let i = 0; i < 400 && !/\/mcp$/m.test(out); i++) await sleepMs(50);
    const url = /^(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/mcp)$/m.exec(out)[1];
    const secret = new URL(url).pathname.split('/')[1];
    const lines = [];
    const checking = runSelfCheck({ url, client: 'claude', approveWaitMs: 30_000, say: l => lines.push(l) });
    for (let i = 0; i < 400 && !/Approve this connection\? \[y\/N\] /.test(out); i++) await sleepMs(50);
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
  const url = 'https://demo.example/' + 'a'.repeat(64) + '/mcp';
  const lines = [];
  const fetchImpl = async (u, init = {}) => {
    if (init.method === 'POST' && String(u) === url) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://demo.example/.well-known/oauth-protected-resource/x/mcp"' } });
    return Response.json({ resource: url, authorization_servers: [] });
  };
  const result = await runSelfCheck({ url, client: 'chatgpt', fetchImpl, say: l => lines.push(l) });
  assert.equal(result.ok, false);
  assert.match(lines.join('\n'), /PASS challenge[^\n]*\nFAIL discovery[^\n]*no authorization server\nSKIP metadata[^\n]*\nSKIP registration/);
  assert.equal(lines.at(-1), 'RESULT FAIL');
  assert.ok(!lines.join('\n').includes('a'.repeat(64)), 'the secret path is not printed');
});

async function liveSelfCheck(wrapFetch) {
  const home = path.join(tmp, `sc-${Math.random().toString(16).slice(2, 8)}`);
  const route = fakeRoute();
  const input = new PassThrough(), controller = new AbortController();
  let out = '';
  const finished = runTry({ argv: ['--public', '--client', 'claude', '--home', home, '--port', String(await reservedPort())], env: { PATH: process.env.PATH }, out: { write: t => { out += t; } }, input, signal: controller.signal, errorContext: {},
    hosted: { interactive: true, providers: [route.provider], serverEnv: { DALAN_TEST_OAUTH: '1' } } }).catch(error => error);
  try {
    for (let i = 0; i < 400 && !/\/mcp$/m.test(out); i++) await sleepMs(50);
    const url = /^(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/mcp)$/m.exec(out)[1];
    const lines = [], sent = [];
    const fetchImpl = wrapFetch((u, init) => { sent.push({ url: String(u), init }); return fetch(u, init); });
    const checking = runSelfCheck({ url, client: 'claude', fetchImpl, approveWaitMs: 30_000, say: l => lines.push(l) });
    for (let i = 0; i < 400 && !/Approve this connection\? \[y\/N\] /.test(out) && !/FAIL/.test(lines.join()); i++) await sleepMs(50);
    input.write('y\n');
    return { result: await checking, lines, sent, url };
  } finally { controller.abort(); await finished; }
}

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
  const bad = await runSelfCheck({ url: 'https://exa mple.test/SECRETSECRETSECRET/mcp', say: l => lines.push(l) });
  assert.equal(bad.ok, false);
  assert.deepEqual(lines, ['FAIL input: the trial URL is not a valid web address', 'RESULT FAIL']);
  assert.equal(JSON.stringify(bad).includes('SECRETSECRETSECRET'), false);
  const text = [];
  const url = 'https://demo.example/' + 'b'.repeat(64) + '/mcp';
  const leaky = await runSelfCheck({ url, fetchImpl: async () => { throw new Error(`connect failed for ${url} with ${'b'.repeat(64)}`); }, say: l => text.push(l) });
  assert.equal(leaky.ok, false);
  assert.ok(!JSON.stringify(leaky).includes('b'.repeat(64)) && !text.join().includes('b'.repeat(64)), 'neither the lines nor the returned detail carry the secret');
  // A server that never finishes answering ends at the request deadline, not at the approval wait.
  const started = Date.now();
  const hung = await runSelfCheck({ url, requestMs: 100, fetchImpl: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), say() {} });
  assert.equal(hung.ok, false);
  assert.ok(Date.now() - started < 3000, 'bounded');
  // The CLI prints a fixed line for a malformed credential and never the credential.
  const cli = spawnSync(process.execPath, [path.join(repo, 'scripts/dalan-try-selfcheck.mjs'), '--client', 'claude'], { env: { PATH: process.env.PATH, DALAN_TRY_URL: 'https://exa mple.test/CLISECRETCLISECRET/mcp' }, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.doesNotMatch(cli.stdout + cli.stderr, /CLISECRET/);
});

// ---- route choice and the trial's own Tailscale node -----------------------------------------------------------------------
const stubProvider = (name, { ok = true, busy, startError, line = `${name} line`, fix = `${name} fix` } = {}) => {
  const record = { started: 0, stopped: 0 };
  return { record, name, probe: () => ok ? { ok: true } : { ok: false, line, fix, busy }, start: async () => { record.started++; if (startError) throw new Error(startError); return { origin: `https://${name}.example`, exited: new Promise(() => {}) }; }, stop: async () => { record.stopped++; return { removed: true }; } };
};
test('route choice: trial links are localhost.run, a real route is only Tailscale, and neither falls back to the other', async () => {
  const lines = [];
  const pick = async (route, providers) => startRoute({ route, providers, gatePort: 1, home: tmp, say: l => lines.push(l) }).then(r => ({ chosen: r.provider.name }), error => ({ error: error.message }));
  const lhr = () => stubProvider('localhost.run');
  // The trial route needs nothing but ssh and never touches Tailscale.
  const ts = stubProvider('tailscale'), node = stubProvider('tailscale-node'), trial = lhr();
  assert.equal((await pick('localhost.run', [ts, node, trial])).chosen, 'localhost.run');
  assert.equal(ts.record.started + node.record.started, 0);
  // ssh missing: one line with the fix, no other route.
  const noSsh = stubProvider('localhost.run', { ok: false, fix: 'ssh is not installed. Install OpenSSH.' });
  assert.deepEqual(await pick('localhost.run', [ts, noSsh]), { error: 'ssh is not installed. Install OpenSSH.' });
  // A real route: this computer's Tailscale on 443, else a node of the trial's own, else a clear stop (never localhost.run).
  assert.equal((await pick('tailscale', [stubProvider('tailscale'), node, lhr()])).chosen, 'tailscale');
  const busy = { ok: false, busy: true, line: 'Tailscale port 443 is not free for Funnel on this computer; its rules are unchanged.', fix: 'Free Funnel port 443' };
  const second = await pick('tailscale', [stubProvider('tailscale', busy), stubProvider('tailscale-node'), lhr()]);
  assert.equal(second.chosen, 'tailscale-node');
  assert.match(lines.join('\n'), /its rules are unchanged\. Starting a separate Tailscale node for this trial\./);
  const absent = stubProvider('tailscale', { ok: false, line: 'Tailscale is not installed.', fix: 'Install Tailscale from https://tailscale.com/download, run `tailscale up`, then retry.' });
  const refused = lhr();
  assert.match((await pick('tailscale', [absent, stubProvider('tailscale-node'), refused])).error, /Install Tailscale from https:\/\/tailscale\.com\/download/);
  assert.equal(refused.record.started, 0, 'a real route is never answered with a trial link');
  const failing = stubProvider('tailscale', { startError: 'serve failed' });
  assert.match((await pick('tailscale', [failing, refused])).error, /serve failed/);
  assert.equal(failing.record.stopped, 1, 'a failed start is cleaned up');
  assert.equal(refused.record.started, 0);
});

function nodeHarness({ certInspection, killGraceMs = 2000, certWaitMs = 60_000, certBehaviour = 'ok', upBehaviour = 'login-then-ok', host = {}, env = {}, loginWaitMs = 200, registry, daemonOutput = [], loginChunks = ['\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/abc123\n'] } = {}) {
  const fake = fakeTailscale(host);
  const events = { spawned: [], daemon: null, envs: [], keyDuringUp: null };
  registry ??= fs.mkdtempSync(path.join(tmp, 'registry-'));
  const spawnChild = (cmd, args, opts) => {
    events.spawned.push([cmd, ...args]); events.envs.push(opts?.env);
    if (cmd === 'tailscaled') {
      const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.pid = 777; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.exitCode = 0; child.emit('exit'); };
      events.daemon = child; setImmediate(() => { for (const chunk of daemonOutput) child.stderr.write(chunk); });
      return child;
    }
    if (args.includes('cert')) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.pid = 5555; events.certAlive = true;
      child.once('exit', () => { events.certAlive = false; });
      events.cert = { args, child, signals: [], files: args.filter(a => /^--(cert|key)-file=/.test(a)).map(a => a.split('=')[1]) };
      child.kill = sig => {
        events.cert.signals.push(sig); events.cert.dirAtKill = fs.existsSync(path.dirname(events.cert.files[0]));
        if ((certBehaviour === 'stubborn' || certBehaviour === 'late') && sig !== 'SIGKILL') return true; // ignores SIGTERM
        if (['immortal', 'error-live'].includes(certBehaviour)) return true; // ignores everything
        child.signalCode = sig;
        setTimeout(() => { events.cert.dirAtExit = fs.existsSync(path.dirname(events.cert.files[0])); child.emit('exit', null); }, certBehaviour === 'late' ? 150 : 10);
        return true;
      };
      setImmediate(() => {
        if (certBehaviour === 'error-live') child.emit('error', new Error('process-control failure'));
        if (certBehaviour === 'ok') { for (const f of events.cert.files) fs.writeFileSync(f, '-----BEGIN PRIVATE KEY-----\nPRIVATE-KEY-BODY\n-----END PRIVATE KEY-----\n'); child.exitCode = 0; child.emit('exit', 0); }
        if (certBehaviour === 'error-named') { child.stderr.write('500 Internal Server Error: no cert for box.tail1234.ts.net (owner@example.com)\n'); child.exitCode = 1; child.emit('exit', 1); }
        if (certBehaviour === 'error') { child.stderr.write('500 Internal Server Error: no TailscaleVarRoot\n'); child.exitCode = 1; child.emit('exit', 1); }
      });
      return child;
    }
    if (args.includes('up')) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
      child.kill = () => { child.exitCode = 1; child.emit('exit', 1); };
      const keyArg = args.find(a => a.startsWith('--auth-key=file:'));
      if (keyArg) events.keyDuringUp = fs.readFileSync(keyArg.slice('--auth-key=file:'.length), 'utf8');
      events.up = child;
      setImmediate(() => {
        if (upBehaviour === 'login-then-ok') { for (const chunk of loginChunks) child.stderr.write(chunk); setTimeout(() => { child.exitCode = 0; child.emit('exit', 0); }, 5); }
        if (upBehaviour === 'ok') { child.exitCode = 0; child.emit('exit', 0); }
      });
      return child;
    }
    return fake.spawnChild(cmd, args, opts);
  };
  const lines = [];
  const node = tailscaleNodeProvider({ env: { PATH: process.env.PATH, ...env }, spawnChild, runCli: () => fake.run, which: () => '/usr/bin/x', registry, clock: { sleep: async ms => { await sleepMs(ms === 250 ? 1 : ms); } }, newId: () => 'abc123', loginWaitMs, daemonWaitMs: 200, certWaitMs, killGraceMs, processCmd: pid => pid === 5555 ? (certInspection ? certInspection(events) : events.certAlive ? { state: 'present', command: 'tailscale cert', start: '100' } : { state: 'absent' }) : processCommand(pid) });
  return { node, fake, events, lines, registry, say: l => lines.push(l) };
}
const liveProcess = marker => spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', '--', marker], { stdio: 'ignore' });
const deadPid = () => new Promise(resolve => { const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }); c.once('exit', () => resolve(c.pid)); });
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the trial\'s own node: ephemeral userspace tailscaled, a one-time login line, a 443 Funnel, then logout and removal', async () => {
  const h = nodeHarness();
  assert.equal(h.node.probe().ok, true);
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  const started = await h.node.start({ gatePort: 6161, home, say: h.say });
  assert.equal(started.origin, 'https://box.tail1234.ts.net', '443 on the node\'s own address');
  const [daemon] = h.events.spawned;
  // tailscaled keeps TLS certificates under its var root, which --state=mem: does not provide: a state directory of its own is
  // needed or every first TLS hello fails with "no TailscaleVarRoot". It is inside tsnode, so it is deleted with it.
  assert.deepEqual(daemon, ['tailscaled', '--tun=userspace-networking', '--state=mem:', `--statedir=${home}/tsnode/state`, `--socket=${home}/tsnode/tailscaled.sock`, '--port=0'], 'in-memory node state, a private directory for certificates');
  assert.equal(fs.statSync(path.join(home, 'tsnode', 'state')).mode & 0o777, 0o700, 'the certificate directory is private');
  assert.ok(h.events.spawned.some(a => a[0] === 'tailscale' && a.includes('up') && a.includes('--hostname=dalan-trial-abc123')), 'its own hostname');
  assert.deepEqual(h.lines.filter(l => /login/.test(l)), ['This temporary Tailscale node needs a one-time sign-in. Open: https://login.tailscale.com/a/abc123'], 'one login line');
  const funnel = h.events.spawned.find(a => a.includes('funnel'));
  assert.deepEqual(funnel, ['tailscale', `--socket=${home}/tsnode/tailscaled.sock`, 'funnel', '--https=443', 'http://127.0.0.1:6161']);
  assert.deepEqual(fs.readdirSync(h.registry), ['dalan-trial-abc123.json'], 'the node is listed in the registry that any later trial reads');
  const stopped = await h.node.stop();
  assert.deepEqual(stopped, { removed: true });
  assert.equal(h.fake.state.loggedOut, true, 'the node is logged out');
  assert.equal(h.events.daemon.exitCode, 0, 'the daemon is ended');
  assert.equal(fs.existsSync(path.join(home, 'tsnode')), false, 'its directory is deleted');
  assert.deepEqual(fs.readdirSync(h.registry), []);
});

test('the trial\'s own node: a failed TLS certificate check prints one sanitized line, leaves no key material, and keeps the daemon log', async () => {
  for (const [behaviour, expected] of [['ok', /^TLS certificate: ok$/], ['error', /^TLS certificate: error \(500 Internal Server Error: no TailscaleVarRoot\)$/], ['hang', /^TLS certificate: error \(no answer in 1 s\)$/]]) {
    const h = nodeHarness({ certBehaviour: behaviour, certWaitMs: 1000, daemonOutput: ['2026/11/11 cert: tskey-auth-SECRETKEYVALUE failed\n', 'serve: TLS handshake error\n'] });
    const home = fs.mkdtempSync(path.join(tmp, 'node-'));
    await h.node.start({ gatePort: 6161, home, say: h.say });
    await sleepMs(30);
    const lines = []; await h.node.diagnose({ home, say: l => lines.push(l) });
    const certLines = lines.filter(l => l.startsWith('TLS certificate'));
    assert.equal(certLines.length, 1, behaviour); assert.match(certLines[0], expected);
    const cert = h.events.cert;
    assert.deepEqual(cert.args.filter(a => !a.startsWith('--cert-file=') && !a.startsWith('--key-file=')), [`--socket=${home}/tsnode/tailscaled.sock`, 'cert', 'box.tail1234.ts.net'], 'the node\'s own DNS name, on the node\'s own socket');
    const outDir = path.dirname(cert.files[0]);
    assert.notEqual(outDir, path.join(home, 'tsnode'), 'a private temporary directory of its own');
    assert.equal(fs.existsSync(outDir), false, 'the outputs are deleted');
    assert.ok(!lines.join('\n').includes('PRIVATE-KEY-BODY'), 'key material is never printed');
    const kept = fs.readFileSync(path.join(home, 'tailscaled.log'), 'utf8');
    assert.match(kept, /TLS handshake error/); assert.ok(!kept.includes('SECRETKEYVALUE'), 'the kept log is masked');
    assert.equal(fs.statSync(path.join(home, 'tailscaled.log')).mode & 0o777, 0o600);
    await h.node.stop();
    assert.equal(fs.existsSync(path.join(home, 'tsnode')), false);
    assert.equal(fs.existsSync(path.join(home, 'tailscaled.log')), true, 'the copy outlives the node directory');
    if (behaviour === 'hang') assert.equal(cert.child.signalCode, 'SIGTERM', 'a hung check is ended');
  }
  const idle = nodeHarness();
  await idle.node.diagnose({ home: tmp, say: () => { throw new Error('nothing to say before a node exists'); } });
});

test('the trial\'s own node: the certificate check ends on cancel, escalates past a child that ignores SIGTERM, and keeps its files under tsnode', async () => {
  // 1. Ctrl-C during the check: it ends at once, not after the 60 s limit, and the child gets SIGTERM.
  const a = nodeHarness({ certBehaviour: 'hang', certWaitMs: 60_000 });
  const homeA = fs.mkdtempSync(path.join(tmp, 'node-'));
  await a.node.start({ gatePort: 6161, home: homeA, say: a.say });
  const controller = new AbortController(), lines = [];
  const began = Date.now(), pending = a.node.diagnose({ home: homeA, say: l => lines.push(l), signal: controller.signal });
  await sleepMs(30);
  // 3. The files live inside tsnode, so the sweep of an abandoned trial removes them (a SIGKILLed trial never reaches its cleanup).
  const outDir = path.dirname(a.events.cert.files[0]);
  assert.equal(path.dirname(outDir), path.join(homeA, 'tsnode'), 'inside the registered node directory');
  assert.equal(fs.statSync(outDir).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(outDir, 'key'), 'PRIVATE-KEY-BODY');
  controller.abort();
  await pending;
  assert.ok(Date.now() - began < 5000, 'cancel does not wait for the 60 s limit');
  assert.deepEqual(a.events.cert.signals, ['SIGTERM']);
  assert.match(lines.join('\n'), /TLS certificate: error \(cancelled\)/);
  assert.equal(fs.existsSync(outDir), false);
  await a.node.stop();
  // The sweep: a record whose trial is gone loses its tsnode tree, including a key left by a killed check.
  const b = nodeHarness({ certBehaviour: 'hang', certWaitMs: 60_000 });
  const homeB = fs.mkdtempSync(path.join(tmp, 'node-'));
  await b.node.start({ gatePort: 6161, home: homeB, say: b.say });
  const pendingB = b.node.diagnose({ home: homeB, say() {} });
  await sleepMs(30);
  const leftover = path.dirname(b.events.cert.files[0]); fs.writeFileSync(path.join(leftover, 'key'), 'PRIVATE-KEY-BODY');
  const deferred = [];
  const held = await sweepTrialNodes({ registry: b.registry, processCmd: pid => pid === 5555 ? { state: 'unknown' } : { state: 'absent' }, say: line => deferred.push(line), kill() {}, clock: { sleep: async () => {} } });
  assert.deepEqual(held, []);
  assert.equal(b.events.certAlive, true);
  assert.equal(fs.existsSync(leftover), true, 'failed inspection cannot delete files under a live writer');
  assert.match(deferred.join('\n'), /certificate.*unknown/i);
  b.events.cert.child.kill('SIGTERM'); await pendingB;
  assert.equal(b.events.certAlive, false, 'the fake really exited before cleanup');
  const ended = await sweepTrialNodes({ registry: b.registry, processCmd: () => ({ state: 'absent' }), kill() {}, clock: { sleep: async () => {} } });
  assert.deepEqual(ended, ['dalan-trial-abc123']);
  assert.equal(fs.existsSync(leftover), false, 'the sweep removed the key');
  await b.node.stop();
  // 2. A child that ignores SIGTERM is killed, and the outputs are removed only after it has exited.
  const c = nodeHarness({ certBehaviour: 'stubborn', certWaitMs: 50, killGraceMs: 50 });
  const homeC = fs.mkdtempSync(path.join(tmp, 'node-'));
  await c.node.start({ gatePort: 6161, home: homeC, say: c.say });
  const linesC = []; await c.node.diagnose({ home: homeC, say: l => linesC.push(l) });
  assert.deepEqual(c.events.cert.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(c.events.cert.dirAtKill, true, 'the outputs still existed when the child was killed');
  assert.equal(c.events.cert.child.signalCode, 'SIGKILL');
  assert.equal(fs.existsSync(path.dirname(c.events.cert.files[0])), false);
  assert.match(linesC.join('\n'), /TLS certificate: error \(no answer in 0 s\)/);
  await c.node.stop();
});

test('the trial\'s own node: outputs wait for a late exit, and are kept for the sweep when the exit never comes', async () => {
  // A SIGKILLed child exits late: the files exist until then and are gone after.
  const late = nodeHarness({ certBehaviour: 'late', certWaitMs: 40, killGraceMs: 400 });
  const homeL = fs.mkdtempSync(path.join(tmp, 'node-'));
  await late.node.start({ gatePort: 6161, home: homeL, say: late.say });
  await late.node.diagnose({ home: homeL, say() {} });
  assert.deepEqual(late.events.cert.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(late.events.cert.dirAtExit, true, 'the outputs existed until the child exited');
  assert.equal(fs.existsSync(path.dirname(late.events.cert.files[0])), false, 'and were removed after');
  await late.node.stop();
  // A child that never exits: one SIGKILL only, the outputs stay under tsnode, the line says termination was not confirmed, the sweep owns the files.
  const never = nodeHarness({ certBehaviour: 'immortal', certWaitMs: 40, killGraceMs: 40 });
  const homeN = fs.mkdtempSync(path.join(tmp, 'node-'));
  await never.node.start({ gatePort: 6161, home: homeN, say: never.say });
  const lines = []; await never.node.diagnose({ home: homeN, say: l => lines.push(l) });
  const kept = path.dirname(never.events.cert.files[0]);
  assert.deepEqual(never.events.cert.signals, ['SIGTERM', 'SIGKILL'], 'no second SIGKILL');
  assert.equal(path.dirname(kept), path.join(homeN, 'tsnode'));
  assert.equal(fs.existsSync(kept), true, 'not removed without a confirmed exit');
  assert.match(lines.join('\n'), /did not stop \(termination not confirmed\)/);
  // The node's own stop does not delete files of a child that has not exited: the rest of the node goes, its directory and record stay.
  await never.node.stop();
  assert.equal(fs.existsSync(kept), true, 'stop keeps the files of a cert child that never exited');
  assert.deepEqual(fs.readdirSync(path.join(homeN, 'tsnode')), [path.basename(kept)], 'and removes the rest');
  assert.deepEqual(fs.readdirSync(never.registry), ['dalan-trial-abc123.json'], 'the record stays, so the sweep finishes the job');
  // Owner and daemon are gone but the cert child still runs: the sweep keeps its folder and the record; after its exit it removes both.
  const alive = pid => pid === 5555 && never.events.certAlive ? { state: 'present', command: 'tailscale cert', start: '100' } : { state: 'absent' };
  const kept1 = await sweepTrialNodes({ registry: never.registry, processCmd: alive, kill() {}, clock: { sleep: async () => {} } });
  assert.deepEqual(kept1, [], 'nothing is ended while the cert child runs');
  assert.equal(fs.existsSync(kept), true, 'its folder stays');
  assert.deepEqual(fs.readdirSync(never.registry), ['dalan-trial-abc123.json'], 'and so does the record');
  const unknownLines = [];
  const unknown = await sweepTrialNodes({ registry: never.registry, processCmd: pid => pid === 5555 ? { state: 'unknown' } : { state: 'absent' }, say: line => unknownLines.push(line), kill() {}, clock: { sleep: async () => {} } });
  assert.deepEqual(unknown, []);
  assert.equal(never.events.certAlive, true);
  assert.equal(fs.existsSync(kept), true);
  assert.equal(fs.existsSync(path.join(never.registry, 'dalan-trial-abc123.json')), true);
  assert.match(unknownLines.join('\n'), /certificate.*unknown/i);
  never.events.cert.child.exitCode = 0; never.events.cert.child.emit('exit', 0);
  assert.equal(never.events.certAlive, false, 'confirmed fake exit precedes cleanup');
  const ended = await sweepTrialNodes({ registry: never.registry, processCmd: alive, kill() {}, clock: { sleep: async () => {} } });
  assert.deepEqual(ended, ['dalan-trial-abc123']);
  assert.equal(fs.existsSync(kept), false, 'removed after the exit is confirmed');
  assert.deepEqual(fs.readdirSync(never.registry), []);
});

test('process inspection separates failed checks from exit and reads Linux and macOS start identity', async () => {
  const error = code => Object.assign(new Error(code), { code });
  const stat = start => '123 (name with ) spaces) S ' + [...Array(18).fill('0'), start, '0'].join(' ');
  const linux = { platform: 'linux', readFile: () => stat('100'), run: () => ({ status: 0, stdout: 'tailscale cert\n' }) };
  assert.deepEqual(processCommand(123, linux), { state: 'present', command: 'tailscale cert', start: '100' });
  for (const failure of [{ status: null, error: error('ETIMEDOUT') }, { status: 1, stdout: '', stderr: 'denied' }, { status: 0, stdout: '' }]) {
    assert.deepEqual(processCommand(123, { ...linux, run: () => failure, probe() {} }), { state: 'unknown' });
  }
  assert.deepEqual(processCommand(123, { ...linux, readFile: () => { throw error('EACCES'); } }), { state: 'unknown' });
  assert.deepEqual(processCommand(123, { ...linux, readFile: () => 'malformed' }), { state: 'unknown' });
  assert.deepEqual(processCommand(123, { ...linux, readFile: () => { throw error('ENOENT'); }, probe: () => { throw error('ESRCH'); } }), { state: 'absent' });
  assert.deepEqual(processCommand(123, { ...linux, run: () => { throw error('ENOENT'); }, probe() {} }), { state: 'unknown' }, 'missing ps is not exit');
  let reads = 0;
  assert.deepEqual(processCommand(123, { ...linux, readFile: () => stat(String(++reads)) }), { state: 'unknown' }, 'PID reuse during ps is not a coherent identity');
  const darwin = { platform: 'darwin', run: (_cmd, args, opts) => {
    assert.equal(opts.env.LC_ALL, 'C'); assert.equal(opts.env.TZ, 'UTC');
    assert.deepEqual(args, ['-p', '123', '-o', 'lstart=,command=']);
    return { status: 0, stdout: 'Wed Nov 11 01:02:03 2026 tailscale cert\n' };
  } };
  assert.deepEqual(processCommand(123, darwin), { state: 'present', command: 'tailscale cert', start: 'Wed Nov 11 01:02:03 2026' });
  assert.deepEqual(processCommand(123, { platform: 'darwin', run: () => ({ status: 1 }), probe() {} }), { state: 'unknown' });
  assert.deepEqual(processCommand(123, { platform: 'darwin', run: () => ({ status: 1 }), probe: () => { throw error('EPERM'); } }), { state: 'unknown' });
  assert.deepEqual(processCommand(123, { platform: 'darwin', run: () => ({ status: 1 }), probe: () => { throw error('ESRCH'); } }), { state: 'absent' });
  const child = liveProcess('inspect-start-identity');
  try {
    await sleepMs(100);
    const inspected = processCommand(child.pid);
    assert.equal(inspected.state, 'present'); assert.ok(inspected.start); assert.match(inspected.command, /inspect-start-identity/);
  } finally { const gone = new Promise(resolve => child.once('exit', resolve)); child.kill(); await gone; }
  assert.deepEqual(processCommand(child.pid), { state: 'absent' });
});

test('a real live writer survives failed ps and identity reads, then its confirmed exit releases debt', async () => {
  const registry = fs.mkdtempSync(path.join(tmp, 'registry-'));
  const dir = path.join(fs.mkdtempSync(path.join(tmp, 'real-debt-')), 'tsnode'), out = path.join(dir, 'tlscheck-owned');
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'key'), 'private');
  const child = liveProcess('certificate-writer');
  const gone = new Promise(resolve => child.once('exit', resolve));
  const owner = await deadPid();
  const file = path.join(registry, 'debt.json');
  try {
    await sleepMs(100);
    const identity = processCommand(child.pid); assert.equal(identity.state, 'present');
    fs.writeFileSync(file, JSON.stringify({ dir, certOut: out, certPid: child.pid, certCmd: identity.command, certStart: identity.start, owner }));
    for (const fault of [
      { run: () => ({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }) },
      ...(process.platform === 'linux'
        ? [{ readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }]
        : [{ run: () => ({ status: 0, stdout: 'invalid start identity' }) }]),
    ]) {
      const lines = [];
      assert.deepEqual(await sweepTrialNodes({ registry, processCmd: pid => pid === owner ? { state: 'absent' } : processCommand(pid, fault), say: line => lines.push(line), kill() { assert.fail('writer is not signalled'); } }), []);
      assert.equal(isAlive(child.pid), true); assert.equal(fs.existsSync(out), true); assert.equal(fs.existsSync(file), true);
      assert.match(lines.join('\n'), /certificate.*unknown/i);
    }
  } finally { child.kill(); await gone; }
  assert.deepEqual(await sweepTrialNodes({ registry, processCmd: pid => pid === owner ? { state: 'absent' } : processCommand(pid) }), ['debt.json']);
  assert.equal(fs.existsSync(out), false); assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await sweepTrialNodes({ registry }), [], 'cleanup is idempotent');
});

test('initial certificate identity lookup failure persists cleanup debt before stop and sweep', async () => {
  const h = nodeHarness({ certBehaviour: 'immortal', certWaitMs: 20, killGraceMs: 20, certInspection: () => ({ state: 'unknown' }) });
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  await h.node.start({ gatePort: 6161, home, say: h.say });
  const pending = h.node.diagnose({ home, say: h.say });
  await sleepMs(5);
  const file = path.join(h.registry, 'dalan-trial-abc123.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.certPid, 5555, 'ownership recorded while diagnose is still waiting');
  assert.equal(rec.certStart, null);
  await pending; await h.node.stop();
  const lines = [];
  const held = await sweepTrialNodes({ registry: h.registry, processCmd: pid => pid === 5555 ? { state: 'present', command: 'tailscale cert', start: '100' } : { state: 'absent' }, say: line => lines.push(line), kill() {} });
  assert.deepEqual(held, []); assert.equal(h.events.certAlive, true);
  assert.equal(fs.existsSync(rec.certOut), true); assert.equal(fs.existsSync(file), true);
  assert.match(lines.join('\n'), /certificate.*unknown/i);
  h.events.cert.child.exitCode = 0; h.events.cert.child.emit('exit', 0);
  await sweepTrialNodes({ registry: h.registry, processCmd: () => ({ state: 'absent' }), kill() {} });
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(rec.certOut), false);
});

test('process-control errors after spawn do not confirm certificate exit', async () => {
  const h = nodeHarness({ certBehaviour: 'error-live', killGraceMs: 20 });
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  await h.node.start({ gatePort: 6161, home, say: h.say });
  await h.node.diagnose({ home, say: h.say });
  await h.node.stop();
  const out = path.dirname(h.events.cert.files[0]);
  assert.equal(h.events.certAlive, true); assert.equal(fs.existsSync(out), true);
  assert.deepEqual(h.events.cert.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(fs.existsSync(path.join(h.registry, 'dalan-trial-abc123.json')), true);
  h.events.cert.child.exitCode = 0; h.events.cert.child.emit('exit', 0);
  await sweepTrialNodes({ registry: h.registry, processCmd: () => ({ state: 'absent' }), kill() {} });
});

test('failed certificate identity persistence keeps the durable unknown marker and reports debt', async t => {
  const h = nodeHarness({ certBehaviour: 'immortal', killGraceMs: 20 });
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  await h.node.start({ gatePort: 6161, home, say: h.say });
  const file = path.join(h.registry, 'dalan-trial-abc123.json');
  const rename = fs.renameSync;
  let failed = false;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file && JSON.parse(fs.readFileSync(from, 'utf8')).certPid === 5555) {
      failed = true; throw new Error('injected identity persistence failure');
    }
    return rename(from, to);
  });
  await h.node.diagnose({ home, say: h.say });
  mocked.mock.restore();
  assert.equal(failed, true);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.certPid, null); assert.ok(rec.certOut);
  assert.match(h.lines.join('\n'), /identity persistence failure/);
  await h.node.stop();
  const lines = [];
  assert.deepEqual(await sweepTrialNodes({ registry: h.registry, processCmd: pid => pid === process.pid ? { state: 'absent' } : processCommand(pid), say: line => lines.push(line), kill() {} }), []);
  assert.equal(fs.existsSync(rec.certOut), true); assert.equal(fs.existsSync(file), true);
  assert.deepEqual(fs.readdirSync(h.registry), ['dalan-trial-abc123.json'], 'atomic-update scratch is removed');
  assert.match(lines.join('\n'), /certificate.*unknown/i);
  h.events.cert.child.exitCode = 0; h.events.cert.child.emit('exit', 0);
  // The placeholder has no PID to inspect. It remains manual cleanup debt even after this test ends the writer.
});

test('certificate cleanup debt survives unknown inspection and releases only on exit or identity mismatch', async () => {
  for (const [label, inspection, savedStart, releases] of [
    ['lookup failed', { state: 'unknown' }, '100', false],
    ['identity lookup failed', { state: 'unknown', command: 'tailscale cert' }, '100', false],
    ['same child', { state: 'present', command: 'tailscale cert', start: '100' }, '100', false],
    ['same start with changed command', { state: 'present', command: 'other', start: '100' }, '100', false],
    ['current start missing', { state: 'present', command: 'tailscale cert' }, '100', false],
    ['legacy identity missing', { state: 'present', command: 'tailscale cert', start: '100' }, null, false],
    ['confirmed exit', { state: 'absent' }, '100', true],
    ['PID reused with same command', { state: 'present', command: 'tailscale cert', start: '101' }, '100', true],
    ['PID reused with different command', { state: 'present', command: 'other', start: '101' }, '100', true],
  ]) {
    const registry = fs.mkdtempSync(path.join(tmp, 'registry-'));
    const dir = path.join(fs.mkdtempSync(path.join(tmp, 'debt-')), 'tsnode'), out = path.join(dir, 'tlscheck-owned');
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'key'), 'private');
    const owner = await deadPid();
    const file = path.join(registry, 'debt.json');
    fs.writeFileSync(file, JSON.stringify({ dir, certOut: out, certPid: 5555, certCmd: 'tailscale cert', certStart: savedStart, owner }));
    const lines = [];
    const ended = await sweepTrialNodes({ registry, processCmd: pid => pid === owner ? { state: 'absent' } : inspection, say: line => lines.push(line), kill() { assert.fail('certificate PID must not be signalled'); } });
    assert.equal(fs.existsSync(out), !releases, label);
    assert.equal(fs.existsSync(file), !releases, label);
    assert.equal(ended.length, releases ? 1 : 0, label);
    if (inspection.state === 'unknown' || (inspection.state === 'present' && !inspection.start) || !savedStart) assert.match(lines.join('\n'), /certificate.*unknown/i, label);
  }
});

test('the trial\'s own node: the identity is cached at sign-in; with none known, any email in the log and the error line is redacted', async () => {
  // Cached at sign-in: status fails later, the names are still redacted and the check still runs.
  const named = { ...readyStatus, CurrentTailnet: { MagicDNSEnabled: true, Name: 'owner@example.com' } };
  const a = nodeHarness({ certBehaviour: 'error-named', host: { status: named }, daemonOutput: ['joined tailnet owner@example.com as box.tail1234.ts.net\n'] });
  const homeA = fs.mkdtempSync(path.join(tmp, 'node-'));
  await a.node.start({ gatePort: 6161, home: homeA, say: a.say });
  await sleepMs(30);
  a.fake.state.statusFails = true;
  const linesA = []; await a.node.diagnose({ home: homeA, say: l => linesA.push(l) });
  assert.match(linesA.join('\n'), /TLS certificate: error \(500 Internal Server Error: no cert for \[tailnet name\] \(\[tailnet name\]\)\)/);
  assert.ok(!fs.readFileSync(path.join(homeA, 'tailscaled.log'), 'utf8').includes('owner@example.com'));
  await a.node.stop();
  // Never known (no tailnet name in status) and status failing: fail closed on anything email-shaped.
  const b = nodeHarness({ certBehaviour: 'error-named', daemonOutput: ['account someone.else+x@corp.example.org signed in; peer foo.tail9.ts.net\n'] });
  const homeB = fs.mkdtempSync(path.join(tmp, 'node-'));
  await b.node.start({ gatePort: 6161, home: homeB, say: b.say });
  await sleepMs(30);
  b.fake.state.statusFails = true;
  const linesB = []; await b.node.diagnose({ home: homeB, say: l => linesB.push(l) });
  const keptB = fs.readFileSync(path.join(homeB, 'tailscaled.log'), 'utf8');
  for (const secret of ['someone.else', 'corp.example.org', 'tail9', 'ts.net', 'owner@example.com']) { assert.ok(!keptB.includes(secret), `${secret} in the log`); assert.ok(!linesB.join('\n').includes(secret), `${secret} in the line`); }
  assert.match(keptB, /account \[email\] signed in/);
  await b.node.stop();
});

test('the trial\'s own node: tailnet and device names are redacted from the retained log and the certificate line', async () => {
  const status = { ...readyStatus, CurrentTailnet: { MagicDNSEnabled: true, Name: 'owner@example.com' } };
  const h = nodeHarness({ certBehaviour: 'error-named', host: { status }, daemonOutput: ['peer dalan-trial-abc123.tail1234.ts.net joined tailnet owner@example.com\n', 'serve: TLS handshake error for box.tail1234.ts.net\n'] });
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  await h.node.start({ gatePort: 6161, home, say: h.say });
  await sleepMs(30);
  const lines = []; await h.node.diagnose({ home, say: l => lines.push(l) });
  const kept = fs.readFileSync(path.join(home, 'tailscaled.log'), 'utf8');
  for (const secret of ['tail1234', 'ts.net', 'owner@example.com', 'box.']) { assert.ok(!kept.includes(secret), `${secret} not in the retained log`); assert.ok(!lines.join('\n').includes(secret), `${secret} not in the certificate line`); }
  assert.match(kept, /TLS handshake error for \[tailnet name\]/);
  assert.match(lines.join('\n'), /TLS certificate: error \(500 Internal Server Error: no cert for \[tailnet name\] \(\[tailnet name\]\)\)/);
  await h.node.stop();
});

test('the trial\'s own node: an unfinished login is a clean failure; a long home path is refused; a failed logout is not reported as removed', async () => {
  const h = nodeHarness({ upBehaviour: 'hang' });
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  await assert.rejects(h.node.start({ gatePort: 1, home, say: h.say }), /sign-in was not completed in time/);
  assert.deepEqual(await h.node.stop(), { removed: true }, 'a node that never signed in has nothing registered');
  assert.equal(h.fake.state.loggedOut, undefined);
  assert.equal(h.events.daemon.exitCode, 0);
  assert.equal(fs.existsSync(path.join(home, 'tsnode')), false);
  const long = nodeHarness({ upBehaviour: 'ok' });
  await assert.rejects(long.node.start({ gatePort: 1, home: path.join(tmp, 'x'.repeat(120)), say() {} }), /path is too long for a Tailscale socket/);
  assert.equal(long.events.spawned.length, 0, 'no process starts');
  assert.equal(tailscaleNodeProvider({ which: () => null }).probe().ok, false);
  // Logout fails: the daemon and files are still removed, but the result says the node may still be registered.
  const bad = nodeHarness({ upBehaviour: 'ok' });
  await bad.node.start({ gatePort: 1, home: fs.mkdtempSync(path.join(tmp, 'node-')), say() {} });
  bad.fake.state.logoutFails = true;
  const result = await bad.node.stop();
  assert.equal(result.removed, false);
  assert.match(result.detail, /dalan-trial-abc123 could not be logged out.*ephemeral.*admin console/);
  assert.equal(bad.events.daemon.exitCode, 0, 'the daemon is ended even so');
});

test('the trial\'s own node: the auth key is in no argument or environment, only in a file that is gone once login ends; the daemon log is masked', async () => {
  const h = nodeHarness({ upBehaviour: 'ok', env: { DALAN_TS_AUTHKEY: 'tskey-auth-SECRETSECRET' }, daemonOutput: ['boot with tskey-auth-SECRETSECRET\nvisit https://login.tailscale.com/a/LOGINTOKEN ok\n'] });
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  await h.node.start({ gatePort: 1, home, say: h.say });
  assert.equal(h.events.keyDuringUp, 'tskey-auth-SECRETSECRET', 'tailscale up reads the key from a file');
  assert.equal(fs.existsSync(path.join(home, 'tsnode', 'authkey')), false, 'the key file is deleted as soon as login ends, not at the end of the run');
  assert.ok(!JSON.stringify(h.events.spawned).includes('SECRETSECRET'), 'never in an argument');
  assert.ok(h.events.envs.every(e => e && !('DALAN_TS_AUTHKEY' in e)), 'never in a child environment');
  const log = fs.readFileSync(path.join(home, 'tsnode', 'tailscaled.log'), 'utf8');
  assert.match(log, /boot with \[key\]/);
  assert.ok(!log.includes('SECRETSECRET') && !log.includes('LOGINTOKEN'), 'the daemon log holds no key or login token');
  await h.node.stop();
  assert.deepEqual(filesHolding(home, 'SECRETSECRET'), []);
  assert.deepEqual(filesHolding(h.registry, 'SECRETSECRET'), []);
});

test('the trial\'s own node: a login URL split across output chunks is announced whole, once', async () => {
  const h = nodeHarness({ loginChunks: ['To authenticate, visit:\n\n\thttps://login.tail', 'scale.com/a/ab', 'c123\n'] });
  await h.node.start({ gatePort: 1, home: fs.mkdtempSync(path.join(tmp, 'node-')), say: h.say });
  assert.deepEqual(h.lines.filter(l => /Open:/.test(l)), ['This temporary Tailscale node needs a one-time sign-in. Open: https://login.tailscale.com/a/abc123']);
  await h.node.stop();
});

test('the trial\'s own node: after login no timer keeps the process alive', async () => {
  const timers = () => process.getActiveResourcesInfo().filter(t => t === 'Timeout').length;
  const h = nodeHarness();
  const before = timers();
  await h.node.start({ gatePort: 1, home: fs.mkdtempSync(path.join(tmp, 'node-')), say: h.say });
  assert.equal(timers(), before, 'the login timeout was cleared when the login finished');
  await h.node.stop();
});

test('leftover trial daemons are found in any later run, by registry and a portable process check; a live trial is left alone', async () => {
  const registry = fs.mkdtempSync(path.join(tmp, 'registry-'));
  const root = fs.mkdtempSync(path.join(tmp, 'left-'));
  const mk = async (name, { ownerAlive }) => {
    const dir = path.join(root, name, 'tsnode'), sock = path.join(dir, 'tailscaled.sock');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'left'), 'x');
    const daemon = liveProcess(`--socket=${sock}`);
    const owner = ownerAlive ? liveProcess(`--owner-${name}`) : null;
    const ownerPid = owner ? owner.pid : await deadPid();
    await sleepMs(150); // let `ps` see both command lines
    fs.writeFileSync(path.join(registry, `${name}.json`), JSON.stringify({ dir, sock, hostname: name, pid: daemon.pid, owner: ownerPid, ownerCmd: processCommand(ownerPid).command ?? `node -e 0 --owner-${name}`, home: path.join(root, name) }));
    return { daemon, owner, dir };
  };
  const crashed = await mk('crashed', { ownerAlive: false });
  const running = await mk('running', { ownerAlive: true });
  try {
    const h = nodeHarness({ upBehaviour: 'ok', registry });
    // A trial in a DIFFERENT home sweeps the registry: the crashed trial's daemon ends, the running one stays.
    const ended = await h.node.recover();
    assert.deepEqual(ended, ['crashed']);
    await sleepMs(200);
    assert.equal(isAlive(crashed.daemon.pid), false, 'the crashed trial\'s daemon was ended');
    assert.equal(fs.existsSync(crashed.dir), false, 'its directory is gone');
    assert.equal(isAlive(running.daemon.pid), true, 'a trial whose process still runs is not touched');
    assert.ok(fs.existsSync(path.join(registry, 'running.json')));
    // A PID that now belongs to some other program is not killed.
    const other = liveProcess('--unrelated');
    await sleepMs(150);
    fs.writeFileSync(path.join(registry, 'reused.json'), JSON.stringify({ dir: path.join(root, 'reused', 'tsnode'), sock: path.join(root, 'reused', 'tsnode', 'tailscaled.sock'), hostname: 'reused', pid: other.pid, owner: await deadPid(), ownerCmd: 'x' }));
    await h.node.recover();
    assert.equal(isAlive(other.pid), true, 'the daemon is ended only if its command line still names the trial\'s socket');
    other.kill();
  } finally { crashed.daemon.kill(); running.daemon.kill(); running.owner?.kill(); }
});

test('Ctrl-C during startup ends it at once: nothing waits for the login, the node is cleaned up and a trial link is not tried', async () => {
  const h = nodeHarness({ upBehaviour: 'hang', loginWaitMs: 600_000 }); // the abort must come long before the login timeout
  const long = h.node;
  const cloudflare = stubProvider('localhost.run');
  const controller = new AbortController();
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  const busy = { ok: false, busy: true, line: 'busy', fix: 'free it' };
  const started = Date.now();
  const pending = startRoute({ route: 'tailscale', providers: [stubProvider('tailscale', busy), long, cloudflare], gatePort: 1, home, say() {}, signal: controller.signal });
  await sleepMs(80); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.ok(Date.now() - started < 5000, 'it did not wait for the ten-minute login timeout');
  assert.equal(cloudflare.record.started, 0, 'an abort is never answered by another route');
  assert.equal(h.events.daemon.exitCode, 0, 'the daemon was ended');
  assert.equal(fs.existsSync(path.join(home, 'tsnode')), false);
  // Readiness and the helper download stop on abort too.
  const gone = new AbortController(); gone.abort();
  await assert.rejects(verifyPublicReady({ origin: 'https://x.example', secret: 's', fetchImpl: async () => { throw new Error('should not fetch'); }, timeoutMs: 60_000, signal: gone.signal }), error => error.name === 'AbortError');
  const slow = new AbortController();
  const hang = localhostRunProvider({ env: {}, spawnChild: fakeSpawn([]).spawnChild, which: () => 'x', startMs: 60_000 });
  const waiting = hang.start({ gatePort: 1, home, signal: slow.signal });
  slow.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
});

test('the printed restart command: the same home only where the address is stable; a new home otherwise', () => {
  const base = { cli: 'dalan', home: '/h', shellQuote: x => x, client: 'claude', route: 'auto' };
  assert.equal(tryHostedInternals.restartCommand({ ...base, provider: 'tailscale' }), 'dalan try --public --client claude --route auto --home /h');
  for (const provider of ['localhost.run', 'tailscale-node']) assert.equal(tryHostedInternals.restartCommand({ ...base, provider }), 'dalan try --public --client claude --route auto', `${provider}: its next address is new, so the home would refuse it`);
});

test('a route that fails to start names the real next steps, not a new home', async () => {
  const home = path.join(tmp, 'routefail');
  const failing = { name: 'tailscale', probe: () => ({ ok: true, origin: 'x' }), start: async () => { throw new Error('tailscale funnel did not publish the rule'); }, stop: async () => ({ removed: true }) };
  const context = { shellCli: `'x'`, cli: 'dalan', shellHome: `'${home}'`, logFile: '/none', shellLog: '/none' };
  const error = await runTry({ argv: ['--public', '--route', 'tailscale', '--home', home], env: { PATH: process.env.PATH }, out: { write() {} }, input: new PassThrough(), errorContext: context, hosted: { interactive: true, providers: [failing] } }).then(() => null, e => e);
  assert.equal(error.tryKind, 'route_start');
  const text = tryInternals.formatTryError(error, context, { home: '/other', port: 1 });
  assert.match(text, /tailscale funnel did not publish the rule\nA Tailscale route never falls back to a trial link on its own[^\n]*\nThe public route did not start, so the bridge was not started\./);
  assert.doesNotMatch(text, /new home|Fix the problem above/);
  assert.match(text, /Try again with:\n\s+dalan try --public --client chatgpt --route tailscale --home /);
  assert.match(text, /Or make a trial link \(localhost\.run\) instead:\n\s+dalan try --public --client chatgpt --route localhost\.run --home /);
  assert.match(text, /Or try on this computer only:\n\s+dalan try --local/);
});

test('a public trial without a terminal fails before any route or file exists', async () => {
  const home = path.join(tmp, 'noterm');
  const route = fakeRoute();
  await assert.rejects(runTry({ argv: ['--public', '--home', home], env: { PATH: process.env.PATH }, out: { write() {} }, input: new PassThrough(), errorContext: { shellCli: `'x'` }, hosted: { providers: [route.provider] } }),
    /Hosted setup needs an interactive terminal for the URL and connection approval\. Run this in an interactive terminal:\n  node 'x' try --public --client chatgpt/);
  assert.equal(route.record.started, 0);
  assert.equal(fs.existsSync(home), false);
});

test('a bare `try` with no terminal runs the local self-check and never opens a route', async () => {
  const route = fakeRoute();
  const input = new PassThrough();
  input.end();
  let out = '';
  await runTry({ argv: ['--home', path.join(tmp, 'localpipe'), '--port', String(await reservedPort())], env: { PATH: process.env.PATH }, out: { write: t => { out += t; } }, input, errorContext: {}, hosted: { providers: [route.provider] } });
  assert.match(out, /Self-check passed/);
  assert.equal(route.record.started, 0);
});

test('a route that dies stops the trial, with the route stopped and the restart command printed', async () => {
  const run = await hostedRun('routedies');
  try {
    await run.handoff();
    run.route.die();
    const result = await run.finished;
    assert.match(result.error?.message ?? '', /The public route stopped\. This URL is offline\./);
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
  assert.match(run.out, /TLS certificate: error \(fake\)/, 'the certificate check runs when the address never answers');
  assert.equal(run.route.diagnosed, 0, 'and it runs before the route is stopped');
});

test('hosted failure cleanup with the real node provider: a cert check that will not exit keeps only its files, everything else is removed', async () => {
  const h = nodeHarness({ certBehaviour: 'immortal', certWaitMs: 30, killGraceMs: 30 });
  const busy = { name: 'tailscale', probe: () => ({ ok: false, busy: true, line: 'busy', fix: 'free 443' }), start: async () => { throw new Error('must not start'); }, stop: async () => ({ removed: true }) };
  const run = await hostedRun('nodecleanup', { argv: ['--route', 'tailscale'], clock: virtualClock(), fetchImpl: async () => { throw new Error('fetch failed'); }, providers: [busy, h.node] });
  const result = await run.finished;
  assert.match(result.error?.message ?? '', /The public route is not ready/);
  const kept = path.dirname(h.events.cert.files[0]);
  assert.match(run.out, /did not stop \(termination not confirmed\)/);
  assert.equal(fs.existsSync(kept), true, 'the files of the still-running child were not deleted by the trial\'s own cleanup');
  assert.deepEqual(fs.readdirSync(path.join(run.home, 'tsnode')), [path.basename(kept)]);
  assert.equal(h.events.daemon.exitCode, 0, 'the daemon was ended');
});

test('Ctrl-C while the route diagnosis runs reaches it as a signal, so the trial stops at once', async () => {
  const r = fakeRoute();
  r.provider.diagnose = ({ signal }) => new Promise(resolve => { r.record.sawSignal = Boolean(signal); r.record.diagnosing = true; signal?.addEventListener('abort', resolve, { once: true }); });
  const run = await hostedRun('diagcancel', { clock: virtualClock(), fetchImpl: async () => { throw new Error('fetch failed'); }, providers: [unreadyTailscale('x'), r.provider] });
  try {
    for (let i = 0; i < 400 && !r.record.diagnosing; i++) await sleepMs(25);
    assert.equal(r.record.diagnosing, true, 'the diagnosis started');
    assert.equal(r.record.sawSignal, true, 'it received the abort signal');
    run.controller.abort();
    const result = await Promise.race([run.finished, sleepMs(5000).then(() => 'hung')]);
    assert.notEqual(result, 'hung', 'the trial stops after Ctrl-C instead of waiting for the diagnosis');
    assert.equal(r.record.stopped, 1);
  } finally { run.controller.abort(); }
});

test('a home set up for another public address is refused, not re-issued', async () => {
  const home = path.join(tmp, 'moved');
  fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dalan-trial'), 'x');
  fs.writeFileSync(path.join(home, '.config/dot-bridge/workers.json'), JSON.stringify({ workers: { hosted: {} } }));
  fs.writeFileSync(path.join(home, '.config/dot-bridge/as.json'), JSON.stringify({ version: 1, public_url: 'https://old.example.com' }));
  const route = fakeRoute();
  const run = await runTry({ argv: ['--public', '--home', home], env: { PATH: process.env.PATH }, out: { write() {} }, input: new PassThrough(), errorContext: {}, hosted: { interactive: true, providers: [unreadyTailscale('x'), route.provider] } }).then(() => null, error => error);
  assert.match(run?.message ?? '', /this home was set up for https:\/\/old\.example\.com/);
  assert.equal(route.record.stopped, 1);
});

// ---- arguments and the mode question -----------------------------------------------------------------------------------
test('option parsing: local and public modes, clients, routes and conflicts', () => {
  assert.deepEqual(parseTryArgs(['--public', '--client', 'claude', '--route', 'localhost.run']), { home: null, port: null, callbacks: [], mode: 'public', client: 'claude', route: 'localhost.run' });
  assert.equal(parseTryArgs(['--local']).mode, 'local');
  assert.equal(parseTryArgs(['--client', 'chatgpt']).mode, 'public');
  for (const bad of [['--local', '--public', '--callback', 'x'], ['--local', '--client', 'chatgpt'], ['--local', '--route', 'auto'], ['--public', '--callback', 'x'], ['--client', 'bing'], ['--route', 'ngrok'], ['--route', 'cloudflare'], ['--client']]) assert.throws(() => parseTryArgs(bad), /./, JSON.stringify(bad));
  assert.deepEqual(parseTryArgs([]), { home: null, port: null, callbacks: [] });
});

async function answerMode(lines) {
  const input = new PassThrough();
  let out = '';
  const pending = chooseMode({ input, out: { write: t => { out += t; } }, signal: undefined });
  for (const line of lines) { await sleepMs(20); input.write(line); }
  return { choice: await pending, out };
}
test('the mode question: Enter chooses hosted ChatGPT; no route is asked', async () => {
  const enter = await answerMode(['\n', '\n']);
  assert.deepEqual(enter.choice, { mode: 'public', client: 'chatgpt' });
  assert.doesNotMatch(enter.out, /route|Tailscale|Cloudflare|localhost\.run/i, 'progressive disclosure: no route question');
  assert.deepEqual((await answerMode(['1\n', '2\n'])).choice, { mode: 'public', client: 'claude' });
  assert.deepEqual((await answerMode(['2\n'])).choice, { mode: 'local' });
  const retyped = await answerMode(['9\n', '\n', '\n']);
  assert.deepEqual(retyped.choice, { mode: 'public', client: 'chatgpt' });
  assert.match(retyped.out, /Type 1 to 2, or press Enter for 1\./);
});
test('the mode question: an input that ends chooses the local path, never a public route', async () => {
  const input = new PassThrough();
  const pending = chooseMode({ input, out: { write() {} } });
  input.end();
  assert.deepEqual(await pending, { mode: 'local' });
});

// ---- prerequisites -----------------------------------------------------------------------------------------------------
const capMap = { https: [], funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': [] };
const readyStatus = { BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.', CapMap: capMap }, CurrentTailnet: { MagicDNSEnabled: true } };
// Mirrors real Tailscale 1.104.5: a foreground `tailscale funnel` (no --bg) is listed only under Foreground.<session>, never in the
// top-level TCP/Web/AllowFunnel maps (checked live; a fake that put it at the top level hid the first live failure).
const foregroundView = (state) => {
  const sessions = Object.entries(state.foreground);
  if (!sessions.length) return {};
  return { Foreground: Object.fromEntries(sessions.map(([id, port]) => [id, {
    TCP: { [port]: { HTTPS: true } },
    Web: { [`box.tail1234.ts.net:${port}`]: state.fgWeb[id] },
    AllowFunnel: { [`box.tail1234.ts.net:${port}`]: true },
  }])) };
};
function fakeTailscale({ status = readyStatus, serve = {}, onFunnelOn, foreignForeground } = {}) {
  const state = { calls: [], web: {}, serve, foreground: {}, fgWeb: {} };
  if (foreignForeground) { state.foreground.other = foreignForeground; state.fgWeb.other = { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } }; }
  const run = args => {
    state.calls.push(args.join(' '));
    const ok = value => ({ status: 0, stdout: JSON.stringify(value) });
    if (args[0] === 'status') return state.statusFails ? { status: 1, stdout: '' } : ok(status);
    if (args[0] === 'logout') { if (state.logoutFails) return { status: 1, stdout: '' }; state.loggedOut = true; return { status: 0, stdout: '' }; }
    if (args[0] === 'serve') return ok({ ...state.serve, ...foregroundView(state) });
    if (args[0] === 'funnel' && args[1] === 'status') return ok({ Web: state.web, AllowFunnel: Object.fromEntries(Object.keys(state.web).map(k => [k, true])), ...foregroundView(state) });
    if (args[0] === 'funnel' && args.at(-1) === 'off') { delete state.web[`box.tail1234.ts.net:${args[1].split('=')[1]}`]; return { status: 0, stdout: '' }; }
    throw new Error(`unexpected tailscale call ${args.join(' ')}`);
  };
  const spawnChild = (cmd, args) => {
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.pid = 4242;
    const port = args.find(a => a.startsWith('--https=')).split('=')[1], target = args.at(-1);
    onFunnelOn?.(args);
    const id = `session${port}`;
    state.foreground[id] = port; state.fgWeb[id] = { Handlers: { '/': { Proxy: target } } };
    child.kill = () => { child.exitCode = 0; delete state.foreground[id]; child.emit('exit'); };
    state.child = child; state.spawned = [cmd, ...args];
    return child;
  };
  return { run, spawnChild, state };
}
const provider = (fake, extra = {}) => tailscaleProvider({ tailscale: fake.run, spawnChild: fake.spawnChild, platform: 'linux', which: () => '/usr/bin/tailscale', clock: { sleep: async () => {} }, ...extra });

test('each missing Tailscale prerequisite gets one line', () => {
  const absent = tailscaleProvider({ which: () => null, tailscale: () => { throw new Error('unused'); } }).probe();
  assert.equal(absent.line, 'Tailscale is not installed');
  const probe = status => provider(fakeTailscale({ status })).probe();
  assert.match(probe({ ...readyStatus, BackendState: 'NeedsLogin' }).line, /^Tailscale is not connected; run: tailscale up$/);
  assert.match(probe({ ...readyStatus, CurrentTailnet: { MagicDNSEnabled: false } }).line, /^MagicDNS is off\.$/);
  assert.match(probe({ ...readyStatus, Self: { ...readyStatus.Self, CapMap: { funnel: [] } } }).line, /^Tailscale HTTPS is off\.$/);
  assert.match(probe({ ...readyStatus, Self: { ...readyStatus.Self, CapMap: { https: [] } } }).line, /^Funnel is not allowed for this tailnet\.$/);
  assert.match(probe({ ...readyStatus, Self: { ...readyStatus.Self, CapMap: { https: [], funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': [] } } }).ok ? 'ok' : 'no', /ok/);
  const full = provider(fakeTailscale({ serve: { TCP: { 443: {} } } })).probe();
  assert.equal(full.line, 'Tailscale port 443 is not free for Funnel on this computer; its rules are unchanged.');
  assert.equal(full.busy, true, 'only a busy 443 leads to a node of the trial\'s own');
  assert.equal(absent.busy, undefined);
  for (const result of [absent, full]) assert.ok(result.fix, 'an explicit --route tailscale gets the owner\'s own fix');
  assert.match(explainTailscale(new Error('weird')).line, /^Tailscale Funnel is not usable \(weird\)\.$/);
});

test('a ready Funnel is used on 443, and removed on stop; another rule is never touched', async () => {
  const fake = fakeTailscale({ serve: { Web: { 'box.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } });
  const ts = provider(fake);
  const probe = ts.probe();
  assert.equal(probe.origin, 'https://box.tail1234.ts.net', 'always 443, whatever else is in use');
  const home = fs.mkdtempSync(path.join(tmp, 'ts-'));
  const started = await ts.start({ gatePort: 5151, home });
  assert.equal(started.origin, probe.origin);
  assert.deepEqual(fake.state.spawned, ['tailscale', 'funnel', '--https=443', 'http://127.0.0.1:5151'], 'a foreground rule to the gate, never --bg');
  assert.ok(fs.existsSync(path.join(home, 'dot-bridge-trial.exposure.json')), 'ownership is recorded before the rule exists');
  assert.deepEqual(await ts.stop(), { removed: true });
  assert.equal(fs.existsSync(path.join(home, 'dot-bridge-trial.exposure.json')), false);
  assert.deepEqual(fake.state.calls.filter(c => c.startsWith('funnel --https')), [], 'no blanket reset and no other rule was switched off');
});

test('a foreground rule listed only under Foreground.<session> is seen: ours is found, and another session\'s 443 is not taken', async () => {
  const fake = fakeTailscale({ foreignForeground: 8443 });
  const ts = provider(fake);
  assert.equal(ts.probe().origin, 'https://box.tail1234.ts.net');
  const started = await ts.start({ gatePort: 5151, home: fs.mkdtempSync(path.join(tmp, 'ts-fg-')) });
  assert.equal(started.origin, 'https://box.tail1234.ts.net');
  assert.deepEqual(Object.keys(fake.state.web), [], 'nothing is at the top level, as on real Tailscale');
  assert.deepEqual(await ts.stop(), { removed: true });
  assert.deepEqual(Object.keys(fake.state.foreground), ['other'], 'the other session is untouched');
  const held = provider(fakeTailscale({ foreignForeground: 443 })).probe();
  assert.equal(held.ok, false, 'a foreground rule on 443 occupies it');
  assert.equal(held.busy, true);
});

test('a port another rule took after the check is left alone and Funnel is not applied', async () => {
  const fake = fakeTailscale();
  const ts = provider(fake);
  ts.probe();
  fake.state.serve = { TCP: { 443: {} } }; // appears between the probe and the apply
  const home = fs.mkdtempSync(path.join(tmp, 'ts-'));
  // The probe chose 443; it is now occupied.
  await assert.rejects(ts.start({ gatePort: 5151, home }), /was taken by another rule after the check/);
  assert.equal(fake.state.spawned, undefined);
});

test('a Funnel that does not start stops the real route with its reason, after confirming its rule is gone', async () => {
  const lines = [];
  const ts = provider(fakeTailscale(), { clock: { sleep: async () => {} } });
  const trial = fakeRoute();
  const broken = { ...ts, async start() { throw new Error('tailscale funnel did not publish the rule'); }, probe: () => ({ ok: true, origin: 'x' }), stop: async () => ({ removed: true }) };
  await assert.rejects(startRoute({ route: 'tailscale', providers: [broken, trial.provider], gatePort: 1, home: tmp, say: line => lines.push(line) }), /did not publish the rule/);
  assert.equal(trial.record.started, 0, 'no trial link was made');
  const dead = unreadyTailscale('Funnel is not allowed for this tailnet.');
  dead.probe = () => ({ ok: false, line: 'x', fix: 'A tailnet administrator can enable Funnel at https://console.tailscale.com/admin/acls, then retry.' });
  await assert.rejects(startRoute({ route: 'tailscale', providers: [dead, fakeRoute().provider], gatePort: 1, home: tmp, say() {} }), /tailnet administrator can enable Funnel at https:\/\/console\.tailscale\.com\/admin\/acls/);
});

test('a Funnel rule that someone else replaced is left alone and reported with the exact command, not as removed', async () => {
  const other = fakeTailscale();
  const ts = provider(other);
  ts.probe();
  const home = fs.mkdtempSync(path.join(tmp, 'ts-'));
  await ts.start({ gatePort: 5151, home });
  // The child ends, its foreground session goes with it, and the port now holds someone else's rule that points elsewhere.
  other.state.child.kill = () => { other.state.child.exitCode = 0; other.state.foreground = {}; other.state.child.emit('exit'); };
  other.state.web['box.tail1234.ts.net:443'] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } };
  const refused = await ts.stop();
  assert.equal(refused.removed, false);
  assert.match(refused.detail, /no longer matches this setup; refusing to change it/);
  assert.equal(refused.command, 'tailscale funnel --https=443 off');
  assert.ok(other.state.web['box.tail1234.ts.net:443'], 'the other rule survives');
  assert.ok(fs.existsSync(path.join(home, 'dot-bridge-trial.exposure.json')), 'the record stays for recovery');
});

// ---- the tunnel helper -------------------------------------------------------------------------------------------------
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fakeSpawn(lines, { exitEarly = false } = {}) {
  const calls = [];
  const spawnChild = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.pid = 31337;
    child.kill = () => { child.exitCode = 0; child.emit('exit'); };
    calls.push({ bin, args, options, child });
    setImmediate(() => { if (exitEarly) { child.exitCode = 1; child.emit('exit'); } else for (const line of lines) child.stderr.write(`${line}\n`); });
    return child;
  };
  return { spawnChild, calls };
}
const LHR_BANNER = ['Welcome to localhost.run!', 'To set up and manage custom domains go to https://admin.localhost.run/', 'https://localhost.run/docs/'];
test('localhost.run output: only a single-label lhr.life https address is an origin; banner links, look-alikes and ANSI noise are not', () => {
  assert.deepEqual(parseLocalhostRunOrigins('952406d567dd10.lhr.life tunneled with tls termination, https://952406d567dd10.lhr.life\r'), ['https://952406d567dd10.lhr.life']);
  assert.deepEqual(parseLocalhostRunOrigins('\u001b[7m  \u001b[0mhttps://abc.lhr.life\u001b[0m'), ['https://abc.lhr.life'], 'terminal control codes are stripped first');
  for (const bad of ['https://admin.localhost.run/', 'https://localhost.run/docs/', 'https://evil.lhr.life.example.com', 'https://a.b.lhr.life', 'http://abc.lhr.life', 'https://user@abc.lhr.life', 'https://abc.lhr.life:8443', 'https://abc.lhr.life/path', 'https://lhr.life', 'https://abc-.lhr.life']) assert.deepEqual(parseLocalhostRunOrigins(`see ${bad}`), [], bad);
  assert.deepEqual(parseLocalhostRunOrigins('https://aa.lhr.life and https://bb.lhr.life'), ['https://aa.lhr.life', 'https://bb.lhr.life']);
});
test('localhost.run: ssh gets the gate port, a private known_hosts, no user config, agent or key; the address is read from split, CRLF output; stop ends it by handle', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'lhr-'));
  const fake = fakeSpawn([]);
  const provider = localhostRunProvider({ env: { PATH: '/usr/bin', SSH_AUTH_SOCK: '/agent', HOME: '/home/real' }, spawnChild: fake.spawnChild, which: () => '/usr/bin/ssh', clock: { sleep: async () => {} } });
  assert.deepEqual(provider.probe(), { ok: true });
  const starting = provider.start({ gatePort: 7001, home });
  await sleepMs(10);
  const [call] = fake.calls;
  call.child.stdout.write('\u001b[1mWelcome\u001b[0m\r\nabc123def456.lhr.life tunneled with tls term'); call.child.stdout.write('ination, https://abc123def456.lhr.life\r\n');
  call.child.stdout.write('This domain periodically rotates to a new one.\r\nhttps://abc123def456.lhr.life\r\n');
  const started = await starting;
  assert.equal(started.origin, 'https://abc123def456.lhr.life');
  assert.equal(call.bin, 'ssh');
  assert.deepEqual(call.args.slice(0, 3), ['-F', '/dev/null', '-T']);
  assert.ok(call.args.includes('-R') && call.args[call.args.indexOf('-R') + 1] === '80:127.0.0.1:7001', 'forwards to the gate port only');
  assert.equal(call.args.at(-1), 'nokey@localhost.run');
  const joined = call.args.join(' ');
  for (const flag of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ForwardAgent=no', 'IdentitiesOnly=yes', 'GlobalKnownHostsFile=/dev/null', `UserKnownHostsFile=${path.join(home, 'localhost-run', 'known_hosts')}`]) assert.ok(joined.includes(flag), flag);
  assert.equal(call.options.env.SSH_AUTH_SOCK, undefined, 'the user\'s ssh agent is not passed');
  assert.equal(call.options.env.HOME, undefined, 'and neither is the home directory');
  assert.equal(provider.endedBecause(), null, 'the same address repeated is not a rotation');
  assert.deepEqual(await provider.stop(), { removed: true });
  assert.equal(call.child.exitCode, 0);
});
test('localhost.run: a different address after the first ends the route as rotated; ssh missing, an early exit, no address and an abort are clean failures', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'lhr-'));
  const fake = fakeSpawn([]);
  const provider = localhostRunProvider({ env: {}, spawnChild: fake.spawnChild, which: () => '/usr/bin/ssh', clock: { sleep: async () => {} } });
  const starting = provider.start({ gatePort: 7002, home }); await sleepMs(10);
  fake.calls[0].child.stdout.write('x.lhr.life tunneled, https://one.lhr.life\n');
  const started = await starting;
  let ended = false; started.exited.then(() => { ended = true; });
  fake.calls[0].child.stdout.write('new: https://two.lhr.life\n');
  await sleepMs(20);
  assert.equal(ended, true, 'the route ended');
  assert.equal(provider.endedBecause(), 'rotated');
  assert.equal(fake.calls[0].child.exitCode, 0, 'ssh was stopped');
  // ssh is not installed: one line, with the fix.
  const none = localhostRunProvider({ env: {}, which: () => null }).probe();
  assert.equal(none.ok, false); assert.match(none.fix, /^ssh is not installed\. Install OpenSSH/);
  await assert.rejects(startRoute({ route: 'localhost.run', providers: [localhostRunProvider({ env: {}, which: () => null })], gatePort: 1, home, say() {} }), /^Error: ssh is not installed\./);
  // The relay refuses or ssh dies before an address: a clear failure with what ssh said, no hang.
  const early = fakeSpawn([], { exitEarly: true });
  await assert.rejects(localhostRunProvider({ env: {}, spawnChild: early.spawnChild, which: () => 'x', startMs: 5000 }).start({ gatePort: 1, home }), /ssh to localhost\.run ended before the tunnel was ready/);
  // Banner-only output never becomes an address, and the deadline ends the start.
  const quiet = fakeSpawn(LHR_BANNER);
  const slow = localhostRunProvider({ env: {}, spawnChild: (...a) => { const c = quiet.spawnChild(...a); setImmediate(() => { for (const l of LHR_BANNER) c.stdout.write(`${l}\n`); }); return c; }, which: () => 'x', startMs: 60 });
  await assert.rejects(slow.start({ gatePort: 1, home }), /did not report a public address in time/);
  // An abort ends it at once.
  const controller = new AbortController();
  const hang = localhostRunProvider({ env: {}, spawnChild: fakeSpawn([]).spawnChild, which: () => 'x', startMs: 60_000 });
  const pending = hang.start({ gatePort: 1, home, signal: controller.signal }); await sleepMs(10); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await assert.rejects(localhostRunProvider({ env: {}, spawnChild: fakeSpawn([]).spawnChild, which: () => 'x' }).start({ gatePort: 70000, home }), /gate port is not valid/);
});

// ---- the gate and readiness --------------------------------------------------------------------------------------------
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
  const origin = 'https://demo.trycloudflare.com', secret = 'a'.repeat(64);
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
  assert.match((await check({ [asPath]: () => Response.json({ ...good.as, token_endpoint: `http://demo.trycloudflare.com/${secret}/oauth/token` }) })).last, /token_endpoint/);
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

test('handoff text: the same text for the same inputs, with no unfilled value', () => {
  for (const client of Object.keys(CLIENTS)) {
    const text = handoffText({ client, url: 'https://x.trycloudflare.com/s/mcp' });
    assert.doesNotMatch(text, /<[^>]+>|PATTERN|NAME\b|PORT\b|undefined|null/);
    assert.ok(text.includes('https://x.trycloudflare.com/s/mcp'));
    assert.doesNotMatch(text, /Paste this into the chat:|claim only|bridge first report|prompt below/);
    assert.match(hostedPrompt('req_1', 'bridge first report abcd1234'), /claim only req_1,.*\(bridge first report abcd1234\)/);
  }
});

for (const client of Object.keys(CLIENTS)) test(`${client}: the demo prompt waits for approval and is repeated when the approved client has not claimed`, async () => {
  let now = 0;
  const run = await hostedRun(`prompt-order-${client}`, { argv: ['--client', client], clock: { now: () => now, sleep: sleepMs } });
  try {
    const { url } = await run.handoff();
    run.input.write('help\n');
    now += 60_000;
    await run.until(/No sign-in request yet/);
    assert.doesNotMatch(run.out, /Paste this into the chat:|claim only req_|bridge first report|prompt below/);
    const pairingOptions = { redirect: CLIENTS[client].callbacks[0], clientName: CLIENTS[client].label };
    await beginPairing(url, pairingOptions);
    await run.until(/Approve this connection\? \[y\/N\] /);
    run.input.write('n\n');
    await run.until(/Not approved\./);
    assert.ok(run.out.includes(`Start sign-in again in ${CLIENTS[client].label}; approve the new matching code here to get the demo prompt.`));
    assert.doesNotMatch(run.out, /Approve later with:|Paste this into the chat:|claim only req_|bridge first report/);
    const afterRefusal = run.out.length;
    const pairing = await beginPairing(url, pairingOptions);
    for (let i = 0; !/Approve this connection\? \[y\/N\] /.test(run.out.slice(afterRefusal)); i++) { assert.ok(i < 400, 'new approval question appears'); await sleepMs(25); }
    assert.doesNotMatch(run.out, /Paste this into the chat:|claim only req_|bridge first report/);
    run.input.write('y\n');
    await pairing.complete();
    const { requestId, phrase } = await run.prompt();
    const prompt = hostedPrompt(requestId, phrase);
    assert.ok(run.out.indexOf('Connection approved.') < run.out.indexOf(prompt));
    assert.equal(run.out.split(prompt).length - 1, 1);
    const afterApproval = run.out.length;
    run.input.write('help\n');
    for (let i = 0; !run.out.slice(afterApproval).includes(prompt); i++) { assert.ok(i < 200, 'help repeats the prompt'); await sleepMs(25); }
    assert.equal(run.out.split(prompt).length - 1, 2);
    assert.doesNotMatch(run.out.slice(afterApproval), /https?:\/\/|undefined|null/);
    const afterHelp = run.out.length;
    now += tryInternals.DIAGNOSE_EVERY_MS;
    await run.until(/send this prompt/);
    assert.ok(run.out.slice(afterHelp).includes(prompt), 'the reminder repeats the exact prompt in new output');
    assert.equal(run.out.split(prompt).length - 1, 3);
  } finally { await run.close(); }
});

test('uaToken names a known caller class and never echoes the caller\'s own text', () => {
  const of = ua => uaToken({ headers: ua === undefined ? {} : { 'user-agent': ua } });
  for (const [ua, want] of [['Claude-User/1.0 (+Anthropic)', 'Claude-User'], ['ClaudeBot/1.0', 'ClaudeBot'], ['anthropic-ai/1.0', 'anthropic-ai'], ['ChatGPT-User/1.0', 'ChatGPT-User'], ['OAI-SearchBot/1.0', 'OAI-SearchBot'],
    ['node', 'node'], ['undici', 'undici'], ['curl/8.5', 'curl'], ['python-httpx/0.27', 'python'], ['Python-urllib/3.12', 'python'], ['Mozilla/5.0 (X11)', 'Mozilla'], ['Zq8Lm3Vx9Tn2Rb7Kd4Hs6Pw1Yc5Jf0GH', 'other'], ['Zq8Lm3Vx9Tn2Rb7Kd4Hs6Pw1Yc5Jf0GH/1.0', 'other'], ['', null], [undefined, null]]) {
    assert.equal(of(ua), want, String(ua));
  }
});

test('a saved Tailscale choice asks nothing, says it is not a trial, and never falls back to localhost.run when it fails', async () => {
  const lhr = fakeRoute('localhost.run');
  const ts = unreadyTailscale('Tailscale is not connected; run: tailscale up');
  const run = await hostedRun('saved-ts', { route: 'tailscale', providers: [lhr.provider, ts] });
  const done = await run.finished;
  assert.match(run.out, /^Using Tailscale, the address you saved with `dalan setup`\. This is not a trial link\.$/m);
  assert.doesNotMatch(run.out, /Trial link via/);
  assert.doesNotMatch(run.out, /Choose|\[Y\/n\]|\[y\/N\]/, 'no question is asked');
  assert.match(run.out, /Tailscale is not connected/);
  assert.equal(lhr.record.started, 0, 'localhost.run is never started for a real route');
  assert.ok(done.error || /did not start/.test(run.out));
});

test('with no saved choice a trial prints its one disclaimer; ssh missing is one line with the fix', async () => {
  const missing = localhostRunProvider({ env: {}, which: () => null, spawnChild: () => { throw new Error('must not spawn'); } });
  const run = await hostedRun('no-ssh', { providers: [missing] });
  const done = await run.finished;
  assert.equal(run.out.match(/Trial link via localhost\.run/g).length, 1, 'the disclaimer is printed once');
  assert.match(`${run.out}${done.error?.message ?? ''}`, /ssh is not installed\. Install OpenSSH/);
  assert.doesNotMatch(run.out, /Cloudflare/i);
});

test('a trial says it is a temporary trial with the time left, and ends itself when the time is up; a real route has no timer', async () => {
  const run = await hostedRun('trial-time', { trialMs: 3 * 60_000, clock: virtualClock() });
  const done = await run.finished;
  assert.match(run.out, /^Temporary trial: this link stops in 3 min or sooner if the relay changes the address\./m);
  assert.ok(run.out.indexOf('Temporary trial:') < run.out.indexOf('Connector name:'));
  assert.match(done.error?.message ?? '', /The temporary trial ended after 3 min; its link is removed\. Start a fresh trial/);
  assert.match(run.out, /Temporary trial: \d+ (h \d+ )?min left\./, 'reminders show the time left');
  assert.equal(run.route.stopped, 1, 'the link is removed');
  const real = await hostedRun('real-no-timer', { route: 'tailscale', providers: [unreadyTailscale('x')] });
  await real.finished;
  assert.doesNotMatch(real.out, /Temporary trial/);
});

test('a real route reuses one home per client, so its address and sign-in survive a restart; a trial gets a new home each run', async () => {
  const oldHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dfh-')); // short: the admin socket path has a length limit
  process.env.HOME = fakeHome;
  try {
    const homes = [];
    for (const [route, name] of [['tailscale', 'rh1'], ['tailscale', 'rh2'], [undefined, 'th1'], [undefined, 'th2']]) {
      const run = await hostedRun(name, { noHome: true, route, providers: [{ name: 'tailscale', probe: () => ({ ok: true }), start: async () => { throw new Error('test stops after home selection'); }, stop: async () => ({ removed: true }) }, fakeRoute().provider] });
      for (let waited = 0; !run.errorContext.home && waited < 5000; waited += 20) await sleepMs(20);
      if (!route) await run.close(); else await run.finished;
      assert.ok(run.errorContext.home, `the home is chosen before anything else happens: ${(await run.finished).error?.message}`);
      homes.push(run.errorContext.home);
    }
    assert.equal(homes[0], homes[1]);
    assert.equal(path.basename(homes[0]), 'dalan-hosted-chatgpt');
    assert.notEqual(homes[2], homes[3]);
    assert.notEqual(path.basename(homes[2]), 'dalan-hosted-chatgpt');
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; fs.rmSync(fakeHome, { recursive: true, force: true }); }
});

test('the three-hour limit also ends an unanswered approval question, and the link is removed', async () => {
  const run = await hostedRun('expire-prompt', { trialMs: 6000 });
  await approveAs(run, { answer: null });
  await run.until(/Approve this connection\? \[y\/N\] /);
  const done = await run.finished;
  assert.match(done.error?.message ?? '', /The temporary trial ended after/);
  assert.equal(run.route.stopped, 1);
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

// A real executable boundary: no Gozar, SSH or machine route state is used by these tests.
function fakeGozar(name, mode = 'success') {
  const dir = path.join(tmp, `fake-gozar-${name}`);
  fs.mkdirSync(dir);
  const binary = path.join(dir, 'gozar'), log = path.join(dir, 'calls.jsonl'), state = path.join(dir, 'state.json'), failedStatus = path.join(dir, 'failed-status');
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), state = ${JSON.stringify(state)};
const absent = {phase:'unknown',candidate:null,published:null,limitations:['Controller unavailable: ENOENT']};
const snapshot = () => fs.existsSync(state) ? JSON.parse(fs.readFileSync(state)) : absent;
const save = value => fs.writeFileSync(state,JSON.stringify(value));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'status') { console.log(JSON.stringify({snapshot:snapshot()})); if(snapshot().phase==='unknown' || fs.existsSync(${JSON.stringify(failedStatus)}))process.exitCode=1; }
else if (args[0] === 'stop') { save({sessionId:'own-session',phase:'stopped',candidate:null,published:null,resources:[]}); console.log(JSON.stringify({snapshot:snapshot(),localCleanupFailures:[]})); }
else {
  if (${JSON.stringify(mode)} === 'slow') await new Promise(r=>setTimeout(r,300));
  if (!fs.existsSync(state)) save({sessionId:'own-session',phase:'published-ready',candidate:null,published:'https://trial.lhr.life'});
  if (${JSON.stringify(mode)} === 'error') { save({...snapshot(),phase:'failed',published:null}); console.log(JSON.stringify({error:'trial route unavailable',snapshot:snapshot()})); process.exitCode=1; }
  else if (${JSON.stringify(mode)} === 'candidate') {save({...snapshot(),phase:'starting',candidate:'https://trial.lhr.life',published:null}); console.log(JSON.stringify({snapshot:snapshot()}));}
  else console.log(JSON.stringify({snapshot:snapshot()}));
}
`, { mode: 0o700 });
  return { binary, log, failStatus: () => fs.writeFileSync(failedStatus, ''), clearStatusFailure: () => fs.rmSync(failedStatus, { force: true }), setSnapshot: value => fs.writeFileSync(state, JSON.stringify(value)), calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [], env: { PATH: dir } };
}

test('Gozar uses PATH before GOZAR_BIN, reads published origin and stops the exact gate port', async () => {
  const fake = fakeGozar('success');
  const provider = gozarProvider({ env: { ...fake.env, GOZAR_BIN: '/missing' } });
  assert.equal(provider.probe().ok, true);
  const route = await startRoute({ route: 'gozar', providers: [provider], gatePort: 45678, home: tmp });
  assert.equal(route.origin, 'https://trial.lhr.life');
  assert.deepEqual(fake.calls()[1], ['expose', '--port', '45678', '--client-reach', 'internet', '--yes', '--json', '--transport', 'https', '--sse', '--adapter', 'localhost-run']);
  assert.deepEqual(await route.stop(), { removed: true });
  assert.deepEqual(fake.calls().at(-1), ['stop', '--port', '45678', '--json']);
  await route.stop();
  assert.equal(fake.calls().filter(args => args[0] === 'stop').length, 1, 'stop is idempotent');
});

test('Gozar refuses a preexisting session without exposing or stopping it', async () => {
  for (const phase of ['published-ready', 'starting', 'cleanup-pending']) {
    const fake = fakeGozar(`existing-${phase}`);
    fake.setSnapshot({ sessionId: 'someone-else', phase, candidate: null, published: phase === 'published-ready' ? 'https://other.lhr.life' : null });
    const provider = gozarProvider({ env: fake.env });
    await assert.rejects(startRoute({ route: 'gozar', providers: [provider], gatePort: 45679 }), /port 45679 already has a Gozar route; stop it first: gozar stop --port 45679/);
    assert.deepEqual(fake.calls().map(args => args[0]), ['status']);
  }
});

test('Gozar watcher detects route loss and replacement; cleanup leaves replacements alone', async () => {
  for (const change of ['stopped', 'replacement', 'origin', 'unavailable']) {
    const fake = fakeGozar(`watch-${change}`);
    const provider = gozarProvider({ env: fake.env, pollMs: 10 });
    provider.probe();
    const route = await provider.start({ gatePort: 45680 });
    try {
      assert.ok(route.exited instanceof Promise);
      fake.setSnapshot({ stopped: { sessionId: 'own-session', phase: 'stopped', candidate: null, published: null, resources: [] }, replacement: { sessionId: 'replacement', phase: 'published-ready', candidate: null, published: route.origin }, origin: { sessionId: 'own-session', phase: 'published-ready', candidate: null, published: 'https://changed.lhr.life' }, unavailable: { phase: 'unknown', candidate: null, published: null, limitations: ['Controller unavailable: ENOENT'] } }[change]);
      await Promise.race([route.exited, sleepMs(2000).then(() => { throw new Error('route loss was not observed'); })]);
      assert.deepEqual(await provider.stop(), { removed: true });
      const count = fake.calls().length;
      await sleepMs(50);
      assert.equal(fake.calls().length, count, 'cleanup stops the watcher');
      assert.equal(fake.calls().filter(args => args[0] === 'stop').length, change === 'origin' ? 1 : 0, 'only a still-owned live session is stopped');
    } finally { await provider.stop(); }
  }
});

test('Gozar cleanup checks ownership again even before the next watcher poll', async () => {
  const fake = fakeGozar('cleanup-replacement');
  const provider = gozarProvider({ env: fake.env });
  provider.probe();
  await provider.start({ gatePort: 45681 });
  fake.setSnapshot({ sessionId: 'replacement', phase: 'published-ready', candidate: null, published: 'https://other.lhr.life' });
  assert.deepEqual(await provider.stop(), { removed: true });
  assert.ok(!fake.calls().some(args => args[0] === 'stop'));
});

test('Gozar invalid or failed status never acquires cleanup ownership', async () => {
  const malformed = ['invalid-json', JSON.stringify({ error: 'status unavailable' })];
  for (const value of [undefined, false, 0, '']) {
    malformed.push(JSON.stringify({ snapshot: { phase: 'stopped', candidate: null, published: value, resources: [] } }));
    malformed.push(JSON.stringify({ snapshot: { phase: 'unknown', candidate: value, published: null, limitations: ['Controller unavailable: ENOENT'] } }));
  }
  for (const resources of [null, {}, [null], [{ cleanup: false }]]) malformed.push(JSON.stringify({ snapshot: { phase: 'stopped', candidate: null, published: null, resources } }));
  for (const output of malformed) for (const code of [0, 1]) {
    const calls = [];
    const provider = gozarProvider({ which: () => 'fake', run: (binary, args, options, callback) => { calls.push(args[0]); callback(code ? Object.assign(new Error('status failed'), { code }) : null, output); } });
    await assert.rejects(startRoute({ route: 'gozar', providers: [provider], gatePort: 45682 }));
    assert.deepEqual(calls, ['status']);
  }
});

test('Gozar malformed cleanup status leaves the route untouched and reports unconfirmed cleanup', async () => {
  const fake = fakeGozar('malformed-cleanup');
  const provider = gozarProvider({ env: fake.env });
  provider.probe();
  await provider.start({ gatePort: 45684 });
  try {
    for (const snapshot of [
      { sessionId: 'own-session', phase: 'stopped' },
      { sessionId: 'own-session', phase: 'stopped', candidate: null, published: false },
      { sessionId: 'own-session', phase: 'stopped', candidate: '', published: null },
      { sessionId: 'own-session', phase: 'unknown', candidate: null, published: null, resources: [null] },
    ]) {
      fake.setSnapshot(snapshot);
      assert.equal((await provider.stop()).removed, false);
      assert.ok(!fake.calls().some(args => args[0] === 'stop'));
    }
  } finally {
    fake.setSnapshot({ sessionId: 'own-session', phase: 'published-ready', candidate: null, published: 'https://trial.lhr.life' });
    assert.deepEqual(await provider.stop(), { removed: true });
  }
});

test('Gozar exit-1 ready status withdraws readiness and cannot authorize cleanup', async () => {
  const fake = fakeGozar('failed-ready-status');
  const provider = gozarProvider({ env: fake.env, pollMs: 10 });
  provider.probe();
  const route = await provider.start({ gatePort: 45683 });
  try {
    fake.failStatus();
    await Promise.race([route.exited, sleepMs(2000).then(() => { throw new Error('failed status kept readiness'); })]);
    assert.equal((await provider.stop()).removed, false);
    assert.ok(!fake.calls().some(args => args[0] === 'stop'));
  } finally { fake.clearStatusFailure(); assert.deepEqual(await provider.stop(), { removed: true }); }
});

test('Gozar route loss during approval revokes connections and closes bridge and gate', async () => {
  const fake = fakeGozar('approval-loss');
  const provider = gozarProvider({ env: fake.env, pollMs: 20 });
  const run = await hostedRun('gozar-approval-loss', { argv: ['--route', 'gozar'], providers: [provider], fetchImpl: readyGozarFetch });
  const realFetch = globalThis.fetch;
  try {
    await run.until(/Waiting for sign-in/);
    const url = fs.readFileSync(path.join(run.home, 'resource-url'), 'utf8').trim();
    const gatePort = Number(fake.calls().find(args => args[0] === 'expose')[2]);
    // Stand in for Gozar's HTTPS transport and loopback Host; the gate and bridge are real.
    globalThis.fetch = (value, init = {}) => {
      const target = new URL(value);
      if (target.origin !== 'https://trial.lhr.life') return realFetch(value, init);
      return realFetch(String(value).replace(target.origin, `http://127.0.0.1:${gatePort}`), init);
    };
    const first = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Approve this connection\? \[y\/N\]/);
    run.input.write('y\n');
    await first.complete();
    await run.until(/Connection approved/);
    await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    for (let i = 0; (run.out.match(/Approve this connection\?/g) ?? []).length < 2; i++) { assert.ok(i < 200); await sleepMs(25); }
    fake.setSnapshot({ sessionId: 'own-session', phase: 'stopped', candidate: null, published: null, resources: [] });
    const result = await Promise.race([run.finished, sleepMs(5000).then(() => { throw new Error('hosted run stayed alive'); })]);
    assert.match(result.error?.message ?? '', /The public route stopped/);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(run.home, '.config/dalan/as.sqlite'), { readOnly: true });
    try {
      assert.ok(db.prepare('SELECT count(*) AS total FROM connections').get().total > 0);
      assert.equal(db.prepare('SELECT count(*) AS active FROM connections WHERE revoked_at IS NULL').get().active, 0);
    } finally { db.close(); }
    for (const port of [gatePort, run.errorContext.bindPort]) await assert.rejects(realFetch(`http://127.0.0.1:${port}`));
    const count = fake.calls().length;
    await sleepMs(100);
    assert.equal(fake.calls().length, count);
  } finally { globalThis.fetch = realFetch; await run.close(); }
});

test('Gozar missing is actionable; GOZAR_BIN works when PATH has no gozar', async () => {
  const missing = gozarProvider({ env: { PATH: '', GOZAR_BIN: '/missing' } });
  assert.equal(missing.probe().ok, false);
  await assert.rejects(startRoute({ route: 'gozar', providers: [missing], gatePort: 12345 }), /Install gozar on PATH or set GOZAR_BIN/);
  const fake = fakeGozar('env');
  const provider = gozarProvider({ env: { PATH: '', GOZAR_BIN: fake.binary } });
  assert.equal(provider.probe().ok, true);
  assert.equal((await provider.start({ gatePort: 12345 })).origin, 'https://trial.lhr.life');
  assert.equal((await provider.stop()).removed, true);
});

test('Gozar error JSON and unpublished candidates fail and clean up without another route', async () => {
  for (const mode of ['error', 'candidate']) {
    const fake = fakeGozar(mode, mode), provider = gozarProvider({ env: fake.env });
    const fallback = fakeRoute();
    await assert.rejects(startRoute({ route: 'gozar', providers: [provider, fallback.provider], gatePort: 12346 }), mode === 'error' ? /trial route unavailable/ : /did not publish a ready HTTPS origin/);
    assert.deepEqual(fake.calls().filter(args => args[0] !== 'status').map(args => args[0]), ['expose', 'stop']);
    assert.equal(fallback.record.started, 0);
  }
});

test('Gozar stop reports cleanup debt instead of claiming removal', async () => {
  const fake = fakeGozar('debt');
  let exposed = false;
  const provider = gozarProvider({ env: fake.env, run: (binary, args, options, callback) => {
    if (args[0] === 'expose') exposed = true;
    callback(null, JSON.stringify(args[0] === 'stop' ? { snapshot: { sessionId: 'own', phase: 'cleanup-pending', published: null }, localCleanupFailures: ['ssh still running'] } : { snapshot: exposed ? { sessionId: 'own', phase: 'published-ready', candidate: null, published: 'https://trial.lhr.life' } : { phase: 'unknown', candidate: null, published: null, limitations: ['Controller unavailable: ENOENT'] } }));
  } });
  provider.probe();
  await provider.start({ gatePort: 12347 });
  assert.deepEqual(await provider.stop(), { removed: false, detail: 'Gozar route cleanup is unconfirmed', command: 'gozar stop --port 12347' });
});

const readyGozarFetch = async value => {
  const url = new URL(value), origin = url.origin, secret = url.pathname.split('/').at(-2);
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource/')) return Response.json({ resource: `${origin}/${secret}/mcp`, authorization_servers: [origin] });
  if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
  if (url.pathname.endsWith('/mcp')) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  return new Response('', { status: 404 });
};

test('auto prefers installed Gozar over the saved route and Ctrl-C removes it', async () => {
  const fake = fakeGozar('auto'), provider = gozarProvider({ env: fake.env });
  const fallback = fakeRoute();
  const run = await hostedRun('gozar-auto', { argv: ['--route', 'auto'], route: 'tailscale', providers: [provider, fallback.provider], fetchImpl: readyGozarFetch });
  try {
    await run.until(/Waiting for sign-in/);
    assert.match(run.out, /Public route ready \(gozar\)/);
    assert.equal(fallback.record.started, 0);
  } finally { assert.equal((await run.close()).error, undefined); }
  assert.deepEqual(fake.calls().filter(args => args[0] !== 'status').map(args => args[0]), ['expose', 'stop']);
  assert.match(run.out, /Public route removed\. Bridge stopped\./);
});

test('auto without installed Gozar keeps the default trial route', async () => {
  const fallback = fakeRoute();
  const run = await hostedRun('gozar-missing-auto', { providers: [gozarProvider({ env: { PATH: '' } }), fallback.provider] });
  try { await run.handoff(); assert.equal(fallback.record.started, 1); }
  finally { await run.close(); }
});

test('Ctrl-C during Gozar expose waits for startup and stops the partial route', async () => {
  const fake = fakeGozar('sigint', 'slow');
  const run = await hostedRun('gozar-sigint-home', { argv: ['--route', 'gozar'], providers: [gozarProvider({ env: fake.env })], fetchImpl: readyGozarFetch });
  try {
    for (let i = 0; !fake.calls().some(args => args[0] === 'expose'); i++) { assert.ok(i < 200, 'expose started'); await sleepMs(25); }
    await run.close(); // The same AbortSignal delivered by the CLI's Ctrl-C handler.
    assert.deepEqual(fake.calls().filter(args => args[0] !== 'status').map(args => args[0]), ['expose', 'stop']);
    assert.equal(fake.calls().find(args => args[0] === 'expose')[2], fake.calls().find(args => args[0] === 'stop')[2]);
    assert.doesNotMatch(run.out, /cleanup is unconfirmed|Waiting for sign-in/);
  } finally { await run.close(); }
});

test('Gozar loopback Host normalization keeps the public host check and Origin header intact', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.headers.host !== 'trial.lhr.life') { res.writeHead(421); res.end(); return; }
    res.writeHead(req.headers.origin === 'https://evil.example' ? 403 : 200);
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gate = await createGate();
  try {
    gate.open(upstream.address().port, { gozarOrigin: 'https://trial.lhr.life' });
    const target = `http://127.0.0.1:${gate.port}/mcp`;
    assert.equal((await fetch(target)).status, 200, 'Gozar rewrites Host to the loopback target; restore the configured public host');
    const wrongHost = await new Promise((resolve, reject) => {
      const request = http.get(target, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(wrongHost, 421, 'an unrelated host is still rejected');
    assert.equal((await fetch(target, { headers: { origin: 'https://evil.example' } })).status, 403, 'Origin is preserved for Dalan to check');
  } finally { await gate.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('default Tailscale fallback starts successive ephemeral trials in fresh homes', async () => {
  const oldHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dfb-'));
  process.env.HOME = fakeHome;
  const homes = [];
  try {
    for (let i = 0; i < 2; i++) {
      const fallback = fakeRoute('tailscale-node');
      const busy = { name: 'tailscale', probe: () => ({ ok: false, busy: true, line: 'busy', fix: 'free 443' }) };
      const run = await hostedRun(`fallback-${i}`, { noHome: true, argv: ['--route', 'tailscale'], providers: [busy, fallback.provider] });
      try {
        await run.until(/Checking public routes/);
        homes.push(run.errorContext.home);
        if (i) assert.notEqual(homes[0], homes[1], 'the next trial must not select the previous node identity');
        await run.handoff();
      } finally {
        const done = await run.close();
        assert.equal(done.error, undefined, done.error?.message);
      }
      assert.ok(fs.existsSync(path.join(homes[i], '.config/dalan/as.json')), 'old sign-in identity remains in history');
    }
    assert.notEqual(homes[0], homes[1], 'a new node must not reuse the old sign-in identity');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('node sweep protects owners without recorded identity and requires start identity to prove PID reuse', async () => {
  for (const [label, owner, recordedStart, reclaim] of [
    ['present without saved command', { state: 'present', command: 'trial', start: '10' }, null, false],
    ['unknown without saved command', { state: 'unknown' }, null, false],
    ['same start changed command', { state: 'present', command: 'new title', start: '10' }, '10', false],
    ['different start', { state: 'present', command: 'trial', start: '11' }, '10', true],
    ['confirmed absent', { state: 'absent' }, null, true],
  ]) {
    const registry = fs.mkdtempSync(path.join(tmp, 'owner-'));
    const dir = path.join(registry, 'tsnode'), sock = path.join(dir, 'daemon.sock');
    fs.mkdirSync(dir);
    const file = path.join(registry, 'trial.json');
    fs.writeFileSync(file, JSON.stringify({ owner: 12345, ownerCmd: null, ownerStart: recordedStart, pid: 23456, dir, sock }));
    let daemonAlive = true;
    const killed = [];
    const ended = await sweepTrialNodes({ registry, processCmd: pid => pid === 12345 ? owner : daemonAlive ? { state: 'present', command: `tailscaled --socket=${sock}`, start: '20' } : { state: 'absent' }, kill(pid) { killed.push(pid); daemonAlive = false; }, clock: { sleep: async () => {} } });
    assert.equal(killed.length, reclaim ? 1 : 0, label);
    assert.equal(ended.length, reclaim ? 1 : 0, label);
    assert.equal(fs.existsSync(file), !reclaim, label);
    assert.equal(fs.existsSync(dir), !reclaim, label);
  }
});

test('node sweep retains unreadable records and directories of daemons whose exit is unknown', async () => {
  const registry = fs.mkdtempSync(path.join(tmp, 'inspect-debt-'));
  const broken = path.join(registry, 'broken.json'); fs.writeFileSync(broken, '{');
  const dir = path.join(registry, 'tsnode'); fs.mkdirSync(dir);
  const file = path.join(registry, 'trial.json');
  fs.writeFileSync(file, JSON.stringify({ owner: 12345, pid: 23456, sock: path.join(dir, 'daemon.sock'), dir }));
  assert.deepEqual(await sweepTrialNodes({ registry, processCmd: pid => pid === 12345 ? { state: 'absent' } : { state: 'unknown' }, kill() { assert.fail('unknown process must not be killed'); } }), []);
  assert.ok(fs.existsSync(broken), 'an unparseable record is retained');
  assert.ok(fs.existsSync(file), 'unknown daemon keeps recovery record');
  assert.ok(fs.existsSync(dir), 'unknown daemon keeps its socket directory');
});

test('a daemon that survives stop keeps its directory and recovery record', async () => {
  const h = nodeHarness({ killGraceMs: 5 });
  const home = fs.mkdtempSync(path.join(tmp, 'daemon-debt-'));
  await h.node.start({ gatePort: 1, home, say: h.say });
  h.events.daemon.kill = () => false;
  const stopped = await h.node.stop();
  assert.equal(stopped.keepNode, true);
  assert.equal(stopped.removed, false);
  assert.ok(fs.existsSync(path.join(home, 'tsnode')));
  assert.ok(fs.existsSync(path.join(h.registry, 'dalan-trial-abc123.json')));
});

test('Gozar controller inspection timeout cannot prove a route absent', async () => {
  let exposed = false, timeout = false;
  const calls = [];
  const provider = gozarProvider({ which: () => 'gozar', run(binary, args, options, callback) {
    calls.push(args[0]);
    const empty = { phase: 'unknown', candidate: null, published: null, resources: [], limitations: [`Controller unavailable: ${timeout ? 'timeout' : 'ENOENT'}`] };
    if (args[0] === 'expose') exposed = true;
    callback(null, JSON.stringify({ snapshot: args[0] === 'expose' || (exposed && !timeout) ? { sessionId: 'own', phase: 'published-ready', candidate: null, published: 'https://trial.lhr.life' } : empty }));
  } });
  provider.probe();
  await provider.start({ gatePort: 12348 });
  timeout = true;
  assert.equal((await provider.stop()).removed, false, 'unavailable controller is unknown, not removed');
  assert.equal(calls.includes('stop'), false, 'port-only stop cannot act without observed session ownership');
  const next = gozarProvider({ which: () => 'gozar', run(binary, args, options, callback) {
    assert.equal(args[0], 'status', 'startup must not expose on unknown prior route state');
    callback(null, JSON.stringify({ snapshot: { phase: 'unknown', candidate: null, published: null, resources: [], limitations: ['Controller unavailable: timeout'] } }));
  } });
  next.probe();
  await assert.rejects(next.start({ gatePort: 12349 }), /already has a Gozar route/);
});

test('node sweeps require a present socket identity before signalling and retain incomplete records', async () => {
  for (const [label, overrides, inspectDaemon] of [
    ['missing owner', { owner: null }, sock => ({ state: 'present', command: `tailscaled --socket=${sock}` })],
    ['missing socket', { sock: null }, () => ({ state: 'present', command: 'tailscaled' })],
    ['unknown with partial command', {}, sock => ({ state: 'unknown', command: `tailscaled --socket=${sock}` })],
  ]) {
    const registry = fs.mkdtempSync(path.join(tmp, 'incomplete-node-'));
    const dir = path.join(registry, 'tsnode'); fs.mkdirSync(dir);
    const sock = path.join(dir, 'daemon.sock'), file = path.join(registry, 'trial.json');
    fs.writeFileSync(file, JSON.stringify({ owner: 12345, pid: 23456, sock, dir, ...overrides }));
    assert.deepEqual(await sweepTrialNodes({ registry, processCmd: pid => pid === 12345 ? { state: 'absent' } : inspectDaemon(sock), kill() { assert.fail(`${label} must not authorize a signal`); } }), [], label);
    assert.ok(fs.existsSync(file), label); assert.ok(fs.existsSync(dir), label);
  }
});

test('a Funnel port taken after route selection cannot move an ephemeral identity into the stable default home', async () => {
  const oldHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dfr-')); process.env.HOME = fakeHome;
  let probes = 0;
  const fallback = fakeRoute('tailscale-node');
  const host = { name: 'tailscale', probe: () => ++probes === 1 ? { ok: true } : { ok: false, busy: true, line: 'busy', fix: 'free 443' }, start: async () => { throw new Error('Funnel port 443 was taken by another rule after the check'); }, stop: async () => ({ removed: true }) };
  const run = await hostedRun('fallback-race', { noHome: true, argv: ['--route', 'tailscale'], providers: [host, fallback.provider] });
  try {
    const result = await Promise.race([run.finished, sleepMs(2000).then(() => ({ error: new Error('route selection changed instead of refusing the new rule') }))]);
    assert.match(result.error?.message ?? '', /taken by another rule/);
    assert.equal(probes, 1, 'the home and startup use the same provider decision');
    assert.equal(fallback.record.started, 0, 'the ephemeral node cannot write into the stable home');
    assert.equal(fs.existsSync(path.join(fakeHome, '.local/share/dalan-hosted-chatgpt/.config/dalan/as.json')), false);
  } finally {
    await run.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('failed hosted startup preserves a surviving daemon through the outer cleanup and a later sweep releases it', async () => {
  const h = nodeHarness({ killGraceMs: 5 });
  const originalExit = process.exitCode;
  const provider = { ...h.node, async start(args) {
    await h.node.start(args);
    h.events.daemon.kill = () => false;
    throw new Error('injected failure after daemon startup');
  } };
  const busy = { name: 'tailscale', probe: () => ({ ok: false, busy: true, line: 'busy', fix: 'free 443' }) };
  const run = await hostedRun('failed-start-daemon', { argv: ['--route', 'tailscale'], providers: [busy, provider] });
  try {
    const result = await run.finished;
    assert.match(result.error?.message ?? '', /injected failure after daemon startup/);
    const dir = path.join(run.home, 'tsnode'), record = path.join(h.registry, 'dalan-trial-abc123.json');
    assert.ok(fs.existsSync(dir), 'outer finally must honor the provider cleanup debt');
    assert.ok(fs.existsSync(record), 'the later run can recover this node');
    assert.match(run.out, /cleanup is unconfirmed/);
    h.events.daemon.exitCode = 0; h.events.daemon.emit('exit', 0);
    assert.deepEqual(await sweepTrialNodes({ registry: h.registry, processCmd: () => ({ state: 'absent' }) }), ['dalan-trial-abc123']);
    assert.equal(fs.existsSync(dir), false); assert.equal(fs.existsSync(record), false);
  } finally { await run.close(); process.exitCode = originalExit; }
});

test('failed hosted startup retains node files when cleanup reports writer debt or throws', async () => {
  const originalExit = process.exitCode;
  try {
    for (const throws of [false, true]) {
      let dir;
      const provider = { name: 'tailscale-node', probe: () => ({ ok: true }), async start({ home }) {
        dir = path.join(home, 'tsnode'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'writer'), 'owned files');
        throw new Error('injected startup failure');
      }, async stop() { if (throws) throw new Error('cleanup inspection failed'); return { removed: true, keepNode: true }; } };
      const busy = { name: 'tailscale', probe: () => ({ ok: false, busy: true, line: 'busy', fix: 'free 443' }) };
      const run = await hostedRun(`failed-start-debt-${throws}`, { argv: ['--route', 'tailscale'], providers: [busy, provider] });
      const result = await run.finished;
      assert.match(result.error?.message ?? '', /injected startup failure/);
      assert.equal(fs.readFileSync(path.join(dir, 'writer'), 'utf8'), 'owned files', `cleanup throws=${throws}`);
      await run.close();
    }
  } finally { process.exitCode = originalExit; }
});
