import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMANDS } from '../src/cli-help.mjs';
import { docsUrl } from '../src/docs-url.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-help-'));
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const dalan = (...args) => spawnSync(process.execPath, ['bin/dalan.mjs', ...args], { env: { ...process.env, HOME: home, DALAN_HOME: '' }, encoding: 'utf8' });

test('no arguments print grouped help and exit 0', () => {
  const run = dalan();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  for (const heading of ['Getting started:', 'Everyday:', 'Operator:']) assert.match(run.stdout, new RegExp(`^${heading}$`, 'm'));
  assert.match(run.stdout, /^Start here: {2}dalan try$/m);
  assert.match(run.stdout, /dalan help --all/);
  assert.ok(run.stdout.split('\n').length < 40, 'the first screen stays short');
  assert.ok(!run.stdout.includes('break-usage-backfill'), 'internal commands stay off the first screen');
  assert.ok(!run.stdout.includes('|'), 'no jammed usage line');
});

test('--help, -h and help print the same grouped screen as no arguments', () => {
  const bare = dalan().stdout;
  for (const args of [['--help'], ['-h'], ['help']]) assert.equal(dalan(...args).stdout, bare, args.join(' '));
});

test('an unknown command names itself, suggests a close match, points to --help and exits non-zero', () => {
  const run = dalan('bogus');
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'dalan: unknown command "bogus"\nRun \'dalan --help\' for usage.\n');
  for (const [typo, want] of [['stauts', 'status'], ['stat', 'status'], ['submitt', 'submit'], ['docter', 'doctor']]) {
    const close = dalan(typo);
    assert.equal(close.status, 1, typo);
    assert.match(close.stderr, new RegExp(`unknown command "${typo}"\\. Did you mean "${want}"\\?\\n`), typo);
    assert.match(close.stderr, /dalan --help/);
  }
  assert.deepEqual(JSON.parse(dalan('bogus', '--json').stderr), { error: 'unknown command "bogus"', kind: 'local' });
});

test('an unknown command is reported even when a default trial home exists', () => {
  fs.mkdirSync(path.join(home, '.local/share/dalan-trial'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/share/dalan-trial/.dalan-trial'), '');
  try {
    assert.match(dalan('bogus').stderr, /unknown command "bogus"/);
    assert.equal(dalan().status, 0);
  } finally { fs.rmSync(path.join(home, '.local'), { recursive: true, force: true }); }
});

test('help --all lists every command except internal ones, which help --internal lists', () => {
  const run = dalan('help', '--all'), internal = dalan('help', '--internal');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(internal.status, 0, internal.stderr);
  for (const { name, internal: hidden } of COMMANDS) assert.match((hidden ? internal : run).stdout, new RegExp(`^  ${name} `, 'm'), name);
  assert.ok(run.stdout.startsWith(dalan().stdout), 'the full list extends the short screen');
});

test('per-command help prints usage and does not run the command', () => {
  for (const name of ['try', 'init', 'connect', 'submit', 'status', 'get', 'wait', 'inbox', 'worker', 'doctor', 'paths']) {
    for (const args of [[name, '--help'], ['help', name]]) {
      const run = dalan(...args);
      assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
      assert.equal(run.stderr, '');
      assert.match(run.stdout, new RegExp(`^Usage: dalan ${name}\\b`, 'm'), args.join(' '));
    }
  }
  assert.match(dalan('submit', '-h').stdout, /^Usage: dalan submit/m);
  assert.equal(dalan('help', 'bogus').status, 1);
});

test('every command the CLI dispatches has a help entry', () => {
  const source = fs.readFileSync('bin/dot-worker.mjs', 'utf8');
  const dispatched = new Set(['try', 'setup', 'mcp']); // bin/dalan.mjs dispatches these before the CLI loads
  for (const line of source.match(/^ {4}case '[a-z-]+'(?:: case '[a-z-]+')*/gm)) for (const m of line.matchAll(/'([a-z-]+)'/g)) dispatched.add(m[1]);
  const documented = new Set(COMMANDS.map(c => c.name));
  for (const name of dispatched) assert.ok(documented.has(name), `${name} has no entry in src/cli-help.mjs`);
  for (const name of documented) assert.ok(dispatched.has(name), `${name} is documented but not dispatched`);
});

test('required options are not shown as optional', () => {
  assert.match(dalan('wait', '--help').stdout, /wait --drained --producer-thread ID/);
  assert.doesNotMatch(dalan('wait', '--help').stdout, /\[--producer-thread/);
  // Outside an agent session plain `dalan inbox` lists every producer, so neither inbox flag is required.
  assert.match(dalan('inbox', '--help').stdout, /dalan inbox \[--all \| --producer ID\]/);
});

test('the flags that error messages tell users to pass appear in help', () => {
  assert.match(dalan('submit', '--help').stdout, /--allow-scope-prune/);
});

test('apply help describes finished jobs, not accepted ones', () => {
  const text = dalan('apply', '--help').stdout;
  assert.match(text, /^Apply a finished job's patch/m);
  assert.ok(!/accepted job/i.test(text));
  assert.match(text, /records the decision "applied"/);
});

test('--json is listed wherever the command accepts it', () => {
  const connect = dalan('connect', '--help').stdout;
  for (const sub of ['remove-client CLIENT_ID [--json]', 'pending [--json]', 'list [--json]']) assert.ok(connect.includes(sub), sub);
  assert.match(dalan('as-init', '--help').stdout, /as-init --public-url https:\/\/HOST \[--json\]/);
  assert.match(dalan('as-rotate-keys', '--help').stdout, /\[--json\]/);
});

test('init help does not name the legacy worker as the default', () => {
  const text = dalan('init', '--help').stdout;
  assert.ok(!/\bdot\b/.test(text), 'init help names worker');
});

test('submit help states every default and shows the first-job sequence', () => {
  const text = dalan('submit', '--help').stdout;
  assert.match(text, /--deliver none\|t3:ID .*default: none/);
  assert.match(text, /--execution none\|worker\|host .*default: /);
  assert.match(text, /--timeout S .*default: 300/);
  assert.match(text, /--worker NAME .*default: /);
  assert.match(text, /^Examples\b.*:$/m);
  const examples = text.slice(text.indexOf('Examples'));
  const order = ['dalan submit --worker local --execution none --deliver none --file first-job.json --json', 'dalan wait REQUEST_ID', 'dalan get REQUEST_ID\n', 'dalan decide REQUEST_ID accepted'];
  let at = 0;
  for (const line of order) { const i = examples.indexOf(line, at); assert.ok(i >= at, line); at = i + line.length; }
  assert.match(examples, /REQUEST_ID/);
  assert.match(examples, /read the report before/i);
  assert.ok(examples.includes(docsUrl('docs/manual-setup.md', 'submit-finish-and-read-the-result')), examples);
});

test('connect help has a short usage line, a subcommand list and a pairing example', () => {
  const text = dalan('connect', '--help').stdout;
  assert.match(text, /^Usage: dalan connect <subcommand> \[options\]$/m);
  for (const line of text.split('\n')) assert.ok(line.length <= 100, `line too long: ${line}`);
  const examples = text.slice(text.indexOf('Examples'));
  assert.ok(text.includes('Examples'));
  let at = 0;
  for (const line of ['dalan connect start --worker', 'dalan connect pending', 'dalan connect approve CODE --worker']) { const i = examples.indexOf(line, at); assert.ok(i >= at, line); at = i; }
  assert.match(examples, /--confirm-redirect/);
});

test('wait help states the timeout default and every exit status', () => {
  const text = dalan('wait', '--help').stdout;
  assert.match(text, /--timeout S .*default: 300/);
  assert.match(text, /124 timeout/);
  assert.match(text, /5 the worker is on a usage break/);
  assert.doesNotMatch(text, /worker break/);
});

test('init help does not say the public URL must be HTTPS', () => {
  const text = dalan('init', '--help').stdout;
  assert.doesNotMatch(text, /--public-url https:\/\//);
  assert.doesNotMatch(text, /the HTTPS address/);
  assert.match(text, /^Usage: dalan init --public-url URL /m);
  assert.match(text, /http:\/\/127\.0\.0\.1:8799/);
});

test('try help describes the self-check and the wait for your worker, not a printed result', () => {
  const text = dalan('try', '--help').stdout;
  assert.doesNotMatch(text, /prints the result/);
  assert.match(text, /self-check/);
  assert.match(text, /interactive terminal/);
  assert.match(text, /connect your own worker/);
});

test('top-level help names DALAN_HOME before "Start here"', () => {
  const text = dalan('--help').stdout;
  const line = '  DALAN_HOME   bridge home commands use: the Home line a run prints (local: ~/.local/share/dalan-trial)';
  assert.ok(text.split('\n').includes(line), text);
  assert.match(text, /^Environment:$/m);
  assert.ok(text.indexOf('Environment:') < text.indexOf('Start here:'));
  assert.ok(text.indexOf('Operator:') < text.indexOf('Environment:'));
});

test('submit help lists --brief with an example, and inbox help explains "producer"', () => {
  const submit = dalan('submit', '--help').stdout;
  assert.match(submit, /^Usage: dalan submit \(--file PATH \| --stdin \| --brief TEXT\) \[options\]$/m);
  assert.match(submit, /^ {2}--file PATH \| --stdin \| --brief TEXT\n +where the job comes from \(exactly one\)/m);
  assert.match(submit, /^ {2}dalan submit --worker local --brief "What does a database index do\?"$/m);
  const inbox = dalan('inbox', '--help').stdout;
  assert.equal(inbox.split('the shell or agent session that submitted the job').length, 2, 'explained once');
  assert.match(inbox, /--producer ID/);
});
