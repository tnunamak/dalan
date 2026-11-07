#!/usr/bin/env node
// A stop signal leaves one structured line naming the signal, and the process still ends by that signal.
// Node cannot see who sent a signal, so the line carries the signal name only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const base = path.join(process.env.HOME || os.homedir(), '.tmp'); fs.mkdirSync(base, { recursive: true });
const home = fs.mkdtempSync(path.join(base, 'dalan-signal-log-'));
const config = path.join(home, '.config/dot-bridge'); fs.mkdirSync(config, { recursive: true, mode: 0o700 }); fs.chmodSync(config, 0o700);
fs.writeFileSync(path.join(config, 'oauth.env'), 'OAUTH_ISSUER=http://127.0.0.1:9/realm\nOAUTH_AUDIENCE=https://dot-bridge.example.test\nOAUTH_JWKS_URI=http://127.0.0.1:9/jwks\nOAUTH_ALLOWED_SUBJECTS=dot\n', { mode: 0o600 });
fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify({ default_execution: 'host', workers: { dot: { connections: [{ issuer: 'http://127.0.0.1:9/realm', subject: 'dot', client_id: 'fixture-client' }], repos: ['example-owner/fixture'] } } }), { mode: 0o600 });

async function runUntilSignalled(signal, port) {
  const env = { ...process.env, HOME: home, DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1' };
  const server = spawn(process.execPath, ['src/server.mjs'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; server.stdout.on('data', b => out += b); server.stderr.on('data', b => out += b);
  const closed = new Promise(resolve => server.once('close', (code, sig) => resolve({ code, sig })));
  for (let i = 0; i < 200 && !(out.includes('MCP listening') && out.includes('admin socket')); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(out.includes('MCP listening') && out.includes('admin socket'), `server did not start:\n${out}`);
  server.kill(signal);
  const result = await Promise.race([closed, new Promise(r => setTimeout(() => r(null), 10000))]);
  if (!result) { server.kill('SIGKILL'); assert.fail(`server ignored ${signal}`); }
  return { ...result, out };
}

try {
  let port = Number(process.env.SHUTDOWN_SIGNAL_TEST_PORT || 18861);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const { sig, out } = await runUntilSignalled(signal, port++);
    const lines = out.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const entry = lines.find(l => l.kind === 'shutdown_signal');
    assert.ok(entry, `no shutdown_signal line after ${signal}:\n${out}`);
    assert.deepEqual(Object.keys(entry).sort(), ['kind', 'signal'], 'the line names the signal only; the sender is unknowable');
    assert.equal(entry.signal, signal);
    assert.equal(sig, signal, 'the process must still end by the received signal');
    console.log(`PASS ${signal} is logged as shutdown_signal and the process still ends by it`);
  }
} finally { fs.rmSync(home, { recursive: true, force: true }); }
