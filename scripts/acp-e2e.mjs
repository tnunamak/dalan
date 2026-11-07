#!/usr/bin/env node
// End to end: bin/dot-acp-agent.mjs driven over ACP (raw client, T3's hybrid initialize) against a real bridge server in a
// temp HOME. A fake worker claims and finishes assignments through the MCP tools, as scripts/wait-e2e.mjs does.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startAdapter } from './acp-client.mjs';
import { runtimeBlock, envelope } from './acp-t3-fixtures.mjs';
import { buildIneligible, buildResultText, runBuildProseCheck, isBuild, buildScope, adminRequest, githubRepoOf, buildAssignment, parsePrompt, attemptId, ownerToken, readOrCreateSecret, unwrapUserRequest, withoutNote, sha256, NO_REPO_NOTE } from '../src/acp-bridge.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = resolve(new URL('..', import.meta.url).pathname), home = await mkdtemp(join(tmpdir(), 'dalan-acp-e2e-'));
const port = Number(process.env.ACP_E2E_PORT) || await reservedPort(), threadId = '00000000-0000-4000-8000-000000000001';
const socket = join(home, '.local/share/dot-bridge/admin.sock');
const env = { ...process.env, HOME: home, DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_PORT: String(port), PATH: `${join(home, 'bin')}:${process.env.PATH}` };
const adapterEnv = { HOME: home, DOT_ACP_HEARTBEAT_MS: '1000', DOT_ACP_VALID_MINUTES: '30', DOT_ACP_BUILD_OWNERS: 'acme' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(test, label, ms = 10000) { for (let t = 0; t < ms; t += 25) { if (await test()) return; await sleep(25); } throw new Error(`timed out waiting for ${label}`); }
const workDirs = await mkdtemp(join(tmpdir(), 'dalan-acp-e2e-cwd-'));
env.DOT_BRIDGE_GITHUB_URL_ACME_PACKER = join(workDirs, 'origin.git');
let service; const adapters = [];
const adapter = (extra = {}, cwd) => { const a = startAdapter({ ...adapterEnv, ...extra }, cwd); adapters.push(a); return a; };

try {
  // ---- pure helpers
  assert.equal(githubRepoOf('https://github.com/acme/widget.git'), 'acme/widget');
  assert.equal(githubRepoOf('git@github.com:acme/widget.git'), 'acme/widget');
  assert.equal(githubRepoOf('/srv/git/widget.git'), null);
  assert.deepEqual(parsePrompt('[dot-decision:dec_abc12345]\nreview this\n'), { brief: 'review this', root: 'dec_abc12345', requestRoot: 'dec_abc12345' });
  assert.match(parsePrompt('no token').requestRoot, /^acp-[0-9a-f]{24}$/);
  assert.deepEqual(parsePrompt('Act as the implementation sub-agent for this task.\n\n[dot-decision:dec_abc12345]\n[dot-build] a.py\nfix'), { brief: '[dot-build] a.py\nfix', root: 'dec_abc12345', requestRoot: 'dec_abc12345' }, 'T3 role preamble is stripped');
  assert.equal(parsePrompt('Act as the review sub-agent for this task.\n\nreview x').brief, 'review x');
  assert.equal(parsePrompt('Act as the review sub-agent for this task.\n\nreview x').requestRoot, parsePrompt('review x').requestRoot, 'role does not change identity');
  assert.equal(parsePrompt('Please act as the review sub-agent for this task.\n\nx').brief, 'Please act as the review sub-agent for this task.\n\nx', 'only the exact preamble');
  assert.equal(attemptId('dec_abc12345', 1), 'dec_abc12345'); assert.equal(attemptId('dec_abc12345', 3), 'dec_abc12345_r3');
  const inputs = [{ github_repo: 'acme/widget', base_sha: 'a'.repeat(40), head_sha: 'a'.repeat(40) }];
  assert.equal(buildAssignment({ requestId: 'dec_abc12345', brief: 'b', inputs, validUntil: 'x' }).inputs[0].head_sha, 'a'.repeat(40));
  assert.deepEqual(buildAssignment({ requestId: 'dec_abc12345', brief: 'b', inputs: [], validUntil: 'x' }).inputs, []);

  assert.ok(isBuild('[dot-build] a.py b.py\nx')); assert.ok(isBuild('[dot-build]\nx')); assert.ok(!isBuild('fix [dot-build] a.py')); assert.ok(!isBuild('[dot-build]x a.py'));
  assert.deepEqual(buildScope('[dot-build]  a.py\tb/c.py \nx'), ['a.py', 'b/c.py']); assert.deepEqual(buildScope('[dot-build]\nx'), []);
  assert.equal(buildAssignment({ requestId: 'dec_abc12345', brief: '[dot-build] a.py\nx', inputs, validUntil: 'x', build: true }).execution_scope, 'implementation');
  const patch = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n-old\n+new\n+more\n';
  const evRow = { request_id: 'dec_b1234567', assignment: { inputs }, report: { workspace_evidence: { base_sha: 'a'.repeat(40), checks: [{ check_id: 'default', status: 'completed', exit_code: 0, diff_sha256: 'f'.repeat(64) }], patch_artifact: { artifact_id: 'art_x1234567', size: patch.length, sha256: 'e'.repeat(64) } } } };
  const ev = buildResultText(evRow, 'DONE', Buffer.from(patch));
  assert.match(ev, /worker checks: default completed exit 0 on diff ffffffffffff/); assert.match(ev, /  a\.py \+2 -1/); assert.match(ev, /```diff\ndiff --git/);
  assert.match(ev, /dalan artifact art_x1234567 --output/);
  assert.match(buildResultText(evRow, 'DONE', null), /patch: \d+ bytes, sha256 e+, artifact art_x1234567\nFetch:/, 'an unreadable artifact still gives the fetch command');
  assert.match(buildResultText(evRow, 'DONE', Buffer.from(patch + 'x'.repeat(4000))), /preview omitted/);
  assert.match(buildResultText({ ...evRow, report: { workspace_evidence: { patch_artifact: { artifact_id: 'art_e', size: 0 } } } }, 'DONE', null), /patch: none \(empty diff\)/);

  {
    const cfgFile = join(workDirs, 'producer.json');
    await writeFile(cfgFile, JSON.stringify({ repo_selection: { exclude: ['example-org/secret*'] }, deny_path_terms: ['auth', 'token'] }));
    const env1 = { DOT_ACP_BUILD_OWNERS: 'example-owner,example-partner,example-connectors', DOT_ACP_REPO_CONFIG: cfgFile };
    const defaultOwners = { DOT_ACP_BUILD_OWNERS: '', DOT_ACP_REPO_CONFIG: cfgFile };
    assert.match(buildIneligible('example-connectors/example-repo', ['src/a.py'], defaultOwners), /must list authorized repository owners/);
    assert.equal(buildIneligible('example-connectors/example-repo', ['src/a.py'], env1), null);
    assert.equal(buildIneligible('example-owner/sample-project', ['lib/a.sh'], env1), null);
    assert.equal(buildIneligible('example-partner/x', ['a', 'b', 'c', 'd', 'e'], env1), null);
    assert.equal(buildIneligible('example-owner/sample-config', ['a'], env1), null);
    assert.equal(buildIneligible('example-owner/dot-bridge', ['a'], env1), null);
    const connectorsCfg = join(workDirs, 'connectors-producer.json');
    await writeFile(connectorsCfg, JSON.stringify({ repo_selection: { exclude: ['example-connectors/private*'] }, deny_path_terms: ['auth', 'token'] }));
    const connectorsEnv = { ...env1, DOT_ACP_REPO_CONFIG: connectorsCfg };
    assert.match(buildIneligible('example-connectors/private-repo', ['a'], connectorsEnv), /excluded/);
    assert.match(buildIneligible('example-connectors/example-repo', ['src/auth/client.py'], connectorsEnv), /credential path term/);
    assert.match(buildIneligible('example-connectors/sample-data', ['a'], { ...env1, DOT_ACP_BUILD_OWNERS: 'example-owner,example-partner' }), /outside the configured owner allowlist/);
    assert.match(buildIneligible('example-owner/x', ['a', 'b', 'c', 'd', 'e', 'f'], env1), /at most 5/);
    assert.match(buildIneligible('example-owner/x', ['src/auth/a.py'], env1), /credential path term/);
    assert.match(buildIneligible('example-org/secrets', ['a'], { ...env1, DOT_ACP_BUILD_OWNERS: 'example-org' }), /excluded/);
    assert.match(buildIneligible('example-owner/x', ['a'], { ...env1, DOT_ACP_REPO_CONFIG: join(workDirs, 'missing.json') }), /unreadable/);
  }

  {
    const stubDir = join(workDirs, 'prose-check'), stub = join(stubDir, 'prose-check');
    await mkdir(stubDir);
    const capture = join(stubDir, 'input.txt');
    await writeFile(stub, '#!/bin/sh\ncat > ' + JSON.stringify(capture) + '\nprintf \'{"findings":[],"notes":[]}\\n\'\n', { mode: 0o755 });
    const fixturePatch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-old prose\n+new prose\ndiff --git a/src/client.py b/src/client.py\n--- a/src/client.py\n+++ b/src/client.py\n@@ -1 +1,3 @@\n-old = 1\n+# explain the result\n+result = 3\n';
    const connectorRow = { ...evRow, assignment: { inputs: [{ github_repo: 'example-connectors/example-repo', base_sha: 'a'.repeat(40) }] } };
    assert.equal(await runBuildProseCheck('example-connectors/example-repo', fixturePatch, { DALAN_ACP_PROSE_CHECK: stub }), null, 'the prose check does not apply without an owner allowlist');
    assert.deepEqual(await runBuildProseCheck('example-connectors/example-repo', fixturePatch, { DALAN_ACP_PROSE_CHECK_OWNERS: 'example-connectors' }), { status: 'ERROR', detail: 'prose check command not configured' });
    const proseCheckEnv = { ...process.env, DALAN_ACP_PROSE_CHECK_OWNERS: 'example-connectors', DALAN_ACP_PROSE_CHECK: stub, CAPTURE: capture };
    const pass = await runBuildProseCheck('example-connectors/example-repo', fixturePatch, proseCheckEnv, { refusal: () => null });
    assert.match(buildResultText(connectorRow, 'DONE', Buffer.from(fixturePatch), pass), /worker checks: default completed exit 0[\s\S]*prose check: PASS; no findings/);
    const checked = await readFile(capture, 'utf8');
    assert.match(checked, /README\.md: new prose[\s\S]*src\/client\.py: # explain the result/);
    assert.doesNotMatch(checked, /old prose|result = 3/);
    await writeFile(stub, '#!/bin/sh\ncat >/dev/null\nprintf \'{"findings":[{"severity":"high","rule":"generic","message":"vague prose"}],"notes":[]}\\n\'\nexit 1\n', { mode: 0o755 });
    const fail = await runBuildProseCheck('example-connectors/example-repo', fixturePatch, { ...proseCheckEnv, DALAN_ACP_PROSE_CHECK: stub }, { refusal: () => null });
    const failedText = buildResultText(connectorRow, 'DONE', Buffer.from(fixturePatch), fail);
    assert.match(failedText, /prose check: FAIL \(exit 1\); top findings: high generic: vague prose/);
    assert.match(failedText, /patch: \d+ bytes/, 'a prose check failure keeps the patch in the result');
    const unavailable = await runBuildProseCheck('example-connectors/example-repo', fixturePatch, { ...proseCheckEnv, DALAN_ACP_PROSE_CHECK: join(stubDir, 'missing') }, { refusal: () => null });
    assert.match(buildResultText(connectorRow, 'DONE', Buffer.from(fixturePatch), unavailable), /prose check: ERROR \(command not found\)/);
  }

  // ---- bridge up
  await mkdir(join(home, '.config', 'dot-bridge'), { recursive: true }); await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, '.config', 'dot-bridge', 'limits.json'), JSON.stringify({ main_thread_ids: [threadId] }), { mode: 0o600 });
  // ACP builds in this fixture return patches without host checks. The legacy
  // host default now refuses implementation jobs while the executor is disabled.
  await writeFile(join(home, '.config', 'dot-bridge', 'workers.json'), JSON.stringify({ default_execution: 'none', workers: {
    dot: { connections: [{ issuer: 'https://fixture.invalid', subject: 'fixture', client_id: 'fixture' }], repos:['acme/widget','example-connectors/example-repo','acme/packer'] },
  } }), { mode: 0o600 });
  await writeFile(join(home, 'bin', 't3code'), `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.includes('inspect')) console.log(JSON.stringify({ok:true,data:{runtime:{environmentId:'fake-environment'},thread:{id:'${threadId}',status:'active'}}}));
else if(args.includes('send')) { process.stdin.on('data',()=>{}); process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,data:{}}))); }
else console.log(JSON.stringify({ok:true,data:{}}));
`, { mode: 0o755 });
  let ready = false;
  service = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  process.once('exit', () => service.kill('SIGTERM'));
  service.stdout.on('data', b => { if (String(b).includes('MCP listening')) ready = true; }); service.stderr.on('data', b => process.stderr.write(b));
  await waitFor(() => ready, 'bridge');
  const bridgeSecret = (await readFile(join(home, '.config', 'dot-bridge', 'env'), 'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc = async (name, args) => { const r = await fetch(`http://127.0.0.1:${port}/${bridgeSecret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) }); const b = await r.json(); return JSON.parse(b.result.content[0].text); };
  const db = () => new DatabaseSync(join(home, '.local/share/dot-bridge/bridge.db'), { readOnly: true });
  const rows = like => { const d = db(); try { return d.prepare('SELECT request_id,status,payload FROM assignments WHERE request_id LIKE ? ORDER BY request_id').all(like); } finally { d.close(); } };
  const lifecycle = rid => { const d = db(); try { return d.prepare("SELECT type FROM lifecycle_events WHERE request_id=? AND type='consumed'").all(rid); } finally { d.close(); } };
  const status = rid => rows(rid)[0]?.status;
  const claim = async rid => (await rpc('claim', { request_id: rid, claimant: 'fake-worker' })).claim_id;
  const finish = async (rid, claim_id, result) => rpc('finish', { request_id: rid, claim_id, outcome: 'completed', summary: 'done', result });
  const operator = (...a) => spawnSync(process.execPath, ['bin/dot-worker.mjs', ...a], { cwd: repo, env, encoding: 'utf8' });
  const noGit = join(workDirs, 'plain'); await mkdir(noGit);

  // ---- 1. initialize, free session/new, result round trip, heartbeat, stdout hygiene
  let a = adapter();
  const init = await a.init();
  assert.equal(init.protocolVersion, 1); assert.equal(init.agentCapabilities.loadSession, true);
  const sess = await a.newSession(noGit);
  assert.equal(sess.configOptions[0].category, 'model'); assert.deepEqual(sess.configOptions[0].options.map(o => o.value), ['dot']);
  assert.equal(rows('%').length, 0, 'session/new must not touch the bridge');
  const stateFile = join(home, '.local/state/dot-bridge/acp', `${sess.sessionId}.json`);
  assert.ok(!existsSync(stateFile), 'an idle session leaves no state file');
  const secretFile = join(home, '.config/dot-bridge/acp-secret');
  const root1 = 'dec_roundtrip_1';
  const p1 = a.prompt(sess.sessionId, `[dot-decision:${root1}]\nresearch the thing\n`);
  await waitFor(() => status(root1) === 'queued', 'queued row');
  assert.equal(statSync(secretFile).mode & 0o777, 0o600, 'secret mode');
  assert.equal(JSON.parse(rows(root1)[0].payload).brief, 'research the thing', 'the token line is not sent to the worker');
  await waitFor(() => existsSync(stateFile), 'round-trip state persisted');
  assert.equal(statSync(stateFile).mode & 0o777, 0o600, 'state file mode'); assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).pending.rid, root1);
  await waitFor(() => a.text('agent_thought_chunk').includes('worker queued'), 'queued heartbeat');
  const c1 = await claim(root1);
  await waitFor(() => a.text('agent_thought_chunk').includes('worker claimed'), 'claimed heartbeat');
  await finish(root1, c1, 'THE RESULT OF 1');
  const r1 = await p1;
  assert.equal(r1.result.stopReason, 'end_turn'); assert.equal(a.text('agent_message_chunk'), 'THE RESULT OF 1');
  assert.match(a.rawText('agent_message_chunk'), /^THE RESULT OF 1\n\ndecide: dalan decide dec_roundtrip_1 accepted\|applied\|useful_no_change\|useful_negative\|not_useful$/, 'a plain result ends with the decide line');
  assert.ok(!existsSync(stateFile), 'the state file goes away when the result is delivered');
  assert.deepEqual(lifecycle(root1), [], 'the adapter did not consume its delivered assignment');
  const acpOwner = ownerToken(readOrCreateSecret(secretFile), root1);
  const peek = await adminRequest(socket, `/get?id=${encodeURIComponent(root1)}&peek=1`, { token: acpOwner });
  assert.deepEqual(lifecycle(root1), [], 'peek reads do not record consumption');
  const normal = await adminRequest(socket, `/get?id=${encodeURIComponent(root1)}`, { token: acpOwner });
  assert.deepEqual(normal, peek, 'normal and peek reads return the same assignment data');
  assert.equal(lifecycle(root1).length, 1, 'a normal owner read still records consumption');
  assert.deepEqual(a.errors, []);
  console.log('PASS round trip without adapter consumption, peek and normal reads, free session/new, 0600 state and secret, token line stripped, heartbeats, clean stdout');

  // T3 wraps the brief in <t3_code_instructions> and <user_request>; the adapter unwraps it before reading the token line
  const wrapped = envelope('[dot-decision:dec_wrapped_1]\nwrapped brief');
  const sw = (await a.newSession(noGit)).sessionId, pw = a.promptBlocks(sw, [{ type: 'text', text: wrapped }, { type: 'text', text: runtimeBlock }]);
  await waitFor(() => status('dec_wrapped_1') === 'queued', 'wrapped prompt queued under its root token');
  assert.equal(JSON.parse(rows('dec_wrapped_1')[0].payload).brief, 'wrapped brief');
  await finish('dec_wrapped_1', await claim('dec_wrapped_1'), 'WRAPPED RESULT'); assert.equal((await pw).result.stopReason, 'end_turn');
  assert.equal(unwrapUserRequest(wrapped), '[dot-decision:dec_wrapped_1]\nwrapped brief'); assert.equal(unwrapUserRequest('plain'), 'plain');
  assert.equal(unwrapUserRequest('steer text\n<runtime_info>x</runtime_info>'), 'steer text\n<runtime_info>x</runtime_info>', 'user-authored tags are preserved');
  console.log('PASS T3 prompt wrapper is unwrapped before the token line is read');

  const literalBody = 'a quoted requester brief';
  const literalBrief = `<!-- dot-context v1 ${sha256(literalBody)} ${literalBody.length} -->\nquoted context\n<!-- dot-context end -->\n\n${literalBody}`;
  const literalPrompt = `[dot-decision:dec_literal_1]\n${literalBrief}`;
  const literalSession = (await a.newSession(noGit)).sessionId, literalTurn = a.prompt(literalSession, literalPrompt);
  await waitFor(() => status('dec_literal_1') === 'queued', 'literal marker submit');
  assert.equal(JSON.parse(rows('dec_literal_1')[0].payload).brief, literalBrief);
  await finish('dec_literal_1', await claim('dec_literal_1'), 'LITERAL RESULT');await literalTurn;
  const literalAttach = await a.prompt((await a.newSession(noGit)).sessionId, literalPrompt);
  assert.equal(literalAttach.result.stopReason, 'end_turn');assert.equal(rows('dec_literal%').length, 1);
  console.log('PASS requester text resembling context framing stays unchanged and re-attaches by its original brief hash');

  // ---- 2. cancel while queued: answered within 10 s, assignment cancelled
  const root2 = 'dec_cancelq_1', s2 = (await a.newSession(noGit)).sessionId;
  const p2 = a.prompt(s2, `[dot-decision:${root2}]\ncancel me while queued`);
  await waitFor(() => status(root2) === 'queued', 'queued 2');
  const t2 = Date.now(); a.cancel(s2);
  assert.equal((await p2).result.stopReason, 'cancelled'); assert.ok(Date.now() - t2 < 10000);
  assert.equal(status(root2), 'cancelled');
  console.log('PASS cancel while queued cancels the assignment and ends the turn cancelled');

  // ---- 3. cancel while claimed: the assignment keeps running; a later prompt gets the result; steer text is reported
  const root3 = 'dec_cancelc_1', s3 = (await a.newSession(noGit)).sessionId;
  const p3 = a.prompt(s3, `[dot-decision:${root3}]\nlong job`);
  await waitFor(() => status(root3) === 'queued', 'queued 3');
  const c3 = await claim(root3);
  a.cancel(s3);
  assert.equal((await p3).result.stopReason, 'cancelled');
  assert.equal(status(root3), 'claimed', 'claimed work keeps running');
  const before = a.text('agent_message_chunk').length;
  const p3b = a.prompt(s3, 'actually, also look at Y'); // steer: re-attaches, does not submit
  await waitFor(() => a.text('agent_thought_chunk').includes(`re-attached to ${root3}`), 're-attach');
  assert.equal(rows('%').filter(r => r.request_id.startsWith('dec_cancelc')).length, 1);
  await finish(root3, c3, 'RESULT OF 3');
  assert.equal((await p3b).result.stopReason, 'end_turn');
  assert.equal(a.text('agent_message_chunk').slice(before), 'RESULT OF 3\n\nnot sent to the worker: actually, also look at Y');
  console.log('PASS cancel while claimed leaves the assignment running; a steer re-attaches and is reported as not sent');

  // ---- 4. kill the adapter mid-wait; a new process and a new session with the same brief re-attach: one assignment, one result
  const root4 = 'dec_restart_1', brief4 = `[dot-decision:${root4}]\nsurvive a restart`;
  const s4 = (await a.newSession(noGit)).sessionId;
  a.prompt(s4, brief4);
  await waitFor(() => status(root4) === 'queued', 'queued 4');
  a.kill('SIGKILL'); await a.exited;
  const c4 = await claim(root4);
  const b = adapter(); await b.init();
  const sB = (await b.newSession(noGit)).sessionId; // a relaunched T3 child is a new session
  const p4 = b.prompt(sB, brief4);
  await waitFor(() => b.text('agent_thought_chunk').includes(`re-attached`) || b.text('agent_thought_chunk').includes(`worker assignment ${root4}`), 'attach 4');
  await finish(root4, c4, 'RESULT OF 4');
  assert.equal((await p4).result.stopReason, 'end_turn'); assert.equal(b.text('agent_message_chunk'), 'RESULT OF 4');
  assert.equal(rows(`${root4}%`).length, 1, 'exactly one assignment');
  // same session after a restart: session/load restores the pending assignment and T3's continuation prompt re-attaches without a note
  const root4b = 'dec_restart_2', s4b = (await b.newSession(noGit)).sessionId;
  b.prompt(s4b, `[dot-decision:${root4b}]\nsecond restart case`);
  await waitFor(() => status(root4b) === 'queued', 'queued 4b');
  const c4b = await claim(root4b);
  await waitFor(() => JSON.parse(require_state(s4b)).pending?.rid === root4b, 'pending persisted');
  b.kill('SIGKILL'); await b.exited;
  const c = adapter(); await c.init();
  assert.ok(!(await c.loadSession(s4b, noGit)).error);
  const p4c = c.prompt(s4b, 'Continue where you left off.');
  await waitFor(() => c.text('agent_thought_chunk').includes(`re-attached to ${root4b}`), 'load re-attach');
  await finish(root4b, c4b, 'RESULT OF 4b');
  assert.equal((await p4c).result.stopReason, 'end_turn'); assert.equal(c.text('agent_message_chunk'), 'RESULT OF 4b');
  assert.equal(rows(`${root4b}%`).length, 1);
  function require_state(id) { return readFileSync(join(home, '.local/state/dot-bridge/acp', `${id}.json`)); }
  console.log('PASS kill mid-wait then restart: same brief re-attaches (new session and session/load), one assignment, one result');

  // ---- 5. same token, different brief: refused, never attached
  const root5 = 'dec_conflict_1';
  const s5 = (await c.newSession(noGit)).sessionId;
  c.prompt(s5, `[dot-decision:${root5}]\nbrief A`);
  await waitFor(() => status(root5) === 'queued', 'queued 5');
  const d = adapter(); await d.init();
  const r5 = await d.prompt((await d.newSession(noGit)).sessionId, `[dot-decision:${root5}]\nbrief B`);
  assert.equal(r5.error.code, -32000); assert.match(r5.error.message, /different brief/);
  assert.equal(rows(`${root5}%`).length, 1);
  // same brief, a longer queue age than the stored valid_until, still attaches to the stored row (valid_until is read from the payload)
  const e = adapter({ DOT_ACP_VALID_MINUTES: '5' }); await e.init();
  const pe = e.prompt((await e.newSession(noGit)).sessionId, `[dot-decision:${root5}]\nbrief A`);
  await waitFor(() => e.text('agent_thought_chunk').includes(`worker assignment ${root5}`), 'attach despite a different valid_until');
  assert.equal(rows(`${root5}%`).length, 1);
  const tok5 = ownerToken(readOrCreateSecret(secretFile), root5);
  await adminRequest(socket, '/cancel', { method: 'POST', payload: { id: root5 }, token: tok5 });
  console.log('PASS a different brief under one token is refused; the same brief attaches even with a different valid_until');

  // ---- 6. cancelled row -> relaunch submits `<root>_r2`; expired row while waiting -> resubmits `_r2`
  const s6 = (await e.newSession(noGit)).sessionId;
  const p6 = e.prompt(s6, `[dot-decision:${root5}]\nbrief A`); // row root5 is cancelled
  await waitFor(() => status(`${root5}_r2`) === 'queued', 'r2 submitted');
  assert.equal(rows(`${root5}%`).length, 2);
  const tok6 = ownerToken(readOrCreateSecret(secretFile), `${root5}_r2`);
  await adminRequest(socket, '/cancel', { method: 'POST', payload: { id: `${root5}_r2` }, token: tok6 });
  assert.equal((await p6).error?.code, -32000); // cancelled by someone else: the child ends as an error
  const f = adapter({ DOT_ACP_VALID_MINUTES: '0.02' }); await f.init(); // 1.2 s of validity
  const root6 = 'dec_expire_1';
  const pf = f.prompt((await f.newSession(noGit)).sessionId, `[dot-decision:${root6}]\nexpire me`);
  await waitFor(() => status(`${root6}_r2`) === 'queued', 'expired then resubmitted as r2', 15000);
  assert.equal(status(root6), 'cancelled');
  const c6 = await claim(`${root6}_r2`); await finish(`${root6}_r2`, c6, 'RESULT OF 6');
  assert.equal((await pf).result.stopReason, 'end_turn'); assert.equal(f.text('agent_message_chunk'), 'RESULT OF 6');
  console.log('PASS cancelled and expired rows are never attached: a new `<root>_r<n>` assignment runs');

  // ---- 7. blocker ends the turn with the question
  const root7 = 'dec_blocker_1', g = adapter(); await g.init();
  const pg = g.prompt((await g.newSession(noGit)).sessionId, `[dot-decision:${root7}]\nneeds an answer`);
  await waitFor(() => status(root7) === 'queued', 'queued 7');
  const c7 = await claim(root7);
  await rpc('progress', { request_id: root7, claim_id: c7, note: 'QUESTION: which format?', blocker: true });
  const r7 = await pg;
  assert.equal(r7.result.stopReason, 'end_turn'); assert.match(g.text('agent_message_chunk'), /\[worker question\] QUESTION: which format\?/);
  await finish(root7, c7, 'BLOCKER TEST COMPLETE'); // release the fake worker's claim before later repository cases
  console.log('PASS a QUESTION blocker ends the turn with the question as the result');

  // ---- 8. eligibility: pause and queue cap; repository context and text-only fallback
  const h = adapter({ DOT_ACP_INFLIGHT_CAP: '1' }); await h.init();
  const sh = (await h.newSession(noGit)).sessionId;
  const before8 = rows('%').length;
  assert.equal(operator('pause', '--reason', 'e2e').status, 0);
  const paused = await h.prompt(sh, '[dot-decision:dec_paused_1]\nwhile paused');
  assert.equal(paused.error.code, -32000); assert.match(paused.error.message, /worker refused: worker paused: e2e/);
  assert.equal(operator('resume').status, 0);
  assert.equal(rows('%').length, before8, 'a refusal submits nothing');
  const filler = adapter(); await filler.init();
  filler.prompt((await filler.newSession(noGit)).sessionId, '[dot-decision:dec_fill_1]\nfills the queue');
  await waitFor(() => status('dec_fill_1') === 'queued', 'queue filler');
  const full = await h.prompt(sh, '[dot-decision:dec_full_1]\nwhen the queue is full');
  assert.match(full.error.message, /queue is full/);
  // The real admin route must enforce admission even if its caller omitted the adapter's status precheck.
  await assert.rejects(adminRequest(socket, '/submit', { method: 'POST', payload: {
    delivery: 'none', owner_token: ownerToken(readOrCreateSecret(secretFile), 'dec_atomic_cap'), max_queued: 1,
    assignment: buildAssignment({ requestId: 'dec_atomic_cap', brief: 'atomic HTTP admission', inputs: [], validUntil: new Date(Date.now() + 60000).toISOString() }),
  } }), /queue is full/);
  assert.equal(rows('dec_atomic_cap').length, 0, 'rejected admission inserts no row');
  console.log('PASS refusals on pause and a full queue end the turn with an error and submit nothing; admin admission enforces the cap');
  // drain queued rows so later cases start clean
  for (const r of rows('%').filter(r => r.status === 'queued')) { const t = ownerToken(readOrCreateSecret(secretFile), r.request_id); await adminRequest(socket, '/cancel', { method: 'POST', payload: { id: r.request_id }, token: t }); }

  const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const bare = join(workDirs, 'origin.git'), work = join(workDirs, 'work');
  spawnSync('git', ['init', '-q', '--bare', bare]); spawnSync('git', ['init', '-q', '-b', 'main', work]);
  await writeFile(join(work, 'a.txt'), 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'one');
  git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-q', '-u', 'origin', 'main');
  const ig = adapter(); await ig.init();
  const sg = (await ig.newSession(work)).sessionId;
  await writeFile(join(work, 'a.txt'), 'dirty\n');
  const pd = ig.prompt(sg, '[dot-decision:dec_dirty_1]\nreview my local edit');
  await waitFor(() => status('dec_dirty_1') === 'queued', 'dirty submit');
  const dirtyRow = JSON.parse(rows('dec_dirty_1')[0].payload);
  assert.deepEqual(dirtyRow.inputs, []); assert.ok(dirtyRow.brief.startsWith(NO_REPO_NOTE), 'dirty worktree goes text-only with the no-repository note');
  // while it is queued, the same brief from another session re-attaches although the stored brief carries the note
  const sg2 = (await ig.newSession(work)).sessionId;
  const reDirty = ig.prompt(sg2, '[dot-decision:dec_dirty_1]\nreview my local edit');
  await sleep(1500); assert.equal(rows('dec_dirty%').length, 1, 're-attach, not a second submit');
  ig.cancel(sg2); ig.cancel(sg); await reDirty; assert.equal((await pd).result.stopReason, 'cancelled');
  git(work, 'commit', '-qam', 'two'); // committed but not pushed
  const pu = ig.prompt(sg, '[dot-decision:dec_unpushed_1]\nreview my local commit');
  await waitFor(() => status('dec_unpushed_1') === 'queued', 'unpushed submit');
  assert.ok(JSON.parse(rows('dec_unpushed_1')[0].payload).brief.startsWith(NO_REPO_NOTE), 'unpushed HEAD goes text-only with the note');
  ig.cancel(sg); await pu;
  git(work, 'push', '-q'); // clean and pushed; a non-GitHub origin has no repo input, so the brief goes text-only
  const pc = ig.prompt(sg, '[dot-decision:dec_clean_1]\nreview the pushed commit');
  await waitFor(() => status('dec_clean_1') === 'queued', 'clean repo submit');
  assert.deepEqual(JSON.parse(rows('dec_clean_1')[0].payload).inputs, []);
  ig.cancel(sg); assert.equal((await pc).result.stopReason, 'cancelled');
  console.log('PASS dirty and unpushed worktrees go text-only with a no-repository note and still re-attach; a clean pushed one submits');

  // GitHub identification in the adapter, with only the bridge clone transport redirected to the local bare fixture.
  await writeFile(join(work, '.env.base'), 'SENSITIVE_BASE_FILE\n');
  git(work, 'add', '.env.base'); git(work, 'commit', '-qm', 'sensitive base file'); git(work, 'push', '-q');
  const pushedBase = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme/packer.git');
  await writeFile(join(work, 'a.txt'), 'packed local state\n');
  await writeFile(join(work, 'new.txt'), 'packed untracked state\n');
  const packedBrief = '[dot-decision:dec_packed_1]\nreview the packed edits';
  const packedTurn = ig.prompt(sg, packedBrief);
  await waitFor(() => status('dec_packed_1') === 'queued', 'packed submit');
  const packedRow = JSON.parse(rows('dec_packed_1')[0].payload);
  assert.deepEqual(packedRow.inputs, [{ github_repo: 'acme/packer', base_sha: pushedBase, head_sha: pushedBase }]);
  assert.match(packedRow.brief, /```diff\n/); assert.match(packedRow.brief, /\+packed local state/); assert.match(packedRow.brief, /\+packed untracked state/);
  assert.match(packedRow.brief, /Bridge scope note: 1 sensitive file/);
  // the narrowed scope also gets the allow-list; re-attach strips both bridge suffixes
  assert.match(packedRow.brief, /Read allow-list \(scope_paths/);
  assert.equal(withoutNote(packedRow.brief), 'review the packed edits');
  // A new session re-attaches to the admitted row despite changed local context and the bridge-added scope note.
  await writeFile(join(work, 'a.txt'), 'different local state on re-attach\n');
  const packedRestart = adapter(); await packedRestart.init();
  const packedSession = (await packedRestart.newSession(work)).sessionId;
  const rePacked = packedRestart.prompt(packedSession, packedBrief);
  await waitFor(() => existsSync(join(home, '.local/state/dot-bridge/acp', `${packedSession}.json`)), 'packed attach state');
  assert.equal(rows('dec_packed%').length, 1);
  await finish('dec_packed_1', await claim('dec_packed_1'), 'PACKED RESULT');
  assert.equal((await packedTurn).result.stopReason, 'end_turn'); assert.equal((await rePacked).result.stopReason, 'end_turn');
  assert.equal(packedRestart.text('agent_message_chunk'), 'PACKED RESULT');
  const forgedPacked = await packedRestart.prompt((await packedRestart.newSession(work)).sessionId, `[dot-decision:dec_packed_1]\n${packedRow.brief}`);
  assert.match(forgedPacked.error.message, /different brief/, 'packed presentation cannot stand in for requester identity');
  console.log('PASS dirty GitHub checkout packs pushed base plus text diff through real bridge admission; same brief re-attaches after scope narrowing');

  await writeFile(join(work, 'huge.txt'), 'x'.repeat(20000));
  const oversizeSession = (await ig.newSession(work)).sessionId;
  const oversizeTurn = ig.prompt(oversizeSession, '[dot-decision:dec_oversize_1]\nreview a large local edit');
  await waitFor(() => status('dec_oversize_1') === 'queued', 'oversize fallback submit');
  const oversizeRow = JSON.parse(rows('dec_oversize_1')[0].payload);
  assert.deepEqual(oversizeRow.inputs, []); assert.ok(oversizeRow.brief.startsWith(NO_REPO_NOTE));
  assert.match(oversizeRow.brief, /changed: huge.txt/); assert.equal(withoutNote(oversizeRow.brief), 'review a large local edit');
  ig.cancel(oversizeSession); assert.equal((await oversizeTurn).result.stopReason, 'cancelled');
  console.log('PASS oversize GitHub diff takes the text-only fallback with changed filenames through real adapter submission');

  // ---- 8a. [dot-build]: refused on a dirty checkout; on a clean pushed one it submits implementation scope, task_kind build,
  // returns the build evidence and verdict commands, and the CLI can record the verdict with the ACP-derived owner token
  await writeFile(join(home, '.config', 'dot-bridge', 'producer.json'), JSON.stringify({ repo_selection: { exclude: [] }, deny_path_terms: ['auth'] }));
  const bs = (await ig.newSession(work)).sessionId;
  const noScope = await ig.prompt(bs, '[dot-decision:dec_build_noscope]\n[dot-build]\nfix a.txt');
  assert.match(noScope.error?.message ?? '', /must name the files/, JSON.stringify(noScope));
  const dirtyBuild = await ig.prompt(bs, '[dot-decision:dec_build_dirty]\n[dot-build] a.txt\nfix a.txt');
  assert.match(dirtyBuild.error?.message ?? '', /needs a clean checkout whose HEAD is pushed/, JSON.stringify(dirtyBuild));
  assert.equal(rows('dec_build_dirty%').length, 0, 'a refused build submits nothing');
  git(work, 'checkout', '-q', '--', '.'); git(work, 'clean', '-fdq');
  await mkdir(join(work, 'sub'), { recursive: true }); await writeFile(join(work, 'sub', 'x.txt'), 'x\n');
  git(work, 'add', 'sub'); git(work, 'commit', '-qm', 'sub dir'); git(work, 'remote', 'set-url', 'origin', bare); git(work, 'push', '-q'); git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme/packer.git');
  const buildBase = git(work, 'rev-parse', 'HEAD').trim();
  const dirBuild = await ig.prompt(bs, '[dot-decision:dec_build_dir]\n[dot-build] sub\nfix sub');
  assert.match(dirBuild.error?.message ?? '', /lists a directory \(sub\)/, JSON.stringify(dirBuild));
  const buildBrief = '[dot-build] a.txt\nIn a.txt, change one to uno. Check: default.';
  const bt = ig.prompt(bs, `[dot-decision:dec_build_1]\n${buildBrief}`);
  await Promise.race([waitFor(() => status('dec_build_1') === 'queued', 'build submit'), bt.then(r => { if (r.error) throw new Error(JSON.stringify(r.error)); })]);
  const buildRow = JSON.parse(rows('dec_build_1')[0].payload);
  assert.equal(buildRow.execution_scope, 'implementation'); assert.ok(buildRow.brief.startsWith(buildBrief)); assert.deepEqual(buildRow.scope_paths, ['a.txt']);
  assert.deepEqual(buildRow.inputs, [{ github_repo: 'acme/packer', base_sha: buildBase, head_sha: buildBase }]);
  { const d = db(); try { assert.deepEqual({ ...d.prepare("SELECT task_kind,source FROM assignments WHERE request_id='dec_build_1'").get() }, { task_kind: 'build', source: 'agent' }); } finally { d.close(); } }
  await finish('dec_build_1', await claim('dec_build_1'), 'BUILD RESULT');
  assert.equal((await bt).result.stopReason, 'end_turn');
  const buildText = ig.rawText('agent_message_chunk');
  assert.match(buildText, /BUILD RESULT\n\n--- worker build evidence \(request dec_build_1\) ---/);
  assert.match(buildText, new RegExp(`base: acme/packer@${buildBase}`));
  assert.match(buildText, /dalan accept dec_build_1, or dalan reject dec_build_1 --note/);
  assert.match(buildText, /Or apply it for you: dalan apply dec_build_1 \[--dir <checkout>\]/);
  assert.match(buildText, /decide: dalan decide dec_build_1 accepted\|applied\|useful_no_change\|useful_negative\|not_useful/);
  const accepted = operator('accept', 'dec_build_1');
  assert.equal(accepted.status, 0, accepted.stderr);
  { const d = db(); try { assert.equal(d.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id='dec_build_1' AND type='accepted'").get().n, 1); } finally { d.close(); } }
  console.log('PASS [dot-build] refuses a dirty checkout, submits implementation scope with task_kind build, returns verdict commands; dalan accept works on an ACP row');

  // ---- 8b. a cancel that lands while acquire is still submitting (slow git) is answered in time and still cancels the job
  const shim = join(workDirs, 'slowgit'); await mkdir(shim, { recursive: true });
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  await writeFile(join(shim, 'git'), `#!/bin/sh\nsleep 1\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const slow = adapter({ PATH: `${shim}:${process.env.PATH}` }); await slow.init();
  const sr = (await slow.newSession(work)).sessionId;
  const t0 = Date.now();
  const racing = slow.prompt(sr, '[dot-decision:dec_race_1]\ncancel me while I am being submitted');
  await sleep(300); slow.cancel(sr);
  const raced = await racing;
  assert.equal(raced.result?.stopReason, 'cancelled', JSON.stringify(raced)); assert.ok(Date.now() - t0 < 9000, `cancel answered in ${Date.now() - t0} ms`);
  // acquire keeps going after the answer and submits late; that job must end cancelled, not queued
  await waitFor(() => status('dec_race_1') === 'cancelled', 'late submit cancelled', 20000);
  console.log('PASS a cancel during a slow submit answers in time and cancels the job the late submit created');

  // ---- 9. stdin EOF exits 0 without cancelling anything
  const k = adapter(); await k.init();
  const root9 = 'dec_eof_1';
  k.prompt((await k.newSession(noGit)).sessionId, `[dot-decision:${root9}]\nleave me queued`);
  await waitFor(() => status(root9) === 'queued', 'queued 9');
  k.child.stdin.end();
  let eofTimer;
  const eofTimeout = new Promise(resolve => { eofTimer = setTimeout(() => resolve(null), 5000); });
  let exit9;
  try {
    exit9 = await Promise.race([k.exited, eofTimeout]);
  } finally {
    clearTimeout(eofTimer);
  }
  assert.deepEqual(exit9, { code: 0, signal: null }); assert.equal(status(root9), 'queued');
  assert.ok(adapters.every(x => x.errors.length === 0), 'every adapter kept stdout for protocol frames');
  console.log('PASS stdin EOF exits 0 and leaves the queued assignment alone');
} finally {
  for (const x of adapters) x.child.kill('SIGKILL');
  service?.kill('SIGTERM'); if (service) await new Promise(r => service.once('exit', r));
  await rm(home, { recursive: true, force: true }); await rm(workDirs, { recursive: true, force: true });
}
