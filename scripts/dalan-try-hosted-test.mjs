// `dalan try --public`: the hosted-client path. No real tunnel, no real Tailscale, no ChatGPT or claude.ai account.
// A fake route (a relay on its own port, so the public address is not the bridge's bind address) and a scripted hosted client
// stand in for the outside. The bridge, its OAuth server, its MCP tools and the CLI are the real ones.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { beginPairing, openSession, workJob } from '../src/demo-worker.mjs';
import { parseTryArgs, runTry } from '../src/try.mjs';
import { chooseMode } from '../src/try-hosted.mjs';
import { handoffText, CLIENTS } from '../src/try-hosted-clients.mjs';
import { CLOUDFLARED, HelperError, cloudflareProvider, createGate, ensureCloudflared, explainTailscale, parseQuickTunnelOrigin, startRoute, tailscaleProvider, verifyPublicReady } from '../src/try-exposure.mjs';
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
    const secret = new URL(url).pathname.split('/')[1];
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
  assert.match(run.out, /try --public --client chatgpt --route auto --home /, 'the restart command keeps every selection');
  assert.equal(await closed(run.route.gatePort), true, 'the gate is closed');
});

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
function fakeTailscale({ status = readyStatus, serve = {}, onFunnelOn } = {}) {
  const state = { calls: [], web: {}, serve };
  const run = args => {
    state.calls.push(args.join(' '));
    const ok = value => ({ status: 0, stdout: JSON.stringify(value) });
    if (args[0] === 'status') return ok(status);
    if (args[0] === 'serve') return ok(state.serve);
    if (args[0] === 'funnel' && args[1] === 'status') return ok({ Web: state.web, AllowFunnel: Object.fromEntries(Object.keys(state.web).map(k => [k, true])) });
    if (args[0] === 'funnel' && args.at(-1) === 'off') { delete state.web[`box.tail1234.ts.net:${args[1].split('=')[1]}`]; return { status: 0, stdout: '' }; }
    throw new Error(`unexpected tailscale call ${args.join(' ')}`);
  };
  const spawnChild = (cmd, args) => {
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.pid = 4242;
    const port = args.find(a => a.startsWith('--https=')).split('=')[1], target = args.at(-1);
    onFunnelOn?.(args);
    state.web[`box.tail1234.ts.net:${port}`] = { Handlers: { '/': { Proxy: target } } };
    child.kill = () => { child.exitCode = 0; delete state.web[`box.tail1234.ts.net:${port}`]; child.emit('exit'); };
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
  const full = provider(fakeTailscale({ serve: { TCP: { 443: {}, 8443: {}, 10000: {} } } })).probe();
  assert.equal(full.line, 'All permitted Funnel ports are occupied; using Cloudflare. Existing routes are unchanged.');
  for (const result of [absent, full]) assert.ok(result.fix, 'an explicit --route tailscale gets the owner\'s own fix');
  assert.match(explainTailscale(new Error('weird')).line, /^Tailscale Funnel is not usable \(weird\); using Cloudflare\.$/);
});

test('a ready Funnel is used, on a free port, and removed on stop; another rule is never touched', async () => {
  const fake = fakeTailscale({ serve: { Web: { 'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } });
  const ts = provider(fake);
  const probe = ts.probe();
  assert.equal(probe.origin, 'https://box.tail1234.ts.net:8443', '443 is taken by another rule, so the next permitted port is used');
  const home = fs.mkdtempSync(path.join(tmp, 'ts-'));
  const started = await ts.start({ gatePort: 5151, home });
  assert.equal(started.origin, probe.origin);
  assert.deepEqual(fake.state.spawned, ['tailscale', 'funnel', '--https=8443', 'http://127.0.0.1:5151'], 'a foreground rule to the gate, never --bg');
  assert.ok(fs.existsSync(path.join(home, 'dot-bridge-trial.exposure.json')), 'ownership is recorded before the rule exists');
  assert.deepEqual(await ts.stop(), { removed: true });
  assert.equal(fs.existsSync(path.join(home, 'dot-bridge-trial.exposure.json')), false);
  assert.deepEqual(fake.state.calls.filter(c => c.startsWith('funnel --https')), [], 'no blanket reset and no other rule was switched off');
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
  assert.match(lines.join('\n'), /Tailscale Funnel did not start .* using a temporary Cloudflare route\./);
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
  // The child ends without removing the rule (as after a crash), and the rule now points somewhere else.
  other.state.child.kill = () => { other.state.child.exitCode = 0; other.state.child.emit('exit'); };
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
