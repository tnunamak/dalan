import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHealth } from '../src/host-health.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-host-health-'));
const socketPath = path.join(home, 'admin.sock'), drainerFile = path.join(home, 'drainer.json');
let now = Date.now(), reply = { counts: [], paused: false, claimed_outer_count: 0 };
const server = http.createServer((req, res) => res.end(JSON.stringify(reply)));
await new Promise(resolve => server.listen(socketPath, resolve));
const write = extra => fs.writeFileSync(drainerFile, JSON.stringify({ healthy: true, observed_at: new Date(now).toISOString(), ...extra }));
const check = () => bridgeHealth({ socketPath, drainerFile, now });
try {
  assert.equal((await bridgeHealth({ socketPath, now })).healthy, true, 'fresh install needs no drainer');
  await assert.rejects(check(), /ENOENT/, 'opted-in missing evidence fails');
  write({ observed_at: new Date(now - 150001).toISOString() });
  assert.equal((await bridgeHealth({ socketPath, now })).healthy, true, 'unconfigured stale drainer is ignored');
  assert.equal((await bridgeHealth({ socketPath, drainerFile: '', now })).healthy, true, 'empty drainerFile leaves the gate off');
  write(); assert.equal((await check()).healthy, true, 'empty supply is healthy');
  reply.paused = true; assert.equal((await check()).healthy, true, 'intentional pause is healthy');
  write({ healthy: false }); await assert.rejects(check(), /unhealthy/);
  write(); now += 150001; await assert.rejects(check(), /stale/);
  write({ observed_at: new Date(now + 30001).toISOString() }); await assert.rejects(check(), /stale/);
  fs.writeFileSync(drainerFile, '{'); await assert.rejects(check(), SyntaxError, 'malformed opted-in evidence fails');
  await assert.rejects(bridgeHealth({ socketPath, drainerFile: home, now }), /EISDIR/, 'directory as evidence fails');
  write(); reply = {}; await assert.rejects(check(), /invalid bridge/);
  await assert.rejects(bridgeHealth({ socketPath, now }), /invalid bridge/);
  await new Promise(resolve => server.close(resolve)); await assert.rejects(check(), /ENOENT|ECONNREFUSED|EPIPE/);
  await assert.rejects(bridgeHealth({ socketPath, now }), /ENOENT|ECONNREFUSED|EPIPE/);
  console.log('PASS local heartbeat health gate: optional drainer, idle/pause healthy, missing/stale/future/failed opted-in drainer, invalid or absent socket fail closed');
} finally {
  server.close(); fs.rmSync(home, { recursive: true, force: true });
}
