#!/usr/bin/env node
import { reservedPort } from '../src/test-support/port.mjs';
// Regression coverage for prompt parsing, size refusals, untracked files, and delayed submissions.
// Pure steps use a temporary git repository; deadline steps run the adapter against a local bridge
// through a proxy that delays /submit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startAdapter } from './acp-client.mjs';
import { delegatePrompt, t3Instructions, t3TrailingBlocks } from './acp-t3-fixtures.mjs';
import * as bridge from '../src/acp-bridge.mjs';
const { prepareAssignment, repoInputs, promptText, parsePrompt, withoutNote, sizeRefusal, NO_REPO_NOTE, UNTRACKED_NOTE, Refusal, adminRequest, ownerToken, readOrCreateSecret } = bridge;
import { submissionLimits } from '../src/submission-policy.mjs';

const root = fs.mkdtempSync(join(tmpdir(), 'acp-fixture-')), originalHome = process.env.HOME;
process.env.HOME = join(root, 'home'); fs.mkdirSync(process.env.HOME);
const bytes = text => Buffer.byteLength(text), failures = [];
// Each step runs on its own so one failure does not hide the others; the exit code is non-zero if any step failed.
const step = async (label, fn) => {
  try { await fn(); console.log(`PASS fixture: ${label}`); }
  catch (e) { failures.push(label); console.log(`FAIL fixture: ${label}\n  ${String(e.message).split('\n').slice(0, 3).join('\n  ')}`); }
};
const bare = join(root, 'origin.git'), work = join(root, 'work');
const git = (...args) => { const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-C', work, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const write = (file, text) => { fs.mkdirSync(join(work, file, '..'), { recursive: true }); fs.writeFileSync(join(work, file), text); };
const options = { repoOf: () => 'example-org/example-repo' };
const prep = brief => prepareAssignment({ cwd: work, requestId: 'fixture_test_1', brief, validUntil: '2099-01-01T00:00:00Z' }, options);
let service, adapter, proxy;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(test, label, ms = 20000) { for (let t = 0; t < ms; t += 25) { if (await test()) return; await sleep(25); } throw new Error(`timed out waiting for ${label}`); }

try {
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  write('a.py', 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'base'); git('remote', 'add', 'origin', bare); git('push', '-qu', 'origin', 'main');
  const head = git('rev-parse', 'HEAD');

  // ---- F1: a T3 delegate_task prompt reduces to the request
  await step('T3 delegate_task envelope and trailing blocks are not in the brief', async () => {
    const task = '[dot-decision:fixture_envelope_1]\nReview the retry logic in the sync module and list the three riskiest paths.\n' + 'Detail line for the review. '.repeat(100);
    const prompt = delegatePrompt(task);
    const split = { t3Envelope: bytes(t3Instructions) + bytes(t3TrailingBlocks), requesterTask: bytes(task) };
    const text = promptText([{ type: 'text', text: prompt }]);
    const parsed = parsePrompt(text);
    assert.equal(parsed.brief, task.replace(/^\[.*\]\n/, '').trim(), 'brief is the request, nothing else');
    assert.equal(parsed.root, 'fixture_envelope_1');
    const sent = await prep(parsed.brief);
    assert.equal(sent.brief, parsed.brief, 'a clean pushed checkout adds nothing');
    console.log(`MEASURE synthetic prompt: ${bytes(prompt)} B total; ${split.t3Envelope} B envelope + ${split.requesterTask} B request`);
    assert.ok(bytes(sent.brief) < 4000);
    // the same prompt split in the two blocks T3 sends, and a plain-string prompt, give the same brief
    assert.equal(promptText([{ type: 'text', text: prompt.slice(0, prompt.indexOf('<runtime_info>')) }, { type: 'text', text: t3TrailingBlocks }]), text);
  });

  // ---- F2: size refusals say which part is over and by how much
  await step('oversize refusals name the request bytes, the added bytes, the limit and the bytes to cut', async () => {
    const big = 'é'.repeat(8300); // 16,600 bytes of request: over the brief limit on its own
    await assert.rejects(prep(big), e => e instanceof Refusal && e.message === `brief is 16,600 bytes: your request alone; the limit is 16,384; cut at least 216 bytes from your request`, 'request alone');
    // A synthetic request plus adapter context exceeds the brief limit.
    assert.equal(sizeRefusal('brief: 20000 UTF-8 bytes exceeds 16384; cut at least 3616 bytes', 4000), 'brief is 20,000 bytes: your request 4,000 + context added by the adapter and bridge 16,000; the limit is 16,384; cut at least 3,616 bytes from your request (pushing your local work drops the added context)');
    assert.match(sizeRefusal('task instructions: 25000 UTF-8 bytes exceeds 24576', 9000), /^task instructions \(brief, expected output and scope\) are 25,000 bytes: your request 9,000 \+ context added by the adapter and bridge 16,000; the limit is 24,576; cut at least 424 bytes/);
    assert.equal(sizeRefusal('invalid assignment', 5), null);
  });

  // ---- F3: untracked-only checkout pins HEAD
  await step('untracked-only checkout: repository input pinned to HEAD, brief notes that untracked files are not included', async () => {
    write('__pycache__/m.cpython-312.pyc', 'junk'); write('notes.txt', 'scratch\n');
    const untracked = await prep('Review the repository layout.');
    assert.deepEqual(untracked.inputs, [{ github_repo: 'example-org/example-repo', base_sha: head, head_sha: head }], 'repo input pinned to pushed HEAD');
    assert.equal(untracked.brief, `${UNTRACKED_NOTE}\n\nReview the repository layout.`);
    assert.equal(withoutNote(untracked.brief), 'Review the repository layout.', 'attach identity ignores the note');
    assert.ok(!untracked.brief.includes('dot-context') && !untracked.brief.includes('__pycache__'), 'untracked files are not packed');
    assert.equal(untracked.execution_scope, 'read-only');
  });

  await step('a tracked modification keeps the packed-diff behaviour', async () => {
    // ignored files do not matter either; a tracked change still packs a diff, with the untracked file included as before
    write('a.py', 'x = 2\n');
    const modified = await prep('Review the local change.');
    assert.match(modified.brief, /checkout is at pushed base/); assert.match(modified.brief, /\+x = 2/); assert.ok(!modified.brief.startsWith(UNTRACKED_NOTE));
    git('checkout', 'a.py');
  });

  await step('a build accepts untracked-only files (its patch applies to pushed HEAD) and refuses tracked changes', async () => {
    // builds: the patch applies to pushed HEAD, so untracked files cannot change it; the marker stays the first line
    const cfg = join(root, 'producer.json'); fs.writeFileSync(cfg, JSON.stringify({ repo_selection: { exclude: [] }, deny_path_terms: [] }));
    process.env.DOT_ACP_BUILD_OWNERS = 'example-org'; process.env.DOT_ACP_REPO_CONFIG = cfg;
    const build = await prep('[dot-build] a.py\nChange x to 3.');
    assert.equal(build.execution_scope, 'implementation'); assert.equal(build.inputs[0].base_sha, head); assert.ok(build.brief.startsWith('[dot-build] a.py'), 'no note before the build marker');
    write('a.py', 'x = 2\n');
    await assert.rejects(prep('[dot-build] a.py\nChange x to 3.'), /clean checkout/, 'tracked changes still refuse a build');
    git('checkout', 'a.py');
  });

  await step('a checkout with no commit still sends a text-only job', async () => {
    // text-only jobs are never refused for the state of the checkout
    const empty = join(root, 'empty'); fs.mkdirSync(empty); spawnSync('git', ['init', '-q', empty]); fs.writeFileSync(join(empty, 'u.txt'), 'x');
    const noCommit = await prepareAssignment({ cwd: empty, requestId: 'fixture_test_2', brief: 'Just answer.', validUntil: '2099-01-01T00:00:00Z' }, options);
    assert.deepEqual(noCommit.inputs, []); assert.ok(noCommit.brief.startsWith(NO_REPO_NOTE));
    assert.deepEqual((await repoInputs(join(root, 'does-not-exist'))).inputs, []);
  });
  git('clean', '-fdq');

  // ---- F4: submit deadline
  const home = process.env.HOME, repo = resolve(new URL('..', import.meta.url).pathname), port = Number(process.env.ACP_FIXTURE_PORT || await reservedPort());
  const env = { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_PORT: String(port) };
  fs.mkdirSync(join(home, '.config', 'dot-bridge'), { recursive: true });
  let ready = false;
  service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; }); service.stderr.on('data', b => process.stderr.write(b));
  await waitFor(() => ready, 'bridge');
  const adminSock = join(home, '.local/share/dot-bridge/admin.sock'), proxySock = join(root, 'proxy.sock');
  const secret = fs.readFileSync(join(home, '.config', 'dot-bridge', 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc = async (name, args) => { const r = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) }); return JSON.parse((await r.json()).result.content[0].text); };
  const rows = () => { const d = new DatabaseSync(join(home, '.local/share/dot-bridge/bridge.db'), { readOnly: true }); try { return d.prepare('SELECT request_id,status FROM assignments').all(); } finally { d.close(); } };
  // Forwards to the bridge. `holdRequest` delays the submit before the bridge sees it; `holdReply` delays the answer after the
  // bridge has stored the job (the client times out although the work happened).
  const delays = { holdRequest: 0, holdReply: 0 }; let submits = 0;
  proxy = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const submit = req.url === '/submit'; /* the adapter's dedicated preview is not a submit */ if (submit) submits++;
      const first = submit && submits === 1;
      if (first) await sleep(delays.holdRequest);
      const up = http.request({ socketPath: adminSock, path: req.url, method: req.method, headers: req.headers }, async r => {
        const out = []; r.on('data', c => out.push(c)); r.on('end', async () => { if (first) await sleep(delays.holdReply); res.writeHead(r.statusCode, r.headers); res.end(Buffer.concat(out)); });
      });
      up.on('error', () => res.destroy()); up.end(Buffer.concat(chunks));
    });
  });
  await new Promise(r => proxy.listen(proxySock, r));
  const startAgent = extra => startAdapter({ HOME: home, DOT_ACP_SOCKET: proxySock, DOT_ACP_HEARTBEAT_MS: '1000', ...extra }, work);
  const finishJob = async rid => { await waitFor(() => rows().some(r => r.request_id === rid && r.status === 'queued'), `${rid} queued`); const c = (await rpc('claim', { request_id: rid, claimant: 'fake-worker' })).claim_id; await rpc('finish', { request_id: rid, claim_id: c, outcome: 'completed', summary: 'done', result: 'RESULT ' + rid }); };

  await step('a 6 s submit succeeds within the submit deadline', async () => {
    // a submit that takes 6 s (over the 5 s read deadline) succeeds under the submit deadline
    delays.holdRequest = 6000; submits = 0;
    adapter = startAgent({}); await adapter.init();
    const s1 = (await adapter.newSession(work)).sessionId;
    const t0 = Date.now(), p1 = adapter.prompt(s1, '[dot-decision:fixture_slow_1]\nslow submit');
    await finishJob('fixture_slow_1');
    const r1 = await p1;
    assert.equal(r1.result?.stopReason, 'end_turn', JSON.stringify(r1)); assert.ok(Date.now() - t0 > 5500, 'the submit really took longer than 5 s');
    assert.equal(adapter.text('agent_message_chunk'), 'RESULT fixture_slow_1'); assert.equal(rows().length, 1);
    adapter.kill('SIGKILL');
  });

  await step('a submit that timed out after storing the job is retried by request id without a second job', async () => {
    // a submit that times out after the bridge stored the job: the retry attaches to the same row (one job, one receipt)
    delays.holdRequest = 0; delays.holdReply = 6000; submits = 0;
    adapter = startAgent({ DOT_ACP_SUBMIT_DEADLINE_MS: '1000' }); await adapter.init();
    const s2 = (await adapter.newSession(work)).sessionId, p2 = adapter.prompt(s2, '[dot-decision:fixture_retry_1]\nretry me');
    await finishJob('fixture_retry_1');
    const r2 = await p2;
    assert.equal(r2.result?.stopReason, 'end_turn', JSON.stringify(r2)); assert.equal(rows().filter(r => r.request_id.startsWith('fixture_retry_1')).length, 1, 'exactly one job after a timed-out submit and its retry');
    assert.equal(submits, 1, 'the retry attached to the stored row and did not submit again');
    adapter.kill('SIGKILL');
  });

  await step('the bridge answers a repeated submit with the same job', async () => {
    // the bridge itself: the same submit twice is one job
      const token = ownerToken(readOrCreateSecret(join(home, '.config/dot-bridge/acp-secret')), 'fixture_idem_1');
    const body = { delivery: 'none', owner_token: token, meta: { source: 'agent' }, assignment: { schema_version: 1, request_id: 'fixture_idem_1', brief: 'idempotent', inputs: [], expected_output: 'text', execution_scope: 'read-only', valid_until: new Date(Date.now() + 3600e3).toISOString() } };
    const a = await adminRequest(adminSock, '/submit', { method: 'POST', payload: body, token: undefined }), b = await adminRequest(adminSock, '/submit', { method: 'POST', payload: body, token: undefined });
    assert.equal(b.duplicate, true); assert.equal(b.request_id ?? 'fixture_idem_1', a.request_id ?? 'fixture_idem_1'); assert.equal(rows().filter(r => r.request_id === 'fixture_idem_1').length, 1);
  });
  if (failures.length) { console.log(`${failures.length} step(s) failed`); process.exitCode = 1; }
} finally {
  adapter?.child.kill('SIGKILL'); proxy?.close();
  service?.kill('SIGTERM'); if (service) await new Promise(r => service.once('exit', r));
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
}
