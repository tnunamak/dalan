import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

function canonicalAuthority(value) {
  if (typeof value !== 'string' || !value || /[\s\\\/@?#%,]/.test(value)) return null;
  const match = /^(\[[^\]]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value);
  if (!match) return null;
  const [, hostname, port] = match;
  if (port !== undefined && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) return null;
  if (hostname.startsWith('[')) {
    if (isIP(hostname.slice(1, -1)) !== 6) return null;
  } else {
    if (hostname.length > 253 || !hostname.replace(/\.$/, '').split('.').every(label =>
      label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label))) return null;
    if (/^[0-9.]+$/.test(hostname) && isIP(hostname) !== 4) return null;
  }
  try {
    const url = new URL('https://' + value);
    // WHATWG accepts historical integer/hex/short IPv4 forms. Do not.
    if (isIP(url.hostname) === 4 && isIP(hostname) !== 4) return null;
    return url.host;
  } catch { return null; }
}

// Gozar PR #1 (a620974) challenge-v2: instance, received Host and actual listener.
// No application identity is exposed; the server's public Host check runs first.
export function createServiceVerifier() {
  const instanceId = randomUUID();
  const secret = randomBytes(32);
  return (req, res) => {
    if (req.method !== 'GET' || typeof req.url !== 'string') return false;
    const match = /^\/\.well-known\/gozar\/service\?nonce=([a-f0-9]{64})$/.exec(req.url);
    if (!match || !Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2) return false;
    const hosts = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (typeof req.rawHeaders[i] !== 'string') return false;
      if (req.rawHeaders[i].toLowerCase() === 'host') hosts.push(req.rawHeaders[i + 1]);
    }
    if (hosts.length !== 1) return false;
    const authority = canonicalAuthority(hosts[0]);
    const localPort = req.socket?.localPort;
    if (authority === null || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535) return false;
    const nonce = match[1];
    const transcript = JSON.stringify(['gozar-service-proof', 2, nonce, instanceId, authority, localPort]);
    const proof = createHmac('sha256', secret).update(transcript, 'utf8').digest('hex');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ schemaVersion: 2, nonce, instanceId, authority, localPort, proof }));
    return true;
  };
}
