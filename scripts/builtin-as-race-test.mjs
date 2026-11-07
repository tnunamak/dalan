#!/usr/bin/env node
// Deterministic overlap tests for the built-in authorization server. A real provider, adapter and HTTP listener run in this
// process, and test-only wrappers hold one side of a race until the other side has read or committed, so the interleaving is
// forced instead of hoped for. Each check fails if the guard it names is removed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { initAsFiles } from '../src/as-files.mjs';
import { createAs } from '../src/as.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'dbrace-'));
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
// Hold every reader of `model` after it has read, until `count` readers have read. Both then act on the same "unconsumed" snapshot.
function barrier(model, count) {
  const original = as.store.find.bind(as.store);
  let arrived = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const timer = setTimeout(release, 3000);
  as.store.find = (m, id) => {
    const row = original(m, id);
    if (m !== model || row?.consumed) return row;
    arrived++; if (arrived >= count) { clearTimeout(timer); release(); }
    return gate.then(() => row);
  };
  return { arrived: () => arrived, restore: () => { as.store.find = original; } };
}
const live = async (accessToken) => as.verifyBearer(`Bearer ${accessToken}`).then(() => true, () => false);

await check('R1', 'consume CAS: two code redemptions that both read "unconsumed" give at most one token, and replay revocation leaves none alive', async () => {
  const c = await connected('lark');
  const gate = barrier('AuthorizationCode', 2);
  const results = await Promise.all([1, 2].map(() => token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource })));
  gate.restore();
  assert.equal(gate.arrived(), 2, 'both redemptions must have read the unconsumed code');
  const wins = results.filter(r => r.status === 200);
  assert.ok(wins.length <= 1, `${wins.length} redemptions succeeded`);
  assert.equal(results.filter(r => r.status === 400 && r.body.error === 'invalid_grant').length, 2 - wins.length);
  for (const w of wins) assert.equal(await live(w.body.access_token), false, 'a token survived the replay revocation');
  assert.notEqual(as.store.connectionByGrant(c.approved.grant_id).revoked_at, null);
});
await check('G1', 'duplicate refresh returns the same live response', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  assert.equal(first.status, 200);
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const rotated = await token(c.clientId, request);
  const duplicate = await token(c.clientId, request);
  assert.equal(rotated.status, 200);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.body, rotated.body);
  assert.equal(await live(rotated.body.access_token), true);
});
await check('R2', 'concurrent duplicate refresh returns one live successor', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  assert.equal(first.status, 200);
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const results = await Promise.all([token(c.clientId, request), token(c.clientId, request)]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal(await live(results[0].body.access_token), true);
});
await check('G2', 'grace is absolute and replay after expiry revokes', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const rotated = await token(c.clientId, request); assert.equal(rotated.status, 200);
  offset = 4000; assert.equal((await token(c.clientId, request)).status, 200);
  offset = 6000; const replay = await token(c.clientId, request); offset = 0;
  assert.equal(replay.status, 400); assert.equal(replay.body.error, 'invalid_grant');
  assert.equal(await live(rotated.body.access_token), false);
});
await check('G3', 'ancestor reuse revokes after successor rotates', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const rotated = await token(c.clientId, request);
  const next = await token(c.clientId, { ...request, refresh_token: rotated.body.refresh_token }); assert.equal(next.status, 200);
  assert.equal((await token(c.clientId, request)).status, 400);
  assert.equal(await live(next.body.access_token), false);
});
await check('G4', 'receipt survives restart and contains no plaintext tokens', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const rotated = await token(c.clientId, request); assert.equal(rotated.status, 200);
  const row = as.store.db.prepare('SELECT * FROM refresh_receipts WHERE grant_id=?').get(c.approved.grant_id);
  assert.ok(row); assert.ok(!JSON.stringify(row).includes(rotated.body.refresh_token));
  assert.ok(!JSON.stringify(row).includes(rotated.body.access_token));
  as.close(); as = makeAs();
  const retry = await token(c.clientId, request); assert.equal(retry.status, 200); assert.deepEqual(retry.body, rotated.body);
});
await check('G5', 'failure before commit leaves original token usable', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const original = as.store.commitRefresh;
  as.store.commitRefresh = () => { throw new Error('injected failure'); };
  try { assert.equal((await token(c.clientId, request)).status, 500); } finally { as.store.commitRefresh = original; }
  assert.equal((await token(c.clientId, request)).status, 200);
});
await check('G6', 'owner revocation invalidates a cached response', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const rotated = await token(c.clientId, request); assert.equal(rotated.status, 200);
  as.ops.revoke({ worker: 'duet' });
  assert.equal((await token(c.clientId, request)).status, 400);
  assert.equal(await live(rotated.body.access_token), false);
});
await check('G7', 'wrong client and changed parameters cannot receive a receipt', async () => {
  for (const field of ['client', 'scope', 'resource']) {
    const c = await connected('duet');
    const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
    const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
    const rotated = await token(c.clientId, request); assert.equal(rotated.status, 200);
    let other = c.clientId, changed = request;
    if (field === 'client') other = await register();
    if (field === 'scope') changed = { ...request, scope: 'dot-bridge.read' };
    if (field === 'resource') changed = { ...request, resource: 'https://other.example/mcp' };
    const result = await token(other, changed);
    assert.notEqual(result.status, 200, field);
    assert.notEqual(result.body.refresh_token, rotated.body.refresh_token, field);
  }
});
await check('G8', 'transaction failure after staged consume rolls back', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const original = as.store.upsert;
  as.store.upsert = function(model, ...args) { if (model === 'AccessToken') throw new Error('injected write failure'); return original.call(this, model, ...args); };
  try { assert.equal((await token(c.clientId, request)).status, 500); } finally { as.store.upsert = original; }
  assert.equal((await token(c.clientId, request)).status, 200);
});
await check('G9', 'deadline reached during retry follows replay revocation', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const rotated = await token(c.clientId, request); assert.equal(rotated.status, 200);
  const original = as.provider.RefreshToken.find;
  let calls = 0;
  as.provider.RefreshToken.find = async function(...args) { const result = await original.apply(this, args); if (++calls === 2) offset = 6000; return result; };
  try { assert.equal((await token(c.clientId, request)).status, 400); } finally { as.provider.RefreshToken.find = original; offset = 0; }
  assert.equal(await live(rotated.body.access_token), false);
});
await check('G10', 'expired original token cannot retrieve a receipt', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  const original = as.store.find('RefreshToken', first.body.refresh_token);
  original.exp = Math.floor(Date.now() / 1000) + 2;
  as.store.upsert('RefreshToken', first.body.refresh_token, original, 30 * 86400);
  const request = { grant_type: 'refresh_token', refresh_token: first.body.refresh_token };
  const rotated = await token(c.clientId, request); assert.equal(rotated.status, 200);
  const clock = Date.now; Date.now = () => clock() + 3000;
  try { assert.equal((await token(c.clientId, request)).status, 400); } finally { Date.now = clock; }
});
await check('G11', 'owner revocation during refresh cannot be undone by commit', async () => {
  const c = await connected('duet');
  const first = await token(c.clientId, { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, code_verifier: c.flow.verifier, resource });
  let arrived, release; const entered = new Promise(resolve => { arrived = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const original = as.provider.Grant.find;
  as.provider.Grant.find = async function(...args) { const grant = await original.apply(this, args); arrived(); await gate; return grant; };
  try {
    const pending = token(c.clientId, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token });
    await entered; as.ops.revoke({ worker: 'duet' }); release();
    assert.notEqual((await pending).status, 200);
    assert.notEqual(as.store.connectionByGrant(c.approved.grant_id).revoked_at, null);
  } finally { release(); as.provider.Grant.find = original; }
});
await check('R3', 'adapter level: the second consume of one row throws and revokes the grant', async () => {
  const c = await connected('lark');
  assert.ok(as.store.find('AuthorizationCode', c.code));
  as.store.consume('AuthorizationCode', c.code);
  assert.throws(() => as.store.consume('AuthorizationCode', c.code), error => error.error === 'invalid_grant');
  assert.notEqual(as.store.connectionByGrant(c.approved.grant_id).revoked_at, null);
});
await check('R4', 'pairing reservation: two approvals of one code, the second held until the first commits, give exactly one connection', async () => {
  as.ops.stop(); as.ops.start({ worker: 'lark', minutes: 5 });
  const clientId = await register(), flow = await begin(clientId);
  const before = as.store.db.prepare('SELECT count(*) n FROM connections').get().n;
  const original = as.provider.Client.find.bind(as.provider.Client);
  let calls = 0, firstDone; const gate = new Promise(resolve => { firstDone = resolve; });
  as.provider.Client.find = async (...args) => { const mine = ++calls; const client = await original(...args); if (mine === 2) await gate; return client; };
  try {
    const first = as.ops.approve({ code: flow.code, worker: 'lark', replace: true });
    const second = as.ops.approve({ code: flow.code, worker: 'lark', replace: true });
    const a = await first.then(() => 'ok', e => e.message); firstDone();
    const b = await second.then(() => 'ok', e => e.message);
    assert.equal(calls, 2, 'the hook did not see both approvals');
    assert.deepEqual([a, b].filter(x => x === 'ok').length, 1, `outcomes: ${a} / ${b}`);
  } finally { as.provider.Client.find = original; }
  assert.equal(as.store.db.prepare('SELECT count(*) n FROM connections').get().n - before, 1, 'more than one connection was created for one code');
  assert.equal(as.store.db.prepare("SELECT count(*) n FROM connections WHERE revoked_at IS NULL AND client_id=?").get(clientId).n, 1);
});
await check('R5', 'worker check: a code pending for lark cannot be approved as duet after the window moved to duet', async () => {
  as.ops.stop(); as.ops.start({ worker: 'lark', minutes: 5 });
  const clientId = await register(), flow = await begin(clientId);
  // The window moves without `connect start` (which would purge this attempt): the worker check must hold on its own.
  as.store.closeWindow(); as.store.openWindow('duet', 5);
  await assert.rejects(as.ops.approve({ code: flow.code, worker: 'duet', replace: true }), /belongs to worker lark/);
  assert.equal(as.store.pairingByCode(flow.code).state, 'pending');
});

await check('R6', 'a code that a newer attempt superseded while its approval was running is refused, and the newer one can be approved', async () => {
  as.ops.stop(); as.ops.start({ worker: 'lark', minutes: 5 });
  const older = await begin(await register());
  const connectionsBefore = as.store.db.prepare('SELECT count(*) n FROM connections').get().n;
  const original = as.provider.Client.find.bind(as.provider.Client);
  let reached, release; const held = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // The approval has passed every read-only check when it stops here; the newer attempt then registers before it writes.
  as.provider.Client.find = async (...args) => { const client = await original(...args); reached(); await gate; return client; };
  let newer;
  try {
    const approving = as.ops.approve({ code: older.code, worker: 'lark', replace: true });
    const outcome = approving.then(() => 'approved', error => error.message);
    await held;
    as.provider.Client.find = original;
    newer = await begin(await register());
    assert.equal(as.ops.pending().pending.find(p => p.code === older.code).superseded, true, 'the older attempt is superseded before it writes');
    release();
    assert.match(await outcome, /superseded by a newer attempt/);
  } finally { as.provider.Client.find = original; release(); }
  assert.equal(as.store.pairingByCode(older.code).state, 'pending', 'the refused attempt was not consumed');
  assert.equal(as.store.db.prepare('SELECT count(*) n FROM connections').get().n, connectionsBefore, 'no connection was made for the superseded code');
  assert.equal((await as.ops.approve({ code: newer.code, worker: 'lark', replace: true })).approved, true);
});

server.close(); as.close();
console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nRESULT {"PASS":6}');
process.exit(failures.length ? 1 : 0);
