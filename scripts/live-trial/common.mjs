import { defaultPath } from '../../src/paths.mjs';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const MANIFEST_NAME = 'live-trial.json';
export const RESOURCE_URL_FILE = 'resource-url';
export const JOBS_FILE = 'jobs.json';
export const MANIFEST_PATH = home => path.join(home, MANIFEST_NAME);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseArgs(argv, { values = [], flags = [] } = {}) {
  const valueNames = new Set(values);
  const flagNames = new Set(flags);
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const equals = raw.indexOf('=');
    const name = equals < 0 ? raw : raw.slice(0, equals);
    if (valueNames.has(name)) {
      const value = equals < 0 ? argv[++i] : raw.slice(equals + 1);
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      result[name] = value;
    } else if (flagNames.has(name)) {
      if (equals >= 0) throw new Error(`${name} does not take a value`);
      result[name] = true;
    } else if (raw.startsWith('--')) {
      throw new Error(`unknown option ${name}`);
    } else {
      result._.push(raw);
    }
  }
  return result;
}

export function writeJsonPrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function readJson(file, what = 'JSON file') {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${what} is missing or invalid`); }
}

export function readManifest(home) {
  const absoluteHome = path.resolve(home);
  const manifest = readJson(MANIFEST_PATH(absoluteHome), 'trial manifest');
  if (manifest.schema_version !== 1 || manifest.kind !== 'dot-bridge-live-trial' || manifest.home !== absoluteHome) {
    throw new Error('trial manifest does not own this home');
  }
  if (!Array.isArray(manifest.pids) || !manifest.pids.every(Number.isInteger)) throw new Error('trial manifest has invalid process ids');
  if (manifest.resource_url_file !== RESOURCE_URL_FILE) throw new Error('trial manifest has an invalid resource URL file');
  return manifest;
}

export function resourceUrlFromManifest(manifest) {
  if (manifest.resource_url_file !== RESOURCE_URL_FILE) {
    throw new Error('trial manifest has an invalid resource URL file');
  }
  let value;
  const file = path.join(manifest.home, RESOURCE_URL_FILE);
  try {
    if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error('wrong mode');
    value = fs.readFileSync(file, 'utf8').trim();
  }
  catch { throw new Error('private resource URL file is missing or unreadable'); }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('private resource URL file is invalid'); }
  const issuer = new URL(manifest.public_url);
  if (parsed.origin !== issuer.origin || parsed.search || parsed.hash || parsed.username || parsed.password
    || !/^\/[a-f0-9]{64}\/mcp$/.test(parsed.pathname)) {
    throw new Error('private resource URL does not match the trial issuer');
  }
  return value;
}

export function readJobs(manifest) {
  if (!manifest.jobs_file) throw new Error('no trial jobs have been submitted');
  const jobs = readJson(path.join(manifest.home, manifest.jobs_file), 'trial job state');
  if (jobs.worker !== manifest.worker || !jobs.worker_request_id || !jobs.dot_request_id || !jobs.nonce) {
    throw new Error('trial job state is invalid');
  }
  return jobs;
}

export function runDot(home, args, { input, timeout = 30_000, env = {} } = {}) {
  const result = spawnSync(process.execPath, [path.join(REPO, 'bin/dalan.mjs'), ...args], {
    cwd: REPO,
    env: { HOME: home, PATH: process.env.PATH ?? '', ...env },
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { status: result.status, error: result.error, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function dotJson(home, args, options = {}) {
  const result = runDot(home, args, options);
  if (result.error || result.status !== 0) throw new Error(`dalan ${args[0] ?? 'command'} failed`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`dalan ${args[0] ?? 'command'} returned invalid JSON`); }
}

export function fileList(root) {
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      files.push(relative);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return files.sort();
}

export function bridgeSecret(home) {
  const envFile = defaultPath(home,'.config/dot-bridge/env');
  const contents = fs.readFileSync(envFile, 'utf8');
  const secret = /^BRIDGE_PATH_SECRET=([a-f0-9]{64})$/m.exec(contents)?.[1];
  if (!secret) throw new Error('bridge path secret is missing or invalid');
  return secret;
}

export function localMcpPath(manifest) {
  const publicUrl = new URL(manifest.public_url);
  const resourceUrl = new URL(resourceUrlFromManifest(manifest));
  return { path: resourceUrl.pathname, host: publicUrl.host };
}

// Always connects to 127.0.0.1. The Host header is the configured issuer host so the
// built-in AS keeps its canonical-host check when a future operator uses a reverse proxy.
export async function mcpRpc(manifest, bearer, method, params = {}) {
  const endpoint = localMcpPath(manifest);
  const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: manifest.port,
      path: endpoint.path,
      method: 'POST',
      headers: {
        host: endpoint.host,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      timeout: 5_000,
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* returned as a null body */ }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('loopback MCP request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function mcpTool(manifest, bearer, name, args = {}) {
  const response = await mcpRpc(manifest, bearer, 'tools/call', { name, arguments: args });
  if (response.status !== 200) return { status: response.status, isError: true, value: null, text: '' };
  const result = response.body?.result;
  const text = result?.content?.find(item => item.type === 'text')?.text ?? '';
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { /* the caller can check isError */ }
  return { status: response.status, isError: result?.isError === true, value, text };
}

export async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function isLoopbackPortClosed(port) {
  return await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = closed => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
  });
}

export function processExists(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw new Error(`could not inspect process ${pid} liveness (${error.code ?? 'unknown'})`);
  }
}

export function processCommand(pid, { kill = process.kill, spawn = spawnSync } = {}) {
  if (!processExists(pid, kill)) return null;
  const result = spawn('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 8_192 });
  if (result.error || result.status !== 0) {
    // ps can race with process exit. Only the kernel liveness check can prove it is gone.
    if (!processExists(pid, kill)) return null;
    throw new Error(`could not inspect process ${pid} command (${result.error?.code ?? `exit ${result.status ?? 'unknown'}`})`);
  }
  const command = (result.stdout ?? '').trim();
  if (!command) throw new Error(`could not inspect process ${pid} command (empty result)`);
  return command;
}

export function assertLoopbackListener(pid, port) {
  const result = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 8_192,
  });
  if (result.error || result.status !== 0) throw new Error('could not prove the bridge listener belongs to its manifest process');

  const processes = (result.stdout ?? '').split('\n').filter(line => line.startsWith('p')).map(line => line.slice(1));
  const listeners = (result.stdout ?? '').split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  if (processes.length !== 1 || processes[0] !== String(pid)
    || listeners.length !== 1 || listeners[0] !== `127.0.0.1:${port}`) {
    throw new Error('bridge listener is not exclusively bound to 127.0.0.1 by its manifest process');
  }
}

export function manifestProcessAlive(manifest) {
  return manifest.pids.some(pid => processCommand(pid)?.includes(manifest.process_title) ?? false);
}

export async function waitForManifestProcesses(manifest, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!manifestProcessAlive(manifest)) return true;
    await sleep(100);
  }
  return !manifestProcessAlive(manifest);
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function trialHome(worker, suffix = randomUUID().slice(0, 8)) {
  return path.resolve(os.homedir(), '.tmp', `live-trial-${worker}-${Date.now()}-${suffix}`);
}
