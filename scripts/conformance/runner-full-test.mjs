import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The conformance gate must pass. Each required variant has a pinned status so that a downgrade (for example PASS to
// SAFETY_HOLDS_NOT_EXACT) is noticed. SAFETY_HOLDS_NOT_EXACT means the safety property held but the variant does not claim an
// exact match with the golden envelope (it drives raw tool arguments or has no golden counterpart).
const EXPECTED_VARIANTS = [
  ['V01-T05-concurrent-claims', 'PASS'],
  ['V02-T09-T28-lost-reply-replay', 'SAFETY_HOLDS_NOT_EXACT'],
  ['V03-T21-T22-cancel-finish-race', 'PASS'],
  ['V04-T23-T24-crash-barriers', 'SAFETY_HOLDS_NOT_EXACT'],
  ['V05-T30-T31-waiter-vs-finish', 'SAFETY_HOLDS_NOT_EXACT'],
  ['V06-T34-T35-delivery-uncertainty', 'PASS'],
  ['V07-inbox-ack-crash', 'PASS'],
  ['V08-deadline-boundaries-and-sweep-races', 'SAFETY_HOLDS_NOT_EXACT'],
];
function assertExpectedEvidence(report) {
  assert.deepEqual(report.variants?.map(({ id, status }) => [id, status]), EXPECTED_VARIANTS, 'full run variant evidence changed');
  assert.deepEqual(report.gateErrors, [], 'the conformance gate must report no errors');
  assert.equal(report.exitStatus, 0, 'the conformance gate must pass');
  assert.equal(report.counts.PASS, 42, 'all fixture traces must have passed');
  assert.equal(report.counts.FAIL, 0, 'fixture traces must not fail');
}

const failingGate = { variants: EXPECTED_VARIANTS.map(([id, status]) => ({ id, status })), gateErrors: ['variant failure or non-run evidence'], exitStatus: 1, counts: { PASS: 42, FAIL: 0 } };
assert.throws(() => assertExpectedEvidence(failingGate), /conformance gate must report no errors/, 'a failing gate must fail this test');
const mutated = { variants: EXPECTED_VARIANTS.map(([id, status], i) => ({ id, status: i === 0 ? 'SAFETY_VIOLATED' : status })), gateErrors: [], exitStatus: 0, counts: { PASS: 42, FAIL: 0 } };
assert.throws(() => assertExpectedEvidence(mutated), /full run variant evidence changed/, 'a V01 status mutation must fail for variant evidence');

const result = spawnSync(process.execPath, ['scripts/conformance/runner.mjs', '--no-diagnostic', '--json'], { encoding: 'utf8', timeout: 900_000 });
assert.equal(result.error, undefined, result.error?.message);
const report = JSON.parse(result.stdout);
assertExpectedEvidence(report);
assert.equal(result.status, report.exitStatus, 'CLI exit status must match the complete report');
