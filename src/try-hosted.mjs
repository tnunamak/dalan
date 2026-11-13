// `dalan try --public`: the same trial, reached by a hosted MCP client. It starts a public route, a bridge whose
// OAuth issuer is that route's address, queues one demo job, prints the connector URL and the clicks, asks the owner to approve the
// sign-in, and calls the trial a success only when the hosted client finishes that job. The local flow in try.mjs is unchanged.
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { terminalSafe } from './terminal-safe.mjs';
import { waitForChildExit } from './child-exit.mjs';
import { createLineMasker, safeDiagnostic } from './diagnostic.mjs';
import { registerSecret } from './redaction.mjs';
import { defaultPath } from './paths.mjs';
import { PAIRING_MINUTES } from './as-files.mjs';
import { createGate, verifyPublicReady, watchPublicIdentity } from './try-exposure.mjs';
import { RouteError, buildQuery, describeCandidate, describeDisclosure, ensureDurableRoute, explainRouteError, gozarHomeFor, resolveGozar, startSessionRoute } from './gozar-routes.mjs';
import { readRouteSetting } from './route-setting.mjs';
import { childRegistry, registerChild, sweepChildren } from './child-registry.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOSTED_WORKER = 'hosted';
const PUBLIC_READY_MS = 60_000;
export const CONNECTOR_NAME = 'Dalan Trial';
const STEPS = [
  'In your MCP client, add a custom MCP server (a custom connector).',
  `Name it "${CONNECTOR_NAME}", paste the URL above, choose OAuth (automatic client registration if asked) and create it.`,
  `Open a chat, enable "${CONNECTOR_NAME}", start sign-in, and approve the matching code in this terminal.`,
];
export const hostedPrompt = (requestId, requestPhrase) =>
  `Use ${CONNECTOR_NAME} to list pending jobs, claim only ${requestId}, read its brief, and finish it with the requested report (${requestPhrase}). Stop if the job is missing or cancelled. Do not read files, run commands, or call other services.`;
// `url` is a credential, so the caller writes this text to the owner's terminal only, never to a log.
export const handoffText = ({ url }) => [`Connector name: ${CONNECTOR_NAME}`, 'Paste this URL into your connector (it is a secret; it stays on this terminal and in the private resource-url file):', url, '', ...STEPS.map((step, i) => `${i + 1}. ${step}`)].map(line => terminalSafe(line)).join('\n');
// Files that hold a credential of a finished trial. The job history stays.
// A home that a restart reuses keeps the bridge's own config (its path secret); the others lose it.
export function removeTrialSecrets(home, configDir, { keepConfig = false } = {}) {
  for (const file of [path.join(home, 'resource-url'), ...(keepConfig ? [] : [path.join(configDir, 'env')])]) fs.rmSync(file, { force: true });
}
const REPORT = 'bridge first report';

// One trial at a time per home. A lock file names its owner; a loser exits before it creates, truncates or removes anything.
export function acquireHomeLock(home) {
  const file = path.join(home, '.hosted-lock');
  const token = `${process.pid} ${randomBytes(8).toString('hex')}`;
  const busy = () => Object.assign(new Error(`another trial is using this home; stop it first or choose a new --home (if none is running, delete ${file})`), { tryKind: 'already_running' });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, token); fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, 'utf8') === token) fs.rmSync(file, { force: true }); } catch { /* gone */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raw = fs.readFileSync(file, 'utf8').trim();
      const match = /^([1-9]\d*)(?:\s+\S+)?$/.exec(raw);
      const pid = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(pid)) throw busy();
      try { process.kill(pid, 0); throw busy(); } catch (probe) { if (probe.tryKind || probe.code !== 'ESRCH') throw busy(); }
      fs.rmSync(file, { force: true }); // its owner is gone
    }
  }
  throw busy();
}

// Said once, before any public address exists. Setup chooses a route; it does not install a service.
export const TRIAL_NOTICE = 'Temporary demo link. It can change or stop without warning. Run `dalan setup` to choose a stable route. Setup does not install a background service.';
// A trial's maximum local lifetime is a shutdown limit, not a promise that a public route will stay available.
export const TRIAL_MS = 3 * 60 * 60 * 1000;
export const timeLeft = ms => { const minutes = Math.max(0, Math.ceil(ms / 60_000)); return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`; };
export const REAL_NOTICE = fromSetup => `Using a stable route${fromSetup ? ', the address you saved with `dalan setup`' : ''}. This is not a trial link.`;

// Reads answers from one terminal reader and closes it, so the trial's own reader starts clean.
export async function chooseMode({ input, out, signal }) {
  const lines = readline.createInterface({ input });
  let ended = false;
  lines.once('close', () => { ended = true; });
  const ask = question => ended || signal?.aborted ? Promise.resolve(null) : new Promise(resolve => {
    const finish = answer => { lines.off('line', finish); lines.off('close', onClose); resolve(answer); };
    const onClose = () => finish(null);
    out.write(question);
    lines.once('line', finish); lines.once('close', onClose);
  });
  const pick = async (question, count) => {
    for (;;) {
      const answer = (await ask(question))?.trim();
      if (answer === null || answer === undefined) return null;
      if (answer === '') return 1;
      if (/^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= count) return Number(answer);
      out.write(`Type 1${count > 1 ? ` to ${count}` : ''}, or press Enter for 1.\n`);
    }
  };
  try {
    out.write(`Where will your worker run?\n  1. A hosted MCP client\n  2. Only on this computer\n`);
    const where = await pick('Choose [1]: ', 2);
    return where === 1 ? { mode: 'public' } : { mode: 'local' };
  } finally { lines.close(); }
}

// A stable route keeps its home (and so its sign-in); a temporary route gets a new home each time.
export const restartCommand = ({ cli, home, freshHome, shellQuote, route, stable }) => `${cli} try --public${route === undefined ? '' : ` --route ${shellQuote(route)}`} --home ${shellQuote(stable ? home : freshHome)}`;

export async function runHosted({ options, env, out, input, signal, errorContext, clock = { now: Date.now, sleep }, deps = {}, helpers }) {
  const { prepareHome, portFree, socketAnswers, choosePort, shellQuote, commandLine, parsePending, describeAttempt, MARKER, DIAGNOSE_AFTER_MS, DIAGNOSE_EVERY_MS, DIAGNOSE_LIMIT, POLL_MS, repo } = helpers;
  const say = line => out.write(`${terminalSafe(line)}\n`);
  // With no --route, a route saved by `dalan setup` is used as a durable route; an explicit --route id is a session route for this trial.
  const saved = options.route === undefined ? readRouteSetting(env) : null;
  const durable = saved !== null && saved.origin !== null;
  const realHome = fs.realpathSync(os.homedir());
  let stableAddress = durable; // a session route learns its stability from Gozar once it exists
  const home = prepareHome(options.home ?? env.DALAN_HOME ?? path.join(realHome, '.local/share', durable ? 'dalan-hosted' : `dalan-hosted-${randomBytes(3).toString('hex')}`), realHome);
  errorContext.home = home;
  const cliPath = errorContext.shellCli ?? shellQuote(path.join(repo, 'bin/dalan.mjs'));
  const cli = errorContext.cli ?? `node ${cliPath}`;
  const ownCommand = (...words) => `DALAN_HOME=${shellQuote(home)} ${cli} ${words.join(' ')}`;
  const configDir = defaultPath(home, '.config/dot-bridge');
  const logFile = path.join(home, 'server.log');
  errorContext.shellHome = shellQuote(home); errorContext.logFile = logFile; errorContext.shellLog = shellQuote(logFile);
  errorContext.tryFlags = ` --public${options.route === undefined ? '' : ` --route ${shellQuote(options.route)}`}`;
  const freshRestartHome = path.join(realHome, '.local/share', `dalan-hosted-${randomBytes(3).toString('hex')}`);
  const retry = () => commandLine(restartCommand({ cli, home, freshHome: freshRestartHome, shellQuote, route: options.route, stable: stableAddress }));
  errorContext.freshTrialCommand = retry().trim();

  // A bridge or ssh that an earlier trial left behind (its process was killed without cleanup) is ended first; only a recorded, matching process is touched.
  const registry = childRegistry(env);
  const leftovers = await sweepChildren({ registry }).catch(() => []);
  if (leftovers.length) out.write(`Ended ${leftovers.length} process${leftovers.length === 1 ? '' : 'es'} left by an earlier trial.\n`);
  // A home that already has a bridge or another trial's profile is never reused silently.
  const adminSock = defaultPath(home, '.local/share/dot-bridge', 'admin.sock');
  if (await socketAnswers(adminSock)) throw Object.assign(new Error('the bridge for this home is already running; stop it with Ctrl-C in its terminal first, or choose a new --home'), { tryKind: 'already_running' });
  let freshHome = true, storedOrigin = null;
  try { freshHome = !JSON.parse(fs.readFileSync(path.join(configDir, 'workers.json'), 'utf8')).workers?.[HOSTED_WORKER]; if (freshHome) throw new Error(`${home} holds another trial's worker profile; choose a new --home`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { storedOrigin = new URL(JSON.parse(fs.readFileSync(path.join(configDir, 'as.json'), 'utf8')).public_url).origin; } catch { /* a new home */ }

  const lines = readline.createInterface({ input });
  let inputEnded = false;
  lines.once('close', () => { inputEnded = true; });
  const stopRequested = () => signal?.aborted || inputEnded;
  let exited = true, stopped = Promise.resolve(), server = null, routeDied = false, routeLossReason = null;
  const stopPromise = new Promise(resolve => { if (signal?.aborted) resolve(); signal?.addEventListener('abort', resolve, { once: true }); lines.once('close', resolve); });
  let resolveRouteGone;
  let routeGone = new Promise(resolve => { resolveRouteGone = resolve; });
  const markRouteLost = reason => {
    if (routeDied) return;
    routeDied = true;
    routeLossReason = reason;
    resolveRouteGone();
  };
  // The trial's lifetime is a real timer, not a check in the polling loop, so it also ends an unanswered question or a wait after a result.
  const trialMs = durable ? null : (deps.trialMs ?? TRIAL_MS);
  let expired = false, expireTimer = null;
  const untilStopRequested = () => Promise.race([stopPromise, stopped, routeGone]);
  const ask = question => {
    if (stopRequested() || exited || routeDied || expired) return null;
    out.write(question);
    return new Promise(resolve => {
      const done = answer => { lines.off('line', done); lines.off('close', onClose); signal?.removeEventListener('abort', onClose); resolve(answer); };
      const onClose = () => done(null);
      lines.once('line', done); lines.once('close', onClose); signal?.addEventListener('abort', onClose, { once: true });
      stopped.then(onClose); routeGone.then(onClose);
    });
  };

  const baseEnv = {
    ...Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'NODE_OPTIONS'].filter(k => env[k] !== undefined).map(k => [k, env[k]])),
    HOME: home, DALAN_AUTH_MODE: 'builtin', DALAN_TRIAL_SSE: '1', ...(deps.serverEnv ?? {}),
  };
  let bindPort = null;
  // `abortable: false` is for cleanup: Ctrl-C must not cancel the revocation.
  const dalan = (args, { abortable = true } = {}) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(repo, 'bin/dalan.mjs'), ...args],
    { env: { ...baseEnv, DALAN_PORT: String(bindPort ?? 8799) }, cwd: repo, timeout: 30_000, ...(abortable ? { signal } : {}) }, (error, stdout, stderr) =>
      error ? reject(new Error(`dalan ${args.slice(0, 2).join(' ')} failed: ${safeDiagnostic((stderr || stdout || error.message).trim(), 4000)}`)) : resolve(stdout)));

  const startServer = () => {
    const log = fs.openSync(logFile, 'w', 0o600); fs.fchmodSync(log, 0o600); fs.closeSync(log);
    exited = false;
    server = spawn(process.execPath, [path.join(repo, 'src/server.mjs')], { env: { ...baseEnv, DALAN_PORT: String(bindPort) }, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    const forgetServer = registerChild({ registry, child: server });
    server.once('close', forgetServer);
    const child = server;
    const sinks = [child.stdout, child.stderr].map(stream => { const persist = createLineMasker(text => fs.appendFileSync(logFile, text)); stream.setEncoding('utf8').on('data', chunk => persist(chunk)); return persist; });
    stopped = waitForChildExit(child, {
      onClose: () => { for (const flush of sinks) flush('', true); exited = true; },
      onError: error => { fs.appendFileSync(logFile, `process error: ${safeDiagnostic(error.message, 1000)}\n`); },
    });
  };
  const stopServer = async () => {
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

  let gate = null, route = null, routeStopped = null, cleaned = true;
  let identityWatcher = null;
  let trialEndsAt = null;
  let releaseHome;
  try { releaseHome = acquireHomeLock(home); } catch (error) { lines.close(); throw error; }
  try {
    say(durable ? REAL_NOTICE(true) : TRIAL_NOTICE);
    say('Checking public routes…');
    gate = await createGate();
    signal?.throwIfAborted();
    trialEndsAt = trialMs === null ? null : clock.now() + trialMs;
    // Gozar answers the owner's questions; Dalan only shows what it returned and asks once.
    const consent = async candidate => {
      say(describeCandidate(candidate).join('\n')); say(describeDisclosure(candidate).join('\n')); say('Use this route? [y/N]');
      return new Promise(resolve => {
        if (inputEnded || signal?.aborted) { resolve(false); return; }
        const finish = answer => { lines.off('line', onLine); lines.off('close', onClose); signal?.removeEventListener('abort', onClose); resolve(['y', 'yes'].includes(String(answer ?? '').trim().toLowerCase())); };
        const onLine = answer => finish(answer);
        const onClose = () => finish(null);
        lines.once('line', onLine); lines.once('close', onClose); signal?.addEventListener('abort', onClose, { once: true });
      });
    };
    try {
      const gozar = deps.gozar ?? await resolveGozar();
      const query = buildQuery({ home: saved?.gozarHome ?? gozarHomeFor(env), target: `127.0.0.1:${gate.port}`, route: options.route ?? saved?.routeName ?? undefined,
        usage: durable ? { kind: 'durable', routeId: saved.routeId } : { kind: 'session', lifetimeMs: trialMs }, ...(durable ? { origin: saved.origin, address: 'stable' } : {}) });
      if (durable) {
        const view = await ensureDurableRoute({ gozar, query, consent });
        route = { origin: view.origin, exited: null, endedBecause: () => null, stop: async () => ({ removed: true }) }; // an app exit never closes a durable route
      } else route = await startSessionRoute({ gozar, query, consent, signal, wait: 'allocated' });
      if (!durable) stableAddress = route.view?.properties?.address?.stability === 'stable';
    }
    catch (error) {
      if (error && typeof error === 'object' && !signal?.aborted) {
        if (error.tryKind !== 'consent') {
          const known = explainRouteError(error);
          if (known.code && !(error instanceof RouteError && error.tryKind)) error.message = `${known.line}${known.fix ? `\nNext: ${known.fix}` : ''}`;
        }
        error.tryKind ??= 'route_start';
        if (durable && error instanceof Error) error.message += '\nA saved route never falls back to a temporary link on its own. Fix it and run again, or run with --route <id> (see `dalan routes`).';
      }
      throw error;
    }
    if (route.exited) route.exited.then(() => markRouteLost(route.endedBecause() ?? 'route_lost'));
    const origin = route.origin;
    say('Public route ready.');
    if (storedOrigin && storedOrigin !== origin) {
      const error = new Error(`this home was set up for ${storedOrigin}, but the new public address is ${origin}. A new address is a new sign-in identity. Start a fresh trial instead with: ${retry().trim()}`);
      error.tryKind = 'identity';
      throw error;
    }
    signal?.throwIfAborted();

    say('Starting isolated trial…');
    bindPort = await (deps.pickPort ?? choosePort)({ requested: options.port, stored: null, skip: new Set() });
    errorContext.bindPort = bindPort;
    if (freshHome) await dalan(['init', '--worker', HOSTED_WORKER, '--public-url', origin]);
    startServer();
    if (!await waitForListening()) {
      const error = new Error(`the bridge did not start; last log lines:\n${fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n')}`);
      error.tryKind = 'startup';
      throw error;
    }
    errorContext.started = true;
    const secret = /^BRIDGE_PATH_SECRET=(.+)$/m.exec(fs.readFileSync(path.join(configDir, 'env'), 'utf8'))?.[1];
    registerSecret(secret);
    const mcpUrl = `${origin}/${secret}/mcp`;
    const shownResource = `${origin}/<secret>/mcp`;
    const urlFile = path.join(home, 'resource-url');
    fs.rmSync(urlFile, { force: true });
    fs.writeFileSync(urlFile, `${mcpUrl}\n`, { mode: 0o600 });
    fs.chmodSync(urlFile, 0o600);

    gate.open(bindPort, { publicOrigin: origin });
    const ready = await verifyPublicReady({ origin, secret, fetchImpl: deps.fetchImpl ?? fetch, clock, timeoutMs: deps.readyMs ?? PUBLIC_READY_MS, say, signal });
    if (!ready.ready) { const error = new Error(`The public route is not ready (${ready.last}); the trial is stopping.`); error.tryKind = 'route'; throw error; }
    say("Public HTTPS, OAuth discovery and the authorization server's metadata verified.");

    if (!durable) {
      identityWatcher = await (deps.watchPublicIdentity ?? watchPublicIdentity)({
        origin, secret, identity: ready.identity, fetchImpl: deps.fetchImpl ?? fetch,
        onStatus: status => { if (status === 'retrying') say('The temporary public link is not responding; checking again.'); },
      });
      identityWatcher.lost.then(loss => markRouteLost(loss.reason));
      const watcherReady = await identityWatcher.ready;
      if (!watcherReady) markRouteLost('identity_changed');
      if (routeDied) throw Object.assign(new Error('The temporary demo link changed or stopped responding during startup; the trial is stopping.'), { tryKind: 'route_lost' });
    }

    await dalan(['connect', 'start', '--worker', HOSTED_WORKER]);
    const requestId = `req_${randomUUID()}`;
    const phrase = `${REPORT} ${randomBytes(4).toString('hex')}`;
    const requestFile = path.join(home, `${requestId}.json`);
    fs.writeFileSync(requestFile, JSON.stringify({ schema_version: 1, request_id: requestId, brief: `Report the exact phrase: ${phrase}. Do not read files, run commands or call external services.`, inputs: [], expected_output: `Text report containing: ${phrase}.`, execution_scope: 'read-only' }), { mode: 0o600 });
    await dalan(['submit', '--worker', HOSTED_WORKER, '--execution', 'none', '--deliver', 'none', '--file', requestFile, '--json']);
    const job = async () => JSON.parse(await dalan(['get', requestId, '--json']));
    const pendingNow = async () => parsePending(JSON.parse(await dalan(['connect', 'pending', '--json'])));

    const trialOver = () => expired || (trialEndsAt !== null && clock.now() >= trialEndsAt);
    if (trialMs !== null) {
      const expiry = new Promise(resolve => { expireTimer = setTimeout(() => { expired = true; resolve(); }, Math.max(0, trialEndsAt - clock.now())); expireTimer.unref?.(); });
      routeGone = Promise.race([routeGone, expiry]);
    }
    const trialLeft = () => trialEndsAt === null ? '' : ` Local shutdown limit: ${timeLeft(trialEndsAt - clock.now())}. The temporary link can stop earlier.`;
    if (trialEndsAt !== null) say(`This trial has a local shutdown limit of ${timeLeft(trialEndsAt - clock.now())}; the temporary link can stop earlier or without warning. Run \`dalan setup\` to choose a stable route. Setup does not install a background service.`);
    say('');
    say(handoffText({ url: mcpUrl }));
    say('');
    say(`Waiting for sign-in. Ctrl-C stops the trial and attempts to remove its public route. This terminal shows the connection code. Type help here to see the steps again. The URL is also in ${urlFile}.`);

    const showPrompt = () => say(`Finish sign-in in its browser tab, then enable "${CONNECTOR_NAME}" in a chat. Paste this into the chat:\n${hostedPrompt(requestId, phrase)}`);
    const seen = new Set();
    let approvedConnection = null, reminded = 0, retryNow = false, stage = 'signin';
    let remindAt = clock.now() + DIAGNOSE_AFTER_MS;
    const stageNote = () => ({
      signin: `No sign-in request yet. Add ${CONNECTOR_NAME} in your MCP client and start sign-in. Type help here to see the steps again.`,
      approved: 'Approval succeeded, but the client has not claimed the job. Finish sign-in and send this prompt in a chat with the connector enabled.',
      claimed: 'The demo is claimed. Check the chat for a tool approval or a stopped response.',
    }[stage]);
    const stillCurrent = async attempt => (await pendingNow()).pending.some(p => p.code === attempt.code && !p.superseded);
    const approve = async attempt => {
      if (routeDied || !await stillCurrent(attempt) || routeDied) return false;
      try { return JSON.parse(await dalan(['connect', 'approve', attempt.code, '--worker', HOSTED_WORKER, '--replace', '--json'])).result ?? true; }
      catch (error) { if (routeDied) return false; if (exited || await stillCurrent(attempt)) throw error; return false; }
    };
    // Help is read from the same input as the answers: a line that is not an answer is checked for it.
    let asking = false;
    lines.on('line', line => { if (line.trim().toLowerCase() === 'help' && !asking) { if (stage === 'approved') { showPrompt(); return; } say(`${STEPS.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n(The connector URL is in ${urlFile}.)`); } });
    const askOnce = async question => { asking = true; try { return await ask(question); } finally { asking = false; } };

    while (!exited && !stopRequested() && !routeDied && !trialOver()) {
      const current = await job();
      if (current.status === 'finished') {
        const result = String(current.report?.result ?? '');
        // Proof: this job, finished as completed, with this run's own phrase, by the one connection this owner approved.
        const connection = JSON.parse(await dalan(['connect', 'list', '--json'])).connections?.find(c => c.worker === HOSTED_WORKER && c.revoked_at === null);
        const proven = current.report?.outcome === 'completed' && result.includes(phrase) && approvedConnection !== null && connection?.connection_id === approvedConnection;
        if (!proven) {
          say(`\nThe hosted client finished ${requestId}, but not as the demo asked (outcome ${terminalSafe(String(current.report?.outcome ?? 'unknown'))}). Not counting this as a confirmed run. Report:\n${terminalSafe(result || '(empty)')}`);
          say('Ctrl-C stops the trial.');
          await untilStopRequested();
          break;
        }
        say('Hosted worker completed the demo.');
        say(`Report: ${terminalSafe(result)}`);
        const answer = await askOnce('Accept this result? [y/N] ');
        if (answer?.trim().toLowerCase() === 'y') { await dalan(['decide', requestId, 'accepted']); say(`Recorded as accepted. The trial stays available until you press Ctrl-C.`); }
        else say(stopRequested() ? '\nNot recorded.' : `Not recorded. Decide later while the trial runs:\n${commandLine(ownCommand('decide', requestId, 'accepted'))}`);
        if (!stopRequested() && !routeDied && !exited && !trialOver()) await untilStopRequested();
        break;
      }
      if (current.status === 'queued') {
        let view = await pendingNow();
        if (!view.window) { await dalan(['connect', 'start', '--worker', HOSTED_WORKER]); view = await pendingNow(); }
        for (const attempt of view.pending) {
          if (seen.has(attempt.code) || attempt.superseded) continue;
          seen.add(attempt.code);
          const { text, blocked } = describeAttempt(attempt, shownResource);
          say(`\nConnection waiting for your approval\n${text}\naccess      the trial worker's demo queue`);
          if (blocked) { say('Not approving: this attempt names a different resource than this trial.'); continue; }
          if (attempt.native) { say('Not approving: this is a local program, not a hosted client.'); continue; }
          say('Check that the code matches the Dalan sign-in page you opened.');
          const answer = await askOnce('Approve this connection? [y/N] ');
          remindAt = Math.max(remindAt, clock.now() + DIAGNOSE_AFTER_MS);
          if (answer?.trim().toLowerCase() === 'y' && !routeDied) {
            const result = await approve(attempt);
            if (routeDied) {
              break;
            }
            if (result) { approvedConnection = result.connection_id ?? (await dalan(['connect', 'list', '--json']).then(t => JSON.parse(t).connections.find(c => c.worker === HOSTED_WORKER && c.revoked_at === null)?.connection_id ?? null)); stage = 'approved'; say('Connection approved.'); showPrompt(); }
            else {
              say(`That attempt is no longer current or expired (attempts last ${PAIRING_MINUTES} minutes). Start the sign-in again in your MCP client; its new code appears here.`);
              retryNow = (await pendingNow()).pending.some(p => !p.superseded && !seen.has(p.code));
            }
            break;
          }
          if (stopRequested()) { say('\nNot approved.'); break; }
          say(`Not approved. Start sign-in again in your MCP client; approve the new matching code here to get the demo prompt.`);
        }
      } else if (stage !== 'claimed') { stage = 'claimed'; say(`Hosted worker claimed ${requestId}.`); }
      if (reminded < DIAGNOSE_LIMIT && !exited && !stopRequested() && clock.now() >= remindAt) { say(`\n${stageNote()}${trialLeft()}`); if (stage === 'approved') showPrompt(); reminded++; remindAt = clock.now() + DIAGNOSE_EVERY_MS; }
      if (retryNow) { retryNow = false; continue; }
      await Promise.race([clock.sleep(POLL_MS), untilStopRequested()]);
    }
    if (routeDied && !stopRequested()) {
      const changed = routeLossReason === 'rotated' || routeLossReason === 'identity_changed';
      const error = new Error(`The temporary demo link ${changed ? 'changed its address' : 'stopped responding'}. The connector cannot use this URL; the trial is stopping. Its saved reports stay in the trial Home.`);
      error.tryKind = 'route_lost'; throw error;
    }
    if (trialOver() && !stopRequested()) { const error = new Error(`The temporary trial reached its ${timeLeft(trialMs)} shutdown limit. Route cleanup will be attempted. Start a fresh trial for a new link, or run dalan setup to choose a stable route. Setup does not install a background service.`); error.tryKind = 'route'; throw error; }
    if (exited && !stopRequested()) { const error = new Error('the bridge stopped unexpectedly'); error.tryKind = 'unexpected'; throw error; }
  } catch (error) {
    if (signal?.aborted) { /* a normal stop */ }
    else throw error;
  } finally {
    lines.close();
    clearTimeout(expireTimer);
    await identityWatcher?.stop();
    // Close forwarding first, then end the connection while the bridge can still answer, then remove the route and stop the bridge.
    gate?.shut();
    if (errorContext.started && !exited) await dalan(['connect', 'revoke', HOSTED_WORKER], { abortable: false }).catch(() => {});
    if (route) routeStopped = await route.stop().catch(error => ({ removed: false, detail: error.message }));
    await stopServer();
    await gate?.close();
    // The connector URL and the bridge's secrets are no use after the trial and stay on disk for nobody.
    removeTrialSecrets(home, configDir, { keepConfig: stableAddress });
    releaseHome();
    cleaned = routeStopped ? routeStopped.removed : true;
    if (!cleaned) { process.exitCode = 1; out.write(`dalan: Bridge stopped; public-route cleanup is unconfirmed: ${terminalSafe(routeStopped.detail)}\n`); }
  }
  if (route && cleaned) say('Public route removed. Bridge stopped.');
  else if (!route) say('No public route was started. Bridge stopped.');
  say(`Trial history kept at ${home}`);
  say(`To run it again: ${retry().trim()}`);
}
