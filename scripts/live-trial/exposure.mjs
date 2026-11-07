import path from 'node:path';
import { isIP } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MANIFEST_PATH, processCommand, sleep, writeJsonPrivate } from './common.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const CUTOFF_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'exposure-cutoff.mjs');
const HTTP_HANDLER_KEYS = new Set(['Path', 'Proxy', 'Text', 'AcceptAppCaps', 'Redirect']);
const TCP_HANDLER_KEYS = new Set(['HTTP', 'HTTPS', 'TCPForward', 'TerminateTLS', 'ProxyProtocol']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function socketArgs(exposure) {
  return exposure.mode === 'linux-second-node' ? ['--socket', exposure.tailscale_socket] : [];
}

export function validateExposure(exposure, localPort) {
  if (!isRecord(exposure)) throw new Error('trial exposure metadata is invalid');
  if (!['mac-funnel', 'linux-second-node'].includes(exposure.mode)) {
    throw new Error('trial exposure mode is invalid');
  }
  if (exposure.public_port !== 443 || exposure.local_port !== localPort) {
    throw new Error('trial exposure ports do not match the manifest');
  }
  if (exposure.mode === 'linux-second-node') {
    if (typeof exposure.tailscale_socket !== 'string' || !path.isAbsolute(exposure.tailscale_socket)) {
      throw new Error('trial second-node socket path is missing or invalid');
    }
  } else if (exposure.tailscale_socket !== null) {
    throw new Error('Mac Funnel metadata must not contain a second-node socket');
  }
  return exposure;
}

export function validateExposureCutoff(exposure) {
  const cutoff = exposure?.cutoff;
  if (!isRecord(cutoff) || !Number.isInteger(cutoff.pid) || cutoff.pid <= 0
    || typeof cutoff.deadline_at !== 'string' || !Number.isFinite(Date.parse(cutoff.deadline_at))
    || typeof cutoff.log_file !== 'string' || !path.isAbsolute(cutoff.log_file)) {
    throw new Error('trial exposure cutoff metadata is missing or invalid');
  }
  return cutoff;
}

export function funnelOffArgs(exposure) {
  return [
    ...socketArgs(exposure),
    'funnel',
    '--bg',
    `--https=${exposure.public_port}`,
    `http://127.0.0.1:${exposure.local_port}`,
    'off',
  ];
}

export function funnelStatusArgs(exposure) {
  return [...socketArgs(exposure), 'funnel', 'status', '--json'];
}

function callTailscale(args, spawn = spawnSync) {
  try {
    return spawn('tailscale', args, {
      encoding: 'utf8',
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
    });
  } catch (error) {
    return { status: null, error };
  }
}

function parseTargetAddress(target) {
  if (typeof target !== 'string') return null;
  if (/^\d+$/.test(target)) {
    const port = Number(target);
    return Number.isInteger(port) && port > 0 && port <= 65_535
      ? { port, hostname: '127.0.0.1' }
      : null;
  }
  try {
    const url = new URL(target.includes('://') ? target : `http://${target}`);
    if (url.port) {
      const port = Number(url.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
      return { port, hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase() };
    }
    if (url.protocol === 'http:') return { port: 80, hostname: url.hostname.toLowerCase() };
    if (url.protocol === 'https:') return { port: 443, hostname: url.hostname.toLowerCase() };
    return null;
  } catch {
    return null;
  }
}

function targetPort(target) {
  return parseTargetAddress(target)?.port ?? null;
}

function forwardingTarget(target) {
  if (typeof target !== 'string') return null;
  if (target.startsWith('unix:')) {
    return target.length > 'unix:'.length ? { port: null, local: false } : null;
  }
  const address = parseTargetAddress(target);
  if (!address) return null;
  const host = address.hostname.replace(/\.$/, '');
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || (isIP(host) === 4 && host.startsWith('127.'));
  return { port: address.port, local };
}

function configForwardsToPort(config, localPort, endpoint) {
  if (!isRecord(config) || !isRecord(config.Handlers)) {
    throw new Error(`Funnel status omitted or malformed Handlers for active endpoint ${endpoint}`);
  }
  for (const handler of Object.values(config.Handlers)) {
    if (!isRecord(handler)) throw new Error(`Funnel status had a malformed handler for active endpoint ${endpoint}`);
    if (!Object.keys(handler).every(key => HTTP_HANDLER_KEYS.has(key))) {
      throw new Error(`Funnel status had an unrecognized handler shape for active endpoint ${endpoint}`);
    }
    const contentKeys = ['Path', 'Proxy', 'Text'].filter(key => Object.hasOwn(handler, key));
    if (contentKeys.length > 1 || (contentKeys.length === 0 && !Object.hasOwn(handler, 'Redirect'))) {
      throw new Error(`Funnel status had an incomplete handler shape for active endpoint ${endpoint}`);
    }
    for (const key of [...contentKeys, ...(Object.hasOwn(handler, 'Redirect') ? ['Redirect'] : [])]) {
      if (typeof handler[key] !== 'string' || handler[key].length === 0) {
        throw new Error(`Funnel status had an invalid ${key} handler for active endpoint ${endpoint}`);
      }
    }
    if (Object.hasOwn(handler, 'AcceptAppCaps')
      && (!Array.isArray(handler.AcceptAppCaps) || !handler.AcceptAppCaps.every(value => typeof value === 'string'))) {
      throw new Error(`Funnel status had invalid AcceptAppCaps for active endpoint ${endpoint}`);
    }
    if (Object.hasOwn(handler, 'Proxy')) {
      const target = forwardingTarget(handler.Proxy);
      if (!target) throw new Error(`Funnel status had a malformed Proxy for active endpoint ${endpoint}`);
      if (target.local && target.port === localPort) return true;
    }
  }
  return false;
}

function tcpForwardPort(handler, endpoint) {
  if (handler === undefined) return { configured: false, target: null };
  if (!isRecord(handler) || !Object.keys(handler).every(key => TCP_HANDLER_KEYS.has(key))) {
    throw new Error(`Funnel status had an unrecognized TCP handler for active endpoint ${endpoint}`);
  }
  for (const key of ['HTTP', 'HTTPS']) {
    if (Object.hasOwn(handler, key) && typeof handler[key] !== 'boolean') {
      throw new Error(`Funnel status had an invalid ${key} TCP handler for active endpoint ${endpoint}`);
    }
  }
  if (Object.hasOwn(handler, 'TerminateTLS') && typeof handler.TerminateTLS !== 'string') {
    throw new Error(`Funnel status had an invalid TerminateTLS handler for active endpoint ${endpoint}`);
  }
  if (Object.hasOwn(handler, 'ProxyProtocol')
    && (!Number.isInteger(handler.ProxyProtocol) || handler.ProxyProtocol < 0)) {
    throw new Error(`Funnel status had an invalid ProxyProtocol handler for active endpoint ${endpoint}`);
  }
  if (Object.hasOwn(handler, 'TCPForward')) {
    const target = handler.TCPForward;
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error(`Funnel status had an invalid TCPForward for active endpoint ${endpoint}`);
    }
    const forwarding = forwardingTarget(target);
    if (!forwarding) throw new Error(`Funnel status had a malformed TCPForward for active endpoint ${endpoint}`);
    return { configured: true, target: forwarding };
  }
  return { configured: false, target: null };
}

function forwardingState(stdout, exposure) {
  let status;
  try { status = JSON.parse(stdout); }
  catch { throw new Error('Funnel status was not valid JSON'); }
  if (!isRecord(status)) throw new Error('Funnel status was not an object');
  if (!Object.keys(status).every(key => ['TCP', 'Web', 'AllowFunnel'].includes(key))) {
    throw new Error('Funnel status used an unrecognized schema');
  }
  for (const field of ['TCP', 'Web', 'AllowFunnel']) {
    if (Object.hasOwn(status, field) && status[field] !== null && !isRecord(status[field])) {
      throw new Error(`Funnel status ${field} field was not an object`);
    }
  }

  const allowFunnel = status.AllowFunnel ?? {};
  if (Object.values(allowFunnel).some(enabled => typeof enabled !== 'boolean')) {
    throw new Error('Funnel status AllowFunnel values were not booleans');
  }
  const activeEndpoints = Object.entries(allowFunnel).filter(([, enabled]) => enabled === true);
  if (activeEndpoints.length === 0) return 'clear';
  const web = status.Web ?? {};
  const tcp = status.TCP ?? {};

  for (const [endpoint] of activeEndpoints) {
    const endpointPort = targetPort(endpoint);
    if (endpointPort === null) throw new Error(`Funnel status had an invalid active endpoint ${endpoint}`);
    const tcpForward = tcpForwardPort(tcp[String(endpointPort)], endpoint);
    if (tcpForward.target?.local && tcpForward.target.port === exposure.local_port) return 'forwarding';
    const config = web[endpoint];
    if (config === undefined && tcpForward.configured) continue;
    if (!isRecord(config)) throw new Error(`Funnel status omitted the active endpoint ${endpoint}`);
    if (configForwardsToPort(config, exposure.local_port, endpoint)) return 'forwarding';
  }
  return 'clear';
}

function recoveryInstructions(exposure, home, reason) {
  const socket = exposure.mode === 'linux-second-node'
    ? ` --socket '${exposure.tailscale_socket.replaceAll("'", "'\\''")}'`
    : '';
  const funnel = `tailscale${socket} funnel`;
  return [
    `trial Funnel shutdown was not verified (${reason}); the bridge and trial home are still running at ${home}.`,
    `Run: ${funnel} --bg --https=${exposure.public_port} http://127.0.0.1:${exposure.local_port} off`,
    `Then inspect: ${funnel} status --json`,
    `Confirm no AllowFunnel endpoint has a Proxy targeting port ${exposure.local_port}, then rerun teardown.`,
  ].join('\n');
}

export function disableAndVerifyFunnel(exposure, home, { spawn = spawnSync } = {}) {
  const off = callTailscale(funnelOffArgs(exposure), spawn);
  const offFailure = off.error
    ? `funnel-off command unavailable (${off.error.code ?? 'spawn error'})`
    : off.status === 0 ? null : `funnel-off command exited ${off.status ?? 'unknown'}`;

  const status = callTailscale(funnelStatusArgs(exposure), spawn);
  if (status.error) {
    throw new Error(recoveryInstructions(exposure, home, `status unavailable (${status.error.code ?? 'spawn error'})`));
  }
  if (status.status !== 0) {
    throw new Error(recoveryInstructions(exposure, home, `status exited ${status.status ?? 'unknown'}`));
  }

  let state;
  try { state = forwardingState(status.stdout ?? '', exposure); }
  catch (error) { throw new Error(recoveryInstructions(exposure, home, error.message)); }
  if (state !== 'clear') throw new Error(recoveryInstructions(exposure, home, 'status still shows the trial port forwarding'));
  if (offFailure) throw new Error(recoveryInstructions(exposure, home, offFailure));
  return { state: 'clear', offArgs: funnelOffArgs(exposure), statusArgs: funnelStatusArgs(exposure) };
}

function isCutoffCommand(command, manifest) {
  return command?.includes(CUTOFF_SCRIPT) && command.includes(manifest.home) && command.includes(manifest.run_id);
}

// A process that has exited but whose parent has not collected it still has a PID. `ps` prints
// `<defunct>` for it (Linux and macOS). While a process exits, its arguments are already gone, and
// `ps` prints only its name: in parentheses on macOS, such as `(node)`, and in brackets on Linux, such
// as `[node-MainThread]`. A running process of this user always shows its arguments. Treat all of
// these as stopped, not as a new identity.
const hasExited = command => !command || command.includes('<defunct>') || /^(\([^()]*\)|\[[^[\]]*\])$/.test(command);

export async function cancelExposureCutoff(manifest, { inspect = processCommand } = {}) {
  const cutoff = validateExposureCutoff(manifest.exposure);

  cutoff.cancelled_at = new Date().toISOString();
  writeJsonPrivate(MANIFEST_PATH(manifest.home), manifest);

  const command = inspect(cutoff.pid);
  if (!command) return true;
  if (!isCutoffCommand(command, manifest)) throw new Error('cutoff PID no longer identifies the trial cutoff process');
  try { process.kill(cutoff.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = inspect(cutoff.pid);
    if (hasExited(current)) return true;
    if (!isCutoffCommand(current, manifest)) throw new Error('cutoff PID changed identity while stopping');
    await sleep(100);
  }

  const current = inspect(cutoff.pid);
  if (hasExited(current)) return true;
  if (!isCutoffCommand(current, manifest)) throw new Error('cutoff PID changed identity while stopping');
  try { process.kill(cutoff.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await sleep(100);
  return hasExited(inspect(cutoff.pid));
}
