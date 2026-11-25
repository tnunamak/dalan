import assert from 'node:assert/strict';
import { createPublicationPlan } from '../src/publish-plan.mjs';

// Synthetic minimal valid input; no receipts or publication authority implied.
function input(title = 'Ordinary title', body = '') {
  const repository = { host: 'github.com', id: '1', owner_id: '2', owner: 'fixture', name: 'repo' };
  const binding = {
    request_id: 'request', result_receipt: 'receipt', artifact_id: 'artifact',
    artifact_sha256: 'a'.repeat(64), source_base_sha: 'b'.repeat(40),
    source_repository: repository, target_repository: repository,
    target_base_ref: 'refs/heads/main', target_base_sha: 'b'.repeat(40),
    intended_operation: 'create-branch-and-draft-pr',
  };
  return { selection: { binding }, candidate: { binding }, presentation: { title, body } };
}

// Separator assertions are expected to fail against the unfixed source.
for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
  assert.throws(
    () => createPublicationPlan(input('review' + separator + '- FAKE STEP')),
    { name: 'TypeError', message: 'presentation.title: unsafe text controls' },
  );
}

for (const [separator, escaped] of [['\n', '\\n'], ['\u2028', '\\u2028'], ['\u2029', '\\u2029']]) {
  const body = 'before' + separator + 'after';
  const result = createPublicationPlan(input('Ordinary title', body));
  assert.equal(result.plan.pull_request.title_text, 'Ordinary title');
  assert.equal(result.plan.pull_request.body_text, body, 'plain-text payload must remain raw');
  assert.doesNotMatch(result.explanation, /[\u2028\u2029]/);
  const bodyLine = result.explanation.split('\n').find(line => line.startsWith('Draft PR body (literal text): '));
  assert.equal(bodyLine, 'Draft PR body (literal text): "before' + escaped + 'after"');
}

const ordinary = createPublicationPlan(input());
assert.equal(ordinary.plan.pull_request.title_text, 'Ordinary title');
assert.ok(ordinary.explanation.includes('Draft PR title (literal text): "Ordinary title"\n'));
console.log('publish-plan separator regression passed');
