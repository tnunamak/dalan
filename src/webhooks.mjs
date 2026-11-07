import { readEnv } from './env.mjs';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHmac } from 'node:crypto';

function publicIp(ip) {
  if (readEnv('DALAN_ALLOW_PRIVATE_WEBHOOKS') === '1') return true;
  if (net.isIP(ip) === 4) {
    const x = ip.split('.').map(Number);
    return !(x[0] === 0 || x[0] === 10 || x[0] === 127 || x[0] >= 224 ||
      x[0] === 169 && x[1] === 254 || x[0] === 172 && x[1] >= 16 && x[1] <= 31 ||
      x[0] === 192 && x[1] === 168 || x[0] === 100 && x[1] >= 64 && x[1] <= 127 ||
      x[0] === 192 && x[1] === 0 || x[0] === 198 && x[1] >= 18 && x[1] <= 19);
  }
  const s = ip.toLowerCase();
  return !(s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') ||
    s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') ||
    s.startsWith('feb') || s.startsWith('::ffff:'));
}

async function destination(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(readEnv('DALAN_ALLOW_PRIVATE_WEBHOOKS') === '1' && url.protocol === 'http:')) throw new Error('HTTPS required');
  if (url.username || url.password) throw new Error('URL credentials forbidden');
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicIp(a.address))) throw new Error('non-public callback address');
  return { url, address: addresses[0].address };
}

export function validSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  const bytes = Buffer.from(secret.slice(6), 'base64');
  return bytes.length >= 24 && bytes.length <= 64;
}

export function signature(secret, id, timestamp, body) {
  return 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body}`).digest('base64');
}

// `timeout` below is socket inactivity only: a receiver that sends one byte every few seconds never trips it.
// The deadline bounds the whole request, response body included, because delivery drains subscribers one at a time.
export const WEBHOOK_DEADLINE_MS = 15000;

export async function sendWebhook(rawUrl, secret, id, subId, body, { deadlineMs = WEBHOOK_DEADLINE_MS } = {}) {
  // The deadline also covers the DNS lookup, whose hostname the subscriber controls.
  const started = Date.now();
  let lookupTimer;
  const dest = await Promise.race([
    destination(rawUrl),
    new Promise((_, fail) => { lookupTimer = setTimeout(() => fail(new Error('timeout')), deadlineMs); })
  ]).finally(() => clearTimeout(lookupTimer));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    'webhook-id': id, 'Idempotency-Key': id, 'webhook-timestamp': timestamp,
    'webhook-signature': signature(secret, id, timestamp, body),
    'X-MCP-Subscription-Id': subId
  };
  return new Promise((resolve, reject) => {
    let deadline;
    const settle = fn => value => { clearTimeout(deadline); fn(value); };
    resolve = settle(resolve); reject = settle(reject);
    const lib = dest.url.protocol === 'https:' ? https : http;
    const req = lib.request(dest.url, {
      method: 'POST', headers, timeout: 10000,
      lookup: (_host, opts, cb) => opts?.all
        ? cb(null, [{ address: dest.address, family: net.isIP(dest.address) }])
        : cb(null, dest.address, net.isIP(dest.address))
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size <= 8192) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    deadline = setTimeout(() => {
      const error = new Error('timeout');
      reject(error);
      req.destroy(error);
    }, Math.max(0, deadlineMs - (Date.now() - started)));
    req.on('error', reject);
    req.end(body);
  });
}
