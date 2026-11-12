import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { checkPublicIdentity, watchPublicIdentity } from '../src/try-exposure.mjs';

const origin = 'https://trial.example';
const secret = randomBytes(24).toString('hex');
const identity = {
  resource: `${origin}/${secret}/mcp`,
  authorizationServers: [origin],
  issuer: origin,
  authorizationServer: {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
  },
};
const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
};

const readyFetch = async (input, options) => {
  const url = new URL(input);
  if (options.redirect !== 'manual') throw new Error('redirects must remain manual');
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource/')) return Response.json({ resource: identity.resource, authorization_servers: identity.authorizationServers });
  if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return Response.json(identity.authorizationServer);
  if (url.pathname.endsWith('/mcp')) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  return new Response('', { status: 404 });
};

test('public trial ends after two quiet-route identity failures and preserves the first origin', async () => {
  let unavailable = false, active = 0, maxActive = 0, probes = 0;
  const fetchImpl = async (...args) => {
    active++; maxActive = Math.max(maxActive, active); probes++;
    try {
      if (unavailable) return new Response('no tunnel', { status: 502 });
      return await readyFetch(...args);
    } finally { active--; }
  };
  const notices = [];
  const watcher = await watchPublicIdentity({ origin, secret, identity, fetchImpl, intervalMs: 5, retryMs: 5, timeoutMs: 500, onStatus: status => notices.push(status) });
  try {
    await watcher.ready;
    const before = probes;
    unavailable = true;
    const loss = await withTimeout(watcher.lost, 1000, 'watcher did not stop after repeated 502 responses');
    assert.equal(loss.reason, 'unresponsive');
    assert.equal(loss.origin, origin);
    assert.ok(probes - before >= 2, 'the route was checked twice after its first failure');
    assert.ok(notices.includes('retrying'));
    assert.equal(maxActive, 1, 'identity checks do not overlap');
  } finally { await watcher.stop(); }
});

test('public trial treats an announced issuer or origin change as immediate identity loss', async () => {
  const changed = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource/')) return Response.json({ resource: identity.resource, authorization_servers: ['https://changed.example'] });
    return readyFetch(input, options);
  };
  const watcher = await watchPublicIdentity({ origin, secret, identity, fetchImpl: changed, intervalMs: 5, retryMs: 5, timeoutMs: 500 });
  try {
    const loss = await withTimeout(watcher.lost, 500, 'identity change was not detected');
    assert.equal(loss.reason, 'identity_changed');
    assert.equal(loss.origin, origin);
  } finally { await watcher.stop(); }
});

test('one transient miss recovers without ending the first identity', async () => {
  let missed = false, restored = false;
  const recovered = new Promise(resolve => { restored = resolve; });
  const fetchImpl = async (...args) => {
    const url = new URL(args[0]);
    if (!missed && url.pathname.startsWith('/.well-known/oauth-protected-resource/')) {
      missed = true;
      return new Response('temporary miss', { status: 502 });
    }
    return readyFetch(...args);
  };
  const statuses = [];
  const watcher = await watchPublicIdentity({ origin, secret, identity, fetchImpl, intervalMs: 5, retryMs: 5, timeoutMs: 500, onStatus: status => { statuses.push(status); if (status === 'ready') restored(); } });
  try {
    assert.equal(await withTimeout(watcher.ready, 500, 'watcher did not start'), true);
    await withTimeout(recovered, 500, 'watcher did not recover after a transient failure');
    assert.deepEqual(statuses.slice(0, 2), ['retrying', 'ready']);
  } finally { await watcher.stop(); }
});

test('identity probes bound slow fetches and bodies to one deadline', async () => {
  let cancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; },
  }), { status: 200 });
  const started = Date.now();
  const result = await checkPublicIdentity({ origin, secret, fetchImpl, timeoutMs: 40 });
  assert.equal(result.kind, 'unresponsive', JSON.stringify(result));
  assert.ok(Date.now() - started < 500, 'one deadline bounds the whole identity check');
  assert.equal(cancelled, true, 'the timed out response body is cancelled');
});

test('identity probes cancel oversized metadata without reading an unbounded response', async () => {
  let cancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { cancelled = true; },
  }), { status: 200 });
  const result = await checkPublicIdentity({ origin, secret, fetchImpl, timeoutMs: 500 });
  assert.equal(result.kind, 'identity_changed');
  assert.equal(cancelled, true, 'the oversized metadata stream is cancelled');
});
