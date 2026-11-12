// The public route for `dalan try --public`: a loopback gate the route forwards to, a ready Tailscale Funnel for a real route,
// or, for a trial, an anonymous localhost.run tunnel over `ssh`. Every process, file and rule here is
// owned by one trial and removed by `stop()`. Every outside effect goes through a seam in `deps` so tests need no real route.
import { spawn, spawnSync, execFile } from 'node:child_process';
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
// the top-level maps that the shared preflight and rule matching read (verified live on Tailscale 1.104.5). Merging the sessions
// into the top-level view makes those routines see foreground rules, ours and other people's, exactly like background ones.
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
  if (port) return { ...first(`Tailscale port ${port} is not free for Funnel on this computer; its rules are unchanged.`, `Free Funnel port ${port} (tailscale funnel status shows what uses it), or make a trial link with --route localhost.run.`), busy: /already used/.test(text) };
  if (/macOS: the Tailscale/.test(text)) return first('The Tailscale app on this Mac cannot serve Funnel here', text.split('\n')[0]);
  const line = safeDiagnostic(text.split('\n')[0], 160);
  return first(`Tailscale Funnel is not usable (${line}).`, line);
}

// WHY 443 ONLY: a trial always publishes on public port 443, for every client. On 2026-11-10 claude.ai could not reach a Funnel on
// 8443 ("Couldn't reach this address") but did reach 443, so a Funnel on any other port is not a working route. When this
// computer's Tailscale already has a rule on 443 (it is never changed), the trial uses its own Tailscale node instead
// (`tailscaleNodeProvider`), and localhost.run is the trial route.
export const TRIAL_PORT = 443;
export function tailscaleProvider({ port: wantedPort = TRIAL_PORT, name = 'tailscale', record: recordName = 'trial', tailscale: rawTailscale = tailscaleRunner(), env = process.env, platform = process.platform, spawnChild = spawn, clock = { sleep }, which = name => whichOnPath(name, env) } = {}) {
  const tailscale = seeForeground(rawTailscale);
  let plan = null, child = null, record = null, rule = null;
  return {
    name,
    // Read-only: inspects the daemon, DNS identity, capabilities and the ports other rules already use.
    probe() {
      if (!which('tailscale')) return { ok: false, ...explainTailscale(new Error('Tailscale is not installed')) };
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
      child = spawnChild('tailscale', funnelOnArgs(plan.port, gatePort).filter(arg => arg !== '--bg'), { env, stdio: 'ignore' });
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
      catch (error) { return { removed: false, detail: error.message, command: `tailscale ${funnelOffArgs(rule.port).join(' ')}` }; }
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
// Inspection failure is not evidence of exit. Read Linux start ticks on both sides of ps so command and identity belong
// to the same process. macOS supplies its start timestamp and command in one ps snapshot.
export const processCommand = (pid, { platform = process.platform, run = spawnSync, readFile = fs.readFileSync, probe = pid => process.kill(pid, 0) } = {}) => {
  const unknown = { state: 'unknown' }, absent = { state: 'absent' };
  if (!Number.isInteger(pid) || pid <= 0) return unknown;
  const startTicks = () => {
    const stat = readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('invalid process start time');
    return fields[19];
  };
  try {
    const before = platform === 'linux' ? startTicks() : null;
    if (!['linux', 'darwin'].includes(platform)) return unknown;
    const out = run('ps', ['-p', String(pid), '-o', platform === 'darwin' ? 'lstart=,command=' : 'command='], { encoding: 'utf8', timeout: 5000 });
    if (out.error || out.status !== 0 || !out.stdout?.trim()) {
      // Even ps exit 1 can be an inspection failure; only ESRCH confirms absence.
      try { probe(pid); } catch (error) { if (error.code === 'ESRCH') return absent; }
      return unknown;
    }
    if (platform === 'linux') {
      const after = startTicks();
      return before === after ? { state: 'present', command: out.stdout.trim(), start: before } : unknown;
    }
    const match = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(out.stdout.trim());
    return match ? { state: 'present', command: match[2], start: match[1].replace(/\s+/g, ' ') } : unknown;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) {
      try { probe(pid); } catch (probeError) { if (probeError.code === 'ESRCH') return absent; }
    }
    return unknown;
  }
};
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
  let names = []; try { names = fs.readdirSync(registry).filter(n => n.endsWith('.json')); } catch { return []; }
  const ended = [];
  for (const name of names) {
    const file = path.join(registry, name);
    let rec; try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fs.rmSync(file, { force: true }); continue; }
    if (Number.isInteger(rec.owner) && rec.owner !== process.pid && rec.ownerCmd) {
      const owner = processCmd(rec.owner);
      if (owner.state === 'unknown' || (owner.state === 'present' && owner.command === rec.ownerCmd)) continue; // its trial may still run
    }
    if (Number.isInteger(rec.pid) && rec.sock && processCmd(rec.pid).command?.includes(rec.sock)) {
      try { kill(rec.pid, 'SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 20 && processCmd(rec.pid).command?.includes(rec.sock); i++) await clock.sleep(100);
      if (processCmd(rec.pid).command?.includes(rec.sock)) { try { kill(rec.pid, 'SIGKILL'); } catch { /* gone */ } }
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
  }
  return ended;
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
      await sweepTrialNodes({ registry, processCmd, clock, say });
      const dir = path.join(home, 'tsnode'), sock = path.join(dir, 'tailscaled.sock'), hostname = `dalan-trial-${newId()}`;
      if (Buffer.byteLength(sock) > SOCKET_PATH_LIMIT) throw new Error('the trial home path is too long for a Tailscale socket; choose a shorter --home');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // tailscaled keeps its TLS certificates under its var root (--statedir). --state=mem: gives it none, so without this directory
      // every first TLS hello fails ("no TailscaleVarRoot") and the public address answers with a TLS internal error. It lives inside
      // `tsnode`, so it goes with the node.
      const stateDir = path.join(dir, 'state');
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
      const recordFile = path.join(registry, `${hostname}.json`);
      const writeRecord = pid => fs.writeFileSync(recordFile, JSON.stringify({ dir, sock, hostname, pid, home, owner: process.pid, ownerCmd: processCmd(process.pid).command ?? null, created_at: new Date().toISOString() }), { mode: 0o600 });
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
      if (daemon.exitCode === null && daemon.signalCode == null) { const gone = new Promise(resolve => daemon.once('exit', resolve)); daemon.kill('SIGTERM'); await Promise.race([gone, clock.sleep(5000)]); if (daemon.exitCode === null && daemon.signalCode == null) daemon.kill('SIGKILL'); }
      // A certificate child that diagnose could not stop still holds its files: wait once more for its exit. Without a confirmed
      // exit, everything else goes, the child's directory stays, and the record stays so the next sweep removes it.
      const pendingCert = node.certChild;
      let certConfirmed = true;
      if (pendingCert) {
        let exitedNow = false; pendingCert.exited.then(() => { exitedNow = true; });
        await Promise.race([pendingCert.exited, clock.sleep(killGraceMs)]);
        certConfirmed = exitedNow;
      }
      if (certConfirmed) { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(recordFile, { force: true }); }
      else {
        for (const entry of fs.readdirSync(dir)) if (path.join(dir, entry) !== pendingCert.out) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
      node = null;
      // keepNode tells the caller not to delete the node's directory: a certificate child still holds files there.
      const keep = certConfirmed ? {} : { keepNode: true };
      if (!result.removed) return { ...result, ...keep };
      // Logout removes the node at once. If it failed, the node is still registered until Tailscale drops the ephemeral machine.
      return loggedOut ? { removed: true, ...keep } : { ...keep, removed: false, detail: `the trial's Tailscale node ${hostname} could not be logged out. It is ephemeral, so Tailscale removes it on its own once offline; to remove it now, delete ${hostname} in the Tailscale admin console` };
    },
  };
}

// ---- localhost.run (the trial route) -------------------------------------------------------------------------------------
// An anonymous SSH reverse tunnel: `ssh -R 80:127.0.0.1:<gate> nokey@localhost.run`. No account, no download (ssh ships with macOS and
// Linux). The relay ends TLS, so it can see the traffic, and its free address changes within hours. Both facts are told to the owner
// before the URL is shown. A changed address cannot keep the OAuth identity, so the trial stops instead of restarting.
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
export function gozarProvider({ env = process.env, which = name => whichOnPath(name, env), run = execFile, pollMs = 3000 } = {}) {
  let binary = null, port = null, sessionId = null;
  let watching = false, timer = null, wakeWatcher = () => {}, watcher = Promise.resolve();
  const command = (args, { status = false } = {}) => new Promise((resolve, reject) => {
    run(binary, args, { env, encoding: 'utf8', timeout: status ? 15_000 : 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
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
    (snapshot.phase === 'stopped' || (snapshot.phase === 'unknown' && Array.isArray(snapshot.limitations) && snapshot.limitations.some(line => typeof line === 'string' && /^Controller unavailable:/.test(line))));
  const stopWatcher = async () => {
    watching = false;
    clearTimeout(timer);
    wakeWatcher();
    await watcher;
  };
  return {
    name: 'gozar',
    probe() {
      binary = which('gozar');
      if (!binary && env.GOZAR_BIN) {
        try { fs.accessSync(env.GOZAR_BIN, fs.constants.X_OK); binary = env.GOZAR_BIN; } catch { /* unavailable */ }
      }
      return binary ? { ok: true } : { ok: false, line: 'Gozar is not installed', fix: 'Install gozar on PATH or set GOZAR_BIN to its executable path.' };
    },
    async start({ gatePort, signal }) {
      signal?.throwIfAborted();
      if (!binary) throw new Error('gozar: probe() must succeed before start()');
      if (!Number.isInteger(gatePort) || gatePort < 1 || gatePort > 65535) throw new Error('the local gate port is not valid');
      // Expose silently reuses an existing controller. Refuse it before acquiring any cleanup responsibility.
      const before = await status(gatePort);
      if (!removed(before.snapshot)) throw new Error(`port ${gatePort} already has a Gozar route; stop it first: gozar stop --port ${gatePort}`);
      signal?.throwIfAborted();
      port = gatePort;
      // Pin the trial adapter; never let auto recommendation select the machine's Tailscale.
      // Let expose settle before cleanup: it starts a background controller even if the caller cancels.
      let reply;
      try { reply = await command(['expose', '--port', String(port), '--client-reach', 'internet', '--yes', '--json', '--transport', 'https', '--sse', '--adapter', 'localhost-run']); }
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
          } catch { /* Unobservable readiness cannot keep the trial alive. */ }
          if (watching) ended();
          break;
        }
      })();
      return { origin, exited };
    },
    async stop() {
      await stopWatcher();
      if (port === null) return { removed: true };
      const cleanupCommand = `gozar stop --port ${port}`;
      try {
        const current = (await status(port)).snapshot;
        if (removed(current) || (sessionId && current?.sessionId && current.sessionId !== sessionId)) {
          port = null; sessionId = null;
          return { removed: true };
        }
        // Without the expose receipt, or after controller identity is lost, port-only stop is unsafe.
        if (!sessionId || current?.sessionId !== sessionId) throw new Error('Gozar session ownership could not be confirmed; leaving the route untouched');
        const reply = await command(['stop', '--port', String(port), '--json']);
        if (!removed(reply.snapshot) || reply.localCleanupFailures?.length) throw new Error('Gozar route cleanup is unconfirmed');
        port = null; sessionId = null;
        return { removed: true };
      } catch (error) { return { removed: false, detail: error.message, command: cleanupCommand }; }
    },
  };
}

// ---- choosing a route --------------------------------------------------------------------------------------------------
// `localhost.run` is the trial route (anonymous, automatic). `tailscale` is the real route: this computer's Tailscale on :443 when no
// rule uses it, else a Tailscale node of the trial's own. An explicit route shows its own failure and never falls back to the other:
// a real route never becomes a trial link without the owner choosing it. A rule that already holds 443 is never changed.
export async function startRoute({ route = 'localhost.run', providers, gatePort, home, say, signal }) {
  const named = name => providers.find(p => p.name === name);
  // A start that fails is cleaned up before anything else happens, so a failed route never leaves a rule, node or process behind.
  const attempt = async provider => {
    signal?.throwIfAborted();
    try {
      const started = await provider.start({ gatePort, home, say, signal });
      return { provider, origin: started.origin, exited: started.exited, stop: () => provider.stop() };
    } catch (error) {
      const cleaned = await provider.stop().catch(e => ({ removed: false, detail: e.message }));
      if (!cleaned.removed) throw Object.assign(new Error(`${provider.name} failed (${error.message}) and could not be removed: ${cleaned.detail}${cleaned.command ? `\nRemove it with:\n  ${cleaned.command}` : ''}`), { cleanupFailed: true });
      throw error;
    }
  };
  signal?.throwIfAborted();
  if (route === 'localhost.run' || route === 'gozar') {
    const provider = named(route), probe = provider.probe();
    if (!probe.ok) throw new Error(probe.fix);
    return attempt(provider);
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
  return attempt(choice);
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
    if (challenge.status !== 401 || !/^Bearer/i.test(challenge.headers.get('www-authenticate') ?? '')) return `an unauthenticated MCP request returned HTTP ${challenge.status}, not an OAuth challenge`;
    for (const owner of ['/admin', '/connect/pending', '/connect/list']) {
      const res = await fetchImpl(`${origin}${owner}`, { redirect: 'manual', signal: within(10_000) });
      if (res.status === 200) return `${owner} answers on the public address`;
    }
    return null;
  };
  const end = clock.now() + timeoutMs;
  let last = 'no answer yet', nextSay = clock.now() + 15_000;
  for (;;) {
    signal?.throwIfAborted();
    try { last = await check(); if (last === null) return { ready: true }; }
    catch (error) { if (signal?.aborted) throw error; last = safeDiagnostic(error.cause?.code ?? error.message, 120); }
    if (clock.now() >= end) return { ready: false, last };
    if (clock.now() >= nextSay) { say(`Still waiting for the public address to answer (${last})…`); nextSay += 15_000; }
    await raceAbort(clock.sleep(2000), signal);
  }
}
