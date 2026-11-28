import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'deadman-clock-'));
try {
  const heartbeat = fileURLToPath(new URL('../bin/dot-deadman.mjs', import.meta.url));
  const T = Date.parse('2026-01-01T00:00:00.000Z');
  const health = path.join(root, 'health.json');
  await writeFile(health, JSON.stringify({healthy: true, observed_at: new Date(T + 30_000).toISOString()}));
  const preload = path.join(root, 'preload.mjs');
  // Resolve the CLI's dependencies before changing the clock so initialization
  // in an imported module cannot consume the heartbeat's first time sample.
  await writeFile(preload, [
    'import ' + JSON.stringify(new URL('../src/env.mjs', import.meta.url).href) + ';',
    'import ' + JSON.stringify(new URL('../src/deadman.mjs', import.meta.url).href) + ';',
    'import assert from "node:assert/strict";',
    'let readings = 0;',
    'Date.now = () => readings++ === 0 ? ' + T + ' : ' + (T - 1) + ';',
    'globalThis.fetch = async (url, init) => {',
    '  assert.equal(String(url), "http://127.0.0.1:9/heartbeat");',
    '  assert.equal(init.method, "POST");',
    '  assert.equal(init.body, JSON.stringify({healthy: true}));',
    '  process.stdout.write("stubbed heartbeat sent\\n");',
    '  return {status: 202};',
    '};'
  ].join('\n'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const result = spawnSync(process.execPath, ['--import', preload, heartbeat, 'heartbeat'], {
    cwd: root, encoding: 'utf8', timeout: 15_000, env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      DOT_DEADMAN_ENV: path.join(root, 'nonexistent.env'),
      DALAN_HEALTH_FILE: health,
      DOT_DEADMAN_URL: 'http://127.0.0.1:9',
      DOT_DEADMAN_TOKEN: 'x'.repeat(32)
    }
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^stubbed heartbeat sent$/m);
  assert.match(result.stdout, /^heartbeat accepted$/m);
} finally {
  await rm(root, {recursive: true, force: true});
}
