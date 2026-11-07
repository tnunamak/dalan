#!/usr/bin/env node
// A fresh install works with T3 absent. HOME is new, PATH holds node, git and coreutils but no t3code, and workers.json
// (profile mode) names one generic worker w1. The real server, the real dot-worker CLI and an MCP-over-HTTP worker run one
// job and one cancel without any step needing T3, and no user-visible text talks about T3. Every check reports PASS/FAIL, so the
// same file can run against older code and show what it fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
// The admin socket is <HOME>/.local/share/dot-bridge/admin.sock and macOS allows 104 bytes: keep HOME short, and fall back to /tmp
// when the platform temp dir is long (macOS $TMPDIR under /var/folders is about 50 bytes, /var resolves to /private/var).
const sockTail = '/.local/share/dot-bridge/admin.sock';
const base = (() => { const dir = fs.realpathSync(os.tmpdir()); return Buffer.byteLength(path.join(dir, 'dbs3-xxxxxx') + sockTail) <= 90 ? dir : '/tmp'; })();
const root = fs.mkdtempSync(path.join(base, 'dbs3-'));
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}: ${String(error.message ?? error).split('\n').slice(0, 12).join(' | ')}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rid = label => `req_${label}_${randomUUID().slice(0, 8)}`;
const assignment = id => ({ schema_version: 1, request_id: id, brief: `Read-only review ${id}: summarize the change.`, inputs: [{ revision: 'abc' }], expected_output: 'one short result', execution_scope: 'read-only' });
const t3Words = /t3/i;

// A PATH with only what the bridge needs. t3code must not resolve in it.
const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
const realPath = process.env.PATH ?? '';
const which = name => { for (const dir of realPath.split(path.delimiter)) { const file = path.join(dir, name); try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {} } return null; };
for (const name of ['node', 'git', 'sh', 'env', 'cat', 'ls', 'rm', 'mkdir', 'cp', 'mv', 'ln', 'chmod', 'sleep', 'date', 'uname', 'tar', 'head', 'tail', 'sort', 'tr', 'wc', 'dirname', 'basename', 'sed', 'grep', 'awk', 'readlink', 'mktemp', 'id', 'df', 'stat', 'true', 'false']) {
  const file = name === 'node' ? process.execPath : which(name);
  if (file) fs.symlinkSync(file, path.join(bin, name));
}
const cleanPath = bin;
const resolves = name => spawnSync('/bin/sh', ['-c', `command -v ${name}`], { env: { PATH: cleanPath }, encoding: 'utf8' }).status === 0;

// Test IdP: one signing key, JWKS over loopback.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
const jwks = http.createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${jwks.address().port}/realm`, audience = 'https://dot-bridge.example.test';
const token = azp => {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 600, sub: 'owner', scope: 'dot-bridge.read dot-bridge.work', azp })).toString('base64url');
  return `${head}.${claims}.${sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url')}`;
};
const profile = (extra = {}) => ({ workers: { w1: { connections: [{ issuer, subject: 'owner', client_id: 'client-w1' }], ...extra } } });

// Start the real server with a fresh HOME. The environment is built from nothing: no T3 variable, no inherited PATH.
async function startServer(name, workers, { loaderGuard = false } = {}) {
  const home = path.join(root, name), config = path.join(home, '.config/dot-bridge');
  const t3Loads = path.join(root, `${name}-t3-loads.log`);
  const t3GuardDisabled = path.join(root, `${name}-disable-t3-loader-guard`);
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=${issuer.replace('/realm', '/jwks')}\nOAUTH_ALLOWED_SUBJECTS=owner\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify(workers), { mode: 0o600 });
  const env = { HOME: home, PATH: cleanPath, NODE_OPTIONS: process.env.NODE_OPTIONS, DALAN_PORT: '0', DALAN_AUTH_MODE: 'oauth', DALAN_TEST_OAUTH: '1', DALAN_ALLOW_PRIVATE_WEBHOOKS: '1', ...(loaderGuard ? { DALAN_TEST_T3_LOADS: t3Loads, DALAN_TEST_T3_GUARD_DISABLED: t3GuardDisabled } : {}), ...(name==='cap'?{DALAN_ENABLE_T3_TOOLS:'1'}:{}) };
  const args = [...(loaderGuard ? ['--experimental-loader', path.join(repo, 'scripts/test-support/no-t3-loads.mjs')] : []), 'src/server.mjs'];
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let port = null, stdout = '', stderr = '', exited = null;
  child.stdout.on('data', b => { stdout += b; const m = /MCP listening on 0\.0\.0\.0:(\d+)/.exec(String(b)); if (m) port = Number(m[1]); });
  child.stderr.on('data', b => { stderr += b; });
  child.once('exit', code => { exited = code; });
  for (let i = 0; i < 200 && port === null && exited === null; i++) await sleep(50);
  const server = { home, env, child, port, get exited() { return exited; }, get stderr() { return stderr; }, get stdout() { return stdout; } };
  server.stop = async () => { child.kill('SIGTERM'); if (exited === null) await new Promise(resolve => child.once('exit', resolve)); };
  if (port === null) return server;
  const secret = fs.readFileSync(path.join(config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  server.rpc = async (bearer, method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  server.tool = async (bearer, tool, args = {}) => {
    const { status, text, body } = await server.rpc(bearer, 'tools/call', { name: tool, arguments: args });
    if (status !== 200) return { ok: false, text, error: text };
    const out = body.result.content[0].text;
    return body.result.isError ? { ok: false, text: out, error: out } : { ok: true, text: out, value: JSON.parse(out) };
  };
  server.admin = (route, body) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path.join(home, '.local/share/dot-bridge/admin.sock'), method: 'POST', path: route, headers: { 'content-type': 'application/json' } }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.once('error', reject); request.end(JSON.stringify(body));
  });
  server.t3Loads = t3Loads;
  server.t3GuardDisabled = t3GuardDisabled;
  server.cli = (args, input) => { const r = spawnSync(process.execPath, ['bin/dalan.mjs', ...args], { cwd: repo, env, input, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  return server;
}

try {
  await check('the test PATH has node and git and no t3code, and no T3 env var reaches the server', async () => {
    assert.equal(resolves('t3code'), false, 't3code resolves in the test PATH');
    assert.equal(fs.existsSync(path.join(bin, 't3code')), false);
    assert.ok(resolves('node') && resolves('git'), 'node and git must resolve');
    const home = path.join(root, 'probe');
    assert.ok(!Object.keys({ HOME: home, PATH: cleanPath }).some(k => /t3/i.test(k)));
  });
  await check('the admin socket path fits the macOS 104-byte limit', () => {
    const socket = path.join(root, 'main') + sockTail;
    assert.ok(Buffer.byteLength(socket) < 104, `${socket} is ${Buffer.byteLength(socket)} bytes`);
  });

  const server = await startServer('main', profile(), { loaderGuard: true });
  try {
    await check('profile mode with no t3 worker starts with no t3code, T3 config or thread ids', () => {
      assert.notEqual(server.port, null, `server did not start: ${server.stderr}`);
      assert.equal(server.env.DALAN_ENABLE_T3_TOOLS, undefined, 'T3 tools setting must be unset');
      assert.doesNotMatch(server.stdout, /T3 tools enabled|t3code/i);
      assert.doesNotMatch(server.stderr, /t3code|ENOENT/i);
    });
    assert.notEqual(server.port, null, 'server did not start; later checks cannot run');
    const W = token('client-w1');
    const j1 = rid('job'), j2 = rid('cancel');

    await check('requester: a read-only job with quiet delivery targeted at w1 is accepted', () => {
      const r = server.cli(['submit', '--stdin', '--json', '--worker', 'w1'], JSON.stringify(assignment(j1)));
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(JSON.parse(r.stdout).duplicate ?? false, false);
    });

    await check('admin submit rejects explicit null and unknown delivery modes', async () => {
      for (const [suffix, delivery] of [['null', null], ['unknown', 'smtp:other']]) {
        const response = await server.admin('/submit', { assignment: assignment(rid(`bad-delivery-${suffix}`)), delivery, owner_token: `owner-${suffix}` });
        assert.equal(response.status, 400, JSON.stringify(response.body));
        assert.match(response.body.error, /invalid delivery/);
      }
    });

    await check('worker: tools/list has no t3_* tool and no notify_owner', async () => {
      const list = await server.rpc(W, 'tools/list');
      assert.equal(list.status, 200);
      const names = list.body.result.tools.map(t => t.name);
      for (const name of ['list_pending', 'claim', 'progress', 'finish', 'get']) assert.ok(names.includes(name), `missing ${name}`);
      assert.deepEqual(names.filter(n => /^t3_|^notify_owner$/.test(n)), []);
    });

    let claim;
    await check('worker: list_pending, claim, progress', async () => {
      const pending = await server.tool(W, 'list_pending');
      assert.ok(pending.ok, pending.error);
      assert.ok(pending.value.assignments.some(a => a.request_id === j1), pending.text);
      assert.doesNotMatch(pending.text, t3Words, 'list_pending talks about T3');
      claim = await server.tool(W, 'claim', { request_id: j1, claimant: 'w1' });
      assert.ok(claim.ok, claim.error);
      assert.doesNotMatch(claim.text, t3Words, 'claim response talks about T3');
      const progress = await server.tool(W, 'progress', { request_id: j1, claim_id: claim.value.claim_id, note: 'reading the change' });
      assert.ok(progress.ok, progress.error);
      assert.doesNotMatch(progress.text, t3Words, 'progress response talks about T3');
    });

    await check('owner note reaches the worker', async () => {
      const note = server.cli(['note', j1, 'please also check the tests', '--json']);
      assert.equal(note.code, 0, note.stderr + note.stdout);
      const got = await server.tool(W, 'get', { request_id: j1 });
      assert.ok(got.ok, got.error);
      assert.equal(got.value.owner_notes.length, 1);
      assert.match(JSON.stringify(got.value.owner_notes), /check the tests/);
      assert.doesNotMatch(got.text, t3Words, `get response talks about T3: ${got.text.match(/.{60}t3.{60}/i)?.[0]}`);
    });

    await check('owner reconcile --json carries no T3 field (thread_id, t3_muted) for a quiet job', async () => {
      const rec = server.cli(['reconcile', j1, '--json']);
      assert.equal(rec.code, 0, rec.stderr + rec.stdout);
      const keys = [], walk = v => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
      walk(JSON.parse(rec.stdout));
      assert.ok(keys.includes('assignment') && keys.includes('request_id'), 'reconcile output has the assignment');
      for (const k of ['thread_id', 't3_muted']) assert.ok(!keys.includes(k), `reconcile output has ${k}`);
    });

    await check('worker finishes; owner get --json names target_worker w1 and the finisher; wait returns the result', async () => {
      const finish = await server.tool(W, 'finish', { request_id: j1, claim_id: claim.value.claim_id, outcome: 'completed', summary: 'reviewed', result: 'looks fine, no T3 needed' });
      assert.ok(finish.ok, finish.error);
      assert.doesNotMatch(finish.text, /t3code|thread/i);
      const got = server.cli(['get', j1, '--json']);
      assert.equal(got.code, 0, got.stderr);
      const text = got.stdout, value = JSON.parse(text);
      assert.equal(value.target_worker, 'w1', text);
      assert.equal(value.status, 'finished');
      assert.equal(value.report?.worker, 'w1', 'the finishing worker is recorded');
      const waited = server.cli(['wait', j1, '--timeout', '20', '--json']);
      assert.equal(waited.code, 0, waited.stderr + waited.stdout);
      assert.equal(JSON.parse(waited.stdout).status, 'finished');
      assert.match(got.stdout, /looks fine/, 'owner get carries the worker result');
    });

    await check('fresh-process loader guard saw no T3 module during default startup or job completion', () => {
      assert.equal(fs.existsSync(server.t3Loads), false, fs.existsSync(server.t3Loads) ? fs.readFileSync(server.t3Loads, 'utf8') : '');
      fs.writeFileSync(server.t3GuardDisabled, 'allow explicit T3 delivery checks after the default-path assertion');
    });

    await check('cancel on a second job', async () => {
      const sub = server.cli(['submit', '--stdin', '--json', '--worker', 'w1'], JSON.stringify(assignment(j2)));
      assert.equal(sub.code, 0, sub.stderr + sub.stdout);
      const cancel = server.cli(['cancel', j2, '--reason', 'not needed', '--json']);
      assert.equal(cancel.code, 0, cancel.stderr + cancel.stdout);
      const got = server.cli(['get', j2, '--json']);
      assert.equal(JSON.parse(got.stdout).status, 'cancelled');
      const pending = await server.tool(W, 'list_pending');
      assert.ok(!pending.value.assignments.some(a => a.request_id === j2));
    });

    await check('--deliver t3:x is refused with a clear error and nothing is stored', async () => {
      const id = rid('t3');
      const r = server.cli(['submit', '--stdin', '--json', '--worker', 'w1', '--deliver', 't3:thread_abcdef'], JSON.stringify(assignment(id)));
      assert.notEqual(r.code, 0);
      assert.match(r.stderr + r.stdout, /t3code was not found on PATH/);
      assert.doesNotMatch(r.stderr + r.stdout, /ENOENT|spawn/);
      const missing = server.cli(['get', id, '--json']);
      assert.notEqual(missing.code, 0, 'a refused submit stored a job');
      const quiet = server.cli(['submit', '--stdin', '--json', '--worker', 'w1'], JSON.stringify(assignment(id)));
      assert.equal(quiet.code, 0, 'the same request id is free after the refusal: ' + quiet.stderr + quiet.stdout);
    });

    await check('dot-worker status stays T3-free and an unknown id reports its missing owner receipt', () => {
      const status = server.cli(['status']);
      assert.equal(status.code, 0, status.stderr);
      assert.doesNotMatch(status.stdout, /t3|thread/i, status.stdout);
      const explain = server.cli(['status', '--explain']);
      assert.equal(explain.code, 0, explain.stderr);
      assert.doesNotMatch(explain.stdout, /t3|thread/i, explain.stdout);
      const unknownId = 'req_unknown_00000000';
      const bad = server.cli(['get', unknownId, '--json']);
      assert.notEqual(bad.code, 0, 'unknown request unexpectedly succeeded');
      const error = JSON.parse(bad.stderr);
      assert.equal(error.kind, 'local');
      assert.equal(error.code, 'unknown_request', 'unknown id must report the missing owner receipt');
      assert.equal(error.error, `no job "${unknownId}" in this bridge home: ${server.home} has no receipt for it`, 'unknown id failed on something other than its owner receipt');
      assert.doesNotMatch(error.error.replace(server.home, '<home>'), /t3|thread/i);
    });
  } finally { await server.stop(); }

  await check('a worker with the t3 capability and no t3code fails startup with one clear line', async () => {
    const bad = await startServer('cap', profile({ capabilities: ['t3'] }));
    try {
      assert.equal(bad.port, null, 'the server started');
      if (bad.exited === null) await sleep(500);
      assert.ok(bad.exited !== null && bad.exited !== 0, `exit code ${bad.exited}`);
      const lines = bad.stderr.trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 1, `stderr was ${lines.length} lines: ${bad.stderr}`);
      assert.equal(lines[0], 'dalan: startup: worker w1 has capability t3 but t3code was not found on PATH; install T3 Code or remove the capability');
    } finally { await bad.stop(); }
  });
} finally {
  jwks.close();
  fs.rmSync(root, { recursive: true, force: true });
}
assert.equal(fs.existsSync(root), false, 'temp HOME was not removed');
if (failures.length) { console.log(`\n${failures.length} FAILED: ${failures.join('; ')}`); process.exit(1); }
console.log('\nt3-absent-e2e: all checks passed');
