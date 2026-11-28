import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('heartbeat refuses stray arguments before configuration or network', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-heartbeat-args-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../bin/dot-deadman.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, 'heartbeat', 'stray-fixture-argument'], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, HOME: home, DOT_DEADMAN_ENV: path.join(home, 'absent') },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /usage: dalan-deadman heartbeat/);
  assert.doesNotMatch(result.stderr, /heartbeat requires health file/);
});
