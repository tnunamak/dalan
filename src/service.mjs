import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { defaultPath } from './paths.mjs';
import { socketPathLimit } from './admin-socket.mjs';
import { initAsFiles, writeAtomic } from './as-files.mjs';
import { parseWorkers } from './workers.mjs';
import { parseArgs } from '../scripts/live-trial/common.mjs';
import { buildQuery, ensureDurableRoute, explainRouteError, describeCandidate, describeDisclosure, gozarHomeFor, registerExternalService, resolveGozar, resolveRouteWord } from './gozar-routes.mjs';
import { autoUpdateUnits, setAutoUpdate } from './service-auto-update.mjs';
import { serviceHomeFor, readDefaultHome, recordDefaultHome, forgetDefaultHome, DEFAULT_SERVICE_HOME } from './default-home.mjs';
import { launchdLabels, launchAgentsDir, servicePlist, updatePlist, preflightAgentFile, writeAgentFile, loadAgent, unloadAgent, removeAgents, lintPlist, isLoaded } from './service-launchd.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SAFE_PATH = /^[A-Za-z0-9_@+=:,./-]+$/;
const fail = message => { throw new Error(message); };

function parseOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('--public-url must be an HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== url.origin) {
    fail('--public-url must contain only https://, a host and an optional port');
  }
  return url.origin;
}

function parseTarget(value) {
  const match = /^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/.exec(value ?? '');
  if (!match || isIP(match[1]) !== 4 || match[1].split('.').some(part => Number(part) > 255)) {
    fail('--target must be an IPv4 address and port, such as 127.0.0.1:8789');
  }
  const port = Number(match[2]);
  if (port < 1 || port > 65535) fail('--target port must be 1 through 65535');
  return { host: match[1], port, value: `${match[1]}:${port}` };
}

function validateTopology({ port, target, lanPort = null, verifyCmd }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be a fixed port from 1024 through 65535');
  if (lanPort !== null && (!Number.isInteger(lanPort) || lanPort < 1024 || lanPort > 65535)) fail('--lan-port must be a port from 1024 through 65535');
  const direct = target.host === '127.0.0.1' && target.port === port;
  if (!direct && lanPort !== target.port) fail('a forwarded --target requires --lan-port matching its port');
  if (direct && lanPort !== null) fail('--lan-port needs a separate --target address and port');
  if (!direct && target.port === port && target.host === '0.0.0.0') fail('same-port --target must not use wildcard 0.0.0.0; it collides with the loopback listener');
  if (verifyCmd != null && (typeof verifyCmd !== 'string' || !verifyCmd.trim() || verifyCmd.length > 4096)) fail('--verify-cmd must be a nonempty command of at most 4096 characters');
  if (target.port !== port && !(typeof verifyCmd === 'string' && verifyCmd.trim())) fail('translated target ports require an explicit nonempty --verify-cmd; challenge verification binds the receiving port');
}

function parseOptions(argv, env) {
  const parsed = parseArgs(argv, {
    values: ['--home', '--public-url', '--port', '--target', '--worker', '--verify-cmd', '--route', '--lan-port'],
    flags: ['--write-units-only', '--enable-workspace', '--enable-t3', '--auto-update', '--no-auto-update', '--yes', '--json', '--help'],
  });
  if (parsed._.length) fail(`unexpected argument ${parsed._[0]}`);
  if (parsed['--help']) return { help: true };
  if (parsed['--auto-update'] && parsed['--no-auto-update']) fail('choose --auto-update or --no-auto-update');
  const home = path.resolve(parsed['--home'] ?? serviceHomeFor(env));
  if (!SAFE_PATH.test(home)) fail('--home contains characters that cannot be written safely in a service definition');
  // `--route NAME` alone is the one-command install: Gozar supplies the public address and Dalan picks a loopback port.
  const auto = parsed['--public-url'] === undefined && parsed['--port'] === undefined && parsed['--target'] === undefined;
  if (auto && parsed['--route'] === undefined) fail('pass --route NAME to publish through Gozar, or --public-url, --port and --target for a proxy you already run');
  if (auto && (parsed['--lan-port'] !== undefined || parsed['--verify-cmd'] !== undefined)) fail('--lan-port and --verify-cmd belong with an explicit --public-url, --port and --target');
  const origin = auto ? null : parseOrigin(parsed['--public-url']);
  const port = auto ? null : Number(parsed['--port']);
  if (!auto && (!Number.isInteger(port) || port < 1024 || port > 65535)) fail('--port must be a fixed port from 1024 through 65535');
  const target = auto ? null : parseTarget(parsed['--target']);
  const lanPort = parsed['--lan-port'] === undefined ? null : Number(parsed['--lan-port']);
  if (!auto) validateTopology({ port, target, lanPort, verifyCmd: parsed['--verify-cmd'] });
  const workers = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--worker') workers.push(argv[++i]);
    else if (argv[i].startsWith('--worker=')) workers.push(argv[i].slice('--worker='.length));
  }
  if (workers.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name) || ['pool', 'unknown'].includes(name))) {
    fail('--worker must be a lowercase name of up to 32 letters, digits, - or _');
  }
  if (new Set(workers).size !== workers.length) fail('--worker names must be unique');
  if (parsed['--verify-cmd']?.length > 4096) fail('--verify-cmd is too long');
  const route = parsed['--route'];
  if (route !== undefined && (!route || route.startsWith('-'))) fail('--route must name a Gozar route');
  return { home, auto, homeExplicit: parsed['--home'] !== undefined, origin, port, target, lanPort, enableWorkspace: parsed['--enable-workspace'] === true, enableT3: parsed['--enable-t3'] === true, workers, verifyCmd: parsed['--verify-cmd'] ?? null,
    route, yes: parsed['--yes'] === true, autoUpdate: parsed['--auto-update'] ? true : parsed['--no-auto-update'] ? false : undefined,
    writeUnitsOnly: parsed['--write-units-only'] === true, json: parsed['--json'] === true };
}

function assertRealDirectoryPath(target, { owner = false } = {}) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root, deepest = null;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory() || fs.realpathSync(current) !== current) {
      fail(`${current} is not a real directory; refusing to write through a symlink`);
    }
    deepest = { path: current, info };
  }
  if (owner && deepest && typeof process.getuid === 'function' && deepest.info.uid !== process.getuid()) fail(`${deepest.path} is not owned by the current user`);
}

function nodePath(execPath) {
  let real;
  try { real = fs.realpathSync(execPath); } catch { return execPath; }
  const userHome = os.userInfo().homedir || os.homedir();
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', path.join(userHome, '.local/share/mise/installs/node/lts/bin/node')];
  for (const candidate of candidates) {
    try { if (fs.realpathSync(candidate) === real) return candidate; } catch { /* candidate is not installed */ }
  }
  return execPath;
}

function readReceipt(home) {
  const file = path.join(defaultPath(home, '.config/dot-bridge'), 'service-install.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function firstFreePort(start) {
  return new Promise((resolve, reject) => {
    const attempt = port => {
      if (port > 65535) return reject(new Error('no free port from 8789 upward'));
      const probe = net.createServer();
      probe.once('error', () => attempt(port + 1));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
    };
    attempt(start);
  });
}

function unitName(home) { return `dalan-${createHash('sha256').update(home).digest('hex').slice(0, 10)}`; }

function unitFiles(o, { home, repo = REPO, node = nodePath(process.execPath), proxy = null, recover = true } = {}) {
  const name = unitName(home);
  for (const [label, value] of [['home', home], ['repo', repo], ['node', node]]) {
    if (!SAFE_PATH.test(value)) fail(`${label} contains characters that cannot be written safely in a systemd unit`);
  }
  const base = {
    [`${name}.service`]: [
      '[Unit]', 'Description=Dalan worker bridge', 'After=network-online.target', '', '[Service]',
      `WorkingDirectory=${repo}`, `ExecStart=${node} ${path.join(repo, 'src/server.mjs')}`,
      ...(recover ? [`ExecStartPre=${node} ${path.join(repo, 'bin/dalan.mjs')} service recover --home ${home} --quiet`] : []),
      `Environment=HOME=${home}`, 'Environment=NODE_ENV=production', 'Environment=DALAN_AUTH_MODE=builtin',
      'Environment=DALAN_BIND_HOST=127.0.0.1', 'Environment=DALAN_GOZAR_SERVICE=1', 'Environment=DALAN_CATALOG_PROFILE=stable',
      `Environment=DALAN_ENABLE_WORKSPACE=${o.enableWorkspace ? '1' : '0'}`, `Environment=DALAN_ENABLE_T3_TOOLS=${o.enableT3 ? '1' : '0'}`,
      `Environment=DALAN_PORT=${o.port}`, `Environment=PATH=${[path.dirname(node), '/usr/local/bin', '/usr/bin', '/bin'].join(':')}`,
      'UnsetEnvironment=OPENAI_API_KEY ANTHROPIC_API_KEY DALAN_LOOPBACK DOT_BRIDGE_LOOPBACK DALAN_WORKERS_FILE DOT_BRIDGE_WORKERS_FILE', 'Restart=on-failure', 'RestartSec=3', 'UMask=0077', '',
      '[Install]', 'WantedBy=default.target', '',
    ].join('\n'),
  };
  const enable = [`${name}.service`];
  const isDirect = o.target.host === '127.0.0.1' && o.target.port === o.port;
  if (!isDirect) {
    if (!proxy || !SAFE_PATH.test(proxy)) fail('systemd-socket-proxyd is required when --target is not 127.0.0.1:<port>');
    base[`${name}-target.socket`] = [
      '[Unit]', 'Description=Gozar target for Dalan', '', '[Socket]',
      `ListenStream=${o.target.host}:${o.target.port}`, 'FreeBind=true', '', '[Install]', 'WantedBy=sockets.target', '',
    ].join('\n');
    base[`${name}-target.service`] = [
      '[Unit]', 'Description=Forward Gozar target to the Dalan bridge', `Requires=${name}.service`, `After=${name}.service`, '', '[Service]',
      `ExecStart=${proxy} 127.0.0.1:${o.port}`, 'Restart=on-failure', '',
    ].join('\n');
    enable.push(`${name}-target.socket`);
  }
  return { files: base, enable, name };
}

function findProxy() {
  return ['/usr/lib/systemd/systemd-socket-proxyd', '/lib/systemd/systemd-socket-proxyd'].find(file => fs.existsSync(file)) ?? null;
}

function profileFor(home, workers) {
  const file = path.join(defaultPath(home, '.config/dot-bridge'), 'workers.json');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) fail(`${file} must be a private regular file`);
    let profile;
    try { profile = parseWorkers(JSON.parse(fs.readFileSync(file, 'utf8')), { builtin: true }); }
    catch (error) { fail(`${file} is not a built-in OAuth worker profile: ${error.message}`); }
    if (!profile.workers.size || profile.legacy) fail(`${file} must contain a built-in OAuth worker profile`);
    const configuredWorkers = [...profile.workers.keys()].sort();
    if (workers.length && JSON.stringify([...workers].sort()) !== JSON.stringify(configuredWorkers)) {
      fail(`${file} already exists; omit --worker or pass its exact worker set, and keep its workers and repository grants`);
    }
    return { file, workers: [...profile.workers.keys()], existing: true };
  }
  if (!workers.length) fail(`no ${file}; run dalan service migrate-workers first or pass --worker NAME`);
  const value = { workers: Object.fromEntries(workers.map(name => [name, { repos: [] }])), default_execution: 'none' };
  parseWorkers(value, { builtin: true });
  return { file, workers, value, existing: false };
}

const POLICY_HOME_FILES = new Set([
  'service-migration.json', 'workers.json', 'workers-audit.jsonl', 'workers-audit-checkpoint.sqlite',
  'workers-audit-checkpoint.sqlite-wal', 'workers-audit-checkpoint.sqlite-shm', 'workers-repos.json',
]);
const WORKSPACE_RUNTIME_DIRS = new Set(['artifacts', 'caches', 'host-receipts', 'mirrors', 'run', 'worktrees']);
const WORKSPACE_RUNTIME_FILES = new Map([['github-askpass', 0o700]]);

function installReceipt(home, configDir, o, workers) {
  return { schema_version: 1, home, origin: o.origin, port: o.port, target: o.target.value, enable_workspace: !!o.enableWorkspace, enable_t3: !!o.enableT3,
    unit: unitName(home), workers: [...workers].sort(), created_at: new Date().toISOString() };
}

function validateWorkspaceRuntime(home) {
  const scratch = path.join(home, '.tmp');
  const runtime = path.join(scratch, 'dalan');
  for (const directory of [scratch, runtime]) assertRealDirectoryPath(directory, { owner: true });
  const scratchEntries = fs.readdirSync(scratch);
  if (scratchEntries.length !== 1 || scratchEntries[0] !== 'dalan') fail(`${scratch} contains data outside Dalan runtime scratch`);
  if ((fs.lstatSync(runtime).mode & 0o777) !== 0o700) fail(`${runtime} must be private`);
  const runtimeEntries = fs.readdirSync(runtime).sort();
  for (const name of runtimeEntries) {
    const entry = path.join(runtime, name);
    if (!WORKSPACE_RUNTIME_DIRS.has(name) && !WORKSPACE_RUNTIME_FILES.has(name)) fail(`${runtime} contains an unknown Dalan workspace entry`);
    const info = fs.lstatSync(entry);
    if (WORKSPACE_RUNTIME_FILES.has(name)) {
      const owned = typeof process.getuid !== 'function' || info.uid === process.getuid();
      if (!info.isFile() || info.isSymbolicLink() || !owned || (info.mode & 0o777) !== WORKSPACE_RUNTIME_FILES.get(name)) {
        fail(`${entry} must be a private regular Dalan file`);
      }
      continue;
    }
    assertRealDirectoryPath(entry, { owner: true });
    if ((info.mode & 0o777) !== 0o700) fail(`${entry} must be private`);
  }
}

function checkHomeScope(home, configDir, o, workers) {
  if (!fs.existsSync(home)) return { receiptFile: path.join(configDir, 'service-install.json'), hasReceipt: false };
  const rootEntries = fs.readdirSync(home);
  if (!rootEntries.length) return { receiptFile: path.join(configDir, 'service-install.json'), hasReceipt: false };
  const rootAllowed = ['.config', '.local', '.tmp', 'resource-url', 'logs', 'current', 'versions', 'update-result.json', 'update-failed.json', 'update-transaction.json', 'update-backup', 'update-lock.sqlite', 'update-lock.sqlite-journal'];
  if (rootEntries.some(name => !rootAllowed.includes(name))) fail(`${home} contains unrelated data; use a fresh home or one created by dalan service migrate-workers`);
  if (!rootEntries.includes('.config')) fail(`${home} has no Dalan config directory; refusing to adopt it`);
  const configRoot = path.join(home, '.config');
  if (fs.lstatSync(configRoot).isSymbolicLink() || !fs.lstatSync(configRoot).isDirectory()) fail(`${configRoot} must be a real directory`);
  const configEntries = fs.readdirSync(configRoot);
  const configName = path.basename(configDir);
  if (configEntries.some(name => name !== configName)) fail(`${home} contains config outside the service home; refusing to adopt it`);
  if (!configEntries.length) {
    if (rootEntries.includes('.local') || rootEntries.includes('.tmp') || rootEntries.includes('resource-url')) fail(`${home} already contains bridge data; use a fresh home or one created by dalan service migrate-workers`);
    return { receiptFile: path.join(configDir, 'service-install.json'), hasReceipt: false };
  }
  const configInfo = fs.lstatSync(configDir);
  if (configInfo.isSymbolicLink() || !configInfo.isDirectory()) fail(`${configDir} must be a real directory`);
  const receiptFile = path.join(configDir, 'service-install.json');
  const entries = fs.readdirSync(configDir);
  const hasReceipt = entries.includes('service-install.json');
  if (!hasReceipt && rootEntries.some(name => !['.config', '.local', '.tmp', 'resource-url', 'logs'].includes(name))) fail(`${home} contains update data without a service receipt`);
  if (hasReceipt) {
    const info = fs.lstatSync(receiptFile);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) fail(`${receiptFile} must be a private regular file`);
    let existing;
    try { existing = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { fail(`${receiptFile} is not valid JSON`); }
    const wanted = installReceipt(home, configDir, o, workers);
    for (const field of ['schema_version', 'home', 'origin', 'port', 'target', 'enable_workspace', 'enable_t3', 'unit', 'workers']) {
      if (JSON.stringify(existing[field]) !== JSON.stringify(wanted[field])) fail(`${receiptFile} belongs to a different service configuration (${field}); refusing to change it`);
    }
    if (rootEntries.includes('.tmp')) validateWorkspaceRuntime(home);
    if (rootEntries.includes('.local')) assertRealDirectoryPath(defaultPath(home, '.local/share/dot-bridge'));
    return { receiptFile, hasReceipt };
  }
  if (rootEntries.includes('.local') || rootEntries.includes('.tmp') || rootEntries.includes('resource-url')) fail(`${home} already contains bridge data; use a fresh home or one created by dalan service migrate-workers`);
  for (const name of entries) {
    if (POLICY_HOME_FILES.has(name) || hasReceipt && name === 'service-install.json') continue;
    fail(`${configDir}/${name} is outside a fresh or migrated policy-only home; refusing to adopt it`);
  }
  if (entries.length && !entries.includes('workers.json')) fail(`${configDir} has no worker policy; refusing to adopt it`);
  return { receiptFile, hasReceipt };
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || fs.readFileSync(file, 'utf8') !== text) {
      fail(`${file} already exists with different or unsafe contents; refusing to replace it`);
    }
  }
}

function prepareHome(o, profile) {
  fs.mkdirSync(o.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(o.home, 0o700);
  const config = defaultPath(o.home, '.config/dot-bridge');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  if (!profile.existing) writePrivate(profile.file, `${JSON.stringify(profile.value, null, 2)}\n`);
  initAsFiles(config, { publicUrl: o.origin });
  const envFile = path.join(config, 'env');
  if (!fs.existsSync(envFile)) writePrivate(envFile, `BRIDGE_PATH_SECRET=${randomBytes(32).toString('hex')}\n`);
  const envInfo = fs.lstatSync(envFile);
  const envText = fs.readFileSync(envFile, 'utf8');
  const secret = /^BRIDGE_PATH_SECRET=([a-f0-9]{64})\n?$/.exec(envText)?.[1];
  if (!envInfo.isFile() || envInfo.isSymbolicLink() || (envInfo.mode & 0o777) !== 0o600 || !secret) fail(`${envFile} is not a private bridge secret file`);
  const resourceFile = path.join(o.home, 'resource-url');
  writePrivate(resourceFile, `${o.origin}/${secret}/mcp\n`);
  return { config, resourceFile, secret };
}

function writeUnits(dir, files) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    try { fs.writeFileSync(file, text, { mode: 0o644, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== text) fail(`${file} already exists with different contents; refusing to replace it`);
    }
  }
}

function runCommand(command, args, { env, spawn = spawnSync, timeout = 30000 } = {}) {
  const result = spawn(command, args, { encoding: 'utf8', env, timeout, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error(`${command} ${args.join(' ')} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? result.signal}): ${(result.stderr || result.stdout || '').trim().slice(0, 1000)}`);
  return result.stdout ?? '';
}

function socketIsReady(socketPath, timeoutMs = 30000) {
  return new Promise(resolve => {
    const started = Date.now();
    const attempt = () => {
      const probe = net.connect(socketPath);
      const done = ready => { probe.destroy(); if (ready) resolve(true); else if (Date.now() - started >= timeoutMs) resolve(false); else setTimeout(attempt, 200); };
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
      probe.setTimeout(1000, () => done(false));
    };
    attempt();
  });
}

// Gozar refuses a state path whose ancestors are writable by group or others, but only
// when `service add` runs, after the bridge is already started. Apply the same rule first.
function assertGozarStatePath(env) {
  const stateHome = env.GOZAR_HOME ?? path.join(env.HOME ?? os.homedir(), '.local', 'state', 'gozar');
  let canonical = path.resolve(stateHome);
  const missing = [];
  for (;;) {
    try { canonical = path.join(fs.realpathSync(canonical), ...missing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') return; // Gozar reports other failures itself.
      const parent = path.dirname(canonical);
      if (parent === canonical) return;
      missing.unshift(path.basename(canonical));
      canonical = parent;
    }
  }
  const uid = process.getuid();
  const chain = [];
  for (let dir = canonical; ; dir = path.dirname(dir)) { chain.unshift(dir); if (path.dirname(dir) === dir) break; }
  for (const dir of chain) {
    let stat;
    try { stat = fs.lstatSync(dir); } catch { return; }
    const rootSticky = stat.uid === 0 && (stat.mode & 0o1000);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Gozar refuses its state path: ${dir} must be a real directory. Set GOZAR_HOME to a private directory, then retry.`);
    if (stat.uid !== 0 && stat.uid !== uid) fail(`Gozar refuses its state path: ${dir} must be owned by you or root. Set GOZAR_HOME to a directory you own, then retry.`);
    if ((stat.mode & 0o022) && !rootSticky) fail(`Gozar refuses its state path: ${dir} is writable by group or others. Run: chmod go-w ${dir}   (then retry service install)`);
  }
}

export async function installService(o, seams = {}) {
  const env = seams.env ?? process.env;
  const platform = seams.platform ?? process.platform;
  if (!['linux', 'darwin'].includes(platform)) fail('dalan service install needs Linux with a systemd user manager or macOS with launchd');
  const mac = platform === 'darwin';
  if (!path.isAbsolute(o.home) || !SAFE_PATH.test(o.home)) fail('--home must be an absolute service-safe path');
  assertRealDirectoryPath(path.dirname(o.home), { owner: true });
  assertRealDirectoryPath(o.home, { owner: true });
  // Every check up to the route allocation below only reads. A public route is allocated after the last of them passes, so a
  // read-only preflight refusal leaves no route behind. Later writes or startup can still fail.
  const adminSocket = path.join(defaultPath(o.home, '.local/share/dot-bridge'), 'admin.sock');
  const socketBytes = Buffer.byteLength(adminSocket), socketLimit = socketPathLimit(platform);
  if (socketBytes > socketLimit) fail(`--home is too long: the bridge's admin socket ${adminSocket} would be ${socketBytes} bytes, and the limit on ${mac ? 'macOS' : 'Linux'} is ${socketLimit} bytes. Use a shorter --home.`);
  let gozar = null, allocate = false;
  if (o.auto) {
    // The one-command install: reuse the port and address a previous run recorded, or pick a free port now and ask Gozar for
    // the address once every check has passed.
    const prior = readReceipt(o.home);
    if (prior?.origin && prior.port) o = { ...o, origin: prior.origin, port: prior.port, target: parseTarget(prior.target) };
    else {
      const port = await (seams.freePort ?? firstFreePort)(8789);
      o = { ...o, origin: null, port, target: parseTarget(`127.0.0.1:${port}`) };
      allocate = true;
    }
  }
  const target = parseTarget(typeof o.target === 'string' ? o.target : `${o.target?.host}:${o.target?.port}`);
  o = { ...o, target };
  validateTopology(o);
  const profile = profileFor(o.home, o.workers ?? []);
  assertRealDirectoryPath(path.dirname(profile.file));
  const unitDir = mac ? launchAgentsDir(env) : path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config'), 'systemd/user');
  assertRealDirectoryPath(unitDir, { owner: true });
  const configDir = path.dirname(profile.file);
  const homeScope = checkHomeScope(o.home, configDir, o, profile.workers);
  if (mac && !(o.target.host === '127.0.0.1' && o.target.port === o.port)) fail('on macOS the target must be 127.0.0.1:<port> (the same as --port)');
  const proxy = o.target.host === '127.0.0.1' && o.target.port === o.port ? null : (seams.proxy ?? findProxy());
  const repo = seams.repo ?? REPO, node = seams.node ?? nodePath(process.execPath);
  const receiptFile = homeScope.receiptFile;
  const previous = homeScope.hasReceipt ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  const autoUpdate = o.autoUpdate ?? previous?.auto_update ?? !homeScope.hasReceipt;
  const current = path.join(o.home, 'current');
  const hasCurrent = fs.existsSync(current) || (() => { try { fs.lstatSync(current); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } })();
  if (hasCurrent && !fs.lstatSync(current).isSymbolicLink()) fail(`${current} must be the service package symlink`);
  const name = unitName(o.home), labels = launchdLabels(name);
  let files, enable = [];
  if (mac) files = { [`${labels.service}.plist`]: servicePlist({ unit: name, node, home: o.home, port: o.port, enableWorkspace: o.enableWorkspace, enableT3: o.enableT3 }) };
  else {
    ({ files, enable } = unitFiles(o, { home: o.home, repo: current, node, proxy }));
    Object.assign(files, autoUpdateUnits({ home: o.home, unit: name, node }).files);
  }
  let replaceLegacyUnit = false;
  // Check every collision before creating the bridge home or the first unit file.
  if (mac && autoUpdate && !o.writeUnitsOnly) {
    preflightAgentFile(path.join(unitDir, `${labels.update}.plist`), updatePlist({ unit: name, node, home: o.home }));
  }
  for (const [filename, text] of Object.entries(files)) {
    const file = path.join(unitDir, filename);
    if (mac) { preflightAgentFile(file, text); continue; }
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== text)) {
      const actual = fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : '';
      const oldRepo = actual.match(/^WorkingDirectory=(.+)$/m)?.[1];
      const oldNode = actual.match(/^ExecStart=(\S+) /m)?.[1];
      const expected = filename === `${name}.service` && previous && oldRepo && oldNode && SAFE_PATH.test(oldRepo) && SAFE_PATH.test(oldNode)
        ? unitFiles(o, { home: o.home, repo: oldRepo, node: oldNode, proxy, recover: false }).files[filename] : null;
      // Only the exact former generated unit can be enrolled or retried after interruption.
      if (expected && actual === expected) replaceLegacyUnit = true;
      else fail(`${file} already exists with different contents; refusing to overwrite it`);
    }
  }
  if (o.writeUnitsOnly) {
    if (replaceLegacyUnit) fail('rerun without --write-units-only to enroll an existing service for updates');
    if (mac) for (const [filename, text] of Object.entries(files)) writeAgentFile(path.join(unitDir, filename), text); else writeUnits(unitDir, files);
    return { schema_version: 1, home: o.home, unit: mac ? labels.service : `${name}.service`, units: Object.keys(files), target: o.target.value, started: false, route: null };
  }
  gozar ??= seams.gozar ?? await resolveGozar();
  assertGozarStatePath(env);
  const needsEnrollmentRestart = replaceLegacyUnit || !!previous && (!previous.repo || previous.enrollment_pending === true);
  const spawn = seams.spawn ?? spawnSync;
  if (!mac) {
    try { runCommand('systemctl', ['--user', 'show-environment'], { env, spawn }); }
    catch (error) { fail(`the user systemd manager is not reachable (${error.message}). Run \`systemctl --user status\` to see why; a login session or \`loginctl enable-linger\` may be needed.`); }
  }
  let allocated = null;
  if (allocate) {
    const wanted = buildQuery({ home: gozarHomeFor(env), target: o.target.value, usage: { kind: 'durable', routeId: 'dalan-main' }, route: o.route, address: 'stable' });
    const { query, pick } = await resolveRouteWord({ gozar, query: wanted });
    const view = await ensureDurableRoute({ gozar, query, pick, consent: seams.consent ?? (async () => fail('A durable route needs your approval; run `dalan setup --route NAME` first, then retry.')) });
    o = { ...o, origin: parseOrigin(view.origin) };
    // Gozar's reply does not say whether this call created the route or reused one that already existed (from `dalan setup`, or
    // another install), so a failure below never closes it. The receipt keeps its handle, and `dalan service uninstall` releases it.
    allocated = view.handle ?? null;
  }
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (!homeScope.hasReceipt) writePrivate(receiptFile, `${JSON.stringify({ ...installReceipt(o.home, configDir, o, profile.workers), repo, node, unit_dir: unitDir, auto_update: autoUpdate, platform, route: o.route ?? null, ...(allocated ? { route_handle: allocated } : {}) }, null, 2)}\n`);
  if (!hasCurrent) fs.symlinkSync(repo, current);
  const homeFiles = prepareHome(o, profile);
  if (needsEnrollmentRestart) {
    writeAtomic(receiptFile, `${JSON.stringify({ ...previous, repo: previous.repo ?? repo, node, unit_dir: unitDir, auto_update: autoUpdate, enrollment_pending: true }, null, 2)}\n`);
  }
  if (replaceLegacyUnit) {
    const file = path.join(unitDir, `${name}.service`), mode = fs.statSync(file).mode & 0o777;
    writeAtomic(file, files[`${name}.service`]);
    fs.chmodSync(file, mode);
  }
  if (mac) {
    fs.mkdirSync(path.join(o.home, 'logs'), { recursive: true, mode: 0o700 });
    const plistFile = path.join(unitDir, `${labels.service}.plist`);
    const changed = writeAgentFile(plistFile, files[`${labels.service}.plist`]);
    if (lintPlist(plistFile, seams) === false) fail(`${plistFile} is not a valid property list`);
    if (changed) unloadAgent({ label: labels.service }, seams.launchd);
    const { kicked, detail } = loadAgent({ label: labels.service, plistFile }, seams.launchd);
    if (!kicked) fail(`launchctl kickstart ${labels.service} failed: ${detail}`);
  } else {
    writeUnits(unitDir, files);
    runCommand('systemctl', ['--user', 'daemon-reload'], { env, spawn });
    runCommand('systemctl', ['--user', 'enable', '--now', ...enable], { env, spawn });
    if (needsEnrollmentRestart) runCommand('systemctl', ['--user', 'restart', `${name}.service`], { env, spawn });
  }
  const dataDir = defaultPath(o.home, '.local/share/dot-bridge');
  const ready = await (seams.waitForSocket ?? socketIsReady)(path.join(dataDir, 'admin.sock'), seams.socketTimeoutMs ?? 30000);
  if (!ready) fail(`Dalan did not start on its admin socket; the service and home remain for inspection: ${mac ? `tail ${path.join(o.home, 'logs', 'bridge.err.log')}` : `systemctl --user status ${name}.service`}`);
  const gozarHome = gozarHomeFor(env);
  let routeReply;
  if (o.route !== undefined) {
    // A named Gozar route: Gozar allocates or adopts it and pins the origin; nothing here interprets the name.
    const wanted = buildQuery({ home: gozarHome, target: o.target.value, usage: { kind: 'durable', routeId: 'dalan-main' }, route: o.route, origin: o.origin, address: 'stable' });
    const { query, pick } = await resolveRouteWord({ gozar, query: wanted });
    const view = await ensureDurableRoute({ gozar, query, pick, consent: seams.consent ?? (async () => fail('A durable route needs your approval; run `dalan setup --route NAME` first, then retry.')) });
    if (view.origin !== o.origin) fail(`Gozar pinned ${view.origin}, not the requested ${o.origin}; the bridge is running but its route needs repair`);
    routeReply = view;
  } else {
    routeReply = (await registerExternalService({ gozar, home: gozarHome, origin: o.origin, target: o.target.value, ...(o.verifyCmd ? { verifyCmd: o.verifyCmd } : {}) })).route;
  }
  if (routeReply.verification?.status !== 'verified') fail(`Gozar did not verify the route; the bridge is running and the route needs repair: ${JSON.stringify(routeReply).slice(0, 1500)}`);
  { const done = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); if (routeReply.handle && JSON.stringify(done.route_handle) !== JSON.stringify(routeReply.handle)) writeAtomic(receiptFile, `${JSON.stringify({ ...done, route_handle: routeReply.handle }, null, 2)}\n`); }
  await setAutoUpdate({ home: o.home, enabled: autoUpdate }, { ...seams, env, spawn, platform });
  if (!env.DALAN_HOME) recordDefaultHome(o.home, env);
  if (needsEnrollmentRestart) {
    const enrolled = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    delete enrolled.enrollment_pending;
    writeAtomic(receiptFile, `${JSON.stringify(enrolled, null, 2)}\n`);
  }
  return { schema_version: 1, origin: routeReply.published ?? o.origin, home: o.home, unit: mac ? labels.service : `${name}.service`, already_installed: homeScope.hasReceipt && !needsEnrollmentRestart, units: Object.keys(files), port: o.port,
    workers: profile.workers, public_url: `${o.origin}/<secret>/mcp`, resource_url_file: homeFiles.resourceFile,
    target: o.target.value, started: true, route: routeReply, auto_update: autoUpdate };
}

// Stop the service and its update job, delete the generated definitions and the public route, and forget the default home.
// The home itself (secrets, grants, data) stays; delete it by hand if you also want that gone.
export async function uninstallService({ home }, seams = {}) {
  const env = seams.env ?? process.env, platform = seams.platform ?? process.platform, mac = platform === 'darwin';
  home = path.resolve(home);
  const receipt = readReceipt(home);
  if (!receipt?.unit || receipt.home !== home) fail(`no Dalan service is installed for ${home}`);
  const removed = [];
  const unitDir = receipt.unit_dir;
  if (!unitDir || !path.isAbsolute(unitDir)) fail('the service receipt names no unit directory');
  // Verify both jobs before removing either plist or disabling automatic updates.
  if (mac) for (const label of Object.values(launchdLabels(receipt.unit))) isLoaded(label, seams.launchd);
  if (receipt.auto_update) { try { await setAutoUpdate({ home, enabled: false }, { ...seams, env, platform }); removed.push('automatic updates off'); } catch (error) { if (mac) throw error; removed.push(`update job not removed: ${error.message}`); } }
  if (mac) removed.push(...removeAgents({ unit: receipt.unit, unit_dir: unitDir }, seams.launchd));
  else {
    const spawn = seams.spawn ?? spawnSync, name = receipt.unit;
    const units = [`${name}.service`, `${name}-target.socket`, `${name}-target.service`, `${name}-update.service`, `${name}-update.timer`].filter(unit => fs.existsSync(path.join(unitDir, unit)));
    if (units.length) { spawn('systemctl', ['--user', 'disable', '--now', ...units], { encoding: 'utf8', env }); }
    for (const unit of units) { fs.rmSync(path.join(unitDir, unit)); removed.push(`removed ${path.join(unitDir, unit)}`); }
    spawn('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', env });
  }
  if (receipt.route_handle) {
    try {
      const gozar = seams.gozar ?? await resolveGozar();
      const closed = await gozar.closeRoute({ home: gozarHomeFor(env), handle: receipt.route_handle, mode: 'remove' });
      removed.push(`public route ${closed.state}`);
    } catch (error) { removed.push(`public route not removed: ${explainRouteError(error).line}`); }
  }
  forgetDefaultHome(home, env);
  // The home holds secrets, grants and data, so it is moved aside, never deleted. A new install then starts from a fresh home at the same path.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  let aside = `${home}.removed-${stamp}`;
  for (let n = 2; fs.existsSync(aside); n++) aside = `${home}.removed-${stamp}-${n}`;
  fs.renameSync(home, aside);
  return { home, removed, kept: `${aside} (secrets and data, moved aside; delete it yourself to remove them)`, moved_to: aside };
}

export async function serviceMain(argv, seams = {}) {
  const [action, ...args] = argv;
  if (action === 'migrate-workers') {
    const { migrationMain } = await import('./service-migrate-workers.mjs');
    return migrationMain(args);
  }
  if (action === 'recover') {
    const parsed = parseArgs(args, { values: ['--home'], flags: ['--quiet', '--help'] });
    if (parsed['--help']) return serviceMain(['help'], seams);
    if (parsed._.length) fail(`unexpected argument ${parsed._[0]}`);
    const home = path.resolve(parsed['--home'] ?? serviceHomeFor(seams.env ?? process.env));
    const { recoverService } = await import('./service-update.mjs');
    const result = recoverService({ home });
    if (!parsed['--quiet']) (seams.out ?? console.log)(JSON.stringify(result));
    return result;
  }
  if (['update', 'status', 'auto-update'].includes(action)) {
    const parsed = parseArgs(args, { values: ['--home'], flags: ['--check', '--yes', '--retry', '--json', '--help'] });
    if (parsed['--help']) return serviceMain(['help'], seams);
    const home = path.resolve(parsed['--home'] ?? serviceHomeFor(seams.env ?? process.env));
    let result;
    if (action === 'auto-update') {
      if (parsed._.length !== 1 || !['on', 'off'].includes(parsed._[0]) || parsed['--check'] || parsed['--yes'] || parsed['--retry']) fail('use dalan service auto-update on|off [--home DIR]');
      result = await setAutoUpdate({ home, enabled: parsed._[0] === 'on' }, seams);
    } else {
      if (parsed._.length) fail(`unexpected argument ${parsed._[0]}`);
      if (parsed['--check'] && parsed['--retry']) fail('--check cannot be used with --retry');
      if (parsed['--check'] && parsed['--yes']) fail('--check cannot be used with --yes');
      if (action === 'status' && (parsed['--check'] || parsed['--yes'] || parsed['--retry'])) fail('service status does not accept --check, --yes or --retry');
      const updater = await import('./service-update.mjs');
      result = await updater[action === 'status' ? 'serviceStatus' : 'updateService']({ home, check: !!parsed['--check'], yes: !!parsed['--yes'], retry: !!parsed['--retry'] }, seams);
    }
    (seams.out ?? console.log)(parsed['--json'] ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return result;
  }
  if (action === 'help' || action === '--help' || !action) {
    (seams.out ?? console.log)('Usage: dalan service install --worker NAME --route NAME [--yes] [--home DIR] [--enable-workspace] [--enable-t3] [--auto-update|--no-auto-update]\n       dalan service install --public-url https://HOST --port N --target HOST:PORT [--home DIR] [--lan-port N] [--worker NAME ...] [--verify-cmd COMMAND] [--write-units-only]   (an address you already serve)\n       dalan service uninstall [--home DIR]\n       dalan service migrate-workers --home DIR --source workers.json [--source workers.json ...]\n       dalan service update [--check|--yes] [--retry] [--home DIR] [--json]\n       dalan service auto-update on|off [--home DIR]\n       dalan service status [--home DIR] [--json]\n       dalan service recover --home DIR [--quiet]\nNew installs check daily with jitter. Catalog changes stage until --yes authorizes a connector refresh. --check reports availability without installing. Runs under systemd on Linux and launchd on macOS.');
    return null;
  }
  if (action === 'uninstall') {
    const parsed = parseArgs(args, { values: ['--home'], flags: ['--json', '--help'] });
    if (parsed['--help']) return serviceMain(['help'], seams);
    if (parsed._.length) fail(`unexpected argument ${parsed._[0]}`);
    const result = await uninstallService({ home: parsed['--home'] ?? serviceHomeFor(seams.env ?? process.env) }, seams);
    const out = seams.out ?? console.log;
    if (parsed['--json']) out(JSON.stringify(result)); else { for (const line of result.removed) out(line); out(`Kept: ${result.kept}`); }
    return result;
  }
  if (action !== 'install') fail('use dalan service install, uninstall, update, auto-update, status, recover or migrate-workers');
  const o = parseOptions(args, seams.env ?? process.env);
  if (o.help) return serviceMain(['help'], seams);
  const out0 = seams.out ?? console.log;
  // Gozar describes the route it would open; the owner approves it once (the answer is kept with the route). `--yes` approves what was printed.
  const consent = seams.consent ?? (async candidate => {
    out0(describeCandidate(candidate).join('\n')); out0(describeDisclosure(candidate).join('\n'));
    if (o.yes) return true;
    if (!process.stdin.isTTY) { out0('Run this in a terminal to approve the route, or add --yes after reading the description above.'); return false; }
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question('Use this route? [y/N] ')).trim()); } finally { rl.close(); }
  });
  const result = await installService(o, { ...seams, consent });
  if (o.json) (seams.out ?? console.log)(JSON.stringify(result));
  else {
    const out = seams.out ?? console.log;
    out(`Service: ${result.unit} (${result.started ? (result.already_installed ? 'already installed, running' : 'running') : 'files written'})`);
    out(`Home: ${result.home}`);
    out(`Public address: ${result.origin ?? o.origin ?? result.public_url}`);
    out(`Connector URL (keep private): in ${result.resource_url_file ?? path.join(result.home, 'resource-url')}`);
    if (result.route) out(`Route: ${result.route.verification?.status ?? 'unknown'}`);
    if (result.started) {
      out(`Updates: ${result.auto_update ? 'automatic, once a day' : 'off; run dalan service update'}`);
      const worker = result.workers?.[0] ?? 'WORKER';
      out(`Next: dalan connect start --worker ${worker}`);
      out('Check: dalan doctor --auth');
    }
  }
  return result;
}

export { parseOrigin, parseTarget, unitFiles };
