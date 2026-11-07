// On a terminal, `dalan get` and `dalan wait` print a short human view; piped or with --json they print the JSON.
// A stand-in bridge on the admin socket answers /get and /wait, so the test needs no running server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-get-human-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// A PATH directory whose `dalan` is this checkout's bin, as an npm install puts it there.
const binDir = fs.mkdtempSync(path.join(tmp, 'bin-'));
fs.symlinkSync(path.resolve('bin/dalan.mjs'), path.join(binDir, 'dalan'));
const env = (home, extra = {}) => { const e = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, HOME: home, NO_COLOR: '1', ...extra }; for (const k of ['DALAN_HOME', 'npm_command']) if (!(k in extra)) delete e[k]; return e; };
const fresh = name => { const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
const PTY = 'import os,pty,sys\nos.environ["TERM"]="dumb"\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';
const hasPty = spawnSync('python3', ['-c', 'import pty']).status === 0;
const exec = (command, args, e) => new Promise(resolve => {
  const child = spawn(command, args, { env: e });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  child.on('close', code => resolve({ code, stdout: stdout.replaceAll('\r', ''), stderr }));
  child.stdin.end();
});
const piped = (args, e) => exec(process.execPath, ['bin/dalan.mjs', ...args], e);
const tty = (args, e) => exec('python3', ['-I', '-c', PTY, process.execPath, 'bin/dalan.mjs', ...args], e);

const ID = 'req_human_get_01';
async function bridge(name, body) {
  const home = fresh(name);
  const e = env(fresh(name + '-home'), { DALAN_HOME: home });
  const root = spawnSync(process.execPath, ['bin/dalan.mjs', 'paths', '--data-root'], { env: e, encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(path.join(root, 'receipts'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'receipts', createHash('sha256').update(ID).digest('hex') + '.json'), JSON.stringify({ request_id: ID, token: 't'.repeat(64), body: '', delivery: 'none' }) + '\n', { mode: 0o600 });
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(path.join(root, 'admin.sock'), resolve));
  return { env: e, close: () => new Promise(resolve => server.close(resolve)) };
}
const finished = { request_id: ID, status: 'finished', target_worker: 'local', report: { outcome: 'done', summary: 'Answered the question.', result: 'The answer is 42.' }, claim: {}, assignment: {} };

test('on a terminal, get prints a human view with the result and the next command; piped or --json keeps the JSON', { skip: !hasPty && 'python3 with pty not available' }, async () => {
  const b = await bridge('finished', finished);
  try {
    const human = await tty(['get', ID], b.env);
    assert.equal(human.code, 0, human.stdout);
    const lines = human.stdout.split('\n');
    assert.ok(lines.includes(`Job ${ID}: finished`), human.stdout);
    assert.ok(lines.includes('Worker: local'), human.stdout);
    assert.ok(lines.includes('Summary: Answered the question.'), human.stdout);
    assert.ok(lines.includes('The answer is 42.'), human.stdout);
    assert.ok(lines.includes(`Next: dalan decide ${ID} accepted`), human.stdout);
    assert.doesNotMatch(human.stdout, /"status"|"report"|[{}]/, 'a terminal shows no JSON');
    const asJson = await tty(['get', ID, '--json'], b.env);
    assert.equal(JSON.parse(asJson.stdout.trim().split('\n').at(-1)).report.result, 'The answer is 42.');
    const pipedOut = await piped(['get', ID], b.env);
    assert.equal(pipedOut.code, 0, pipedOut.stderr);
    assert.equal(pipedOut.stdout, JSON.stringify(finished, null, 2) + '\n', 'piped output is today\'s JSON byte for byte');
  } finally { await b.close(); }
});

test('on a terminal, get shows a queued job and a hostile report inertly', { skip: !hasPty && 'python3 with pty not available' }, async () => {
  const q = await bridge('queued', { request_id: ID, status: 'queued', target_worker: 'local', report: null, claim: null, assignment: {} });
  try {
    const out = await tty(['get', ID], q.env);
    assert.ok(out.stdout.split('\n').includes(`Job ${ID}: queued`), out.stdout);
    assert.match(out.stdout, /Next: .*dalan wait /);
    assert.doesNotMatch(out.stdout, /decide/, 'an unfinished job offers no decision');
  } finally { await q.close(); }
  const h = await bridge('hostile', { ...finished, report: { outcome: 'done', summary: 'ok\u001b]52;c;SGVsbG8=\u0007', result: 'r\u009b31m' } });
  try {
    const out = await tty(['get', ID], h.env);
    assert.doesNotMatch(out.stdout, /[\u001b\u0007\u009b]/);
    assert.ok(out.stdout.includes('\\x1b]52;c;SGVsbG8=\\x07'), out.stdout);
  } finally { await h.close(); }
});

test('on a terminal, wait prints one human line and keeps its exit code; piped or --json keeps the JSON', { skip: !hasPty && 'python3 with pty not available' }, async () => {
  const done = await bridge('wait-done', { request_id: ID, status: 'finished' });
  try {
    const human = await tty(['wait', ID], done.env);
    assert.equal(human.code, 0, human.stdout);
    assert.ok(human.stdout.split('\n').includes(`Job ${ID}: finished. Read it with: dalan get ${ID}`), human.stdout);
    assert.doesNotMatch(human.stdout, /[{}]/);
    assert.equal((await piped(['wait', ID], done.env)).stdout, JSON.stringify({ request_id: ID, status: 'finished' }) + '\n');
    assert.match((await tty(['wait', ID, '--json'], done.env)).stdout, /"status":"finished"/);
  } finally { await done.close(); }
  const late = await bridge('wait-timeout', { request_id: ID, status: 'timeout' });
  try {
    const human = await tty(['wait', ID, '--timeout', '5'], late.env);
    assert.equal(human.code, 124, human.stdout);
    assert.doesNotMatch(human.stdout, /[{}]/);
  } finally { await late.close(); }
});

test('the terminal get view shows worker blockers and questions, evidence and the full-record command', async () => {
  const { formatGetSummary } = await import('../src/get-summary.mjs');
  const claimed = formatGetSummary({ status: 'claimed', target_worker: 'local', progress: [{ note: 'Reading files' }, { note: 'QUESTION: which branch?' }, { note: 'BLOCKED: missing input' }] }, { id: ID, cli: 'dalan' });
  assert.match(claimed, /^Worker asks or is blocked:$/m, claimed);
  assert.match(claimed, /^ {2}QUESTION: which branch\?$/m, claimed);
  assert.match(claimed, /^ {2}BLOCKED: missing input$/m, claimed);
  assert.doesNotMatch(claimed, /Reading files/, claimed);
  assert.match(claimed, /dalan note req_human_get_01 /, claimed);
  const withEvidence = formatGetSummary({ ...finished, artifacts: [{ id: 'art_1' }, { id: 'art_2' }], checks: [{ check_id: 'default', status: 'passed' }] }, { id: ID, cli: 'dalan' });
  assert.match(withEvidence, /^Evidence: 2 artifacts, 1 check$/m, withEvidence);
  for (const view of [claimed, withEvidence, formatGetSummary(finished, { id: ID, cli: 'dalan' })])
    assert.match(view, /^Full record: dalan get req_human_get_01 --json$/m, view);
});

test('on a terminal, decide prints one line; piped or --json keeps the JSON', { skip: !hasPty && 'python3 with pty not available' }, async () => {
  const b = await bridge('decide', { ok: true });
  try {
    const human = await tty(['decide', ID, 'accepted'], b.env);
    assert.equal(human.code, 0, human.stdout);
    assert.equal(human.stdout.trim(), `Recorded ${ID} as accepted.`);
    for (const args of [['decide', ID, 'accepted'], ['decide', ID, 'accepted', '--json']]) {
      const out = args.includes('--json') ? await tty(args, b.env) : await piped(args, b.env);
      assert.doesNotMatch(out.stdout, /Recorded/);
      assert.deepEqual(JSON.parse(out.stdout), { ok: true });
    }
  } finally { await b.close(); }
});
