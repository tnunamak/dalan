import fs from 'node:fs';
import { controlLaunchd } from './service-launchd.mjs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultPath } from './paths.mjs';
import { initAsFiles } from './as-files.mjs';

const PACKAGE = '@tnunamak/dalan';
const PUBLIC_REGISTRY = 'https://registry.npmjs.org';
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TIMEOUT = 30_000;
const fail = message => { throw new Error(message); };
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

// npm 12 refuses a remote tarball URL as a dependency (allow-remote defaults to none), so the updater fetches the tarball itself,
// checks every byte against the registry's sha512 integrity, and hands npm only a local file. Works the same on npm 10, 11 and 12.
async function fetchTarball(url, integrity, { timeout = 120_000, fetchImpl = fetch } = {}) {
  let bytes;
  if (/^file:\/\//.test(url)) bytes = fs.readFileSync(fileURLToPath(url));
  else {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) fail(`release tarball download failed (${response.status})`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_TARBALL_BYTES) fail('release tarball is too large');
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length > MAX_TARBALL_BYTES) fail('release tarball is too large');
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) fail('release tarball integrity does not match registry metadata');
  return bytes;
}

function validRelease(value, { allowLocalTarball = false } = {}) {
  const localTarball = typeof value?.dist?.tarball === 'string' && (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(value.dist.tarball) || /^file:\/\//.test(value.dist.tarball));
  let productionTarball = false;
  try { const url = new URL(value?.dist?.tarball); productionTarball = url.protocol === 'https:' && url.hostname === 'registry.npmjs.org'; } catch { /* checked below */ }
  if (!value || value.name !== PACKAGE || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version ?? '') ||
      !value.dist || typeof value.dist.tarball !== 'string' || (!productionTarball && !(allowLocalTarball && localTarball)) ||
      typeof value.dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.dist.integrity)) {
    fail('npm registry returned invalid Dalan release metadata');
  }
  return { name: value.name, version: value.version, dist: { tarball: value.dist.tarball, integrity: value.dist.integrity } };
}

function requestJson(url, { timeout = TIMEOUT, socketPath, headers = {}, allowHttp = false } = {}) {
  return new Promise((resolve, reject) => {
    let absoluteTimer, settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      fn(value);
    };
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    if (target.protocol !== 'https:' && !socketPath && !(allowHttp && target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) return finish(reject, new Error('HTTPS required'));
    const req = transport.request({ ...(socketPath ? { socketPath, path: url } : { hostname: target.hostname, port: target.port || undefined, path: target.pathname + target.search }), method: 'GET', headers, timeout }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('response too large')); else chunks.push(chunk); });
      res.on('aborted', () => finish(reject, new Error('response ended before completion')));
      res.on('error', error => finish(reject, error));
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(reject, Object.assign(new Error(`request failed (${res.statusCode})`), { statusCode: res.statusCode }));
        try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(reject, new Error('invalid JSON response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', error => finish(reject, error));
    absoluteTimer = setTimeout(() => req.destroy(new Error('request timed out')), timeout);
    req.end();
  });
}

function run(command, args, { cwd, env, timeout = TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', done = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length); });
    child.on('error', error => { if (done) return; done = true; clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { if (done) return; done = true; clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${signal || code})${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : ''}`)); });
  });
}

export async function latestRelease(_receipt, { registry = PUBLIC_REGISTRY } = {}) {
  const localTestRegistry = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(registry);
  if (!/^https:\/\//.test(registry) && !localTestRegistry) fail('npm registry must use HTTPS');
  const metadata = await requestJson(`${registry.replace(/\/$/, '')}/@tnunamak%2fdalan/latest`, { allowHttp: localTestRegistry });
  return validRelease(metadata, { allowLocalTarball: localTestRegistry });
}

function packageAt(home, version) { return path.join(home, 'versions', version, 'node_modules', '@tnunamak', 'dalan'); }
function installEnv(dir) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, npm_config_userconfig: path.join(dir, '.npmrc'), npm_config_cache: path.join(dir, '.cache') };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  return env;
}

export async function installRelease(home, input, options = {}) {
  const localTestRegistry = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(options.registry ?? '');
  const release = validRelease(input, { allowLocalTarball: localTestRegistry }), versions = path.join(home, 'versions'), destination = packageAt(home, release.version);
  fs.mkdirSync(versions, { recursive: true, mode: 0o700 });
  const marker = path.join(path.dirname(path.dirname(path.dirname(destination))), '.dalan-release.json');
  if (fs.existsSync(destination)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { fail(`installed version ${release.version} has no valid integrity receipt`); }
    const pkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
    if (existing.integrity !== release.dist.integrity || pkg.name !== PACKAGE || pkg.version !== release.version) fail(`installed version ${release.version} does not match registry integrity`);
    return destination;
  }
  const staging = path.join(versions, `.stage-${release.version}-${process.pid}-${randomBytes(5).toString('hex')}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const registry = options.registry ?? PUBLIC_REGISTRY;
  if (!/^https:\/\//.test(registry) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(registry)) fail('npm registry must use HTTPS');
  try {
    const tarballName = `dalan-${release.version}.tgz`;
    fs.writeFileSync(path.join(staging, tarballName), await fetchTarball(release.dist.tarball, release.dist.integrity, { timeout: options.timeout, fetchImpl: options.fetch }), { mode: 0o600 });
    const pkg = { private: true, name: 'dalan-release-stage', version: '1.0.0', dependencies: { [PACKAGE]: `file:./${tarballName}` } };
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg), { mode: 0o600 });
    const env = installEnv(staging), npm = options.npm ?? 'npm';
    const base = ['--ignore-scripts', '--no-audit', '--no-fund', '--registry', registry];
    await (options.run ?? run)(npm, ['install', '--package-lock-only', ...base], { cwd: staging, env, timeout: options.timeout ?? TIMEOUT });
    const lock = JSON.parse(fs.readFileSync(path.join(staging, 'package-lock.json'), 'utf8'));
    if (lock.packages?.[`node_modules/${PACKAGE}`]?.integrity !== release.dist.integrity) fail('npm lock integrity does not match registry metadata');
    await (options.run ?? run)(npm, ['ci', ...base, '--omit=dev'], { cwd: staging, env, timeout: options.timeout ?? TIMEOUT });
    const installed = JSON.parse(fs.readFileSync(path.join(staging, 'node_modules', PACKAGE, 'package.json'), 'utf8'));
    if (installed.name !== PACKAGE || installed.version !== release.version) fail('installed package identity does not match registry metadata');
    fs.writeFileSync(path.join(staging, '.dalan-release.json'), JSON.stringify({ name: PACKAGE, version: release.version, integrity: release.dist.integrity }), { mode: 0o600 });
    fs.rmSync(path.join(staging, '.cache'), { recursive: true, force: true });
    fs.rmSync(path.join(staging, '.npmrc'), { force: true });
    fs.rmSync(path.join(staging, tarballName), { force: true });
    fs.renameSync(staging, path.join(versions, release.version));
    return destination;
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
}

function validateProbe(value, { expectedWorkers, expectedVersion } = {}) {
  if (!value || typeof value !== 'object' || typeof value.version !== 'string' || value.update_protocol !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || value.self_check !== true ||
      !value.catalogs || typeof value.catalogs !== 'object' || Array.isArray(value.catalogs) || !Object.keys(value.catalogs).length) fail('service self-check response is incomplete');
  for (const [worker, tools] of Object.entries(value.catalogs)) {
    const names = new Set();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(worker) || !Array.isArray(tools) || !tools.length || tools.some(tool => {
      if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name) || typeof tool.description !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object') return true;
      names.add(tool.name); return false;
    })) fail('service self-check returned an invalid worker catalog');
  }
  if (expectedWorkers && JSON.stringify(Object.keys(value.catalogs).sort()) !== JSON.stringify([...expectedWorkers].sort())) fail('service self-check worker set does not match configuration');
  if (expectedVersion && value.version !== expectedVersion) fail('service self-check version does not match selected package');
  return value;
}

function expectedProbe(home, receipt, repo) {
  const workers = JSON.parse(fs.readFileSync(defaultPath(home, '.config/dot-bridge', 'workers.json'), 'utf8'))?.workers;
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) fail('worker configuration is invalid for service self-check');
  const packageDir = repo ?? receipt?.repo ?? path.join(home, 'current');
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  return { expectedWorkers: Object.keys(workers), expectedVersion: manifest.version };
}

export async function probeService(home, _receipt, options = {}) {
  const socketPath = defaultPath(home, '.local/share/dot-bridge', 'admin.sock');
  const operator = fs.readFileSync(defaultPath(home, '.config/dot-bridge', 'operator.key'), 'utf8').trim();
  if (!operator || operator.length > 1024) fail('service operator key is invalid');
  const timeout = options.timeout ?? TIMEOUT;
  if (!Number.isFinite(timeout) || timeout <= 0) fail('service probe timeout must be positive');
  const deadline = performance.now() + timeout;
  const expected = expectedProbe(home, _receipt);
  let value;
  try { value = validateProbe(await requestJson('http://localhost/service-check', { socketPath, headers: { 'x-operator-key': operator }, timeout }), expected); }
  catch (error) {
    // A 0.6.0 or 0.6.1 server answers on its admin socket but has no /service-check. That is a running legacy server with no update gate:
    // the updater stops it, switches the package and starts it again. Its catalogs are unknown, so none are compared.
    if (error.statusCode !== 404 || !_receipt?.port) throw error;
    const left = deadline - performance.now();
    if (left <= 0) fail('service probe timed out');
    await checkLoopback(_receipt.port, left);
    return { legacy: true, version: expected.expectedVersion, update_protocol: 0, port: _receipt.port, self_check: false, catalogs: null };
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) fail('service probe timed out');
  await checkLoopback(value.port, remaining);
  return value;
}

function checkLoopback(port, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => socket.destroy(new Error('service listener check timed out')), timeout);
    socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(new Error(`reported loopback listener is unavailable: ${error.message}`)); });
  });
}

// The candidate runs before promotion and may be incompatible or hostile. It receives configuration shape (workers, public origin)
// but never a live secret: signing keys, cookie keys, the storage key and the operator key are generated fresh for each probe.
function prepareProbeConfig(from, to) {
  const source = defaultPath(from, '.config/dot-bridge'), target = defaultPath(to, '.config/dot-bridge');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ['workers.json', 'workers-repos.json']) {
    const a = path.join(source, name); if (!fs.existsSync(a)) continue;
    const stat = fs.lstatSync(a); if (!stat.isFile() || stat.isSymbolicLink()) continue;
    fs.copyFileSync(a, path.join(target, name), fs.constants.COPYFILE_EXCL); fs.chmodSync(path.join(target, name), stat.mode & 0o777);
  }
  const origin = JSON.parse(fs.readFileSync(path.join(source, 'as.json'), 'utf8'));
  initAsFiles(target, { publicUrl: origin.public_url });
  fs.writeFileSync(path.join(target, 'as.json'), JSON.stringify({ ...origin, public_url: origin.public_url }), { mode: 0o600 });
  fs.writeFileSync(path.join(target, 'operator.key'), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.spawned === false) return;
  if (!child.pid) return;
  child.kill('SIGTERM');
  let timer;
  await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null && child.spawned !== false) await new Promise(resolve => child.once('close', resolve));
}

async function requireCatalogGuard(repo, env, receipt, options) {
  const child = (options.spawn ?? spawn)(receipt.node ?? process.execPath, [path.join(repo, 'src/server.mjs')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let spawnError = null, closed = false;
  child.on('error', error => { spawnError = error; });
  child.once('close', () => { closed = true; });
  child.stdout?.on('data', chunk => { if (stdout.length < 8192) stdout += chunk.toString().slice(0, 8192 - stdout.length); });
  child.stderr?.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length); });
  try {
    const deadline = Date.now() + (options.guardTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      if (spawnError) fail(`candidate service could not start: ${spawnError.message}`);
      if (/MCP listening|admin socket/.test(stdout)) fail('candidate started despite mismatched service catalog pin');
      if (closed) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!closed) fail('candidate did not enforce the service catalog pin before timeout');
    if (/MCP listening|admin socket/.test(stdout)) fail('candidate announced a listener before enforcing the service catalog pin');
    if (child.exitCode === 0 || !stderr.includes('service catalog guard mismatch')) fail('candidate did not reject the mismatched service catalog pin');
  } finally { await stopChild(child); }
}

export async function probeCandidate(home, receipt, repo, options = {}) {
  const scratchBase = path.join(os.homedir(), '.tmp');
  fs.mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(scratchBase, 'dalan-candidate-'));
  fs.chmodSync(scratch, 0o700);
  let child;
  try {
    prepareProbeConfig(home, scratch);
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, NODE_ENV: 'production', DALAN_AUTH_MODE: 'builtin', DALAN_BIND_HOST: '127.0.0.1', DALAN_PORT: '0', DALAN_CATALOG_PROFILE: 'stable', DALAN_ENABLE_WORKSPACE: receipt.enable_workspace ? '1' : '0', DALAN_ENABLE_T3_TOOLS: receipt.enable_t3 ? '1' : '0' };
    const configDir = defaultPath(scratch, '.config/dot-bridge');
    const pinFile = path.join(configDir, 'service-catalog.json');
    const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
    fs.writeFileSync(pinFile, JSON.stringify({ version, catalogs: {} }), { mode: 0o600, flag: 'wx' });
    try { await requireCatalogGuard(repo, env, receipt, options); }
    finally { fs.rmSync(pinFile, { force: true }); }
    child = (options.spawn ?? spawn)(receipt.node ?? process.execPath, [path.join(repo, 'src/server.mjs')], { cwd: repo, env, stdio: ['ignore', 'ignore', 'ignore'] });
    let spawnError = null, closed = false;
    child.on('error', error => { spawnError = error; });
    child.once('close', () => { closed = true; });
    const deadline = Date.now() + (options.startupTimeoutMs ?? 20_000);
    let result;
    while (Date.now() < deadline) {
      if (spawnError) fail(`candidate service could not start: ${spawnError.message}`);
      if (closed) fail('candidate service exited before self-check');
      if (child.exitCode !== null || child.signalCode !== null) fail('candidate service exited before self-check');
      try { result = await probeService(scratch, { ...receipt, repo }); break; } catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    if (!result) fail('candidate service did not pass its self-check before timeout');
    return result;
  } finally {
    await stopChild(child);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function controlService(receipt, action, options = {}) {
  if (!['stop', 'restart', 'daemon-reload'].includes(action)) fail('unsupported service action');
  const unit = String(receipt.unit ?? '');
  if (!/^[A-Za-z0-9_.@-]+$/.test(unit)) fail('invalid service unit name');
  if (receipt.platform === 'darwin') { (options.launchd ?? controlLaunchd)(receipt, action, options.launchdSeams); return; }
  const name = unit.endsWith('.service') ? unit : `${unit}.service`;
  await (options.run ?? run)('systemctl', ['--user', action, ...(action === 'daemon-reload' ? [] : [name])], { timeout: TIMEOUT });
}
