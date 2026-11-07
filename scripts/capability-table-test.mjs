#!/usr/bin/env node
// The declared capability table (src/execution.mjs) must equal what the probe suite measures on this host, and the suite must pass.
// Runs `node scripts/sandbox-probe-e2e.mjs --json` and applies the gate (scripts/capability-gate.mjs): a nonzero exit, a failed probe,
// or any difference between table and measurement fails, so the table cannot drift silently and a broken probe cannot hide.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CAPABILITY_NAMES, CAPABILITY_STATES, hostBackend } from '../src/execution.mjs';
import { gate } from './capability-gate.mjs';

// The declared table is only reported while host checks are opted in, which is how the probe suite runs.
process.env.DALAN_HOST_CHECKS = '1';
const backend = hostBackend();
assert.deepEqual(Object.keys(backend.capabilities).sort(), [...CAPABILITY_NAMES].sort(), 'the table covers the section 13 vocabulary exactly');
for (const state of Object.values(backend.capabilities)) assert(CAPABILITY_STATES.includes(state));

// The gate itself, on synthetic reports: each of these must be refused.
{
  const ok = { backend: backend.name, probes: [{ id: '1.1', status: 'PASS' }], summary: { pass: 1, fail: 0, unsupported: 0 }, capabilities: { ...backend.capabilities } };
  gate({ status: 0, report: ok, backend });
  assert.throws(() => gate({ status: 1, report: ok, backend }), /probe suite exited 1/, 'nonzero exit');
  const failing = { ...ok, probes: [{ id: '6.6', status: 'FAIL' }], summary: { pass: 0, fail: 1, unsupported: 0 } };
  assert.throws(() => gate({ status: 0, report: failing, backend }), /1 failed probe\(s\): 6\.6/, 'a failed probe with matching capabilities');
  assert.throws(() => gate({ status: 0, report: { ...ok, capabilities: { ...backend.capabilities, private_loopback: 'unsupported' } }, backend }), /declared table differs/);
}

await import('./require-host-sandbox.mjs');
const measured = spawnSync(process.execPath, ['scripts/sandbox-probe-e2e.mjs', '--json'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 });
let report;
try { report = JSON.parse(measured.stdout); } catch { throw new Error(`probe suite printed no JSON (exit ${measured.status}): ${measured.stderr.slice(-800)}`); }
gate({ status: measured.status, report, backend });
console.log(`capability-table-test: PASS (${report.summary.pass} PASS, ${report.summary.fail} FAIL, ${report.summary.unsupported} UNSUPPORTED)`);
