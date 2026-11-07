// `dalan try`: the one-command first job. These tests run the real CLI, a real bridge process and the real OAuth flow.
// The "own worker" is a second stand-in client that uses the same demo-worker module. Nothing here touches the real HOME.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { beginPairing, openSession, workJob } from '../src/demo-worker.mjs';
import { describeAttempt, describeTryError, parsePending, parseTryArgs, runTry } from '../src/try.mjs';
import { reservedPort } from '../src/test-support/port.mjs';
import { defaultPath } from '../src/paths.mjs';
import { WORKER_INSTRUCTIONS } from '../src/worker-instructions.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tempRoot, 'dtry-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const realHome = path.join(tmp, 'real-home');
fs.mkdirSync(realHome, { recursive: true });
const cleanEnv = extra => ({ PATH: process.env.PATH, HOME: realHome, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...extra });
// DALAN_TRY_TEST_BIN points the same tests at an installed copy of the package (see the npm install proof in the PR).
const dalanBin = process.env.DALAN_TRY_TEST_BIN ?? path.join(repo, 'bin/dalan.mjs');
const runCwd = process.env.DALAN_TRY_TEST_BIN ? tmp : repo;
// Failure output must not carry the trial's bridge secret into CI logs.
const scrub = text => String(text).replace(/[0-9a-f]{64}/g, '<secret>');

function startTry(args, { cwd = runCwd, env = {} } = {}) {
  const child = spawn(process.execPath, [dalanBin, 'try', ...args], { env: cleanEnv(env), cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const run = { child, stdout: '', stderr: '', exit: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))) };
  child.stdout.on('data', chunk => { run.stdout += chunk; });
  child.stderr.on('data', chunk => { run.stderr += chunk; });
  run.until = async (pattern, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!pattern.test(run.stdout)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`never saw ${pattern}\nstdout:\n${scrub(run.stdout)}\nstderr:\n${scrub(run.stderr)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return run.stdout.match(pattern);
  };
  run.stop = async () => { child.kill('SIGINT'); return run.exit; };
  // Resolves with the exit, or fails if the command is still running after `ms`: used to prove it stops by itself.
  run.exitsWithin = (ms, why) => Promise.race([run.exit, new Promise((_, reject) => setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`still running after ${ms} ms: ${why}\nstdout:\n${scrub(run.stdout)}`)); }, ms))]);
  return run;
}

const portClosed = port => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true));
});

const listenOn = port => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

// The words of a printed shell command exactly as a shell reads them: quotes removed, a trailing period kept as part of a word.
const argvOf = line => {
  const read = spawnSync('sh', ['-c', `printf '%s\\0' ${line}`], { encoding: 'utf8' });
  assert.equal(read.status, 0, `not a valid shell command: ${line}\n${read.stderr}`);
  return read.stdout.split('\0').slice(0, -1);
};
// Printed commands sit alone on a line, indented by two spaces, with nothing after them.
const commandLines = text => text.split('\n').flatMap(line => /^  ((?:DALAN_HOME=|node |cat |dalan |export )\S.*)$/.exec(line)?.[1] ?? []);
const withoutNodeSqliteWarning = text => text.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/, '');
// A command is only ever printed as a whole indented line. In prose it would be pasted with its punctuation or its backticks,
// and a bare `dalan` needs the PATH. This looks for the shapes that break that.
const assertNoLooseCommands = text => {
  for (const line of text.split('\n')) {
    if (/^  (DALAN_HOME=|node |cat |export )\S/.test(line) || /^dalan: usage:|^usage:/.test(line)) continue;
    assert.doesNotMatch(line, /`[^`]*\b(dalan|node|export|cat) [^`]*`|(^|[\s(:])(dalan (try|worker|decide|connect|status|init|submit)\b|export DALAN_HOME)/, `a command inside prose: ${line}`);
  }
};
// The MCP URL is a credential: `try` writes it to a private file and prints only that file's path.
const tryUrl = async run => {
  const file = (await run.until(/^  MCP URL file: (.+)$/m))[1];
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The guide link sits beside the URL file, before the waiting line, so the reader knows how to use the file.
  await run.until(/^  How to connect Claude Code, Codex or another client: https:\/\/github\.com\/tnunamak\/dalan\/blob\/v[^/\s]+\/README\.md#connect-your-own-worker$/m);
  return fs.readFileSync(file, 'utf8').trim();
};
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

// The pid of the bridge server that `try` started on `port`, found from /proc (Linux only).
function bridgePid(port) {
  for (const name of fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry))) {
    try {
      if (!fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')[1]?.endsWith('src/server.mjs')) continue;
      if (fs.readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(`DALAN_PORT=${port}`)) return Number(name);
    } catch { /* the process ended, or is not ours */ }
  }
  return null;
}

// `runTry` in this process with its input and output captured. `finished` settles with {} or { error }.
async function liveTry(name, { clock, beforeCommand } = {}) {
  const port = await reservedPort();
  const run = { port, out: '', fullOut: '', errorContext: { started: false, shellCli: `'${path.resolve(dalanBin)}'` }, input: new PassThrough(), controller: new AbortController(), home: path.join(tmp, name) };
  run.finished = runTry({
    argv: ['--home', run.home, '--port', String(port)], env: { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    out: { write: text => { run.out += text; run.fullOut += text; } }, input: run.input, signal: run.controller.signal, clock, beforeCommand, errorContext: run.errorContext,
  }).then(() => ({}), error => ({ error }));
  run.until = async (pattern, ms = 60_000) => {
    for (let waited = 0; !pattern.test(run.out); waited += 50) {
      if (waited > ms) throw new Error(`never saw ${pattern}\n${scrub(run.out)}`);
      await sleepMs(50);
    }
    return run.out.match(pattern);
  };
  // Never leave the bridge running, whatever the test did.
  run.close = async () => { run.controller.abort(); await run.finished; };
  return run;
}

const attempt = extra => ({ code: 'ABCD-1234', client_id: 'cid', client_name: 'app', redirect_uri: 'http://127.0.0.1/cb', scopes: ['a', 'b'], ...extra });
const MCP = 'http://127.0.0.1:8799/s/mcp';

test('option parsing is strict', () => {
  assert.deepEqual(parseTryArgs([]), { home: null, port: null, callbacks: [] });
  assert.deepEqual(parseTryArgs(['--home', '/x', '--port', '9000', '--callback', 'a', '--callback', 'b']), { home: '/x', port: 9000, callbacks: ['a', 'b'] });
  for (const bad of [['--port'], ['--port', 'x'], ['--port', '70000'], ['--home', '--port'], ['stray'], ['--unknown', '1']]) assert.throws(() => parseTryArgs(bad), /usage|port/, JSON.stringify(bad));
});

// A new trial command is printed whole: a new home that does not exist yet, and a port that is free now.
async function assertNewHomeCommand(argv, cli, { port } = {}) {
  assert.deepEqual(argv.slice(0, 3), ['node', cli, 'try'], JSON.stringify(argv));
  assert.equal(argv[3], '--home');
  assert.ok(path.isAbsolute(argv[4]) && !fs.existsSync(argv[4]), `a new home that does not exist yet: ${argv[4]}`);
  assert.ok(Buffer.byteLength(path.join(argv[4], '.local/share/dot-bridge/admin.sock')) <= (process.platform === 'darwin' ? 103 : 107), 'home fits the Unix socket path limit');
  assert.equal(argv[5], '--port');
  assert.match(argv[6], /^\d+$/);
  assert.equal(argv.length, 7);
  if (port) assert.equal(argv[6], String(port));
  assert.ok(await portClosed(Number(argv[6])), 'the port in the command is free');
}

test('try errors distinguish pre-start guidance from post-start log recovery, and every command can be pasted', async () => {
  const cli = path.resolve(dalanBin);
  const invalid = spawnSync(process.execPath, [dalanBin, 'try', '--port', 'bad'], { env: cleanEnv({}), cwd: runCwd, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  const errorText=withoutNodeSqliteWarning(invalid.stderr);
  assert.match(errorText, /^dalan: --port requires a number from 1 to 65535\nThe server has not started; no server log was created for this attempt\.\n/);
  assert.match(errorText, /Fix the problem above, then run the command again\. Or start a trial in a new home:\n  node /);
  assert.doesNotMatch(errorText, /NEW_DIR|NEW_PORT|Full log:|Try another port: dalan try --port/);
  const [preStart, ...none] = commandLines(errorText);
  assert.equal(none.length, 0, 'one command, on its own line');
  await assertNewHomeCommand(argvOf(preStart), cli);

  const home = path.join(tmp, "post start's home");
  const run = startTry(['--home', home, '--callback', 'invalid-callback']);
  const exit = await run.exitsWithin(30_000, 'invalid callback after bridge startup');
  assert.equal(exit.code, 1, run.stderr);
  const log = path.join(home, 'server.log');
  assert.ok(run.stderr.includes(`Server log: ${log}\n`), 'the log path ends its line');
  assert.deepEqual(commandLines(run.stderr).map(argvOf), [['cat', log], ['node', cli, 'try', '--home', home]],
    'the log command and the retry command, as the shell reads them');
  assert.ok(run.stderr.split('\n').every(line => !/^  (cat|node) .*[.;,]$/.test(line)), 'no command ends in punctuation');
  assert.match(run.stderr, /approve callback|callback/i, 'the original subprocess cause remains visible');
  assert.doesNotMatch(run.stderr, /Try another port: dalan try --port|NEW_DIR|NEW_PORT/);
});

test('a bridge that does not start prints its log, a retry and a concrete new-home command', { timeout: 60_000 }, async () => {
  const home = path.join(tmp, "no start's home");
  const port = await reservedPort();
  const blocker = await listenOn(port);
  const cli = path.resolve(dalanBin);
  const errorContext = { started: false, shellCli: `'${cli}'` };
  try {
    // The port check passes (the seam says so) but the bind fails: the bridge exits before it listens.
    await runTry({ argv: ['--home', home, '--port', String(port)], env: { PATH: process.env.PATH }, out: { write() {} }, input: new PassThrough(), pickPort: async () => port, errorContext });
    assert.fail('try should have failed');
  } catch (error) {
    assert.equal(error.tryKind, 'startup');
    const text = await describeTryError(error, errorContext);
    const log = path.join(home, 'server.log');
    assert.ok(text.includes(`Full log: ${log}\n`));
    const commands = commandLines(text).map(argvOf);
    assert.equal(commands.length, 3, text);
    assert.deepEqual(commands.slice(0, 2), [['cat', log], ['node', cli, 'try', '--home', home]]);
    await assertNewHomeCommand(commands[2], cli);
    assert.doesNotMatch(text, /NEW_DIR|NEW_PORT/);
  } finally { blocker.close(); }
});

test('pending output is read as data, and a changed shape stops the command instead of skipping an attempt', () => {
  const ok = parsePending({ window: { worker: 'local', expires_at: 'x' }, pending: [attempt({ superseded: true }), attempt({ code: 'WXYZ-9876' })] });
  assert.deepEqual(ok.pending.map(p => [p.code, p.superseded, p.resource]), [['ABCD-1234', true, ''], ['WXYZ-9876', false, '']]);
  assert.equal(parsePending({ window: null, pending: [] }).window, null);
  for (const bad of [null, 'text', {}, { window: null }, { window: {}, pending: [] }, { window: null, pending: [attempt({ code: undefined })] },
    { window: null, pending: [attempt({ redirect_uri: 5 })] }, { window: null, pending: [attempt({ scopes: 'a b' })] }, { window: null, pending: ['code ABCD-1234'] }]) {
    assert.throws(() => parsePending(bad), /unexpected output from `dalan connect pending --json`/, JSON.stringify(bad));
  }
});

test('the resource line is always shown; a missing resource is said plainly and a foreign one blocks approval', () => {
  const missing = describeAttempt(parsePending({ window: null, pending: [attempt()] }).pending[0], MCP);
  assert.match(missing.text, /^resource    \(not reported: /m);
  assert.deepEqual([missing.blocked, missing.resourceReported], [false, false]);
  const same = describeAttempt(attempt({ resource: MCP }), MCP);
  assert.match(same.text, /^resource    "http:\/\/127\.0\.0\.1:8799\/s\/mcp"$/m);
  assert.deepEqual([same.blocked, same.resourceReported], [false, true]);
  const foreign = describeAttempt(attempt({ resource: 'http://127.0.0.1:8799/other/mcp' }), MCP);
  assert.match(foreign.text, /NOT this bridge's MCP URL/);
  assert.equal(foreign.blocked, true);
  assert.doesNotMatch(describeAttempt(attempt({ client_name: 'evil\u001b[31m\nname' }), MCP).text, /\u001b|name\n/, 'vendor strings stay terminal-safe');
});

// A bridge stub that answers discovery and refuses registration with the given status and description.
async function refusingRegistration(status, description) {
  const server = http.createServer((req, res) => {
    req.resume();
    const base = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) return res.end(JSON.stringify({ authorization_servers: [base] }));
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) return res.end(JSON.stringify({ registration_endpoint: `${base}/reg`, authorization_endpoint: `${base}/auth` }));
    res.statusCode = status;
    res.end(JSON.stringify({ error: 'temporarily_unavailable', error_description: description }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/s/mcp` };
}

test('a registration limit (HTTP 429) shows the server text and the lowest-risk next step, not callback advice', async () => {
  const { server, url } = await refusingRegistration(429, 'Registration limit reached. Reuse the client this worker already registered. If you cannot, ask the owner to run dalan connect reset, then retry.');
  try {
    await assert.rejects(beginPairing(url), error => {
      assert.match(error.message, /HTTP 429/);
      assert.ok(error.message.includes('Registration limit reached.'), error.message);
      assert.match(error.message, /Reuse the client this worker already registered/);
      assert.doesNotMatch(error.message, /allow-callback|allow the callback/);
      return true;
    });
  } finally { server.close(); }
  const other = await refusingRegistration(400, 'redirect_uri is not allowed');
  try {
    await assert.rejects(beginPairing(other.url), /HTTP 400.*redirect_uri is not allowed.*allow-callback/s);
  } finally { other.server.close(); }
});

test('the demo worker opens a real MCP session before it calls a tool', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      seen.push({ method: message.method, version: req.headers['mcp-protocol-version'], session: req.headers['mcp-session-id'], auth: req.headers.authorization });
      if (message.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's', version: '1' } } }));
      }
      if (!message.id) { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const call = await openSession(`http://127.0.0.1:${server.address().port}/s/mcp`, 'tok');
    assert.deepEqual(await call('list_pending', {}), { ok: true });
    assert.deepEqual(seen.map(s => s.method), ['initialize', 'notifications/initialized', 'tools/call']);
    assert.deepEqual(seen.slice(1).map(s => [s.version, s.session]), [['2025-06-18', 'sess-1'], ['2025-06-18', 'sess-1']], 'later calls carry the negotiated version and session');
    assert.ok(seen.every(s => s.auth === 'Bearer tok'));
  } finally {
    server.close();
  }
  const noVersion = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); }); });
  await new Promise(resolve => noVersion.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(openSession(`http://127.0.0.1:${noVersion.address().port}/s/mcp`, 'tok'), /initialize returned no protocol version/);
  } finally {
    noVersion.close();
  }
});

test('try refuses the real home before creating anything, and leaves a foreign directory untouched', () => {
  const link = path.join(tmp, 'link-to-home');
  fs.symlinkSync(realHome, link);
  const run = (args, { env = {}, cwd = runCwd } = {}) => spawnSync(process.execPath, [dalanBin, 'try', ...args], { env: cleanEnv(env), cwd, encoding: 'utf8', timeout: 20_000 });
  for (const [args, options] of [[['--home', realHome], {}], [['--home', link], {}], [['--home', '.'], { cwd: realHome }], [[], { env: { DALAN_HOME: realHome } }]]) {
    const result = run(args, options);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /real home/);
  }
  assert.deepEqual(fs.readdirSync(realHome), [], 'nothing was written to the real home');

  // A directory that already holds other files could be a real Dalan home: refuse it and do not touch its mode.
  const foreign = path.join(tmp, 'foreign');
  fs.mkdirSync(foreign, { mode: 0o755 });
  fs.chmodSync(foreign, 0o755);
  fs.writeFileSync(path.join(foreign, 'keep.txt'), 'x');
  const refused = run(['--home', foreign]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /did not create/);
  assert.deepEqual(fs.readdirSync(foreign), ['keep.txt']);
  assert.equal(fs.statSync(foreign).mode & 0o777, 0o755, 'a refused directory keeps its mode');

  // A path too long for the admin socket fails early with a reason, and creates nothing.
  const long = path.join(tmp, 'x'.repeat(110), 'trial');
  const tooLong = run(['--home', long]);
  assert.equal(tooLong.status, 1);
  assert.match(tooLong.stderr, /too long for the bridge's admin socket/);
  assert.ok(!fs.existsSync(path.join(tmp, 'x'.repeat(110))));
});

test('DALAN_HOME selects the bridge home for other commands, relative paths included, and help lists try', () => {
  const bridgeHome = path.join(tmp, 'named-home');
  const paths = spawnSync(process.execPath, [dalanBin, 'paths', '--json'], { env: cleanEnv({ DALAN_HOME: bridgeHome }), cwd: runCwd, encoding: 'utf8' });
  assert.equal(paths.status, 0, paths.stderr);
  assert.ok(JSON.parse(paths.stdout).config_dir.startsWith(`${bridgeHome}${path.sep}`), paths.stdout);
  const relative = spawnSync(process.execPath, [dalanBin, 'paths', '--json'], { env: cleanEnv({ DALAN_HOME: 'rel-home' }), cwd: tmp, encoding: 'utf8' });
  assert.equal(relative.status, 0, relative.stderr);
  assert.ok(JSON.parse(relative.stdout).config_dir.startsWith(`${path.join(tmp, 'rel-home')}${path.sep}`), `a relative DALAN_HOME is resolved against the current directory: ${relative.stdout}`);
  const help = spawnSync(process.execPath, [dalanBin, '--help'], { env: cleanEnv({}), cwd: runCwd, encoding: 'utf8' });
  assert.match(help.stdout, /^Getting started:\n  try /m);
  const trial = path.join(realHome, '.local/share/dalan-trial');
  fs.mkdirSync(trial, { recursive: true }); fs.writeFileSync(path.join(trial, '.dalan-trial'), 'fixture');
  try {
    const unsafe = spawnSync(process.execPath, [dalanBin, 'worker', 'list', '--json'], { env: cleanEnv({}), cwd: runCwd, encoding: 'utf8' });
    assert.equal(unsafe.status, 1); assert.match(JSON.parse(unsafe.stderr).error, /DALAN_HOME is not set, so "dalan worker" does not know which bridge home to use\. To use the trial bridge, run this, then run the command again:\n  export DALAN_HOME='/);
    const explicit = spawnSync(process.execPath, [dalanBin, 'worker', 'list', '--json'], { env: cleanEnv({ DALAN_HOME: bridgeHome }), cwd: runCwd, encoding: 'utf8' });
    assert.equal(explicit.status, 0, explicit.stderr); assert.doesNotMatch(explicit.stderr, /DALAN_HOME is not set/);
  } finally { fs.rmSync(path.join(realHome, '.local'), { recursive: true, force: true }); }
});

test('a port that is in use stops try with a clear message', async () => {
  const port = await reservedPort();
  const blocker = await listenOn(port);
  try {
    const run = startTry(['--home', path.join(tmp, 'busy'), '--port', String(port)]);
    const exit = await run.exitsWithin(30_000, 'a named port that is in use');
    assert.equal(exit.code, 1);
    assert.match(run.stderr, new RegExp(`port ${port} is in use`));
    // A home not yet tied to a port can run on a free one: the next command is that, for the same home.
    const [next, ...others] = commandLines(run.stderr);
    assert.equal(others.length, 0, run.stderr);
    const argv = argvOf(next);
    assert.deepEqual(argv.slice(2, 5), ['try', '--home', path.join(tmp, 'busy')], next);
    assert.equal(argv[5], '--port');
    assert.notEqual(argv[6], String(port));
    assert.ok(await portClosed(Number(argv[6])), 'the port in the command is free');
  } finally {
    blocker.close();
  }
});

test('a port lost to another process between the check and the bind is retried on the next one', { timeout: 60_000 }, async () => {
  const [lost, free] = [await reservedPort(), await reservedPort()];
  const blocker = await listenOn(lost);
  const picks = [];
  const controller = new AbortController();
  let out = '';
  const finished = runTry({
    argv: ['--home', path.join(tmp, 'race')], env: { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    out: { write: text => { out += text; } }, input: new PassThrough(), signal: controller.signal,
    // The search offers a port that looks free (the blocker already holds it) first, then a real free one.
    pickPort: async ({ skip }) => { picks.push([...skip]); return skip.has(lost) ? free : lost; },
  });
  try {
    for (let waited = 0; !out.includes(`Bridge up on http://127.0.0.1:${free}`); waited += 100) {
      if (waited > 30_000) throw new Error(`no retry onto ${free}:\n${scrub(out)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(picks, [[], [lost]], 'the second search skipped the port that failed');
  } finally {
    controller.abort();
    await finished;
    blocker.close();
  }
  assert.ok(await portClosed(free));
});

test('Ctrl-C during the demo stops try promptly', { timeout: 60_000 }, async () => {
  const port = await reservedPort();
  const run = startTry(['--home', path.join(tmp, 'early-stop'), '--port', String(port)]);
  await run.until(/Bridge up on/);
  run.child.kill('SIGINT');
  const exit = await run.exitsWithin(15_000, 'Ctrl-C while the demo was running');
  assert.equal(exit.code, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /Self-check/, 'the demo was cut short');
  assert.match(run.stdout, /Stopped\./);
  assert.ok(await portClosed(port), 'the bridge stopped with the command');
});

test('a second signal during the stop does not cut the cleanup short', { timeout: 90_000 }, async () => {
  // npx forwards the terminal's Ctrl-C to the command it runs, so try can get SIGINT twice in quick succession.
  const port = await reservedPort();
  const run = startTry(['--home', path.join(tmp, 'double-signal'), '--port', String(port)]);
  await run.until(/Waiting for your worker/, 60_000);
  run.child.kill('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 50));
  run.child.kill('SIGINT');
  const exit = await run.exitsWithin(45_000, 'two signals during the stop');
  assert.equal(exit.signal, null, `killed by ${exit.signal}\nstdout:\n${scrub(run.stdout)}`);
  assert.equal(exit.code, 0, run.stderr);
  assert.match(run.stdout, /Stopped\. Trial home kept at .*The demo grant and files are removed\./);
  assert.ok(await portClosed(port), 'the bridge stopped with the command');
});

test('ended input stops try after the demo, reuses the home and port, and keeps a reused home private', { timeout: 90_000 }, async () => {
  const home = path.join(tmp, 'eof');
  const port = await reservedPort();
  const first = startTry(['--home', home, '--port', String(port)]);
  first.child.stdin.end();
  const exit = await first.exitsWithin(60_000, 'input ended before the demo finished');
  assert.equal(exit.code, 0, first.stderr);
  assert.match(first.stdout, /Self-check passed in [\d.]+ s: a demo worker, approved by this command, finished a job; the repository grant works and a second repository is refused\./);
  assert.match(first.stdout, /Input ended, so nobody can approve a worker\. Stopping the bridge. To connect your worker, run:\n/);
  assert.deepEqual(commandLines(first.stdout).map(argvOf).filter(argv => argv[0] === 'node'), [['node', path.resolve(dalanBin), 'try', '--home', home]], 'the command that connects your own client');
  // The repository step: refused before any grant, then granted exactly one repository and finished by the real claim path.
  const profile = JSON.parse(fs.readFileSync(path.join(home, '.config/dalan/workers.json'), 'utf8'));
  assert.deepEqual(profile.workers.local.repos, [], 'the demo grant is revoked when the command exits');
  const audit = fs.readFileSync(path.join(home, '.config/dalan/workers-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(audit.map(e => e.after.repos), [['dalan-demo/hello'], []], 'the grant and its revocation are both audited');
  assert.ok(!fs.existsSync(path.join(home, 'demo')), 'the demo repository is removed');
  assert.deepEqual(fs.readdirSync(home).filter(name => /^req_.*\.json$/.test(name)), [], 'request files are removed');
  // Worker guidance for clients that load instruction files (opencode's "instructions"): kept with the URL file, private.
  const guide = path.join(home, 'worker-instructions.md');
  assert.equal(fs.statSync(guide).mode & 0o777, 0o600);
  const guideText = fs.readFileSync(guide, 'utf8');
  assert.equal(guideText, WORKER_INSTRUCTIONS, 'the one shared guidance text');
  assert.match(guideText, /There is no `execute` tool/);
  assert.match(guideText, /Never write a tool call as text/);
  assert.ok(await portClosed(port));

  // Loosen the home and the log, then run again without --port: the stored port is reused and the modes are tightened.
  fs.chmodSync(home, 0o755);
  fs.chmodSync(path.join(home, 'server.log'), 0o644);
  const again = startTry(['--home', home]);
  again.child.stdin.end();
  assert.equal((await again.exitsWithin(60_000, 'second run')).code, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`Bridge up on http://127\\.0\\.0\\.1:${port}`));
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, 'server.log')).mode & 0o777, 0o600);
  for (const file of fs.readdirSync(home).filter(name => name.endsWith('.json'))) assert.equal(fs.statSync(path.join(home, file)).mode & 0o777, 0o600, file);
  assert.ok(await portClosed(port));
});

test('one command finishes a demo job, then pairs, runs and accepts a second client', { timeout: 120_000 }, async () => {
  const home = path.join(tmp, 'trial');
  const port = await reservedPort();
  const run = startTry(['--home', home, '--port', String(port)]);
  try {
    await run.until(/Self-check passed in [\d.]+ s/);
    assert.ok(run.stdout.startsWith(`Dalan trial. Home: ${home}\n`), 'the heading names the trial home');
    assert.doesNotMatch(run.stdout, /For other shells/);
    const url = await tryUrl(run);
    const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
    await run.until(/Waiting for your worker/);
    assert.match(run.stdout, /Job req_[-\w]+ is queued for your worker\. When it is connected, send it:\n/);
    // The prompt leads with the request ID and the one allowed action, then a short stop condition.
    const prompt = /send it:\n  "(.+)"\n/.exec(run.stdout)[1];
    assert.ok(prompt.startsWith(`Request ${jobId} is your only job: claim it with Dalan`), prompt);
    assert.match(prompt, /Stop if it is missing or cancelled\. Claim no other job\.$/);
    assert.ok(prompt.length < 230, `the prompt stays short (${prompt.length} characters)`);
    // The demo worker is disconnected before the user's worker arrives, so no approval needs --replace.
    const listed = spawnSync(process.execPath, [dalanBin, 'connect', 'list'], { env: { PATH: process.env.PATH, HOME: home, DALAN_LOOPBACK: '1', DALAN_AUTH_MODE: 'builtin', DALAN_PORT: String(port) }, cwd: runCwd, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).connections.filter(c => c.revoked_at === null), [], 'no connection is active while the user\'s worker is awaited');
    assert.ok(run.stdout.includes('  Callbacks: http://127.0.0.1/callback, http://localhost/callback. To add one, restart with:\n'), 'the callback summary');
    assert.deepEqual(argvOf(commandLines(run.stdout).find(line => line.includes('--callback'))), ['node', path.resolve(dalanBin), 'try', '--home', home, '--callback', 'PATTERN']);

    // The owner says no: the client stays unpaired and the output says how to approve later. While try waits for that
    // answer, the same client registers twice more, leaving an older attempt that can no longer finish.
    const refused = await beginPairing(url, { redirect: 'http://localhost:43112/callback', clientName: 'stand-in client', timeoutMs: 1500 });
    await run.until(new RegExp(`code\\s+${refused.code}`));
    assert.match(run.stdout, /redirect\s+"http:\/\/localhost:43112\/callback"/);
    await run.until(/Approve this connection for worker "local"\?( The resource is not reported, so check that the redirect host is your client's\.)? \[y\/N\] /);
    // The resource line is shown whatever the bridge reports: either the bridge's own URL or a plain "not reported".
    assert.match(run.stdout, /^resource +(\(not reported: |"http:\/\/127\.0\.0\.1:\d+\/<secret>\/mcp")/m);
    assert.doesNotMatch(run.stdout, /NOT this bridge's MCP URL/);
    const stale = await beginPairing(url, { redirect: 'http://localhost:43115/callback', clientName: 'stale', timeoutMs: 500 });
    const newest = await beginPairing(url, { redirect: 'http://localhost:43116/callback', clientName: 'newest', timeoutMs: 500 });
    run.child.stdin.write('n\n');
    const later = await run.until(/Not approved\. Approve later with:\n  (DALAN_HOME=.*)\n/);
    assert.deepEqual(argvOf(later[1]), [`DALAN_HOME=${home}`, 'node', path.resolve(dalanBin), 'connect', 'approve', refused.code, '--worker', 'local', '--confirm-redirect', 'http://localhost:43112/callback', '--replace'], 'the later-approval command (a native callback needs its exact redirect), as a shell reads it');
    await assert.rejects(refused.complete(), /not approved in time/);
    await run.until(new RegExp(`code\\s+${newest.code}`));
    assert.ok(!run.stdout.includes(stale.code), 'the superseded attempt was never put to the owner');
    run.stdout = run.stdout.slice(run.stdout.lastIndexOf(newest.code));
    await run.until(/Approve this connection for worker "local"\?/);
    run.child.stdin.write('n\n');
    await run.until(/Not approved\. Approve later with:\n/);
    await assert.rejects(newest.complete(), /not approved in time/);

    // The owner says yes: the client pairs, takes the job and the owner accepts the report.
    const pairing = await beginPairing(url, { redirect: 'http://localhost:43113/callback', clientName: 'stand-in client' });
    await run.until(new RegExp(`code\\s+${pairing.code}`));
    run.stdout = run.stdout.slice(run.stdout.lastIndexOf(pairing.code));
    await run.until(/Approve this connection for worker "local"\?/);
    run.child.stdin.write('y\n');
    const token = await pairing.complete();
    await workJob(url, token, jobId, { claimant: 'stand-in', report: 'bridge first report' });
    await run.until(/Your worker finished req_[-\w]+\. Report:\nbridge first report/);
    await run.until(/Accept this result\? \[y\/N\]/);
    run.child.stdin.write('y\n');
    await run.until(/Recorded as accepted\.\nThe bridge stays up/);

    // Input ending is enough to stop it: no signal is sent here.
    run.child.stdin.end();
    const exit = await run.exitsWithin(20_000, 'input ended after the job was accepted');
    assert.equal(exit.code, 0, run.stderr);
  } finally {
    run.child.kill('SIGKILL');
  }
  assert.match(run.stdout, /Stopped\. Trial home kept at/);
  assert.ok(await portClosed(port), 'the bridge stopped with the command');
  assert.ok(!run.stdout.includes('\u001b'), 'plain text output');
});

test('a local clone can be granted: DALAN_GITHUB_URL_* given to try reaches the bridge, with no network', { timeout: 90_000 }, async () => {
  const clone = path.join(tmp, 'my-clone');
  const gitEnv = { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  fs.mkdirSync(clone, { recursive: true });
  fs.writeFileSync(path.join(clone, 'README.md'), '# My clone\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one']]) assert.equal(spawnSync('git', ['-C', clone, ...args], { env: gitEnv }).status, 0);
  const sha = spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { env: gitEnv, encoding: 'utf8' }).stdout.trim();
  const home = path.join(tmp, 'local-clone-home'), port = await reservedPort();
  const run = startTry(['--home', home, '--port', String(port)], { env: { DALAN_GITHUB_URL_LOCAL_MY_CLONE: clone, GITHUB_CLONE_BASE_URL: 'http://127.0.0.1:9' } });
  try {
    await run.until(/Waiting for your worker/);
    const bridge = { PATH: process.env.PATH, HOME: home, DALAN_LOOPBACK: '1', DALAN_AUTH_MODE: 'builtin', DALAN_PORT: String(port) };
    const dalan = args => spawnSync(process.execPath, [dalanBin, ...args], { env: bridge, cwd: runCwd, encoding: 'utf8', timeout: 60_000 });
    assert.equal(dalan(['worker', 'allow', 'local', 'local/my-clone']).status, 0);
    const file = path.join(tmp, 'local-clone-job.json');
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, request_id: `req_${randomUUID()}`, brief: 'Read README.md at the pinned commit and report its title.', inputs: [{ github_repo: 'local/my-clone', base_sha: sha }], expected_output: 'README title.', scope_paths: ['README.md'], execution_scope: 'read-only' }));
    const submitted = dalan(['submit', '--worker', 'local', '--execution', 'none', '--deliver', 'none', '--file', file, '--json']);
    assert.equal(submitted.status, 0, scrub(submitted.stderr + submitted.stdout));
  } finally { await run.stop(); }
});

test('without python3 the repository step is skipped with the fix, and the first job still finishes', { timeout: 90_000 }, async () => {
  const bin = path.join(tmp, 'git-only-bin');
  fs.mkdirSync(bin, { recursive: true });
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(git, path.join(bin, 'git'));
  const run = startTry(['--home', path.join(tmp, 'no-python'), '--port', String(await reservedPort())], { env: { PATH: bin } });
  run.child.stdin.end();
  const exit = await run.exitsWithin(60_000, 'try without python3');
  assert.equal(exit.code, 0, run.stderr);
  assert.match(run.stdout, /Self-check passed in [\d.]+ s: a demo worker, approved by this command, finished a job\./);
  assert.match(run.stdout, /Repository step skipped: python3 was not found on PATH; install Python 3\.8 or newer, then run this command again to see the repository step:\n  node /);
  assertNoLooseCommands(run.stdout);
  assert.deepEqual(commandLines(run.stdout).map(argvOf).find(argv => argv[0] === 'node'), ['node', path.resolve(dalanBin), 'try', '--home', path.join(tmp, 'no-python')]);
  assert.doesNotMatch(run.stdout, /Granted dalan-demo/);
});

test('an unsupported Node version or platform stops the dalan command with one line, before any modern import', () => {
  // Preloads that pretend to be an old Node or Windows. The check must run before node:sqlite or the CLI loads.
  const fake = (name, source) => { const file = path.join(tmp, name); fs.writeFileSync(file, source); return file; };
  const oldNode = fake('old-node.mjs', "Object.defineProperty(process.versions, 'node', { value: '22.4.0' });\n");
  const windows = fake('windows.mjs', "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
  const run = (preload, args) => spawnSync(process.execPath, ['--import', preload, dalanBin, ...args], { env: cleanEnv({}), cwd: runCwd, encoding: 'utf8', timeout: 20_000 });
  for (const args of [['try', '--bogus'], ['status'], ['--help']]) {
    const old = run(oldNode, args);
    assert.equal(old.status, 1, old.stdout + old.stderr);
    assert.match(old.stderr, /^dalan: dalan needs Node\.js 24 or newer; this is Node\.js 22\.4\.0\. Install a newer one from https:\/\/nodejs\.org\/en\/download/);
    assert.equal(old.stderr.trim().split('\n').length, 1, 'one line, no stack trace');
    assert.equal(old.stdout, '');
    const win = run(windows, args);
    assert.equal(win.status, 1, win.stdout + win.stderr);
    assert.match(win.stderr, /^dalan: dalan runs on Linux and macOS only/);
    assert.equal(win.stderr.trim().split('\n').length, 1);
  }
});

test('a trial home that already runs on one port refuses a different --port and says how to start a separate trial', { timeout: 120_000 }, async () => {
  const home = path.join(tmp, 'tied');
  const [port, other] = [await reservedPort(), await reservedPort()];
  const first = startTry(['--home', home, '--port', String(port)]);
  first.child.stdin.end();
  assert.equal((await first.exitsWithin(60_000, 'first run on the tied home')).code, 0, first.stderr);
  const asJson = path.join(home, '.config/dalan/as.json');
  const before = fs.readFileSync(asJson, 'utf8');

  const changed = startTry(['--home', home, '--port', String(other)]);
  changed.child.stdin.end();
  const exit = await changed.exitsWithin(30_000, 'a different port on a reused home');
  assert.equal(exit.code, 1, changed.stdout);
  assert.match(changed.stderr, new RegExp(`tied to port ${port}`));
  assert.doesNotMatch(changed.stderr, /NEW_DIR|NEW_PORT/);
  await assertNewHomeCommand(argvOf(commandLines(changed.stderr).at(-1)), path.resolve(dalanBin), { port: other });
  assert.doesNotMatch(changed.stdout, /Bridge up/, 'no bridge was started on the new port');
  assert.equal(fs.readFileSync(asJson, 'utf8'), before, 'the saved public URL did not change');
  assert.ok(await portClosed(other));

  // The same port is still fine to name. If another process holds it, the advice is about the tied home, not "choose another --port".
  const blocker = await listenOn(port);
  try {
    const busy = startTry(['--home', home]);
    busy.child.stdin.end();
    assert.equal((await busy.exitsWithin(30_000, 'the tied port is in use')).code, 1);
    assert.match(busy.stderr, new RegExp(`port ${port} is in use`));
    assert.match(busy.stderr, new RegExp(`tied to port ${port}`));
    assert.doesNotMatch(busy.stderr, /choose another with --port|NEW_DIR|NEW_PORT/);
    await assertNewHomeCommand(argvOf(commandLines(busy.stderr).at(-1)), path.resolve(dalanBin));

    // When the port holder is this home's own bridge (its admin socket answers), say so and how to use it.
    const dataRoot = spawnSync(process.execPath, [dalanBin, 'paths', '--data-root'], { env: cleanEnv({ DALAN_HOME: home }), cwd: runCwd, encoding: 'utf8' }).stdout.trim();
    // The stopped first run left its socket file behind; a running bridge would hold a fresh one.
    fs.rmSync(path.join(dataRoot, 'admin.sock'), { force: true });
    const admin = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { admin.once('error', reject); admin.listen(path.join(dataRoot, 'admin.sock'), resolve); });
    // A running trial's demo files stay: this command must not clean up the trial it found running.
    fs.mkdirSync(path.join(home, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(home, 'demo', 'in-use'), '');
    try {
      const own = startTry(['--home', home]);
      own.child.stdin.end();
      assert.equal((await own.exitsWithin(30_000, 'this home already runs')).code, 1);
      assert.equal(own.stderr, `dalan: the trial bridge for this home is already running on http://127.0.0.1:${port}. Use it from another terminal (export DALAN_HOME='${home}'), or stop it with Ctrl-C in its terminal first.\n`);
      assert.ok(fs.existsSync(path.join(home, 'demo', 'in-use')), 'the running trial\'s files are untouched');
    } finally { await new Promise(resolve => admin.close(resolve)); }
  } finally { blocker.close(); }
});

test('the local-filesystem refusal names the alternate trial command', { skip: process.platform !== 'linux' && 'the refusal reads statfs magic numbers on Linux only' }, async () => {
  const { acquireAsOwner } = await import('../src/as-files.mjs');
  const dir = path.join(tmp, 'as-fs');
  fs.mkdirSync(dir, { mode: 0o700 });
  const original = fs.statfsSync;
  fs.statfsSync = () => ({ type: 0x65735546 }); // FUSE
  try {
    assert.throws(() => acquireAsOwner(dir), /local filesystem[\s\S]*dalan try --home \/short\/local\/path[\s\S]*not your real home/);
  } finally { fs.statfsSync = original; }
});

// The bridge process dies while `try` is waiting for the owner. Each prompt below used to wait for input or Ctrl-C only,
// so `try` printed nothing more and never stopped.
const waitPoints = [
  ['approval', async () => {}],
  ['acceptance', async run => { run.input.write('y\n'); }],
  ['the bridge stays up', async run => { run.input.write('y\n'); }],
];
const settleWithin = (promise, ms) => Promise.race([promise, sleepMs(ms).then(() => 'hung')]);
for (const [name, advance] of waitPoints) {
  test(`the bridge dying while try waits at ${name} ends in recovery, not a hang`, { timeout: 120_000, skip: process.platform !== 'linux' && 'finds the bridge process through /proc' }, async () => {
    const cli = path.resolve(dalanBin);
    const run = await liveTry(`death-${name.replaceAll(' ', '-')}`);
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const url = await tryUrl(run);
      const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
      await run.until(/Waiting for your worker/);
      const pairing = await beginPairing(url, { redirect: 'http://localhost:43131/callback', clientName: 'stand-in client' });
      await run.until(/Approve this connection for worker "local"\?/);
      if (name !== 'approval') {
        await advance(run);
        await workJob(url, await pairing.complete(), jobId, { claimant: 'stand-in', report: 'bridge first report' });
        if (name === 'the bridge stays up') { await run.until(/Accept this result\? \[y\/N\]/); run.input.write('y\n'); }
      }
      await run.until(name === 'approval' ? /Approve this connection/ : name === 'acceptance' ? /Accept this result\? \[y\/N\]/ : /The bridge stays up/);
      const pid = bridgePid(run.port);
      assert.ok(pid, 'found the bridge process');
      process.kill(pid, 'SIGKILL');

      const settled = await settleWithin(run.finished, 20_000);
      assert.notEqual(settled, 'hung', `try kept waiting after the bridge died\n${scrub(run.out)}`);
      assert.equal(settled.error?.tryKind, 'unexpected', `${settled.error?.stack}\n${scrub(run.out)}`);
      const text = await describeTryError(settled.error, run.errorContext);
      assert.match(text, /^the bridge stopped unexpectedly/);
      assert.deepEqual(commandLines(text).slice(0, 2).map(argvOf), [['cat', path.join(run.home, 'server.log')], ['node', cli, 'try', '--home', run.home]]);
      await sleepMs(300);
      assert.deepEqual(unhandled, [], 'no unhandled rejection');
      assert.equal(run.input.isPaused(), true, 'try stopped reading the input');
      assert.equal(run.input.listenerCount('end'), 0, 'the line reader is closed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await run.close();
    }
  });
}

// Diagnostics when no worker claims the job. The clock is a seam: every wait advances two virtual minutes at once, so the
// timing is exact and the test does not wait for real minutes.
test('a worker that never connects gets bounded diagnostics with the exact commands', { timeout: 120_000 }, async () => {
  let virtual = 0;
  const clock = { now: () => virtual, sleep: async () => { virtual += 120_000; await sleepMs(100); } };
  const run = await liveTry('silent-worker', { clock });
  try {
    const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
    await run.until(/Still waiting for your worker/);
    while (virtual < 1_800_000) await sleepMs(100); // half an hour of virtual time
    run.input.end();
    await run.finished;
    assert.equal(run.out.match(/Still waiting for your worker/g).length, 3, 'a bounded number of reminders');
    const shellHome = `DALAN_HOME=${run.home}`;
    const cli = ['node', path.resolve(dalanBin)];
    const block = [[shellHome, ...cli, 'connect', 'pending'], [shellHome, ...cli, 'connect', 'start', '--worker', 'local'], [shellHome, ...cli, 'status']];
    const shown = commandLines(run.out).map(argvOf).filter(argv => argv[0] === shellHome && argv[3] !== 'worker'); // other commands are checked elsewhere
    assert.deepEqual(shown, [...block, ...block, ...block]);
    assert.match(run.out, new RegExp(`Still waiting for your worker to claim ${jobId}`));
  } finally { await run.close(); }
});

test('a client that retries after the owner approved is asked again until the worker claims the job', { timeout: 120_000 }, async () => {
  const run = await liveTry('retry-after-approval');
  try {
    const url = await tryUrl(run);
    const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
    await run.until(/Waiting for your worker/);

    // The owner approves, but the client's sign-in never finishes (its callback fails): it never claims anything.
    const failed = await beginPairing(url, { redirect: 'http://localhost:43141/callback', clientName: 'first try', timeoutMs: 500 });
    await run.until(new RegExp(`code\\s+${failed.code}`));
    await run.until(/Approve this connection for worker "local"\?/);
    run.input.write('y\n');
    await run.until(/Approved\. Waiting for the worker to finish the job\./);

    // The client tries again. That is a new attempt and needs a new approval, which has to be put to the owner.
    run.out = '';
    const retry = await beginPairing(url, { redirect: 'http://localhost:43142/callback', clientName: 'second try' });
    await run.until(new RegExp(`code\\s+${retry.code}`));
    await run.until(/Approve this connection for worker "local"\?/);
    run.input.write('y\n');
    await run.until(/Replaced connection [0-9a-f-]+, your worker's earlier sign-in\./);
    await workJob(url, await retry.complete(), jobId, { claimant: 'stand-in', report: 'bridge first report' });
    await run.until(/Your worker finished req_[-\w]+\. Report:\nbridge first report/);
    run.input.end();
    assert.deepEqual(await run.finished, {});
  } finally { await run.close(); }
});

test('from the command line, a bridge that dies after the report is accepted ends with the exit code and the recovery commands', { timeout: 120_000, skip: process.platform !== 'linux' && 'finds the bridge process through /proc' }, async () => {
  const home = path.join(tmp, 'death-cli');
  const port = await reservedPort();
  const run = startTry(['--home', home, '--port', String(port)]);
  try {
    const url = await tryUrl(run);
    const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
    const pairing = await beginPairing(url, { redirect: 'http://localhost:43151/callback', clientName: 'stand-in client' });
    await run.until(/Approve this connection for worker "local"\?/);
    run.child.stdin.write('y\n');
    await workJob(url, await pairing.complete(), jobId, { claimant: 'stand-in', report: 'bridge first report' });
    await run.until(/Accept this result\? \[y\/N\]/);
    run.child.stdin.write('y\n');
    await run.until(/The bridge stays up/);
    process.kill(bridgePid(port), 'SIGKILL');
    const exit = await run.exitsWithin(20_000, 'the bridge died while try waited for Ctrl-C');
    assert.equal(exit.code, 1, run.stderr);
    assert.match(withoutNodeSqliteWarning(run.stderr), /^dalan: the bridge stopped unexpectedly/);
    const cli = path.resolve(dalanBin);
    const commands = commandLines(run.stderr).map(argvOf);
    assert.deepEqual(commands.slice(0, 2), [['cat', path.join(home, 'server.log')], ['node', cli, 'try', '--home', home]]);
    await assertNewHomeCommand(commands[2], cli);
  } finally { run.child.kill('SIGKILL'); }
});

test('try emits only a private resource URL file path, never the path credential', { timeout: 300_000 }, async () => {
  const run = await liveTry('private-url');
  try {
    await run.until(/Waiting for your worker/, 250_000);
    const secret = /^BRIDGE_PATH_SECRET=(.+)$/m.exec(fs.readFileSync(defaultPath(run.home, '.config/dot-bridge', 'env'), 'utf8'))?.[1];
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.ok(!run.fullOut.includes(secret), 'stdout carries the path credential');
    const file = /^  MCP URL file: (.+)$/m.exec(run.fullOut)?.[1];
    assert.ok(file, 'the instructions name the URL file');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), `http://127.0.0.1:${run.port}/${secret}/mcp`);
    assert.match(run.fullOut, new RegExp(`^  MCP URL \\(secret hidden\\): http://127\\.0\\.0\\.1:${run.port}/<secret>/mcp$`, 'm'));
    run.input.end();
    assert.deepEqual(await run.finished, {}, 'the run succeeded');
    assert.ok(!run.fullOut.includes(secret), 'stdout carries the path credential after exit');
  } finally { await run.close(); }
});

// The path secret of a trial home, read from its bridge env file.
const homeSecret = home => /^BRIDGE_PATH_SECRET=(.+)$/m.exec(fs.readFileSync(defaultPath(home, '.config/dot-bridge', 'env'), 'utf8'))?.[1];
const assertSecretAbsent = (secret, home, run, label) => {
  assert.match(secret, /^[0-9a-f]{64}$/);
  for (const [name, text] of [['stdout', run.stdout], ['stderr', run.stderr], ['server.log', fs.readFileSync(path.join(home, 'server.log'), 'utf8')]]) {
    assert.ok(!text.includes(secret), `${label}: ${name} carries the path credential`);
  }
};

test('the CLI never prints or logs the path credential, on success or on failure', { timeout: 300_000 }, async () => {
  const okHome = path.join(tmp, 'cli-secret-ok');
  const okPort = await reservedPort();
  const ok = startTry(['--home', okHome, '--port', String(okPort)]);
  try {
    await ok.until(/Waiting for your worker/, 250_000);
    ok.child.stdin.end();
    const exit = await ok.exitsWithin(30_000, 'input ended while waiting for a worker');
    assert.equal(exit.code, 0, ok.stderr);
    assertSecretAbsent(homeSecret(okHome), okHome, ok, 'success');
  } finally { ok.child.kill('SIGKILL'); }

  const failHome = path.join(tmp, 'cli-secret-fail');
  const fail = startTry(['--home', failHome, '--callback', 'invalid-callback']);
  try {
    const exit = await fail.exitsWithin(60_000, 'invalid callback after bridge startup');
    assert.equal(exit.code, 1, fail.stderr);
    assert.match(fail.stderr, /callback/i, 'the failure was the formatted error');
    assertSecretAbsent(homeSecret(failHome), failHome, fail, 'failure');
  } finally { fail.child.kill('SIGKILL'); }
});

test('every command the walk prints sits alone on a line, runs the checkout CLI by absolute path and reads as one argv', { timeout: 120_000 }, async () => {
  const run = await liveTry('pasteable');
  try {
    const url = await tryUrl(run);
    const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
    await run.until(/Waiting for your worker/);
    const declined = await beginPairing(url, { redirect: 'http://localhost:43161/callback', clientName: 'declined', timeoutMs: 500 });
    await run.until(/Approve this connection for worker "local"\? /);
    run.input.write('n\n');
    await run.until(/Not approved\. Approve later with:\n/);
    const pairing = await beginPairing(url, { redirect: 'http://localhost:43162/callback', clientName: 'stand-in client' });
    await run.until(new RegExp(`code\\s+${pairing.code}`));
    run.out = run.out.slice(run.out.lastIndexOf(pairing.code));
    await run.until(/Approve this connection for worker "local"\? /);
    run.input.write('y\n');
    await workJob(url, await pairing.complete(), jobId, { claimant: 'stand-in', report: 'bridge first report' });
    await run.until(/Accept this result\? \[y\/N\] /);
    run.input.write('n\n');
    await run.until(/Not recorded\. Decide later while the bridge runs:\n/);
    run.input.end();
    assert.deepEqual(await run.finished, {});
    const home = `DALAN_HOME=${run.home}`, cli = ['node', path.resolve(dalanBin)];
    const stdout = run.fullOut;
    const commands = commandLines(stdout).map(argvOf);
    assert.deepEqual(commands, [
      [...cli, 'try', '--home', run.home, '--callback', 'PATTERN'],
      [home, ...cli, 'connect', 'approve', declined.code, '--worker', 'local', '--confirm-redirect', 'http://localhost:43161/callback', '--replace'],
      [home, ...cli, 'decide', jobId, 'accepted'],
    ]);
    assertNoLooseCommands(stdout);
  } finally { await run.close(); }
});

// The owner is shown attempt A, the client starts B (which supersedes A), and the owner answers y to A. The bridge rejects
// the approval of A. That is a refresh, not a failure: B is shown and the bridge stays up.
test('an approval answered after a newer attempt superseded it is refreshed, not fatal', { timeout: 120_000 }, async () => {
  const run = await liveTry('stale-approval');
  try {
    const url = await tryUrl(run);
    const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
    await run.until(/Waiting for your worker/);
    const first = await beginPairing(url, { redirect: 'http://localhost:43171/callback', clientName: 'first', timeoutMs: 500 });
    await run.until(new RegExp(`code\\s+${first.code}`));
    await run.until(/Approve this connection for worker "local"\? /);
    const second = await beginPairing(url, { redirect: 'http://localhost:43172/callback', clientName: 'second' });
    run.input.write('y\n');
    await run.until(new RegExp(`code\\s+${second.code}`));
    await run.until(/no longer current/);
    assert.doesNotMatch(run.out, /Looking for the newest/, 'the stale notice never ends on a promise');
    assert.ok(run.out.indexOf(second.code) > run.out.indexOf('no longer current'), 'the current code follows at once');
    assert.doesNotMatch(run.out, /Approved\. Waiting/, 'the superseded attempt was not approved');
    assert.equal(await Promise.race([run.finished, sleepMs(300).then(() => 'running')]), 'running', `the bridge was stopped\n${scrub(run.out)}`);
    run.out = run.out.slice(run.out.lastIndexOf(second.code));
    await run.until(/Approve this connection for worker "local"\? /);
    run.input.write('y\n');
    await workJob(url, await second.complete(), jobId, { claimant: 'stand-in', report: 'bridge first report' });
    await run.until(/Your worker finished req_[-\w]+\. Report:\nbridge first report/);
    run.input.end();
    assert.deepEqual(await run.finished, {});
  } finally { await run.close(); }
});

test('an approval answered after the attempt was withdrawn is refreshed, not fatal', { timeout: 120_000 }, async () => {
  const run = await liveTry('withdrawn-approval');
  try {
    const url = await tryUrl(run);
    const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
    await run.until(/Waiting for your worker/);
    const first = await beginPairing(url, { redirect: 'http://localhost:43181/callback', clientName: 'first', timeoutMs: 500 });
    await run.until(new RegExp(`code\\s+${first.code}`));
    await run.until(/Approve this connection for worker "local"\? /);
    // Another terminal clears the unapproved attempts while the question is open.
    const reset = spawnSync(process.execPath, [dalanBin, 'connect', 'reset'], { env: { PATH: process.env.PATH, HOME: run.home, DALAN_LOOPBACK: '1', DALAN_AUTH_MODE: 'builtin', DALAN_PORT: String(run.port) }, cwd: runCwd, encoding: 'utf8' });
    assert.equal(reset.status, 0, reset.stderr);
    run.input.write('y\n');
    await run.until(/no longer current/);
    await run.until(/No newer attempt is waiting\. Start the sign-in again in your worker; its new code appears here\./);
    assert.doesNotMatch(run.out, /Looking for the newest/);
    assert.equal(await Promise.race([run.finished, sleepMs(500).then(() => 'running')]), 'running', `the bridge was stopped\n${scrub(run.out)}`);
    run.out = '';
    const second = await beginPairing(url, { redirect: 'http://localhost:43182/callback', clientName: 'second' });
    await run.until(new RegExp(`code\\s+${second.code}`));
    await run.until(/Approve this connection for worker "local"\? /);
    run.input.write('y\n');
    await workJob(url, await second.complete(), jobId, { claimant: 'stand-in', report: 'bridge first report' });
    await run.until(/Your worker finished req_[-\w]+\. Report:\nbridge first report/);
    run.input.end();
    assert.deepEqual(await run.finished, {});
  } finally { await run.close(); }
});

// The owner answers y; `try` has re-read the pending list and found the attempt current. The state then changes in the one
// moment before the approve command runs: the hook below fires after the prompt and after that re-read.
async function approveRaceRun(name, change) {
  let hook = null;
  const run = await liveTry(name, { beforeCommand: async args => { if (args[1] === 'approve' && hook) { const fire = hook; hook = null; await fire(); } } });
  const url = await tryUrl(run);
  const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
  await run.until(/Waiting for your worker/);
  const first = await beginPairing(url, { redirect: 'http://localhost:43191/callback', clientName: 'first', timeoutMs: 500 });
  await run.until(new RegExp(`code\\s+${first.code}`));
  await run.until(/Approve this connection for worker "local"\? /);
  const second = { pairing: null };
  hook = () => change({ run, url, second });
  run.input.write('y\n');
  await run.until(/no longer current/);
  assert.equal(await Promise.race([run.finished, sleepMs(300).then(() => 'running')]), 'running', `the bridge was stopped\n${scrub(run.out)}`);
  assert.doesNotMatch(run.out, /Approved\. Waiting/, 'the changed attempt was not approved');
  return { run, url, jobId, second };
}

test('an approval answered after the attempt expired says it expired and names the command to start a new one', { timeout: 120_000 }, async () => {
  let offset = 0;
  const clock = { now: () => Date.now() + offset, sleep: ms => sleepMs(Math.min(ms, 200)) };
  let hook = null;
  const run = await liveTry('expired-approval', { clock, beforeCommand: async args => { if (args[1] === 'approve' && hook) { const fire = hook; hook = null; await fire(); } } });
  try {
    const url = await tryUrl(run);
    await run.until(/Job (req_[-\w]+) is queued for your worker/);
    await run.until(/Waiting for your worker/);
    const first = await beginPairing(url, { redirect: 'http://localhost:43201/callback', clientName: 'first', timeoutMs: 500 });
    await run.until(new RegExp(`code\\s+${first.code}`));
    await run.until(/Approve this connection for worker "local"\? /);
    // Ten minutes pass: the bridge drops the attempt and the owner's clock moves on with it.
    hook = () => {
      const found = spawnSync('find', [run.home, '-name', 'as.sqlite'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
      const db = new DatabaseSync(found);
      db.prepare('UPDATE pairings SET expires_at=?').run(Date.now() - 1000);
      db.close();
      offset += 11 * 60_000;
    };
    run.input.write('y\n');
    await run.until(/That attempt expired after 10 minutes\./);
    assert.doesNotMatch(run.out, /no longer current/, 'an expired attempt is not called stale');
    await run.until(/connect start --worker local/);
    assert.match(run.out, /Start the sign-in again in your worker/);
  } finally { await run.close(); }
});

test('an attempt that vanishes between the re-read and the approval is refreshed, not fatal', { timeout: 120_000 }, async () => {
  const { run, url, jobId } = await approveRaceRun('vanish-between', async ({ run }) => {
    const reset = spawnSync(process.execPath, [dalanBin, 'connect', 'reset'], { env: { PATH: process.env.PATH, HOME: run.home, DALAN_LOOPBACK: '1', DALAN_AUTH_MODE: 'builtin', DALAN_PORT: String(run.port) }, cwd: runCwd, encoding: 'utf8' });
    assert.equal(reset.status, 0, reset.stderr);
  });
  try {
    run.out = '';
    const next = await beginPairing(url, { redirect: 'http://localhost:43192/callback', clientName: 'next' });
    await run.until(new RegExp(`code\\s+${next.code}`));
    await run.until(/Approve this connection for worker "local"\? /);
    run.input.write('y\n');
    await workJob(url, await next.complete(), jobId, { claimant: 'stand-in', report: 'bridge first report' });
    await run.until(/Your worker finished req_[-\w]+\. Report:\nbridge first report/);
    run.input.end();
    assert.deepEqual(await run.finished, {});
  } finally { await run.close(); }
});

// The bridge approves a native attempt by its own code and never refuses it for a newer one. The owner answered y to the
// code on screen, so that code is approved; the attempt that began meanwhile is asked next.
test('a native attempt that a newer one follows before the approval runs is approved by its own code, then the newer is asked', { timeout: 120_000 }, async () => {
  let hook = null;
  const run = await liveTry('newer-between', { beforeCommand: async args => { if (args[1] === 'approve' && hook) { const fire = hook; hook = null; await fire(); } } });
  try {
    const url = await tryUrl(run);
    const jobId = (await run.until(/Job (req_[-\w]+) is queued for your worker/))[1];
    await run.until(/Waiting for your worker/);
    const first = await beginPairing(url, { redirect: 'http://localhost:43191/callback', clientName: 'first', timeoutMs: 500 });
    await run.until(new RegExp(`code\\s+${first.code}`));
    await run.until(/Approve this connection for worker "local"\? /);
    let second = null;
    hook = async () => { second = await beginPairing(url, { redirect: 'http://localhost:43193/callback', clientName: 'second' }); };
    run.input.write('y\n');
    await run.until(/Approved\. Waiting for the worker to finish the job\./);
    assert.doesNotMatch(run.out, /no longer current/);
    await run.until(new RegExp(`code\\s+${second.code}`));
    run.out = run.out.slice(run.out.lastIndexOf(second.code));
    await run.until(/Approve this connection for worker "local"\? /);
    run.input.write('y\n');
    await workJob(url, await second.complete(), jobId, { claimant: 'stand-in', report: 'bridge first report' });
    await run.until(/Your worker finished req_[-\w]+\. Report:\nbridge first report/);
    run.input.end();
    assert.deepEqual(await run.finished, {});
  } finally { await run.close(); }
});
