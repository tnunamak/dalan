#!/usr/bin/env node
// Catalog freeze gate: the advertised discover/initialize/tools/events definitions must stay byte-identical
// to scripts/fixtures/catalog.golden.json. ChatGPT caches this catalog; any change breaks every call until the operator
// refreshes the connector and restarts the worker conversation. Run with --update ONLY for a deliberate, announced catalog release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { reservedPort } from '../src/test-support/port.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const goldenPath = path.join(root, 'scripts/fixtures/catalog.golden.json');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-bridge-catalog-'));
fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true });
const port = await reservedPort();
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: root, env: { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_AUTH_MODE: '', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let ready = false;
child.stdout.on('data', c => { if (String(c).includes('MCP listening')) ready = true; });
child.stderr.on('data', c => process.stderr.write(c));
try {
  for (let i = 0; i < 100 && !ready; i++) await new Promise(r => setTimeout(r, 50));
  assert(ready, 'server startup');
  const secret = fs.readFileSync(path.join(home, '.config/dot-bridge/env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const call = async (method, params = {}) => (await (await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json()).result;
  const catalog = {
    discover: await call('server/discover'),
    initialize: await call('initialize', { protocolVersion: '2025-11-25' }),
    tools: await call('tools/list'),
    events: await call('events/list'),
  };
  const text = JSON.stringify(catalog, null, 1) + '\n';
  if (process.argv.includes('--update')) { fs.writeFileSync(goldenPath, text); console.log('catalog golden updated'); }
  else {
    assert.equal(text, fs.readFileSync(goldenPath, 'utf8'), 'advertised catalog changed: this needs a deliberate release with a Refresh + reboot');
    console.log(`PASS advertised catalog identical to golden (${catalog.tools.tools.length} tools)`);
  }
} finally {
  child.kill('SIGTERM');
  await new Promise(r => child.once('exit', r));
  fs.rmSync(home, { recursive: true, force: true });
}
