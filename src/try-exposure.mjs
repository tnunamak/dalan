// The public route for `dalan try --public`: a loopback gate forwarded by Tailscale or a temporary relay. Cleanup attempts to
// remove resources owned by the trial and reports when removal is unconfirmed. Outside effects use injected seams in tests.
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  ADMIN_ACL_URL, ADMIN_DNS_URL, choosePort, funnelOffArgs, funnelOnArgs, funnelRuleMatches, funnelStatusArgs,
  preflight, publicUrl, removeExposure, whichOnPath, writeExposureRecord, recordPath,
} from '../scripts/lib/expose-tailscale.mjs';
import { childRegistry, registerChild, sweepChildren } from './child-registry.mjs';
import { safeDiagnostic } from './diagnostic.mjs';
import { processCommand } from './process-inspection.mjs';
export { processCommand } from './process-inspection.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Cancellation: every wait in route startup ends when the caller's signal aborts, and an abort is never turned into a fallback.
const abortReason = signal => signal.reason ?? Object.assign(new Error('stopped'), { name: 'AbortError', code: 'ABORT_ERR' });
const raceAbort = (promise, signal) => !signal ? promise : Promise.race([promise, new Promise((_, reject) => {
  if (signal.aborted) reject(abortReason(signal)); else signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
})]);
// Complete lines from chunks that may split anywhere; `end()` hands over a last line that had no newline.
export function lineBuffer(onLine, max = 65_536) {
  let buf = '';
  const push = chunk => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    if (buf.length > max) buf = buf.slice(-max);
  };
  push.end = () => { if (buf) onLine(buf); buf = ''; };
  return push;
}
const PROBE_TIMEOUT_MS = 10_000;
export const PUBLIC_READY_MS = { tailscale: 120_000, 'tailscale-node': 120_000, 'localhost.run': 60_000, gozar: 60_000 };

// ---- the gate ----------------------------------------------------------------------------------------------------------
// The route forwards to this listener, never to the bridge. A tunnel reports its address only after it starts, and the
// bridge needs that address at `init`, so the route must exist first. The gate answers 503 until the bridge is up, forwards to the
// one bridge port after that, and answers 503 again once closed. Nothing else on the computer is ever reachable through the route.
export async function createGate() {
  let upstream = null, gozarHost = null;
  // A fresh connection per request: a kept-alive socket that the bridge closed in the meantime would fail the next request with a 502
  // that the bridge never sees.
  const agent = new http.Agent({ keepAlive: false });
  const server = http.createServer((req, res) => {
    if (!upstream) { res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' }); res.end('starting\n'); return; }
    // Gozar forwards with Host set to this loopback gate. Restore only that exact transport host to the
    // configured public host; preserve other hosts and Origin for the bridge's identity checks.
    const headers = gozarHost && req.headers.host === `127.0.0.1:${server.address().port}` ? { ...req.headers, host: gozarHost } : req.headers;
    const forward = http.request({ agent, host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers }, answer => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  });
  server.headersTimeout = 10_000; server.requestTimeout = 60_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    open(port, { gozarOrigin } = {}) { upstream = port; gozarHost = gozarOrigin ? new URL(gozarOrigin).host : null; },
    shut() { upstream = null; },
    async close() { upstream = null; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

// ---- Tailscale Funnel --------------------------------------------------------------------------------------------------
const tailscaleRunner = (env = process.env) => args => spawnSync('tailscale', args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env });

// A foreground Funnel (no --bg) is listed by `serve|funnel status --json` under Foreground.<session>.{TCP,Web,AllowFunnel}, not in
// the top-level maps read by the shared preflight and rule matching. Merge foreground sessions into the view used for rule matching.
export function mergeForeground(status) {
  const sessions = Object.values(status?.Foreground ?? {});
  if (!sessions.length) return status;
  const merged = { ...status, TCP: { ...status.TCP }, Web: { ...status.Web }, AllowFunnel: { ...status.AllowFunnel } };
  for (const session of sessions) for (const key of ['TCP', 'Web', 'AllowFunnel']) Object.assign(merged[key], session?.[key]);
  return merged;
}
const seeForeground = run => args => {
  const result = run(args);
  if (!(args.includes('status') || args[0] === 'serve') || !args.includes('--json') || result.status !== 0 || !result.stdout) return result;
  try { return { ...result, stdout: JSON.stringify(mergeForeground(JSON.parse(result.stdout))) }; } catch { return result; }
};

// One line for the first thing that stops Funnel, plus the owner's own fix.
export function explainTailscale(error) {
  const text = String(error?.message ?? error);
  const first = (line, fix) => ({ line, fix: fix ?? line });
  if (/not installed|ENOENT/.test(text)) return first('Tailscale is not installed', 'Install Tailscale from https://tailscale.com/download, run `tailscale up`, then retry.');
  if (/not running or not logged in/.test(text)) return first('Tailscale is not connected; run: tailscale up', 'Run `tailscale up`, then retry.');
  if (/MagicDNS/.test(text)) return first('MagicDNS is off.', `Enable MagicDNS at ${ADMIN_DNS_URL}, then retry.`);
  if (/HTTPS certificates/.test(text)) return first('Tailscale HTTPS is off.', `Enable HTTPS Certificates at ${ADMIN_DNS_URL} (it publishes your machine names on a public ledger), then retry.`);
  if (/Funnel is not allowed/.test(text)) return first('Funnel is not allowed for this tailnet.', `A tailnet administrator can enable Funnel at ${ADMIN_ACL_URL}, then retry.`);
  if (/no free Funnel port/.test(text)) return first('All permitted Funnel ports are occupied. Existing routes are unchanged.', 'Free one Funnel port (tailscale funnel status), then retry.');
  const port = /--funnel-port (\d+) is (?:already used|not allowed)/.exec(text)?.[1];
  if (port) return { ...first(`Tailscale port ${port} is not free for Funnel on this computer; its rules are unchanged.`, `Free Funnel port ${port} (tailscale funnel status shows what uses it), or make a public demo link with --route gozar.`), busy: /already used/.test(text) };
  if (/macOS: the Tailscale/.test(text)) return first('The Tailscale app on this Mac cannot serve Funnel here', text.split('\n')[0]);
  const line = safeDiagnostic(text.split('\n')[0], 160);
  return first(`Tailscale Funnel is not usable (${line}).`, line);
}

// Hosted trials use HTTPS port 443 for client compatibility. If this computer already uses 443, its existing rule is unchanged;
// an explicitly selected Tailscale route can use an isolated temporary node. Automatic trial relay selection uses Gozar.
export const TRIAL_PORT = 443;
export function tailscaleProvider({ port: wantedPort = TRIAL_PORT, name = 'tailscale', record: recordName = 'trial', tailscale: rawTailscale = tailscaleRunner(), env = process.env, platform = process.platform, spawnChild = spawn, clock = { sleep }, which = name => whichOnPath(name, env) } = {}) {
  const tailscale = seeForeground(rawTailscale);
  let plan = null, child = null, record = null, rule = null, cli = null;
  return {
    name,
    // Read-only: inspects the daemon, DNS identity, capabilities and the ports other rules already use.
    probe() {
      const found = which('tailscale');
      if (!found) return { ok: false, ...explainTailscale(new Error('Tailscale is not installed')) };
      cli = typeof found === 'string' ? path.resolve(found) : null;
      try {
        const state = preflight({ tailscale, platform });
        const port = choosePort({ requested: wantedPort, allowed: state.allowed, occupied: state.occupied });
        plan = { dnsName: state.dnsName, port, origin: publicUrl(state.dnsName, port) };
        return { ok: true, origin: plan.origin };
      } catch (error) { return { ok: false, ...explainTailscale(error) }; }
    },
    // A foreground rule on a free port, exactly ours: it is removed by Tailscale itself when the child ends, and again by `stop`.
    async start({ gatePort, home, signal }) {
      signal?.throwIfAborted();
      if (!plan) throw new Error('tailscale: probe() must succeed before start()');
      // Re-read just before applying: a port another rule took since the probe is not ours to share.
      const again = preflight({ tailscale, platform });
      if (again.occupied.has(plan.port)) throw new Error(`Funnel port ${plan.port} was taken by another rule after the check; its rule is unchanged`);
      record = recordPath(home, recordName);
      recoverStaleFunnel(home, tailscale, recordName);
      writeExposureRecord({ file: record, worker: 'trial', dnsName: plan.dnsName, port: plan.port, localPort: gatePort, url: plan.origin });
      rule = { dnsName: plan.dnsName, port: plan.port, gatePort };
      child = spawnChild(cli ?? 'tailscale', funnelOnArgs(plan.port, gatePort).filter(arg => arg !== '--bg'), { env, stdio: 'ignore' });
      const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      for (let waited = 0; ; waited += 500) {
        const status = JSON.parse(tailscale(funnelStatusArgs()).stdout || '{}');
        if (funnelRuleMatches(status, plan.dnsName, plan.port, gatePort)) break;
        if (waited >= 20_000 || child.exitCode !== null) throw new Error('tailscale funnel did not publish the rule');
        await raceAbort(clock.sleep(500), signal);
      }
      return { origin: plan.origin, exited };
    },
    // Ends the child, then confirms the rule is gone. Only a rule that still matches ours is switched off.
    async stop() {
      if (!rule) return { removed: true };
      if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), clock.sleep(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
      try { removeExposure({ tailscale, file: record, log: () => {} }); return { removed: true }; }
      catch (error) {
        const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
        const keys = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR'];
        const assignments = keys.filter(key => env[key] !== undefined).map(key => `${key}=${quote(env[key])}`);
        const command = cli && path.isAbsolute(cli)
          ? `(unset ${keys.join(' ')} && ${[...assignments, quote(cli), ...funnelOffArgs(rule.port).map(quote)].join(' ')})`
          : null;
        return { removed: false, detail: error.message, ...(command ? { command } : {}) };
      }
    },
  };
}

// A record from a trial that was killed: switch off exactly its rule if it is still ours, then drop the record.
function recoverStaleFunnel(home, tailscale, recordName = 'trial') {
  const file = recordPath(home, recordName);
  if (fs.existsSync(file)) removeExposure({ tailscale, file, log: () => {} });
}

// ---- A Tailscale node of its own -----------------------------------------------------------------------------------------
// When this computer's Tailscale has a rule on 443, the trial starts a second, userspace `tailscaled`: its own socket and hostname
// (dalan-trial-<id>), so it has its own address and its own :443 Funnel. It touches nothing of the computer's Tailscale.
// The node is EPHEMERAL: `--state=mem:` keeps no state on disk and registers the machine as an ephemeral node, so Tailscale
// removes it by itself once the daemon is gone, even when this process was killed. `stop` ends the Funnel, logs out (which removes
// it at once), ends the daemon and deletes the socket directory.
// Every node is also listed in a registry that does not depend on the trial home. Any later trial sweeps it and ends daemons whose
// trial is gone.
const SOCKET_PATH_LIMIT = 100; // a unix socket path must fit sun_path (104 on macOS, 108 on Linux)
const nodeCli = (sock, env) => args => spawnSync('tailscale', [`--socket=${sock}`, ...args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env });
const defaultRegistry = env => path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'dalan', 'trial-nodes');
// A key, a login link or a node key never reaches the daemon log.
export const maskNodeText = text => String(text).replace(/tskey-[A-Za-z0-9_-]+/g, '[key]').replace(/https:\/\/login\.tailscale\.com\/\S+/g, '[login link]').replace(/(nodekey|authkey)\S*/gi, '[secret]');

// Device and tailnet names identify the owner's tailnet. A kept log or a printed line carries neither: any *.ts.net name, the
// node's own DNS name and the tailnet's name (which can be an email address) become "[tailnet name]".
const readIdentity = run => {
  try { const status = JSON.parse(run(['status', '--json']).stdout || '{}'); return { dnsName: String(status.Self?.DNSName ?? '').replace(/\.$/, ''), tailnet: String(status.CurrentTailnet?.Name ?? '') }; } catch { return { dnsName: '', tailnet: '' }; }
};
export const redactTailnetNames = (text, names = [], { strict = false } = {}) => {
  let out = String(text).replace(/[A-Za-z0-9][A-Za-z0-9.-]*\.ts\.net\b/gi, '[tailnet name]');
  for (const name of names.filter(n => n.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(name).join('[tailnet name]');
  // The tailnet's name is unknown (no status): fail closed, since it can be an email address.
  return strict ? out.replace(/[^\s@()<>"',;]+@[^\s@()<>"',;]+\.[A-Za-z]{2,}/g, '[email]') : out;
};

// Ends the daemons of trials that no longer run. A record is stale when its trial process is gone (or its PID now runs something
// else); the daemon is ended only if its command line still names the socket this trial started it with.
export async function sweepTrialNodes({ registry, processCmd = processCommand, kill = (pid, sig) => process.kill(pid, sig), clock = { sleep }, say = () => {} }) {
  let names = []; try { names = fs.readdirSync(registry).filter(n => n.endsWith('.json')); } catch (error) { if (error.code === 'ENOENT') return { ended: [], retained: [] }; throw error; }
  const ended = [], retained = [];
  for (const name of names) {
    const file = path.join(registry, name);
    let rec; try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { retained.push({ home: null, sock: null }); continue; }
    // Keep the ownership boundary even when a record cannot be safely reclaimed.
    retained.push({ home: rec?.home ?? (typeof rec?.dir === 'string' ? path.dirname(rec.dir) : null), sock: rec?.sock ?? null });
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if (Number.isInteger(rec.pid) && (!Number.isInteger(rec.owner) || typeof rec.sock !== 'string' || !rec.sock)) continue;
    if (Number.isInteger(rec.owner)) {
      const owner = processCmd(rec.owner);
      const reused = owner.state === 'present' && rec.ownerStart && owner.start && owner.start !== rec.ownerStart;
      if (owner.state !== 'absent' && !reused) continue; // a missing command is not evidence that its trial ended
    }
    const daemonMatches = () => { const daemon = processCmd(rec.pid); return daemon.state === 'present' && daemon.command?.includes(rec.sock); };
    if (Number.isInteger(rec.pid) && rec.sock && daemonMatches()) {
      try { kill(rec.pid, 'SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 20 && daemonMatches(); i++) await clock.sleep(100);
      if (daemonMatches()) { try { kill(rec.pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    // A failed check or signal must keep the daemon's files and recovery record.
    if (Number.isInteger(rec.pid)) {
      const daemon = processCmd(rec.pid);
      if (daemon.state === 'unknown' || (daemon.state === 'present' && daemon.command?.includes(rec.sock))) continue;
    }
    // Missing identities (including older records) cannot prove PID reuse. Unknown inspection keeps all files and the debt.
    if (rec.certOut) {
      const cert = processCmd(rec.certPid);
      const different = cert.state === 'present' && rec.certStart && cert.start && cert.start !== rec.certStart;
      if (cert.state !== 'absent' && !different) {
        const unknown = cert.state !== 'present' || !cert.start || !rec.certStart;
        say(`TLS certificate cleanup deferred: ${unknown ? 'process identity unknown' : 'child still running'} (${rec.hostname ?? name}).`);
        continue;
      }
    }
    if (rec.dir && path.basename(rec.dir) === 'tsnode') fs.rmSync(rec.dir, { recursive: true, force: true });
    fs.rmSync(file, { force: true });
    ended.push(rec.hostname ?? name);
    retained.pop();
  }
  return { ended, retained };
}

export function tailscaleNodeProvider({
  env = process.env, platform = process.platform, spawnChild = spawn, runCli = nodeCli, clock = { sleep }, which = name => whichOnPath(name, env),
  newId = () => randomBytes(3).toString('hex'), loginWaitMs = 600_000, daemonWaitMs = 20_000, certWaitMs = 60_000, killGraceMs = 2000, registry = defaultRegistry(env), processCmd = processCommand,
} = {}) {
  let node = null; // { dir, sock, hostname, daemon, daemonExited, run, inner, recordFile, signedIn }
  // The credential never reaches a child's environment: it travels only in a file read by `tailscale up`.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'DALAN_TS_AUTHKEY'));
  return {
    name: 'tailscale-node',
    probe() {
      if (!which('tailscaled') || !which('tailscale')) return { ok: false, line: 'tailscaled is not installed, so a separate Tailscale node cannot be started', fix: 'Install Tailscale (it includes tailscaled) from https://tailscale.com/download, or free Funnel port 443 on this computer.' };
      return { ok: true };
    },
    recover: ({ say } = {}) => sweepTrialNodes({ registry, processCmd, clock, say }),
    async start({ gatePort, home, say = () => {}, signal }) {
      signal?.throwIfAborted();
      const { retained } = await sweepTrialNodes({ registry, processCmd, clock, say });
      const dir = path.join(home, 'tsnode'), sock = path.join(dir, 'tailscaled.sock'), hostname = `dalan-trial-${newId()}`;
      if (retained.some(debt => debt.home === home || debt.sock === sock || (!debt.home && !debt.sock))) {
        throw Object.assign(new Error(`Cannot confirm that the earlier Tailscale node in ${home} has stopped; its files are retained.`), { tryKind: 'node_retained' });
      }
      if (Buffer.byteLength(sock) > SOCKET_PATH_LIMIT) throw new Error('the trial home path is too long for a Tailscale socket; choose a shorter --home');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // tailscaled keeps its TLS certificates under its var root (--statedir). --state=mem: gives it none, so without this directory
      // every first TLS hello fails ("no TailscaleVarRoot") and the public address answers with a TLS internal error. It lives inside
      // `tsnode`, so it goes with the node.
      const stateDir = path.join(dir, 'state');
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
      const recordFile = path.join(registry, `${hostname}.json`);
      const owner = processCmd(process.pid);
      const writeRecord = pid => fs.writeFileSync(recordFile, JSON.stringify({ dir, sock, hostname, pid, home, owner: process.pid, ownerCmd: owner.command ?? null, ownerStart: owner.start ?? null, created_at: new Date().toISOString() }), { mode: 0o600 });
      writeRecord(null); // ownership is recorded before the first process exists
      const run = runCli(sock, childEnv);
      const logFile = path.join(dir, 'tailscaled.log');
      const daemon = spawnChild('tailscaled', ['--tun=userspace-networking', '--state=mem:', `--statedir=${stateDir}`, `--socket=${sock}`, '--port=0'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      const daemonLog = lineBuffer(line => { try { fs.appendFileSync(logFile, `${maskNodeText(line)}\n`, { mode: 0o600 }); } catch { /* the directory is gone */ } });
      for (const stream of [daemon.stdout, daemon.stderr]) { stream?.setEncoding?.('utf8'); stream?.on('data', daemonLog); stream?.on('end', () => daemonLog.end()); }
      const daemonExited = new Promise(resolve => { daemon.once('exit', resolve); daemon.once('error', resolve); });
      node = { dir, sock, hostname, daemon, daemonExited, run, recordFile, inner: null, signedIn: false };
      writeRecord(daemon.pid ?? null);
      for (let waited = 0; ; waited += 250) {
        let up = false; try { up = Boolean(JSON.parse(run(['status', '--json']).stdout || '{}').BackendState); } catch { /* not ready */ }
        if (up) break;
        if (daemon.exitCode !== null || waited >= daemonWaitMs) throw new Error('tailscaled did not start for the trial node');
        await raceAbort(clock.sleep(250), signal);
      }
      // One-time sign-in of the new node: a login URL on a terminal, or an auth key from DALAN_TS_AUTHKEY. The key is in a 0600 file
      // only while `tailscale up` runs.
      const keyFile = path.join(dir, 'authkey');
      const upArgs = ['up', `--hostname=${hostname}`, '--accept-dns=false', '--accept-routes=false'];
      if (env.DALAN_TS_AUTHKEY) { fs.writeFileSync(keyFile, env.DALAN_TS_AUTHKEY, { mode: 0o600 }); upArgs.push(`--auth-key=file:${keyFile}`); }
      const upChild = spawnChild('tailscale', [`--socket=${sock}`, ...upArgs], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let announced = false, timer = null;
      const scan = lineBuffer(line => {
        const url = !announced && /https:\/\/login\.tailscale\.com\/\S+/.exec(line)?.[0];
        if (url) { announced = true; say(`This temporary Tailscale node needs a one-time sign-in. Open: ${url}`); say('Waiting for the sign-in…'); }
      });
      for (const stream of [upChild.stdout, upChild.stderr]) { stream?.on('data', scan); stream?.on('end', () => scan.end()); }
      const upDone = new Promise(resolve => { upChild.once('exit', code => { scan.end(); resolve(code); }); upChild.once('error', () => resolve(-1)); });
      const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), loginWaitMs); });
      let code;
      try { code = await raceAbort(Promise.race([upDone, timedOut]), signal); }
      finally { clearTimeout(timer); fs.rmSync(keyFile, { force: true }); if (upChild.exitCode === null && upChild.signalCode === null) upChild.kill('SIGTERM'); }
      if (code !== 0) throw new Error(code === 'timeout' ? 'the one-time Tailscale sign-in was not completed in time' : 'the Tailscale node could not sign in');
      node.signedIn = true;
      node.identity = readIdentity(run); // kept now: at diagnose time the node may no longer answer status
      const wrapSpawn = (cmd, args, opts) => spawnChild(cmd, [`--socket=${sock}`, ...args], opts);
      const inner = tailscaleProvider({ tailscale: run, env: childEnv, platform: 'linux', spawnChild: wrapSpawn, clock, which: () => true, name: 'tailscale-node', record: 'trial-node' });
      node.inner = inner;
      const probe = inner.probe();
      if (!probe.ok) throw new Error(probe.fix);
      const started = await inner.start({ gatePort, home, signal });
      return { origin: started.origin, exited: Promise.race([started.exited, daemonExited]) };
    },
    // Called when the public address never answered: one bounded certificate request on the node's own socket says whether the
    // node can get a TLS certificate at all, and a copy of the daemon log survives the node's directory.
    // Output: one line, never a key. The certificate files go to a private directory inside `tsnode` (so the sweep of an
    // abandoned trial removes them too) and are deleted once the child has exited. Names that identify the tailnet are redacted
    // from the line and from the kept log.
    async diagnose({ home, say = () => {}, signal } = {}) {
      if (!node) return;
      const now = readIdentity(node.run), cached = node.identity ?? { dnsName: '', tailnet: '' };
      const dnsName = now.dnsName || cached.dnsName, tailnet = now.tailnet || cached.tailnet;
      if (dnsName || tailnet) node.identity = { dnsName, tailnet };
      const redact = text => redactTailnetNames(text, [dnsName, tailnet], { strict: !tailnet });
      let verdict;
      if (!dnsName) verdict = 'error (the node has no DNS name)';
      else {
        const out = fs.mkdtempSync(path.join(node.dir, 'tlscheck-'));
        let timer = null, child = null, gone = true, exited = null;
        const recordCert = fields => {
          const rec = JSON.parse(fs.readFileSync(node.recordFile, 'utf8'));
          const pending = node.recordFile + '.cert-tmp';
          try {
            fs.writeFileSync(pending, JSON.stringify({ ...rec, ...fields }), { mode: 0o600 });
            fs.renameSync(pending, node.recordFile);
          } finally { fs.rmSync(pending, { force: true }); }
        };
        try {
          // Persist the folder before spawning. If later identity persistence fails, this marker still prevents a sweep deleting it.
          recordCert({ certOut: out, certPid: null, certCmd: null, certStart: null });
          child = spawnChild('tailscale', [`--socket=${node.sock}`, 'cert', `--cert-file=${path.join(out, 'cert')}`, `--key-file=${path.join(out, 'key')}`, dnsName], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
          let said = '';
          for (const stream of [child.stdout, child.stderr]) { stream?.setEncoding?.('utf8'); stream?.on('data', chunk => { if (said.length < 2000) said += chunk; }); }
          gone = false;
          exited = new Promise(resolve => child.once('exit', code => { gone = true; resolve(code); }));
          const failed = new Promise(resolve => child.once('error', () => { if (!child.pid) gone = true; resolve(-1); }));
          node.certChild = { out, exited };
          const identity = processCmd(child.pid);
          recordCert({ certPid: child.pid ?? null, certCmd: identity.command ?? null, certStart: identity.start ?? null });
          const aborted = new Promise(resolve => { if (signal?.aborted) resolve('aborted'); else signal?.addEventListener('abort', () => resolve('aborted'), { once: true }); });
          const code = await Promise.race([exited, failed, aborted, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), certWaitMs); })]);
          const first = said.split('\n').map(l => l.trim()).find(Boolean);
          verdict = code === 0 ? 'ok' : code === 'aborted' ? 'error (cancelled)' : code === 'timeout' ? `error (no answer in ${Math.round(certWaitMs / 1000)} s)` : `error (${first ? redact(safeDiagnostic(first, 120)) : `exit ${code}`})`;
        } catch (error) { verdict = `error (${redact(safeDiagnostic(error.message, 120))})`; }
        finally {
          clearTimeout(timer);
          // Every path, including a record-write or process-control error, attempts termination before handing off cleanup debt.
          for (const sig of ['SIGTERM', 'SIGKILL']) {
            if (gone) break;
            try { child.kill(sig); } catch { /* a failed signal does not prove exit */ }
            await Promise.race([exited, clock.sleep(killGraceMs)]);
          }
          // The files go only after confirmed exit. Otherwise stop and the sweep retain them as cleanup debt.
          if (gone) {
            fs.rmSync(out, { recursive: true, force: true });
            node.certChild = null;
            try { recordCert({ certOut: null, certPid: null, certCmd: null, certStart: null }); }
            catch { say('TLS certificate cleanup record could not be cleared; a later sweep may retain it.'); }
          }
          else {
            node.certChild = { out, exited }; // the node's stop keeps owning it
            say(`TLS certificate check did not stop (termination not confirmed); its files stay in ${out} until exit is confirmed.`);
          }
        }
      }
      say(`TLS certificate: ${verdict}`);
      try {
        const kept = path.join(home, 'tailscaled.log');
        fs.writeFileSync(kept, fs.readFileSync(path.join(node.dir, 'tailscaled.log'), 'utf8').split('\n').map(redact).join('\n'), { mode: 0o600 });
        fs.chmodSync(kept, 0o600);
      } catch { /* no log to keep */ }
    },
    async stop() {
      if (!node) return { removed: true };
      const { dir, hostname, daemon, run, recordFile, inner } = node;
      let result = { removed: true };
      if (inner) result = await inner.stop();
      let loggedOut = true;
      if (node.signedIn) { try { loggedOut = run(['logout']).status === 0; } catch { loggedOut = false; } }
      const daemonGone = () => daemon.exitCode !== null || daemon.signalCode != null || !Number.isInteger(daemon.pid);
      if (!daemonGone()) {
        const gone = new Promise(resolve => daemon.once('exit', resolve));
        try { daemon.kill('SIGTERM'); } catch { /* only exit confirms cleanup */ }
        await Promise.race([gone, clock.sleep(5000)]);
        if (!daemonGone()) {
          try { daemon.kill('SIGKILL'); } catch { /* keep recovery debt */ }
          await Promise.race([gone, clock.sleep(killGraceMs)]);
        }
      }
      const daemonConfirmed = daemonGone();
      // A certificate child that diagnose could not stop still holds its files: wait once more for its exit. Without a confirmed
      // exit, everything else goes, the child's directory stays, and the record stays so the next sweep removes it.
      const pendingCert = node.certChild;
      let certConfirmed = true;
      if (pendingCert) {
        let exitedNow = false; pendingCert.exited.then(() => { exitedNow = true; });
        await Promise.race([pendingCert.exited, clock.sleep(killGraceMs)]);
        certConfirmed = exitedNow;
      }
      if (daemonConfirmed && certConfirmed) { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(recordFile, { force: true }); }
      else if (daemonConfirmed) {
        for (const entry of fs.readdirSync(dir)) if (path.join(dir, entry) !== pendingCert.out) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
      node = null;
      // keepNode tells the caller not to delete the node's directory: a certificate child still holds files there.
      const keep = daemonConfirmed && certConfirmed ? {} : { keepNode: true };
      if (!daemonConfirmed) return { removed: false, ...keep, detail: `the trial's Tailscale daemon did not exit; its files and recovery record are retained` };
      if (!result.removed) return { ...result, ...keep };
      // Logout removes the node at once. If it failed, the node is still registered until Tailscale drops the ephemeral machine.
      return loggedOut ? { removed: true, ...keep } : { ...keep, removed: false, detail: `the trial's Tailscale node ${hostname} could not be logged out. It is ephemeral, so Tailscale removes it on its own once offline; to remove it now, delete ${hostname} in the Tailscale admin console` };
    },
  };
}

// ---- localhost.run (explicit legacy route) -------------------------------------------------------------------------------
// An explicit legacy option. The relay ends TLS and can see traffic. A changed address cannot keep the OAuth identity, so the trial
// stops instead of restarting.
export const LHR_ORIGIN = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.lhr\.life$/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// Every origin the relay names on one line of its session output. Banner links (admin.localhost.run, docs) are not tunnels: only
// a single-label name under lhr.life counts.
export function parseLocalhostRunOrigins(line) {
  const found = [];
  for (const token of String(line).replace(ANSI, '').split(/[\s,]+/)) {
    const match = /^https:\/\/[^/?#]+/.exec(token);
    if (match && LHR_ORIGIN.test(match[0]) && token === match[0]) found.push(match[0]);
  }
  return [...new Set(found)];
}
export const LOCALHOST_RUN_FIX = 'ssh is not installed. Install OpenSSH (macOS and most Linux systems include it; on Debian or Ubuntu: sudo apt install openssh-client) and run this again.';
export function localhostRunProvider({ env = process.env, spawnChild = spawn, which = name => whichOnPath(name, env), clock = { sleep }, startMs = 30_000, killGraceMs = 2000 } = {}) {
  let child = null, reason = null, forget = () => {};
  const registry = childRegistry(env);
  return {
    name: 'localhost.run',
    // An ssh left by a trial whose process was killed without cleanup is ended by the next trial.
    recover: () => sweepChildren({ registry, clock }).then(pids => pids.length ? ['ssh'] : []),
    probe: () => which('ssh') ? { ok: true } : { ok: false, line: LOCALHOST_RUN_FIX, fix: LOCALHOST_RUN_FIX },
    // Why the route ended, when the provider knows: 'rotated' (the relay named a new address), else null.
    endedBecause: () => reason,
    async start({ gatePort, home, signal }) {
      if (!Number.isInteger(gatePort) || gatePort < 1 || gatePort > 65535) throw new Error('the local gate port is not valid');
      signal?.throwIfAborted();
      // A known_hosts file of the trial's own: the relay's key is trusted at first use and then pinned for this trial. The user's
      // ssh configuration, agent and keys are not used (the relay needs no key).
      const dir = path.join(home, 'localhost-run');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const childEnv = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(k => env[k] !== undefined).map(k => [k, env[k]]));
      const args = ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
        '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ForwardAgent=no', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
        '-R', `80:127.0.0.1:${gatePort}`, 'nokey@localhost.run'];
      child = spawnChild('ssh', args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      forget = registerChild({ registry, child });
      child.once('exit', () => forget());
      let first = null, tail = '';
      let onRotate = () => {};
      const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      const origin = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(reject)(new Error('localhost.run did not report a public address in time')), startMs);
        const onAbort = () => finish(reject)(abortReason(signal));
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        let settled = false;
        const finish = fn => value => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value); };
        const onLine = line => {
          tail = `${tail}${String(line).replace(ANSI, '')}\n`.slice(-2000);
          for (const found of parseLocalhostRunOrigins(line)) {
            if (first === null) { first = found; finish(resolve)(found); }
            else if (found !== first && reason === null) { reason = 'rotated'; onRotate(); }
          }
        };
        const sinks = [child.stdout, child.stderr].map(stream => { const buffer = lineBuffer(onLine); stream?.setEncoding?.('utf8'); stream?.on('data', buffer); stream?.on('end', () => buffer.end()); return buffer; });
        exited.then(() => { for (const sink of sinks) sink.end(); finish(reject)(new Error(`ssh to localhost.run ended before the tunnel was ready: ${safeDiagnostic(tail.trim().split('\n').filter(Boolean).slice(-2).join(' '), 200)}`)); });
      });
      // A new address after the first one ends the route: the sign-in identity is tied to the first.
      const ended = new Promise(resolve => { exited.then(resolve); onRotate = () => { child.kill('SIGTERM'); resolve('rotated'); }; });
      if (reason === 'rotated') onRotate();
      return { origin, exited: ended };
    },
    async stop() {
      if (!child) return { removed: true };
      if (child.exitCode === null && child.signalCode === null) {
        const gone = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([gone, clock.sleep(killGraceMs)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([gone, clock.sleep(killGraceMs)]); }
      }
      return child.exitCode !== null || child.signalCode !== null ? { removed: true } : { removed: false, detail: 'the ssh process did not exit', command: `kill ${child.pid}` };
    },
  };
}

// ---- Gozar (transport only; Dalan still owns sign-in and identity) --------------------------------------------------------
const require = createRequire(import.meta.url);
const bundledGozar = () => {
  try { return require.resolve('@tnunamak/gozar/bin/gozar.mjs'); } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
};

export function gozarProvider({ env = process.env, which = name => whichOnPath(name, env), resolveBundled = bundledGozar, run = execFile, pollMs = 3000, now = Date.now } = {}) {
  let binary = null, bundled = null, commandCwd = null, port = null, sessionId = null;
  let endReason = null;
  let watching = false, timer = null, wakeWatcher = () => {}, watcher = Promise.resolve();
  const command = (args, { status = false } = {}) => new Promise((resolve, reject) => {
    run(binary, [...(bundled ? [bundled] : []), ...args], { cwd: commandCwd, env, encoding: 'utf8', timeout: status ? 15_000 : 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      let reply;
      try { reply = JSON.parse(stdout); } catch { reject(new Error('Gozar did not return valid JSON')); return; }
      if (status && !validStatus(reply?.snapshot)) { reject(new Error('Gozar did not return valid status JSON')); return; }
      // Status exits 1 with valid, withdrawn-readiness JSON when no controller is running.
      if ((error && !(status && error.code === 1 && withdrawn(reply?.snapshot))) || reply?.error) {
        reject(Object.assign(new Error(`Gozar: ${safeDiagnostic(reply?.error ?? 'command failed', 240)}`), { gozarReply: reply })); return;
      }
      resolve(reply);
    });
  });
  // Recovery may be pasted into another shell: retain the selected executable and
  // directory lookup context, without printing unrelated environment secrets.
  const recoveryCommand = target => {
    const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const keys = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'GOZAR_HOME'];
    const assignments = keys.filter(key => env[key] !== undefined).map(key => `${key}=${quote(env[key])}`);
    const argv = [binary, ...(bundled ? [bundled] : []), 'stop', '--port', String(target)];
    return `(cd ${quote(commandCwd ?? process.cwd())} && unset ${keys.join(' ')} && ${[...assignments, ...argv.map(quote)].join(' ')})`;
  };
  const status = target => command(['status', '--port', String(target), '--json'], { status: true });
  const validResources = snapshot => snapshot.resources === undefined || (Array.isArray(snapshot.resources) &&
    snapshot.resources.every(resource => resource && typeof resource === 'object' && !Array.isArray(resource) && typeof resource.cleanup === 'string' && resource.cleanup.length > 0));
  const validStatus = snapshot => snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) &&
    typeof snapshot.phase === 'string' && snapshot.phase.length > 0 &&
    (snapshot.published === null || (typeof snapshot.published === 'string' && snapshot.published.length > 0)) &&
    (snapshot.candidate === null || (typeof snapshot.candidate === 'string' && snapshot.candidate.length > 0)) && validResources(snapshot);
  const withdrawn = snapshot => validStatus(snapshot) &&
    snapshot.published === null && snapshot.candidate === null &&
    ['unknown', 'stopped', 'stopping', 'cleanup-pending'].includes(snapshot.phase);
  const removed = snapshot => withdrawn(snapshot) && (snapshot.resources ?? []).every(resource => resource.cleanup === 'removed') &&
    (snapshot.phase === 'stopped' || (snapshot.phase === 'unknown' && Array.isArray(snapshot.limitations) && snapshot.limitations.some(line => typeof line === 'string' && /^Controller unavailable:.*\b(?:ENOENT|ECONNREFUSED)\b/.test(line))));
  const stopWatcher = async () => {
    watching = false;
    clearTimeout(timer);
    wakeWatcher();
    await watcher;
  };
  return {
    name: 'gozar',
    probe() {
      commandCwd = process.cwd();
      bundled = resolveBundled();
      binary = bundled ? process.execPath : null;
      if (!binary && env.GOZAR_BIN) {
        try { fs.accessSync(env.GOZAR_BIN, fs.constants.X_OK); binary = env.GOZAR_BIN; } catch { /* unavailable */ }
      }
      binary ??= which('gozar');
      return binary ? { ok: true } : { ok: false, line: 'Gozar is not installed', fix: 'Install gozar on PATH or set GOZAR_BIN to its executable path.' };
    },
    async start({ gatePort, signal, lifetimeEndsAt }) {
      signal?.throwIfAborted();
      if (!binary) throw new Error('gozar: probe() must succeed before start()');
      if (!Number.isInteger(gatePort) || gatePort < 1 || gatePort > 65535) throw new Error('the local gate port is not valid');
      // Expose silently reuses an existing controller. Refuse it before acquiring any cleanup responsibility.
      const before = await status(gatePort);
      if (!removed(before.snapshot)) throw new Error(`port ${gatePort} already has a Gozar route; Dalan cannot confirm ownership and is leaving it untouched. Choose a different --port and --home for another trial.`);
      signal?.throwIfAborted();
      port = gatePort;
      // Pin the trial adapter; never let auto recommendation select the machine's Tailscale.
      // Let expose settle before cleanup: it starts a background controller even if the caller cancels.
      let reply;
      const lifetimeArgs = lifetimeEndsAt === undefined ? [] : ['--lifetime-ms', String(Math.max(1, Math.floor(lifetimeEndsAt - now())))];
      try { reply = await command(['expose', ...lifetimeArgs, '--port', String(port), '--client-reach', 'internet', '--yes', '--json', '--transport', 'https', '--sse', '--adapter', 'tunnl-gg']); }
      catch (error) { sessionId = error.gozarReply?.snapshot?.sessionId ?? null; throw error; }
      sessionId = reply?.snapshot?.sessionId ?? null;
      signal?.throwIfAborted();
      const origin = reply?.snapshot?.published;
      let url; try { url = new URL(origin); } catch { /* rejected below */ }
      if (typeof sessionId !== 'string' || !sessionId || reply?.snapshot?.phase !== 'published-ready' || !url || url.protocol !== 'https:' || url.origin !== origin) throw new Error('Gozar did not publish a ready HTTPS origin with a session identity');
      let ended;
      const exited = new Promise(resolve => { ended = resolve; });
      const ownedPort = port, ownedSession = sessionId;
      watching = true;
      watcher = (async () => {
        while (watching) {
          await new Promise(resolve => { wakeWatcher = resolve; timer = setTimeout(resolve, pollMs); timer.unref?.(); });
          if (!watching) break;
          try {
            const current = (await status(ownedPort)).snapshot;
            if (current?.sessionId === ownedSession && current.phase === 'published-ready' && current.published === origin) continue;
            endReason = current?.sessionId === ownedSession && current.phase === 'published-ready' && current.published && current.published !== origin ? 'rotated' : 'lost';
          } catch { /* Unobservable readiness cannot keep the trial alive. */ }
          if (watching) ended();
          break;
        }
      })();
      return { origin, exited, endedBecause: () => endReason };
    },
    async stop() {
      await stopWatcher();
      if (port === null) return { removed: true };
      let current;
      try {
        current = (await status(port)).snapshot;
      } catch (error) {
        return { removed: false, detail: `Gozar session ownership could not be confirmed (${error.message}); leaving the route untouched. Choose a different --port and --home for another trial.` };
      }
      if (sessionId && current?.sessionId && current.sessionId !== sessionId) {
        return { removed: false, detail: 'Gozar now reports a different session for this port; cleanup of this trial could not be confirmed. The replacement was left untouched. Choose a different --port and --home for another trial.' };
      }
      if (removed(current)) {
        const noController = current.phase === 'unknown' && Array.isArray(current.limitations) && current.limitations.some(line => typeof line === 'string' && /^Controller unavailable:.*\b(?:ENOENT|ECONNREFUSED)\b/.test(line));
        if (!noController && (!sessionId || current.sessionId !== sessionId)) {
          return { removed: false, detail: 'Gozar reports no active route, but cleanup of this trial could not be confirmed because its session identity is missing. Choose a different --port and --home for another trial.' };
        }
        port = null; sessionId = null;
        return { removed: true };
      }
      // This avoids stopping a session already known to be unowned; Gozar can still race a replacement after this check.
      if (!sessionId || current?.phase === 'unknown' || current?.sessionId !== sessionId) {
        return { removed: false, detail: 'Gozar session ownership could not be confirmed; leaving the route untouched. Choose a different --port and --home for another trial.' };
      }
      const cleanupCommand = recoveryCommand(port);
      let reply;
      try {
        reply = await command(['stop', '--port', String(port), '--json']);
      } catch (error) {
        return { removed: false, detail: `Gozar route cleanup is unconfirmed (${error.message}); its current owner could not be confirmed. Choose a different --port and --home for another trial.` };
      }
      const stopped = reply?.snapshot;
      if (!validStatus(stopped) || stopped.sessionId !== sessionId || stopped.phase === 'unknown') {
        return { removed: false, detail: 'Gozar route cleanup is unconfirmed; its current owner could not be confirmed. Choose a different --port and --home for another trial.' };
      }
      if (removed(stopped) && !reply.localCleanupFailures?.length) {
        port = null; sessionId = null;
        return { removed: true };
      }
      if (stopped.phase === 'cleanup-pending' && stopped.published === null && stopped.candidate === null) {
        return { removed: false, detail: 'Gozar reports cleanup pending for this session. Its recovery command stops by port and can race a route replacement; inspect the route before you run it.', command: cleanupCommand };
      }
      return { removed: false, detail: 'Gozar route cleanup is unconfirmed; its current owner could not be confirmed. Choose a different --port and --home for another trial.' };
    },
  };
}

// ---- choosing a route --------------------------------------------------------------------------------------------------
// `tailscale` uses the computer's HTTPS route, or an isolated node when that route is busy. `gozar` is the temporary demo relay.
// An explicit route shows its own failure and never falls back to the other. Existing Tailscale rules are never changed.
export function selectRouteProvider({ route = 'gozar', providers, say = () => {}, signal }) {
  const named = name => providers.find(p => p.name === name);
  signal?.throwIfAborted();
  if (route === 'localhost.run' || route === 'gozar') {
    const provider = named(route), probe = provider.probe();
    if (!probe.ok) throw new Error(probe.fix);
    return provider;
  }
  if (route !== 'tailscale') throw new Error(`unknown route ${route}`);
  const host = named('tailscale').probe();
  let choice = null, why = host.fix;
  if (host.ok) choice = named('tailscale');
  else if (host.busy && named('tailscale-node')) {
    const node = named('tailscale-node').probe();
    if (node.ok) { say(`${host.line} Starting a separate Tailscale node for this trial.`); choice = named('tailscale-node'); }
    else { say(host.line); why = `${host.fix} (${node.fix})`; }
  } else say(host.line);
  if (!choice) throw new Error(why);
  return choice;
}

export async function startRoute({ route = 'gozar', providers, selectedProvider, gatePort, home, say, signal, lifetimeEndsAt }) {
  // Clean a failed start before returning, and carry any retained files/debt to the caller's final cleanup.
  const attempt = async provider => {
    signal?.throwIfAborted();
    try {
      const started = await provider.start({ gatePort, home, say, signal, lifetimeEndsAt });
      return { provider, origin: started.origin, exited: started.exited, endedBecause: started.endedBecause, stop: () => provider.stop() };
    } catch (error) {
      const cleaned = await provider.stop().catch(e => ({ removed: false, keepNode: true, detail: e.message }));
      if (!cleaned.removed) throw Object.assign(new Error(`${provider.name} failed (${error.message}) and could not be removed: ${cleaned.detail}${cleaned.command ? `\nRemove it with:\n  ${cleaned.command}` : ''}`), { cleanupFailed: true, routeCleanup: cleaned });
      throw Object.assign(error, { routeCleanup: cleaned });
    }
  };
  return attempt(selectedProvider ?? selectRouteProvider({ route, providers, say, signal }));
}

// A trial constraint, not an OAuth rule: RFC 8414 lets an authorization server live on another origin. A trial's bridge serves its own
// authorization server, so the check requires the issuer and every endpoint on the trial's public origin (a bare root issuer counts).
export const TRIAL_ORIGIN_RULE = 'a trial constraint: the bridge serves its own authorization server on the public origin';
export const onOrigin = (origin, value) => value === origin || value.startsWith(`${origin}/`);
// RFC 8414 section 3.1: the well-known segment goes between the host and the issuer's path, and a terminal slash of that path is
// dropped. The metadata's `issuer` is still compared to the issuer exactly as written.
export function authorizationServerMetadataUrl(issuer) {
  let url; try { url = new URL(issuer); } catch { url = null; }
  if (!url || url.search || url.hash || issuer.includes('?') || issuer.includes('#')) throw new Error('the issuer is not a plain address (it has a query or fragment, or is not a URL)');
  return `${url.origin}/.well-known/oauth-authorization-server${url.pathname.replace(/\/$/, '')}`;
}

// ---- readiness ---------------------------------------------------------------------------------------------------------
// The public address answers as this bridge: trusted TLS (the platform's fetch checks it), discovery that names this origin and
// resource, an OAuth challenge on an unauthenticated MCP request, and no owner route. The secret path is known only to this bridge,
// so a matching discovery document also shows that the route reaches it and not another program.
export async function verifyPublicReady({ origin, secret, fetchImpl = fetch, clock = { now: Date.now, sleep }, timeoutMs, say = () => {}, signal }) {
  const within = ms => signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
  const resource = `${origin}/${secret}/mcp`;
  const check = async () => {
    const meta = await fetchImpl(`${origin}/.well-known/oauth-protected-resource/${secret}/mcp`, { redirect: 'manual', signal: within(10_000) });
    if (meta.status !== 200) return `discovery returned HTTP ${meta.status}`;
    const doc = await meta.json().catch(() => null);
    if (doc?.resource !== resource) return 'discovery names a different resource';
    if (!Array.isArray(doc.authorization_servers) || doc.authorization_servers.length === 0) return 'discovery names no authorization server';
    if (!doc.authorization_servers.every(s => onOrigin(origin, String(s)))) return `discovery names an issuer outside this origin (${TRIAL_ORIGIN_RULE})`;
    // The issuer's own metadata: the exact issuer, and https endpoints for sign-in, tokens and registration on this origin.
    const issuer = String(doc.authorization_servers[0]);
    let asUrl; try { asUrl = authorizationServerMetadataUrl(issuer); } catch (error) { return error.message; }
    const asMeta = await fetchImpl(asUrl, { redirect: 'manual', signal: within(10_000) });
    if (asMeta.status !== 200) return `authorization-server metadata returned HTTP ${asMeta.status}`;
    const as = await asMeta.json().catch(() => null);
    if (as?.issuer !== issuer) return 'the authorization-server issuer does not match the issuer in discovery';
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      if (typeof as[key] !== 'string' || !onOrigin(origin, as[key])) return `the authorization server's ${key} is missing or is not an address on this origin (${TRIAL_ORIGIN_RULE})`;
    }
    const challenge = await fetchImpl(resource, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}', signal: within(10_000) });
    const isChallenge = challenge.status === 401 && /^Bearer/i.test(challenge.headers.get('www-authenticate') ?? '');
    void challenge.body?.cancel().catch(() => {});
    if (!isChallenge) return `an unauthenticated MCP request returned HTTP ${challenge.status}, not an OAuth challenge`;
    for (const owner of ['/admin', '/connect/pending', '/connect/list']) {
      const res = await fetchImpl(`${origin}${owner}`, { redirect: 'manual', signal: within(10_000) });
      const status = res.status;
      void res.body?.cancel().catch(() => {});
      if (status === 200) return `${owner} answers on the public address`;
    }
    return {
      resource: doc.resource,
      authorizationServers: doc.authorization_servers,
      issuer,
      authorizationServer: as,
    };
  };
  const end = clock.now() + timeoutMs;
  let last = 'no answer yet', nextSay = clock.now() + 15_000;
  for (;;) {
    signal?.throwIfAborted();
    try { last = await check(); if (last && typeof last === 'object') return { ready: true, identity: last }; }
    catch (error) { if (signal?.aborted) throw error; last = safeDiagnostic(error.cause?.code ?? error.message, 120); }
    if (clock.now() >= end) return { ready: false, last };
    if (clock.now() >= nextSay) { say(`Still waiting for the public address to answer (${last})…`); nextSay += 15_000; }
    await raceAbort(clock.sleep(2000), signal);
  }
}

const identityMatches = (actual, expected) => actual.resource === expected.resource &&
  JSON.stringify(actual.authorizationServers) === JSON.stringify(expected.authorizationServers) &&
  actual.issuer === expected.issuer &&
  ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint'].every(key => actual.authorizationServer[key] === expected.authorizationServer[key]);

async function readIdentityJson(response, signal, label, maxBytes = 65_536) {
  if (response.status >= 300 && response.status < 400) return { kind: 'identity_changed', detail: `${label} redirected` };
  if (response.status !== 200) return { kind: 'unresponsive', detail: `${label} returned HTTP ${response.status}` };
  if (!response.body) return { kind: 'unresponsive', detail: `${label} returned no body` };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('identity check timed out');
      const { done, value } = await raceSignal(reader.read(), signal, () => reader.cancel().catch(() => {}));
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        return { kind: 'identity_changed', detail: `${label} returned an oversized identity document` };
      }
      chunks.push(Buffer.from(value));
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return { kind: 'identity_changed', detail: `${label} returned invalid JSON` }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'identity_changed', detail: `${label} returned invalid JSON` };
    return { value };
  } finally { try { reader.releaseLock(); } catch { /* A timed-out stream may still be cancelling. */ } }
}

function raceSignal(promise, signal, onAbort = () => {}) {
  if (signal.aborted) {
    const failed = Promise.reject(signal.reason ?? new Error('identity check timed out'));
    onAbort();
    return failed;
  }
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => { reject(signal.reason ?? new Error('identity check timed out')); onAbort(); };
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', listener));
}

// One bounded identity check: one deadline covers TLS, all response bodies and every endpoint.
export async function checkPublicIdentity({ origin, secret, fetchImpl = fetch, signal, timeoutMs = 5000 }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const checkSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const request = (url, init = {}) => raceSignal(fetchImpl(url, { ...init, redirect: 'manual', signal: checkSignal }), checkSignal);
  const resource = `${origin}/${secret}/mcp`;
  try {
    const meta = await request(`${origin}/.well-known/oauth-protected-resource/${secret}/mcp`);
    const docResult = await readIdentityJson(meta, checkSignal, 'protected-resource metadata');
    if (docResult.kind) return docResult;
    const doc = docResult.value;
    if (doc.resource !== resource || !Array.isArray(doc.authorization_servers) || !doc.authorization_servers.length ||
        doc.authorization_servers.some(value => typeof value !== 'string' || !onOrigin(origin, value))) {
      return { kind: 'identity_changed', detail: 'protected-resource identity changed' };
    }
    const issuer = doc.authorization_servers[0];
    let asUrl;
    try { asUrl = authorizationServerMetadataUrl(issuer); }
    catch { return { kind: 'identity_changed', detail: 'authorization-server identity changed' }; }
    const asResponse = await request(asUrl);
    const asResult = await readIdentityJson(asResponse, checkSignal, 'authorization-server metadata');
    if (asResult.kind) return asResult;
    const as = asResult.value;
    if (as.issuer !== issuer || !['authorization_endpoint', 'token_endpoint', 'registration_endpoint'].every(key =>
      typeof as[key] === 'string' && onOrigin(origin, as[key]))) {
      return { kind: 'identity_changed', detail: 'authorization-server identity changed' };
    }
    const challenge = await request(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    try {
      if (challenge.status >= 300 && challenge.status < 400) return { kind: 'identity_changed', detail: 'MCP endpoint redirected' };
      if (challenge.status !== 401 || !/^Bearer/i.test(challenge.headers.get('www-authenticate') ?? '')) {
        return { kind: 'unresponsive', detail: `MCP identity probe returned HTTP ${challenge.status}` };
      }
    } finally { void challenge.body?.cancel().catch(() => {}); }
    const actual = { resource: doc.resource, authorizationServers: doc.authorization_servers, issuer, authorizationServer: as };
    return { kind: 'ready', identity: actual };
  } catch (error) {
    if (signal?.aborted) return { kind: 'stopped' };
    return { kind: 'unresponsive', detail: safeDiagnostic(error?.cause?.code ?? error?.message ?? 'probe failed', 160) };
  }
}

const sleepOrAbort = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

// The URL is also the OAuth identity. A replacement or two consecutive failed public checks ends this trial.
export async function watchPublicIdentity({ origin, secret, identity, fetchImpl = fetch, intervalMs = 10_000, retryMs = 5000, timeoutMs = 5000, onStatus = () => {} }) {
  const controller = new AbortController();
  let resolveReady, resolveLost;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const lost = new Promise(resolve => { resolveLost = resolve; });
  let stopped = false, failure = null;
  const check = async () => checkPublicIdentity({ origin, secret, fetchImpl, signal: controller.signal, timeoutMs });
  const run = (async () => {
    const initial = await check();
    if (initial.kind === 'identity_changed' || (initial.kind === 'ready' && !identityMatches(initial.identity, identity))) {
      resolveLost({ origin, reason: 'identity_changed', detail: initial.detail });
      resolveReady(false);
      return;
    }
    if (initial.kind !== 'ready') {
      failure = initial;
      try { onStatus('retrying', initial.detail); } catch { /* A status message cannot keep a dead route alive. */ }
    }
    resolveReady(true);
    for (;;) {
      await sleepOrAbort(failure ? retryMs : intervalMs, controller.signal);
      if (stopped) return;
      const result = await check();
      if (result.kind === 'stopped' || stopped) return;
      if (result.kind === 'identity_changed' || (result.kind === 'ready' && !identityMatches(result.identity, identity))) {
        resolveLost({ origin, reason: 'identity_changed', detail: result.detail });
        return;
      }
      if (result.kind === 'ready') {
        failure = null;
        try { onStatus('ready'); } catch { /* A status message cannot keep a dead route alive. */ }
        continue;
      }
      if (!failure) {
        failure = result;
        try { onStatus('retrying', result.detail); } catch { /* A status message cannot keep a dead route alive. */ }
        continue;
      }
      resolveLost({ origin, reason: 'unresponsive', detail: result.detail ?? failure.detail });
      return;
    }
  })();
  return {
    ready,
    lost,
    async stop() { stopped = true; controller.abort(); await run; },
  };
}
