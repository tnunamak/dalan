import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { defaultPath } from './paths.mjs';
import { initAsFiles, writeAtomic } from './as-files.mjs';
import { parseWorkers } from './workers.mjs';
import { parseArgs } from '../scripts/live-trial/common.mjs';
import { resolveGozarCommand } from './try-exposure.mjs';
import { autoUpdateUnits, setAutoUpdate } from './service-auto-update.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
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
    values: ['--home', '--public-url', '--port', '--target', '--worker', '--verify-cmd', '--gozar-bin', '--lan-port'],
    flags: ['--write-units-only', '--enable-workspace', '--enable-t3', '--auto-update', '--no-auto-update', '--json', '--help'],
  });
  if (parsed._.length) fail(`unexpected argument ${parsed._[0]}`);
  if (parsed['--help']) return { help: true };
  if (parsed['--auto-update'] && parsed['--no-auto-update']) fail('choose --auto-update or --no-auto-update');
  const home = path.resolve(parsed['--home'] ?? path.join(os.homedir(), '.local/share/dalan-service'));
  if (!SAFE_PATH.test(home)) fail('--home contains characters that cannot be written safely in a systemd unit');
  const origin = parseOrigin(parsed['--public-url']);
  const port = Number(parsed['--port']);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be a fixed port from 1024 through 65535');
  const target = parseTarget(parsed['--target']);
  const lanPort = parsed['--lan-port'] === undefined ? null : Number(parsed['--lan-port']);
  validateTopology({ port, target, lanPort, verifyCmd: parsed['--verify-cmd'] });
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
  const gozarBin = parsed['--gozar-bin'];
  if (gozarBin !== undefined && (!gozarBin || gozarBin.startsWith('-'))) fail('--gozar-bin must name a command');
  return { home, origin, port, target, lanPort, enableWorkspace: parsed['--enable-workspace'] === true, enableT3: parsed['--enable-t3'] === true, workers, verifyCmd: parsed['--verify-cmd'] ?? null,
    gozarBin, autoUpdate: parsed['--auto-update'] ? true : parsed['--no-auto-update'] ? false : undefined,
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

function unitName(home) { return `dalan-${createHash('sha256').update(home).digest('hex').slice(0, 10)}`; }

function unitFiles(o, { home, repo = REPO, node = nodePath(process.execPath), proxy = null } = {}) {
  const name = unitName(home);
  for (const [label, value] of [['home', home], ['repo', repo], ['node', node]]) {
    if (!SAFE_PATH.test(value)) fail(`${label} contains characters that cannot be written safely in a systemd unit`);
  }
  const base = {
    [`${name}.service`]: [
      '[Unit]', 'Description=Dalan worker bridge', 'After=network-online.target', '', '[Service]',
      `WorkingDirectory=${repo}`, `ExecStart=${node} ${path.join(repo, 'src/server.mjs')}`,
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
  const rootAllowed = ['.config', '.local', '.tmp', 'resource-url', 'current', 'versions', 'update-result.json', 'update-transaction.json', 'update-backup', 'update-lock.sqlite', 'update-lock.sqlite-journal'];
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
  if (!hasReceipt && rootEntries.some(name => !['.config', '.local', '.tmp', 'resource-url'].includes(name))) fail(`${home} contains update data without a service receipt`);
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
  if ((seams.platform ?? process.platform) !== 'linux') fail('dalan service install currently requires Linux with a systemd user manager');
  if (!path.isAbsolute(o.home) || !SAFE_PATH.test(o.home)) fail('--home must be an absolute systemd-safe path');
  const target = parseTarget(typeof o.target === 'string' ? o.target : `${o.target?.host}:${o.target?.port}`);
  o = { ...o, target };
  validateTopology(o);
  assertRealDirectoryPath(path.dirname(o.home), { owner: true });
  assertRealDirectoryPath(o.home, { owner: true });
  const profile = profileFor(o.home, o.workers ?? []);
  assertRealDirectoryPath(path.dirname(profile.file));
  const unitDir = path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config'), 'systemd/user');
  assertRealDirectoryPath(unitDir, { owner: true });
  const configDir = path.dirname(profile.file);
  const homeScope = checkHomeScope(o.home, configDir, o, profile.workers);
  const proxy = o.target.host === '127.0.0.1' && o.target.port === o.port ? null : (seams.proxy ?? findProxy());
  const repo = seams.repo ?? REPO, node = seams.node ?? nodePath(process.execPath);
  const receiptFile = homeScope.receiptFile;
  const previous = homeScope.hasReceipt ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  const autoUpdate = o.autoUpdate ?? previous?.auto_update ?? !homeScope.hasReceipt;
  const current = path.join(o.home, 'current');
  const hasCurrent = fs.existsSync(current) || (() => { try { fs.lstatSync(current); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } })();
  if (hasCurrent && !fs.lstatSync(current).isSymbolicLink()) fail(`${current} must be the service package symlink`);
  const { files, enable, name } = unitFiles(o, { home: o.home, repo: current, node, proxy });
  const updateUnits = autoUpdateUnits({ home: o.home, unit: name, node });
  Object.assign(files, updateUnits.files);
  let replaceLegacyUnit = false;
  // Check every collision before creating the bridge home or the first unit file.
  for (const [filename, text] of Object.entries(files)) {
    const file = path.join(unitDir, filename);
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== text)) {
      const actual = fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : '';
      const oldRepo = actual.match(/^WorkingDirectory=(.+)$/m)?.[1];
      const oldNode = actual.match(/^ExecStart=(\S+) /m)?.[1];
      const expected = filename === `${name}.service` && previous && oldRepo && oldNode && SAFE_PATH.test(oldRepo) && SAFE_PATH.test(oldNode)
        ? unitFiles(o, { home: o.home, repo: oldRepo, node: oldNode, proxy }).files[filename] : null;
      // Only the exact former generated unit can be enrolled or retried after interruption.
      if (expected && actual === expected) replaceLegacyUnit = true;
      else fail(`${file} already exists with different contents; refusing to overwrite it`);
    }
  }
  if (o.writeUnitsOnly) {
    if (replaceLegacyUnit) fail('rerun without --write-units-only to enroll an existing service for updates');
    writeUnits(unitDir, files);
    return { schema_version: 1, home: o.home, unit: `${name}.service`, units: Object.keys(files), target: o.target.value, started: false, route: null };
  }
  // An explicit --gozar-bin wins; otherwise the bundled Gozar, GOZAR_BIN, then PATH.
  const gozar = o.gozarBin !== undefined ? { binary: o.gozarBin, args: [] }
    : resolveGozarCommand({ env, resolveBundled: seams.resolveBundled, which: seams.which });
  if (!gozar.binary) fail('Gozar is unavailable; reinstall @tnunamak/dalan with its dependencies, or install gozar on PATH or set GOZAR_BIN to an executable path, then retry service install.');
  assertGozarStatePath(env);
  const needsEnrollmentRestart = replaceLegacyUnit || !!previous && (!previous.repo || previous.enrollment_pending === true);
  const spawn = seams.spawn ?? spawnSync;
  runCommand('systemctl', ['--user', 'show-environment'], { env, spawn });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (!homeScope.hasReceipt) writePrivate(receiptFile, `${JSON.stringify({ ...installReceipt(o.home, configDir, o, profile.workers), repo, node, unit_dir: unitDir, auto_update: autoUpdate }, null, 2)}\n`);
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
  writeUnits(unitDir, files);
  runCommand('systemctl', ['--user', 'daemon-reload'], { env, spawn });
  runCommand('systemctl', ['--user', 'enable', '--now', ...enable], { env, spawn });
  if (needsEnrollmentRestart) runCommand('systemctl', ['--user', 'restart', `${name}.service`], { env, spawn });
  const dataDir = defaultPath(o.home, '.local/share/dot-bridge');
  const ready = await (seams.waitForSocket ?? socketIsReady)(path.join(dataDir, 'admin.sock'), seams.socketTimeoutMs ?? 30000);
  if (!ready) fail(`Dalan did not start on its admin socket; the unit and home remain for inspection: systemctl --user status ${name}.service`);
  const gozarArgs = ['service', 'add', '--origin', o.origin, '--target', o.target.value];
  if (o.verifyCmd) gozarArgs.push('--verify-cmd', o.verifyCmd);
  gozarArgs.push('--json');
  const output = runCommand(gozar.binary, [...gozar.args, ...gozarArgs], { env, spawn, timeout: 120000 });
  let routeReply;
  try { routeReply = JSON.parse(output); } catch { fail('Gozar returned invalid JSON for service add; the bridge is running but its route is unverified'); }
  if (routeReply?.schemaVersion !== 1 || routeReply?.route?.origin !== o.origin || routeReply?.route?.target !== o.target.value) {
    fail('Gozar returned a service route that does not match the requested origin and target; the bridge is running but its route is unverified');
  }
  if (routeReply.route.verification?.status !== 'verified') {
    fail(`Gozar did not verify the service route; the bridge is running and the service route needs repair: ${JSON.stringify(routeReply).slice(0, 1500)}`);
  }
  await setAutoUpdate({ home: o.home, enabled: autoUpdate }, { ...seams, env, spawn });
  if (needsEnrollmentRestart) {
    const enrolled = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    delete enrolled.enrollment_pending;
    writeAtomic(receiptFile, `${JSON.stringify(enrolled, null, 2)}\n`);
  }
  return { schema_version: 1, home: o.home, unit: `${name}.service`, units: Object.keys(files), port: o.port,
    workers: profile.workers, public_url: `${o.origin}/<secret>/mcp`, resource_url_file: homeFiles.resourceFile,
    target: o.target.value, started: true, route: routeReply.route, auto_update: autoUpdate };
}

export async function serviceMain(argv, seams = {}) {
  const [action, ...args] = argv;
  if (action === 'migrate-workers') {
    const { migrationMain } = await import('./service-migrate-workers.mjs');
    return migrationMain(args);
  }
  if (['update', 'status', 'auto-update'].includes(action)) {
    const parsed = parseArgs(args, { values: ['--home'], flags: ['--check', '--yes', '--json', '--help'] });
    if (parsed['--help']) return serviceMain(['help'], seams);
    const home = path.resolve(parsed['--home'] ?? path.join(os.homedir(), '.local/share/dalan-service'));
    let result;
    if (action === 'auto-update') {
      if (parsed._.length !== 1 || !['on', 'off'].includes(parsed._[0]) || parsed['--check'] || parsed['--yes']) fail('use dalan service auto-update on|off [--home DIR]');
      result = await setAutoUpdate({ home, enabled: parsed._[0] === 'on' }, seams);
    } else {
      if (parsed._.length) fail(`unexpected argument ${parsed._[0]}`);
      if (parsed['--check'] && parsed['--yes']) fail('--check cannot be used with --yes');
      if (action === 'status' && (parsed['--check'] || parsed['--yes'])) fail('service status does not accept --check or --yes');
      const updater = await import('./service-update.mjs');
      result = await updater[action === 'status' ? 'serviceStatus' : 'updateService']({ home, check: !!parsed['--check'], yes: !!parsed['--yes'] }, seams);
    }
    (seams.out ?? console.log)(parsed['--json'] ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return result;
  }
  if (action === 'help' || action === '--help' || !action) {
    (seams.out ?? console.log)('Usage: dalan service install --home DIR --public-url https://HOST --port N --target HOST:PORT [--lan-port N] [--enable-workspace] [--enable-t3] [--worker NAME ...] [--verify-cmd COMMAND] [--auto-update|--no-auto-update] [--write-units-only]\n       dalan service migrate-workers --home DIR --source workers.json [--source workers.json ...]\n       dalan service update [--check|--yes] [--home DIR] [--json]\n       dalan service auto-update on|off [--home DIR]\n       dalan service status [--home DIR] [--json]\nNew installs check daily with jitter. Catalog changes stage until --yes authorizes a connector refresh. --check reports availability without installing. Linux systemd only.');
    return null;
  }
  if (action !== 'install') fail('use dalan service install or dalan service migrate-workers');
  const o = parseOptions(args, seams.env ?? process.env);
  if (o.help) return serviceMain(['help'], seams);
  const result = await installService(o, seams);
  if (o.json) (seams.out ?? console.log)(JSON.stringify(result));
  else {
    (seams.out ?? console.log)(`Service: ${result.unit} (${result.started ? 'active' : 'unit files written'})`);
    (seams.out ?? console.log)(`Home: ${result.home}`);
    (seams.out ?? console.log)(`Public MCP URL: ${result.public_url ?? `${o.origin}/<secret>/mcp`}`);
    (seams.out ?? console.log)(`Private URL file: ${result.resource_url_file ?? path.join(result.home, 'resource-url')}`);
    (seams.out ?? console.log)(`Gozar target: ${result.target}`);
    if (result.route) (seams.out ?? console.log)(`Gozar route: ${result.route.verification.status}`);
  }
  return result;
}

export { parseOrigin, parseTarget, unitFiles };
