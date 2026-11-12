import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initAsFiles } from '../src/as-files.mjs';

// While an update window is open (journal phase 'switched'), a candidate must acknowledge no mutation on any entry:
// public MCP/OAuth listener, admin socket, and background writers. Pause alone does not cover these paths.
const repo = fileURLToPath(new URL('..', import.meta.url));
const scratch = path.join(os.homedir(), '.tmp'); fs.mkdirSync(scratch, { recursive: true });
const home = fs.mkdtempSync(path.join(scratch, 'gate-')); fs.chmodSync(home, 0o700);
const config = path.join(home, '.config', 'dot-bridge'); fs.mkdirSync(config, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(config, 'workers.json'), JSON.stringify({ workers: { codex: { repos: [] } } }), { mode: 0o600 });
initAsFiles(config, { publicUrl: 'https://gate.example.test' });
fs.writeFileSync(path.join(config, 'operator.key'), 'gate-operator-key\n', { mode: 0o600 });
const journal = path.join(home, 'update-transaction.json');
const writeJournal = phase => fs.writeFileSync(journal, JSON.stringify({ home, phase }), { mode: 0o600 });
writeJournal('switched');
const socket = path.join(home, '.local', 'share', 'dot-bridge', 'admin.sock');
const admin = (method, route, body) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath: socket, path: route, method, headers: { 'x-operator-key': 'gate-operator-key', 'content-type': 'application/json' }, timeout: 4000 }, res => {
    let text = ''; res.on('data', d => text += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
const pub = (port, method, route) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { host: 'gate.example.test' }, timeout: 4000 }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); });
  req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
});
let child, stderr = '';
try {
  child = spawn(process.execPath, [path.join(repo, 'src/server.mjs')], { cwd: repo, env: { PATH: process.env.PATH, HOME: home, NODE_ENV: 'production', DALAN_AUTH_MODE: 'builtin', DALAN_BIND_HOST: '127.0.0.1', DALAN_PORT: '0', DALAN_CATALOG_PROFILE: 'stable' }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  let check;
  for (let i = 0; i < 200 && !check; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try { const r = await admin('GET', '/service-check'); if (r.status === 200) check = JSON.parse(r.text); } catch { /* not listening yet */ }
    if (!check) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(check, `server did not start: ${stderr}`);
  // Inside the window: the self-check read stays available; every mutating entry is refused with a retryable status.
  assert.equal((await admin('GET', '/service-check')).status, 200);
  for (const [method, route] of [['POST', '/submit'], ['POST', '/pause'], ['POST', '/resume'], ['POST', '/reconcile']]) {
    const r = await admin(method, route, {});
    assert.equal(r.status, 503, `${method} ${route} was not refused during the update window (${r.status})`);
    assert.ok(r.headers['retry-after'], 'refusal must say when to retry');
  }
  for (const [method, route] of [['POST', '/'], ['POST', '/token'], ['POST', '/register']]) {
    const r = await pub(check.port, method, route);
    assert.equal(r.status, 503, `public ${method} ${route} was not refused during the update window (${r.status})`);
    assert.ok(r.headers['retry-after']);
  }
  // After the commit point the same entries serve again without a restart.
  writeJournal('committed');
  assert.notEqual((await admin('POST', '/submit', {})).status, 503);
  assert.notEqual((await pub(check.port, 'POST', '/token')).status, 503);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000); child.once('exit', () => { clearTimeout(t); resolve(); }); }); }
  fs.rmSync(home, { recursive: true, force: true });
}
