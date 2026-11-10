// The public route for `dalan try --public`: a loopback gate the route forwards to, a ready Tailscale Funnel when one works, and
// otherwise a Cloudflare Quick Tunnel through a pinned, checksum-verified `cloudflared`. Every process, file and rule here is
// owned by one trial and removed by `stop()`. Every outside effect goes through a seam in `deps` so tests need no real route.
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const PROBE_TIMEOUT_MS = 10_000;
export const PUBLIC_READY_MS = { tailscale: 120_000, cloudflare: 60_000 };

// ---- the gate ----------------------------------------------------------------------------------------------------------
// The route forwards to this listener, never to the bridge. A Quick Tunnel reports its address only after it starts, and the
// bridge needs that address at `init`, so the route must exist first. The gate answers 503 until the bridge is up, forwards to the
// one bridge port after that, and answers 503 again once closed. Nothing else on the computer is ever reachable through the route.
export async function createGate() {
  let upstream = null;
  const server = http.createServer((req, res) => {
    if (!upstream) { res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '2' }); res.end('starting\n'); return; }
    const forward = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers: req.headers }, answer => {
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
  if (/macOS: the Tailscale/.test(text)) return first('The Tailscale app on this Mac cannot serve Funnel here; using Cloudflare.', text.split('\n')[0]);
  const line = safeDiagnostic(text.split('\n')[0], 160);
  return first(`Tailscale Funnel is not usable (${line}); using Cloudflare.`, line);
}

export function tailscaleProvider({ tailscale = tailscaleRunner(), env = process.env, platform = process.platform, spawnChild = spawn, clock = { sleep }, which = name => whichOnPath(name, env) } = {}) {
  let plan = null, child = null, record = null, rule = null;
  return {
    name: 'tailscale',
    // Read-only: inspects the daemon, DNS identity, capabilities and the ports other rules already use.
    probe() {
      if (!which('tailscale')) return { ok: false, ...explainTailscale(new Error('Tailscale is not installed')) };
      try {
        const state = preflight({ tailscale, platform });
        const port = choosePort({ allowed: state.allowed, occupied: state.occupied });
        plan = { dnsName: state.dnsName, port, origin: publicUrl(state.dnsName, port) };
        return { ok: true, origin: plan.origin };
      } catch (error) { return { ok: false, ...explainTailscale(error) }; }
    },
    // A foreground rule on a free port, exactly ours: it is removed by Tailscale itself when the child ends, and again by `stop`.
    async start({ gatePort, home }) {
      if (!plan) throw new Error('tailscale: probe() must succeed before start()');
      // Re-read just before applying: a port another rule took since the probe is not ours to share.
      const again = preflight({ tailscale, platform });
      if (again.occupied.has(plan.port)) throw new Error(`Funnel port ${plan.port} was taken by another rule after the check; its rule is unchanged`);
      record = recordPath(home, 'trial');
      recoverStaleFunnel(home, tailscale);
      writeExposureRecord({ file: record, worker: 'trial', dnsName: plan.dnsName, port: plan.port, localPort: gatePort, url: plan.origin });
      rule = { dnsName: plan.dnsName, port: plan.port, gatePort };
      child = spawnChild('tailscale', funnelOnArgs(plan.port, gatePort).filter(arg => arg !== '--bg'), { env, stdio: 'ignore' });
      const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      for (let waited = 0; ; waited += 500) {
        const status = JSON.parse(tailscale(funnelStatusArgs()).stdout || '{}');
        if (funnelRuleMatches(status, plan.dnsName, plan.port, gatePort)) break;
        if (waited >= 20_000 || child.exitCode !== null) throw new Error('tailscale funnel did not publish the rule');
        await clock.sleep(500);
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
function recoverStaleFunnel(home, tailscale) {
  const file = recordPath(home, 'trial');
  if (fs.existsSync(file)) removeExposure({ tailscale, file, log: () => {} });
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
const defaultDownload = async url => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

// A `cloudflared` already on PATH is used as is. Otherwise the pinned download is cached in the user's cache directory and
// checked again against its recorded hash on every reuse.
export async function ensureCloudflared({ env = process.env, platform = process.platform, arch = process.arch, manifest = CLOUDFLARED, cacheRoot, download = defaultDownload, extract = defaultExtract, which = name => whichOnPath(name, env), say = () => {} } = {}) {
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
    try { bytes = await download(`${manifest.base}${asset.name}`); }
    catch (error) {
      const brew = platform === 'darwin' && which('brew') ? ' Install it with: brew install cloudflared' : '';
      throw new HelperError(`Tunnel-helper download failed (${safeDiagnostic(error.message, 120)}).${brew}`, 'download');
    }
    if (sha256(bytes) !== asset.sha256) throw new HelperError('The tunnel helper could not be verified for this computer (its checksum did not match the pinned value); public setup stopped. Nothing was run.', 'checksum');
    let file = path.join(work, asset.name);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    if (asset.archive) {
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
    async start({ gatePort, home }) {
      const { bin } = await ensure({ env, platform, arch, say, ...helperDeps });
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
        let tail = '';
        const onData = chunk => {
          tail = (tail + chunk).slice(-4000);
          for (const line of String(chunk).split('\n')) { const found = parseQuickTunnelOrigin(line); if (found) { clearTimeout(timer); resolve(found); return; } }
        };
        for (const stream of [child.stdout, child.stderr]) stream?.setEncoding?.('utf8'), stream?.on('data', onData);
        exited.then(() => { clearTimeout(timer); reject(new Error(`cloudflared exited before the tunnel was ready: ${safeDiagnostic(tail.trim().split('\n').slice(-2).join(' '), 200)}`)); });
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
export async function startRoute({ route = 'auto', providers, gatePort, home, say }) {
  const attempt = async provider => {
    const started = await provider.start({ gatePort, home });
    return { provider, origin: started.origin, exited: started.exited, stop: () => provider.stop() };
  };
  const named = name => providers.find(p => p.name === name);
  if (route === 'cloudflare') return attempt(named('cloudflare'));
  const funnel = named('tailscale').probe();
  if (route === 'tailscale') {
    if (!funnel.ok) throw new Error(funnel.fix);
    return attempt(named('tailscale'));
  }
  if (funnel.ok) {
    try { return await attempt(named('tailscale')); }
    catch (error) {
      const cleaned = await named('tailscale').stop();
      if (!cleaned.removed) throw new Error(`Tailscale Funnel failed (${error.message}) and its rule could not be removed: ${cleaned.detail}\nRemove it with:\n  ${cleaned.command}`);
      say(`Tailscale Funnel did not start (${safeDiagnostic(error.message, 120)}); using a temporary Cloudflare route.`);
    }
  } else say(funnel.line);
  return attempt(named('cloudflare'));
}

// ---- readiness ---------------------------------------------------------------------------------------------------------
// The public address answers as this bridge: trusted TLS (the platform's fetch checks it), discovery that names this origin and
// resource, an OAuth challenge on an unauthenticated MCP request, and no owner route. The secret path is known only to this bridge,
// so a matching discovery document also shows that the route reaches it and not another program.
export async function verifyPublicReady({ origin, secret, fetchImpl = fetch, clock = { now: Date.now, sleep }, timeoutMs, say = () => {} }) {
  const resource = `${origin}/${secret}/mcp`;
  const check = async () => {
    const meta = await fetchImpl(`${origin}/.well-known/oauth-protected-resource/${secret}/mcp`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (meta.status !== 200) return `discovery returned HTTP ${meta.status}`;
    const doc = await meta.json().catch(() => null);
    if (doc?.resource !== resource) return 'discovery names a different resource';
    if (!Array.isArray(doc.authorization_servers) || !doc.authorization_servers.every(s => String(s).startsWith(`${origin}/`))) return 'discovery names a different issuer';
    const challenge = await fetchImpl(resource, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}', signal: AbortSignal.timeout(10_000) });
    if (challenge.status !== 401 || !/^Bearer/i.test(challenge.headers.get('www-authenticate') ?? '')) return `an unauthenticated MCP request returned HTTP ${challenge.status}, not an OAuth challenge`;
    for (const owner of ['/admin', '/connect/pending', '/connect/list']) {
      const res = await fetchImpl(`${origin}${owner}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) return `${owner} answers on the public address`;
    }
    return null;
  };
  const end = clock.now() + timeoutMs;
  let last = 'no answer yet', nextSay = clock.now() + 15_000;
  for (;;) {
    try { last = await check(); if (last === null) return { ready: true }; }
    catch (error) { last = safeDiagnostic(error.cause?.code ?? error.message, 120); }
    if (clock.now() >= end) return { ready: false, last };
    if (clock.now() >= nextSay) { say(`Still waiting for the public address to answer (${last})…`); nextSay += 15_000; }
    await clock.sleep(2000);
  }
}
