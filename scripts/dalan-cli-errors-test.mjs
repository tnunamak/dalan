// A first-time user's errors: each names what failed, the specific cause and the exact next command, and exits non-zero.
// The bridge is absent or a small stand-in on the admin socket, so the test needs no running server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-err-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const realHome = path.join(tmp, 'h');
const trial = path.join(realHome, '.local/share/dalan-trial');
fs.mkdirSync(trial, { recursive: true });
fs.writeFileSync(path.join(trial, '.dalan-trial'), '');
// `dalan` on PATH is this checkout's bin, as after an npm install, so the commands the CLI prints read `dalan …`.
const binDir = path.join(tmp, 'bin');
fs.mkdirSync(binDir);
fs.symlinkSync(path.resolve('bin/dalan.mjs'), path.join(binDir, 'dalan'));
const env = extra => { const e = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, HOME: realHome, NO_COLOR: '1', ...extra }; for (const k of ['DALAN_HOME', 'npm_command', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) if (!(k in extra)) delete e[k]; return e; };
const dalan = (args, extra = { DALAN_HOME: trial }, input) => spawnSync(process.execPath, ['bin/dalan.mjs', ...args], { env: env(extra), encoding: 'utf8', input });
const dataRoot = dalan(['paths', '--data-root']).stdout.trim();
const job = path.join(tmp, 'first-job.json');
fs.writeFileSync(job, JSON.stringify({ schema_version: 1, request_id: 'req_errors_test_0001', brief: 'Report the exact phrase: hi.', inputs: [], expected_output: 'hi', execution_scope: 'read-only' }));
const quote = value => `'${value}'`;

test('a stopped trial bridge is reported as not running, with the command that starts it', () => {
  for (const args of [['status'], ['submit', '--file', job]]) {
    const run = dalan(args);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /^dalan: cannot reach the bridge: the trial bridge in .* is not running \(connect (ENOENT|ECONNREFUSED) /m, args[0]);
    assert.ok(run.stderr.includes(`dalan try --home ${quote(trial)}`), run.stderr);
  }
  const json = JSON.parse(dalan(['status', '--json']).stderr);
  assert.equal(json.kind, 'transport');
  assert.match(json.fix.join('\n'), /dalan try --home/);
});

test('a socket file with no listener is reported the same way', () => {
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const sock = path.join(dataRoot, 'admin.sock');
  // A process that exits while listening leaves its socket file behind, as a stopped bridge does.
  spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)},()=>process.exit(0))`]);
  try {
    const run = dalan(['status']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /cannot reach the bridge: the trial bridge in .* is not running \(connect ECONNREFUSED /);
  } finally { fs.rmSync(sock, { force: true }); }
});

test('a home that is not a trial home names DALAN_HOME and the setup guide instead', () => {
  const other = path.join(tmp, 'manual');
  fs.mkdirSync(other);
  const run = dalan(['status'], { DALAN_HOME: other });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^dalan: cannot reach the bridge: no bridge is running for DALAN_HOME=/m);
  assert.match(run.stderr, /docs\/manual-setup\.md#owner-and-requester-setup/);
});

test('an unknown request ID names the ID and the command that lists your jobs', () => {
  for (const command of ['get', 'wait']) {
    const run = dalan([command, 'nope-123']);
    assert.equal(run.status, 1, command);
    assert.match(run.stderr, /^dalan: no job "nope-123" in this bridge home: /m, command);
    assert.match(run.stderr, /list your jobs with: dalan inbox --all$/m, command);
    assert.doesNotMatch(run.stderr, /ENOENT|receipts\//, command);
    const json = JSON.parse(dalan([command, 'nope-123', '--json']).stderr);
    assert.equal(json.code, 'unknown_request');
  }
  const short = dalan(['get', 'nope']);
  assert.equal(short.status, 1);
  assert.match(short.stderr, /^dalan: invalid request ID "nope": /m);
});

test('submit names a missing job file, bad JSON and a missing field, with what to do next', () => {
  const none = dalan(['submit']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^dalan: submit needs a job: pass --file PATH, --stdin or --brief TEXT/m);
  assert.match(none.stderr, /dalan submit --worker local --execution none --deliver none --file first-job\.json/);

  const missing = dalan(['submit', '--file', path.join(tmp, 'nothing.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^dalan: cannot read the job file ".*nothing\.json": no such file/m);
  assert.doesNotMatch(missing.stderr, /ENOENT: /);

  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{"request_id":');
  const malformed = dalan(['submit', '--file', bad]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /^dalan: the job file ".*bad\.json" is not valid JSON: /m);
  assert.match(malformed.stderr, /run the same dalan submit command again/);
  assert.match(dalan(['submit', '--stdin'], undefined, '{').stderr, /^dalan: the job on standard input is not valid JSON: /m);

  const noId = path.join(tmp, 'noid.json');
  fs.writeFileSync(noId, '{"brief":"hi","inputs":[]}');
  const field = dalan(['submit', '--file', noId]);
  assert.equal(field.status, 1);
  assert.match(field.stderr, /^dalan: the job has no valid request_id: /m);
  assert.match(field.stderr, /randomUUID/);

  const noInputs = path.join(tmp, 'noinputs.json');
  fs.writeFileSync(noInputs, '{"request_id":"req_errors_test_0002"}');
  assert.match(dalan(['submit', '--file', noInputs]).stderr, /^dalan: the job has no inputs array: [^\n]*\ndalan: fix: add "inputs": \[\]/m);
});

test('an unknown option names the option and the help command', () => {
  for (const args of [['status', '--bogus'], ['submit', '--file', job, '--bogus'], ['get', 'req_errors_test_0001', '--bogus'], ['wait', 'req_errors_test_0001', '--bogus']]) {
    const run = dalan(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.equal(run.stderr.split('\n')[0], `dalan: ${args[0]}: unknown option "--bogus". See the options with: dalan ${args[0]} --help`);
  }
});

test('doctor runs with no bridge home selected and reports that as one finding with the fix', () => {
  for (const extra of [{}, { DALAN_HOME: '' }]) {
    const run = dalan(['doctor'], extra);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /DALAN_HOME is not set, so/);
    const findings = run.stdout.split('\n').filter(line => /bridge home/.test(line));
    assert.equal(findings.length, 1, run.stdout);
    assert.match(findings[0], /^WARNING: no bridge home selected: DALAN_HOME is not set/);
    assert.ok(run.stdout.includes(`export DALAN_HOME=${quote(trial)}`), run.stdout);
    assert.match(run.stdout, /^host executor: /m);
    const json = JSON.parse(dalan(['doctor', '--json'], extra).stdout);
    assert.equal(json.bridge_home.selected, false);
    assert.match(json.bridge_home.fix, /export DALAN_HOME=/);
  }
});

test('doctor reports disabled host checks as optional, not as a failure', { skip: process.platform !== 'linux' }, () => {
  const run = dalan(['doctor'], { DALAN_HOME: '', DALAN_HOST_CHECKS: '' });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split('\n').find(entry => /^host executor: /.test(entry));
  assert.match(line, /off \(optional: only jobs that run checks on this computer need it; a first job does not\)/);
  assert.doesNotMatch(run.stdout, /not ready \(resource_limits_unavailable: host checks are disabled/);
  const json = JSON.parse(dalan(['doctor', '--json'], { DALAN_HOME: '', DALAN_HOST_CHECKS: '' }).stdout);
  assert.match(json.host_executor.reason, /^resource_limits_unavailable: host checks are disabled/, '--json keeps the reason');
  assert.equal(json.host_executor.ready, false);
  assert.equal(json.host_executor.checks_disabled, true);
});

test('a wait that times out says the job is still open and how to keep waiting, and exits 124', async () => {
  // A stand-in bridge on the admin socket that answers every wait with a timeout, as the real bridge does.
  const home = path.join(tmp, 'waiting');
  fs.mkdirSync(home);
  const root = spawnSync(process.execPath, ['bin/dalan.mjs', 'paths', '--data-root'], { env: env({ DALAN_HOME: home }), encoding: 'utf8' }).stdout.trim();
  const id = 'req_errors_wait_0001';
  fs.mkdirSync(path.join(root, 'receipts'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'receipts', `${createHash('sha256').update(id).digest('hex')}.json`), JSON.stringify({ request_id: id, token: 't', body: '{}', delivery: 'none' }), { mode: 0o600 });
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'timeout', report_summary: null, blocker_text: null, artifact_ids: [] })); });
  await new Promise(resolve => server.listen(path.join(root, 'admin.sock'), resolve));
  try {
    const run = await new Promise(resolve => {
      const child = spawn(process.execPath, ['bin/dalan.mjs', 'wait', id, '--timeout', '2'], { env: env({ DALAN_HOME: home }) });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', b => { stderr += b; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(run.code, 124);
    assert.equal(JSON.parse(run.stdout).status, 'timeout');
    assert.match(run.stderr, new RegExp(`^dalan: wait timed out after 2 s: job ${id} is not finished yet`, 'm'));
    assert.ok(run.stderr.includes(`dalan wait ${id} --timeout 3600`), run.stderr);
    assert.ok(run.stderr.includes(`dalan get ${id}`), run.stderr);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
