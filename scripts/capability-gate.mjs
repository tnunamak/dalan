// A module, not a test: scripts/capability-table-test.mjs imports it and exercises it (see the synthetic reports there). Running it alone does nothing, so it is not a suite segment.
// The drift gate: the probe suite's JSON report must come from a run that exited 0 with no failed probe, and its measured capabilities
// must equal the declared table. A failing probe fails the gate even when the capability summary happens to match.
import assert from 'node:assert/strict';

export function gate({ status, report, backend }) {
  assert.equal(status, 0, `probe suite exited ${status}`);
  assert.equal(report.backend, backend.name);
  const failed = report.probes.filter(p => p.status === 'FAIL').map(p => p.id);
  assert.equal(report.summary.fail, 0, `probe suite reports ${report.summary.fail} failed probe(s): ${failed.join(', ')}`);
  assert.deepEqual(failed, [], `failed probes: ${failed.join(', ')}`);
  assert.deepEqual(report.capabilities, backend.capabilities, `declared table differs from measurement\ndeclared: ${JSON.stringify(backend.capabilities)}\nmeasured: ${JSON.stringify(report.capabilities)}`);
}
