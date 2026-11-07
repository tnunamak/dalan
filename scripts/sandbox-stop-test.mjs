#!/usr/bin/env node
import './require-host-sandbox.mjs';
// Executor hardening: the launcher closes every inherited fd above 2 (sparse high fds included), and compute_stopped is true only
// after the supervisor has verified that nothing of the sandbox remains. "Cancel requested" is a separate fact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withClosedFds, verifyStopped, remainingProcesses } from '../src/sandbox-supervisor.mjs';
import { writeOwnerHostChecks } from './lib/owner-host-checks.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-sandbox-stop-'));
process.env.HOME = home;
process.env.DOT_BRIDGE_WORKSPACE_ROOT = path.join(home, 'work');
delete process.env.DOT_BRIDGE_ALLOW_SHARED_NET_INSTALL; // the install phase goes through pasta, as in production
const { Store } = await import('../src/store.mjs');
const { Workspace } = await import('../src/workspace.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, cwd) => { const x = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr || x.stdout); return x.stdout.trim(); };

// ---- 1. launcher: fds 3.. are closed, including multi-digit and sparse high ones ----
{
  const probe = 'for fd in 3 4 9 57 200 256 257 700 1000 3000 4000; do [ -e /proc/self/fd/$fd ] && echo OPEN$fd; done; echo END';
  // The prefix opens fds the way a careless parent would: no close-on-exec, sparse numbers well above 256.
  const prefix = 'ulimit -n 8192; for fd in 3 4 9 57 200 256 257 700 1000 3000 4000; do eval "exec $fd<>/dev/null"; done; exec "$@"';
  const out = (cmd, args) => spawnSync('/usr/bin/bash', ['-c', prefix, 'prep', cmd, ...args], { encoding: 'utf8' }).stdout.trim().split('\n');
  const control = out('/usr/bin/bash', ['-c', probe]);
  assert.deepEqual(control, ['OPEN3', 'OPEN4', 'OPEN9', 'OPEN57', 'OPEN200', 'OPEN256', 'OPEN257', 'OPEN700', 'OPEN1000', 'OPEN3000', 'OPEN4000', 'END'], 'control: without the launcher every fd leaks');
  const [bin, args] = withClosedFds('/usr/bin/bash', ['-c', probe]);
  assert.deepEqual(out(bin, args), ['END'], 'through the launcher none of them survives');
  // The command, its arguments and stdio pass through unchanged.
  const echoed = spawnSync(...[withClosedFds('/usr/bin/bash', ['-c', 'echo "$1|$2"; echo err >&2; exit 7', 'x', 'a b', '$c'])].map(([b, a]) => [b, a])[0], { encoding: 'utf8' });
  assert.equal(echoed.stdout, 'a b|$c\n'); assert.equal(echoed.stderr, 'err\n'); assert.equal(echoed.status, 7);
}

// ---- 2. verifyStopped: waits, sweeps, and refuses to say verified while anything remains ----
{
  const empty = await verifyStopped({ nsInode: null, pgid: null, scan: () => [], signal: () => assert.fail('nothing to signal') });
  assert.deepEqual(empty, { verified: false, remaining: [], swept: [], reason: 'sandbox_scope_unavailable' });
  let calls = 0; const gone = await verifyStopped({ nsInode: 1, pgid: 2, graceMs: 500, pollMs: 5, scan: () => (++calls < 4 ? [{ pid: 99, reason: 'x' }] : []), signal: () => assert.fail('it exited by itself') });
  assert.equal(gone.verified, true); assert.deepEqual(gone.swept, []);
  const killed = []; const stuck = await verifyStopped({ nsInode: 1, pgid: 2, graceMs: 30, sweepMs: 30, pollMs: 5, scan: () => [{ pid: 42, start: 1, reason: 'in_sandbox_pid_namespace' }], recheck: entry => entry, signal: entries => { killed.push(...entries.map(entry => [entry.pid, 'SIGKILL'])); return entries.map(entry => entry.pid); } });
  assert.equal(stuck.verified, false, 'a process that survives the sweep means not verified'); assert.deepEqual(stuck.remaining, [{ pid: 42, start: 1, reason: 'in_sandbox_pid_namespace' }]); assert.deepEqual(killed, [[42, 'SIGKILL']]);
  // The real scan finds a live process by process group and ignores a zombie.
  const sleeper = spawn('/usr/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  assert.deepEqual(remainingProcesses({ nsInode: null, pgid: sleeper.pid }).map(p => p.pid), [sleeper.pid]);
  process.kill(sleeper.pid, 'SIGKILL'); await new Promise(r => sleeper.once('exit', r));
  assert.deepEqual(remainingProcesses({ nsInode: null, pgid: sleeper.pid }), []);
}

// ---- 3. store: compute_stopped is derived from verified sandboxes, never constant ----
const repo = path.join(home, 'repo');
fs.mkdirSync(repo);
run('git', ['init', '-q'], repo); run('git', ['config', 'user.email', 't@example.com'], repo); run('git', ['config', 'user.name', 'T'], repo);
fs.writeFileSync(path.join(repo, 'hello.txt'), 'before\n');
fs.writeFileSync(path.join(repo, '.dot-bridge.json'), JSON.stringify({ checks: { default: { argv: ['/runtime/node', '-e', '0'], timeout_ms: 5000, output_bytes: 16384 } } }));
run('git', ['add', '.'], repo); run('git', ['commit', '-qm', 'base'], repo);
const base = run('git', ['rev-parse', 'HEAD'], repo);
process.env.DALAN_GITHUB_URL_EXAMPLE_OWNER_FIXTURE = repo;
const store = new Store(path.join(home, 'db.sqlite'));
const ws = new Workspace(store);
const setCheck = spec => writeOwnerHostChecks(home, 'example-owner/fixture', { default: { timeout_ms: 30000, output_bytes: 16384, ...spec } });
function assignment() {
  const id = `req_${randomUUID()}`, payload = { schema_version: 1, request_id: id, brief: 'fixture', inputs: [{ github_repo: 'example-owner/fixture', base_sha: base }], expected_output: 'patch', execution_scope: 'implementation' };
  store.submit(payload, 'thread', 'environment', 'owner');
  const claim = store.claim(id, 'dot', 'subject', 99).claim_id;
  ws.ensure(id, claim, 'subject');
  return { id, claim, dir: path.join(home, 'work/worktrees', id) };
}
try {
  const idle = assignment();
  assert.deepEqual([store.get(idle.id).compute_stopped, store.get(idle.id).sandbox_stop.reason], [false, 'not_cancelled']);
  assert.equal(store.cancel(idle.id).compute_stopped, false, 'the cancel response is a request, not an observation');
  assert.deepEqual([store.get(idle.id).compute_stopped, store.get(idle.id).sandbox_stop.reason], [false, 'no_host_sandbox_ran'], 'no sandbox ran, so there is nothing the bridge verified');
  // A job whose stop was never verified (interrupted by a restart) keeps it false and says why.
  const lost = assignment();
  store.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES('check_lost',?,?,'default','','interrupted',?)").run(lost.id, lost.claim, new Date().toISOString());
  store.cancel(lost.id);
  assert.deepEqual([store.get(lost.id).compute_stopped, store.get(lost.id).sandbox_stop.reason, store.get(lost.id).sandbox_stop.unverified[0].reason], [false, 'stop_not_verified', 'stop_not_verified']);
  store.recordSandboxStop('check_lost', 'check', { verified: false, reason: 'processes_remaining' });
  assert.equal(store.get(lost.id).sandbox_stop.unverified[0].reason, 'processes_remaining');
  store.recordSandboxStop('check_lost', 'check', { verified: true, reason: 'x' });
  store.db.prepare("UPDATE check_jobs SET status='completed' WHERE id='check_lost'").run();
  assert.equal(store.get(lost.id).compute_stopped, true);

  // ---- 4. end to end: a detached, SIGTERM-proof heartbeat chain; cancel; compute_stopped only after the observed stop ----
  const marker = `SSTOP${randomUUID().replace(/-/g, '')}`;
  const a = assignment();
  const beatCode = 'process.on("SIGTERM",()=>{});const fs=require("fs");let n=0;setInterval(()=>fs.writeFileSync("hb.txt",String(++n)+" "+Date.now()),100);setTimeout(()=>process.exit(0),40000)';
  const launch = 'const {spawn}=require("child_process");spawn(process.execPath,["-e",process.argv[1],process.argv[2]],{detached:true,stdio:"ignore"}).unref();setInterval(()=>{},1000)';
  setCheck({ argv: ['/runtime/node', '-e', launch, beatCode, marker], timeout_ms: 60000, output_bytes: 16384 });
  const started = ws.check(a.id, a.claim, 'subject', 'default');
  // The sandbox writes into a private copy, so the host cannot read hb.txt; it sees the chain as a process whose arguments carry the marker.
  const markerPids = () => spawnSync('ps', ['-eo', 'pid=,args=']).stdout.toString().split('\n').filter(l => l.includes(marker)).map(l => +l.trim().split(/\s+/)[0]);
  for (let i = 0; i < 200 && !markerPids().length; i++) await sleep(50);
  assert(markerPids().length >= 1, 'the detached heartbeat is running inside the sandbox');
  assert(markerPids().length >= 1, 'host sees the chain while it runs');
  const requested = store.cancel(a.id, 'stop');
  const right = store.get(a.id);
  assert.equal(requested.cancellation_requested, true); assert.equal(requested.compute_stopped, false);
  assert.equal(right.cancellation_requested, true); assert.equal(right.compute_stopped, false, 'cancel requested is not compute stopped');
  assert.equal(right.sandbox_stop.reason, 'stop_not_verified');
  await started;
  for (let i = 0; i < 100 && store.db.prepare('SELECT status FROM check_jobs WHERE request_id=?').get(a.id).status === 'running'; i++) await sleep(50);
  assert.deepEqual(markerPids(), [], 'no process of the sandbox is left on the host');
  const after = store.get(a.id);
  assert.equal(after.compute_stopped, true); assert.equal(after.sandbox_stop.reason, 'verified'); assert.deepEqual(after.sandbox_stop.unverified, []);
  const job = store.db.prepare('SELECT stop_verified,stop_evidence FROM check_jobs WHERE request_id=?').get(a.id);
  // The budgeted backend runs every phase in one systemd service and records its control-group stop receipt under `host`.
  assert.equal(job.stop_verified, 1); const phase = JSON.parse(job.stop_evidence).host;
  assert.equal(phase.verified, true); assert.equal(phase.reason, 'systemd_control_group_stopped'); assert.deepEqual(phase.remaining_pids, []);

  // ---- 5. both phases run in one systemd service; the bridge records the verified control-group stop for each ----
  const b = assignment();
  setCheck({ install_argv: ['/runtime/node', '-e', 'console.log("INSTALL")'], argv: ['/runtime/node', '-e', 'console.log("CHECK")'], timeout_ms: 30000, output_bytes: 16384 });
  let r = await ws.check(b.id, b.claim, 'subject', 'default');
  for (let i = 0; i < 300 && r.status === 'running'; i++) { await sleep(100); r = { ...r, status: store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(r.check_run_id).status }; }
  const ev = JSON.parse(store.db.prepare('SELECT evidence FROM check_runs WHERE id=?').get(r.check_run_id).evidence);
  assert.equal(ev.exit_code, 0, JSON.stringify(ev.host_budget));
  for (const phaseName of ['install', 'check']) {
    const stop = ev.sandbox_stop[phaseName];
    assert.equal(stop.verified, true, `${phaseName}: ${JSON.stringify(stop)}`); assert.equal(stop.reason, 'systemd_control_group_stopped'); assert.deepEqual(stop.remaining_pids, []);
  }
  assert.equal(ev.sandbox_stop.install.invocation_id, ev.sandbox_stop.check.invocation_id, 'one service invocation covers both phases');

  // A successful install exit does not allow the check phase when process-tree shutdown is unverified. The seam fakes only the
  // executor result: the real stop receipts are asserted above.
  const unverified = assignment();
  setCheck({
    install_argv: ['/runtime/node', '-e', 'console.log("INSTALL_UNVERIFIED")'],
    argv: ['/runtime/node', '-e', 'console.log("OFFLINE_CHECK_RAN")'],
    timeout_ms: 30000, output_bytes: 16384,
  });
  const realRunConfined = ws.runConfined;
  ws.runConfined = async (_requestId, _dir, _command, spec) => {
    const stop = { verified: false, reason: 'processes_remaining', remaining_pids: [4242] };
    return { notStarted: false, error: null, exit: { code: 0 }, timedOut: false, cancelled: false, phases: [{ name: 'install', exit: { code: 0 }, timedOut: false, cancelled: false, bytes: Buffer.from('INSTALL_UNVERIFIED\n'), stop }],
      stop, budgets: spec.host_budget, usage: {}, duration_ms: 1, truncated: false };
  };
  let blocked;
  try {
    blocked = await ws.check(unverified.id, unverified.claim, 'subject', 'default');
    for (let i = 0; i < 300 && blocked.status === 'running'; i++) { await sleep(100); blocked = { ...blocked, status: store.db.prepare('SELECT status FROM check_jobs WHERE id=?').get(blocked.check_run_id).status }; }
  } finally { ws.runConfined = realRunConfined; }
  const blockedRow = store.db.prepare('SELECT * FROM check_runs WHERE id=?').get(blocked.check_run_id);
  assert(blockedRow, 'the install result and receipt are kept');
  const blockedEvidence = JSON.parse(blockedRow.evidence);
  const blockedOutput = ws.artifact(blockedRow.output_artifact_id, unverified.id).bytes.toString();
  assert.equal(blockedEvidence.phase, 'install');
  assert.equal(blockedEvidence.exit_code, 0, 'preserve the successful install exit');
  assert.equal(blockedEvidence.sandbox_stop.install.verified, false);
  assert(blockedOutput.includes('INSTALL_UNVERIFIED'), 'preserve install output');
  assert(!blockedOutput.includes('OFFLINE_CHECK_RAN'), 'the check phase did not run');
  assert.equal(blockedEvidence.host_budget.error, 'host_stop_unverified', 'persist why the check did not run');
  console.log('sandbox-stop-test: PASS');
} finally { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); }
