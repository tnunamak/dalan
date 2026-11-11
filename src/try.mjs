// `dalan try`: the README's same-machine walk as one command. It creates a private trial home, starts the loopback
// server, pairs a built-in demo worker through the real OAuth flow and finishes one job. Then it queues a second
// job for the user's own worker, asks before approving that worker, and waits for its report.
// Every bridge action is the ordinary `dalan` command or `src/server.mjs`, run as a child process with the trial home as HOME.
import { terminalSafe } from './terminal-safe.mjs';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { defaultPath } from './paths.mjs';
import { cliCommand } from './cli-name.mjs';
import { docsUrl } from './docs-url.mjs';
import { workerPrompt } from './worker-prompt.mjs';
import { createLineMasker, safeDiagnostic } from './diagnostic.mjs';
import { registerSecret } from './redaction.mjs';
import { PAIRING_MINUTES, untrusted } from './as-files.mjs';
import { beginPairing, DEMO_REDIRECT, workJob, workRepositoryJob } from './demo-worker.mjs';
import { writeWorkerInstructions } from './worker-instructions.mjs';
import { SOCKET_PATH_LIMIT } from './admin-socket.mjs';


const repo = path.resolve(import.meta.dirname, '..');
const WORKER = 'local';
const BRIEF = 'Report the exact phrase: bridge first report. Do not read files, run commands or call external services.';
const REPORT = 'bridge first report';
const MARKER = '.dalan-trial';
const DEFAULT_CALLBACKS = ['http://127.0.0.1/callback', 'http://localhost/callback'];
const USAGE = 'usage: dalan try [--local | --public [--client chatgpt|claude] [--route auto|tailscale|cloudflare]] [--home DIR] [--port N] [--callback PATTERN]...';
const DEMO_REPO = 'dalan-demo/hello';
const DENIED_REPO = 'dalan-demo/other';
const DEMO_TITLE = 'Hello from the Dalan demo repository';
const DIAGNOSE_AFTER_MS = 60_000; // no worker has claimed the job after this long: say what to check
const DIAGNOSE_EVERY_MS = 300_000;
const DIAGNOSE_LIMIT = 3;
const POLL_MS = 1500;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Every command the user must run sits alone on a line, indented, with nothing after it, so it can be pasted as written.
const commandLine = command => `  ${command}`;
const commandBlock = (label, ...commands) => `${label}\n${commands.map(commandLine).join('\n')}`;

// A home that does not exist yet and a port that is free now, for the "start over somewhere else" command. A reused trial home
// is tied to its port, so a new port needs a new home.
async function alternateTrial(preferPort) {
  const free = async skip => {
    if (preferPort && await portFree(preferPort)) return preferPort;
    for (let port = 8799; port < 8820; port++) if (port !== skip && await portFree(port)) return port;
    return null;
  };
  for (const base of [fs.realpathSync(os.homedir()), fs.realpathSync(os.tmpdir())]) {
    for (let n = 2; n < 100; n++) {
      const home = path.join(base, `.dalan-trial-${n}`);
      if (fs.existsSync(home) || Buffer.byteLength(defaultPath(home, '.local/share/dot-bridge', 'admin.sock')) > SOCKET_PATH_LIMIT) continue;
      return { home, port: await free(null) };
    }
  }
  return null;
}

function formatTryError(error, context, alternate = null) {
  const cause = safeDiagnostic(error?.message ?? String(error), 4000);
  const cli = context.cli ?? `node ${context.shellCli}`;
  const flags = context.tryFlags ?? ''; // a public trial restarts as a public trial
  const newHome = label => alternate && commandBlock(label, `${cli} try${flags} --home ${shellQuote(alternate.home)}${alternate.port ? ` --port ${alternate.port}` : ''}`);
  const recover = (head, withNewHome) => [`${cause}${head}`, commandBlock('Read the log with:', `cat ${context.shellLog}`),
    commandBlock('Retry this home with:', `${cli} try${flags} --home ${context.shellHome}`), withNewHome ? newHome('To try again in a new home instead, run:') : null].filter(Boolean).join('\n');
  if (error?.tryKind === 'startup') return recover(`\nThe bridge did not start. Full log: ${context.logFile}`, true);
  if (context.started) {
    const invariant = error?.tryKind === 'invariant' ? '\nStop and report this failure; do not grant broader access.' : '';
    return recover(`${invariant}\nServer log: ${context.logFile}`, error?.tryKind === 'unexpected');
  }
  if (error?.tryKind === 'already_running') return cause;
  if (error?.tryKind === 'route_start') {
    // The route, not the home, failed: the same home retries cleanly, and the other route or a local trial are the real alternatives.
    const otherRoute = /--route tailscale\b/.test(flags) && !/--client claude\b/.test(flags) ? commandBlock('Or use a temporary Cloudflare route instead:', `${cli} try${flags.replace('--route tailscale', '--route cloudflare')} --home ${context.shellHome}`) : null;
    return [`${cause}\nThe public route did not start, so the bridge was not started.`, commandBlock('Try again with:', `${cli} try${flags} --home ${context.shellHome}`), otherRoute,
      commandBlock('Or try on this computer only:', `${cli} try --local`)].filter(Boolean).join('\n');
  }
  const notStarted = `${cause}\nThe server has not started; no server log was created for this attempt.`;
  if (error?.freePort && context.shellHome) return `${notStarted}\n${commandBlock('Stop that program, or run the trial on a free port:', `${cli} try${flags} --home ${context.shellHome} --port ${error.freePort}`)}`;
  return `${notStarted}\nFix the problem above, then run the command again.${alternate ? ` ${newHome('Or start a trial in a new home:')}` : ''}`;
}

function printTryError(out, error, context) { out.write(`dalan: ${formatTryError(error, context)}\n`); }

// The message `dalan try` prints for a failure, with a concrete new-home command where one helps.
export async function describeTryError(error, context) {
  return formatTryError(error, context, await alternateTrial(error?.alternatePort).catch(() => null));
}

export function parseTryArgs(argv) {
  const out = { home: null, port: null, callbacks: [] };
  const choices = { '--client': ['chatgpt', 'claude'], '--route': ['auto', 'tailscale', 'cloudflare'] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--local' || flag === '--public') { out.mode = flag.slice(2); continue; }
    if (!['--home', '--port', '--callback', '--client', '--route'].includes(flag)) throw new Error(`unknown option ${JSON.stringify(flag)}\n${USAGE}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    i++;
    if (flag === '--home') out.home = value;
    else if (flag === '--callback') out.callbacks.push(value);
    else if (flag in choices) {
      if (!choices[flag].includes(value)) throw new Error(`${flag} must be one of: ${choices[flag].join(', ')}`);
      out[flag.slice(2)] = value;
    } else if (/^\d+$/.test(value) && Number(value) > 0 && Number(value) < 65536) out.port = Number(value);
    else throw new Error('--port requires a number from 1 to 65535');
  }
  // Conflicts are refused here, before any file, process or route exists. --client and --route only make sense for a public trial.
  const hostedOnly = ['client', 'route'].filter(key => out[key] !== undefined);
  if (out.mode === 'local' && hostedOnly.length) throw new Error(`--local cannot be combined with --${hostedOnly[0]}; those options are for a public trial`);
  if (hostedOnly.length && !out.mode) out.mode = 'public';
  if (out.mode === 'public' && out.callbacks.length) throw new Error('--callback is for a local client; a public trial uses the selected client\'s own callback');
  return out;
}

// The shape of `dalan connect pending --json`. Anything else is an error: this decides what the owner is asked to
// approve, so a changed format must stop the command, not leave a connection silently unasked.
export function parsePending(result) {
  const bad = why => new Error(`unexpected output from \`dalan connect pending --json\` (${why}); not guessing which connection to approve`);
  if (!result || typeof result !== 'object' || !Array.isArray(result.pending)) throw bad('no pending list');
  if (result.window !== null && typeof result.window?.worker !== 'string') throw bad('bad window');
  const pending = result.pending.map(p => {
    for (const key of ['code', 'client_id', 'redirect_uri']) if (typeof p?.[key] !== 'string' || !p[key]) throw bad(`attempt without ${key}`);
    if (!Array.isArray(p.scopes)) throw bad('attempt without scopes');
    return {
      code: p.code, worker: typeof p.worker === 'string' ? p.worker : '', client_id: p.client_id, client_name: typeof p.client_name === 'string' ? p.client_name : '', redirect_uri: p.redirect_uri,
      resource: typeof p.resource === 'string' ? p.resource : '', scopes: p.scopes.map(String), superseded: p.superseded === true, native: p.native === true,
      expires_in_seconds: Number.isFinite(p.expires_in_seconds) ? p.expires_in_seconds : null,
    };
  });
  // The trial bridge listens on loopback only and its one owner is the one person starting the client, so a client that
  // starts again abandons its older attempt: only the newest native attempt is put to the owner. The bridge itself never
  // supersedes a native attempt, so this is a choice of what `try` asks, not a rule it enforces.
  const newestNative = pending.filter(p => p.native && !p.superseded).at(-1);
  return { window: result.window, pending: pending.map(p => p.native && !p.superseded && p !== newestNative ? { ...p, superseded: true } : p) };
}

// What the owner sees for one attempt. The resource is the MCP URL the app asked to use. A bridge that does not report
// it is shown as such (not hidden), and a resource that is not this bridge's own URL blocks approval.
export function describeAttempt(attempt, expectedResource) {
  const q = value => JSON.stringify(untrusted(value, 200));
  const resourceMatches = attempt.resource === '' ? null : attempt.resource === expectedResource;
  const resourceLine = resourceMatches === null ? 'resource    (not reported: this bridge did not say which resource the app asked for)'
    : resourceMatches ? `resource    ${q(attempt.resource)}` : `resource    ${q(attempt.resource)}  <-- NOT this bridge's MCP URL`;
  const text = [
    `code        ${attempt.code}`, `client_id   ${q(attempt.client_id)}`, `client_name [untrusted, set by the app] ${q(attempt.client_name)}`,
    `redirect    ${JSON.stringify(String(attempt.redirect_uri ?? '').replace(/[\p{C}\p{Z}]+/gu, ' ').trim())}`, resourceLine, `scopes      ${attempt.scopes.map(q).join(' ')}`,
    ...(attempt.native ? ['WARNING     native client identity is unverified; host and name prove nothing. Approve only if this code matches the browser page you opened, or the code the person at the worker read to you over a trusted channel.'] : []),
  ].join('\n');
  return { text, blocked: resourceMatches === false, resourceReported: resourceMatches !== null };
}

const portFree = port => new Promise(resolve => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});

// Whether a bridge answers on this admin socket: then the trial bridge for that home is already running.
const socketAnswers = file => new Promise(resolve => {
  const probe = net.connect(file);
  const done = value => { probe.destroy(); resolve(value); };
  probe.setTimeout(1000, () => done(false));
  probe.once('connect', () => done(true));
  probe.once('error', () => done(false));
});

// A free port is a hint: another process can take it before the server binds, so the caller retries on a bind failure.
async function choosePort({ requested, stored, skip = new Set() }) {
  const wanted = requested ?? stored;
  if (wanted) {
    if (await portFree(wanted)) return wanted;
    // A reused home is tied to its saved port: its issuer URL names it. Another port needs another home.
    if (stored) throw new Error(`port ${wanted} is in use (is another trial still running?). This trial home is tied to port ${stored}. Stop the process that uses it, or start a separate trial in a new home`);
    // This home is not tied to a port yet, so the same home can run on a free one.
    const error = new Error(`cannot start the trial bridge: port ${wanted} is in use by another program`);
    for (let port = 8799; port < 8820; port++) if (port !== wanted && !skip.has(port) && await portFree(port)) { error.freePort = port; break; }
    throw error;
  }
  for (let port = 8799; port < 8820; port++) if (!skip.has(port) && await portFree(port)) return port;
  throw new Error('no free port in 8799-8819; choose one with --port N');
}

// The real path of `target` even when it does not exist yet: the nearest existing ancestor, resolved, plus the rest.
function realPathThroughAncestors(target) {
  const rest = [];
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) { rest.unshift(path.basename(existing)); existing = path.dirname(existing); }
  return path.join(fs.realpathSync(existing), ...rest);
}

// Decide the trial home, and create it, only after every refusal has been checked. Nothing is created for a refused home.
function prepareHome(candidate, realHome) {
  const home = path.resolve(candidate);
  if (realPathThroughAncestors(home) === realHome) throw new Error('refusing to use your real home as the trial home; choose another with --home DIR');
  if (fs.existsSync(home)) {
    if (!fs.statSync(home).isDirectory()) throw new Error(`${home} is not a directory; choose another with --home DIR`);
    if (!fs.existsSync(path.join(home, MARKER)) && fs.readdirSync(home).length) {
      throw new Error(`${home} already holds files that a trial did not create (it could be a real Dalan home); choose a new or empty directory with --home DIR`);
    }
  }
  const socket = defaultPath(home, '.local/share/dot-bridge', 'admin.sock');
  if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) throw new Error(`the trial home path is too long for the bridge's admin socket (${Buffer.byteLength(socket)} bytes, limit ${SOCKET_PATH_LIMIT}); choose a shorter --home DIR`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.writeFileSync(path.join(home, MARKER), 'created by `dalan try`\n', { mode: 0o600 });
  return home;
}

// A one-commit repository that lives in the trial home. The commit time is fixed, so the revision is the same on every run.
// Returns the bare repository path and the full revision, or null with a reason when git or python3 (which the mirror
// fetch needs) is missing.
async function prepareDemoRepository(home, signal, tryAgain) {
  const run = (cmd, args, options = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30_000, signal, ...options },
    (error, stdout, stderr) => error ? reject(new Error(`${cmd} ${args.join(' ')} failed: ${safeDiagnostic((stderr || error.message).trim(), 4000)}`)) : resolve(stdout.trim())));
  for (const [tool, arg, fix] of [['git', '--version', 'install Git'], ['python3', '--version', 'install Python 3.8 or newer']]) {
    try { await run(tool, [arg]); } catch (error) { if (signal?.aborted) throw error; return { reason: `${tool} was not found on PATH; ${fix}, then run this command again to see the repository step:\n${commandLine(tryAgain)}` }; }
  }
  const dir = path.join(home, 'demo'), bare = path.join(dir, 'hello.git');
  if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory())) throw new Error(`${dir} is not a plain directory; remove it, then run this command again:\n${commandLine(tryAgain)}`);
  if (fs.existsSync(bare) && fs.lstatSync(bare).isSymbolicLink()) throw new Error(`${bare} is a symbolic link; remove it, then run this command again:\n${commandLine(tryAgain)}`);
  // The same sanitized environment builds the repository and reads its revision, so no host Git setting reaches either step.
  const when = '2026-01-01T00:00:00Z';
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dalan demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Dalan demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  if (!fs.existsSync(bare)) {
    fs.mkdirSync(dir, { recursive: true });
    // A fresh scratch directory each time: an interrupted earlier run or a planted link cannot be reused or followed.
    const work = fs.mkdtempSync(path.join(dir, 'work-'));
    try {
      fs.writeFileSync(path.join(work, 'README.md'), `# ${DEMO_TITLE}\n\nThis repository exists only for \`dalan try\`.\n`);
      await run('git', ['-c', 'init.templateDir=', '-C', work, 'init', '-q', '-b', 'main', '--object-format=sha1'], { env });
      await run('git', ['-C', work, 'add', 'README.md'], { env });
      await run('git', ['-C', work, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', 'Add the demo README'], { env });
      await run('git', ['-c', 'init.templateDir=', 'clone', '-q', '--bare', work, bare], { env });
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  }
  return { bare, sha: await run('git', ['-C', bare, 'rev-parse', 'refs/heads/main'], { env }) };
}

// `pickPort` and `clock` are seams for tests: the first stands in for the free-port search so a lost race can be reproduced,
// the second for the time and the wait between polls so minutes of waiting need no real minutes.
// The worker wrote the report; it reaches the terminal only through terminalSafe, right before the acceptance prompt.
export function finishedNotice(jobId, job) { return terminalSafe(`\n✔ Your worker finished ${jobId}. Report:\n${job.report?.result ?? '(empty)'}`); }

export async function runTry({ argv = [], env = process.env, out = process.stdout, input = process.stdin, signal, pickPort = choosePort, errorContext = {}, clock = { now: Date.now, sleep }, beforeCommand = null, hosted = {} } = {}) {
  const options = parseTryArgs(argv);
  // The mode is asked only on a terminal. A pipe, CI or `< /dev/null` never opens a public route: it runs the local self-check.
  const interactive = hosted.interactive ?? Boolean(input.isTTY && out.isTTY);
  if (options.mode === 'public' || (!options.mode && interactive)) {
    const hostedMode = await import('./try-hosted.mjs');
    if (!options.mode) Object.assign(options, await hostedMode.chooseMode({ input, out, signal }));
    if (options.mode === 'public') {
      const cli = errorContext.cli ?? `node ${errorContext.shellCli ?? shellQuote(path.join(repo, 'bin/dalan.mjs'))}`;
      if (!interactive) throw new Error(`Hosted setup needs an interactive terminal for the URL and connection approval. Run this in an interactive terminal:\n${commandLine(`${cli} try --public --client ${options.client ?? 'chatgpt'}`)}`);
      return hostedMode.runHosted({ options, env, out, input, signal, errorContext, clock, deps: hosted, helpers: tryInternals });
    }
  }
  const realHome = fs.realpathSync(os.homedir());
  const home = prepareHome(options.home ?? env.DALAN_HOME ?? path.join(realHome, '.local/share/dalan-trial'), realHome);
  errorContext.home = home;
  const say = line => out.write(`${terminalSafe(line)}\n`);
  // Commands the user is told to run: the checkout's own CLI by absolute path (dalan need not be on PATH), with the trial home.
  const cliPath = errorContext.shellCli ?? shellQuote(path.join(repo, 'bin/dalan.mjs'));
  const cli = errorContext.cli ?? `node ${cliPath}`;
  const ownCommand = (...words) => `DALAN_HOME=${shellQuote(home)} ${cli} ${words.join(' ')}`;
  const started = Date.now();
  say(`Dalan trial. Home: ${home}`);
  const shellHome = shellQuote(home);
  errorContext.shellHome = shellHome;

  const configDir = defaultPath(home, '.config/dot-bridge');
  const freshHome = !fs.existsSync(path.join(configDir, 'workers.json'));
  let storedPort = null;
  try { storedPort = Number(new URL(JSON.parse(fs.readFileSync(path.join(configDir, 'as.json'), 'utf8')).public_url).port) || null; } catch { /* a new home */ }
  // This home's own bridge already holds its port. Say so before anything below touches the running trial's grant or files.
  if (storedPort && !await portFree(storedPort) && await socketAnswers(defaultPath(home, '.local/share/dot-bridge', 'admin.sock'))) {
    const error = new Error(`the trial bridge for this home is already running on http://127.0.0.1:${storedPort}. Use it from another terminal (export DALAN_HOME=${shellHome}), or stop it with Ctrl-C in its terminal first.`);
    error.tryKind = 'already_running';
    throw error;
  }
  // The saved public URL names the port and is the issuer; changing it ends every connection. Do not start on another port.
  if (storedPort && options.port && options.port !== storedPort) {
    const error = new Error(`this trial home is tied to port ${storedPort}; it cannot run on port ${options.port}. Start a separate trial in a new home on that port`);
    error.alternatePort = options.port;
    throw error;
  }

  // Input that has ended (`dalan try < /dev/null`, a closed terminal) is treated like Ctrl-C once the demo is done:
  // nobody can answer a question or press Ctrl-C, so the bridge stops instead of waiting for a signal that cannot come.
  const lines = readline.createInterface({ input });
  let inputEnded = false;
  lines.once('close', () => { inputEnded = true; });
  const stopRequested = () => signal?.aborted || inputEnded;
  const stopPromise = new Promise(resolve => {
    if (signal?.aborted) resolve();
    signal?.addEventListener('abort', resolve, { once: true });
    lines.once('close', resolve);
  });
  // A wait for the owner also ends when the bridge process ends: nobody can finish what the owner is being asked about.
  // `stopped` is replaced when the server restarts, so it is read at the time of the wait.
  const untilStopRequested = () => Promise.race([stopPromise, stopped]);
  // null means no answer: Ctrl-C, the input ended, or the bridge exited.
  const ask = question => {
    if (stopRequested() || exited) return null;
    out.write(question);
    return new Promise(resolve => {
      const done = answer => { lines.off('line', done); lines.off('close', onClose); signal?.removeEventListener('abort', onClose); resolve(answer); };
      const onClose = () => done(null);
      lines.once('line', done); lines.once('close', onClose); signal?.addEventListener('abort', onClose, { once: true });
      stopped.then(onClose);
    });
  };

  // Repository workspaces are on in the trial. Only the demo repository is redirected, to the local copy above, so the
  // repository step needs no network and no GitHub login. Every other repository is denied until the owner grants it.
  const baseEnv = {
    ...Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'NODE_OPTIONS'].filter(k => env[k] !== undefined).map(k => [k, env[k]])),
    // A clone URL for a repository the owner names (a local path works), so a worker can use a local clone with no GitHub login.
    ...Object.fromEntries(Object.entries(env).filter(([k, v]) => /^DALAN_GITHUB_URL_[A-Z0-9_]+$/.test(k) && v)),
    HOME: home, DALAN_LOOPBACK: '1', DALAN_AUTH_MODE: 'builtin',
    DALAN_ENABLE_WORKSPACE: '1', DALAN_WORKSPACE_ROOT: path.join(home, 'workspace'), DALAN_MIN_FREE_BYTES: String(256 * 2 ** 20),
  };
  let demoRepo = { reason: 'not prepared' };
  let port = null;
  const dalan = async args => { await beforeCommand?.(args); return runDalan(args); };
  const runDalan = args => new Promise((resolve, reject) => execFile(process.execPath, [path.join(repo, 'bin/dalan.mjs'), ...args],
    { env: { ...baseEnv, DALAN_PORT: String(port) }, cwd: repo, timeout: 30_000, signal }, (error, stdout, stderr) =>
      error ? reject(new Error(`dalan ${args.slice(0, 2).join(' ')} failed: ${safeDiagnostic((stderr || stdout || error.message).trim(), 4000)}`)) : resolve(stdout)));

  // The trial owns `demo/` and the `req_*.json` request files in its home. Its one authority change is the demo grant.
  // Cleanup runs from the same place on every exit, and again at the next start for a run that was killed. It uses no abort
  // signal, so Ctrl-C cannot cancel the revocation. Job history stays in the trial home: only the grant and the files go.
  const grantHeld = () => {
    try { return JSON.parse(fs.readFileSync(path.join(configDir, 'workers.json'), 'utf8')).workers?.[WORKER]?.repos?.some(r => String(r).toLowerCase() === DEMO_REPO) === true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  // Returns true only when the grant is confirmed gone and the demo files are removed.
  const cleanupTrial = async () => {
    let clean = true;
    try {
      if (grantHeld()) {
        await new Promise((resolve, reject) => execFile(process.execPath, [path.join(repo, 'bin/dalan.mjs'), 'worker', 'deny', WORKER, DEMO_REPO],
          { env: { ...baseEnv, DALAN_PORT: String(port ?? storedPort ?? 8799) }, cwd: repo, timeout: 30_000 }, error => error ? reject(error) : resolve()));
        if (grantHeld()) throw new Error('the grant is still in the profile');
      }
    } catch (error) {
      clean = false;
      printTryError(out, new Error(`Could not revoke the demo grant (${error.message.split('\n')[0]}).\n${commandBlock('Revoke it with:', ownCommand('worker', 'deny', WORKER, DEMO_REPO))}`), errorContext);
      process.exitCode = 1;
    }
    try {
      fs.rmSync(path.join(home, 'demo'), { recursive: true, force: true });
      for (const name of fs.readdirSync(home)) if (/^req_[0-9a-f-]+\.json$/.test(name)) fs.rmSync(path.join(home, name), { force: true });
    } catch (error) { clean = false; printTryError(out, new Error(`Could not remove the demo files in ${home}: ${error.message}`), errorContext); }
    return clean;
  };

  const logFile = path.join(home, 'server.log');
  errorContext.logFile = logFile;
  errorContext.shellLog = shellQuote(logFile);
  let server = null, exited = true, stopped = Promise.resolve();
  const startServer = () => {
    const log = fs.openSync(logFile, 'w', 0o600);
    fs.fchmodSync(log, 0o600);
    exited = false;
    fs.closeSync(log);
    // Server output is sanitized line by line before it is persisted; a partial line is held until it completes.
    server = spawn(process.execPath, [path.join(repo, 'src/server.mjs')], { env: { ...baseEnv, DALAN_PORT: String(port) }, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    const child = server;
    const sinks = [child.stdout, child.stderr].map(stream => {
      const persist = createLineMasker(text => fs.appendFileSync(logFile, text));
      stream.setEncoding('utf8').on('data', chunk => persist(chunk));
      return persist;
    });
    stopped = new Promise(resolve => {
      child.once('close', () => { for (const flush of sinks) flush('', true); exited = true; resolve(); });
      child.once('error', error => { fs.appendFileSync(logFile, `spawn failed: ${safeDiagnostic(error.message, 1000)}\n`); exited = true; resolve(); });
    });
  };
  const stop = async () => {
    if (exited) return;
    server.kill('SIGTERM');
    await Promise.race([stopped, sleep(5000)]);
    if (!exited) { server.kill('SIGKILL'); await stopped; }
  };
  const waitForListening = async () => {
    for (let waited = 0; !/MCP listening/.test(fs.readFileSync(logFile, 'utf8')); waited += 100) {
      if (exited || waited > 20_000) return false;
      signal?.throwIfAborted();
      await sleep(100);
    }
    return true;
  };

  let cleaned = false;
  try {
    await cleanupTrial(); // state left by a run that was killed
    signal?.throwIfAborted();
    demoRepo = await prepareDemoRepository(home, signal, `${cli} try --home ${shellHome}`);
    if (demoRepo.bare) baseEnv.DALAN_GITHUB_URL_DALAN_DEMO_HELLO = demoRepo.bare;
    // The probe for a free port can lose a race with another process, so a bind failure on a port this command chose
    // retries on the next free one. A port the user named, or one a reused home already points at, is not changed.
    const tried = new Set();
    for (let attempt = 1; ; attempt++) {
      port = await pickPort({ requested: options.port, stored: storedPort, skip: tried });
      tried.add(port);
      if (freshHome) await dalan(['init', '--worker', WORKER, '--public-url', `http://127.0.0.1:${port}`]);
      startServer();
      if (await waitForListening()) break;
      const logged = fs.readFileSync(logFile, 'utf8').trim();
      const tail = logged.split('\n').slice(-5).join('\n');
      await stop();
      if (attempt < 3 && freshHome && !options.port && /EADDRINUSE/.test(logged)) { fs.rmSync(configDir, { recursive: true, force: true }); continue; }
      const error = new Error(`the bridge did not start; last log lines:\n${tail}`);
      error.tryKind = 'startup';
      throw error;
    }
    errorContext.started = true;
    say(`✔ Bridge up on http://127.0.0.1:${port}. Loopback only. Log: ${logFile}`);
    const secret = /^BRIDGE_PATH_SECRET=(.+)$/m.exec(fs.readFileSync(path.join(configDir, 'env'), 'utf8'))?.[1];
    registerSecret(secret);
    const mcpUrl = `http://127.0.0.1:${port}/${secret}/mcp`;
    // `connect pending` masks the path secret, so compare against the masked form.
    const shownMcpUrl = `${new URL(mcpUrl).origin}/<secret>/mcp`;
    // The URL is a credential, so it goes to a private file in the trial home, never to the output.
    const urlFile = path.join(home, 'resource-url');
    fs.rmSync(urlFile, { force: true });
    fs.writeFileSync(urlFile, `${mcpUrl}\n`, { mode: 0o600 });
    fs.chmodSync(urlFile, 0o600);
    writeWorkerInstructions(home);

    for (const pattern of [...DEFAULT_CALLBACKS, ...options.callbacks]) await dalan(['connect', 'allow-callback', pattern]);
    await dalan(['connect', 'start', '--worker', WORKER]);

    const submit = async () => {
      const requestId = `req_${randomUUID()}`;
      const file = path.join(home, `${requestId}.json`);
      fs.writeFileSync(file, JSON.stringify({ schema_version: 1, request_id: requestId, brief: BRIEF, inputs: [], expected_output: `Text report containing: ${REPORT}.`, execution_scope: 'read-only' }), { mode: 0o600 });
      await dalan(['submit', '--worker', WORKER, '--execution', 'none', '--deliver', 'none', '--file', file, '--json']);
      return requestId;
    };
    const job = async requestId => JSON.parse(await dalan(['get', requestId, '--json']));
    const pendingNow = async () => parsePending(JSON.parse(await dalan(['connect', 'pending', '--json'])));

    // 1. The built-in demo worker: real pairing, a real MCP session, real job tools. Ctrl-C stops every step.
    const demoId = await submit();
    const pairing = await beginPairing(mcpUrl, { signal });
    await dalan(['connect', 'approve', pairing.code, '--worker', WORKER, '--confirm-redirect', DEMO_REDIRECT, '--replace']);
    const token = await pairing.complete();
    await workJob(mcpUrl, token, demoId, { report: REPORT, signal });
    const done = await job(demoId);
    if (done.status !== 'finished' || done.report?.result !== REPORT) throw new Error(`demo job did not finish as expected: ${done.status}`);
    await dalan(['decide', demoId, 'accepted']);
    const firstJobSeconds = ((Date.now() - started) / 1000).toFixed(1);
    let selfCheck = `a demo worker, approved by this command, finished a job`;

    // 2. A repository job: refused before a grant, then finished by the same demo worker through the real claim path.
    if (!demoRepo.bare) printTryError(out, new Error(`Repository step skipped: ${demoRepo.reason}`), errorContext);
    else {
      const submitRepo = async (repoName, requestId) => {
        const file = path.join(home, `${requestId}.json`);
        fs.writeFileSync(file, JSON.stringify({ schema_version: 1, request_id: requestId, brief: 'Read README.md at the pinned commit and report its title. Do not run checks or change files.',
          inputs: [{ github_repo: repoName, base_sha: demoRepo.sha }], expected_output: 'README title and pinned revision; no patch or check claim.', scope_paths: ['README.md'], execution_scope: 'read-only' }), { mode: 0o600 });
        return dalan(['submit', '--worker', WORKER, '--execution', 'none', '--deliver', 'none', '--file', file, '--json']);
      };
      let refusal = null;
      const deniedId = `req_${randomUUID()}`;
      try { await submitRepo(DENIED_REPO, deniedId); } catch (error) { refusal = error.message; }
      // The refusal must also leave no job behind: `get` must not find it.
      const leftBehind = await job(deniedId).then(() => true, error => { if (!/"code":"unknown_request"/.test(error.message)) throw error; return false; });
      if (!refusal || !/not allowed/.test(refusal) || leftBehind) { const error = new Error(`a repository job for ${DENIED_REPO} was not refused cleanly before any grant; stopping`); error.tryKind = 'invariant'; throw error; }
      await dalan(['worker', 'allow', WORKER, DEMO_REPO]);
      // The grant is exact: another repository is still refused, and the refusal is recorded.
      const stillDenied = await submitRepo(DENIED_REPO, `req_${randomUUID()}`).then(() => false, error => /not allowed/.test(error.message));
      if (!stillDenied) { const error = new Error(`a repository job for ${DENIED_REPO} was not refused after the grant; stopping`); error.tryKind = 'invariant'; throw error; }
      const repoId = `req_${randomUUID()}`;
      await submitRepo(DEMO_REPO, repoId);
      await workRepositoryJob(mcpUrl, token, repoId, { sha: demoRepo.sha, signal });
      const repoDone = await job(repoId);
      if (repoDone.status !== 'finished' || !repoDone.report?.result?.includes(DEMO_TITLE) || !repoDone.report.result.includes(demoRepo.sha)) throw new Error(`repository demo job did not finish as expected: ${repoDone.status}`);
      await dalan(['decide', repoId, 'accepted']);
      selfCheck += '; the repository grant works and a second repository is refused';
    }
    say(`✔ Self-check passed in ${firstJobSeconds} s: ${selfCheck}.`);
    // The demo's work is done, so end its connection. Your worker then pairs without replacing anything.
    await dalan(['connect', 'revoke', WORKER]);

    // 3. The user's own worker.
    if (inputEnded && !signal?.aborted) {
      say('\nInput ended, so nobody can approve a worker. Stopping the bridge. To connect your worker, run:');
      say(`  ${cli} try --home ${shellHome}`);
    } else {
      const jobId = await submit();
      say('');
      say('Connect your worker as an HTTP MCP server with OAuth:');
      say(`  MCP URL file: ${urlFile}`);
      say(`  MCP URL (secret hidden): ${shownMcpUrl}`);
      say('  Keep the URL private.');
      say(`  How to connect Claude Code, Codex or another client: ${docsUrl('README.md', 'connect-your-own-worker')}`);
      say(`  Callbacks: ${[...DEFAULT_CALLBACKS, ...options.callbacks].join(', ')}. To add one, restart with:`);
      say(commandLine(`${cli} try --home ${shellHome}${options.callbacks.map(pattern => ` --callback ${shellQuote(pattern)}`).join('')} --callback PATTERN`));
      say(`Job ${jobId} is queued for your worker. When it is connected, send it:`);
      say(`  "${workerPrompt(jobId)}"`);
      say('Waiting for your worker. Ctrl-C stops the bridge.');

      const seen = new Set();
      let approved = false, reminded = 0, retryNow = false;
      let remindAt = clock.now() + DIAGNOSE_AFTER_MS;
      const remind = () => {
        say(`\nStill waiting for your worker to claim ${jobId}.${approved ? ' It was approved but has not claimed the job yet. If you have not sent it the prompt above, send it now; if its sign-in failed, a new attempt appears here for approval.' : ''} Check from another terminal:`);
        for (const words of [['connect', 'pending'], ['connect', 'start', '--worker', WORKER], ['status']]) say(commandLine(ownCommand(...words)));
      };
      // The owner can answer after the client has started a newer attempt or the bridge dropped this one. An answer to such an
      // attempt is a refresh, not a failure: approve only an attempt that is still pending and newest, and if the bridge
      // refuses an approval, look again before treating it as an error.
      const deadlines = new Map();
      const stillCurrent = async attempt => (await pendingNow()).pending.some(p => p.code === attempt.code && !p.superseded);
      const approveIfCurrent = async attempt => {
        if (!await stillCurrent(attempt)) return false;
        try {
          const { replaced } = JSON.parse(await dalan(['connect', 'approve', attempt.code, '--worker', WORKER, ...(attempt.native ? ['--confirm-redirect', attempt.redirect_uri] : []), '--replace', '--json']));
          if (replaced) say(`Replaced connection ${replaced}, your worker's earlier sign-in.`);
          return true;
        }
        catch (error) { if (exited || await stillCurrent(attempt)) throw error; return false; }
      };
      while (!exited && !stopRequested()) {
        const current = await job(jobId);
        if (current.status === 'finished') {
          say(finishedNotice(jobId, current));
          const answer = await ask('Accept this result? [y/N] ');
          if (exited && !stopRequested()) break;
          if (answer?.trim().toLowerCase() === 'y') { await dalan(['decide', jobId, 'accepted']); say('Recorded as accepted.'); }
          else say(stopRequested() ? '\nNot recorded.' : `Not recorded. Decide later while the bridge runs:\n${commandLine(ownCommand('decide', jobId, 'accepted'))}`);
          if (!stopRequested()) { say('The bridge stays up. Ctrl-C stops it.'); await untilStopRequested(); }
          break;
        }
        // Until the worker claims the job, a client can still retry (its sign-in can fail after the owner approved), and
        // a retry is a new attempt that needs its own approval.
        if (current.status === 'queued') {
          let view = await pendingNow();
          if (!view.window) { await dalan(['connect', 'start', '--worker', WORKER]); view = await pendingNow(); }
          // A client can retry, so ask about each new code, newest last; superseded ones cannot finish.
          for (const attempt of view.pending) {
            if (seen.has(attempt.code) || attempt.superseded) continue;
            seen.add(attempt.code);
            if (attempt.expires_in_seconds !== null) deadlines.set(attempt.code, clock.now() + attempt.expires_in_seconds * 1000);
            const { text, blocked, resourceReported } = describeAttempt(attempt, shownMcpUrl);
            say(`\n${text}`);
            if (blocked) { say('Not approving: this attempt names a different MCP URL than this bridge.'); continue; }
            const note = resourceReported ? '' : ' The resource is not reported, so check that the redirect host is your client\'s.';
            const answer = await ask(`Approve this connection for worker "${WORKER}"?${note} [y/N] `);
            remindAt = Math.max(remindAt, clock.now() + DIAGNOSE_AFTER_MS);
            if (exited && !stopRequested()) break;
            if (answer?.trim().toLowerCase() === 'y') {
              if (await approveIfCurrent(attempt)) { approved = true; say('Approved. Waiting for the worker to finish the job.'); }
              else {
                if (deadlines.has(attempt.code) && clock.now() >= deadlines.get(attempt.code)) say(`That attempt expired after ${PAIRING_MINUTES} minutes. Start the sign-in again in your worker. If the pairing window closed, reopen it with:\n${commandLine(ownCommand('connect', 'start', '--worker', WORKER))}`);
                else say('That attempt is no longer current.');
                // Show the newest attempt at once; the next pass of the loop asks about it without waiting.
                const newest = (await pendingNow()).pending.filter(p => !p.superseded).at(-1);
                if (!newest) say('No newer attempt is waiting. Start the sign-in again in your worker; its new code appears here.');
                else if (seen.has(newest.code)) say(`The current code is ${newest.code}. Approve it with:\n${commandLine(ownCommand('connect', 'approve', newest.code, '--worker', WORKER, ...(newest.native ? ['--confirm-redirect', newest.redirect_uri] : []), '--replace'))}`);
                else retryNow = true;
              }
              break;
            }
            if (stopRequested()) { say('\nNot approved.'); break; }
            say(`Not approved. Approve later with:\n${commandLine(ownCommand('connect', 'approve', attempt.code, '--worker', WORKER, ...(attempt.native ? ['--confirm-redirect', attempt.redirect_uri] : []), '--replace'))}`);
          }
          if (reminded < DIAGNOSE_LIMIT && !exited && !stopRequested() && clock.now() >= remindAt) {
            remind();
            reminded++;
            remindAt = clock.now() + DIAGNOSE_EVERY_MS;
          }
        }
        if (retryNow) { retryNow = false; continue; }
        await Promise.race([clock.sleep(POLL_MS), untilStopRequested()]);
      }
      if (exited && !stopRequested()) { const error = new Error('the bridge stopped unexpectedly'); error.tryKind = 'unexpected'; throw error; }
      if (inputEnded && !signal?.aborted) say('Input ended. Stopping the bridge.');
    }
  } catch (error) {
    // Ctrl-C can land anywhere (a child command, a request, a wait); that is a normal stop, not a failure.
    if (signal?.aborted) { /* a normal stop */ }
    else if (exited && errorContext.started && !error.tryKind) {
      // A command failed because the bridge is gone: say that, with the same recovery as any other unexpected exit.
      const gone = new Error(`the bridge stopped unexpectedly (${String(error.message).split('\n')[0]})`);
      gone.tryKind = 'unexpected';
      throw gone;
    } else throw error;
  } finally {
    lines.close();
    await stop();
    cleaned = await cleanupTrial();
  }
  say(`Stopped. Trial home kept at ${home}; delete it to start over.${cleaned ? ' The demo grant and files are removed.' : ''}`);
  say(`Next steps (connect your own worker, repository jobs, other machines): ${docsUrl('README.md', 'next-steps')}`);
}

export { cliCommand };

// What the hosted flow shares with this one: the same home, port, quoting, approval and error rules.
export const tryInternals = { prepareHome, portFree, socketAnswers, choosePort, shellQuote, commandLine, commandBlock, MARKER, WORKER, parsePending, describeAttempt, formatTryError, alternateTrial, DIAGNOSE_AFTER_MS, DIAGNOSE_EVERY_MS, DIAGNOSE_LIMIT, POLL_MS, repo };

export async function main() {
  const controller = new AbortController();
  // The first signal starts the stop. Later ones are ignored so the cleanup can finish: npx forwards the terminal's
  // Ctrl-C to this process, so one keypress can arrive twice. The stop is bounded (server 5 s, revoke 30 s).
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => controller.abort());
  const errorContext = { started: false };
  errorContext.shellCli = shellQuote(path.resolve(process.argv[1] ?? path.join(repo, 'bin/dalan.mjs')));
  errorContext.cli = cliCommand(process.argv[1], process.env);
  try { await runTry({ argv: process.argv.slice(3), signal: controller.signal, errorContext }); }
  catch (error) { process.stderr.write(`dalan: ${await describeTryError(error, errorContext)}\n`); process.exitCode = 1; }
}
