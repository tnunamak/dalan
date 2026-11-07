#!/usr/bin/env node
// Stopping the cutoff process: a process that has exited but whose parent has not yet
// collected it (a zombie) is gone. `ps` then prints `<defunct>` in place of the command, so it
// no longer matches the cutoff script. That is not an identity change;
// cancelExposureCutoff must report the process as stopped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cancelExposureCutoff } from './exposure.mjs';

const cutoffScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'exposure-cutoff.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cutoff-exit-'));
const runId = 'zombie-run-1';

// The parent starts a stand-in cutoff process, prints its PID, then does not collect it for 20 s.
const parentSource = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ${JSON.stringify(cutoffScript)}, ${JSON.stringify(home)}, ${JSON.stringify(runId)}], { stdio: 'ignore' });
console.log(child.pid);
const end = Date.now() + 20000;
while (Date.now() < end) {}
`;
const parent = spawn(process.execPath, ['-e', parentSource], { stdio: ['ignore', 'pipe', 'ignore'] });
let cleanupPids = [parent.pid];
try {
  const childPid = await new Promise((resolve, reject) => {
    let text = '';
    parent.stdout.on('data', chunk => { text += chunk; const m = /^(\d+)\n/.exec(text); if (m) resolve(Number(m[1])); });
    parent.on('error', reject);
    parent.on('exit', () => reject(new Error('parent exited before printing the child PID')));
  });
  cleanupPids.push(childPid);
  const manifest = {
    home, run_id: runId,
    exposure: { cutoff: { pid: childPid, deadline_at: new Date(Date.now() + 60000).toISOString(), log_file: path.join(home, 'cutoff.log') } },
  };
  const started = Date.now();
  assert.equal(await cancelExposureCutoff(manifest), true, 'a cutoff process that exited and awaits collection counts as stopped');
  assert.ok(Date.now() - started < 5000, 'cancel returns without waiting for the parent');
  console.log('PASS cancelling a cutoff whose process exited but is not yet collected succeeds');
} finally {
  for (const pid of cleanupPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  fs.rmSync(home, { recursive: true, force: true });
}

// While a process exits, its arguments are already gone and `ps` prints only its name: `(node)` on macOS,
// `[node-MainThread]` on Linux. That is the same exit, not a new process with this PID.
for (const exiting of ['(node)', '[node-MainThread]']) {
  const exitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cutoff-exiting-'));
  const argv = ['-e', 'setTimeout(() => {}, 60000)', cutoffScript, exitHome, runId];
  const child = spawn(process.execPath, argv, { stdio: 'ignore' });
  try {
    const seen = [[process.execPath, ...argv].join(' '), exiting];
    const manifest = { home: exitHome, run_id: runId,
      exposure: { cutoff: { pid: child.pid, deadline_at: new Date(Date.now() + 60000).toISOString(), log_file: path.join(exitHome, 'cutoff.log') } } };
    assert.equal(await cancelExposureCutoff(manifest, { inspect: () => seen.length > 1 ? seen.shift() : seen[0] }), true,
      `a cutoff process whose ps entry shows only ${exiting} while it exits counts as stopped`);
    console.log(`PASS cancelling a cutoff whose ps entry shows only ${exiting} while it exits succeeds`);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(exitHome, { recursive: true, force: true });
  }
}
