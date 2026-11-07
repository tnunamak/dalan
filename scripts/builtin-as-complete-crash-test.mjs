#!/usr/bin/env node
// Crash recovery of the browser's completion step. A real provider, adapter and HTTP listener run in this process. A test-only
// hook fails one write of the completion, and the same browser then retries the same interaction. The retry must finish the
// OAuth flow for the connection the owner already approved, without a second approval or a second connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { initAsFiles } from '../src/as-files.mjs';
import { createAs } from '../src/as.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'dbcomplete-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
const port = await reservedPort();
const pub = `http://127.0.0.1:${port}`, resource = `${pub}/secret/mcp`, oauth = `${pub}/secret/oauth`, CALLBACK = 'https://vendor.example/oauth/callback';
const dir = path.join(root, 'cfg');
initAsFiles(dir, { publicUrl: pub, allowHttp: true });
let offset = 0;
const makeAs = () => createAs({ dir, resource, allowHttp: true, now: () => Date.now() + offset, workerNames: () => ['lark', 'duet'] });
let as = makeAs();
as.ops.allowCallback({ pattern: CALLBACK });
const server = http.createServer(async (req, res) => { if (!as.hostOk(req)) { res.writeHead(421); res.end(); return; } if (!(await as.handle(req, res))) { res.writeHead(404); res.end(); } });
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

const failures = [];
async function check(id, name, fn) { try { await fn(); console.log(`PASS ${id} ${name}`); } catch (error) { failures.push(id); console.log(`FAIL ${id} ${name}: ${String(error.message ?? error).split('\n').slice(0, 3).join(' | ')}`); } }

const jarHeader = jar => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function hit(url, jar, opt = {}) {
  const res = await fetch(url, { redirect: 'manual', ...opt, headers: { ...(opt.headers ?? {}), ...(jar.size ? { cookie: jarHeader(jar) } : {}) } });
  for (const line of res.headers.getSetCookie()) { const [pair] = line.split(';'); const i = pair.indexOf('='); const v = pair.slice(i + 1); if (v === '') jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), v); }
  return res;
}
async function register() {
  const res = await fetch(`${oauth}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(res.status, 201); return (await res.json()).client_id;
}
async function begin(clientId) {
  const verifier = randomBytes(32).toString('base64url'), jar = new Map();
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: CALLBACK, scope: 'dot-bridge.read dot-bridge.work', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource });
  const res = await hit(`${oauth}/auth?${q}`, jar);
  const loc = res.headers.get('location'); assert.ok(loc?.startsWith('/secret/oauth/interaction/'), `auth gave ${res.status} ${loc}`);
  const page = await (await hit(pub + loc, jar)).text();
  return { jar, loc, verifier, code: page.match(/class="code">([A-Z0-9-]+)</)[1] };
}
async function finish(flow) {
  const done = await hit(pub + flow.loc, flow.jar); assert.equal(done.status, 303);
  const resume = await hit(done.headers.get('location'), flow.jar);
  return new URL(resume.headers.get('location')).searchParams.get('code');
}
const token = (clientId, fields) => fetch(`${oauth}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, ...fields }) }).then(async r => ({ status: r.status, body: await r.json() }));
async function connected(worker) {
  as.ops.stop(); as.ops.start({ worker, minutes: 5 });
  const clientId = await register(), flow = await begin(clientId);
  const approved = await as.ops.approve({ code: flow.code, worker, replace: true });
  const code = await finish(flow);
  return { clientId, flow, approved, code };
}

const connectionCount = () => as.store.db.prepare('SELECT count(*) n FROM connections').get().n;
const exchange = (clientId, flow, code) => token(clientId, { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: flow.verifier, resource });
const live = accessToken => as.verifyBearer(`Bearer ${accessToken}`).then(() => true, () => false);
async function approved(worker) {
  as.ops.stop(); as.ops.start({ worker, minutes: 5 });
  const clientId = await register(), flow = await begin(clientId);
  const approval = await as.ops.approve({ code: flow.code, worker, replace: true });
  return { clientId, flow, approval };
}
// Fail `target[method]` once: before it runs, or (after: true) after its write landed.
function failOnce(target, method, { after = false } = {}) {
  const original = target[method];
  let failed = 0;
  target[method] = function (...args) {
    if (failed) return original.apply(this, args);
    failed++;
    if (!after) throw new Error('injected crash');
    const out = original.apply(this, args);
    if (out && typeof out.then === 'function') return out.then(() => { throw new Error('injected crash'); });
    throw new Error('injected crash');
  };
  return () => { target[method] = original; return failed; };
}
async function recovers(c, label) {
  const before = connectionCount();
  const retry = await hit(pub + c.flow.loc, c.flow.jar);
  assert.equal(retry.status, 303, `${label}: retry of the interaction gave ${retry.status}`);
  const resume = await hit(retry.headers.get('location'), c.flow.jar);
  const code = new URL(resume.headers.get('location')).searchParams.get('code');
  assert.ok(code, `${label}: resume gave no code`);
  const issued = await exchange(c.clientId, c.flow, code);
  assert.equal(issued.status, 200, `${label}: code exchange gave ${issued.status}`);
  assert.equal(await live(issued.body.access_token), true);
  assert.equal(connectionCount(), before, `${label}: a retry made another connection`);
  assert.equal(as.store.connectionByGrant(c.approval.grant_id).revoked_at, null);
  assert.equal(as.store.pairingByUid(new URL(pub + c.flow.loc).pathname.split('/').pop()).state, 'done');
  return { code, issued };
}

await check('C1', 'crash before interactionFinished persists: the retry finishes the approved connection', async () => {
  const c = await approved('lark');
  const restore = failOnce(as.provider, 'interactionFinished');
  const crashed = await hit(pub + c.flow.loc, c.flow.jar);
  assert.equal(restore(), 1, 'the hook did not fire');
  assert.equal(crashed.status, 500);
  await recovers(c, 'C1');
});
await check('C2', 'crash after interactionFinished persists but before the pairing is marked done: the retry finishes', async () => {
  const c = await approved('lark');
  const restore = failOnce(as.store, 'finishPairing');
  const crashed = await hit(pub + c.flow.loc, c.flow.jar);
  assert.equal(restore(), 1, 'the hook did not fire');
  assert.ok(crashed.status === 303 || crashed.status === 500, `status ${crashed.status}`);
  // A crashed process never sent the redirect; an in-process failure may have. Either way the same interaction can be retried
  // as long as the browser has not followed the resume redirect yet.
  await recovers(c, 'C2');
});
await check('C3', 'duplicate completion after success is a no-op: no second code, no second connection, token stays live', async () => {
  const c = await approved('lark');
  const first = await hit(pub + c.flow.loc, c.flow.jar); assert.equal(first.status, 303);
  const code = new URL((await hit(first.headers.get('location'), c.flow.jar)).headers.get('location')).searchParams.get('code');
  const issued = await exchange(c.clientId, c.flow, code); assert.equal(issued.status, 200);
  const before = connectionCount();
  const again = await hit(pub + c.flow.loc, c.flow.jar);
  assert.ok([400, 410].includes(again.status), `duplicate completion gave ${again.status}`);
  assert.ok(!again.headers.get('location'), 'a duplicate completion redirected');
  assert.equal(connectionCount(), before);
  assert.equal(await live(issued.body.access_token), true);
});
await check('C4', 'two concurrent completions of one interaction give exactly one usable code', async () => {
  const c = await approved('lark');
  const both = await Promise.all([hit(pub + c.flow.loc, c.flow.jar), hit(pub + c.flow.loc, c.flow.jar)]);
  const redirects = both.filter(r => r.status === 303);
  assert.ok(redirects.length >= 1);
  const codes = [];
  for (const r of redirects) {
    const resume = await hit(r.headers.get('location'), c.flow.jar);
    const code = new URL(resume.headers.get('location') ?? 'http://x/').searchParams.get('code');
    if (code) codes.push(code);
  }
  assert.equal(codes.length, 1, `codes issued: ${codes.length}`);
  assert.equal((await exchange(c.clientId, c.flow, codes[0])).status, 200);
});
await check('C5', 'a revoked approval is not completed on retry', async () => {
  const c = await approved('lark');
  const restore = failOnce(as.provider, 'interactionFinished');
  await hit(pub + c.flow.loc, c.flow.jar); restore();
  as.ops.revoke({ worker: 'lark' });
  const retry = await hit(pub + c.flow.loc, c.flow.jar);
  assert.equal(retry.status, 409);
  assert.ok(!retry.headers.get('location'));
});

server.close(); as.close();
console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nRESULT {"PASS":5}');
process.exit(failures.length ? 1 : 0);
