// The public-route checks for `dalan try --public`. Routes themselves come from Gozar (gozar-routes.mjs); this file holds what Dalan
// owns around them: the loopback gate a route forwards to, and the readiness and identity checks run on the public origin.
import http from 'node:http';
import { safeDiagnostic } from './diagnostic.mjs';
export { processCommand } from './process-inspection.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const abortReason = signal => signal.reason ?? Object.assign(new Error('stopped'), { name: 'AbortError', code: 'ABORT_ERR' });
const raceAbort = (promise, signal) => !signal ? promise : Promise.race([promise, new Promise((_, reject) => {
  if (signal.aborted) reject(abortReason(signal)); else signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
})]);
// Complete lines from chunks that may split anywhere; `end()` hands over a last line that had no newline.
export function lineBuffer(onLine, max = 65_536) {
  let buf = '';
  const push = chunk => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    if (buf.length > max) buf = buf.slice(-max);
  };
  push.end = () => { if (buf) onLine(buf); buf = ''; };
  return push;
}

// ---- the gate ----------------------------------------------------------------------------------------------------------
// The route forwards to this listener, never to the bridge. A tunnel reports its address only after it starts, and the
// bridge needs that address at `init`, so the route must exist first. The gate answers 503 until the bridge is up, forwards to the
// one bridge port after that, and answers 503 again once closed. Nothing else on the computer is ever reachable through the route.
export async function createGate() {
  let upstream = null, publicHost = null;
  // A fresh connection per request: a kept-alive socket that the bridge closed in the meantime would fail the next request with a 502
  // that the bridge never sees.
  const agent = new http.Agent({ keepAlive: false });
  const server = http.createServer((req, res) => {
    if (!upstream) { res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' }); res.end('starting\n'); return; }
    // A route may forward with Host set to this loopback gate. Restore only that exact transport host to the
    // allocated public host; preserve other hosts and Origin for the bridge's identity checks.
    const headers = publicHost && req.headers.host === `127.0.0.1:${server.address().port}` ? { ...req.headers, host: publicHost } : req.headers;
    const forward = http.request({ agent, host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers }, answer => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  });
  server.headersTimeout = 10_000; server.requestTimeout = 60_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    open(port, { publicOrigin } = {}) { upstream = port; publicHost = publicOrigin ? new URL(publicOrigin).host : null; },
    shut() { upstream = null; },
    async close() { upstream = null; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

// A trial constraint, not an OAuth rule: RFC 8414 lets an authorization server live on another origin. A trial's bridge serves its own
// authorization server, so the check requires the issuer and every endpoint on the trial's public origin (a bare root issuer counts).
export const TRIAL_ORIGIN_RULE = 'a trial constraint: the bridge serves its own authorization server on the public origin';
export const onOrigin = (origin, value) => value === origin || value.startsWith(`${origin}/`);
// RFC 8414 section 3.1: the well-known segment goes between the host and the issuer's path, and a terminal slash of that path is
// dropped. The metadata's `issuer` is still compared to the issuer exactly as written.
export function authorizationServerMetadataUrl(issuer) {
  let url; try { url = new URL(issuer); } catch { url = null; }
  if (!url || url.search || url.hash || issuer.includes('?') || issuer.includes('#')) throw new Error('the issuer is not a plain address (it has a query or fragment, or is not a URL)');
  return `${url.origin}/.well-known/oauth-authorization-server${url.pathname.replace(/\/$/, '')}`;
}

// ---- readiness ---------------------------------------------------------------------------------------------------------
// The public address answers as this bridge: trusted TLS (the platform's fetch checks it), discovery that names this origin and
// resource, an OAuth challenge on an unauthenticated MCP request, and no owner route. The secret path is known only to this bridge,
// so a matching discovery document also shows that the route reaches it and not another program.
export async function verifyPublicReady({ origin, secret, fetchImpl = fetch, clock = { now: Date.now, sleep }, timeoutMs, say = () => {}, signal }) {
  const within = ms => signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
  const resource = `${origin}/${secret}/mcp`;
  const check = async () => {
    const meta = await fetchImpl(`${origin}/.well-known/oauth-protected-resource/${secret}/mcp`, { redirect: 'manual', signal: within(10_000) });
    if (meta.status !== 200) return `discovery returned HTTP ${meta.status}`;
    const doc = await meta.json().catch(() => null);
    if (doc?.resource !== resource) return 'discovery names a different resource';
    if (!Array.isArray(doc.authorization_servers) || doc.authorization_servers.length === 0) return 'discovery names no authorization server';
    if (!doc.authorization_servers.every(s => onOrigin(origin, String(s)))) return `discovery names an issuer outside this origin (${TRIAL_ORIGIN_RULE})`;
    // The issuer's own metadata: the exact issuer, and https endpoints for sign-in, tokens and registration on this origin.
    const issuer = String(doc.authorization_servers[0]);
    let asUrl; try { asUrl = authorizationServerMetadataUrl(issuer); } catch (error) { return error.message; }
    const asMeta = await fetchImpl(asUrl, { redirect: 'manual', signal: within(10_000) });
    if (asMeta.status !== 200) return `authorization-server metadata returned HTTP ${asMeta.status}`;
    const as = await asMeta.json().catch(() => null);
    if (as?.issuer !== issuer) return 'the authorization-server issuer does not match the issuer in discovery';
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      if (typeof as[key] !== 'string' || !onOrigin(origin, as[key])) return `the authorization server's ${key} is missing or is not an address on this origin (${TRIAL_ORIGIN_RULE})`;
    }
    const challenge = await fetchImpl(resource, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}', signal: within(10_000) });
    const isChallenge = challenge.status === 401 && /^Bearer/i.test(challenge.headers.get('www-authenticate') ?? '');
    void challenge.body?.cancel().catch(() => {});
    if (!isChallenge) return `an unauthenticated MCP request returned HTTP ${challenge.status}, not an OAuth challenge`;
    for (const owner of ['/admin', '/connect/pending', '/connect/list']) {
      const res = await fetchImpl(`${origin}${owner}`, { redirect: 'manual', signal: within(10_000) });
      const status = res.status;
      void res.body?.cancel().catch(() => {});
      if (status === 200) return `${owner} answers on the public address`;
    }
    return {
      resource: doc.resource,
      authorizationServers: doc.authorization_servers,
      issuer,
      authorizationServer: as,
    };
  };
  const end = clock.now() + timeoutMs;
  let last = 'no answer yet', nextSay = clock.now() + 15_000;
  for (;;) {
    signal?.throwIfAborted();
    try { last = await check(); if (last && typeof last === 'object') return { ready: true, identity: last }; }
    catch (error) { if (signal?.aborted) throw error; last = safeDiagnostic(error.cause?.code ?? error.message, 120); }
    if (clock.now() >= end) return { ready: false, last };
    if (clock.now() >= nextSay) { say(`Still waiting for the public address to answer (${last})…`); nextSay += 15_000; }
    await raceAbort(clock.sleep(2000), signal);
  }
}

const identityMatches = (actual, expected) => actual.resource === expected.resource &&
  JSON.stringify(actual.authorizationServers) === JSON.stringify(expected.authorizationServers) &&
  actual.issuer === expected.issuer &&
  ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint'].every(key => actual.authorizationServer[key] === expected.authorizationServer[key]);

async function readIdentityJson(response, signal, label, maxBytes = 65_536) {
  if (response.status >= 300 && response.status < 400) return { kind: 'identity_changed', detail: `${label} redirected` };
  if (response.status !== 200) return { kind: 'unresponsive', detail: `${label} returned HTTP ${response.status}` };
  if (!response.body) return { kind: 'unresponsive', detail: `${label} returned no body` };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('identity check timed out');
      const { done, value } = await raceSignal(reader.read(), signal, () => reader.cancel().catch(() => {}));
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        return { kind: 'identity_changed', detail: `${label} returned an oversized identity document` };
      }
      chunks.push(Buffer.from(value));
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return { kind: 'identity_changed', detail: `${label} returned invalid JSON` }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'identity_changed', detail: `${label} returned invalid JSON` };
    return { value };
  } finally { try { reader.releaseLock(); } catch { /* A timed-out stream may still be cancelling. */ } }
}

function raceSignal(promise, signal, onAbort = () => {}) {
  if (signal.aborted) {
    const failed = Promise.reject(signal.reason ?? new Error('identity check timed out'));
    onAbort();
    return failed;
  }
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => { reject(signal.reason ?? new Error('identity check timed out')); onAbort(); };
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', listener));
}

// One bounded identity check: one deadline covers TLS, all response bodies and every endpoint.
export async function checkPublicIdentity({ origin, secret, fetchImpl = fetch, signal, timeoutMs = 5000 }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const checkSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const request = (url, init = {}) => raceSignal(fetchImpl(url, { ...init, redirect: 'manual', signal: checkSignal }), checkSignal);
  const resource = `${origin}/${secret}/mcp`;
  try {
    const meta = await request(`${origin}/.well-known/oauth-protected-resource/${secret}/mcp`);
    const docResult = await readIdentityJson(meta, checkSignal, 'protected-resource metadata');
    if (docResult.kind) return docResult;
    const doc = docResult.value;
    if (doc.resource !== resource || !Array.isArray(doc.authorization_servers) || !doc.authorization_servers.length ||
        doc.authorization_servers.some(value => typeof value !== 'string' || !onOrigin(origin, value))) {
      return { kind: 'identity_changed', detail: 'protected-resource identity changed' };
    }
    const issuer = doc.authorization_servers[0];
    let asUrl;
    try { asUrl = authorizationServerMetadataUrl(issuer); }
    catch { return { kind: 'identity_changed', detail: 'authorization-server identity changed' }; }
    const asResponse = await request(asUrl);
    const asResult = await readIdentityJson(asResponse, checkSignal, 'authorization-server metadata');
    if (asResult.kind) return asResult;
    const as = asResult.value;
    if (as.issuer !== issuer || !['authorization_endpoint', 'token_endpoint', 'registration_endpoint'].every(key =>
      typeof as[key] === 'string' && onOrigin(origin, as[key]))) {
      return { kind: 'identity_changed', detail: 'authorization-server identity changed' };
    }
    const challenge = await request(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    try {
      if (challenge.status >= 300 && challenge.status < 400) return { kind: 'identity_changed', detail: 'MCP endpoint redirected' };
      if (challenge.status !== 401 || !/^Bearer/i.test(challenge.headers.get('www-authenticate') ?? '')) {
        return { kind: 'unresponsive', detail: `MCP identity probe returned HTTP ${challenge.status}` };
      }
    } finally { void challenge.body?.cancel().catch(() => {}); }
    const actual = { resource: doc.resource, authorizationServers: doc.authorization_servers, issuer, authorizationServer: as };
    return { kind: 'ready', identity: actual };
  } catch (error) {
    if (signal?.aborted) return { kind: 'stopped' };
    return { kind: 'unresponsive', detail: safeDiagnostic(error?.cause?.code ?? error?.message ?? 'probe failed', 160) };
  }
}

const sleepOrAbort = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

// The URL is also the OAuth identity. A replacement or two consecutive failed public checks ends this trial.
export async function watchPublicIdentity({ origin, secret, identity, fetchImpl = fetch, intervalMs = 10_000, retryMs = 5000, timeoutMs = 5000, onStatus = () => {} }) {
  const controller = new AbortController();
  let resolveReady, resolveLost;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const lost = new Promise(resolve => { resolveLost = resolve; });
  let stopped = false, failure = null;
  const check = async () => checkPublicIdentity({ origin, secret, fetchImpl, signal: controller.signal, timeoutMs });
  const run = (async () => {
    const initial = await check();
    if (initial.kind === 'identity_changed' || (initial.kind === 'ready' && !identityMatches(initial.identity, identity))) {
      resolveLost({ origin, reason: 'identity_changed', detail: initial.detail });
      resolveReady(false);
      return;
    }
    if (initial.kind !== 'ready') {
      failure = initial;
      try { onStatus('retrying', initial.detail); } catch { /* A status message cannot keep a dead route alive. */ }
    }
    resolveReady(true);
    for (;;) {
      await sleepOrAbort(failure ? retryMs : intervalMs, controller.signal);
      if (stopped) return;
      const result = await check();
      if (result.kind === 'stopped' || stopped) return;
      if (result.kind === 'identity_changed' || (result.kind === 'ready' && !identityMatches(result.identity, identity))) {
        resolveLost({ origin, reason: 'identity_changed', detail: result.detail });
        return;
      }
      if (result.kind === 'ready') {
        failure = null;
        try { onStatus('ready'); } catch { /* A status message cannot keep a dead route alive. */ }
        continue;
      }
      if (!failure) {
        failure = result;
        try { onStatus('retrying', result.detail); } catch { /* A status message cannot keep a dead route alive. */ }
        continue;
      }
      resolveLost({ origin, reason: 'unresponsive', detail: result.detail ?? failure.detail });
      return;
    }
  })();
  return {
    ready,
    lost,
    async stop() { stopped = true; controller.abort(); await run; },
  };
}
