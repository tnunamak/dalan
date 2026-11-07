#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readManifest, sleep } from './common.mjs';
import { disableAndVerifyFunnel, validateExposure, validateExposureCutoff } from './exposure.mjs';

const args = parseArgs(process.argv.slice(2), { values: ['--home', '--run-id'] });
let logFile = null;

function append(message) {
  if (!logFile) return;
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
}

async function registeredManifest(home, runId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const manifest = readManifest(home);
      if (manifest.run_id !== runId) throw new Error('cutoff run ID does not match the manifest');
      logFile = manifest.exposure?.cutoff?.log_file ?? null;
      if (manifest.exposure?.cutoff?.pid === process.pid) return manifest;
    } catch (error) {
      if (error.message === 'cutoff run ID does not match the manifest') throw error;
    }
    await sleep(25);
  }
  throw new Error('cutoff process was not registered in the trial manifest');
}

async function main() {
  if (args._.length || !args['--home'] || !args['--run-id']) {
    throw new Error('usage: exposure-cutoff.mjs --home DIR --run-id ID');
  }
  const home = path.resolve(args['--home']);
  const runId = args['--run-id'];
  let manifest = await registeredManifest(home, runId);
  let exposure = validateExposure(manifest.exposure, manifest.port);
  validateExposureCutoff(exposure);

  const remaining = Date.parse(exposure.cutoff.deadline_at) - Date.now();
  if (remaining > 0) await sleep(remaining);

  manifest = readManifest(home);
  exposure = validateExposure(manifest.exposure, manifest.port);
  validateExposureCutoff(exposure);
  if (manifest.run_id !== runId) throw new Error('cutoff run ID changed in the manifest');
  if (exposure.cutoff.cancelled_at) {
    append('cutoff cancelled by teardown');
    return;
  }

  disableAndVerifyFunnel(exposure, home);
  append(`cutoff verified clear; public_port=${exposure.public_port} local_port=${exposure.local_port}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    append(`cutoff failed: ${error.message}`);
    console.error(`exposure cutoff failed: ${error.message}`);
    process.exitCode = 1;
  });
}
