#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

process.env.DALAN_HOST_CHECKS = '1';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-stop-production-'));
const repo = path.join(home, 'repo');
const config = path.join(home, '.config/dot-bridge');
const requestId = `req_${randomUUID()}`;
const marker = `DALAN_STOP_PROBE_${randomUUID().replaceAll('-', '')}`;
const budget = { cpu_ms: 3000, wall_ms: 8000, memory_bytes: 192 * 1024 ** 2, processes: 32, disk_write_bytes: 8 * 1024 ** 2, output_bytes: 16384 };
const check = {
  argv: ['/runtime/node', '-e', `const {spawn}=require('node:child_process');spawn('/runtime/node',['-e',"setInterval(()=>{},1000);console.log('${marker}')"],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`],
  host_budget: budget,
  timeout_ms: 60000,
  output_bytes: budget.output_bytes,
};
const pidsForMarker = () => spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout
  .split('\n').filter(line => line.includes(marker)).map(line => Number(line.trim().split(/\s+/)[0])).filter(Number.isSafeInteger);
const waitFor = async (predicate, timeoutMs) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
};

let store;
let workspace;
let Store;
let Workspace;
let hostBackend;
let readVerifiedHostStop;
let work;
try {
  process.env.HOME = home;
  process.env.DALAN_WORKSPACE_ROOT = path.join(home, 'work');
  process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
  await import('./require-host-checks.mjs');
  ({ Store } = await import('../src/store.mjs'));
  ({ Workspace } = await import('../src/workspace.mjs'));
  ({ hostBackend } = await import('../src/execution.mjs'));
  ({ readVerifiedHostStop } = await import('../src/host-budget-receipts.mjs'));
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, 'host-check-allowlist.json'), JSON.stringify({ version: 1, checks: [{ repo: 'example-owner/fixture', check_id: 'default' }] }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'checks.json'), JSON.stringify({ 'example-owner/fixture': { checks: { default: check } } }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, '.local/share/dot-bridge'), { recursive: true, mode: 0o700 });

  fs.mkdirSync(repo);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'fixture\n');
  fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: { default: check } }), { mode: 0o600 });
  git('add', 'file.txt', '.dot-bridge.json');
  git('commit', '-qm', 'fixture');
  const baseSha = git('rev-parse', 'HEAD');

  const backend = hostBackend();
  assert.equal(backend.name, 'linux-bwrap-systemd');
  assert.equal(backend.capabilities.full_tree_cancel_verified, 'verified');
  assert.equal(backend.measured_by.full_tree_cancel_verified, 'scripts/host-stop-production-path-test.mjs');

  store = new Store(path.join(home, '.local/share/dot-bridge/bridge.db'), { allowDefaultHomeMigration: true });
  workspace = new Workspace(store, true, { checkResponseOptions: { responseMs: 0 } });
  store.submit({
    schema_version: 1,
    request_id: requestId,
    brief: 'Run the stop-path fixture check',
    inputs: [{ github_repo: 'example-owner/fixture', base_sha: baseSha }],
    expected_output: 'A test result',
    execution_scope: 'implementation',
    execution: 'host',
  }, 'thread', 'environment', 'owner');
  const claimId = store.claim(requestId, 'dot', 'subject', 60).claim_id;
  workspace.ensure(requestId, claimId, 'subject');

  const start = await workspace.check(requestId, claimId, 'subject', 'default');
  assert.equal(start.status, 'running');
  work = workspace.checkEffects.get(requestId);
  assert(work, 'the production Workspace.check path started the host job');
  const runningPids = await waitFor(() => { const pids = pidsForMarker(); return pids.length ? pids : null; }, 10000);
  assert(runningPids?.length, 'the check and its detached child became visible before cancellation');

  store.cancel(requestId, 'stop-path test');
  const gone = await waitFor(() => pidsForMarker().length === 0, 4000);
  assert.equal(gone, true, 'the systemd control group stopped the check and detached child');
  await work;

  const job = store.db.prepare('SELECT id,status,stop_verified,stop_evidence FROM check_jobs WHERE request_id=?').get(requestId);
  assert(job, 'the production check has a durable job row');
  const receipt = readVerifiedHostStop({ receiptDir: path.join(home, 'work/host-receipts'), checkRunId: job.id });
  assert.equal(receipt?.verified, true);
  assert.deepEqual(receipt?.remaining_pids, []);
  assert.equal(job.stop_verified, 1, 'the workspace reconciled the durable stop receipt');
  assert.equal(store.get(requestId).compute_stopped, true);
  console.log('PASS systemd cgroup cancellation through Workspace.check records an empty, verified stop receipt');
} finally {
  if (workspace && store && store.get(requestId)?.status === 'claimed') {
    try { store.cancel(requestId, 'test cleanup'); } catch {}
  }
  await work?.catch(() => {});
  for (const pid of pidsForMarker()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  store?.db.close();
  fs.rmSync(home, { recursive: true, force: true });
}
