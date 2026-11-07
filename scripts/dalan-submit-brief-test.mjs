// `dalan submit --brief TEXT`: a repository-free job built from typed text. A stand-in bridge on the admin socket
// records exactly what the CLI sends, so the test needs no running server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-brief-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const env = (home, extra = {}) => { const e = { ...process.env, HOME: home, NO_COLOR: '1', ...extra }; for (const k of ['DALAN_HOME', 'DALAN_WORKERS_FILE', 'npm_command', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) if (!(k in extra)) delete e[k]; return e; };
const fresh = name => { const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
const run = (args, home, extra, input) => new Promise(resolve => {
  const child = spawn(process.execPath, ['bin/dalan.mjs', ...args], { env: env(home, extra) });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  child.on('close', code => resolve({ code, stdout, stderr }));
  child.stdin.end(input ?? '');
});
const WORKER_PROMPT = id => `Send your worker: Request ${id} is your only job: claim it with Dalan, do what its brief asks, report progress and finish it with the claim_id. Stop if it is missing or cancelled. Claim no other job.`;

// Answers /submit and /submit-preview, keeping every request body.
async function bridge(home) {
  const init = spawnSync(process.execPath, ['bin/dalan.mjs', 'init', '--worker', 'local', '--public-url', 'http://127.0.0.1:8799'], { env: env(fresh('init'), { DALAN_HOME: home, DALAN_LOOPBACK: '1' }), encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const root = spawnSync(process.execPath, ['bin/dalan.mjs', 'paths', '--data-root'], { env: env(fresh('paths'), { DALAN_HOME: home }), encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', b => { body += b; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/submit' || req.url === '/submit-preview') {
        const sent = JSON.parse(body); seen.push({ url: req.url, sent });
        return res.end(JSON.stringify(req.url === '/submit' ? { request_id: sent.assignment.request_id, status: 'queued', duplicate: false, execution: 'none' } : { verdict: 'accept', reasons: [], warnings: [] }));
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise(resolve => server.listen(path.join(root, 'admin.sock'), resolve));
  return { seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test('submit --brief sends a repository-free job with the text byte for byte', async () => {
  const home = fresh('exact'), marker = path.join(tmp, 'PWNED');
  const b = await bridge(home);
  try {
    const text = `  Explain \`touch ${marker}\` and $(touch ${marker}) "quoted" $HOME back\\slash and a 'single' quote.  `;
    const out = await run(['submit', '--brief', text, '--worker', 'local', '--execution', 'none', '--deliver', 'none'], fresh('real'), { DALAN_HOME: home });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(b.seen.length, 1);
    const { url, sent } = b.seen[0];
    assert.equal(url, '/submit');
    assert.equal(sent.worker, 'local');
    assert.equal(sent.execution, 'none');
    assert.equal(sent.delivery, 'none');
    const job = sent.assignment;
    assert.match(job.request_id, /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(job).sort(), ['brief', 'execution_scope', 'expected_output', 'inputs', 'request_id', 'schema_version']);
    assert.equal(job.schema_version, 1);
    assert.equal(job.brief, text);
    assert.deepEqual(job.inputs, []);
    assert.equal(job.expected_output, 'A plain-text answer.');
    assert.equal(job.execution_scope, 'read-only');
    assert.equal(fs.existsSync(marker), false, 'the text was never run by a shell');
    assert.equal(JSON.parse(out.stdout).request_id, job.request_id);
  } finally { await b.close(); }
});

test('each --brief submit gets a fresh request ID', async () => {
  const home = fresh('fresh-id');
  const b = await bridge(home);
  try {
    for (let i = 0; i < 2; i++) assert.equal((await run(['submit', '--brief', 'Say hi.'], fresh('real'), { DALAN_HOME: home })).code, 0);
    assert.notEqual(b.seen[0].sent.assignment.request_id, b.seen[1].sent.assignment.request_id);
  } finally { await b.close(); }
});

test('submit --brief prints the request ID and the worker prompt as their own lines', async () => {
  const home = fresh('human');
  const b = await bridge(home);
  try {
    const out = await run(['submit', '--brief', 'Say hi.'], fresh('real'), { DALAN_HOME: home });
    assert.equal(out.code, 0, out.stderr);
    const id = b.seen[0].sent.assignment.request_id;
    const lines = out.stderr.split('\n');
    assert.ok(lines.includes(`Request ID: ${id}`), out.stderr);
    assert.ok(lines.includes(WORKER_PROMPT(id)), out.stderr);
    const json = await run(['submit', '--brief', 'Say hi.', '--json'], fresh('real'), { DALAN_HOME: home });
    assert.equal(json.code, 0, json.stderr);
    assert.doesNotMatch(json.stdout + json.stderr, /Send your worker/);
  } finally { await b.close(); }
});

// Runs the CLI with its standard output on a pseudo-terminal, as in an interactive shell. The terminal merges
// standard output and standard error, which is what the reader sees.
const PTY = 'import os,pty,sys\nos.environ["TERM"]="dumb"\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';
// Asynchronous, so that the stand-in bridge in this process can answer while the CLI runs.
const runTty = (args, home, extra) => new Promise(resolve => {
  const child = spawn('python3', ['-I', '-c', PTY, process.execPath, 'bin/dalan.mjs', ...args], { env: env(home, extra) });
  let stdout = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stdout += b; });
  child.on('close', status => resolve({ status, stdout }));
  child.stdin.end();
});

test('on a terminal, submit prints the human lines and no JSON; piped, it prints the JSON receipt', { skip: spawnSync('python3', ['-c', 'import pty']).status !== 0 && 'python3 with pty not available' }, async () => {
  const home = fresh('tty');
  const b = await bridge(home);
  try {
    const tty = await runTty(['submit', '--brief', 'Say hi.'], fresh('real'), { DALAN_HOME: home });
    assert.equal(tty.status, 0, tty.stdout + tty.stderr);
    const id = b.seen[0].sent.assignment.request_id;
    const lines = tty.stdout.replaceAll('\r', '').split('\n');
    assert.ok(lines.includes(`Request ID: ${id}`), tty.stdout);
    assert.ok(lines.includes(WORKER_PROMPT(id)), tty.stdout);
    assert.doesNotMatch(tty.stdout, /"status"|"request_id"|[{}]/, 'a terminal shows no JSON receipt');
    const ttyJson = await runTty(['submit', '--brief', 'Say hi.', '--json'], fresh('real'), { DALAN_HOME: home });
    assert.equal(ttyJson.status, 0, ttyJson.stdout);
    assert.match(ttyJson.stdout, /"request_id"/, '--json prints the receipt on a terminal too');
    const piped = await run(['submit', '--brief', 'Say hi.'], fresh('real'), { DALAN_HOME: home });
    assert.equal(piped.code, 0, piped.stderr);
    assert.equal(JSON.parse(piped.stdout).request_id, b.seen[2].sent.assignment.request_id, 'piped output stays the JSON receipt');
  } finally { await b.close(); }
});

test('submit --brief works with --dry-run', async () => {
  const home = fresh('dry');
  const b = await bridge(home);
  try {
    const out = await run(['submit', '--brief', 'Say hi.', '--dry-run'], fresh('real'), { DALAN_HOME: home });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(b.seen[0].url, '/submit-preview');
    assert.equal(b.seen[0].sent.assignment.brief, 'Say hi.');
  } finally { await b.close(); }
});

test('submit takes exactly one of --file, --stdin and --brief', async () => {
  const home = fresh('modes');
  for (const args of [['--brief', 'x', '--stdin'], ['--brief', 'x', '--file', 'job.json'], ['--stdin', '--file', 'job.json'], ['--brief', 'x', '--file', 'job.json', '--stdin']]) {
    const out = await run(['submit', ...args], fresh('real'), { DALAN_HOME: home }, '{}');
    assert.equal(out.code, 1, `${args.join(' ')}: ${out.stderr}`);
    assert.match(out.stderr, /exactly one of --file PATH, --stdin and --brief TEXT|not both|only one/i, args.join(' '));
  }
});

test('submit --brief rejects an empty, blank or missing text', async () => {
  const home = fresh('empty');
  for (const args of [['--brief', ''], ['--brief', '   \n\t '], ['--brief'], ['--brief', '--json']]) {
    const out = await run(['submit', ...args], fresh('real'), { DALAN_HOME: home });
    assert.equal(out.code, 1, `${JSON.stringify(args)}: ${out.stderr}`);
    assert.match(out.stderr, /--brief needs the text of the job/, JSON.stringify(args));
  }
});

test('submit without a job names --brief among the choices', async () => {
  const out = await run(['submit'], fresh('real'), { DALAN_HOME: fresh('none') });
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /--file PATH, --stdin or --brief TEXT/);
});
