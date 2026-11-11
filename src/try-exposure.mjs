// The public route for `dalan try --public`: a loopback gate the route forwards to, a ready Tailscale Funnel when one works, and
// otherwise a Cloudflare Quick Tunnel through a pinned, checksum-verified `cloudflared`. Every process, file and rule here is
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
export const PUBLIC_READY_MS = { tailscale: 120_000, 'tailscale-node': 120_000, cloudflare: 60_000 };

// ---- the gate ----------------------------------------------------------------------------------------------------------
// The route forwards to this listener, never to the bridge. A Quick Tunnel reports its address only after it starts, and the
// bridge needs that address at `init`, so the route must exist first. The gate answers 503 until the bridge is up, forwards to the
// one bridge port after that, and answers 503 again once closed. Nothing else on the computer is ever reachable through the route.
export async function createGate() {
  let upstream = null;
  // A fresh connection per request: a kept-alive socket that the bridge closed in the meantime would fail the next request with a 502
  // that the bridge never sees.
  const agent = new http.Agent({ keepAlive: false });
  const server = http.createServer((req, res) => {
    if (!upstream) { res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' }); res.end('starting\n'); return; }
    const forward = http.request({ agent, host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers: req.headers }, answer => {
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
    open(port) { upstream = port; },
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

// One line for the first thing that stops Funnel, plus the owner's own fix. `auto` mode prints only `line` and uses Cloudflare.
export function explainTailscale(error) {
  const text = String(error?.message ?? error);
  const first = (line, fix) => ({ line, fix: fix ?? line });
  if (/not installed|ENOENT/.test(text)) return first('Tailscale is not installed; using a temporary Cloudflare route.', 'Install Tailscale from https://tailscale.com/download, run `tailscale up`, then retry.');
  if (/not running or not logged in/.test(text)) return first('Tailscale is not connected; using Cloudflare. To reconnect Tailscale later, run: tailscale up', 'Run `tailscale up`, then retry.');
  if (/MagicDNS/.test(text)) return first('MagicDNS is off; using Cloudflare.', `Enable MagicDNS at ${ADMIN_DNS_URL}, then retry.`);
  if (/HTTPS certificates/.test(text)) return first('Tailscale HTTPS is off; using Cloudflare.', `Enable HTTPS Certificates at ${ADMIN_DNS_URL} (it publishes your machine names on a public ledger), then retry.`);
  if (/Funnel is not allowed/.test(text)) return first('Funnel is not allowed for this tailnet; using Cloudflare.', `A tailnet administrator can enable Funnel at ${ADMIN_ACL_URL}, then retry.`);
  if (/no free Funnel port/.test(text)) return first('All permitted Funnel ports are occupied; using Cloudflare. Existing routes are unchanged.', 'Free one Funnel port (tailscale funnel status), then retry.');
  const port = /--funnel-port (\d+) is (?:already used|not allowed)/.exec(text)?.[1];
  if (port) return { ...first(`Tailscale port ${port} is not free for Funnel on this computer; its rules are unchanged.`, `Free Funnel port ${port} (tailscale funnel status shows what uses it), or use --route cloudflare.`), busy: /already used/.test(text) };
  if (/macOS: the Tailscale/.test(text)) return first('The Tailscale app on this Mac cannot serve Funnel here; using Cloudflare.', text.split('\n')[0]);
  const line = safeDiagnostic(text.split('\n')[0], 160);
  return first(`Tailscale Funnel is not usable (${line}); using Cloudflare.`, line);
}

// WHY 443 ONLY: a trial always publishes on public port 443, for every client. On 2026-11-10 claude.ai could not reach a Funnel on
// 8443 ("Couldn't reach this address") but did reach 443, so a Funnel on any other port is not a working route. When this
// computer's Tailscale already has a rule on 443 (it is never changed), the trial uses its own Tailscale node instead
// (`tailscaleNodeProvider`), and Cloudflare after that.
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
// The command line of a process, or null. `ps` exists on Linux and macOS; /proc does not exist on macOS.
export const processCommand = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
};
const defaultRegistry = env => path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'dalan', 'trial-nodes');
// A key, a login link or a node key never reaches the daemon log.
export const maskNodeText = text => String(text).replace(/tskey-[A-Za-z0-9_-]+/g, '[key]').replace(/https:\/\/login\.tailscale\.com\/\S+/g, '[login link]').replace(/(nodekey|authkey)\S*/gi, '[secret]');

// Device and tailnet names identify the owner's tailnet. A kept log or a printed line carries neither: any *.ts.net name, the
// node's own DNS name and the tailnet's name (which can be an email address) become "[tailnet name]".
export const redactTailnetNames = (text, names = []) => {
  let out = String(text).replace(/[A-Za-z0-9][A-Za-z0-9.-]*\.ts\.net\b/gi, '[tailnet name]');
  for (const name of names.filter(n => n.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(name).join('[tailnet name]');
  return out;
};

// Ends the daemons of trials that no longer run. A record is stale when its trial process is gone (or its PID now runs something
// else); the daemon is ended only if its command line still names the socket this trial started it with.
export async function sweepTrialNodes({ registry, processCmd = processCommand, kill = (pid, sig) => process.kill(pid, sig), clock = { sleep } }) {
  let names = []; try { names = fs.readdirSync(registry).filter(n => n.endsWith('.json')); } catch { return []; }
  const ended = [];
  for (const name of names) {
    const file = path.join(registry, name);
    let rec; try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fs.rmSync(file, { force: true }); continue; }
    if (Number.isInteger(rec.owner) && rec.owner !== process.pid && rec.ownerCmd && processCmd(rec.owner) === rec.ownerCmd) continue; // its trial still runs
    if (Number.isInteger(rec.pid) && rec.sock && processCmd(rec.pid)?.includes(rec.sock)) {
      try { kill(rec.pid, 'SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 20 && processCmd(rec.pid)?.includes(rec.sock); i++) await clock.sleep(100);
      if (processCmd(rec.pid)?.includes(rec.sock)) { try { kill(rec.pid, 'SIGKILL'); } catch { /* gone */ } }
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
      if (!which('tailscaled') || !which('tailscale')) return { ok: false, line: 'tailscaled is not installed, so a separate Tailscale node cannot be started; using Cloudflare.', fix: 'Install Tailscale (it includes tailscaled) from https://tailscale.com/download, or free Funnel port 443 on this computer.' };
      return { ok: true };
    },
    recover: () => sweepTrialNodes({ registry, processCmd, clock }),
    async start({ gatePort, home, say = () => {}, signal }) {
      signal?.throwIfAborted();
      await sweepTrialNodes({ registry, processCmd, clock });
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
      const writeRecord = pid => fs.writeFileSync(recordFile, JSON.stringify({ dir, sock, hostname, pid, home, owner: process.pid, ownerCmd: processCmd(process.pid), created_at: new Date().toISOString() }), { mode: 0o600 });
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
      let dnsName = '', tailnet = '';
      try { const status = JSON.parse(node.run(['status', '--json']).stdout || '{}'); dnsName = String(status.Self?.DNSName ?? '').replace(/\.$/, ''); tailnet = String(status.CurrentTailnet?.Name ?? ''); } catch { /* no status */ }
      const redact = text => redactTailnetNames(text, [dnsName, tailnet]);
      let verdict;
      if (!dnsName) verdict = 'error (the node has no DNS name)';
      else {
        const out = fs.mkdtempSync(path.join(node.dir, 'tlscheck-'));
        let timer = null, child = null;
        try {
          child = spawnChild('tailscale', [`--socket=${node.sock}`, 'cert', `--cert-file=${path.join(out, 'cert')}`, `--key-file=${path.join(out, 'key')}`, dnsName], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
          let said = '';
          for (const stream of [child.stdout, child.stderr]) { stream?.setEncoding?.('utf8'); stream?.on('data', chunk => { if (said.length < 2000) said += chunk; }); }
          const exited = new Promise(resolve => { child.once('exit', code => resolve(code)); child.once('error', () => resolve(-1)); });
          const aborted = new Promise(resolve => { if (signal?.aborted) resolve('aborted'); else signal?.addEventListener('abort', () => resolve('aborted'), { once: true }); });
          const code = await Promise.race([exited, aborted, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), certWaitMs); })]);
          const first = said.split('\n').map(l => l.trim()).find(Boolean);
          verdict = code === 0 ? 'ok' : code === 'aborted' ? 'error (cancelled)' : code === 'timeout' ? `error (no answer in ${Math.round(certWaitMs / 1000)} s)` : `error (${first ? redact(safeDiagnostic(first, 120)) : `exit ${code}`})`;
          // A child that is still running is ended before its files are removed: SIGTERM, then SIGKILL after a short grace.
          if (code === 'aborted' || code === 'timeout') {
            for (const sig of ['SIGTERM', 'SIGKILL']) {
              if (child.exitCode !== null || child.signalCode !== null) break;
              child.kill(sig);
              await Promise.race([exited, clock.sleep(killGraceMs)]);
            }
          }
        } catch (error) { verdict = `error (${redact(safeDiagnostic(error.message, 120))})`; }
        finally {
          clearTimeout(timer);
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          fs.rmSync(out, { recursive: true, force: true });
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
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(recordFile, { force: true });
      node = null;
      if (!result.removed) return result;
      // Logout removes the node at once. If it failed, the node is still registered until Tailscale drops the ephemeral machine.
      return loggedOut ? { removed: true } : { removed: false, detail: `the trial's Tailscale node ${hostname} could not be logged out. It is ephemeral, so Tailscale removes it on its own once offline; to remove it now, delete ${hostname} in the Tailscale admin console` };
    },
  };
}

// ---- Cloudflare Quick Tunnel -------------------------------------------------------------------------------------------
// The helper is a release-pinned download. Each asset's SHA-256 is the digest GitHub shows for the release asset (and matches
// the downloaded bytes). Nothing is executed before its hash matches. Update by re-reading the digests of a newer release:
//   gh api repos/cloudflare/cloudflared/releases/tags/<tag> --jq '.assets[] | {name, digest}'
export const CLOUDFLARED = Object.freeze({
  version: '2026.10.7',
  base: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/',
  assets: Object.freeze({
    'linux-x64': { name: 'cloudflared-linux-amd64', sha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872' },
    'linux-arm64': { name: 'cloudflared-linux-arm64', sha256: '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775' },
    'darwin-x64': { name: 'cloudflared-darwin-amd64.tgz', sha256: '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848', archive: true },
    'darwin-arm64': { name: 'cloudflared-darwin-arm64.tgz', sha256: '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd', archive: true },
  }),
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export class HelperError extends Error { constructor(message, code) { super(message); this.code = code; } }

const defaultExtract = (archive, dir) => new Promise((resolve, reject) => execFile('tar', ['-xzf', archive, '-C', dir], { timeout: 60_000 }, error => error ? reject(error) : resolve()));
const defaultDownload = async (url, { signal } = {}) => {
  const res = await fetch(url, { redirect: 'follow', signal: signal ? AbortSignal.any([AbortSignal.timeout(120_000), signal]) : AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

// A `cloudflared` already on PATH is used as is. Otherwise the pinned download is cached in the user's cache directory and
// checked again against its recorded hash on every reuse.
export async function ensureCloudflared({ env = process.env, platform = process.platform, arch = process.arch, manifest = CLOUDFLARED, cacheRoot, download = defaultDownload, extract = defaultExtract, which = name => whichOnPath(name, env), say = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  const onPath = which('cloudflared');
  if (onPath) return { bin: onPath, source: 'path' };
  const asset = manifest.assets[`${platform}-${arch}`];
  if (!asset) throw new HelperError(`The tunnel helper could not be verified for this computer (${platform}/${arch} has no pinned build); public setup stopped. Use --local, or run on Linux or macOS with a ready Tailscale Funnel.`, 'unsupported');
  const root = cacheRoot ?? path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'dalan', 'cloudflared', manifest.version);
  const bin = path.join(root, 'cloudflared'), marker = `${bin}.sha256`;
  const executable = () => { try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch { return false; } };
  if (executable() && fs.existsSync(marker) && sha256(fs.readFileSync(bin)) === fs.readFileSync(marker, 'utf8').trim()) return { bin, source: 'cache' };
  say('Downloading the verified tunnel helper for this computer…');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(root, 'dl-'));
  try {
    let bytes;
    try { bytes = await download(`${manifest.base}${asset.name}`, { signal }); }
    catch (error) {
      if (signal?.aborted) throw error;
      const brew = platform === 'darwin' && which('brew') ? ' Install it with: brew install cloudflared' : '';
      throw new HelperError(`Tunnel-helper download failed (${safeDiagnostic(error.message, 120)}).${brew}`, 'download');
    }
    if (sha256(bytes) !== asset.sha256) throw new HelperError('The tunnel helper could not be verified for this computer (its checksum did not match the pinned value); public setup stopped. Nothing was run.', 'checksum');
    let file = path.join(work, asset.name);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    if (asset.archive) {
      signal?.throwIfAborted();
      await extract(file, work);
      file = path.join(work, 'cloudflared');
      if (!fs.existsSync(file)) throw new HelperError('The tunnel helper archive did not contain cloudflared; public setup stopped.', 'archive');
    }
    fs.chmodSync(file, 0o700);
    const digest = sha256(fs.readFileSync(file));
    fs.renameSync(file, bin);
    fs.writeFileSync(marker, `${digest}\n`, { mode: 0o600 });
    return { bin, source: 'download' };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

export const QUICK_TUNNEL_HOST = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com\b/;

// The tunnel's public origin from one line of its output, or null. `api.trycloudflare.com` is Cloudflare's own API, named in errors.
export function parseQuickTunnelOrigin(line) {
  const match = QUICK_TUNNEL_HOST.exec(line);
  return match && match[1] !== 'api' ? `https://${match[1]}.trycloudflare.com` : null;
}

export function cloudflareProvider({ env = process.env, platform = process.platform, arch = process.arch, spawnChild = spawn, ensure = ensureCloudflared, clock = { sleep }, say = () => {}, startMs = 60_000, ...helperDeps } = {}) {
  let child = null;
  return {
    name: 'cloudflare',
    probe: () => ({ ok: true }),
    async start({ gatePort, home, signal }) {
      const { bin } = await ensure({ env, platform, arch, say, signal, ...helperDeps });
      signal?.throwIfAborted();
      // An existing named-tunnel configuration must not change this tunnel's target: the helper sees an empty home and config.
      const isolated = path.join(home, 'cloudflared');
      fs.mkdirSync(isolated, { recursive: true, mode: 0o700 });
      const config = path.join(isolated, 'config.yml');
      fs.writeFileSync(config, '', { mode: 0o600 });
      const childEnv = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter(k => env[k] !== undefined).map(k => [k, env[k]]));
      child = spawnChild(bin, ['tunnel', '--config', config, '--no-autoupdate', '--url', `http://127.0.0.1:${gatePort}`], { env: { ...childEnv, HOME: isolated }, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      const origin = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cloudflared did not report a public address in time')), startMs);
        const onAbort = () => reject(abortReason(signal));
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        let tail = '';
        const finish = fn => value => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value); };
        const found = finish(resolve);
        const onLine = line => { tail = `${tail}${line}\n`.slice(-4000); const origin = parseQuickTunnelOrigin(line); if (origin) found(origin); };
        const sinks = [child.stdout, child.stderr].map(stream => { const buffer = lineBuffer(onLine); stream?.setEncoding?.('utf8'); stream?.on('data', buffer); stream?.on('end', () => buffer.end()); return buffer; });
        exited.then(() => { for (const sink of sinks) sink.end(); finish(reject)(new Error(`cloudflared exited before the tunnel was ready: ${safeDiagnostic(tail.trim().split('\n').slice(-2).join(' '), 200)}`)); });
      });
      return { origin, exited };
    },
    // Only the process this trial started, by its handle; never a PID looked up by name.
    async stop() {
      if (!child) return { removed: true };
      if (child.exitCode === null && child.signalCode === null) {
        const gone = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([gone, clock.sleep(5000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([gone, clock.sleep(2000)]); }
      }
      return child.exitCode !== null || child.signalCode !== null ? { removed: true } : { removed: false, detail: 'the cloudflared process did not exit', command: `kill ${child.pid}` };
    },
  };
}

// ---- choosing a route --------------------------------------------------------------------------------------------------
// `auto`: a ready Funnel, else a Quick Tunnel. An explicit route shows its own failure and never falls back. Returns the started
// route with its provider name; the caller owns `stop()`.
// Route choice, in order: this computer's Tailscale on :443 when no rule uses it; else a Tailscale node of the trial's own; else
// Cloudflare. `tailscale` allows only the first two. A rule that already holds 443 is never changed.
export async function startRoute({ route = 'auto', providers, gatePort, home, say, signal }) {
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
  if (route === 'cloudflare') return attempt(named('cloudflare'));
  const host = named('tailscale').probe();
  let choice = null, why = host.fix;
  if (host.ok) choice = named('tailscale');
  else if (host.busy && named('tailscale-node')) {
    const node = named('tailscale-node').probe();
    if (node.ok) { say(`${host.line} Starting a separate Tailscale node for this trial.`); choice = named('tailscale-node'); }
    else { say(host.line); why = `${host.fix} (${node.fix})`; }
  } else say(host.line);
  if (route === 'tailscale') {
    if (!choice) throw new Error(why);
    return attempt(choice);
  }
  if (choice) {
    try { return await attempt(choice); }
    catch (error) {
      if (error.cleanupFailed || signal?.aborted) throw error; // a stop request is never answered by trying another route
      say(`Tailscale did not start (${safeDiagnostic(error.message, 120)}); using a temporary Cloudflare route.`);
    }
  }
  return attempt(named('cloudflare'));
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
    if (!Array.isArray(doc.authorization_servers) || !doc.authorization_servers.every(s => String(s).startsWith(`${origin}/`))) return 'discovery names a different issuer';
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
