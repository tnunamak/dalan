import { readEnv } from './env.mjs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const protocolVersion = 2;
const activeStatuses = new Set(['preparing', 'starting', 'running', 'waiting']);
// Created only for authenticated HTTP reads/ticket issuance before dispatch.
export class T3PreDispatchAuthError extends Error {}

export function resultDeliveryIds(jobId, effectId) {
  if (typeof jobId !== 'string' || !jobId || typeof effectId !== 'string' || !effectId) {
    throw new Error('T3 result delivery requires job and effect IDs');
  }
  const digest = createHash('sha256').update(JSON.stringify([jobId, effectId])).digest('hex');
  return { commandId: `dot-bridge:${digest}`, messageId: `dot-bridge-message:${digest}` };
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('T3 transport requires a loopback origin');
  return url.origin;
}

function t3Home() {
  return path.resolve(process.env.T3CODE_HOME || path.join(os.homedir(), '.t3'));
}

async function runtime(home) {
  for (const name of ['userdata', 'dev']) {
    try {
      const value = JSON.parse(await readFile(path.join(home,name,'server-runtime.json'), 'utf8'));
      if (value.version === 1 && typeof value.origin === 'string' && typeof value.serverVersion === 'string') {
        const origin = loopbackOrigin(value.origin);
        const response = await fetch(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2500) });
        if (!response.ok) continue;
        const descriptor = await response.json();
        if (descriptor.orchestrationProtocolVersion !== protocolVersion || descriptor.serverVersion !== value.serverVersion || typeof descriptor.environmentId !== 'string') continue;
        return { origin, serverVersion: value.serverVersion, environmentId: descriptor.environmentId, baseDir: home };
      }
    } catch {}
  }
  throw new Error('T3 local orchestrator V2 is unavailable');
}

async function cliCommand(serverVersion) {
  const command = readEnv('DALAN_T3_COMMAND') || 't3';
  const version = await execFileAsync(command, ['--version'], { timeout: 5000 }).catch(() => null);
  if (!version || !version.stdout.includes(serverVersion)) throw new Error('matching T3 auth command is unavailable');
  return command;
}

async function issueSession(command, baseDir) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(command, [
      'auth', 'session', 'issue', '--json', '--ttl', '2m', '--label', 'dot-bridge-result-delivery',
      '--subject', 'dot-bridge', '--base-dir', baseDir,
      '--scope', 'orchestration:read', '--scope', 'orchestration:operate',
    ], { timeout: 15000, maxBuffer: 64 * 1024 }));
  } catch { throw new Error('T3 auth session issue failed'); }
  let issued;
  try { issued = JSON.parse(stdout); } catch { throw new Error('T3 auth returned invalid JSON'); }
  if (typeof issued.sessionId !== 'string' || typeof issued.token !== 'string') throw new Error('T3 auth returned an invalid session');
  return issued;
}

async function revokeSession(command, baseDir, sessionId) {
  await execFileAsync(command, ['auth', 'session', 'revoke', sessionId, '--base-dir', baseDir], { timeout: 10000 }).catch(() => {});
}

async function authenticatedRequest(origin, token, pathname, method = 'GET') {
  const response = await fetch(new URL(pathname, origin), {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-t3-orchestration-protocol': String(protocolVersion) },
    signal: AbortSignal.timeout(10000),
  });
  if(response.status===401) throw new T3PreDispatchAuthError('T3 rejected authentication before message dispatch');
  if (!response.ok) throw new Error(`T3 read failed with HTTP ${response.status}`);
  return response.json();
}

function dispatchMode(projection) {
  const active = projection.runs.filter(run => activeStatuses.has(run.status));
  const activeRun = active.sort((a, b) => b.ordinal - a.ordinal)[0];
  if (activeRun) return { type: 'steer_active', targetRunId: activeRun.id };
  if (projection.runs.some(run => run.status === 'queued' || run.queuePosition != null)) return { type: 'queue_after_active' };
  return { type: 'start_immediately' };
}

function rpcRequest(url, tag, payload) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const requestId = '1';
    const timer = setTimeout(() => finish(new Error('T3 dispatch timed out')), 15000);
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      error ? reject(error) : resolve(value);
    };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ _tag: 'Request', id: requestId, tag, payload, headers: [] })));
    socket.addEventListener('message', event => {
      try {
        const messages = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
        for (const message of (Array.isArray(messages) ? messages : [messages])) {
          if (message._tag === 'Exit' && String(message.requestId) === requestId) {
            if (message.exit?._tag !== 'Success') return finish(new Error('T3 rejected message dispatch'));
            return finish(null, message.exit.value);
          }
          if (message._tag === 'Defect' || message._tag === 'ClientProtocolError') return finish(new Error('T3 WebSocket protocol error'));
        }
      } catch { finish(new Error('T3 returned an invalid WebSocket response')); }
    });
    socket.addEventListener('error', () => finish(new Error('T3 WebSocket request failed')));
    socket.addEventListener('close', () => { if (!done) finish(new Error('T3 closed before dispatch response')); });
  });
}

async function dispatchWithSession(origin, token, threadId, message, ids, options) {
  const detail = await authenticatedRequest(origin, token, `/api/orchestration/threads/${encodeURIComponent(threadId)}`);
  const projection = detail?.projection;
  if (projection?.thread?.id !== threadId) throw new Error('T3 thread binding changed');
  const issued = await authenticatedRequest(origin, token, '/api/auth/websocket-ticket', 'POST');
  if (typeof issued.ticket !== 'string' || !issued.ticket) throw new Error('T3 did not issue a WebSocket ticket');
  const wsUrl = new URL('/ws', origin);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('wsTicket', issued.ticket);
  wsUrl.searchParams.set('orchestrationProtocol', String(protocolVersion));
  const command = {
    type: 'message.dispatch', ...ids, threadId, messageId: ids.messageId,
    text: message, attachments: [], createdBy: 'user', creationSource: 'web',
    dispatchMode: options.dispatchMode ?? dispatchMode(projection),
  };
  return rpcRequest(wsUrl, 'orchestration.dispatchCommand', command);
}

export async function dispatchT3Result(threadId, environmentId, jobId, effectId, message, options = {}) {
  const ids = resultDeliveryIds(jobId, effectId);
  const home = await t3Home();
  const target = await runtime(home);
  if (target.environmentId !== environmentId) throw new Error('T3 environment binding changed');
  const command = await cliCommand(target.serverVersion);
  const session = await issueSession(command, target.baseDir);
  try {
    options.onSession?.(session.sessionId);
    return await dispatchWithSession(target.origin, session.token, threadId, message, ids, options);
  } finally {
    await revokeSession(command, target.baseDir, session.sessionId);
  }
}
