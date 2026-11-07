#!/usr/bin/env node
// Approval is bound to the scope, resource, client and response mode the owner saw on the pairing request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { initAsFiles } from '../src/as-files.mjs';
import { createAs } from '../src/as.mjs';

const temp = new URL('../.test-home/', import.meta.url);
fs.mkdirSync(temp, { recursive: true });
const home = fs.mkdtempSync(path.join(temp.pathname, 'request-binding-'));
let as;
const server = http.createServer(async (req, res) => {
  if (!as.hostOk(req)) { res.writeHead(421); res.end(); return; }
  if (!await as.handle(req, res)) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pub = `http://127.0.0.1:${server.address().port}`, resource = `${pub}/fixture/mcp`;
const callback = 'https://vendor.example/oauth/callback';
const hit = async (url, jar, options = {}) => {
  const res = await fetch(url, { redirect: 'manual', ...options, headers: { ...(options.headers ?? {}), cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } });
  for (const header of res.headers.getSetCookie()) {
    const pair = header.split(';')[0], i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
};
try {
  initAsFiles(home, { publicUrl: pub, allowHttp: true });
  as = createAs({ dir: home, resource, allowHttp: true, workerNames: () => ['lark'] });
  as.ops.allowCallback({ pattern: callback }); as.ops.start({ worker: 'lark', minutes: 5 });
  const issuer = new URL(as.issuer);
  const discoveryResponse = await fetch(new URL(`/.well-known/oauth-authorization-server${issuer.pathname}`, issuer.origin));
  assert.equal(discoveryResponse.status, 200, 'authorization-server discovery failed');
  const discovery = await discoveryResponse.json();
  for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) assert.ok(discovery[endpoint].startsWith(`${issuer.href}/`));
  const register = async () => {
    const res = await fetch(discovery.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    assert.equal(res.status, 201); return (await res.json()).client_id;
  };
  const clientId = await register(), otherClient = await register();
  const verifier = randomBytes(32).toString('base64url'), jar = new Map();
  const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback, scope: 'dot-bridge.read', state: 'fixture', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource });
  const auth = await hit(`${discovery.authorization_endpoint}?${query}`, jar);
  assert.equal(auth.status, 303);
  const location = auth.headers.get('location');
  const page = await hit(pub + location, jar); assert.equal(page.status, 200);
  const code = (await page.text()).match(/class="code">([A-Z0-9-]+)</)?.[1];
  assert.ok(code, 'the real browser interaction produced a pairing');
  const pairing = as.store.pairingByCode(code), original = as.store.find('Interaction', pairing.uid);
  const grantsBefore = as.store.db.prepare("SELECT count(*) n FROM oidc WHERE model='Grant'").get().n;
  for (const change of [{ scope: 'dot-bridge.read t3.write' }, { resource: 'https://other.example/mcp' }, { client_id: otherClient }, { response_mode: 'form_post' }]) {
    as.store.upsert('Interaction', pairing.uid, { ...original, params: { ...original.params, ...change } }, 600);
    await assert.rejects(as.ops.approve({ code, worker: 'lark' }), /pending request changed or expired/, `changed ${Object.keys(change)[0]} was approved`);
    assert.equal(as.store.pairingByCode(code).state, 'pending', 'refusal did not consume or reserve the pairing');
    assert.equal(as.store.activeConnection('lark'), undefined, 'refusal created no connection');
    assert.equal(as.store.db.prepare("SELECT count(*) n FROM oidc WHERE model='Grant'").get().n, grantsBefore, 'refusal created no grant');
  }
  as.store.upsert('Interaction', pairing.uid, original, 600);
  await as.ops.approve({ code, worker: 'lark' });
  const completed = await hit(pub + location, jar); assert.equal(completed.status, 303);
  const resumed = await hit(completed.headers.get('location'), jar);
  const authorizationCode = new URL(resumed.headers.get('location')).searchParams.get('code');
  assert.ok(authorizationCode?.length > 0, 'unchanged request completed through the real provider');
  const tokens = await fetch(discovery.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code: authorizationCode, redirect_uri: callback, code_verifier: verifier, resource }) });
  assert.equal(tokens.status, 200);
  const issued = await tokens.json();
  assert.equal((await as.verifyBearer(`Bearer ${issued.access_token}`)).connection.worker, 'lark');
  console.log('PASS changed pairing scope/resource/client/response mode creates no grant; restored request exchanges a working token');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  as?.close(); fs.rmSync(home, { recursive: true, force: true });
}
