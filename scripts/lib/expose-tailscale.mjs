// Public exposure for a worker bridge: Tailscale Funnel (preflight, port choice, the funnel rule, public verification,
// removal) and the ngrok fallback (config file and printed commands only; this code never runs ngrok).
// Used by scripts/worker-bridge-setup.mjs --expose tailscale|ngrok. Nothing here changes a serve or funnel rule that already
// exists. The only Tailscale mutation is our own rule on our own port.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Resolver } from 'node:dns/promises';

// Public ports Tailscale Funnel accepts, in the order we prefer them.
// Source: https://tailscale.com/kb/1223/funnel ("443, 8443, and 10000").
export const FUNNEL_PORTS = [443, 8443, 10000];
// Admin pages. Host verified this session: https://tailscale.com/kb/1223/funnel and https://tailscale.com/kb/1153/enabling-https
// both name console.tailscale.com. Brief: "use whichever host the docs currently give".
export const ADMIN_DNS_URL = 'https://console.tailscale.com/admin/dns';
export const ADMIN_ACL_URL = 'https://console.tailscale.com/admin/acls';
export const INSTALL_URL = 'https://tailscale.com/download';
export const HTTPS_DOC_URL = 'https://tailscale.com/kb/1153/enabling-https';
export const FUNNEL_DOC_URL = 'https://tailscale.com/kb/1223/funnel';
export const MACOS_VARIANTS_DOC_URL = 'https://tailscale.com/docs/concepts/macos-variants';
const DEFAULT_TIMEOUT_MS = 20_000;
const refuseOverwrite = message => { throw Object.assign(new Error(message), { name: 'SetupRefusal', code: 'SETUP_REFUSED' }); };

// Public DNS: up to 10 minutes is normal (first Funnel certificate). Progress every 30 s.
export const DNS_WAIT_MS = 600_000;
export const DNS_PROGRESS_MS = 30_000;

// ngrok: free-plan limits from https://ngrok.com/docs/pricing-limits/free-plan-limits (20,000 HTTP requests/month, 1 GB egress/month).
export const NGROK_FREE_PLAN_URL = 'https://ngrok.com/docs/pricing-limits/free-plan-limits';
export const NGROK_QUOTA_WARNING = `ngrok free plan quota (${NGROK_FREE_PLAN_URL}): 20,000 HTTP requests per month and 1 GB egress per month. `
  + 'A 60 s wake hook alone makes about 43,000 requests per month. Set the hook poll interval to 300 s or more with ngrok. '
  + 'Rejecting fast polls on the bridge would still count them against the quota, so the interval has to be set in the hook.';
export const WAKE_POLL_SECONDS = 60;
export const WAKE_POLL_SECONDS_NGROK = 300;

const MACOS_APP = '/Applications/Tailscale.app';

// The wake-hook poll interval for this home: 300 s when any recorded exposure is ngrok, else 60 s.
export function pollIntervalSeconds(records) {
  return records.some(r => r.mode === 'ngrok') ? WAKE_POLL_SECONDS_NGROK : WAKE_POLL_SECONDS;
}

// Reads every dot-bridge-<worker>.exposure.json in a bridge home. Missing home or no records gives [].
export function readExposureRecords(home, { readdir = fs.readdirSync, read = fs.readFileSync } = {}) {
  let names;
  try { names = readdir(home); } catch { return []; }
  return names.filter(n => /^dot-bridge-.+\.exposure\.json$/.test(n))
    .map(n => JSON.parse(read(path.join(home, n), 'utf8')));
}

export function enableMagicDnsMessage() {
  return `MagicDNS is off for this tailnet. Turn it on at ${ADMIN_DNS_URL} (the DNS page, MagicDNS), then retry. Doc: ${HTTPS_DOC_URL} (step 2).`;
}

// The doc says enabling HTTPS publishes machine names and the tailnet DNS name on a public ledger. Say so before the owner clicks.
export function enableHttpsMessage() {
  return `HTTPS certificates are off for this tailnet. Turn them on at ${ADMIN_DNS_URL} (HTTPS Certificates: Enable HTTPS). `
    + `Tailscale publishes your machine names and tailnet DNS name on a public ledger when you do; accept that or do not enable Funnel. Then retry. Doc: ${HTTPS_DOC_URL}.`;
}

export function enableFunnelMessage() {
  return `Funnel is not allowed for this tailnet. Add the funnel node attribute at ${ADMIN_ACL_URL} (Access controls, Funnel section, "Add Funnel to policy"), then retry. Doc: ${FUNNEL_DOC_URL}.`;
}

export function macConflictMessage(label) {
  return `macOS: the Tailscale ${label} is installed and its CLI is the \`tailscale\` on PATH. Funnel is not supported by the App Store app or the Standalone app; only the open-source tailscaled supports it (${MACOS_VARIANTS_DOC_URL}). The app and the open-source daemon conflict. Nothing was changed.\n`
    + 'Either:\n'
    + '  1. Quit Tailscale from the menu bar, then uninstall the app (Standalone: move /Applications/Tailscale.app to the Trash; App Store: delete it from Launchpad). Then run:\n'
    + '       brew install tailscale && sudo brew services start tailscale && sudo tailscale up\n'
    + '     and retry this command.\n'
    + '  2. Or use the ngrok fallback instead: --expose ngrok --ngrok-domain <assigned-domain>';
}

const notInstalled = () => new Error(`Tailscale is not installed. Install it from ${INSTALL_URL}, then run \`tailscale up\` and retry.`);
const notRunning = () => new Error('Tailscale is not running or not logged in. Run `tailscale up` and retry.');

// Injected by tests through PATH only; the real binary is never named here except as the PATH lookup.
export function defaultTailscale(args) {
  return spawnSync('tailscale', args, { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
}

// First executable named `name` on PATH, or null.
export function whichOnPath(name, env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

// macOS variant check (darwin only). Detects the App Store or Standalone app at /Applications/Tailscale.app.
// It is in use when the `tailscale` on PATH resolves into that bundle. The open-source tailscaled (Homebrew) on PATH is fine.
// Everything is injected so tests can use fake paths. Returns null off macOS or when the app is not installed.
// The App Store label relies on the _MASReceipt directory (the usual App Store receipt location). Assumed, not doc-verified.
export function macVariantCheck({
  platform = process.platform, exists = fs.existsSync, realpath = fs.realpathSync, which = name => whichOnPath(name),
} = {}) {
  if (platform !== 'darwin' || !exists(MACOS_APP)) return null;
  const label = exists(path.join(MACOS_APP, 'Contents/_MASReceipt/receipt')) ? 'App Store app' : 'Standalone app';
  const cli = which('tailscale');
  let real = null;
  if (cli) { try { real = realpath(cli); } catch { real = cli; } }
  if (real && real.startsWith(`${MACOS_APP}/`)) return { label, inUse: true, cli: real };
  return { label, inUse: false, cli: real, warning: `the Tailscale ${label} is installed, but the \`tailscale\` on PATH is not its CLI (${real ?? 'not found'}); continuing with that one. If the app's daemon is also running, the two will conflict: ${MACOS_VARIANTS_DOC_URL}` };
}

function parseJsonOutput(result, label) {
  const text = (result.stdout ?? '').trim();
  if (!text.startsWith('{')) {
    if (result.status === 0 && text === '') return {};
    throw new Error(`could not read \`${label}\` output as JSON`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`could not parse \`${label}\` output as JSON`); }
}

function runOrThrow(tailscale, args, label) {
  const r = tailscale(args);
  if (r.error?.code === 'ENOENT') throw notInstalled();
  if (r.error) throw new Error(`\`tailscale ${label}\` failed to start (${r.error.code ?? r.error.message})`);
  if (r.status !== 0) throw new Error(`\`tailscale ${label}\` exited ${r.status ?? r.signal}: ${String(r.stderr ?? '').trim().split('\n').at(-1) ?? ''}`.trimEnd());
  return r;
}

// Ports the cap allows: the query of https://tailscale.com/cap/funnel-ports?ports=443,8443,10000 in Self.CapMap.
export function allowedFunnelPorts(capMap = {}) {
  const ports = new Set();
  for (const key of Object.keys(capMap)) {
    if (!key.startsWith('https://tailscale.com/cap/funnel-ports')) continue;
    for (const p of new URL(key).searchParams.get('ports')?.split(',') ?? []) {
      const n = Number(p);
      if (Number.isInteger(n)) ports.add(n);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

// Ports that serve status already uses: TCP listeners and Web handlers keyed by "name:port".
export function occupiedPorts(serve) {
  const occupied = new Map();
  for (const k of Object.keys(serve.TCP ?? {})) occupied.set(Number(k), `TCP listener on ${k}`);
  for (const k of Object.keys(serve.Web ?? {})) occupied.set(Number(k.split(':').at(-1)), `web rule ${k}`);
  return occupied;
}

// Read-only. Throws with the exact next step for each refusal, in this order: macOS variant, status, MagicDNS, HTTPS, funnel.
// MagicDNS is CurrentTailnet.MagicDNSEnabled (field name observed in `tailscale status --json` on this host).
// HTTPS is the `https` key in Self.CapMap (observed on this host; the HTTPS doc names no field, so this is assumed to track it).
// Funnel is the `funnel` key in Self.CapMap plus the funnel-ports cap (observed on this host).
export function preflight({ tailscale = defaultTailscale, platform = process.platform, mac = {} } = {}) {
  const variant = macVariantCheck({ platform, ...mac });
  if (variant?.inUse) throw new Error(macConflictMessage(variant.label));
  const status = runOrThrow(tailscale, ['status', '--json'], 'status --json');
  const s = parseJsonOutput(status, 'tailscale status --json');
  if (s.BackendState !== 'Running') throw notRunning();
  const dnsName = String(s.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!dnsName) throw new Error('`tailscale status --json` has no Self.DNSName; the node is not fully set up');
  if (s.CurrentTailnet?.MagicDNSEnabled !== true) throw new Error(enableMagicDnsMessage());
  const capMap = s.Self?.CapMap ?? {};
  if (!('https' in capMap)) throw new Error(enableHttpsMessage());
  const allowed = allowedFunnelPorts(capMap);
  if (!('funnel' in capMap) || allowed.length === 0) throw new Error(enableFunnelMessage());
  const serve = parseJsonOutput(runOrThrow(tailscale, ['serve', 'status', '--json'], 'serve status --json'), 'tailscale serve status --json');
  return { dnsName, allowed, occupied: occupiedPorts(serve), warnings: variant?.warning ? [variant.warning] : [] };
}

// --funnel-port must be allowed and free. Without it, the first free allowed port of 443, 8443, 10000.
export function choosePort({ requested, allowed, occupied }) {
  if (requested !== undefined) {
    if (!allowed.includes(requested)) throw new Error(`--funnel-port ${requested} is not allowed for this tailnet (allowed: ${allowed.join(', ')})`);
    if (occupied.has(requested)) throw new Error(`--funnel-port ${requested} is already used (${occupied.get(requested)}). Pick another port; existing rules are never replaced.`);
    return requested;
  }
  const free = FUNNEL_PORTS.find(p => allowed.includes(p) && !occupied.has(p));
  if (free !== undefined) return free;
  const lines = FUNNEL_PORTS.map(p => {
    if (!allowed.includes(p)) return `  ${p}: not allowed by this tailnet`;
    return `  ${p}: ${occupied.get(p) ?? 'free'}`;
  });
  throw new Error(`no free Funnel port (443, 8443, 10000). What occupies each port:\n${lines.join('\n')}\nRemove one of those rules yourself, or pass --funnel-port with a free allowed port.`);
}

export function publicUrl(dnsName, port) {
  return `https://${dnsName}${port === 443 ? '' : `:${port}`}`;
}

export const funnelOnArgs = (port, localPort) => ['funnel', '--bg', `--https=${port}`, `http://127.0.0.1:${localPort}`];
export const funnelOffArgs = port => ['funnel', `--https=${port}`, 'off'];
export const funnelStatusArgs = () => ['funnel', 'status', '--json'];

// True when the funnel status maps exactly our port to our local bridge port, and nothing else on that port.
export function funnelRuleMatches(status, dnsName, port, localPort) {
  const key = `${dnsName}:${port}`;
  const handlers = status.Web?.[key]?.Handlers ?? {};
  return Object.keys(handlers).join(',') === '/'
    && handlers['/'].Proxy === `http://127.0.0.1:${localPort}`
    && status.AllowFunnel?.[key] === true;
}

export function funnelRulePresent(status, dnsName, port) {
  return Object.hasOwn(status.Web ?? {}, `${dnsName}:${port}`);
}

// Public DNS through three resolvers in parallel (one resolver can keep a negative-cached NXDOMAIN for a new name for >10 min).
// Returns the first IPv4 found as { address, server }, or null when none of them has an answer.
export const PUBLIC_DNS_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

export function makePublicResolver(resolvers = defaultResolvers()) {
  return name => new Promise(resolve => {
    let pending = resolvers.length;
    const settle = () => { if (--pending === 0) resolve(null); };
    for (const { server, resolver } of resolvers) {
      resolver.resolve4(name).then(
        addresses => (addresses[0] ? resolve({ address: addresses[0], server }) : settle()),
        settle,
      );
    }
  });
}

function defaultResolvers() {
  return PUBLIC_DNS_SERVERS.map(server => {
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers([server]);
    return { server, resolver };
  });
}

// GET /admin pinned to the address that DNS returned. Expects 404 from the bridge (its unauthenticated path).
export function fetchPinned(url, address, { timeoutMs = 15_000 } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: '/admin', method: 'GET', timeout: timeoutMs,
      // Keep the hostname for SNI and the Host header; only the address is pinned.
      lookup: (_host, options, cb) => (options?.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)),
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Retries DNS for up to timeoutMs (10 minutes is normal), logging progress every progressMs, then retries GET /admin for up to 120 s until it returns 404.
const HTTPS_WAIT_MS = 120_000;

export async function verifyPublic({
  url, dnsName, resolve4, request = fetchPinned, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now,
  timeoutMs = DNS_WAIT_MS, intervalMs = 5_000, progressMs = DNS_PROGRESS_MS, log = console.log,
}) {
  const secs = ms => Math.round(ms / 1000);
  const start = now();
  const end = start + timeoutMs;
  let nextProgress = progressMs;
  let found = null;
  while (!found) {
    found = await resolve4(dnsName);
    if (found) break;
    const elapsed = now() - start;
    if (elapsed >= nextProgress && elapsed < timeoutMs) {
      log(`waiting for public DNS of ${dnsName} … ${secs(elapsed)} s / ${secs(timeoutMs)} s`);
      nextProgress += progressMs;
    }
    if (now() >= end) break;
    await sleep(intervalMs);
  }
  if (!found) {
    log(`FAIL public DNS: no A record for ${dnsName} from 1.1.1.1, 8.8.8.8 or 9.9.9.9 after ${secs(timeoutMs)} s. Likely cause: the Funnel rule or its certificate is not ready, or the name is not published yet. Next: run \`dig @8.8.8.8 ${dnsName} A\` (also try @1.1.1.1 and @9.9.9.9) and \`tailscale funnel status\`, then retry.`);
    return false;
  }
  const { address, server } = found;
  log(`PASS public DNS: ${dnsName} -> ${address} (via ${server})`);
  // Funnel needs a while after the rule exists: the first requests can fail the TLS handshake or hit a 5xx.
  // Retry every non-404 outcome until the window ends, then fail with the last error or status.
  const httpsEnd = now() + HTTPS_WAIT_MS;
  let nextHttpsProgress = now() + progressMs;
  let last;
  for (;;) {
    try {
      const code = await request(url, address);
      if (code === 404) break;
      last = `GET /admin returned ${code}, expected 404 from the bridge`;
    } catch (e) { last = e.message; }
    if (now() >= httpsEnd) {
      log(`FAIL public HTTPS: ${last} (still failing after ${secs(HTTPS_WAIT_MS)} s). Likely cause: the Funnel certificate is still being issued, the rule is not active, or a different service answers on this port. Next: \`tailscale funnel status\` and check the local port, then retry.`);
      return false;
    }
    if (now() >= nextHttpsProgress) {
      log(`waiting for public HTTPS of ${dnsName} … last result: ${last}`);
      nextHttpsProgress += progressMs;
    }
    await sleep(intervalMs);
  }
  log('PASS public HTTPS: GET /admin returned 404 from the bridge');
  return true;
}

export function recordPath(unitDir, worker) {
  return path.join(unitDir, `dot-bridge-${worker}.exposure.json`);
}

function writeRecord(file, value) {
  try { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') refuseOverwrite(`${file} already exists; refusing to overwrite an exposure record`);
    throw error;
  }
  fs.chmodSync(file, 0o600);
}

function readOwnedRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`exposure record ${file} is not a regular file owned by the current user; refusing to use it`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Step 3 of the brief: run our funnel rule, then prove it maps exactly our port.
export function applyFunnel({ tailscale = defaultTailscale, dnsName, port, localPort }) {
  runOrThrow(tailscale, funnelOnArgs(port, localPort), `funnel --bg --https=${port}`);
  const status = parseJsonOutput(runOrThrow(tailscale, funnelStatusArgs(), 'funnel status --json'), 'tailscale funnel status --json');
  if (!funnelRuleMatches(status, dnsName, port, localPort)) {
    throw new Error(`funnel status does not show ${dnsName}:${port} mapped to http://127.0.0.1:${localPort}. Run \`tailscale funnel status\` and fix it by hand; nothing else was changed.`);
  }
}

export const ngrokStopCommands = worker => [
  `ngrok service stop`,
  `ngrok service uninstall`,
].map(c => `  ${c}    # worker ${worker}`);

// --remove: a tailscale record turns off exactly its rule and verifies it is gone; an ngrok record only drops the record
// and prints the ngrok commands (ngrok is never run here). Units and home are left alone.
export function removeExposure({ tailscale = defaultTailscale, file, log = console.log }) {
  if (!fs.existsSync(file)) throw new Error(`no exposure record at ${file}; nothing to remove`);
  const rec = readOwnedRecord(file);
  if (rec.mode === 'ngrok') {
    if (!rec.domain || !rec.ngrok_config) throw new Error(`exposure record ${file} is not a valid ngrok record`);
    fs.rmSync(file);
    log(`Removed the ngrok exposure record for ${rec.domain} (was -> http://127.0.0.1:${rec.local_port}). ngrok itself was NOT stopped by this script. To stop it and remove its service, run:`);
    for (const line of ngrokStopCommands(rec.worker)) log(line);
    log(`The ngrok config ${rec.ngrok_config} is left in place; delete it yourself if you do not need it.`);
    return;
  }
  if (rec.mode !== 'tailscale' || !Number.isInteger(rec.public_port) || !rec.dns_name) throw new Error(`exposure record ${file} is not a tailscale record`);
  const before = parseJsonOutput(runOrThrow(tailscale, funnelStatusArgs(), 'funnel status --json'), 'tailscale funnel status --json');
  if (funnelRulePresent(before, rec.dns_name, rec.public_port)) {
    if (!funnelRuleMatches(before, rec.dns_name, rec.public_port, rec.local_port)) {
      throw new Error(`funnel rule ${rec.dns_name}:${rec.public_port} no longer matches this setup; refusing to change it. Inspect tailscale funnel status and remove the owned rule by hand if appropriate.`);
    }
    runOrThrow(tailscale, funnelOffArgs(rec.public_port), `funnel --https=${rec.public_port} off`);
    const after = parseJsonOutput(runOrThrow(tailscale, funnelStatusArgs(), 'funnel status --json'), 'tailscale funnel status --json');
    if (funnelRulePresent(after, rec.dns_name, rec.public_port)) throw new Error(`funnel rule ${rec.dns_name}:${rec.public_port} is still present after off`);
  }
  fs.rmSync(file);
  log(`Removed Funnel rule ${rec.dns_name}:${rec.public_port} (was -> http://127.0.0.1:${rec.local_port}) and its record`);
}

// Publish intent before changing Funnel so --remove can recover an interrupted mutation.
export function writeExposureRecord({ file, worker, dnsName, port, localPort, url, state = 'pending' }) {
  writeRecord(file, { mode: 'tailscale', state, worker, dns_name: dnsName, public_url: url, public_port: port, local_port: localPort, created_at: new Date().toISOString() });
}

export function updateExposureState(file, state) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('exposure record is not a regular file owned by the current user; refusing to update it');
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...value, state }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

// ngrok v3 agent config (https://ngrok.com/docs/agent/config/v3: version 3, endpoints[].name, url, upstream.url).
// The authtoken is deliberately absent: `ngrok config add-authtoken` keeps it in ngrok's own config.
export function ngrokConfigText({ worker, domain, localPort }) {
  return `version: 3\n\nendpoints:\n  - name: dot-bridge-${worker}\n    url: ${domain}\n    upstream:\n      url: http://127.0.0.1:${localPort}\n`;
}

export function ngrokConfigPath(home, worker) {
  return path.join(home, `ngrok-${worker}.yml`);
}

// Writes the config (0600, never overwritten) and the record (0600). The record is what signal-token and --remove read.
export function writeNgrokExposure({ home, worker, domain, localPort, file }) {
  const configFile = ngrokConfigPath(home, worker);
  try { fs.writeFileSync(configFile, ngrokConfigText({ worker, domain, localPort }), { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') refuseOverwrite(`${configFile} already exists; refusing to overwrite the ngrok config`);
    throw error;
  }
  fs.chmodSync(configFile, 0o600);
  writeRecord(file, { mode: 'ngrok', state: 'unverified', worker, domain, public_url: `https://${domain}`, public_port: null, local_port: localPort, ngrok_config: configFile, created_at: new Date().toISOString() });
  return configFile;
}

export function ngrokCommands(configFile) {
  return [
    'ngrok config add-authtoken <TOKEN>     # placeholder: paste your token from the ngrok dashboard; this script never stores it',
    `ngrok service install --config ${configFile}`,
    'ngrok service start',
  ];
}
