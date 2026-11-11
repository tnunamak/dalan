// `dalan try --public`: the hosted-client path. No real tunnel, no real Tailscale, no ChatGPT or claude.ai account.
// A fake route (a relay on its own port, so the public address is not the bridge's bind address) and a scripted hosted client
// stand in for the outside. The bridge, its OAuth server, its MCP tools and the CLI are the real ones.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { handoffText, CLIENTS } from '../src/try-hosted-clients.mjs';
import { uaToken } from '../src/mcp-outcome.mjs';
import { CLOUDFLARED, HelperError, sweepTrialNodes, cloudflareProvider, createGate, ensureCloudflared, explainTailscale, parseQuickTunnelOrigin, processCommand, startRoute, tailscaleNodeProvider, tailscaleProvider, verifyPublicReady } from '../src/try-exposure.mjs';
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
function fakeRoute(name = 'cloudflare') {
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
async function hostedRun(name, { argv = [], providers, clock, fetchImpl } = {}) {
  const home = path.join(tmp, name);
  const port = await reservedPort();
  const route = fakeRoute();
  const run = { out: '', input: new PassThrough(), controller: new AbortController(), home, route: route.record, errorContext: { started: false, shellCli: `'${path.join(repo, 'bin/dalan.mjs')}'` } };
  run.finished = runTry({
    argv: ['--public', '--client', 'chatgpt', '--home', home, '--port', String(port), ...argv], env: { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    out: { write: text => { run.out += text; } }, input: run.input, signal: run.controller.signal, errorContext: run.errorContext, clock,
    hosted: { interactive: true, providers: providers ?? [unreadyTailscale('Tailscale is not installed; using a temporary Cloudflare route.'), route.provider], serverEnv: { DALAN_TEST_OAUTH: '1' }, fetchImpl },
  }).then(() => ({}), error => ({ error }));
  run.until = async (pattern, ms = 60_000) => {
    for (let waited = 0; !pattern.test(run.out); waited += 50) {
      if (waited > ms) throw new Error(`never saw ${pattern}\n${run.out.replace(/[0-9a-f]{64}/g, '<secret>')}`);
      await sleepMs(50);
    }
    return run.out.match(pattern);
  };
  run.close = async () => { run.controller.abort(); return run.finished; };
  // The handoff: the URL line, the request id and the phrase the prompt asks for.
  run.handoff = async () => {
    const url = (await run.until(/^(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/mcp)$/m))[1];
    const requestId = (await run.until(/claim only (req_[0-9a-f-]+),/))[1];
    const phrase = (await run.until(/requested report \((bridge first report [0-9a-f]{8})\)/))[1];
    return { url, requestId, phrase };
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
    const { url, requestId, phrase } = await run.handoff();
    // Every value is filled in: no placeholder, and the handoff names the connector, the steps and the prompt.
    const handoff = run.out.slice(run.out.indexOf('Connector name:'));
    assert.doesNotMatch(handoff, /<[A-Za-z _-]+>|PATTERN|NAME|PORT|HOME_PATH|YOUR_/, 'the handoff has no placeholder');
    assert.match(handoff, /Connector name: Dalan Trial/);
    for (const step of CLIENTS.chatgpt.steps) assert.ok(handoff.includes(step), step);
    assert.ok(handoff.includes('Paste this into the chat:'));
    const origin = new URL(url).origin;
    assert.notEqual(Number(new URL(origin).port), run.errorContext.bindPort, 'the public origin is not the bridge bind address');
    assert.match(run.out, /Public HTTPS and OAuth discovery verified\./);
    assert.match(run.out, /Tailscale is not installed; using a temporary Cloudflare route\./);
    // The scripted client signs in through the public origin, the owner approves, the client works the job.
    const pairing = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Connection waiting for your approval/);
    await run.until(/Approve this connection\? \[y\/N\] /);
    assert.match(run.out, new RegExp(`code        ${pairing.code}`));
    assert.match(run.out, new RegExp(`resource    "${origin}/<secret>/mcp"`));
    run.input.write('y\n');
    const token = await pairing.complete();
    await run.until(/Connection approved\. Waiting for the client to claim the demo job/);
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
  assert.match(run.out, /To run it again: .*try --public --client chatgpt --route auto\n/, 'the restart command keeps every selection');
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
    const { url, requestId, phrase } = await run.handoff();
    const pairing = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Approve this connection\? \[y\/N\] /);
    run.input.write('y\n');
    const token = await pairing.complete();
    await run.until(/Connection approved/);
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
    const { url, requestId, phrase } = await run.handoff();
    const pairing = await beginPairing(url, { redirect: CHATGPT_CALLBACK, clientName: 'ChatGPT' });
    await run.until(/Approve this connection\? \[y\/N\] /);
    run.input.write('y\n');
    const token = await pairing.complete();
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
    await run.until(/Not approved\. Approve later with:/);
    assert.doesNotMatch(run.out, /Connection approved/);
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
    hosted: { interactive: true, providers: [unreadyTailscale('x'), route.provider], serverEnv: { DALAN_TEST_OAUTH: '1' } } }).catch(error => error);
  try {
    for (let i = 0; i < 400 && !/\/mcp$/m.test(out); i++) await sleepMs(50);
    const url = /^(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/mcp)$/m.exec(out)[1];
    assert.match(out, /Customize → Connectors/);
    assert.doesNotMatch(out, /Settings → Apps/);
    const pairing = await beginPairing(url, { redirect: CLAUDE_CALLBACK, clientName: 'claude' });
    for (let i = 0; i < 400 && !/Approve this connection\? \[y\/N\] /.test(out); i++) await sleepMs(50);
    input.write('y\n');
    await pairing.complete();
    assert.match(out, new RegExp(CLAUDE_CALLBACK.replace(/[./]/g, '\\$&')));
  } finally { controller.abort(); await finished; }
});

test('claude.ai\'s order: challenge, discovery from the challenge, registration, sign-in, token, then an MCP call; every step is in the log by name', async () => {
  const home = path.join(tmp, 'claudeflow');
  const route = fakeRoute();
  const input = new PassThrough(), controller = new AbortController();
  let out = '';
  const finished = runTry({ argv: ['--public', '--client', 'claude', '--home', home, '--port', String(await reservedPort())], env: { PATH: process.env.PATH }, out: { write: t => { out += t; } }, input, signal: controller.signal, errorContext: { started: false },
    hosted: { interactive: true, providers: [unreadyTailscale('x'), route.provider], serverEnv: { DALAN_TEST_OAUTH: '1' } } }).catch(error => error);
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

// ---- route choice and the trial's own Tailscale node -----------------------------------------------------------------------
const stubProvider = (name, { ok = true, busy, startError, line = `${name} line`, fix = `${name} fix` } = {}) => {
  const record = { started: 0, stopped: 0 };
  return { record, name, probe: () => ok ? { ok: true } : { ok: false, line, fix, busy }, start: async () => { record.started++; if (startError) throw new Error(startError); return { origin: `https://${name}.example`, exited: new Promise(() => {}) }; }, stop: async () => { record.stopped++; return { removed: true }; } };
};
test('route choice: the computer\'s Tailscale on 443, else a node of its own, else Cloudflare; `tailscale` never reaches Cloudflare', async () => {
  const pick = async (route, providers) => { const lines = []; try { return { chosen: (await startRoute({ route, providers, gatePort: 1, home: tmp, say: l => lines.push(l) })).provider.name, lines }; } catch (error) { return { error: error.message, lines }; } };
  // 1. 443 is free on this computer.
  assert.equal((await pick('auto', [stubProvider('tailscale'), stubProvider('tailscale-node'), stubProvider('cloudflare')])).chosen, 'tailscale');
  // 2. 443 is held by another rule: the node, with one line saying why; the other rule is not the trial's to change.
  const busy = { ok: false, busy: true, line: 'Tailscale port 443 is not free for Funnel on this computer; its rules are unchanged.', fix: 'Free Funnel port 443' };
  const node = stubProvider('tailscale-node'), host = stubProvider('tailscale', busy);
  const second = await pick('auto', [host, node, stubProvider('cloudflare')]);
  assert.equal(second.chosen, 'tailscale-node');
  assert.match(second.lines.join('\n'), /Tailscale port 443 is not free for Funnel on this computer; its rules are unchanged\. Starting a separate Tailscale node for this trial\./);
  assert.equal(host.record.started, 0, 'the computer\'s Tailscale is not started when 443 is busy');
  assert.equal((await pick('tailscale', [stubProvider('tailscale', busy), stubProvider('tailscale-node'), stubProvider('cloudflare')])).chosen, 'tailscale-node');
  // 3. No node is possible (no tailscaled), or its start fails: Cloudflare, after the node was cleaned up.
  const noNode = stubProvider('tailscale-node', { ok: false });
  assert.equal((await pick('auto', [stubProvider('tailscale', busy), noNode, stubProvider('cloudflare')])).chosen, 'cloudflare');
  const failing = stubProvider('tailscale-node', { startError: 'the one-time Tailscale sign-in was not completed in time' });
  const fell = await pick('auto', [stubProvider('tailscale', busy), failing, stubProvider('cloudflare')]);
  assert.equal(fell.chosen, 'cloudflare');
  assert.equal(failing.record.stopped, 1, 'a failed node start is cleaned up');
  assert.match(fell.lines.join('\n'), /Tailscale did not start \(the one-time Tailscale sign-in was not completed in time\); using a temporary Cloudflare route\./);
  // `--route tailscale` stops with the reason instead of using Cloudflare; a reason other than 443 skips the node.
  const refused = await pick('tailscale', [stubProvider('tailscale', busy), noNode, stubProvider('cloudflare')]);
  assert.match(refused.error, /Free Funnel port 443/);
  const noTailscale = stubProvider('tailscale', { ok: false, line: 'Tailscale is not installed; using a temporary Cloudflare route.' });
  const skipped = await pick('auto', [noTailscale, stubProvider('tailscale-node'), stubProvider('cloudflare')]);
  assert.equal(skipped.chosen, 'cloudflare');
  // Cloudflare asked for by name touches no Tailscale provider.
  assert.equal((await pick('cloudflare', [host, node, stubProvider('cloudflare')])).chosen, 'cloudflare');
});

function nodeHarness({ killGraceMs = 2000, certWaitMs = 60_000, certBehaviour = 'ok', upBehaviour = 'login-then-ok', host = {}, env = {}, loginWaitMs = 200, registry, daemonOutput = [], loginChunks = ['\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/abc123\n'] } = {}) {
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
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
      events.cert = { args, child, signals: [], files: args.filter(a => /^--(cert|key)-file=/.test(a)).map(a => a.split('=')[1]) };
      child.kill = sig => {
        events.cert.signals.push(sig); events.cert.dirAtKill = fs.existsSync(path.dirname(events.cert.files[0]));
        if ((certBehaviour === 'stubborn' || certBehaviour === 'late') && sig !== 'SIGKILL') return true; // ignores SIGTERM
        if (certBehaviour === 'immortal') return true; // ignores everything
        child.signalCode = sig;
        setTimeout(() => { events.cert.dirAtExit = fs.existsSync(path.dirname(events.cert.files[0])); child.emit('exit', null); }, certBehaviour === 'late' ? 150 : 10);
        return true;
      };
      setImmediate(() => {
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
  const node = tailscaleNodeProvider({ env: { PATH: process.env.PATH, ...env }, spawnChild, runCli: () => fake.run, which: () => '/usr/bin/x', registry, clock: { sleep: async ms => { await sleepMs(ms === 250 ? 1 : ms); } }, newId: () => 'abc123', loginWaitMs, daemonWaitMs: 200, certWaitMs, killGraceMs });
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
  const ended = await sweepTrialNodes({ registry: b.registry, processCmd: () => null, kill() {}, clock: { sleep: async () => {} } });
  assert.deepEqual(ended, ['dalan-trial-abc123']);
  assert.equal(fs.existsSync(leftover), false, 'the sweep removed the key');
  b.events.cert.child.kill('SIGTERM'); await pendingB; await b.node.stop();
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
  const ended = await sweepTrialNodes({ registry: never.registry, processCmd: () => null, kill() {}, clock: { sleep: async () => {} } });
  assert.deepEqual(ended, ['dalan-trial-abc123']);
  assert.equal(fs.existsSync(kept), false, 'the sweep removed them');
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
    fs.writeFileSync(path.join(registry, `${name}.json`), JSON.stringify({ dir, sock, hostname: name, pid: daemon.pid, owner: ownerPid, ownerCmd: processCommand(ownerPid) ?? `node -e 0 --owner-${name}`, home: path.join(root, name) }));
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

test('Ctrl-C during startup ends it at once: nothing waits for the login, the node is cleaned up and Cloudflare is not tried', async () => {
  const h = nodeHarness({ upBehaviour: 'hang', loginWaitMs: 600_000 }); // the abort must come long before the login timeout
  const long = h.node;
  const cloudflare = stubProvider('cloudflare');
  const controller = new AbortController();
  const home = fs.mkdtempSync(path.join(tmp, 'node-'));
  const busy = { ok: false, busy: true, line: 'busy', fix: 'free it' };
  const started = Date.now();
  const pending = startRoute({ route: 'auto', providers: [stubProvider('tailscale', busy), long, cloudflare], gatePort: 1, home, say() {}, signal: controller.signal });
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
  const cf = cloudflareProvider({ env: {}, ensure: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), spawnChild: () => { throw new Error('no spawn after abort'); } });
  const waiting = cf.start({ gatePort: 1, home, signal: slow.signal });
  slow.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
});

test('Cloudflare Quick Tunnel: an address split across two output chunks is still found', async () => {
  const calls = [];
  const spawnChild = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null; child.pid = 1;
    child.kill = () => { child.exitCode = 0; child.emit('exit'); }; calls.push(child);
    setImmediate(() => { child.stderr.write('INF |  https://split-name-d'); setTimeout(() => child.stderr.write('emo.trycloudflare.com  |\n'), 10); });
    return child;
  };
  const cf = cloudflareProvider({ env: {}, spawnChild, ensure: async () => ({ bin: '/x' }), startMs: 2000 });
  const started = await cf.start({ gatePort: 1, home: fs.mkdtempSync(path.join(tmp, 'cf-')) });
  assert.equal(started.origin, 'https://split-name-demo.trycloudflare.com');
  await cf.stop();
});

test('the printed restart command: the same home only where the address is stable; a new home otherwise', () => {
  const base = { cli: 'dalan', home: '/h', shellQuote: x => x, client: 'claude', route: 'auto' };
  assert.equal(tryHostedInternals.restartCommand({ ...base, provider: 'tailscale' }), 'dalan try --public --client claude --route auto --home /h');
  for (const provider of ['cloudflare', 'tailscale-node']) assert.equal(tryHostedInternals.restartCommand({ ...base, provider }), 'dalan try --public --client claude --route auto', `${provider}: its next address is new, so the home would refuse it`);
});

test('a route that fails to start names the real next steps, not a new home', async () => {
  const home = path.join(tmp, 'routefail');
  const failing = { name: 'tailscale', probe: () => ({ ok: true, origin: 'x' }), start: async () => { throw new Error('tailscale funnel did not publish the rule'); }, stop: async () => ({ removed: true }) };
  const context = { shellCli: `'x'`, cli: 'dalan', shellHome: `'${home}'`, logFile: '/none', shellLog: '/none' };
  const error = await runTry({ argv: ['--public', '--route', 'tailscale', '--home', home], env: { PATH: process.env.PATH }, out: { write() {} }, input: new PassThrough(), errorContext: context, hosted: { interactive: true, providers: [failing] } }).then(() => null, e => e);
  assert.equal(error.tryKind, 'route_start');
  const text = tryInternals.formatTryError(error, context, { home: '/other', port: 1 });
  assert.match(text, /tailscale funnel did not publish the rule\nThe public route did not start, so the bridge was not started\./);
  assert.doesNotMatch(text, /new home|Fix the problem above/);
  assert.match(text, /Try again with:\n\s+dalan try --public --client chatgpt --route tailscale --home /);
  assert.match(text, /Or use a temporary Cloudflare route instead:\n\s+dalan try --public --client chatgpt --route cloudflare --home /);
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
  assert.deepEqual(parseTryArgs(['--public', '--client', 'claude', '--route', 'cloudflare']), { home: null, port: null, callbacks: [], mode: 'public', client: 'claude', route: 'cloudflare' });
  assert.equal(parseTryArgs(['--local']).mode, 'local');
  assert.equal(parseTryArgs(['--client', 'chatgpt']).mode, 'public');
  for (const bad of [['--local', '--public', '--callback', 'x'], ['--local', '--client', 'chatgpt'], ['--local', '--route', 'auto'], ['--public', '--callback', 'x'], ['--client', 'bing'], ['--route', 'ngrok'], ['--client']]) assert.throws(() => parseTryArgs(bad), /./, JSON.stringify(bad));
  assert.deepEqual(parseTryArgs([]), { home: null, port: null, callbacks: [] });
});

async function answerMode(lines) {
  const input = new PassThrough();
  let out = '';
  const pending = chooseMode({ input, out: { write: t => { out += t; } }, signal: undefined });
  for (const line of lines) { await sleepMs(20); input.write(line); }
  return { choice: await pending, out };
}
test('the mode question: Enter chooses hosted ChatGPT, and the exposure notice comes before the choice', async () => {
  const enter = await answerMode(['\n', '\n']);
  assert.deepEqual(enter.choice, { mode: 'public', client: 'chatgpt' });
  assert.ok(enter.out.indexOf('Ctrl-C stops the trial') < enter.out.indexOf('Choose [1]:'));
  assert.match(enter.out, /It may download a tunnel helper/);
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

test('each missing Tailscale prerequisite gets one line and the Cloudflare fallback', () => {
  const absent = tailscaleProvider({ which: () => null, tailscale: () => { throw new Error('unused'); } }).probe();
  assert.equal(absent.line, 'Tailscale is not installed; using a temporary Cloudflare route.');
  const probe = status => provider(fakeTailscale({ status })).probe();
  assert.match(probe({ ...readyStatus, BackendState: 'NeedsLogin' }).line, /^Tailscale is not connected; using Cloudflare\. To reconnect Tailscale later, run: tailscale up$/);
  assert.match(probe({ ...readyStatus, CurrentTailnet: { MagicDNSEnabled: false } }).line, /^MagicDNS is off; using Cloudflare\.$/);
  assert.match(probe({ ...readyStatus, Self: { ...readyStatus.Self, CapMap: { funnel: [] } } }).line, /^Tailscale HTTPS is off; using Cloudflare\.$/);
  assert.match(probe({ ...readyStatus, Self: { ...readyStatus.Self, CapMap: { https: [] } } }).line, /^Funnel is not allowed for this tailnet; using Cloudflare\.$/);
  assert.match(probe({ ...readyStatus, Self: { ...readyStatus.Self, CapMap: { https: [], funnel: [], 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': [] } } }).ok ? 'ok' : 'no', /ok/);
  const full = provider(fakeTailscale({ serve: { TCP: { 443: {} } } })).probe();
  assert.equal(full.line, 'Tailscale port 443 is not free for Funnel on this computer; its rules are unchanged.');
  assert.equal(full.busy, true, 'only a busy 443 leads to a node of the trial\'s own');
  assert.equal(absent.busy, undefined);
  for (const result of [absent, full]) assert.ok(result.fix, 'an explicit --route tailscale gets the owner\'s own fix');
  assert.match(explainTailscale(new Error('weird')).line, /^Tailscale Funnel is not usable \(weird\); using Cloudflare\.$/);
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

test('auto falls back to Cloudflare when Funnel does not start, after confirming its rule is gone; an explicit route does not', async () => {
  const lines = [];
  const fake = fakeTailscale();
  const ts = provider(fake, { clock: { sleep: async () => {} } });
  const cloud = fakeRoute();
  // A Funnel whose status never shows our rule fails to publish.
  const broken = { ...ts, async start(ctx) { throw new Error('tailscale funnel did not publish the rule'); }, probe: () => ({ ok: true, origin: 'x' }), stop: async () => ({ removed: true }) };
  const route = await startRoute({ route: 'auto', providers: [broken, cloud.provider], gatePort: 1, home: tmp, say: line => lines.push(line) });
  assert.equal(route.provider.name, 'cloudflare');
  assert.match(lines.join("\n"), /Tailscale did not start .* using a temporary Cloudflare route\./);
  await route.stop();
  const dead = unreadyTailscale('Funnel is not allowed for this tailnet; using Cloudflare.');
  dead.probe = () => ({ ok: false, line: 'x', fix: 'A tailnet administrator can enable Funnel at https://console.tailscale.com/admin/acls, then retry.' });
  await assert.rejects(startRoute({ route: 'tailscale', providers: [dead, fakeRoute().provider], gatePort: 1, home: tmp, say() {} }), /tailnet administrator can enable Funnel at https:\/\/console\.tailscale\.com\/admin\/acls/);
  const cf = fakeRoute();
  const chosen = await startRoute({ route: 'cloudflare', providers: [dead, cf.provider], gatePort: 1, home: tmp, say() {} });
  assert.equal(chosen.provider.name, 'cloudflare');
  await chosen.stop();
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
function manifestFor(bytes, archive = false) {
  return { version: 't1', base: 'https://example.invalid/', assets: { 'linux-x64': { name: 'cloudflared-linux-amd64', sha256: sha(bytes) }, 'darwin-arm64': { name: 'cloudflared-darwin-arm64.tgz', sha256: sha(bytes), archive: true } } };
}
test('the helper: the shipped manifest pins a checksum for every supported platform', () => {
  assert.deepEqual(Object.keys(CLOUDFLARED.assets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
  for (const asset of Object.values(CLOUDFLARED.assets)) assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.match(CLOUDFLARED.base, /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/[^/]+\/$/);
});
test('the helper: verified before it can run, cached, re-checked on reuse, and never executed when wrong', async () => {
  const bytes = Buffer.from('#!/bin/sh\necho ok\n');
  const cacheRoot = fs.mkdtempSync(path.join(tmp, 'cache-'));
  const base = { platform: 'linux', arch: 'x64', env: {}, cacheRoot, which: () => null, manifest: manifestFor(bytes) };
  const said = [];
  const first = await ensureCloudflared({ ...base, download: async url => { assert.equal(url, 'https://example.invalid/cloudflared-linux-amd64'); return bytes; }, say: l => said.push(l) });
  assert.equal(first.source, 'download');
  assert.deepEqual(said, ['Downloading the verified tunnel helper for this computer…']);
  assert.equal(fs.statSync(first.bin).mode & 0o777, 0o700);
  assert.equal((await ensureCloudflared({ ...base, download: async () => { throw new Error('must reuse'); } })).source, 'cache');
  fs.appendFileSync(first.bin, 'tampered');
  assert.equal((await ensureCloudflared({ ...base, download: async () => bytes })).source, 'download', 'a changed cached binary is replaced');
  // A wrong download is refused before anything is written as the helper.
  const empty = fs.mkdtempSync(path.join(tmp, 'cache-'));
  await assert.rejects(ensureCloudflared({ ...base, cacheRoot: empty, download: async () => Buffer.from('evil') }), error => error instanceof HelperError && error.code === 'checksum' && /could not be verified/.test(error.message));
  assert.equal(fs.existsSync(path.join(empty, 'cloudflared')), false);
  assert.deepEqual(fs.readdirSync(empty), [], 'no partial file is left');
  await assert.rejects(ensureCloudflared({ ...base, cacheRoot: empty, platform: 'darwin', env: {}, which: n => n === 'brew' ? '/opt/homebrew/bin/brew' : null, arch: 'arm64', download: async () => { throw new Error('offline'); } }), /Tunnel-helper download failed \(offline\)\. Install it with: brew install cloudflared/);
  await assert.rejects(ensureCloudflared({ ...base, platform: 'win32' }), error => error.code === 'unsupported');
  assert.equal((await ensureCloudflared({ ...base, which: () => '/usr/local/bin/cloudflared', download: async () => { throw new Error('no'); } })).source, 'path', 'a cloudflared already installed is used as is');
});
test('the helper: a macOS archive is extracted only after its checksum matches', async () => {
  const bytes = Buffer.from('archive-bytes');
  const cacheRoot = fs.mkdtempSync(path.join(tmp, 'cache-'));
  const result = await ensureCloudflared({ platform: 'darwin', arch: 'arm64', env: {}, cacheRoot, which: () => null, manifest: manifestFor(bytes), download: async () => bytes,
    extract: async (archive, dir) => { assert.equal(sha(fs.readFileSync(archive)), sha(bytes)); fs.writeFileSync(path.join(dir, 'cloudflared'), '#!/bin/sh\n'); } });
  assert.equal(result.source, 'download');
  assert.ok(fs.existsSync(result.bin));
});

test('quick tunnel output: the public origin is read strictly, and Cloudflare\'s own API host is not it', () => {
  assert.equal(parseQuickTunnelOrigin('INF |  https://violet-river-demo.trycloudflare.com  |'), 'https://violet-river-demo.trycloudflare.com');
  assert.equal(parseQuickTunnelOrigin('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"'), null);
  assert.equal(parseQuickTunnelOrigin('https://trycloudflare.com.evil.example/x'), null);
  assert.equal(parseQuickTunnelOrigin('nothing here'), null);
});

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
test('Cloudflare Quick Tunnel: started against the gate with an isolated configuration, stopped by its own handle', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'cf-'));
  const fake = fakeSpawn(['INF Requesting new quick Tunnel on trycloudflare.com...', 'INF |  https://violet-river-demo.trycloudflare.com  |']);
  const cf = cloudflareProvider({ env: { PATH: '/usr/bin', HOME: '/home/real', TUNNEL_TOKEN: 'secret' }, spawnChild: fake.spawnChild, ensure: async () => ({ bin: '/cache/cloudflared' }), clock: { sleep: async () => {} } });
  const started = await cf.start({ gatePort: 7001, home });
  assert.equal(started.origin, 'https://violet-river-demo.trycloudflare.com');
  const [call] = fake.calls;
  assert.equal(call.bin, '/cache/cloudflared');
  assert.deepEqual(call.args.slice(0, 1).concat(call.args.slice(-2)), ['tunnel', '--url', 'http://127.0.0.1:7001']);
  assert.equal(fs.readFileSync(call.args[call.args.indexOf('--config') + 1], 'utf8'), '', 'an empty configuration: a named-tunnel config cannot change the target');
  assert.equal(call.options.env.HOME, path.join(home, 'cloudflared'), 'the helper does not see the user\'s home');
  assert.equal(call.options.env.TUNNEL_TOKEN, undefined, 'no provider login or token is passed through');
  assert.deepEqual(await cf.stop(), { removed: true });
  assert.equal(call.child.exitCode, 0);
});
test('Cloudflare Quick Tunnel: a helper that exits before it is ready is a clear failure, not a hang', async () => {
  const fake = fakeSpawn([], { exitEarly: true });
  const cf = cloudflareProvider({ env: {}, spawnChild: fake.spawnChild, ensure: async () => ({ bin: '/x' }), startMs: 5000 });
  await assert.rejects(cf.start({ gatePort: 1, home: fs.mkdtempSync(path.join(tmp, 'cf-')) }), /cloudflared exited before the tunnel was ready/);
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
  const good = {
    meta: { resource: `${origin}/${secret}/mcp`, authorization_servers: [`${origin}/${secret}/oauth`] },
  };
  const respond = (overrides = {}) => async (url, init = {}) => {
    const u = new URL(url);
    if (overrides[u.pathname]) return overrides[u.pathname]();
    if (u.pathname.startsWith('/.well-known/')) return Response.json(good.meta);
    if (u.pathname === `/${secret}/mcp`) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="x"' } });
    return new Response('', { status: 404 });
  };
  const check = async overrides => verifyPublicReady({ origin, secret, fetchImpl: respond(overrides), clock: virtualClock(), timeoutMs: 6000 });
  assert.equal((await check({})).ready, true);
  assert.match((await check({ [`/.well-known/oauth-protected-resource/${secret}/mcp`]: () => Response.json({ resource: 'https://other/x', authorization_servers: [] }) })).last, /different resource/);
  assert.match((await check({ [`/.well-known/oauth-protected-resource/${secret}/mcp`]: () => Response.json({ resource: good.meta.resource, authorization_servers: ['https://elsewhere.example/o'] }) })).last, /different issuer/);
  assert.match((await check({ [`/${secret}/mcp`]: () => new Response('{}', { status: 200 }) })).last, /not an OAuth challenge/);
  assert.match((await check({ '/connect/pending': () => new Response('{}', { status: 200 }) })).last, /\/connect\/pending answers on the public address/);
  assert.match((await check({ [`/.well-known/oauth-protected-resource/${secret}/mcp`]: () => new Response('', { status: 503 }) })).last, /HTTP 503/);
});

test('handoff text: the same text for the same inputs, with no unfilled value', () => {
  for (const client of Object.keys(CLIENTS)) {
    const text = handoffText({ client, url: 'https://x.trycloudflare.com/s/mcp', requestId: 'req_1', requestPhrase: 'bridge first report abcd1234' });
    assert.doesNotMatch(text, /<[^>]+>|PATTERN|NAME\b|PORT\b/);
    assert.ok(text.includes('https://x.trycloudflare.com/s/mcp') && text.includes('claim only req_1,') && text.includes('(bridge first report abcd1234)'));
  }
});

test('uaToken names a known caller class and never echoes the caller\'s own text', () => {
  const of = ua => uaToken({ headers: ua === undefined ? {} : { 'user-agent': ua } });
  for (const [ua, want] of [['Claude-User/1.0 (+Anthropic)', 'Claude-User'], ['ClaudeBot/1.0', 'ClaudeBot'], ['anthropic-ai/1.0', 'anthropic-ai'], ['ChatGPT-User/1.0', 'ChatGPT-User'], ['OAI-SearchBot/1.0', 'OAI-SearchBot'],
    ['node', 'node'], ['undici', 'undici'], ['curl/8.5', 'curl'], ['python-httpx/0.27', 'python'], ['Python-urllib/3.12', 'python'], ['Mozilla/5.0 (X11)', 'Mozilla'], ['Zq8Lm3Vx9Tn2Rb7Kd4Hs6Pw1Yc5Jf0GH', 'other'], ['Zq8Lm3Vx9Tn2Rb7Kd4Hs6Pw1Yc5Jf0GH/1.0', 'other'], ['', null], [undefined, null]]) {
    assert.equal(of(ua), want, String(ua));
  }
});
