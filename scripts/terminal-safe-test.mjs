// Worker-supplied text reaches the operator's terminal only after control characters are made inert.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { terminalSafe, jsonTerminalSafe } from '../src/terminal-safe.mjs';
import { formatInbox } from '../src/inbox.mjs';

const HOSTILE = 'x\x1b]52;c;SGVsbG8=\x07 \x1b[2J \x9b31m end\x7f';
const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-term-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

test('terminalSafe escapes controls and keeps newline and tab', () => {
  const out = terminalSafe(`a\nb\tc${HOSTILE}`);
  assert.doesNotMatch(out, RAW);
  assert.match(out, /^a\nb\tc/);
  assert.ok(out.includes('\\x1b]52;c;SGVsbG8=\\x07') && out.includes('\\x9b31m'));
});

test('jsonTerminalSafe keeps JSON valid and the string exact', () => {
  const text = JSON.stringify({ result: HOSTILE });
  const safe = jsonTerminalSafe(text);
  assert.doesNotMatch(safe, RAW);
  assert.equal(JSON.parse(safe).result, HOSTILE);
});

test('inbox lines carry no raw control bytes', () => {
  const inbox = { total: 1, counts: { question: 1 }, hidden_older: 0, items: [{ group: 'question', request_id: 'r', worker: 'w', status: 's', updated_at: '', title: HOSTILE, text: HOSTILE, next: [HOSTILE] }] };
  assert.doesNotMatch(formatInbox(inbox), RAW);
});

// A stand-in bridge that answers /get with hostile report and error text.
async function bridge(home, report) {
  const env = { ...process.env, HOME: path.join(tmp, 'h-' + path.basename(home)), DALAN_HOME: home };
  fs.mkdirSync(env.HOME, { recursive: true });
  const paths = await new Promise(resolve => { let o = ''; const c = spawn(process.execPath, ['bin/dalan.mjs', 'paths', '--data-root'], { env }); c.stdout.on('data', b => { o += b; }); c.on('close', () => resolve(o.trim())); });
  fs.mkdirSync(path.join(paths, 'receipts'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths, 'receipts', createHash('sha256').update('req_term').digest('hex') + '.json'), JSON.stringify({ request_id: 'req_term', token: 't'.repeat(64), body: '', delivery: 'none' }) + '\n', { mode: 0o600 });
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(report)); });
  await new Promise(resolve => server.listen(path.join(paths, 'admin.sock'), resolve));
  return { env, close: () => new Promise(resolve => server.close(resolve)) };
}
const run = (args, env) => new Promise(resolve => {
  const child = spawn(process.execPath, ['bin/dalan.mjs', ...args], { env: { ...env, NO_COLOR: '1' } });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end();
});

test('dalan get prints report, error and activity text without raw control bytes; --json round-trips', async () => {
  const body = { request_id: 'req_term', status: 'finished', report: { outcome: 'done', summary: HOSTILE, result: HOSTILE }, claim: { activity: { tool_calls: 1, last_tool: 'read_file', last_tool_at: '2026-01-01T00:00:00Z', last_tool_error: HOSTILE } }, assignment: {} };
  const b = await bridge(path.join(tmp, 'home-get'), body);
  try {
    const human = await run(['get', 'req_term'], b.env);
    assert.equal(human.code, 0, human.stderr);
    assert.doesNotMatch(human.stdout, RAW); assert.doesNotMatch(human.stderr, RAW);
    assert.ok(human.stdout.includes('SGVsbG8='));
    const json = await run(['get', 'req_term', '--json'], b.env);
    assert.doesNotMatch(json.stdout, RAW);
    assert.equal(JSON.parse(json.stdout).report.result, HOSTILE);
  } finally { await b.close(); }
});

test('a bridge error naming a hostile path prints inert on stderr', async () => {
  const home = path.join(tmp, 'home-err');
  const b = await bridge(home, {});
  await b.close();
  const server = http.createServer((req, res) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: `path outside scope: ${HOSTILE}` })); });
  const paths = await new Promise(resolve => { let o = ''; const c = spawn(process.execPath, ['bin/dalan.mjs', 'paths', '--data-root'], { env: b.env }); c.stdout.on('data', x => { o += x; }); c.on('close', () => resolve(o.trim())); });
  fs.rmSync(path.join(paths, 'admin.sock'), { force: true });
  await new Promise(resolve => server.listen(path.join(paths, 'admin.sock'), resolve));
  try {
    const out = await run(['get', 'req_term'], b.env);
    assert.notEqual(out.code, 0);
    assert.doesNotMatch(out.stderr + out.stdout, RAW);
    assert.ok(out.stderr.includes('\\x1b[2J'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('dalan try shows a hostile report inert before the acceptance prompt', async () => {
  const { finishedNotice } = await import('../src/try.mjs');
  const shown = finishedNotice('req_term', { report: { result: HOSTILE } });
  assert.doesNotMatch(shown, RAW);
  assert.ok(shown.includes('\\x1b]52;c;SGVsbG8=\\x07'));
});

test('stored and alerted error notes carry no raw control bytes', async () => {
  const { redactNote } = await import('../src/alerts.mjs');
  assert.doesNotMatch(redactNote(`path outside scope: ${HOSTILE}`), RAW);
});
