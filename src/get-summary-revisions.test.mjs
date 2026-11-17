import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGetSummary, formatGetEndNote } from './get-summary.mjs';

const options = { id: 'job-original', cli: 'dalan', decideWords: 'accepted|rejected|applied' };
for (const status of ['finished', 'running']) {
  test(`revised ${status} job points to correction without hiding original evidence`, () => {
    const job = { status, target_worker: 'dot', revised_by: { request_id: 'job-correction' },
      report: { outcome: 'completed', summary: 'Original summary', result: 'Original report remains readable' },
      artifacts: [{ id: 'artifact-original' }], checks: [{ id: 'check-original' }] };
    const before = structuredClone(job);
    const summary = formatGetSummary(job, options);
    assert.ok(summary.startsWith(`Job job-original: ${status}\n`));
    assert.ok(summary.includes('Correction: job-correction'));
    assert.ok(summary.includes('Next: dalan get job-correction'));
    assert.ok(summary.includes('Original summary'));
    assert.ok(summary.includes('Original report remains readable'));
    assert.ok(summary.includes('Evidence: 1 artifact, 1 check'));
    assert.ok(summary.includes('Full record: dalan get job-original --json'));
    assert.doesNotMatch(summary, /decide job-original|cancelled/);
    assert.equal(formatGetEndNote(job, options), 'Next: dalan get job-correction');
    assert.deepEqual(job, before);
  });
}
for (const [status, next, note] of [
  ['finished', 'Next: dalan decide job-original accepted', 'decide: dalan decide job-original accepted|rejected|applied'],
  ['running', 'Next: dalan wait job-original --timeout 3600, then dalan get job-original', null],
  ['cancelled', null, null],
]) {
  test(`unrevised ${status} guidance is unchanged`, () => {
    const summary = formatGetSummary({ status }, options);
    assert.equal(summary, `Job job-original: ${status}${next ? '\n\n' + next : ''}\nFull record: dalan get job-original --json`);
    assert.equal(formatGetEndNote({ status }, options), note);
    assert.doesNotMatch(summary, /Correction:/);
  });
}
test('running questions and original full-record access remain available after revision', () => {
  const summary = formatGetSummary({ status: 'running', revised_by: { request_id: 'job-correction' },
    progress: [{ note: 'QUESTION: Which fixture?' }] }, options);
  assert.ok(summary.includes('QUESTION: Which fixture?'));
  assert.ok(summary.includes('Answer with: dalan note job-original "TEXT"'));
  assert.ok(summary.includes('Full record: dalan get job-original --json'));
  assert.ok(summary.includes('Next: dalan get job-correction'));
});
