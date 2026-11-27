#!/usr/bin/env node
// `dalan mcp` is a local stdio MCP server that lets a requester agent submit, wait for and read jobs as tool calls.
// This test runs the real stdio process against a hermetic bridge in a temp home. A built-in demo worker, reached
// through the real OAuth flow, finishes the job so the whole submit -> wait -> result loop is exercised.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { beginPairing, openSession, DEMO_REDIRECT } from '../src/demo-worker.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const WORKER = 'acme';
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const home = fs.mkdtempSync(path.join(tempRoot, 'dalan-mcp-'));
let port = null;
const env = { PATH: process.env.PATH, HOME: home, DALAN_LOOPBACK: '1', DALAN_AUTH_MODE: 'builtin', DALAN_PORT: '0', DALAN_CATALOG_PROFILE: 'questions-v1' };
const dalan = args => new Promise((resolve, reject) => execFile(process.execPath, [path.join(repo, 'bin/dalan.mjs'), ...args], { env, cwd: repo, timeout: 30_000 },
  (error, stdout, stderr) => error ? reject(new Error(`dalan ${args.slice(0, 2).join(' ')}: ${(stderr || stdout || error.message).trim()}`)) : resolve(stdout)));
const log = path.join(home, 'server.log');
let server, mcp;
const stdoutLines = [];
const stderrChunks = [];
const pending = new Map();
const send = frame => mcp.stdin.write(`${JSON.stringify(frame)}\n`);
let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 60_000);
  pending.set(id, value => { clearTimeout(timer); resolve(value); });
  send({ jsonrpc: '2.0', id, method, params });
});
const call = async (name, args) => {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, `tools/call ${name} must not be a transport error: ${JSON.stringify(response.error)}`);
  return response.result;
};
const textOf = result => JSON.parse(result.content[0].text);
try {
  const started = await reservedPort({ start: async candidate => {
    port = candidate; env.DALAN_PORT = String(candidate);
    fs.rmSync(path.join(home, '.config'), { recursive: true, force: true });
    fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    await dalan(['init', '--worker', WORKER, '--public-url', `http://127.0.0.1:${port}`]);
    const fd = fs.openSync(log, 'w', 0o600);
    server = spawn(process.execPath, [path.join(repo, 'src/server.mjs')], { env, cwd: repo, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    for (let i = 0; i < 300; i++) {
      const output = fs.readFileSync(log, 'utf8');
      if (/MCP listening/.test(output)) return server;
      if (server.exitCode !== null) {
        if (/EADDRINUSE/.test(output)) throw Object.assign(new Error(output), { code: 'EADDRINUSE' });
        throw new Error(`server did not start:\n${output}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`server did not start:\n${fs.readFileSync(log, 'utf8')}`);
  } });
  port = started.port; server = started.value;
  const configDir = path.join(home, '.config/dalan');
  const secret = /^BRIDGE_PATH_SECRET=(.+)$/m.exec(fs.readFileSync(path.join(configDir, 'env'), 'utf8'))[1];
  const mcpUrl = `http://127.0.0.1:${port}/${secret}/mcp`;
  await dalan(['connect', 'allow-callback', 'http://127.0.0.1/callback']);
  await dalan(['connect', 'start', '--worker', WORKER]);
  const pairing = await beginPairing(mcpUrl);
  await dalan(['connect', 'approve', pairing.code, '--worker', WORKER, '--confirm-redirect', DEMO_REDIRECT, '--replace']);
  const workerCall = await openSession(mcpUrl, await pairing.complete());

  mcp = spawn(process.execPath, [path.join(repo, 'bin/dalan.mjs'), 'mcp'], { env, cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  mcp.stderr.on('data', chunk => stderrChunks.push(String(chunk)));
  readline.createInterface({ input: mcp.stdout }).on('line', line => {
    stdoutLines.push(line);
    const frame = JSON.parse(line); // stdout carries protocol frames only: anything else throws here
    assert.equal(frame.jsonrpc, '2.0');
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  });

  // initialize: version negotiation like the main server.
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.ok(init.capabilities.tools);
  assert.equal(init.serverInfo.name, 'dalan-mcp');
  const unknown = (await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).result;
  assert.equal(unknown.protocolVersion, '2025-11-25');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // tools/list: exact names, schemas and annotations.
  const tools = (await rpc('tools/list', {})).result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ['dalan_accept', 'dalan_answer', 'dalan_cancel', 'dalan_correct', 'dalan_forecast', 'dalan_questions', 'dalan_result', 'dalan_status', 'dalan_submit', 'dalan_wait']);
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  for (const name of ['dalan_status', 'dalan_result', 'dalan_wait', 'dalan_questions']) assert.equal(byName[name].annotations.readOnlyHint, true, name);
  assert.equal(byName.dalan_submit.annotations.readOnlyHint, false);
  assert.equal(byName.dalan_forecast.annotations.readOnlyHint, true);
  assert.equal(byName.dalan_forecast.annotations.idempotentHint, true);
  assert.equal(byName.dalan_submit.annotations.destructiveHint, false);
  assert.deepEqual(byName.dalan_wait.inputSchema.required, ['request_id']);
  assert.equal(byName.dalan_wait.inputSchema.properties.timeout_seconds.maximum, 300);

  assert.deepEqual(byName.dalan_questions.inputSchema.required, ['id']);
  assert.deepEqual(byName.dalan_answer.inputSchema.required, ['id', 'question_id', 'text']);
  assert.equal(byName.dalan_answer.annotations.readOnlyHint, false);
  assert.equal(byName.dalan_answer.annotations.idempotentHint, true);
  assert.match(byName.dalan_wait.description, /dalan_questions.*dalan_answer.*dalan_wait/);
  for (const [name, destructiveHint] of [['dalan_cancel', true], ['dalan_accept', false], ['dalan_correct', false]]) {
    const { annotations: { readOnlyHint, destructiveHint: destructive, idempotentHint, openWorldHint } } = byName[name];
    assert.deepEqual({ readOnlyHint, destructive, idempotentHint, openWorldHint },
      { readOnlyHint: false, destructive: destructiveHint, idempotentHint: true, openWorldHint: false }, name);
  }
  assert.deepEqual(byName.dalan_correct.inputSchema.properties.assignment, byName.dalan_submit.inputSchema.properties.assignment);
  // Validation errors must be local, before an unknown job can reach the CLI.
  for (const [args, message] of [
    [{ id: 'req_unknown_validation', question_id: 'q1', text: '' }, /must not be blank/],
    [{ id: 'req_unknown_validation', question_id: 'q1', text: '   ' }, /must not be blank/],
    [{ id: 'req_unknown_validation', question_id: 'q1', text: 'x'.repeat(4097) }, /4096 UTF-8 bytes/],
    [{ id: 'req_unknown_validation', question_id: 'q1', text: 'é'.repeat(2049) }, /4096 UTF-8 bytes/],
    [{ id: 'req_unknown_validation', question_id: '../q1', text: 'ok' }, /question_id/],
    [{ id: 'req_unknown_validation', text: 'ok' }, /question_id/],
    [{ id: 'req_unknown_validation', question_id: 'q1', text: 42 }, /text/],
    [{ id: 'req_unknown_validation', question_id: 'q1', text: '-option' }, /dash/],
  ]) {
    const invalid = await call('dalan_answer', args);
    assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, message);
  }
  assert.equal((await call('dalan_questions', {})).isError, true);
  assert.equal((await call('dalan_questions', { id: 'bad/id' })).isError, true);
  assert.equal((await call('dalan_questions', { id: 'req_unknown_validation', extra: true })).isError, true);

  // dalan_status reaches the bridge through the admin socket.
  const status = await call('dalan_status', {});
  assert.notEqual(status.isError, true, JSON.stringify(status));
  assert.equal(typeof textOf(status), 'object');

  // submit -> worker finishes -> wait -> result
  const requestId = `req_${randomUUID()}`;
  const assignment = { schema_version: 1, request_id: requestId, brief: 'Report the exact phrase: mcp roundtrip report.', inputs: [], expected_output: 'Text report.', execution_scope: 'read-only' };
  const forecast = await call('dalan_forecast', { assignment, execution: 'none' });
  assert.notEqual(forecast.isError, true, JSON.stringify(forecast));
  const forecastAnswer = textOf(forecast);
  assert.equal(forecastAnswer.verdict,'admissible');
  assert.ok(forecastAnswer.admission);
  assert.ok(Object.keys(forecastAnswer).every(key=>['verdict','reasons','admission','track_record'].includes(key)));
  assert.equal((await call('dalan_result', { request_id: requestId })).isError, true, 'forecast did not queue the request');
  const invalid = { ...assignment, brief: '' };
  const badForecast = await call('dalan_forecast', { assignment: invalid, execution: 'none' });
  const dryRun = await call('dalan_submit', { assignment: invalid, execution: 'none', dry_run: true });
  assert.equal(badForecast.isError, true);
  assert.equal(dryRun.isError, true);
  assert.equal(textOf(badForecast).verdict, textOf(dryRun).verdict);
  assert.deepEqual(textOf(badForecast).reasons, textOf(dryRun).reasons);

  // The CLI verbs: `dalan forecast` is a dry-run submit and queues nothing; `dalan correct` refuses a flag in the request id slot.
  const cli = (args, input) => new Promise(resolve => { const child = execFile(process.execPath, [path.join(repo, 'bin/dalan.mjs'), ...args], { env, cwd: repo }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })); if (input !== undefined) child.stdin.end(input); });
  const cliId = `req_${randomUUID()}`;
  const cliForecast = await cli(['forecast', '--stdin', '--execution', 'none', '--json'], JSON.stringify({ ...assignment, request_id: cliId }));
  assert.equal(cliForecast.code, 0, cliForecast.stderr);
  const cliEnvelope=JSON.parse(cliForecast.stdout);
  assert.equal(cliEnvelope.verdict,forecastAnswer.verdict);
  assert.deepEqual(cliEnvelope.reasons,forecastAnswer.reasons);
  assert.ok(cliEnvelope.admission,cliForecast.stdout);
  assert.equal((await call('dalan_result', { request_id: cliId })).isError, true, 'dalan forecast did not queue the request');
  const noJob=await cli(['forecast']);
  assert.equal(noJob.code,1,noJob.stderr+noJob.stdout);
  for(const option of ['--file','--stdin','--brief']) assert.ok((noJob.stderr+noJob.stdout).includes(option),option);
  const badId=await cli(['correct','bad id','--json']);
  assert.equal(badId.code,2,badId.stderr+badId.stdout);
  assert.match(JSON.parse(badId.stderr).error,/usage: dalan correct REQUEST_ID/);
  for (const bad of [['correct', '--revises', 'req_aaaaaaaa'], ['correct', '--dry-run'], ['correct']]) {
    const run = await cli(bad);
    assert.equal(run.code, 2, `${bad.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, /usage: dalan correct REQUEST_ID/);
  }

  const submitted = await call('dalan_submit', { assignment, execution: 'none' });
  assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
  assert.ok(JSON.stringify(textOf(submitted)).includes(requestId), 'submit returns the request id');
  assert.equal(textOf(submitted).recovery.get, `dalan get ${requestId}`);

  // A resubmission of the same assignment is idempotent, as in the CLI.
  const again = await call('dalan_submit', { assignment, execution: 'none' });
  assert.notEqual(again.isError, true, JSON.stringify(again));

  const early = await call('dalan_wait', { request_id: requestId, timeout_seconds: 1 });
  assert.notEqual(early.isError, true, 'a wait timeout is a state, not an error');
  assert.equal(textOf(early).status, 'timeout');
  const notFinished = await call('dalan_result', { request_id: requestId });
  assert.notEqual(notFinished.isError, true);
  assert.notEqual(textOf(notFinished).status, 'finished');

  const { claim_id } = await workerCall('claim', { request_id: requestId, claimant: 'acme-agent' });
  // openSession is a real generic worker client; questions-v1 exposes identified questions.
  const questionId = 'roundtrip.question';
  await workerCall('ask_question', { request_id: requestId, claim_id, question_id: questionId, text: 'Which report phrase?', purpose: 'clarification' });
  const waiting = await call('dalan_wait', { request_id: requestId, timeout_seconds: 1 });
  assert.notEqual(waiting.isError, true);
  assert.equal(textOf(waiting).status, 'question');
  const questions = await call('dalan_questions', { id: requestId });
  assert.notEqual(questions.isError, true);
  assert.ok(textOf(questions).questions.some(q => q.question_id === questionId));
  // Exactly 4096 UTF-8 bytes is allowed. Preserve the exact text through the CLI journal.
  const answerText = 'é'.repeat(2048);
  const answerArgs = { id: requestId, question_id: questionId, text: answerText };
  const answered = await call('dalan_answer', answerArgs);
  assert.notEqual(answered.isError, true, JSON.stringify(answered));
  assert.notEqual((await call('dalan_answer', answerArgs)).isError, true, 'exact retry uses saved journal');
  const mismatch = await call('dalan_answer', { ...answerArgs, text: 'different' });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /answer_text_mismatch|different text/);
  const answeredQuestions = textOf(await call('dalan_questions', { id: requestId }));
  assert.equal(answeredQuestions.questions.find(q => q.question_id === questionId).answer, answerText);
  await workerCall('consume_answer', { request_id: requestId, claim_id, question_id: questionId });
  await workerCall('finish', { request_id: requestId, claim_id, outcome: 'completed', summary: 'mcp roundtrip report', result: 'mcp roundtrip report' });
  const waited = await call('dalan_wait', { request_id: requestId, timeout_seconds: 20 });
  assert.notEqual(waited.isError, true, JSON.stringify(waited));
  assert.equal(textOf(waited).status, 'finished');
  const result = await call('dalan_result', { request_id: requestId });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(textOf(result).status, 'finished');
  assert.equal(textOf(result).report.result, 'mcp roundtrip report');
  assert.deepEqual(result.structuredContent, textOf(result));
  const accepted = await call('dalan_accept', { request_id: requestId, verdict: 'accept', note: 'fixture accepts' });
  assert.notEqual(accepted.isError, true, JSON.stringify(accepted));

  // Correction records lineage but does not cancel the predecessor; cancellation is separate.
  const cancelId = `req_${randomUUID()}`;
  const revisedId = `req_${randomUUID()}`;
  assert.notEqual((await call('dalan_submit', { assignment: { ...assignment, request_id: cancelId }, execution: 'none' })).isError, true);
  const revised = await call('dalan_correct', { revises: cancelId, assignment: { ...assignment, request_id: revisedId }, execution: 'none' });
  assert.notEqual(revised.isError, true, JSON.stringify(revised));
  assert.equal(textOf(revised).request_id, revisedId);
  assert.notEqual(revisedId, cancelId);
  assert.equal(JSON.parse(await dalan(['get', revisedId, '--json'])).revises?.request_id, cancelId);
  const cliPrior=`req_${randomUUID()}`, cliReplacement=`req_${randomUUID()}`;
  const created=await call('dalan_submit',{assignment:{...assignment,request_id:cliPrior},execution:'none'});
  assert.notEqual(created.isError,true,JSON.stringify(created));
  const corrected=await cli(['correct',cliPrior,'--stdin','--execution','none','--json'],
    JSON.stringify({...assignment,request_id:cliReplacement}));
  assert.equal(corrected.code,0,corrected.stderr+corrected.stdout);
  assert.equal(JSON.parse(corrected.stdout).request_id,cliReplacement);
  assert.equal(JSON.parse(await dalan(['get',cliReplacement,'--json'])).revises?.request_id,cliPrior);
  const correctedResult=await call('dalan_result',{request_id:cliReplacement});
  assert.notEqual(correctedResult.isError,true,JSON.stringify(correctedResult));
  assert.equal(textOf(correctedResult).status,'queued');
  assert.equal(textOf(await call('dalan_result', { request_id: cancelId })).status, 'queued');
  const cancelled = await call('dalan_cancel', { request_id: cancelId, reason: 'fixture cleanup' });
  assert.notEqual(cancelled.isError, true, JSON.stringify(cancelled));
  const cancellation = textOf(cancelled);
  assert.equal(cancellation.status, 'cancelled', JSON.stringify(cancellation));
  assert.equal(textOf(await call('dalan_result', { request_id: cancelId })).status, 'cancelled');
  assert.equal((await call('dalan_accept', { request_id: 'req_unknown_verdict', verdict: 'accept' })).isError, true);
  for (const bad of ['-option', 'contains\u0000nul']) {
    for (const [name, args] of [
      ['dalan_cancel', { request_id: revisedId, reason: bad }],
      ['dalan_accept', { request_id: revisedId, verdict: 'reject', note: bad }],
    ]) {
      const refused = await call(name, args);
      assert.equal(refused.isError, true, name);
      assert.match(refused.content[0].text, /dash or contain NUL/);
    }
  }
  assert.equal(textOf(await call('dalan_result', { request_id: revisedId })).status, 'queued');

  // Redaction and the size cap apply to a finished report.
  const bigId = `req_${randomUUID()}`;
  await call('dalan_submit', { assignment: { ...assignment, request_id: bigId }, execution: 'none' });
  const bigClaim = await workerCall('claim', { request_id: bigId, claimant: 'acme-agent' });
  const secretLine = `token ${'ghp_'}${'a1B2c3D4e5F6g7H8i9J0k1L2'}`;
  await workerCall('finish', { request_id: bigId, claim_id: bigClaim.claim_id, outcome: 'completed', summary: 'big', result: `${secretLine}\n${'x'.repeat(60_000)}` });
  const big = await call('dalan_result', { request_id: bigId });
  assert.notEqual(big.isError, true, JSON.stringify(big).slice(0, 500));
  assert.ok(!big.content[0].text.includes('a1B2c3D4e5F6g7H8i9J0k1L2'), 'secrets are redacted');
  assert.ok(big.content[0].text.length <= 34_000, `capped: ${big.content[0].text.length}`);
  assert.match(big.content[0].text, /truncated/);
  const rejected = await call('dalan_accept', { request_id: bigId, verdict: 'reject', note: 'fixture rejects' });
  assert.notEqual(rejected.isError, true, JSON.stringify(rejected));

  // A refused submission is a tool result with isError, carrying the CLI's verdict.
  const refused = await call('dalan_submit', { assignment: { ...assignment, request_id: `req_${randomUUID()}`, brief: '' }, execution: 'none', dry_run: true });
  assert.equal(refused.isError, true, JSON.stringify(refused));
  assert.match(refused.content[0].text, /"verdict":\s*"(clarify|reject)"/);
  const badShape = await call('dalan_submit', { assignment: { schema_version: 1, brief: 'no id' } });
  assert.equal(badShape.isError, true);
  assert.match(badShape.content[0].text, /request_id/);

  // Bad arguments and unknown ids are tool errors, not crashes or transport errors.
  const noId = await call('dalan_wait', {});
  assert.equal(noId.isError, true);
  const extra = await call('dalan_status', { surprise: true });
  assert.equal(extra.isError, true);
  const unknownRequest = await call('dalan_result', { request_id: 'req_does_not_exist' });
  assert.equal(unknownRequest.isError, true);
  const unknownTool = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  assert.equal((await rpc('no/such', {})).error.code, -32601);
  assert.deepEqual((await rpc('ping', {})).result, {});

  // A malformed frame gets a parse error and the process keeps serving.
  const parseError = new Promise(resolve => pending.set(null, resolve));
  mcp.stdin.write('{this is not json\n');
  const parsed = await parseError;
  assert.equal(parsed.error.code, -32700);
  assert.equal(parsed.id, null);
  assert.equal(mcp.exitCode, null, 'the process survives a malformed frame');
  assert.equal(typeof (await call('dalan_status', {})).content[0].text, 'string');

  // Closing stdin ends the process cleanly.
  mcp.stdin.end();
  const code = await new Promise(resolve => mcp.once('exit', resolve));
  assert.equal(code, 0);
  assert.ok(stdoutLines.length > 10);
  console.log('dalan-mcp-test: ok');
} finally {
  if (mcp && mcp.exitCode === null) mcp.kill('SIGKILL');
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
  if (process.exitCode) console.error(`mcp stderr:\n${stderrChunks.join('')}\nserver log:\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''}`);
  fs.rmSync(home, { recursive: true, force: true });
}
