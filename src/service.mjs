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
import { loadCapacity } from './projects.mjs';
import { parseArgs } from '../scripts/live-trial/common.mjs';
import { buildQuery, closeExactRoute, ensureDurableRoute, explainRouteError, describeCandidate, describeDisclosure, gozarHomeFor, isPublished, registerExternalService, resolveGozar, resolveRouteWord, observeRetainedRoute, routeFailure, routeNotDispatched } from './gozar-routes.mjs';
import { routeCustodyPath } from './route-custody.mjs';
import { muteableTerminal, runRouteSetup } from './route-setup.mjs';
import { readRouteSetting } from './route-setting.mjs';
import { acquirePrivateLock } from './service-update-lock.mjs';
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
    flags: ['--write-units-only', '--enable-workspace', '--enable-t3', '--auto-update', '--no-auto-update', '--json', '--help'],
  });
  if (parsed._.length) fail(`unexpected argument ${parsed._[0]}`);
  if (parsed['--help']) return { help: true };
  if (parsed['--auto-update'] && parsed['--no-auto-update']) fail('choose --auto-update or --no-auto-update');
  const home = path.resolve(parsed['--home'] ?? serviceHomeFor(env));
  if (!SAFE_PATH.test(home)) fail('--home contains characters that cannot be written safely in a service definition');
  // `--route NAME` alone is the one-command install: Gozar supplies the public address and Dalan picks a loopback port.
  const auto = parsed['--public-url'] === undefined && parsed['--port'] === undefined && parsed['--target'] === undefined;
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
    route, autoUpdate: parsed['--auto-update'] ? true : parsed['--no-auto-update'] ? false : undefined,
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

function pendingInstallPath(env, home) {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME ?? os.homedir(), '.config');
  return path.join(config, 'dalan', 'route-installs', createHash('sha256').update(home).digest('hex') + '.json');
}

function readPendingInstall(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (typeof value?.home !== 'string' || !path.isAbsolute(value.home) || typeof value.operationId !== 'string' ||
      !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) fail('The pending service route reference is invalid.');
  return value;
}

async function withRouteInstallLock(env, home, action) {
  const file = pendingInstallPath(env, home);
  fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  const unlock = acquirePrivateLock(file + '.lock.sqlite', 'another service install or uninstall is already running');
  try { return await action(); } finally { unlock(); }
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
  'workers-audit-checkpoint.sqlite-wal', 'workers-audit-checkpoint.sqlite-shm', 'workers-repos.json', 'limits.json',
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
  if (entries.includes('limits.json')) {
    const file = path.join(configDir, 'limits.json'), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o600) fail(`${file} must be a private regular file`);
    loadCapacity(file);
  }
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
  if (!path.isAbsolute(o.home) || !SAFE_PATH.test(o.home)) fail('--home must be an absolute service-safe path');
  return o.writeUnitsOnly ? installServiceLocked(o, seams) : withRouteInstallLock(env, o.home, () => installServiceLocked(o, seams));
}

async function installServiceLocked(o, seams) {
  const env = seams.env ?? process.env;
  const platform = seams.platform ?? process.platform;
  if (!['linux', 'darwin'].includes(platform)) fail('dalan service install needs Linux with a systemd user manager or macOS with launchd');
  const mac = platform === 'darwin';
  assertRealDirectoryPath(path.dirname(o.home), { owner: true });
  assertRealDirectoryPath(o.home, { owner: true });
  // A public route is allocated after the preflight checks pass. Later writes or startup can still fail.
  const adminSocket = path.join(defaultPath(o.home, '.local/share/dot-bridge'), 'admin.sock');
  const socketBytes = Buffer.byteLength(adminSocket), socketLimit = socketPathLimit(platform);
  if (socketBytes > socketLimit) fail(`--home is too long: the bridge's admin socket ${adminSocket} would be ${socketBytes} bytes, and the limit on ${mac ? 'macOS' : 'Linux'} is ${socketLimit} bytes. Use a shorter --home.`);
  const saved = o.auto && o.route === undefined ? readRouteSetting(env) : null;
  const gozarHome = saved?.gozarHome ?? gozarHomeFor(env);
  const managed = o.auto || o.route !== undefined;
  const pendingPath = pendingInstallPath(env, o.home);
  const persisted = readReceipt(o.home);
  let pending = readPendingInstall(pendingPath);
  let gozar, allocated, allocate = false;
  if (o.auto) {
    // The one-command install: reuse the port and address a previous run recorded, or pick a free port now and ask Gozar for
    // the address once every check has passed.
    const prior = persisted;
    if (prior?.origin && prior.port) o = { ...o, origin: prior.origin, port: prior.port, target: parseTarget(prior.target) };
    else {
      const port = pending?.port ?? await (seams.freePort ?? firstFreePort)(8789);
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
  let updateNeedsReplace = false;
  // Check every collision before creating the bridge home or the first unit file.
  if (mac && autoUpdate && !o.writeUnitsOnly) {
    updateNeedsReplace = preflightAgentFile(path.join(unitDir, `${labels.update}.plist`), updatePlist({ unit: name, node, home: o.home }));
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
  if (mac && !o.writeUnitsOnly && preflightAgentFile(path.join(unitDir, `${labels.service}.plist`), files[`${labels.service}.plist`])) {
    isLoaded(labels.service, seams.launchd);
  }
  if (updateNeedsReplace) isLoaded(labels.update, seams.launchd);
  if (o.writeUnitsOnly) {
    if (replaceLegacyUnit) fail('rerun without --write-units-only to enroll an existing service for updates');
    if (mac) for (const [filename, text] of Object.entries(files)) writeAgentFile(path.join(unitDir, filename), text); else writeUnits(unitDir, files);
    return { schema_version: 1, home: o.home, unit: mac ? labels.service : `${name}.service`, units: Object.keys(files), target: o.target.value, started: false, route: null };
  }
  gozar = seams.gozar ?? await resolveGozar({ env, home: persisted?.gozar_home ?? pending?.home ?? gozarHome, custody: persisted?.route_custody });
  assertGozarStatePath({ ...env, GOZAR_HOME: persisted?.gozar_home ?? pending?.home ?? gozarHome });
  const needsEnrollmentRestart = replaceLegacyUnit || !!previous && (!previous.repo || previous.enrollment_pending === true);
  const spawn = seams.spawn ?? spawnSync;
  if (!mac) {
    try { runCommand('systemctl', ['--user', 'show-environment'], { env, spawn }); }
    catch (error) { fail(`the user systemd manager is not reachable (${error.message}). Run \`systemctl --user status\` to see why; a login session or \`loginctl enable-linger\` may be needed.`); }
  }
  const routeHome = previous?.gozar_home ?? pending?.home ?? gozarHome;
  const custody = previous?.route_custody ?? routeCustodyPath({ HOME: os.homedir(), ...env }, routeHome);
  const consent = seams.consent ?? (async () => fail('A durable route needs your explicit approval in a terminal.'));
  const setup = seams.setup && (candidate => seams.setup({ gozar, candidate, home: routeHome, env }));
  const allocateRoute = async origin => {
    if (pending) {
      const observed = await observeRetainedRoute(gozar, pending);
      if (observed.state === 'recorded') {
        const { view } = observed;
        if (view.cleanup.state === 'confirmed') fail('The retained Gozar operation has been closed. Run dalan service uninstall for this home before starting a new install.');
        if (view.hostConfiguration?.target?.known && view.hostConfiguration.target.value !== o.target.value) fail('The retained route targets a different local listener.');
        return view;
      }
    }
    const wanted = buildQuery({ home: routeHome, target: o.target.value, usage: { kind: 'durable', routeId: saved?.routeId ?? 'dalan-main' },
      route: o.route ?? saved?.routeName ?? undefined, origin, address: 'stable' });
    const { query, pick } = await resolveRouteWord({ gozar, query: wanted });
    const remember = ref => {
      pending = { ...ref, port: o.port };
      writeAtomic(pendingPath, JSON.stringify(pending));
    };
    return ensureDurableRoute({ gozar, query, pick, consent, setup, remember, recovery: pending });
  };
  if (allocate) {
    const view = await allocateRoute(saved?.origin ?? undefined);
    if (!view.origin) throw routeFailure(view, 'Gozar has not allocated an address for this service.');
    o = { ...o, origin: parseOrigin(view.origin) };
    allocated = view.handle;
  }
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (!homeScope.hasReceipt) writePrivate(receiptFile, `${JSON.stringify({ ...installReceipt(o.home, configDir, o, profile.workers), repo, node, unit_dir: unitDir, auto_update: autoUpdate, platform, route: o.route ?? saved?.routeName ?? null, gozar_home: routeHome, route_custody: custody, ...(allocated ? { route_handle: allocated } : {}) }, null, 2)}\n`);
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
    const changed = preflightAgentFile(plistFile, files[`${labels.service}.plist`]);
    if (changed) unloadAgent({ label: labels.service }, seams.launchd);
    writeAgentFile(plistFile, files[`${labels.service}.plist`]);
    if (lintPlist(plistFile, seams) === false) fail(`${plistFile} is not a valid property list`);
    const { kicked, detail } = loadAgent({ label: labels.service, plistFile, knownAbsent: changed }, seams.launchd);
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
  let routeReply;
  const existingHandle = allocated ?? previous?.route_handle;
  if (existingHandle) routeReply = await gozar.routeStatus({ home: routeHome, handle: existingHandle });
  else if (managed) routeReply = await allocateRoute(o.origin);
  else routeReply = (await registerExternalService({ gozar, home: routeHome, origin: o.origin, target: o.target.value,
    ...(o.verifyCmd ? { verifyCmd: o.verifyCmd } : {}) })).view;

  if (routeReply.origin !== o.origin) throw routeFailure(routeReply, 'Gozar returned a different address from the saved service origin.');
  const done = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (routeReply.handle && (JSON.stringify(done.route_handle) !== JSON.stringify(routeReply.handle) || done.gozar_home !== routeHome || done.route_custody !== custody)) {
    writeAtomic(receiptFile, `${JSON.stringify({ ...done, route_handle: routeReply.handle, gozar_home: routeHome, route_custody: custody }, null, 2)}\n`);
  }
  if (pending && readPendingInstall(pendingPath)?.operationId === pending.operationId) fs.rmSync(pendingPath, { force: true });
  if (!isPublished(routeReply)) throw routeFailure(routeReply, 'Gozar did not verify the route; the bridge is running and the route needs repair.');
  writeAtomic(homeFiles.resourceFile, `${routeReply.published}/${homeFiles.secret}/mcp\n`);
  await setAutoUpdate({ home: o.home, enabled: autoUpdate }, { ...seams, env, spawn, platform });
  if (!env.DALAN_HOME) recordDefaultHome(o.home, env);
  if (needsEnrollmentRestart) {
    const enrolled = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    delete enrolled.enrollment_pending;
    writeAtomic(receiptFile, `${JSON.stringify(enrolled, null, 2)}\n`);
  }
  return { schema_version: 1, origin: routeReply.published, home: o.home, unit: mac ? labels.service : `${name}.service`, already_installed: homeScope.hasReceipt && !needsEnrollmentRestart, units: Object.keys(files), port: o.port,
    workers: profile.workers, public_url: `${o.origin}/<secret>/mcp`, resource_url_file: homeFiles.resourceFile,
    target: o.target.value, started: true, route: routeReply, auto_update: autoUpdate };
}

// Stop the service and its update job, delete the generated definitions and the public route, and forget the default home.
// The home itself (secrets, grants, data) stays; delete it by hand if you also want that gone.
export async function uninstallService({ home, confirmRouteStop }, seams = {}) {
  const env = seams.env ?? process.env;
  home = path.resolve(home);
  return withRouteInstallLock(env, home, () => uninstallServiceLocked({ home, confirmRouteStop }, seams));
}

async function uninstallServiceLocked({ home, confirmRouteStop }, seams) {
  const env = seams.env ?? process.env, platform = seams.platform ?? process.platform, mac = platform === 'darwin';
  const receipt = readReceipt(home);
  const pendingPath = pendingInstallPath(env, home);
  const pending = readPendingInstall(pendingPath);
  if (receipt && (!receipt.unit || receipt.home !== home)) fail(`no Dalan service is installed for ${home}`);
  const removed = [];
  if (pending && !receipt?.route_handle) {
    const gozar = routeNotDispatched(pending) ? null : seams.gozar ?? await resolveGozar({ env, home: pending.home });
    const observed = await observeRetainedRoute(gozar, pending);
    if (observed.state === 'unobserved') fail('Gozar has not confirmed whether the retained operation started. Cleanup is unconfirmed; the reference was kept.');
    const view = observed.view;
    const subject = view?.handle ?? { operationId: pending.operationId };
    if (!confirmRouteStop || !await confirmRouteStop(subject)) fail('The saved route or pending operation requires explicit approval.');
    if (view && (view.state !== 'released' || view.cleanup.state !== 'confirmed')) {
      const result = await closeExactRoute(gozar, { ...pending, handle: view.handle });
      if (!result.removed) fail(`Public route removal is unconfirmed. Retained the install operation. ${result.detail}`);
    }
    fs.rmSync(pendingPath, { force: true });
    removed.push(view ? 'public route released' : 'pending route operation cancelled before dispatch');
    if (!receipt) return { home, removed, kept: 'No service home was created.', moved_to: null };
  }
  if (!receipt) fail(`no Dalan service is installed for ${home}`);
  const unitDir = receipt.unit_dir;
  if (!unitDir || !path.isAbsolute(unitDir)) fail('the service receipt names no unit directory');
  // Verify both jobs before removing either plist or disabling automatic updates.
  if (mac) for (const label of Object.values(launchdLabels(receipt.unit))) isLoaded(label, seams.launchd);
  if (receipt.route_handle) {
    const home = receipt.gozar_home ?? gozarHomeFor(env);
    const gozar = seams.gozar ?? await resolveGozar({ env, home, custody: receipt.route_custody });
    if (!confirmRouteStop || !await confirmRouteStop(receipt.route_handle)) fail('Public route stop requires explicit approval for the saved handle.');
    const result = await closeExactRoute(gozar, { home, handle: receipt.route_handle });
    if (!result.removed) fail(`Public route removal is unconfirmed. Retained the service receipt. ${result.detail}`);
    const file = path.join(defaultPath(receipt.home, '.config/dot-bridge'), 'service-install.json');
    const next = { ...receipt };
    delete next.route_handle;
    writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    if (pending?.handle && JSON.stringify(pending.handle) === JSON.stringify(receipt.route_handle)) fs.rmSync(pendingPath, { force: true });
    removed.push('public route released');
  }
  if (receipt.auto_update) { try { await setAutoUpdate({ home, enabled: false }, { ...seams, env, platform }); removed.push('automatic updates off'); } catch (error) { if (mac) throw error; removed.push(`update job not removed: ${error.message}`); } }
  if (mac) removed.push(...removeAgents({ unit: receipt.unit, unit_dir: unitDir }, seams.launchd));
  else {
    const spawn = seams.spawn ?? spawnSync, name = receipt.unit;
    const units = [`${name}.service`, `${name}-target.socket`, `${name}-target.service`, `${name}-update.service`, `${name}-update.timer`].filter(unit => fs.existsSync(path.join(unitDir, unit)));
    if (units.length) { spawn('systemctl', ['--user', 'disable', '--now', ...units], { encoding: 'utf8', env }); }
    for (const unit of units) { fs.rmSync(path.join(unitDir, unit)); removed.push(`removed ${path.join(unitDir, unit)}`); }
    spawn('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', env });
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
    (seams.out ?? console.log)('Usage: dalan service install --worker NAME [--route NAME] [--home DIR] [--enable-workspace] [--enable-t3] [--auto-update|--no-auto-update]\n       dalan service install --public-url https://HOST --port N --target HOST:PORT [--home DIR] [--lan-port N] [--worker NAME ...] [--verify-cmd COMMAND] [--write-units-only]   (an address you already serve)\n       dalan service uninstall [--home DIR]\n       dalan service migrate-workers --home DIR --source workers.json [--source workers.json ...]\n       dalan service update [--check|--yes] [--retry] [--home DIR] [--json]\n       dalan service auto-update on|off [--home DIR]\n       dalan service status [--home DIR] [--json]\n       dalan service recover --home DIR [--quiet]\nNew installs check daily with jitter. Catalog changes stage until --yes authorizes a connector refresh. --check reports availability without installing. Runs under systemd on Linux and launchd on macOS.');
    return null;
  }
  if (action === 'uninstall') {
    const parsed = parseArgs(args, { values: ['--home'], flags: ['--json', '--help'] });
    if (parsed['--help']) return serviceMain(['help'], seams);
    if (parsed._.length) fail(`unexpected argument ${parsed._[0]}`);
    const confirmRouteStop = seams.confirmRouteStop ?? (async handle => {
      if (!process.stdin.isTTY) return false;
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const question = handle.operationId ? `Cancel prepared Gozar operation ${handle.operationId}? [y/N] `
        : `Remove Gozar route ${handle.kind} ${handle.id} (generation ${handle.generation})? [y/N] `;
      try { return /^y(es)?$/i.test((await rl.question(question)).trim()); }
      finally { rl.close(); }
    });
    const result = await uninstallService({ home: parsed['--home'] ?? serviceHomeFor(seams.env ?? process.env), confirmRouteStop }, seams);
    const out = seams.out ?? console.log;
    if (parsed['--json']) out(JSON.stringify(result)); else { for (const line of result.removed) out(line); out(`Kept: ${result.kept}`); }
    return result;
  }
  if (action !== 'install') fail('use dalan service install, uninstall, update, auto-update, status, recover or migrate-workers');
  const o = parseOptions(args, seams.env ?? process.env);
  if (o.help) return serviceMain(['help'], seams);
  const out0 = seams.out ?? console.log;
  // Route consent is collected after showing the exact review returned by Gozar.
  const consent = seams.consent ?? (async candidate => {
    out0(describeCandidate(candidate).join('\n')); out0(describeDisclosure(candidate).join('\n'));
    if (!process.stdin.isTTY) { out0('Run this in a terminal to approve the route.'); return false; }
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question('Use this route? [y/N] ')).trim()); } finally { rl.close(); }
  });
  const setup = async request => {
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    if (!tty) return request.candidate.setup.state === 'ready';
    const { createInterface } = await import('node:readline/promises');
    const terminal = muteableTerminal(process.stdin, process.stdout);
    const rl = createInterface({ input: process.stdin, output: terminal.output, terminal: terminal.terminal });
    try {
      return await runRouteSetup({ ...request, say: out0, ask: message => rl.question(message), async askSecret(label) {
        process.stdout.write(`${label} (hidden): `);
        terminal.mute(true);
        try { return Buffer.from(await rl.question('')); }
        finally { terminal.mute(false); process.stdout.write('\n'); }
      }, handoff: href => process.stdout.write(`${href}\n`) });
    } finally { rl.close(); }
  };
  const result = await installService(o, { ...seams, consent, setup });
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
