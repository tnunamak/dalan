#!/usr/bin/env node
import './require-host-checks.mjs';
// Install-phase network gate: without pasta the networked install fails closed with BLOCKED;
// with pasta it runs in a private namespace and cannot reach host loopback services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
process.env.DOT_BRIDGE_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.homedir(), '.tmp/dalan-bridge-gate-'));
delete process.env.DOT_BRIDGE_ALLOW_SHARED_NET_INSTALL;
const { Workspace } = await import('../src/workspace.mjs');
const ws = new Workspace({ db: { prepare: () => ({ run() {}, get() {}, all: () => [] }) }, get: () => ({ status: 'claimed' }) }, false);
const dir = fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_WORKSPACE_ROOT, 'w-'));
const hasPasta = ['/usr/bin/pasta', '/usr/local/bin/pasta'].some(f => fs.existsSync(f));
const sentinel = http.createServer((q, r) => r.end('HOST-LOOPBACK-REACHED'));
await new Promise(r => sentinel.listen(0, '0.0.0.0', r));
const lanIp = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
const port = sentinel.address().port;
const probe = ['/runtime/node', '-e', `Promise.all([fetch('http://198.18.0.1:${port}/',{signal:AbortSignal.timeout(3000)}).then(r=>r.text(),()=>'UNREACHABLE'),fetch('http://127.0.0.1:${port}/',{signal:AbortSignal.timeout(3000)}).then(r=>r.text(),()=>'UNREACHABLE'),fetch('http://${lanIp}:${port}/',{signal:AbortSignal.timeout(3000)}).then(r=>r.text(),()=>'UNREACHABLE')]).then(t=>{console.log(t.join(' '));process.exit(0)})`];
const spec = { timeout_ms: 20000, output_bytes: 65536, network: true };
try {
  const res = await ws.runConfined('req_gate_test_0001', dir, probe, spec);
  const out = res.bytes.toString();
  if (!hasPasta) {
    assert.equal(res.exit.code, 126); assert.match(out, /BLOCKED/);
    console.log('PASS networked install fails closed without pasta');
  } else {
    assert.equal(out.trim().split('\n').pop(), 'UNREACHABLE UNREACHABLE UNREACHABLE'); // gateway alias, loopback, host LAN address assert.doesNotMatch(out, /HOST-LOOPBACK-REACHED/);
    console.log('PASS install phase cannot reach host loopback or the host LAN address (pasta namespace)');
  }
} finally { sentinel.close(); fs.rmSync(process.env.DOT_BRIDGE_WORKSPACE_ROOT, { recursive: true, force: true }); }
