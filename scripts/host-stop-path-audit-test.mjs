#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { processStart, signalSandboxProcesses, verifyStopped } from '../src/sandbox-supervisor.mjs';
import { resolveHostStopEvidence } from '../src/host-budget.mjs';
import { prepareHostReceipts, writeHostStart, writeHostStop } from '../src/host-budget-receipts.mjs';

const scratchRoot = path.join(os.homedir(), '.tmp');
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'dalan-stop-audit-'));
const stopRecorder = path.resolve('src/host-budget-stop.mjs');
const checkRunId = () => `check_${randomUUID().replaceAll('-', '')}`;
const runRecorder = ({ nestedPid, receipts = false }) => {
  const receiptDir = path.join(scratch, `receipts-${Math.random().toString(16).slice(2)}`);
  if (receipts) fs.mkdirSync(receiptDir, { mode: 0o700 });
  const preload = path.join(scratch, `preload-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    const originalRead = fs.readFileSync.bind(fs);
    const originalReadDir = fs.readdirSync.bind(fs);
    fs.readFileSync = (file, ...args) => {
      const name = String(file);
      if (name === '/proc/self/cgroup') return '0::/fixture\\n';
      if (name === '/sys/fs/cgroup/fixture/cgroup.procs') return '';
      if (name === '/sys/fs/cgroup/fixture/memory.events') return 'oom_kill 0\\n';
      if (name === '/sys/fs/cgroup/fixture/child/cgroup.procs') return ${JSON.stringify(nestedPid ? `${nestedPid}\n` : '')};
      return originalRead(file, ...args);
    };
    fs.readdirSync = (dir, ...args) => String(dir) === '/sys/fs/cgroup/fixture'
      ? ${nestedPid ? "[{ name: 'child', isDirectory: () => true }]" : '[]'}
      : String(dir) === '/sys/fs/cgroup/fixture/child' ? []
      : originalReadDir(dir, ...args);
  `);
  const args = ['--import', preload, stopRecorder];
  if (receipts) args.push('--check-run-id', checkRunId(), '--receipt-dir', receiptDir);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 3000,
    env: { ...process.env, INVOCATION_ID: 'a'.repeat(32) },
  });
};

test('a durable receipt failure cannot produce a verified stop event', () => {
  const result = runRecorder({ receipts: true });
  assert.equal(result.status, 1, result.stderr);
  const event = JSON.parse(result.stdout.trim());
  assert.equal(event.stop.verified, false);
});

test('the host budget accepts stop proof only from the durable receipt', () => {
  const receiptDir = path.join(scratch, 'proof-receipts');
  const id = checkRunId();
  const receipts = prepareHostReceipts({ checkRunId: id, receiptDir });
  const invocationId = 'b'.repeat(32);
  writeHostStart({ ...receipts, invocationId });
  assert.equal(resolveHostStopEvidence(receipts, { verified: true, invocation_id: invocationId }), null);
  writeHostStop({ ...receipts, invocationId, verified: true, remaining_pids: [] });
  assert.equal(resolveHostStopEvidence(receipts, { verified: false })?.verified, true);
});

test('a positive stop flag cannot override missing or nonempty remaining PID evidence', () => {
  assert.equal(resolveHostStopEvidence(null, { verified: true, remaining_pids: [765432] })?.verified, false);
  assert.equal(resolveHostStopEvidence(null, { verified: true })?.verified, false);
});

test('a process in a child cgroup prevents a verified stop event', () => {
  const result = runRecorder({ nestedPid: 876543 });
  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(result.stdout.trim());
  assert.deepEqual(event.stop.remaining_pids, [876543]);
  assert.equal(event.stop.verified, false);
});

test('an absent sandbox scope cannot prove that the sandbox stopped', async () => {
  const stop = await verifyStopped({ nsInode: null, pgid: null, scan: () => [], signal: () => assert.fail('no process should be signalled') });
  assert.equal(stop.verified, false);
  assert.equal(stop.reason, 'sandbox_scope_unavailable');
});

test('a wall-clock adjustment cannot hold stop verification past its deadline', () => {
  const code = `
    import { verifyStopped } from ${JSON.stringify(`file://${path.resolve('src/sandbox-supervisor.mjs')}`)};
    Date.now = () => 1;
    await verifyStopped({ nsInode: 1, pgid: 2, graceMs: 5, sweepMs: 5, pollMs: 1,
      scan: () => [{ pid: 3, start: 4 }], recheck: entry => entry, signal: () => [] });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 1000 });
  assert.notEqual(result.error?.code, 'ETIMEDOUT', 'verification should use a monotonic deadline');
  assert.equal(result.status, 0, result.stderr);
});

test('a wall-clock adjustment cannot hold sandbox-info polling past its deadline', () => {
  const code = `
    import { readSandboxInfo } from ${JSON.stringify(`file://${path.resolve('src/sandbox-supervisor.mjs')}`)};
    Date.now = () => 1;
    await readSandboxInfo('/missing-sandbox-info', { timeoutMs: 5, pollMs: 1 });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 1000 });
  assert.notEqual(result.error?.code, 'ETIMEDOUT', 'sandbox-info polling should use a monotonic deadline');
  assert.equal(result.status, 0, result.stderr);
});

test('a process that remains in uninterruptible sleep is returned as unverified', async () => {
  const signals = [];
  const stop = await verifyStopped({ nsInode: 1, pgid: 2, graceMs: 1, sweepMs: 1, pollMs: 1,
    scan: () => [{ pid: 7, start: 8, state: 'D' }], recheck: entry => entry, signal: entries => { signals.push(...entries.map(entry => [entry.pid, 'SIGKILL'])); return entries.map(entry => entry.pid); } });
  assert.equal(stop.verified, false);
  assert.equal(stop.remaining[0].state, 'D');
  assert.deepEqual(signals, [[7, 'SIGKILL']], 'SIGKILL does not remove a task stuck in uninterruptible sleep');
});

test('pidfd signalling rejects a process whose recorded start time differs', { skip: process.platform !== 'linux' && 'pidfd and /proc are Linux-specific' }, async () => {
  const child = spawn('/usr/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    const start = processStart(child.pid);
    const scope = { nsInode: null, pgid: child.pid };
    assert.deepEqual(signalSandboxProcesses([{ pid: child.pid, start: start + 1 }], scope), []);
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'the changed identity remains alive');
    assert.deepEqual(signalSandboxProcesses([{ pid: child.pid, start }], scope), [child.pid]);
    await once(child, 'exit');
  } finally { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
