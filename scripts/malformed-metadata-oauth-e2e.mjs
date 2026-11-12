#!/usr/bin/env node
// Reproduce and guard against metadata enrichment stranding an OAuth-authenticated claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';
import './runtime-loopback-guard.mjs';

process.umask(0o077);
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const guard = path.join(repoRoot, 'scripts/runtime-loopback-guard.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
const bridges = [];
const callback = 'https://metadata-vendor.example/callback';
const diagnostic = 'invalid check metadata';
const excerpt = 'MALFORMED_METADATA_MUST_NOT_LEAK';
const id = () => `req_${randomUUID()}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const must = (value, message) => assert.ok(value, message);
const cleanText = value => value || '(none)';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function sql(file, query, ...args) {
  const db = new DatabaseSync(file);
  try {
    const statement = db.prepare(query);
    return /^\s*select/i.test(query) ? statement.all(...args) : statement.run(...args);
  } finally { db.close(); }
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

class Bridge {
  constructor() {
    this.home = path.join(root, 'bridge');
    this.config = path.join(this.home, '.config/dot-bridge');
    bridges.push(this);
  }

  async init() {
    this.port = await freePort();
    this.url = `http://127.0.0.1:${this.port}`;
    this.env = fixtureEnv(this.home, {
      DOT_BRIDGE_RESUME_IDLE_MS: '0', // Metadata cases retain the legacy identical-claim retry contract.
      NODE_ENV: 'test',
      NODE_OPTIONS: `--import=${guard}`,
      DOT_BRIDGE_AUTH_MODE: 'builtin',
      DOT_BRIDGE_TEST_OAUTH: '1',
      DOT_BRIDGE_ENABLE_WORKSPACE: '1',
      DOT_BRIDGE_MIN_FREE_BYTES: '0',
      DOT_BRIDGE_PORT: String(this.port),
      DOT_BRIDGE_WORKSPACE_ROOT: path.join(this.home, 'work'),
    });
    fs.mkdirSync(this.config, { recursive: true });
    fs.writeFileSync(path.join(this.config, 'workers.json'), JSON.stringify({ workers: { dot: {workspaceAllowed:true,repos:['test/runtime']}, lark: {workspaceAllowed:true,repos:['test/runtime']} } }), { mode: 0o600 });
    const initialized = this.cli(['as-init', '--public-url', this.url]);
    must(initialized.code === 0, 'as-init failed');
    const secret = randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(this.config, 'env'), `BRIDGE_PATH_SECRET=${secret}\n`, { mode: 0o600 });
    this.resource = `${this.url}/${secret}/mcp`;
    this.oauth = `${this.url}/${secret}/oauth`; // the built-in AS lives under the secret prefix
    return this;
  }

  cli(args, input) {
    const result = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], {
      cwd: repoRoot, env: this.env, input, encoding: 'utf8', timeout: 30000,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async start() {
    let ready = false;
    this.child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: repoRoot, env: this.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stdout.on('data', chunk => {
      if (String(chunk).includes(`MCP listening on 127.0.0.1:${this.port}`)) ready = true;
    });
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    for (let i = 0; i < 200 && !ready && this.child.exitCode === null; i++) await delay(25);
    return ready;
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const done = once(this.child, 'exit');
    this.child.kill('SIGTERM');
    await done;
  }

  db(query, ...args) {
    return sql(path.join(this.home, '.local/share/dot-bridge/bridge.db'), query, ...args);
  }

  submit(execution, baseSha) {
    const requestId = id();
    const assignment = {
      schema_version: 1,
      request_id: requestId,
      brief: 'Review the malformed-metadata fixture and report the result.',
      inputs: [{ github_repo: 'test/runtime', base_sha: baseSha }],
      scope_paths: ['hello.txt'],
      expected_output: 'A report for owner review',
      execution_scope: 'implementation',
    };
    const result = this.cli([
      'submit', '--stdin', '--json', '--worker', 'dot', '--execution', execution,
    ], JSON.stringify(assignment));
    assert.equal(result.code, 0, `${execution} submit failed (details withheld)`);
    return requestId;
  }

  async rpc(access, method, params = {}) {
    const response = await fetch(this.resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async tool(access, name, args = {}) {
    const response = await this.rpc(access, 'tools/call', { name, arguments: args });
    if (response.status !== 200 || response.body?.error || response.body?.result?.isError) {
      return {
        ok: false,
        error: response.body?.error?.message ?? response.body?.result?.content?.[0]?.text,
      };
    }
    return { ok: true, value: JSON.parse(response.body.result.content[0].text) };
  }
}

class Vendor {
  constructor(bridge) { this.bridge = bridge; this.cookies = new Map(); }

  async register() {
    // Built-in DCR is accepted only inside an owner pairing window (exposure hardening).
    must(this.bridge.cli(['connect', 'stop', '--json']).code === 0, 'closing pairing window failed');
    must(this.bridge.cli(['connect', 'start', '--worker', 'dot', '--json']).code === 0, 'pairing window failed');
    const response = await fetch(`${this.bridge.oauth}/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [callback],
        client_name: 'Malformed metadata fixture',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, 'OAuth client registration failed');
    this.client = body.client_id;
  }

  async hit(url) {
    must(new URL(url).origin === this.bridge.url, 'attempted to follow external redirect');
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }

  async connect() {
    // The pairing window opened in register() stays open: restarting it would purge the unapproved client.
    const { verifier, challenge } = pkce();
    const params = new URLSearchParams({
      client_id: this.client,
      response_type: 'code',
      redirect_uri: callback,
      scope: 'dot-bridge.read dot-bridge.work',
      resource: this.bridge.resource,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: randomUUID(),
    });
    const auth = await this.hit(`${this.bridge.oauth}/auth?${params}`);
    let location = auth.headers.get('location');
    must(location?.includes('/oauth/interaction/'), 'OAuth authorization did not reach owner pairing');
    const page = await this.hit(this.bridge.url + location);
    const pairing = (await page.text()).match(/class="code">([A-Z0-9-]+)</)?.[1];
    must(pairing, 'pairing code was missing');
    must(this.bridge.cli(['connect', 'approve', pairing, '--worker', 'dot', '--replace', '--json']).code === 0, 'owner approval failed');
    const resume = await this.hit(this.bridge.url + location);
    assert.equal(resume.status, 303, 'owner-approved flow did not redirect');
    const done = await this.hit(new URL(resume.headers.get('location'), this.bridge.url).href);
    const callbackUrl = new URL(done.headers.get('location'));
    assert.equal(callbackUrl.origin, new URL(callback).origin, 'OAuth flow used the wrong callback');
    const code = callbackUrl.searchParams.get('code');
    must(code, 'authorization code was missing');
    const tokenResponse = await fetch(`${this.bridge.oauth}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.client,
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
        code_verifier: verifier,
        resource: this.bridge.resource,
      }),
    });
    const token = await tokenResponse.json();
    assert.equal(tokenResponse.status, 200, 'OAuth code exchange failed');
    must(token.access_token, 'OAuth access token missing');
    return token.access_token;
  }
}

function assertDiagnostic(value, label) {
  assert.deepEqual(value.available_checks, [], `${label}: malformed metadata advertised a check`);
  assert.equal(value.available_checks_error, diagnostic, `${label}: missing sanitized diagnostic`);
  assert.ok(!JSON.stringify(value).includes(excerpt), `${label}: metadata excerpt leaked`);
}

async function recoverBaselineFailure(bridge, access, requestId, claimant, claimError) {
  const claimRow = bridge.db("SELECT claim_id FROM claims WHERE request_id=? AND state='active'", requestId)[0];
  const retry = await bridge.tool(access, 'claim', { request_id: requestId, claimant });
  const workerGet = await bridge.tool(access, 'get', { request_id: requestId });
  const workspace = claimRow
    ? await bridge.tool(access, 'workspace_result', { request_id: requestId, claim_id: claimRow.claim_id })
    : null;
  const finish = claimRow
    ? await bridge.tool(access, 'finish', {
      request_id: requestId,
      claim_id: claimRow.claim_id,
      outcome: 'completed',
      summary: 'test report',
      result: 'test result',
    })
    : null;
  const owner = bridge.cli(['get', requestId, '--json']);
  const status = bridge.db('SELECT status FROM assignments WHERE request_id=?', requestId)[0]?.status;
  console.log(`STUCK ${requestId}: status=${status}; claim_id_delivered=false; claim=${cleanText(claimError)}; retry=${cleanText(retry.error)}; get=${cleanText(workerGet.error)}; workspace_result=${cleanText(workspace?.error)}; finish=${cleanText(finish?.error)}; owner_get_exit=${owner.code}`);
  // Release only the isolated test fixture so the next execution mode can reproduce independently.
  bridge.db("UPDATE claims SET state='abandoned',abandoned_at=?,abandon_reason='test_cleanup' WHERE request_id=?", new Date().toISOString(), requestId);
  bridge.db("UPDATE assignments SET status='queued' WHERE request_id=?", requestId);
}

async function runNonHost(bridge, access, execution, baseSha) {
  const requestId = bridge.submit(execution, baseSha);
  const claimant = `fixture-${execution}`;
  const claim = await bridge.tool(access, 'claim', { request_id: requestId, claimant });
  if (!claim.ok) {
    await recoverBaselineFailure(bridge, access, requestId, claimant, claim.error);
    assert.fail(`${execution} claim failed after being committed`);
  }
  must(claim.value.claim_id, `${execution} claim_id missing`);
  assertDiagnostic(claim.value, `${execution} claim`);

  const retry = await bridge.tool(access, 'claim', { request_id: requestId, claimant });
  must(retry.ok, `${execution} identical claim retry failed`);
  assert.equal(retry.value.claim_id, claim.value.claim_id, `${execution} retry changed claim_id`);
  assertDiagnostic(retry.value, `${execution} retry`);

  const current = await bridge.tool(access, 'get', { request_id: requestId });
  must(current.ok, `${execution} worker get failed`);
  assertDiagnostic(current.value, `${execution} get`);

  const workspace = await bridge.tool(access, 'workspace_result', {
    request_id: requestId, claim_id: claim.value.claim_id,
  });
  must(workspace.ok, `${execution} workspace_result failed`);
  assertDiagnostic(workspace.value, `${execution} workspace_result`);

  const finish = await bridge.tool(access, 'finish', {
    request_id: requestId,
    claim_id: claim.value.claim_id,
    outcome: 'completed',
    summary: 'Malformed check metadata was reported.',
    result: 'The worker completed the assignment without host checks.',
  });
  must(finish.ok, `${execution} finish failed`);

  const owner = bridge.cli(['get', requestId, '--json']);
  assert.equal(owner.code, 0, `${execution} owner get failed`);
  const ownerResult = JSON.parse(owner.stdout);
  assertDiagnostic(ownerResult, `${execution} owner get`);
  assertDiagnostic(ownerResult.report.workspace_evidence, `${execution} finish snapshot`);
  assert.equal(bridge.db('SELECT status FROM assignments WHERE request_id=?', requestId)[0].status, 'finished');
  console.log(`PASS execution=${execution}: submit → claim/retry/get/workspace_result/snapshot/finish → owner get`);
}

async function runHost(bridge, access, baseSha) {
  // Submit through the supported non-host path, then model an already-stored host job whose pinned
  // metadata became unreadable after admission. Normal host admission remains strict.
  const requestId = bridge.submit('none', baseSha);
  bridge.db("UPDATE assignments SET execution='host' WHERE request_id=?", requestId);
  const claim = await bridge.tool(access, 'claim', { request_id: requestId, claimant: 'fixture-host' });
  if (!claim.ok) {
    await recoverBaselineFailure(bridge, access, requestId, 'fixture-host', claim.error);
    assert.fail('host claim failed after being committed');
  }
  must(claim.ok, 'host claim was lost during metadata enrichment');
  must(claim.value.claim_id, 'host claim_id missing');
  assertDiagnostic(claim.value, 'host claim');

  const current = await bridge.tool(access, 'get', { request_id: requestId });
  must(current.ok, 'host get failed');
  assertDiagnostic(current.value, 'host get');
  const workspace = await bridge.tool(access, 'workspace_result', {
    request_id: requestId, claim_id: claim.value.claim_id,
  });
  must(workspace.ok, 'host workspace_result failed');
  assertDiagnostic(workspace.value, 'host workspace_result');

  const check = await bridge.tool(access, 'run_check', {
    request_id: requestId, claim_id: claim.value.claim_id, check_id: 'default',
  });
  must(check.ok && check.value.status === 'capability_not_available', 'host check was not refused before metadata resolution');
  assert.match(check.value.reason, /resource_limits_unavailable|scope_paths_read_isolation_unavailable/);
  assert.equal(bridge.db('SELECT count(*) n FROM check_jobs WHERE request_id=?', requestId)[0].n, 0, 'refused host check started a job');
  assert.equal(bridge.db('SELECT count(*) n FROM check_runs WHERE request_id=?', requestId)[0].n, 0, 'host check wrote a receipt');

  const finish = await bridge.tool(access, 'finish', {
    request_id: requestId,
    claim_id: claim.value.claim_id,
    outcome: 'blocked',
    summary: 'Host check metadata is invalid.',
    result: 'No host check ran; the report records the blocker.',
  });
  must(finish.ok, 'host blocked finish failed');
  const owner = bridge.cli(['get', requestId, '--json']);
  assert.equal(owner.code, 0, 'host owner get failed');
  const ownerResult = JSON.parse(owner.stdout);
  assertDiagnostic(ownerResult, 'host owner get');
  assertDiagnostic(ownerResult.report.workspace_evidence, 'host finish snapshot');
  console.log('PASS execution=host: claim returned diagnostic; run_check remained fail-closed; blocked finish and owner get succeeded');
}

let bridge;
try {
  bridge = await new Bridge().init();
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: fixture, env: bridge.env, encoding: 'utf8' });
    assert.equal(result.status, 0, 'local git fixture operation failed');
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'metadata@example.invalid');
  git('config', 'user.name', 'Metadata fixture');
  fs.writeFileSync(path.join(fixture, 'hello.txt'), 'fixture\n');
  fs.writeFileSync(path.join(fixture, '.dot-bridge.json'), `{ this is invalid JSON; ${excerpt}`);
  git('add', '.');
  git('commit', '-qm', 'Malformed metadata fixture');
  const baseSha = git('rev-parse', 'HEAD');
  bridge.env.DOT_BRIDGE_GITHUB_URL_TEST_RUNTIME = fixture;
  must(await bridge.start(), 'bridge did not start on loopback');

  must(bridge.cli(['connect', 'allow-callback', callback]).code === 0, 'callback allowlist setup failed');
  const vendor = new Vendor(bridge);
  await vendor.register();
  const access = await vendor.connect();
  must((await bridge.tool(access, 'list_pending')).ok, 'OAuth positive control failed');

  const failures = [];
  for (const execution of ['none', 'worker']) {
    try { await runNonHost(bridge, access, execution, baseSha); }
    catch (error) { failures.push(`execution=${execution}: ${error.message}`); console.log(`FAIL execution=${execution}: ${error.message}`); }
  }
  try { await runHost(bridge, access, baseSha); }
  catch (error) { failures.push(`execution=host: ${error.message}`); console.log(`FAIL execution=host: ${error.message}`); }
  assert.deepEqual(failures, [], 'malformed metadata OAuth regression failed');
} finally {
  for (const active of bridges) await active.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
