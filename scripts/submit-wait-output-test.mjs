// `dalan submit --wait` must print the request ID and the worker prompt as soon as the job is queued, not after the wait ends.
// A stand-in bridge on the admin socket holds /wait open, so the test sees what the CLI has printed while it still waits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-sw-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const env = (home, extra = {}) => { const e = { ...process.env, HOME: home, NO_COLOR: '1', ...extra }; for (const k of ['DALAN_HOME', 'DALAN_WORKERS_FILE', 'npm_command', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) if (!(k in extra)) delete e[k]; return e; };
const fresh = name => { const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
const PTY = 'import os,pty,sys\nos.environ["TERM"]="dumb"\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';
const HOLD_MS = 1500;

async function bridge(home) {
  const init = spawnSync(process.execPath, ['bin/dalan.mjs', 'init', '--worker', 'local', '--public-url', 'http://127.0.0.1:8799'], { env: env(fresh('init'), { DALAN_HOME: home, DALAN_LOOPBACK: '1' }), encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const root = spawnSync(process.execPath, ['bin/dalan.mjs', 'paths', '--data-root'], { env: env(fresh('paths'), { DALAN_HOME: home }), encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const state = { waitAnswered: false };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', b => { body += b; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/submit') { const sent = JSON.parse(body); return res.end(JSON.stringify({ request_id: sent.assignment.request_id, status: 'queued', duplicate: false, execution: 'none' })); }
      if (req.url.startsWith('/wait')) return setTimeout(() => { state.waitAnswered = true; res.end(JSON.stringify({ status: 'timeout' })); }, HOLD_MS);
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise(resolve => server.listen(path.join(root, 'admin.sock'), resolve));
  return { state, close: () => new Promise(resolve => server.close(resolve)) };
}

// Runs the CLI and records, per chunk, whether the bridge had already answered /wait when the chunk arrived.
function run(cmd, args, home, state) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: env(fresh('real'), { DALAN_HOME: home }) });
    const out = { stdout: '', stderr: '', earlyStdout: '', earlyStderr: '' };
    child.stdout.on('data', b => { out.stdout += b; if (!state.waitAnswered) out.earlyStdout += b; });
    child.stderr.on('data', b => { out.stderr += b; if (!state.waitAnswered) out.earlyStderr += b; });
    child.on('close', code => resolve({ ...out, code }));
    child.stdin.end();
  });
}
const submit = ['submit', '--brief', 'Say hi.', '--worker', 'local', '--execution', 'none', '--deliver', 'none', '--wait', '--timeout', '1'];

test('piped: the request ID and worker prompt appear on stderr before the wait ends; stdout stays one JSON result; timeout exits 124', async () => {
  const home = fresh('piped'), b = await bridge(home);
  try {
    const out = await run(process.execPath, ['bin/dalan.mjs', ...submit], home, b.state);
    assert.equal(out.code, 124, out.stderr);
    assert.match(out.earlyStderr, /^Request ID: \S+\nSend your worker: Request \S+ is your only job/m, `nothing printed before the wait ended: ${out.stderr}`);
    assert.equal(out.earlyStdout, '');
    assert.equal(JSON.parse(out.stdout).status, 'timeout');
    assert.equal(out.stderr.match(/Request ID:/g).length, 1, 'the ID is printed once');
  } finally { await b.close(); }
});

test('piped --json: stdout is one JSON object and no early lines are printed', async () => {
  const home = fresh('json'), b = await bridge(home);
  try {
    const out = await run(process.execPath, ['bin/dalan.mjs', ...submit, '--json'], home, b.state);
    assert.equal(out.code, 124, out.stderr);
    assert.doesNotMatch(out.stderr, /Request ID:/);
    assert.equal(out.earlyStdout, '');
    assert.equal(JSON.parse(out.stdout).status, 'timeout');
  } finally { await b.close(); }
});

test('on a terminal: the request ID reaches stdout before the wait ends', { skip: spawnSync('python3', ['-c', 'import pty']).status !== 0 && 'python3 with pty not available' }, async () => {
  const home = fresh('tty'), b = await bridge(home);
  try {
    const out = await run('python3', ['-I', '-c', PTY, process.execPath, 'bin/dalan.mjs', ...submit], home, b.state);
    assert.equal(out.code, 124, out.stdout);
    assert.match(out.earlyStdout, /Request ID: \S+/, `nothing printed before the wait ended: ${out.stdout}`);
    assert.match(out.earlyStdout, /Send your worker: /);
  } finally { await b.close(); }
});
