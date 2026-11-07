#!/usr/bin/env node
import { defaultPath } from '../src/paths.mjs';
import { readEnv } from '../src/env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bridgeHealth } from '../src/host-health.mjs';

const root = defaultPath(os.homedir(),'.local/share/dot-bridge');
const healthFile = readEnv('DALAN_HEALTH_FILE') || path.join(root, 'health.json');
const temporary = `${healthFile}.${process.pid}`;
try {
  const health = await bridgeHealth({ socketPath: path.join(root, 'admin.sock'), drainerFile: readEnv('DALAN_DRAINER_HEALTH_FILE') });
  fs.writeFileSync(temporary, JSON.stringify(health) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, healthFile);
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./dot-deadman.mjs', import.meta.url)), 'heartbeat'], {
    env: { ...process.env, DOT_BRIDGE_HEALTH_FILE: healthFile }, timeout: 10000,
  });
  process.stdout.write(stdout);
} catch {
  fs.rmSync(temporary, { force: true });
  // Remove stale positive evidence; a failed local check must not ping externally.
  fs.rmSync(healthFile, { force: true });
  console.error('dalan-heartbeat: health check or external heartbeat failed');
  process.exitCode = 1;
}
