// `dalan try --public`: the same trial, reached by a hosted client (ChatGPT or claude.ai). It starts a public route, a bridge whose
// OAuth issuer is that route's address, queues one demo job, prints the connector URL and the clicks, asks the owner to approve the
// sign-in, and calls the trial a success only when the hosted client finishes that job. The local flow in try.mjs is unchanged.
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { terminalSafe } from './terminal-safe.mjs';
import { createLineMasker, safeDiagnostic } from './diagnostic.mjs';
import { registerSecret } from './redaction.mjs';
import { defaultPath } from './paths.mjs';
import { PAIRING_MINUTES } from './as-files.mjs';
import { CLIENTS, CONNECTOR_NAME, callbackAllowed, handoffText } from './try-hosted-clients.mjs';
import { PUBLIC_READY_MS, cloudflareProvider, createGate, startRoute, tailscaleProvider, verifyPublicReady } from './try-exposure.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOSTED_WORKER = 'hosted';
const REPORT = 'bridge first report';

export const NOTICE = [
  'Public mode opens an internet route to this trial, protected by your OAuth approval.',
  'It may download a tunnel helper into your private cache. Nothing is installed system-wide.',
  'Leave this terminal open; Ctrl-C stops the trial and removes its route.',
];

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
    out.write(`Where will your worker run?\n  1. ChatGPT or claude.ai: public HTTPS (recommended)\n  2. Only on this computer\n${NOTICE.join('\n')}\n`);
    const where = await pick('Choose [1]: ', 2);
    if (where === null) return { mode: 'local' };
    if (where === 2) return { mode: 'local' };
    out.write('Which client?\n  1. ChatGPT\n  2. claude.ai\n');
    const which = await pick('Choose [1]: ', 2);
    return which === null ? { mode: 'local' } : { mode: 'public', client: which === 2 ? 'claude' : 'chatgpt' };
  } finally { lines.close(); }
}

export function defaultProviders({ env, say, hostedDeps = {} }) {
  return [tailscaleProvider({ env, ...hostedDeps.tailscale }), cloudflareProvider({ env, say, ...hostedDeps.cloudflare })];
}

// The restart command for a trial, with every selection, on one line.
const restartCommand = ({ cli, home, shellQuote, client, route }) => `${cli} try --public --client ${client} --route ${route} --home ${shellQuote(home)}`;

export async function runHosted({ options, env, out, input, signal, errorContext, clock = { now: Date.now, sleep }, deps = {}, helpers }) {
  const { prepareHome, portFree, socketAnswers, choosePort, shellQuote, commandLine, parsePending, describeAttempt, MARKER, DIAGNOSE_AFTER_MS, DIAGNOSE_EVERY_MS, DIAGNOSE_LIMIT, POLL_MS, repo } = helpers;
  const client = options.client ?? 'chatgpt';
  const routeChoice = options.route ?? 'auto';
  const spec = CLIENTS[client];
  const say = line => out.write(`${terminalSafe(line)}\n`);
  const realHome = fs.realpathSync(os.homedir());
  const home = prepareHome(options.home ?? env.DALAN_HOME ?? path.join(realHome, '.local/share', `dalan-hosted-${randomBytes(3).toString('hex')}`), realHome);
  errorContext.home = home;
  const cliPath = errorContext.shellCli ?? shellQuote(path.join(repo, 'bin/dalan.mjs'));
  const cli = errorContext.cli ?? `node ${cliPath}`;
  const ownCommand = (...words) => `DALAN_HOME=${shellQuote(home)} ${cli} ${words.join(' ')}`;
  const configDir = defaultPath(home, '.config/dot-bridge');
  const logFile = path.join(home, 'server.log');
  errorContext.shellHome = shellQuote(home); errorContext.logFile = logFile; errorContext.shellLog = shellQuote(logFile);
  errorContext.tryFlags = ` --public --client ${client} --route ${routeChoice}`;
  const retry = () => commandLine(restartCommand({ cli, home, shellQuote, client, route: routeChoice }));

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
  const untilStopRequested = () => Promise.race([stopPromise, stopped, routeGone]);
  const ask = question => {
    if (stopRequested() || exited || routeDied) return null;
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
    const child = server;
    const sinks = [child.stdout, child.stderr].map(stream => { const persist = createLineMasker(text => fs.appendFileSync(logFile, text)); stream.setEncoding('utf8').on('data', chunk => persist(chunk)); return persist; });
    stopped = new Promise(resolve => {
      child.once('close', () => { for (const flush of sinks) flush('', true); exited = true; resolve(); });
      child.once('error', error => { fs.appendFileSync(logFile, `spawn failed: ${safeDiagnostic(error.message, 1000)}\n`); exited = true; resolve(); });
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
  const providers = deps.providers ?? defaultProviders({ env, say, hostedDeps: deps });
  try {
    for (const line of NOTICE) say(line);
    say('Checking public routes…');
    gate = await createGate();
    try { route = await startRoute({ route: routeChoice, providers, gatePort: gate.port, home, say }); }
    catch (error) { if (error && typeof error === 'object') error.tryKind ??= 'route_start'; throw error; }
    routeGone = route.exited ? route.exited.then(() => { routeDied = true; }) : routeGone;
    const origin = route.origin;
    say(`Public route ready (${route.provider.name}).`);
    if (storedOrigin && storedOrigin !== origin) {
      const error = new Error(`this home was set up for ${storedOrigin}, but the new public address is ${origin}. A new address is a new sign-in identity. Start a fresh trial instead`);
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

    gate.open(bindPort);
    const ready = await verifyPublicReady({ origin, secret, fetchImpl: deps.fetchImpl ?? fetch, clock, timeoutMs: deps.readyMs ?? PUBLIC_READY_MS[route.provider.name], say });
    if (!ready.ready) { const error = new Error(`The public route is not ready (${ready.last}); the trial is stopping.`); error.tryKind = 'route'; throw error; }
    say('Public HTTPS and OAuth discovery verified.');

    // The default callback list already holds both clients' published callbacks; the approval below accepts only the selected client's.
    await dalan(['connect', 'start', '--worker', HOSTED_WORKER]);
    const requestId = `req_${randomUUID()}`;
    const phrase = `${REPORT} ${randomBytes(4).toString('hex')}`;
    const requestFile = path.join(home, `${requestId}.json`);
    fs.writeFileSync(requestFile, JSON.stringify({ schema_version: 1, request_id: requestId, brief: `Report the exact phrase: ${phrase}. Do not read files, run commands or call external services.`, inputs: [], expected_output: `Text report containing: ${phrase}.`, execution_scope: 'read-only' }), { mode: 0o600 });
    await dalan(['submit', '--worker', HOSTED_WORKER, '--execution', 'none', '--deliver', 'none', '--file', requestFile, '--json']);
    const job = async () => JSON.parse(await dalan(['get', requestId, '--json']));
    const pendingNow = async () => parsePending(JSON.parse(await dalan(['connect', 'pending', '--json'])));

    say('');
    say(handoffText({ client, url: mcpUrl, requestId, requestPhrase: phrase }));
    say('');
    say(`Waiting for sign-in. This terminal shows the connection code. Type help here to see the ${spec.label} steps again. The URL is also in ${urlFile}.`);

    const seen = new Set();
    let approvedConnection = null, reminded = 0, retryNow = false, stage = 'signin';
    let remindAt = clock.now() + DIAGNOSE_AFTER_MS;
    const stageNote = () => ({
      signin: `No sign-in request yet. Add ${CONNECTOR_NAME} in ${spec.label} and start sign-in. Type help here to see the steps again.`,
      approved: 'Approval succeeded, but the client has not claimed the job. Finish sign-in in its browser tab, enable the connector in the chat, and send the prompt above.',
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
    lines.on('line', line => { if (line.trim().toLowerCase() === 'help' && !asking) { say(`${spec.label}\n${spec.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n(The connector URL is in ${urlFile}.)`); } });
    const askOnce = async question => { asking = true; try { return await ask(question); } finally { asking = false; } };

    while (!exited && !stopRequested() && !routeDied) {
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
        if (!stopRequested() && !routeDied && !exited) await untilStopRequested();
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
            if (result) { approvedConnection = result.connection_id ?? (await dalan(['connect', 'list', '--json']).then(t => JSON.parse(t).connections.find(c => c.worker === HOSTED_WORKER && c.revoked_at === null)?.connection_id ?? null)); stage = 'approved'; say('Connection approved. Waiting for the client to claim the demo job…'); }
            else {
              say(`That attempt is no longer current or expired (attempts last ${PAIRING_MINUTES} minutes). Start the sign-in again in ${spec.label}; its new code appears here.`);
              retryNow = (await pendingNow()).pending.some(p => !p.superseded && !seen.has(p.code));
            }
            break;
          }
          if (stopRequested()) { say('\nNot approved.'); break; }
          say(`Not approved. Approve later with:\n${commandLine(ownCommand('connect', 'approve', attempt.code, '--worker', HOSTED_WORKER, '--replace'))}`);
        }
      } else if (stage !== 'claimed') { stage = 'claimed'; say(`Hosted worker claimed ${requestId}.`); }
      if (reminded < DIAGNOSE_LIMIT && !exited && !stopRequested() && clock.now() >= remindAt) { say(`\n${stageNote()}`); reminded++; remindAt = clock.now() + DIAGNOSE_EVERY_MS; }
      if (retryNow) { retryNow = false; continue; }
      await Promise.race([clock.sleep(POLL_MS), untilStopRequested()]);
    }
    if (routeDied && !stopRequested()) { const error = new Error('The public route stopped. This URL is offline.'); error.tryKind = 'route'; throw error; }
    if (exited && !stopRequested()) { const error = new Error('the bridge stopped unexpectedly'); error.tryKind = 'unexpected'; throw error; }
  } catch (error) {
    if (signal?.aborted) { /* a normal stop */ }
    else throw error;
  } finally {
    lines.close();
    // Close forwarding first, then end the connection while the bridge can still answer, then remove the route and stop the bridge.
    gate?.shut();
    if (errorContext.started && !exited) await dalan(['connect', 'revoke', HOSTED_WORKER], { abortable: false }).catch(() => {});
    if (route) routeStopped = await route.stop().catch(error => ({ removed: false, detail: error.message }));
    await stopServer();
    await gate?.close();
    cleaned = routeStopped ? routeStopped.removed : true;
    if (!cleaned) { process.exitCode = 1; out.write(`dalan: Bridge stopped; public-route cleanup is unconfirmed: ${terminalSafe(routeStopped.detail)}\n${routeStopped.command ? `Remove it with:\n${commandLine(routeStopped.command)}\n` : ''}`); }
  }
  if (cleaned) say('Public route removed. Bridge stopped.');
  say(`Trial history kept at ${home}`);
  say(`To run it again: ${retry().trim()}`);
}
