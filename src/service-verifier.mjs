import { createHmac, randomBytes, randomUUID } from 'node:crypto';

// Gozar's service-route wire contract. The same instance ID is returned through the target and public ingress.
// This endpoint carries no Dalan identity or authority. The server's public Host check must run first.
export function createServiceVerifier() {
  const instanceId = randomUUID();
  const secret = randomBytes(32);
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/.well-known/gozar/service') return false;
    const nonce = url.searchParams.get('nonce');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' || !/^[a-f0-9]{64}$/.test(nonce ?? '') || [...url.searchParams].length !== 1) {
      res.writeHead(400); res.end(); return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const proof = createHmac('sha256', secret).update(nonce).digest('hex');
    res.end(JSON.stringify({ schemaVersion: 1, nonce, instanceId, proof }));
    return true;
  };
}
