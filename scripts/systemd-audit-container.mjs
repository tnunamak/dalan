#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { launchSystemdAuditContainer } from './lib/systemd-container-safety.mjs';

async function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} exited ${result.status}`);
  return result.stdout;
}

try {
  const id = await launchSystemdAuditContainer({ docker, imageId: process.argv[2] });
  console.log(`Started guarded systemd audit container ${id}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
