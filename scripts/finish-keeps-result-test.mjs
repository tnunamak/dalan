#!/usr/bin/env node
// A worker that finishes with a good result must not lose it to a fixable summary or note problem.
// Workers often do not retry after a validation error, so these cases are accepted and marked instead of refused.
import http from 'node:http';
import { tmpdir } from 'node:os';
import { fixtureEnv } from '../src/test-support/fixture-env.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const repo = resolve(new URL('..', import.meta.url).pathname);
const home = await mkdtemp(join(tmpdir(), 'dalan-finish-keeps-'));
let port;
const children = new Set();
const env = { ...fixtureEnv(home), HOME: home, DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1', DOT_BRIDGE_T3_DRY_RUN: '1',
  DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_PORT: '0' };
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function run(argv, input) {
  return new Promise(done => {
    const child = spawn(argv[0], argv.slice(1), { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', c => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });
    child.on('close', code => done({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}
async function startService() {
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.setEncoding('utf8').on('data', c => { output += c; const m = output.match(/MCP listening on 127\.0\.0\.1:(\d+)/); if (m) port = Number(m[1]); });
  child.stderr.setEncoding('utf8').on('data', c => process.stderr.write(c));
  for (let i = 0; i < 280 && !port; i++) await new Promise(r => setTimeout(r, 25));
  assert(port, 'service did not start');
  return child;
}
async function stopService(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(r => child.once('exit', r));
  const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(kill); }
}
let secret;
async function call(name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
  const body = await response.json();
  const text = body.result.content[0].text;
  return { isError: !!body.result.isError, text, data: body.result.isError ? null : JSON.parse(text) };
}
async function newClaim(label) {
  const requestId = `req_${randomUUID()}`;
  const payload = { schema_version: 1, request_id: requestId, brief: `finish keeps result: ${label}`, inputs: [], expected_output: 'one line', execution_scope: 'read-only' };
  const submit = await run([process.execPath, 'bin/dalan.mjs', 'submit', '--deliver', 'none', '--stdin', '--json'], JSON.stringify(payload));
  assert(submit.code === 0, `submit failed ${submit.stderr}`);
  const claim = await call('claim', { request_id: requestId, claimant: 'fake-worker' });
  assert(!claim.isError, `claim failed ${claim.text}`);
  return { requestId, claimId: claim.data.claim_id };
}
const stored = async requestId => JSON.parse((await run([process.execPath, 'bin/dalan.mjs', 'get', requestId, '--json'])).stdout);
const reportOf = async requestId => (await stored(requestId)).report;

async function main() {
  await mkdir(join(home, '.config', 'dot-bridge'), { recursive: true });
  let service = await startService();
  secret = (await readFile(join(home, '.config', 'dot-bridge', 'env'), 'utf8')).match(/BRIDGE_PATH_SECRET=(.+)/)[1];

  // 1. No summary at all: the report is stored with a summary taken from the first non-empty line of the result.
  let job = await newClaim('missing summary');
  const result = '\n   \n  Verdict: the cache key is wrong  \nDetails follow.\n';
  let finish = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'completed', result });
  assert(!finish.isError, `finish without summary was refused: ${finish.text}`);
  assert(finish.data.summary_derived === true && finish.data.result_authority === true, `receipt must say the summary was derived: ${finish.text}`);
  let report = await reportOf(job.requestId);
  assert(report?.result === result && report.summary === 'Verdict: the cache key is wrong', `stored report wrong: ${JSON.stringify(report)}`);
  const retry = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'completed', result });
  assert(!retry.isError && retry.data.duplicate === true && retry.data.receipt_id === finish.data.receipt_id, `retry without summary must replay the receipt: ${retry.text}`);
  const changed = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'completed', summary: 'other', result });
  assert(changed.isError && /different stored report.*do not call finish again/is.test(changed.text), `contradictory finish text: ${changed.text}`);
  const late = await call('progress', { request_id: job.requestId, claim_id: job.claimId, note: 'late' });
  assert(late.isError && /finished or cancelled.*list_pending/is.test(late.text), `terminal progress text: ${late.text}`);
  console.log('PASS finish without summary keeps the result');

  // 2. Empty and blank summary behave the same.
  for (const blank of ['', '   ']) {
    job = await newClaim(`blank summary ${blank.length}`);
    finish = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'blocked', summary: blank, result: 'Blocked on the missing key' });
    assert(!finish.isError && finish.data.summary_derived === true, `blank summary refused: ${finish.text}`);
    report = await reportOf(job.requestId);
    assert(report.outcome === 'blocked' && report.summary === 'Blocked on the missing key', `blank summary report: ${JSON.stringify(report)}`);
  }
  console.log('PASS empty and blank summary');

  // 3. A long derived summary is capped at the 4096-byte limit on a character boundary.
  job = await newClaim('long first line');
  const longLine = 'é'.repeat(3000);
  finish = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'completed', result: `${longLine}\nrest` });
  assert(!finish.isError, `long first line refused: ${finish.text}`);
  report = await reportOf(job.requestId);
  assert(Buffer.byteLength(report.summary) <= 4096 && report.summary.length > 1000 && /^é+$/.test(report.summary), 'derived summary must be capped on a character boundary');
  console.log('PASS derived summary is capped');

  // 4. A given summary over the limit is truncated and marked, not refused.
  job = await newClaim('long summary');
  finish = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'completed', summary: 'x'.repeat(5000), result: 'done' });
  assert(!finish.isError && finish.data.summary_truncated === true && finish.data.summary_derived !== true, `long summary: ${finish.text}`);
  report = await reportOf(job.requestId);
  assert(Buffer.byteLength(report.summary) === 4096 && report.result === 'done', 'truncated summary must be exactly the limit');
  console.log('PASS long summary is truncated');

  // 5. A normal summary is stored as given, with no marker.
  job = await newClaim('normal');
  finish = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'completed', summary: 'all good', result: 'details' });
  assert(!finish.isError && !('summary_derived' in finish.data) && !('summary_truncated' in finish.data), `normal finish gained a marker: ${finish.text}`);
  console.log('PASS normal finish unchanged');

  // 6. A progress note over the limit is truncated, not refused.
  job = await newClaim('long note');
  const progress = await call('progress', { request_id: job.requestId, claim_id: job.claimId, note: 'n'.repeat(5000) });
  assert(!progress.isError && progress.data.recorded === true && progress.data.note_truncated === true, `long note: ${progress.text}`);
  const closed = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'completed', summary: 'done', result: 'done' });
  assert(!closed.isError, `close note job: ${closed.text}`);
  console.log('PASS long progress note is truncated');

  // 7. Refusals that must stay say what to do next.
  const refusals = [
    ['empty result', { outcome: 'completed', summary: 's', result: '' }, /result.*call finish again/is],
    ['blank result without summary', { outcome: 'completed', result: '  \n ' }, /result.*call finish again/is],
    ['oversize result', { outcome: 'completed', summary: 's', result: 'r'.repeat(262145) }, /262144.*call finish again/is],
    ['bad outcome', { outcome: 'done', summary: 's', result: 'r' }, /outcome.*completed.*blocked.*failed.*call finish again/is],
    ['missing result', { outcome: 'completed', summary: 's' }, /result.*call finish again/is],
  ];
  job = await newClaim('refusals');
  for (const [label, args, pattern] of refusals) {
    const refused = await call('finish', { request_id: job.requestId, claim_id: job.claimId, ...args });
    assert(refused.isError && pattern.test(refused.text), `${label}: refusal must name the fix, got ${refused.text}`);
  }
  const noReport = await reportOf(job.requestId);
  assert(!noReport, 'refused finishes must not store a report');
  const emptyNote = await call('progress', { request_id: job.requestId, claim_id: job.claimId, note: '' });
  assert(emptyNote.isError && /note.*call progress again/is.test(emptyNote.text), `empty note: ${emptyNote.text}`);
  // The claim is still good: the same worker can finish after the refusals above.
  finish = await call('finish', { request_id: job.requestId, claim_id: job.claimId, outcome: 'completed', result: 'second try' });
  assert(!finish.isError, `finish after refusals: ${finish.text}`);
  console.log('PASS kept refusals name the next call');

  // 8. Authority is unchanged: a wrong claim is refused and nothing is stored.
  job = await newClaim('wrong claim');
  const wrong = await call('finish', { request_id: job.requestId, claim_id: `claim_${randomUUID()}`, outcome: 'completed', result: 'no authority' });
  assert(wrong.isError && /claim/i.test(wrong.text) && /list_pending|claim/.test(wrong.text), `wrong claim: ${wrong.text}`);
  assert(!(await reportOf(job.requestId)), 'a wrong claim must not store a report');
  console.log('PASS wrong claim still refused');

  await stopService(service);
  console.log('PASS finish-keeps-result');
}
process.on('unhandledRejection', error => { console.error(`FAIL ${error?.message ?? error}`); process.exit(1); });
try { await main(); }
catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
finally { await Promise.all([...children].map(stopService)); await rm(home, { recursive: true, force: true }); }
