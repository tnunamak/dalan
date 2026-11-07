import http from 'node:http';
import fs from 'node:fs';
import { adminSocketPathError } from './admin-socket.mjs';

export async function bridgeHealth({ socketPath, drainerFile, now = Date.now() }) {
  const socketPathError = adminSocketPathError(socketPath);
  if (socketPathError) throw socketPathError;
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: '/status' }, res => {
      let body = '';
      res.on('data', bytes => {
        body += bytes;
        if (Buffer.byteLength(body) > 1024 * 1024) req.destroy(new Error('status response too large'));
      });
      res.on('end', () => {
        try { if (res.statusCode !== 200) throw new Error('bridge status unavailable'); resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('bridge status response aborted')));
    });
    const deadline = setTimeout(() => req.destroy(new Error('bridge status timeout')), 5000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
  });
  if (!Array.isArray(status.counts) || status.counts.some(row => typeof row.status !== 'string' || !Number.isInteger(row.count) || row.count < 0) || typeof status.paused !== 'boolean' || !Number.isInteger(status.claimed_outer_count) || status.claimed_outer_count < 0) throw new Error('invalid bridge health evidence');
  if (drainerFile) {
    const drainer = JSON.parse(fs.readFileSync(drainerFile, 'utf8'));
    const observed = Date.parse(drainer.observed_at);
    if (drainer.healthy !== true || !Number.isFinite(observed) || now - observed > 150000 || observed > now + 30000) throw new Error('drainer evidence unhealthy or stale');
  }
  // Idle supply, ordinary policy refusals and intentional pause are healthy.
  return { healthy: true, observed_at: new Date(now).toISOString() };
}
