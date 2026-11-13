// A 0.6.0 or 0.6.1 server has no /service-check. The updater must see it as a running legacy server (no update gate), not as a failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defaultPath } from '../src/paths.mjs';
import { probeService } from '../src/service-update-runtime.mjs';

const base = process.env.TMPDIR ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'lp-'));
const home = path.join(root, 'h'), repo = path.join(root, 'pkg');
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@tnunamak/dalan', version: '0.6.0' }));
fs.mkdirSync(defaultPath(home, '.config/dot-bridge'), { recursive: true });
fs.mkdirSync(defaultPath(home, '.local/share/dot-bridge'), { recursive: true });
fs.writeFileSync(defaultPath(home, '.config/dot-bridge', 'workers.json'), JSON.stringify({ workers: { muse: { repos: [] } } }));
fs.writeFileSync(defaultPath(home, '.config/dot-bridge', 'operator.key'), 'k\n');
const sock = defaultPath(home, '.local/share/dot-bridge', 'admin.sock');
const admin = http.createServer((req, res) => { res.statusCode = 404; res.end('{}'); });
await new Promise(r => admin.listen(sock, r));
const tcp = net.createServer(s => s.end());
await new Promise(r => tcp.listen(0, '127.0.0.1', r));
const port = tcp.address().port;
try {
  const probe = await probeService(home, { repo, port });
  assert.equal(probe.legacy, true); assert.equal(probe.version, '0.6.0'); assert.equal(probe.catalogs, null);
  await assert.rejects(probeService(home, { repo }), /404/, 'with no recorded port a 404 is still an error');
  tcp.close(); await new Promise(r => setTimeout(r, 50));
  await assert.rejects(probeService(home, { repo, port }), /loopback listener is unavailable/, 'a 404 with nothing listening is not a live server');
  console.log('service-legacy-probe-test: ok');
} finally { admin.close(); fs.rmSync(root, { recursive: true, force: true }); }
