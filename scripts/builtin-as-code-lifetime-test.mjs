#!/usr/bin/env node
// Real loopback OAuth flow for authorization-code lifetime, bindings, PKCE, single use and interaction errors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { initAsFiles } from '../src/as-files.mjs';
import { createAs } from '../src/as.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'as-code-life-'));
const realNow = Date.now; let offset = 0;
Date.now = () => realNow() + offset;
let server;
try {
  const port = await reservedPort();
  const pub = `http://127.0.0.1:${port}`, resource = `${pub}/secret/mcp`, oauth = `${pub}/secret/oauth`;
  const callback = 'https://vendor.example/oauth/callback', dir = path.join(root, 'cfg');
  initAsFiles(dir, { publicUrl: pub, allowHttp: true });
  const as = createAs({ dir, resource, allowHttp: true, now: () => Date.now(), workerNames: () => ['lark'] });
  as.ops.allowCallback({ pattern: callback });
  server = http.createServer(async (req, res) => { if (!as.hostOk(req)) { res.writeHead(421); res.end(); return; } if (!(await as.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const jarHeader = jar => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function hit(url, jar = new Map(), options = {}) {
    const res = await fetch(url, { redirect: 'manual', ...options, headers: { ...(options.headers ?? {}), ...(jar.size ? { cookie: jarHeader(jar) } : {}) } });
    for (const line of res.headers.getSetCookie()) { const [pair] = line.split(';'); const i = pair.indexOf('='); const v = pair.slice(i + 1); if (v === '') jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), v); }
    return res;
  }
  async function register(uri = callback) {
    const res = await fetch(`${oauth}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    assert.equal(res.status, 201); return (await res.json()).client_id;
  }
  async function begin(clientId, redirect = callback) {
    const verifier = randomBytes(32).toString('base64url'), jar = new Map();
    const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: 'dot-bridge.read dot-bridge.work', state: randomBytes(8).toString('hex'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource });
    const res = await hit(`${oauth}/auth?${q}`, jar); const loc = res.headers.get('location');
    assert.ok(loc?.startsWith('/secret/oauth/interaction/'), `auth gave ${res.status} ${loc}`);
    const html = await (await hit(pub + loc, jar)).text();
    return { jar, loc, verifier, pairing: html.match(/class="code">([A-Z0-9-]+)</)?.[1] };
  }
  async function finish(flow) {
    const approved = await as.ops.approve({ code: flow.pairing, worker: 'lark', replace: true });
    const done = await hit(pub + flow.loc, flow.jar); assert.equal(done.status, 303);
    const resume = await hit(done.headers.get('location'), flow.jar);
    return { code: new URL(resume.headers.get('location')).searchParams.get('code'), approved };
  }
  const exchange = (clientId, code, verifier, redirect = callback, resrc = resource) => fetch(`${oauth}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: verifier, resource: resrc }) }).then(async r => ({ status: r.status, body: await r.json() }));
  as.ops.start({ worker: 'lark', minutes: 5 });
  const client = await register();
  const mainFlow = await begin(client); const { code: mainCode } = await finish(mainFlow);
  const stored = as.store.find('AuthorizationCode', mainCode);
  assert.ok(stored, 'issued authorization code must exist in native store');
  offset = 90000;
  const redeemed = await exchange(client, mainCode, mainFlow.verifier);
  assert.equal(redeemed.status, 200, `90-second redemption: ${redeemed.body.error ?? redeemed.status}`);
  assert.equal(stored.exp - stored.iat, 600, 'stored authorization code lifetime');
  assert.equal(await as.verifyBearer(`Bearer ${redeemed.body.access_token}`).then(() => true, () => false), true);
  const replay = await exchange(client, mainCode, mainFlow.verifier);
  assert.equal(replay.status, 400); assert.equal(replay.body.error, 'invalid_grant');
  assert.equal(await as.verifyBearer(`Bearer ${redeemed.body.access_token}`).then(() => true, () => false), false, 'replay must revoke token family');
  offset = 0;
  async function fresh() { const flow = await begin(client); return { flow, ...(await finish(flow)) }; }
  for (const [label, mutate] of [
    ['wrong PKCE', (f) => exchange(client, f.code, randomBytes(32).toString('base64url'))],
    ['wrong client', async f => exchange(await register(), f.code, f.flow.verifier)],
    ['wrong redirect', f => exchange(client, f.code, f.flow.verifier, 'https://vendor.example/other')],
    ['wrong resource', f => exchange(client, f.code, f.flow.verifier, callback, `${pub}/secret/other`)],
  ]) {
    const f = await fresh(); const result = await mutate(f);
    assert.equal(result.status, 400, `${label} status`);
    assert.ok(label === 'wrong resource' ? ['invalid_grant', 'invalid_target'].includes(result.body.error) : result.body.error === 'invalid_grant', `${label} error: ${result.body.error}`);
    assert.equal(result.body.access_token, undefined, `${label} must not issue credentials`);
  }
  const expired = await fresh();
  const expiresAt = as.store.find('AuthorizationCode', expired.code).exp;
  offset = expiresAt * 1000 - realNow();
  assert.ok(as.store.find('AuthorizationCode', expired.code), 'backing record remains during cleanup tolerance');
  const late = await exchange(client, expired.code, expired.flow.verifier);
  assert.equal(late.status, 400); assert.equal(late.body.error, 'invalid_grant'); assert.equal(late.body.access_token, undefined);
  offset = 0;
  const unknown = await hit(`${pub}/secret/oauth/interaction/not-a-real-session`);
  assert.equal(unknown.status, 400); const errorPage = await unknown.text();
  assert.match(errorPage, /Connection attempt invalid or expired/); assert.match(errorPage, /Start a new connection from the app/); assert.match(errorPage, /Attempts last 10 minutes\. If yours ran out, ask the bridge owner to start a new one\./);
  console.log('PASS authorization-code 600-second lifetime, 90-second exchange, expiry, binding, PKCE, replay revocation, and generic interaction error');
} finally {
  offset = 0; Date.now = realNow;
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
