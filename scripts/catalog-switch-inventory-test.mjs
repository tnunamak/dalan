#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { inventory } from '../src/catalog-switch-inventory.mjs';
import { prepare, send, journalPath } from '../src/answer-journal.mjs';

// scripts/question-lifecycle-test.mjs#job: use a real Store, no server or network.
const root = fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP ?? os.tmpdir(), 'catalog-inventory-'));
const dataRoot = path.join(root, 'data');
const receiptsDir = path.join(dataRoot, 'receipts');
fs.mkdirSync(dataRoot);
let store;
const empty = { open_jobs: [], open_questions: [], unknown_sends: [], safe_to_switch: true };
try {
  store = new Store(path.join(dataRoot, 'bridge.db'), { now: () => 1000000, limits: { leaseMs: 60000 }, resumeIdleMs: 0 });
  const snapshot = () => inventory({ dataRoot });
  assert.deepEqual(snapshot(), empty, 'empty Store is safe, without creating receipts');
  assert.equal(fs.existsSync(receiptsDir), false);
  const id = 'inventory-job';
  const payload = { schema_version: 1, request_id: id, brief: 'catalog inventory fixture', inputs: [], expected_output: 'inventory', execution_scope: 'read-only' };
  store.submit(payload, { mode: 'none' }, null, 'owner');
  const grant = store.claim(id, 'W1', 'subject-1', 60000);
  assert.deepEqual(snapshot(), { ...empty, open_jobs: [{ request_id: id, status: 'claimed' }], safe_to_switch: false });

  store.askQuestion(id, grant.claim_id, 'Q:1', 'choose', 'subject-1');
  assert.deepEqual(snapshot().open_questions, [{ job: id, question_id: 'Q:1' }]);
  assert.equal(snapshot().safe_to_switch, false);
  store.answerQuestion(id, 'Q:1', 'yes');
  assert.deepEqual(snapshot().open_questions, []);
  store.consumeAnswer(id, grant.claim_id, 'Q:1', 'subject-1');
  store.finish(id, grant.claim_id, 'completed', 'done', 'result', 'subject-1');
  assert.deepEqual(snapshot(), empty, 'finished job and answered question are clear');

  // src/answer-journal.mjs#prepare and #send produce real journal states.
  const attempt = await prepare(id, 'Q:1', 'yes', { receiptsDir, readRevision: async () => null });
  assert.deepEqual(snapshot().unknown_sends, [{ job: id, question_id: 'Q:1', state: 'prepared' }]);
  const bytes = fs.readFileSync(attempt.file);
  assert.equal(snapshot().safe_to_switch, false);
  assert.deepEqual(fs.readFileSync(attempt.file), bytes, 'inventory does not settle prepared answers');
  await assert.rejects(send(attempt, { post: async () => { throw Object.assign(new Error('fixture unavailable'), { local_code: 'unknown_request' }); } }), { code: 'answer_state_unknown' });
  assert.deepEqual(snapshot().unknown_sends, [{ job: id, question_id: 'Q:1', state: 'unknown' }]);
  assert.equal(snapshot().safe_to_switch, false, 'unknown send blocks even with no open jobs/questions');
  await send(attempt, { post: async () => ({ answered: true }) }); // Local deterministic dependency, not a server.
  assert.deepEqual(snapshot(), empty, 'all finished and committed');

  // Explicit receipts root is honored. Missing DB must not be created.
  assert.deepEqual(inventory({ dataRoot, receiptsDir: path.join(root, 'empty-receipts') }), empty);
  const missing = path.join(root, 'missing');
  fs.mkdirSync(missing);
  assert.throws(() => inventory({ dataRoot: missing }));
  assert.equal(fs.existsSync(path.join(missing, 'bridge.db')), false);
  fs.writeFileSync(journalPath(receiptsDir, id, 'Q:1'), '{broken');
  assert.throws(snapshot, { code: 'answer_journal_corrupt' }, 'corruption must not become safe');
  fs.rmSync(journalPath(receiptsDir, id, 'Q:1'));

  // src/store.mjs#Store.finish permits a blocked result with an unanswered audit question.
  const blockedId = 'inventory-blocked';
  store.submit({ ...payload, request_id: blockedId }, { mode: 'none' }, null, 'owner');
  const blockedGrant = store.claim(blockedId, 'W1', 'subject-1', 60000);
  store.askQuestion(blockedId, blockedGrant.claim_id, 'Q', 'choose', 'subject-1');
  store.finish(blockedId, blockedGrant.claim_id, 'blocked', 'cannot proceed', 'audit', 'subject-1');
  assert.deepEqual(snapshot().open_jobs, []);
  assert.deepEqual(snapshot().open_questions, [{ job: blockedId, question_id: 'Q' }]);
  assert.equal(snapshot().safe_to_switch, false, 'terminal unanswered audit question is retained');
  console.log('PASS catalog inventory source-bound scenarios');
} finally {
  store?.db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
