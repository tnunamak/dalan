#!/usr/bin/env node
// Run the package's ordered test segments to completion and report every exit.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const segmentFile = path.join(root, 'scripts/test-segments.json');
const packageFile = path.join(root, 'package.json');
const shell = process.env.npm_config_script_shell ?? '/bin/sh';
// Node 24 tags SQLite's startup warning as ExperimentalWarning. This suppresses
// that warning class in test subprocesses that assert clean JSON or diagnostics.
const sqliteWarningFlag = '--disable-warning=ExperimentalWarning';
if (!process.env.NODE_OPTIONS?.includes(sqliteWarningFlag)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, sqliteWarningFlag].filter(Boolean).join(' ');
}
// Tests make their own commits. A developer's global git config (commit signing with a key that this machine lacks, for
// example) must not decide whether they pass. A caller can still set GIT_CONFIG_GLOBAL to use another file.
process.env.GIT_CONFIG_GLOBAL ??= '/dev/null';
let interrupted = null;
let activeRun = null;

function signalRun(run, signal) {
  if (!run.child.pid) return false;
  try {
    if (process.platform === 'win32') return run.child.kill(signal);
    process.kill(-run.child.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

const settlementTimeoutMessage = 'segment process group did not stop before settlement deadline';

function assertSettlementTime(deadline) {
  if (performance.now() >= deadline) throw new Error(settlementTimeoutMessage);
}

async function groupIsRunning(run, deadline) {
  assertSettlementTime(deadline);
  if (process.platform === 'win32') return run.child.exitCode === null && run.child.signalCode === null;
  try { process.kill(-run.child.pid, 0); }
  catch (error) {
    assertSettlementTime(deadline);
    if (error.code === 'ESRCH') return false;
    // Darwin can report EPERM while a killed group is being reaped. Keep
    // ownership and retry within the deadline; permission denial is not absence.
    if (process.platform === 'darwin' && error.code === 'EPERM') return true;
    throw error;
  }
  assertSettlementTime(deadline);
  if (process.platform !== 'linux') return true;
  // Linux can retain nonexecuting orphan zombies after the leader has exited.
  // Check group membership, rather than mistaking those zombies for live work.
  for (const pid of await readdir('/proc')) {
    assertSettlementTime(deadline);
    if (!/^\d+$/.test(pid)) continue;
    let stat;
    try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    assertSettlementTime(deadline);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) === run.child.pid && !['Z', 'X'].includes(fields[0])) return true;
  }
  assertSettlementTime(deadline);
  return false;
}

async function awaitGroupStop(run) {
  const deadline = performance.now() + 5000;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(settlementTimeoutMessage)), Math.max(0, deadline - performance.now()));
  });
  const observe = async () => {
    for (;;) {
      const running = await groupIsRunning(run, deadline);
      assertSettlementTime(deadline);
      if (!running) return;
      await delay(10);
    }
  };
  try {
    // Promise.race retains a rejection handler for a probe that settles late.
    await Promise.race([observe(), timeout]);
    assertSettlementTime(deadline);
  } finally {
    clearTimeout(timer);
  }
}

function interruptRun(run, signal) {
  // The shell can exit before its descendants. Retain this group's identity
  // until escalation finishes, even after the shell's close event.
  run.cleanup ??= (async () => {
    if (!signalRun(run, signal)) return;
    await delay(5000);
    if (signalRun(run, 'SIGKILL')) await awaitGroupStop(run);
  })();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted ??= signal;
    if (activeRun) interruptRun(activeRun, interrupted);
  });
}

async function runCommand(command, { cwd = root, env = process.env, quiet = false } = {}) {
  const child = spawn(shell, ['-c', command], {
    cwd,
    env,
    stdio: quiet ? ['ignore', 'ignore', 'ignore'] : 'inherit',
    detached: process.platform !== 'win32'
  });
  const run = { child, cleanup: null };
  activeRun = run;
  if (interrupted) interruptRun(run, interrupted);
  try {
    return await new Promise(resolve => {
      child.once('error', error => resolve({ code: null, signal: null, error }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await run.cleanup;
    if (activeRun === run) activeRun = null;
  }
}

function exitStatus({ code, signal }) {
  return code ?? (signal ? signalStatus(signal) : 1);
}

const signalStatus = signal => 128 + (os.constants.signals[signal] ?? 1);

// skipCheck records a skipped group once, with the number of checks in it.
const countSkipped = checks => checks.reduce((sum, check) => sum + (check.count ?? 1), 0);

function failureSummary(results) {
  const failures = results.filter(result => result.exitCode !== 0 && result.exitCode !== 77);
  const skipped = results.filter(result => result.exitCode === 77);
  const skippedChecks = results.flatMap(result => (result.skippedChecks ?? []).map(check => ({ ...check, index: result.index })));
  const skippedCount = countSkipped(skippedChecks);
  return [
    `TEST SEGMENTS: ${results.length} total, ${results.length - failures.length - skipped.length} passed, ${failures.length} failed, ${skipped.length} skipped${skippedCount ? `, ${skippedCount} checks skipped` : ''}`,
    ...failures.map(result => `FAIL #${result.index}/${results.length} exit=${result.exitCode}: ${result.command}${result.error ? ` (${result.error.message})` : ''}`),
    ...skipped.map(result => `SKIP #${result.index}/${results.length}: ${result.command}`),
    ...skippedChecks.map(check => `SKIPPED CHECK #${check.index}/${results.length}: ${check.name} — ${check.reason}`)
  ].join('\n');
}

// Each segment gets its own report file in DALAN_TEST_SKIP_REPORT; skipCheck appends one JSON line per skipped check.
async function runSegment(command) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dalan-skips-'));
  const report = path.join(dir, 'skips.jsonl');
  try {
    const result = await runCommand(command, { env: { ...process.env, DALAN_TEST_SKIP_REPORT: report } });
    const text = await readFile(report, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const skippedChecks = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { ...result, skippedChecks };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function verifyFailureDoesNotShortCircuit() {
  const fixture = [
    `${process.execPath} -e 'process.exit(7)'`,
    `${process.execPath} -e 'process.stdout.write("later segment ran")'`,
    `${process.execPath} -e 'process.exit(9)'`
  ];
  const results = [];
  for (const [index, command] of fixture.entries()) {
    const result = await runCommand(command, { quiet: true });
    results.push({ index: index + 1, command, exitCode: exitStatus(result) });
  }
  assert.deepEqual(results.map(result => result.exitCode), [7, 0, 9]);
  const report = failureSummary(results);
  assert.match(report, /FAIL #1\/3 exit=7/);
  assert.match(report, /FAIL #3\/3 exit=9/);
  assert(!report.includes('FAIL #2/3'), 'passing fixture segment was reported as failed');
  console.log('PASS segment runner continues after failures and reports every failed segment');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    await verifyFailureDoesNotShortCircuit();
    await import('./test-segments-test.mjs');
    return;
  }
  const segments = JSON.parse(await readFile(segmentFile, 'utf8'));
  const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
  assert(Array.isArray(segments) && segments.length > 0, 'test segment list must be a non-empty array');
  assert(segments.every(command => typeof command === 'string' && command.trim()), 'test segments must contain non-empty command strings');
  assert.equal(pkg.scripts.test, 'node scripts/test-segments.mjs', 'npm test must use the sequential runner');

  const results = [];
  for (const [offset, command] of segments.entries()) {
    const index = offset + 1;
    console.log(`\n=== SEGMENT ${index}/${segments.length}: ${command} ===`);
    if (interrupted) {
      results.push({ index, command, exitCode: signalStatus(interrupted) });
      break;
    }
    const segmentStart = performance.now();
    const result = await runSegment(command);
    const exitCode = exitStatus(result);
    const seconds = (performance.now() - segmentStart) / 1000;
    results.push({ index, command, exitCode, error: result.error, seconds, skippedChecks: result.skippedChecks });
    console.log(`=== SEGMENT ${index}/${segments.length}: ${exitCode === 77 ? 'SKIP' : exitCode === 0 ? (result.skippedChecks.length ? `PASS, ${countSkipped(result.skippedChecks)} check(s) SKIPPED` : 'PASS') : `FAIL exit=${exitCode}`} === ${seconds.toFixed(3)}s`);
    if (interrupted) break;
  }

  const report = failureSummary(results);
  console.log(`\n${report}`);
  const slowest = results
    .filter(result => typeof result.seconds === 'number')
    .sort((a, b) => b.seconds - a.seconds || a.index - b.index)
    .slice(0, 20);
  if (slowest.length > 0) {
    console.log('SLOWEST SEGMENTS:');
    for (const result of slowest) {
      console.log(`#${result.index}/${segments.length} ${result.seconds.toFixed(3)}s: ${result.command}`);
    }
  }
  if (interrupted) process.exitCode = signalStatus(interrupted);
  else if (results.some(result => result.exitCode !== 0 && result.exitCode !== 77)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
