// What a newcomer reads from help, doctor, status and submit. The bridge is absent or a small stand-in on the admin
// socket, so the test needs no running server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { COMMANDS } from '../src/cli-help.mjs';
import { formatStatusSummary } from '../src/status-summary.mjs';
import { tryCommand } from '../src/try-command.mjs';
import { DOCS_BASE, docsUrl } from '../src/docs-url.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-first-run-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const env = (home, extra = {}) => { const e = { ...process.env, HOME: home, NO_COLOR: '1', ...extra }; for (const k of ['DALAN_HOME', 'DALAN_WORKERS_FILE', 'DALAN_ENABLE_T3_TOOLS', 'npm_command', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) if (!(k in extra)) delete e[k]; return e; };
const dalan = (args, home, extra) => spawnSync(process.execPath, ['bin/dalan.mjs', ...args], { env: env(home, extra), encoding: 'utf8' });
const run = (args, home, extra, input) => new Promise(resolve => {
  const child = spawn(process.execPath, ['bin/dalan.mjs', ...args], { env: env(home, extra) });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  child.on('close', code => resolve({ code, stdout, stderr }));
  child.stdin.end(input ?? '');
});
const fresh = name => { const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
const JOB_EXAMPLE_URL = docsUrl('docs/manual-setup.md', 'submit-finish-and-read-the-result');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A PATH directory whose `dalan` is this checkout's bin, the way an npm install or npx puts it there.
const binDir = fresh('bin');
fs.symlinkSync(path.resolve('bin/dalan.mjs'), path.join(binDir, 'dalan'));
const onPath = { PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
const underNpx = { ...onPath, npm_command: 'exec' };
const byPath = `node '${fs.realpathSync('bin/dalan.mjs')}'`;

test('the job example link points at the first-job JSON, and that anchor exists', () => {
  assert.match(fs.readFileSync('docs/manual-setup.md', 'utf8'), /<a id="submit-finish-and-read-the-result"><\/a>/);
  assert.equal(JOB_EXAMPLE_URL, `${DOCS_BASE}/docs/manual-setup.md#submit-finish-and-read-the-result`);
});

test('top-level help lists mcp under Everyday and shows the version command', () => {
  const text = dalan(['--help'], fresh('help')).stdout;
  const everyday = text.slice(text.indexOf('Everyday:'), text.indexOf('Operator:'));
  assert.match(everyday, /^ {2}mcp +/m);
  assert.match(text, /dalan --version/);
  assert.equal(dalan(['--version'], fresh('help')).status, 0);
});

test('inbox help states the plain-shell default that the command implements', () => {
  const help = dalan(['inbox', '--help'], fresh('inbox-help')).stdout;
  assert.match(help, /dalan inbox \[--all \| --producer ID\]/);
  assert.doesNotMatch(help, /\(--all \| --producer ID\)/, 'the synopsis must not make a flag look required');
  assert.match(help, /Outside a Claude Code or Codex session, plain dalan inbox lists every producer/);
});

test('try help shows an example and where to go next', () => {
  const text = dalan(['try', '--help'], fresh('help')).stdout;
  assert.match(text, /^Example: dalan try$/m);
  assert.ok(text.includes(docsUrl('README.md', 'connect-your-own-worker')), text);
});

test('try help states the home precedence and the port fallback', () => {
  const text = dalan(['try', '--help'], fresh('help')).stdout;
  assert.match(text, /--home DIR +bridge home; otherwise DALAN_HOME if set \(defaults by mode below\)/);
  assert.match(text, /local mode uses ~\/\.local\/share\/dalan-trial, a temporary public trial creates a new home, and a saved stable route uses ~\/\.local\/share\/dalan-hosted\./);
  assert.match(text, /--port N +bridge port \(default: the home's previous port, else 8799 or the next free port\)/);
});

test('init help shows how to select the bridge home in the loopback example', () => {
  const text = dalan(['init', '--help'], fresh('help')).stdout;
  assert.match(text, /^ {2}export DALAN_HOME="\$HOME\/\.local\/share\/dalan-manual-trial"$/m);
  assert.match(text, /^ {2}export DALAN_LOOPBACK=1$/m);
});

test('the status summary prints the select-home line only when DALAN_HOME is unset or differs', () => {
  const base = { home: '/h/trial', trial: true, now: 0 };
  assert.match(formatStatusSummary(sampleStatus, base), /select this bridge home/);
  assert.match(formatStatusSummary(sampleStatus, { ...base, envHome: '/h/other' }), /select this bridge home/);
  assert.doesNotMatch(formatStatusSummary(sampleStatus, { ...base, envHome: '/h/trial' }), /select this bridge home/);
});

test('submit help shows a synopsis that does not leave out the options it lists', () => {
  assert.match(dalan(['submit', '--help'], fresh('help')).stdout, /^Usage: dalan submit \(--file PATH \| --stdin \| --brief TEXT\) \[options\]$/m);
});

test('help --all hides internal maintenance commands; help --internal lists them, and they still dispatch', () => {
  const home = fresh('help');
  const all = dalan(['help', '--all'], home).stdout, internal = dalan(['help', '--internal'], home);
  assert.equal(internal.status, 0, internal.stderr);
  for (const name of ['backfill-objectives', 'break-usage-backfill', 'verify-stops']) {
    assert.doesNotMatch(all, new RegExp(`^ {2}${name} `, 'm'), name);
    assert.match(internal.stdout, new RegExp(`^ {2}${name} `, 'm'), name);
    assert.match(dalan([name, '--help'], home).stdout, new RegExp(`^Usage: dalan ${name}\\b`, 'm'));
  }
  assert.doesNotMatch(all, /rarely needed|internal or for operators/);
  assert.match(all, /dalan help --internal/);
  for (const c of COMMANDS.filter(c => c.internal)) assert.doesNotMatch(all, new RegExp(`^ {2}${c.name} `, 'm'));
});

test('doctor in a clean home says there is no bridge home yet and never shows the legacy worker', () => {
  const home = fresh('doctor-clean');
  const out = dalan(['doctor'], home);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /no bridge home here yet\. To try Dalan, run: npx @tnunamak\/dalan try/i);
  assert.doesNotMatch(out.stdout, /"dot"|\bdot:|t3 capability|repository access/);
  assert.doesNotMatch(out.stdout, /sandbox-probe-e2e|measured v1/);
});

test('doctor names the selected bridge home on its first line and whether its bridge runs', () => {
  const empty = fresh('doctor-empty');
  const first = dalan(['doctor'], fresh('doctor-real'), { DALAN_HOME: empty }).stdout.split('\n')[0];
  assert.equal(first, `bridge home: ${empty}: no bridge home here yet. To try Dalan, run: npx @tnunamak/dalan try`);
  const made = fresh('doctor-made');
  const init = dalan(['init', '--worker', 'local', '--public-url', 'http://127.0.0.1:8799'], fresh('doctor-real'), { DALAN_HOME: made, DALAN_LOOPBACK: '1' });
  assert.equal(init.status, 0, init.stderr);
  const out = dalan(['doctor'], fresh('doctor-real'), { DALAN_HOME: made });
  assert.equal(out.stdout.split('\n')[0], `bridge home: ${made} (bridge, not running)`);
  assert.doesNotMatch(out.stdout, /DALAN_HOME is not set/);
  assert.doesNotMatch(out.stdout, /"dot"|\bdot:/);
  assert.match(out.stdout, /^ {2}local: /m);
  // A new worker has no repository grants yet. That is the normal state, not a warning or a migration.
  assert.doesNotMatch(out.stdout, /WARNING: worker "local"/);
  assert.doesNotMatch(out.stdout, /legacy-repository-policy-migration/);
  assert.ok(out.stdout.split('\n').includes('worker "local" has no repository grants yet, which is normal for a new worker; repository jobs are denied until you run: dalan worker allow local OWNER/REPO'), out.stdout);
  if (process.platform !== 'darwin') {
    assert.ok(out.stdout.split('\n').includes(`Host checks are off. The first job does not need them; to turn them on, see ${docsUrl('docs/operations.md', 'execution-capability-and-check-evidence')}`), out.stdout);
    assert.doesNotMatch(out.stdout, /sandbox-probe-e2e|measured v1/);
    // One line replaces the list of capabilities that are all unknown while host checks are off.
    assert.ok(out.stdout.split('\n').includes('declared capabilities: not checked while host checks are off'), out.stdout);
    assert.doesNotMatch(out.stdout, /^ {2}[a-z_]+: unknown$/m);
    assert.equal(out.stdout.split('\n').filter(line => line.startsWith('declared capabilities')).length, 1);
    const json = JSON.parse(dalan(['doctor', '--json'], fresh('doctor-real'), { DALAN_HOME: made }).stdout);
    assert.ok(Object.keys(json.backend.capabilities).length >= 10, '--json keeps the full capability list');
  }
});

test('doctor says the bridge is running when its admin socket accepts a connection', async () => {
  const made = fresh('doctor-running');
  const init = dalan(['init', '--worker', 'local', '--public-url', 'http://127.0.0.1:8799'], fresh('doctor-real'), { DALAN_HOME: made, DALAN_LOOPBACK: '1' });
  assert.equal(init.status, 0, init.stderr);
  const bridge = await standIn(made, () => [500, {}]);
  try {
    const out = await run(['doctor'], fresh('doctor-real'), { DALAN_HOME: made });
    assert.equal(out.stdout.split('\n')[0], `bridge home: ${made} (bridge, running)`);
  } finally { await bridge.close(); }
});

const sampleStatus = {
  paused: false, oldest_queue_age_ms: 125_000,
  counts: [{ status: 'finished', count: 2 }, { status: 'queued', count: 1 }],
  by_worker: { local: { counts: [{ status: 'finished', count: 2 }, { status: 'queued', count: 1 }], active_claims: 0, subscriptions_active: 0, last_call_at: null } },
};

test('the status summary names the bridge, each worker and one next step', () => {
  const text = formatStatusSummary(sampleStatus, { home: '/h/trial', url: 'http://127.0.0.1:8799', trial: true, now: Date.parse('2026-11-07T00:00:00Z') });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Bridge: running on http://127.0.0.1:8799 (trial home /h/trial)');
  assert.equal(lines[1], 'Worker local: no calls yet · 1 queued (oldest 2 min) · 2 finished');
  // A trial home needs DALAN_HOME for the follow-up commands, and an inline DALAN_HOME=... status leaves the shell without it.
  assert.equal(lines[2], "In this shell, select this bridge home: export DALAN_HOME='/h/trial'", 'the home line comes right before Next');
  assert.ok(lines[3].startsWith(`Next: send your worker the queued job (to connect a worker first, see ${docsUrl('README.md', 'connect-your-own-worker')})`), lines[3]);
  assert.equal(lines.at(-1), 'Full detail: dalan status --json');
  assert.match(formatStatusSummary(sampleStatus, { home: "/h/it's", trial: true, now: 0 }), /^In this shell, select this bridge home: export DALAN_HOME='\/h\/it'\\''s'$/m, 'the home is shell-quoted');
  assert.equal(lines.filter(l => l.startsWith('Next:')).length, 1);
  const now = Date.parse('2026-11-07T00:00:00Z');
  const busy = formatStatusSummary({ ...sampleStatus, by_worker: { local: { ...sampleStatus.by_worker.local, counts: [{ status: 'finished', count: 2 }], last_call_at: new Date(now - 30_000).toISOString() } } }, { home: '/h', url: null, trial: false, now });
  assert.match(busy, /^Bridge: running \(home \/h\)$/m);
  assert.match(busy, /^Worker local: last call 30 s ago · 0 queued · 2 finished$/m);
  assert.match(busy, /^Next: see what needs you: dalan inbox --all$/m);
  assert.doesNotMatch(busy, /DALAN_HOME/, 'a home that is not a trial home gets no export line');
  assert.match(formatStatusSummary({ ...sampleStatus, paused: true, pause_reason: 'maintenance' }, { home: '/h', now }), /^Next: resume handing out jobs: dalan resume$/m);
});

// A stand-in bridge: answers /status with sampleStatus and /submit with the given handler.
async function standIn(home, submit) {
  const root = dalan(['paths', '--data-root'], fresh('paths'), { DALAN_HOME: home }).stdout.trim();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', b => { body += b; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/status') return res.end(JSON.stringify(sampleStatus));
      if (req.url === '/submit') { const [code, value] = submit(JSON.parse(body)); res.statusCode = code; return res.end(JSON.stringify(value)); }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise(resolve => server.listen(path.join(root, 'admin.sock'), resolve));
  return { close: () => new Promise(resolve => server.close(resolve)) };
}

test('plain status prints the summary; --json keeps the full status document', async () => {
  const home = fresh('status-home');
  fs.writeFileSync(path.join(home, '.dalan-trial'), '');
  const bridge = await standIn(home, () => [500, {}]);
  try {
    const plain = await run(['status'], fresh('status-real'), { DALAN_HOME: home });
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, new RegExp(`^Bridge: running \\(trial home ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`, 'm'));
    assert.match(plain.stdout, /^Worker local: no calls yet · 1 queued/m);
    assert.match(plain.stdout, new RegExp(`^Next: .*; list your jobs: ${escape(byPath)} inbox --all$`, 'm'));
    assert.match(plain.stdout, new RegExp(`^Full detail: ${escape(byPath)} status --json$`, 'm'));
    assert.doesNotMatch(plain.stdout, /^\{/);
    const npx = await run(['status'], fresh('status-real'), { DALAN_HOME: home, ...underNpx });
    assert.match(npx.stdout, /^Next: .*; list your jobs: npx @tnunamak\/dalan inbox --all$/m);
    assert.match(npx.stdout, /^Full detail: npx @tnunamak\/dalan status --json$/m);
    const installed = await run(['status'], fresh('status-real'), { DALAN_HOME: home, ...onPath });
    assert.match(installed.stdout, /^Next: .*; list your jobs: dalan inbox --all$/m);
    const json = await run(['status', '--json'], fresh('status-real'), { DALAN_HOME: home });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), sampleStatus);
  } finally { await bridge.close(); }
});

test('a schema error names the missing fields and the example, with no byte counts', async () => {
  const home = fresh('submit-reject');
  const message = 'invalid assignment: needs schema_version 1, brief, inputs, expected_output and execution_scope; missing or wrong: brief, expected_output (a string)';
  const bridge = await standIn(home, () => [400, { error: message, verdict: 'reject', reasons: [{ code: 'invalid_schema', field: 'assignment', message, fix: 'correct assignment (see docs/usage.md, Submit)' }], bytes: { brief: 0, instructions: 0, limits: { brief: 0, instructions: 0 } } }]);
  try {
    const job = JSON.stringify({ schema_version: 1, request_id: 'req_first_run_reject_01', inputs: [], execution_scope: 'read-only' });
    const out = await run(['submit', '--stdin'], fresh('submit-real'), { DALAN_HOME: home }, job);
    assert.equal(out.code, 2, out.stderr);
    assert.equal(out.stderr, `dalan: the job is not a valid assignment: brief is missing or invalid; expected_output must be a string\ndalan: fix: add the missing fields; a valid example: ${JOB_EXAMPLE_URL}\ndalan: nothing was queued or changed\n`);
    const json = await run(['submit', '--stdin', '--json'], fresh('submit-real'), { DALAN_HOME: home }, job);
    assert.equal(json.code, 2);
    assert.equal(JSON.parse(json.stderr).reasons[0].fix, 'correct assignment (see docs/usage.md, Submit)', '--json output is unchanged');
  } finally { await bridge.close(); }
});

test('a queued submit ends with one plain Next line', async () => {
  const home = fresh('submit-ok');
  const id = 'req_first_run_queued_01';
  const bridge = await standIn(home, () => [200, { request_id: id, status: 'queued', duplicate: false, execution: 'none' }]);
  try {
    const job = JSON.stringify({ schema_version: 1, request_id: id, brief: 'Report hi.', inputs: [], expected_output: 'hi', execution_scope: 'read-only' });
    const out = await run(['submit', '--stdin'], fresh('submit-real'), { DALAN_HOME: home }, job);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).request_id, id);
    assert.equal(out.stderr, `Next: send your worker the job, then run: ${byPath} wait ${id} (check it any time with: ${byPath} get ${id})\n`);
    const npx = await run(['submit', '--stdin'], fresh('submit-real'), { DALAN_HOME: home, ...underNpx }, job);
    assert.equal(npx.stderr, `Next: send your worker the job, then run: npx @tnunamak/dalan wait ${id} (check it any time with: npx @tnunamak/dalan get ${id})\n`);
    const installed = await run(['submit', '--stdin'], fresh('submit-real'), { DALAN_HOME: home, ...onPath }, job);
    assert.equal(installed.stderr, `Next: send your worker the job, then run: dalan wait ${id} (check it any time with: dalan get ${id})\n`);
    const json = await run(['submit', '--stdin', '--json'], fresh('submit-real'), { DALAN_HOME: home }, job);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).recovery.wake, 'not_registered_by_this_submit');
    assert.equal(json.stderr, '');
  } finally { await bridge.close(); }
});

test('the try approval warning speaks to someone working alone as well as with a teammate', async () => {
  const { describeAttempt } = await import('../src/try.mjs');
  const { text } = describeAttempt({ code: 'ABCD-1234', client_id: 'c', client_name: 'n', redirect_uri: 'http://127.0.0.1/callback', resource: '', scopes: ['mcp'], native: true }, 'http://127.0.0.1:8799/s/mcp');
  assert.match(text, /Approve only if this code matches the browser page you opened, or the code the person at the worker read to you over a trusted channel\./);
  assert.doesNotMatch(text, /teammate/);
});

test('get and wait fixes name the CLI the way the user ran it; --json keeps plain dalan', () => {
  const home = fresh('get-unknown');
  const plain = dalan(['get', 'req_not_a_known_job_01'], fresh('get-real'), { DALAN_HOME: home, ...underNpx });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /^dalan: fix: check the ID and DALAN_HOME, or list your jobs with: npx @tnunamak\/dalan inbox --all$/m);
  const json = dalan(['get', 'req_not_a_known_job_01', '--json'], fresh('get-real'), { DALAN_HOME: home, ...underNpx });
  assert.deepEqual(JSON.parse(json.stderr).fix, ['check the ID and DALAN_HOME, or list your jobs with: dalan inbox --all']);
  const wait = dalan(['wait'], fresh('get-real'), { DALAN_HOME: home, ...onPath });
  assert.match(wait.stderr, /\(list your jobs with: dalan inbox --all\)/);
});

test('help --all marks accept and reject as decide shorthands; command help points to --all and --internal', () => {
  const all = dalan(['help', '--all'], fresh('help')).stdout;
  assert.match(all, /^ {2}accept +same as: dalan decide REQUEST_ID accepted$/m);
  assert.match(all, /^ {2}reject +same as: dalan decide REQUEST_ID not_useful$/m);
  for (const name of ['status', 'backfill-objectives']) {
    const text = dalan([name, '--help'], fresh('help')).stdout;
    assert.doesNotMatch(text, /for every command/);
    assert.match(text, /dalan help --all/);
    assert.match(text, /dalan help --internal/);
  }
});

// Each example must pass the real argument parser: run against a home with no bridge, it fails only for want of a bridge.
test('status, get, inbox and decide help each show an example that the parser accepts', () => {
  const home = fresh('examples');
  for (const name of ['status', 'get', 'inbox', 'decide']) {
    const text = dalan([name, '--help'], fresh('help')).stdout;
    const line = text.split('\n').find(l => l.startsWith('Example: '));
    assert.ok(line, `${name} help has an Example line`);
    for (const command of line.slice('Example: '.length).split(/, then /)) {
      assert.match(command, /^dalan /, line);
      const argv = command.replace(/^dalan /, '').split(' ').map(a => a === 'REQUEST_ID' ? 'req_example_job_0001' : a);
      const out = dalan(argv, fresh('examples-real'), { DALAN_HOME: home });
      assert.notEqual(out.status, 0, command);
      assert.match(out.stderr, /cannot reach the bridge|no job \\?"req_example_job_0001/, `${command}: ${out.stderr}`);
    }
  }
});

// Printed docs links name the release tag, never mutable main or a bare README anchor on the repository root.
test('every docs link the CLI prints is pinned to this release', () => {
  const texts = [dalan(['--help'], fresh('help')).stdout, dalan(['help', '--all'], fresh('help')).stdout, dalan(['help', '--internal'], fresh('help')).stdout,
    ...COMMANDS.map(c => dalan(['help', c.name], fresh('help')).stdout),
    dalan(['submit'], fresh('links-real'), { DALAN_HOME: fresh('links') }).stderr,
    formatStatusSummary(sampleStatus, { home: '/h', now: 0 })];
  const sources = ['bin', 'src'].flatMap(dir => fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.mjs')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')));
  let links = 0;
  for (const text of [...texts, ...sources]) {
    assert.doesNotMatch(text, /github\.com\/tnunamak\/dalan\/blob\/main\//);
    assert.doesNotMatch(text, /github\.com\/tnunamak\/dalan#/);
  }
  for (const text of texts) for (const [url] of text.matchAll(/https:\/\/github\.com\/tnunamak\/dalan\S*/g)) { links++; assert.ok(url.startsWith(`${DOCS_BASE}/`), url); }
  assert.ok(links >= 3, `found ${links} printed links`);
});

test('doctor on a trial home whose bridge is stopped says how to start it; --json adds the same fix', () => {
  const trial = fresh('doctor-trial');
  const init = dalan(['init', '--worker', 'local', '--public-url', 'http://127.0.0.1:8799'], fresh('doctor-real'), { DALAN_HOME: trial, DALAN_LOOPBACK: '1' });
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(path.join(trial, '.dalan-trial'), '');
  const fix = `fix: start it in another terminal, then run this command again: dalan try --home '${trial}'`;
  const out = dalan(['doctor'], fresh('doctor-real'), { DALAN_HOME: trial, ...onPath });
  const lines = out.stdout.split('\n');
  assert.equal(lines[0], `bridge home: ${trial} (trial bridge, not running)`);
  assert.equal(lines[1], fix, out.stdout);
  assert.equal(JSON.parse(dalan(['doctor', '--json'], fresh('doctor-real'), { DALAN_HOME: trial, ...onPath }).stdout).bridge_home.fix, fix.slice('fix: '.length));
  const plain = dalan(['doctor'], fresh('doctor-real'), { DALAN_HOME: fresh('doctor-plain'), ...onPath });
  assert.doesNotMatch(plain.stdout, /^fix: /m, 'a home that is not a stopped trial gets no fix line');
});

test('the default trial home is started with plain dalan try; another home needs --home', () => {
  assert.equal(tryCommand('dalan', '/u/me/.local/share/dalan-trial', '/u/me'), 'dalan try');
  assert.equal(tryCommand('npx @tnunamak/dalan', '/u/me/.local/share/dalan-trial', '/u/me'), 'npx @tnunamak/dalan try');
  assert.equal(tryCommand('dalan', "/x/it's", '/u/me'), "dalan try --home '/x/it'\\''s'");
});

test('wait help gives the job example and what exit 124 means; inbox help gives the default window and how to see older jobs', () => {
  const wait = dalan(['wait', '--help'], fresh('help')).stdout;
  assert.ok(wait.includes('Example: dalan wait REQUEST_ID --timeout 3600, then dalan get REQUEST_ID.'), wait);
  assert.ok(wait.includes('Exit 124 leaves the job open; inspect it with dalan get before waiting again.'), wait);
  const inbox = dalan(['inbox', '--help'], fresh('help')).stdout;
  assert.ok(inbox.includes('Default window: jobs updated in the last 72 hours. Questions are always listed. To see older results: dalan inbox --all --since all'), inbox);
});
