#!/usr/bin/env node
import http from 'node:http';
import { tmpdir } from 'node:os';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const repo = resolve(new URL('..', import.meta.url).pathname);
const home = await mkdtemp(join(tmpdir(), 'dalan-bridge-fake-'));
const threadId = '00000000-0000-4000-8000-000000000001';
let port;
const children = new Set();
let webhook;
const env = {
  ...fixtureEnv(home),
  HOME: home,
  DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1',
  DOT_BRIDGE_T3_DRY_RUN: '1',
  DOT_BRIDGE_RESUME_IDLE_MS: '0', // This fixture verifies the legacy duplicate-claim contract.
  DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1',
  DOT_BRIDGE_PORT: '0',
  PATH: `${join(home, 'bin')}:${fixtureEnv(home).PATH}`
};

function log(line) { console.log(line); }

function run(argv, input) {
  return new Promise((resolveRun) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function secretKey(secret) { return Buffer.from(secret.slice(6), 'base64'); }

function verifySignature(secret, headers, body) {
  const expected = createHmac('sha256', secretKey(secret)).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
  return headers['webhook-signature'] === `v1,${expected}`;
}

async function setupHome() {
  await mkdir(join(home, 'bin'), { recursive: true });
  await mkdir(join(home, '.config', 'dot-bridge'), { recursive: true });
  await writeFile(join(home, '.config', 'dot-bridge', 'limits.json'), JSON.stringify({ main_thread_ids: [threadId] }), { mode: 0o600 });
  await writeFile(join(home, 'bin', 't3code'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('read')) { console.error('metadata must use threads inspect'); process.exit(2); }
if (args.includes('inspect')) {
  console.log(JSON.stringify({ok:true, data:{runtime:{environmentId:"fake-environment"},thread:{id:"${threadId}",status:"active",deletedAt:null}}}));
  process.exit(0);
}
if (args.includes('send')) {
  let body = "";
  process.stdin.on("data", c => body += c);
  process.stdin.on("end", () => {
    console.log(JSON.stringify({ok:true, data:{argv: args, body}}));
  });
} else {
  console.log(JSON.stringify({ok:true,data:{}}));
}
`, { mode: 0o755 });
}

async function waitFor(predicate, label) {
  const start = Date.now();
  while (Date.now() - start < 7000) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startService() {
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  process.once('exit', () => child.kill('SIGTERM')); // never leave a test server running if the process dies early
  child.once('exit', () => children.delete(child));
  let ready = false, output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
    const match=output.match(/MCP listening on 127\.0\.0\.1:(\d+)/);
    if(match){port=Number(match[1]);ready=true;}
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => process.stderr.write(chunk));
  await waitFor(() => ready, 'service');
  return child;
}

async function stopService(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolveStop=>child.once('exit',resolveStop));
  const kill=setTimeout(()=>child.kill('SIGKILL'),2000);
  child.kill('SIGTERM');
  try{await exited;}finally{clearTimeout(kill);}
}

async function rpc(secret, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
  const response = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const text = await response.text();
  return JSON.parse(text);
}

async function main() {
  await setupHome();
  let service = await startService();
  const envText = await readFile(join(home, '.config', 'dot-bridge', 'env'), 'utf8');
  const secret = envText.match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const wrongPath = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert(wrongPath.status === 404, 'unguarded MCP path');
  const getMcp = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`);
  assert(getMcp.status === 405, 'GET must return 405');
  const notification = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert(notification.status === 202, 'notification must return 202');
  log('PASS path guard and MCP HTTP statuses');

  const webhookSecret = `whsec_${randomBytes(32).toString('base64')}`;
  const received = [];
  webhook = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert(verifySignature(webhookSecret, req.headers, body), 'bad webhook signature');
    const data = JSON.parse(body);
    if (data.type === 'verification') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ challenge: data.challenge }));
      return;
    }
    received.push({ headers: req.headers, data });
    res.writeHead(204).end();
  });
  await new Promise((resolveListen) => webhook.listen(0, '127.0.0.1', resolveListen));
  const webhookUrl = `http://127.0.0.1:${webhook.address().port}/hook`;

  const init = await rpc(secret, 'initialize', { protocolVersion: '2025-06-18' });
  assert(init.result.capabilities.tools && init.result.capabilities.events, 'initialize capabilities missing');
  const discover = await rpc(secret, 'server/discover', {});
  assert(discover.result.supportedVersions.includes('2026-07-28'), 'discover protocol mismatch');
  const initIcon=init.result.serverInfo.icons[0],discoverIcon=discover.result._meta['io.modelcontextprotocol/serverInfo'].icons[0];
  assert(initIcon.src===discoverIcon.src&&initIcon.mimeType==='image/png'&&initIcon.sizes.includes('128x128')&&Buffer.byteLength(initIcon.src)<=10000,'server icon missing or oversized');
  const tools = await rpc(secret, 'tools/list', {});
  assert(tools.result.tools.some((tool) => tool.name === 'claim'), 'claim tool missing');
  const events = await rpc(secret, 'events/list', {});
  assert(events.result.events[0].name === 'assignment.available', 'event missing');
  const sub = await rpc(secret, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: webhookUrl, secret: webhookSecret }, cursor: null });
  assert(sub.result.id && sub.result.truncated === false, 'subscription failed');
  log('PASS subscribe verification');

  const requestId = `req_${randomUUID()}`;
  const payload = { schema_version: 1, request_id: requestId, brief: 'Fake worker e2e tiny assignment', inputs: [], expected_output: 'one line', execution_scope: 'read-only' };
  const submit = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--json'], JSON.stringify(payload));
  assert(submit.code === 0, `submit failed ${submit.stderr}`);
  const dupSubmit = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--json'], JSON.stringify(payload));
  assert(JSON.parse(dupSubmit.stdout).duplicate === true, 'duplicate submit not idempotent');
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  const reorderedSubmit = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--json'], JSON.stringify(reordered));
  assert(JSON.parse(reorderedSubmit.stdout).duplicate === true, 'property order changed request identity');
  const conflictingSubmit = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--json'], JSON.stringify({ ...payload, brief: 'changed objective' }));
  assert(conflictingSubmit.code !== 0 && conflictingSubmit.stderr.includes('conflict'), 'changed duplicate submit was accepted');
  await waitFor(() => received.length === 1, 'assignment event');
  assert(received[0].data.name === 'assignment.available' && received[0].data.data.request_id === requestId, 'wrong event payload');
  log('PASS submit duplicate and signed event');

  const reviewId = `req_${randomUUID()}`;
  const reviewPayload = { schema_version: 1, request_id: reviewId, brief: 'Fake worker review submission', inputs: [], expected_output: 'findings', execution_scope: 'read-only' };
  const reviewSubmit = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--review', '--json'], JSON.stringify(reviewPayload));
  assert(reviewSubmit.code === 0, `review submit failed ${reviewSubmit.stderr}`);
  const reviewDup = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--review', '--json'], JSON.stringify(reviewPayload));
  assert(JSON.parse(reviewDup.stdout).duplicate === true, 'review retry not idempotent');
  const reviewNoFlag = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--json'], JSON.stringify(reviewPayload));
  assert(reviewNoFlag.code !== 0 && reviewNoFlag.stderr.includes('conflict'), 'duplicate submit without --review must conflict');
  const plainWithReview = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--review', '--json'], JSON.stringify(payload));
  assert(plainWithReview.code !== 0 && plainWithReview.stderr.includes('conflict'), 'duplicate submit with --review of a plain request must conflict');
  const reviewGet = JSON.parse((await run([process.execPath, 'bin/dalan.mjs', 'get', reviewId, '--json'])).stdout);
  assert(reviewGet.review === true && !('review' in reviewGet.assignment), 'owner get must show review:true outside the assignment payload');
  const plainGet = JSON.parse((await run([process.execPath, 'bin/dalan.mjs', 'get', requestId, '--json'])).stdout);
  assert(plainGet.review === false, 'plain request must show review:false');
  log('PASS review submission flag');

  const mainId = `req_${randomUUID()}`;
  const mainPayload = { schema_version: 1, request_id: mainId, brief: 'Main thread guard', inputs: [], expected_output: 'one line', execution_scope: 'read-only' };
  const mainDenied = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--json'], JSON.stringify(mainPayload));
  assert(mainDenied.code !== 0 && mainDenied.stderr.includes('protected T3 destination'), 'main thread submit without --allow-main was accepted');
  const mainAllowed = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--json'], JSON.stringify(mainPayload));
  assert(mainAllowed.code === 0 && JSON.parse(mainAllowed.stdout).duplicate === false, `main thread submit with --allow-main failed ${mainAllowed.stderr}`);
  const mainRetry = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--thread', threadId, '--stdin', '--allow-main', '--json'], JSON.stringify(mainPayload));
  assert(mainRetry.code === 0 && JSON.parse(mainRetry.stdout).duplicate === true, 'receipt retry of an accepted main-thread request must keep working');
  const direct = await new Promise((resolveDirect, rejectDirect) => {
    const bytes = JSON.stringify({ delivery: `t3:${threadId}`, assignment: { ...mainPayload, request_id: `req_${randomUUID()}` }, owner_token: randomBytes(32).toString('hex') });
    const req = http.request({ socketPath: join(home, '.local', 'share', 'dot-bridge', 'admin.sock'), path: '/submit', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } }, (res) => { let out = ''; res.on('data', (b) => { out += b; }); res.on('end', () => resolveDirect({ status: res.statusCode, body: out })); });
    req.on('error', rejectDirect); req.end(bytes);
  });
  assert(direct.status === 400 && direct.body.includes('protected T3 destination'), 'admin /submit must enforce main_thread_ids without the CLI');
  assert(!mainDenied.stderr.includes('--allow-main') && !direct.body.includes('--allow-main'), 'protected destination error suggests an override');
  log('PASS main_thread_ids guard');
  // The remaining journey exercises explicit delivery to an unprotected thread.
  await writeFile(join(home, '.config', 'dot-bridge', 'limits.json'), JSON.stringify({ main_thread_ids: [] }), { mode: 0o600 });

  await stopService(service);
  service = await startService();
  const pending = await rpc(secret, 'tools/call', { name: 'list_pending', arguments: {} });
  assert(JSON.parse(pending.result.content[0].text).assignments.some((item) => item.request_id === requestId), 'pending did not survive restart');
  log('PASS restart survival');

  const claim = await rpc(secret, 'tools/call', { name: 'claim', arguments: { request_id: requestId, claimant: 'fake-worker' } });
  const claimData = JSON.parse(claim.result.content[0].text);
  const dupClaim = await rpc(secret, 'tools/call', { name: 'claim', arguments: { request_id: requestId, claimant: 'fake-worker' } });
  assert(JSON.parse(dupClaim.result.content[0].text).duplicate === true, 'duplicate claim not idempotent');
  const rivalClaim = await rpc(secret, 'tools/call', { name: 'claim', arguments: { request_id: requestId, claimant: 'other-worker' } });
  assert(rivalClaim.result.isError, 'rival claim was accepted');
  await rpc(secret, 'tools/call', { name: 'progress', arguments: { request_id: requestId, claim_id: claimData.claim_id, note: 'fake worker is working' } });
  const finish = await rpc(secret, 'tools/call', { name: 'finish', arguments: { request_id: requestId, claim_id: claimData.claim_id, outcome: 'completed', summary: 'fake worker completed one-line result', result: 'one-line result' } });
  const finishData = JSON.parse(finish.result.content[0].text);
  const dupFinish = await rpc(secret, 'tools/call', { name: 'finish', arguments: { request_id: requestId, claim_id: claimData.claim_id, outcome: 'completed', summary: 'fake worker completed one-line result', result: 'one-line result' } });
  assert(JSON.parse(dupFinish.result.content[0].text).receipt_id === finishData.receipt_id, 'duplicate finish changed receipt');
  const changedFinish = await rpc(secret, 'tools/call', { name: 'finish', arguments: { request_id: requestId, claim_id: claimData.claim_id, outcome: 'completed', summary: 'changed summary', result: 'one-line result' } });
  assert(changedFinish.result.isError, 'contradictory finish was accepted');
  log('PASS claim progress finish duplicates');

  await waitFor(async () => {
    const get = await run([process.execPath, 'bin/dalan.mjs', 'get', requestId, '--json']);
    const data = JSON.parse(get.stdout);
    return data.delivery.some((item) => item.kind === 't3' && item.state === 'delivered' && item.argv?.includes('threads'));
  }, 'dry-run T3 delivery');
  log('PASS dry-run T3 argv recorded');

  await stopService(service);
  await new Promise(resolve=>webhook.close(resolve));
  webhook=undefined;
  assert(existsSync(join(home, '.local', 'share', 'dot-bridge', 'bridge.db')), 'db missing');
  log('PASS fake-worker e2e');
}

// An error thrown inside an HTTP listener bypasses main's catch; fail the run and let the exit hook stop the server.
process.on('unhandledRejection', error => { console.error(`FAIL ${error?.message ?? error}`); process.exit(1); });
try { await main(); }
catch(error) { console.error(`FAIL ${error.message}`); process.exitCode=1; }
finally {
  await Promise.all([...children].map(stopService));
  if(webhook){webhook.closeAllConnections();await new Promise(resolve=>webhook.close(resolve));}
  await rm(home,{recursive:true,force:true});
}
