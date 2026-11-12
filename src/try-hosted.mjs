// `dalan try --public`: the same trial, reached by a hosted MCP client (for example ChatGPT or claude.ai). It starts a public route, a bridge whose
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
import { CLIENTS, CONNECTOR_NAME, callbackAllowed, handoffText, hostedPrompt } from './try-hosted-clients.mjs';
import { PUBLIC_READY_MS, createGate, gozarProvider, localhostRunProvider, selectRouteProvider, startRoute, tailscaleNodeProvider, tailscaleProvider, verifyPublicReady } from './try-exposure.mjs';
import { readRouteSetting } from './route-setting.mjs';
import { childRegistry, registerChild, sweepChildren } from './child-registry.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOSTED_WORKER = 'hosted';
// Files that hold a credential of a finished trial. The job history stays.
// A home that a restart reuses keeps the bridge's own config (its path secret); the others lose it.
export function removeTrialSecrets(home, configDir, { keepConfig = false, keepNode = false } = {}) {
  for (const file of [path.join(home, 'resource-url'), ...(keepConfig ? [] : [path.join(configDir, 'env')])]) fs.rmSync(file, { force: true });
  fs.rmSync(path.join(home, 'localhost-run'), { recursive: true, force: true });
  if (!keepNode) fs.rmSync(path.join(home, 'tsnode'), { recursive: true, force: true }); // else a child still holds files there: the next sweep removes them
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

// Said once, before any public address exists. A trial link is told apart from a real address in every line that names it.
export const TRIAL_NOTICE = 'Trial link via localhost.run, a third-party relay that can see this traffic; the address changes within hours. For daily use: dalan setup';
// A trial link lasts at most this long: localhost.run rotates free addresses within hours, so the trial ends itself first, on its own terms.
export const TRIAL_MS = 3 * 60 * 60 * 1000;
export const timeLeft = ms => { const minutes = Math.max(0, Math.ceil(ms / 60_000)); return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`; };
export const REAL_NOTICE = fromSetup => `Using Tailscale${fromSetup ? ', the address you saved with `dalan setup`' : ''}. This is not a trial link.`;

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
    out.write(`Where will your worker run?\n  1. A hosted MCP client (for example ChatGPT or claude.ai)\n  2. Only on this computer\n`);
    const where = await pick('Choose [1]: ', 2);
    if (where === null) return { mode: 'local' };
    if (where === 2) return { mode: 'local' };
    out.write('Which client?\n  1. ChatGPT\n  2. claude.ai\n');
    const which = await pick('Choose [1]: ', 2);
    return which === null ? { mode: 'local' } : { mode: 'public', client: which === 2 ? 'claude' : 'chatgpt' };
  } finally { lines.close(); }
}

export function defaultProviders({ env, say, client, hostedDeps = {} }) {
  return [gozarProvider({ env, ...hostedDeps.gozar }), localhostRunProvider({ env, ...hostedDeps.localhostRun }), tailscaleProvider({ env, ...hostedDeps.tailscale }), tailscaleNodeProvider({ env, ...hostedDeps.tailscaleNode })];
}

// The restart command for a trial, with every selection, on one line. Only the computer's own Tailscale keeps its address between
// runs, so only that route may reuse the home: any other address is new, and a home refuses a new address. Those restarts get a
// new home.
const STABLE_ORIGIN_ROUTES = new Set(['tailscale']);
export const restartCommand = ({ cli, home, shellQuote, client, route, provider }) => `${cli} try --public --client ${client} --route ${route}${STABLE_ORIGIN_ROUTES.has(provider) ? ` --home ${shellQuote(home)}` : ''}`;

export async function runHosted({ options, env, out, input, signal, errorContext, clock = { now: Date.now, sleep }, deps = {}, helpers }) {
  const { prepareHome, portFree, socketAnswers, choosePort, shellQuote, commandLine, parsePending, describeAttempt, MARKER, DIAGNOSE_AFTER_MS, DIAGNOSE_EVERY_MS, DIAGNOSE_LIMIT, POLL_MS, repo } = helpers;
  const client = options.client ?? 'chatgpt';
  const say = line => out.write(`${terminalSafe(line)}\n`);
  const providers = deps.providers ?? defaultProviders({ env, say, client, hostedDeps: deps });
  // An explicit route wins; auto prefers installed Gozar, otherwise preserves the saved/default route.
  const saved = options.route === undefined || options.route === 'auto' ? readRouteSetting(env) : null;
  const automaticRoute = providers.find(provider => provider.name === 'gozar')?.probe().ok ? 'gozar' : saved === 'tailscale' ? 'tailscale' : 'localhost.run';
  const routeChoice = options.route && options.route !== 'auto' ? options.route : automaticRoute;
  const realRoute = routeChoice === 'tailscale';
  const spec = CLIENTS[client];
  const realHome = fs.realpathSync(os.homedir());
  // Only the host's usable Funnel has a stable identity; its ephemeral fallback needs a new home.
  const routeMessages = [];
  let selectedProvider, selectionError;
  try { selectedProvider = selectRouteProvider({ route: routeChoice, providers, say: line => routeMessages.push(line), signal }); }
  catch (error) { selectionError = error; } // Report startup failures after the home and cleanup context are ready.
  const stableHome = selectedProvider?.name === 'tailscale';
  const home = prepareHome(options.home ?? env.DALAN_HOME ?? path.join(realHome, '.local/share', stableHome ? `dalan-hosted-${client}` : `dalan-hosted-${randomBytes(3).toString('hex')}`), realHome);
  errorContext.home = home;
  const cliPath = errorContext.shellCli ?? shellQuote(path.join(repo, 'bin/dalan.mjs'));
  const cli = errorContext.cli ?? `node ${cliPath}`;
  const ownCommand = (...words) => `DALAN_HOME=${shellQuote(home)} ${cli} ${words.join(' ')}`;
  const configDir = defaultPath(home, '.config/dot-bridge');
  const logFile = path.join(home, 'server.log');
  errorContext.shellHome = shellQuote(home); errorContext.logFile = logFile; errorContext.shellLog = shellQuote(logFile);
  errorContext.tryFlags = ` --public --client ${client} --route ${routeChoice}`;
  const retry = () => commandLine(restartCommand({ cli, home, shellQuote, client, route: routeChoice, provider: route?.provider.name }));

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
  let exited = true, stopped = Promise.resolve(), server = null, routeDied = false;
  const stopPromise = new Promise(resolve => { if (signal?.aborted) resolve(); signal?.addEventListener('abort', resolve, { once: true }); lines.once('close', resolve); });
  let routeGone = new Promise(() => {});
  // The trial's lifetime is a real timer, not a check in the polling loop, so it also ends an unanswered question or a wait after a result.
  const trialMs = realRoute ? null : (deps.trialMs ?? TRIAL_MS);
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
    HOME: home, DALAN_AUTH_MODE: 'builtin', ...(deps.serverEnv ?? {}),
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

  let gate = null, route = null, routeStopped = null, cleaned = true, keepRecoveredNode = false;
  let releaseHome;
  try { releaseHome = acquireHomeLock(home); } catch (error) { lines.close(); throw error; }
  try {
    say(realRoute ? REAL_NOTICE(saved === 'tailscale') : TRIAL_NOTICE);
    say('Checking public routes…');
    gate = await createGate();
    // A trial that was killed earlier may have left a Tailscale node of its own running; end it before this one starts.
    for (const provider of providers) {
      const recovery = await provider.recover?.().catch(() => ({ retained: [{ home: null, sock: null }] }));
      const ended = Array.isArray(recovery) ? recovery : recovery?.ended;
      keepRecoveredNode ||= recovery?.retained?.some(debt => debt.home === home || debt.sock === path.join(home, 'tsnode/tailscaled.sock') || (!debt.home && !debt.sock)) ?? false;
      if (ended?.length) say(`Ended ${ended.join(', ')} left by an earlier trial.`);
    }
    signal?.throwIfAborted();
    try {
      for (const message of routeMessages) say(message);
      if (selectionError) throw selectionError;
      route = await startRoute({ selectedProvider, gatePort: gate.port, home, say, signal });
    }
    catch (error) {
      routeStopped = error?.routeCleanup ?? routeStopped;
      if (error?.tryKind === 'node_retained') {
        keepRecoveredNode = true;
        error.message += `\nStart a fresh trial with: ${cli} try --public --client ${client} --route ${routeChoice} --home ${shellQuote(path.join(realHome, '.local/share', `dalan-hosted-${randomBytes(3).toString('hex')}`))}`;
      }
      if (error && typeof error === 'object' && !signal?.aborted) {
        error.tryKind ??= 'route_start';
        // A real route never turns into a trial link without the owner choosing it.
        if (realRoute && error instanceof Error) error.message += '\nA Tailscale route never falls back to a trial link on its own. Fix Tailscale and run again, or make a trial link with: dalan try --public --route localhost.run';
      }
      throw error;
    }
    routeGone = route.exited ? route.exited.then(() => { routeDied = true; }) : routeGone;
    const origin = route.origin;
    say(`Public route ready (${route.provider.name}).`);
    if (storedOrigin && storedOrigin !== origin) {
      const error = new Error(`this home was set up for ${storedOrigin}, but the new public address is ${origin}. A new address is a new sign-in identity. Start a fresh trial instead${route.provider.name === 'tailscale-node' ? ` with: ${cli} try --public --client ${client} --route ${routeChoice} --home ${shellQuote(path.join(realHome, '.local/share', `dalan-hosted-${randomBytes(3).toString('hex')}`))}` : ''}`);
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

    gate.open(bindPort, route.provider.name === 'gozar' ? { gozarOrigin: origin } : {});
    const ready = await verifyPublicReady({ origin, secret, fetchImpl: deps.fetchImpl ?? fetch, clock, timeoutMs: deps.readyMs ?? PUBLIC_READY_MS[route.provider.name], say, signal });
    if (!ready.ready) { if (!signal?.aborted) await route.provider.diagnose?.({ home, say, signal }).catch(() => {}); const error = new Error(`The public route is not ready (${ready.last}); the trial is stopping.`); error.tryKind = 'route'; throw error; }
    say("Public HTTPS, OAuth discovery and the authorization server's metadata verified.");

    // The default callback list already holds both clients' published callbacks; the approval below accepts only the selected client's.
    await dalan(['connect', 'start', '--worker', HOSTED_WORKER]);
    const requestId = `req_${randomUUID()}`;
    const phrase = `${REPORT} ${randomBytes(4).toString('hex')}`;
    const requestFile = path.join(home, `${requestId}.json`);
    fs.writeFileSync(requestFile, JSON.stringify({ schema_version: 1, request_id: requestId, brief: `Report the exact phrase: ${phrase}. Do not read files, run commands or call external services.`, inputs: [], expected_output: `Text report containing: ${phrase}.`, execution_scope: 'read-only' }), { mode: 0o600 });
    await dalan(['submit', '--worker', HOSTED_WORKER, '--execution', 'none', '--deliver', 'none', '--file', requestFile, '--json']);
    const job = async () => JSON.parse(await dalan(['get', requestId, '--json']));
    const pendingNow = async () => parsePending(JSON.parse(await dalan(['connect', 'pending', '--json'])));

    const trialEndsAt = trialMs === null ? null : clock.now() + trialMs;
    const trialOver = () => expired || (trialEndsAt !== null && clock.now() >= trialEndsAt);
    if (trialMs !== null) {
      const expiry = new Promise(resolve => { expireTimer = setTimeout(() => { expired = true; resolve(); }, trialMs); expireTimer.unref?.(); });
      routeGone = Promise.race([routeGone, expiry]);
    }
    const trialLeft = () => trialEndsAt === null ? '' : ` Temporary trial: ${timeLeft(trialEndsAt - clock.now())} left.`;
    if (trialEndsAt !== null) say(`Temporary trial: this link stops in ${timeLeft(trialMs)} or sooner if the relay changes the address. Replace it with \`dalan setup\` for daily use.`);
    say('');
    say(handoffText({ client, url: mcpUrl }));
    say('');
    say(`Waiting for sign-in. Ctrl-C stops the trial and removes its link. This terminal shows the connection code. Type help here to see the ${spec.label} steps again. The URL is also in ${urlFile}.`);

    const showPrompt = () => say(`Finish sign-in in its browser tab, then enable "${CONNECTOR_NAME}" in a ${spec.label} chat. Paste this into the chat:\n${hostedPrompt(requestId, phrase)}`);
    const seen = new Set();
    let approvedConnection = null, reminded = 0, retryNow = false, stage = 'signin';
    let remindAt = clock.now() + DIAGNOSE_AFTER_MS;
    const stageNote = () => ({
      signin: `No sign-in request yet. Add ${CONNECTOR_NAME} in ${spec.label} and start sign-in. Type help here to see the steps again.`,
      approved: 'Approval succeeded, but the client has not claimed the job. Finish sign-in and send this prompt in a chat with the connector enabled.',
      claimed: 'The demo is claimed. Check the chat for a tool approval or a stopped response.',
    }[stage]);
    const stillCurrent = async attempt => (await pendingNow()).pending.some(p => p.code === attempt.code && !p.superseded);
    const approve = async attempt => {
      if (!await stillCurrent(attempt)) return false;
      try { return JSON.parse(await dalan(['connect', 'approve', attempt.code, '--worker', HOSTED_WORKER, '--replace', '--json'])).result ?? true; }
      catch (error) { if (exited || await stillCurrent(attempt)) throw error; return false; }
    };
    // Help is read from the same input as the answers: a line that is not an answer is checked for it.
    let asking = false;
    lines.on('line', line => { if (line.trim().toLowerCase() === 'help' && !asking) { if (stage === 'approved') { showPrompt(); return; } say(`${spec.label}\n${spec.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n(The connector URL is in ${urlFile}.)`); } });
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
          if (!callbackAllowed(client, attempt.redirect_uri)) { say(`Not approving: its callback is not ${spec.label}'s. If you are using the other client, restart with --client ${client === 'chatgpt' ? 'claude' : 'chatgpt'}.`); continue; }
          if (attempt.native) { say('Not approving: this is a local program, not a hosted client.'); continue; }
          say('Check that the code matches the Dalan sign-in page you opened.');
          const answer = await askOnce('Approve this connection? [y/N] ');
          remindAt = Math.max(remindAt, clock.now() + DIAGNOSE_AFTER_MS);
          if (answer?.trim().toLowerCase() === 'y') {
            const result = await approve(attempt);
            if (result) { approvedConnection = result.connection_id ?? (await dalan(['connect', 'list', '--json']).then(t => JSON.parse(t).connections.find(c => c.worker === HOSTED_WORKER && c.revoked_at === null)?.connection_id ?? null)); stage = 'approved'; say('Connection approved.'); showPrompt(); }
            else {
              say(`That attempt is no longer current or expired (attempts last ${PAIRING_MINUTES} minutes). Start the sign-in again in ${spec.label}; its new code appears here.`);
              retryNow = (await pendingNow()).pending.some(p => !p.superseded && !seen.has(p.code));
            }
            break;
          }
          if (stopRequested()) { say('\nNot approved.'); break; }
          say(`Not approved. Start sign-in again in ${spec.label}; approve the new matching code here to get the demo prompt.`);
        }
      } else if (stage !== 'claimed') { stage = 'claimed'; say(`Hosted worker claimed ${requestId}.`); }
      if (reminded < DIAGNOSE_LIMIT && !exited && !stopRequested() && clock.now() >= remindAt) { say(`\n${stageNote()}${trialLeft()}`); if (stage === 'approved') showPrompt(); reminded++; remindAt = clock.now() + DIAGNOSE_EVERY_MS; }
      if (retryNow) { retryNow = false; continue; }
      await Promise.race([clock.sleep(POLL_MS), untilStopRequested()]);
    }
    if (routeDied && !stopRequested()) { const rotated = route?.provider.endedBecause?.() === 'rotated'; const error = new Error(rotated ? 'The temporary public address changed. This trial has stopped to protect its sign-in identity. Start a fresh trial and replace the connector URL.' : 'The public route stopped. This URL is offline.'); error.tryKind = 'route'; throw error; }
    if (trialOver() && !stopRequested()) { const error = new Error(`The temporary trial ended after ${timeLeft(trialMs)}; its link is removed. Start a fresh trial for a new link, or run dalan setup for a stable address.`); error.tryKind = 'route'; throw error; }
    if (exited && !stopRequested()) { const error = new Error('the bridge stopped unexpectedly'); error.tryKind = 'unexpected'; throw error; }
  } catch (error) {
    if (signal?.aborted) { /* a normal stop */ }
    else throw error;
  } finally {
    lines.close();
    clearTimeout(expireTimer);
    // Close forwarding first, then end the connection while the bridge can still answer, then remove the route and stop the bridge.
    gate?.shut();
    if (errorContext.started && !exited) await dalan(['connect', 'revoke', HOSTED_WORKER], { abortable: false }).catch(() => {});
    if (route) routeStopped = await route.stop().catch(error => ({ removed: false, keepNode: true, detail: error.message }));
    await stopServer();
    await gate?.close();
    // The connector URL and the bridge's secrets are no use after the trial and stay on disk for nobody.
    removeTrialSecrets(home, configDir, { keepConfig: STABLE_ORIGIN_ROUTES.has(route?.provider.name), keepNode: keepRecoveredNode || Boolean(routeStopped?.keepNode) });
    releaseHome();
    cleaned = routeStopped ? routeStopped.removed : true;
    if (!cleaned) { process.exitCode = 1; out.write(`dalan: Bridge stopped; public-route cleanup is unconfirmed: ${terminalSafe(routeStopped.detail)}\n${routeStopped.command ? `Remove it with:\n${commandLine(routeStopped.command)}\n` : ''}`); }
  }
  if (cleaned) say('Public route removed. Bridge stopped.');
  say(`Trial history kept at ${home}`);
  say(`To run it again: ${retry().trim()}`);
}
