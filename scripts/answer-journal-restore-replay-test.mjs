#!/usr/bin/env node
// Pin: 919ed1c8a81b123d6617bb2e8e395e6e142e3769.
// Contracts: src/answer-journal.mjs#prepare (132-147) freezes the envelope;
// #send (164-186) owns posting/retries; #reconcile (188-196) never posts.
// bin/dot-worker.mjs#answer (568-575) supplies readQuestion and post.
// Fakes inject only these dependencies. Real durable journal files, no server/network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, send, reconcile, answerThroughJournal, journalPath } from '../src/answer-journal.mjs';

const root = fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP ?? os.tmpdir(), 'answer-restore-'));
const job = 'restore-replay-fixture';
const text = 'Saved answer α';
try {
  assert.deepEqual([prepare.length, send.length, reconcile.length], [4, 2, 3]);
  // Exercise both revision-bound and legacy envelopes without refreshing either.
  for (const revision of [7, null]) {
    for (const mode of ['same', 'open', 'different', 'no-reader']) {
      const questionId = mode + '-' + (revision ?? 'legacy');
      let revisionReads = 0;
      const prepared = await prepare(job, questionId, text, {
        receiptsDir: root, readRevision: async () => { revisionReads++; return revision; },
      });
      const first = [];
      await send(prepared, { post: async envelope => {
        first.push(structuredClone(envelope));
        return { answered: true };
      } });
      const file = journalPath(root, job, questionId);
      const saved = fs.readFileSync(file, 'utf8');
      assert.equal(JSON.parse(saved).state, 'committed');
      const expected = { id: job, question_id: questionId, text, command_key: 'answer:' + questionId,
        ...(revision === null ? {} : { expected_revision: revision }) };
      assert.deepEqual(first, [expected]); // #send: frozen fields, including nullable revision.
      const posts = [];
      let reads = 0;
      const reply = { answered: true, replay: questionId };
      const deps = { receiptsDir: root,
        readRevision: async () => assert.fail('committed entry cannot prepare another envelope'),
        post: async envelope => { posts.push(structuredClone(envelope)); return reply; },
        ...(mode === 'no-reader' ? {} : { readQuestion: async () => {
          reads++;
          return { answer: mode === 'same' ? text : mode === 'different' ? 'Other answer' : null };
        } }),
      };
      // #reconcile remains read-only. Open means pending, never silent success.
      assert.deepEqual(await reconcile(job, questionId, deps), {
        state: mode === 'open' ? 'pending' : mode === 'different' ? 'conflict' : 'committed',
      });
      assert.deepEqual(posts, []);
      assert.equal(fs.readFileSync(file, 'utf8'), saved, 'reconciliation preserves saved bytes');
      const action = () => answerThroughJournal({ job, questionId, text, ...deps });
      if (mode === 'different') {
        await assert.rejects(action, { code: 'answer_conflict' });
        assert.deepEqual(posts, []);
      } else {
        const result = await action();
        if (mode === 'open') {
          assert.strictEqual(result, reply, 'return the existing post path reply');
          assert.deepEqual(posts, [expected], 'exactly one resend with saved key, text and revision');
        } else {
          assert.equal(result.journal, 'committed');
          assert.deepEqual(posts, []);
        }
      }
      assert.equal(reads, mode === 'no-reader' ? 0 : 2);
      assert.equal(revisionReads, 1);
      assert.equal(fs.readFileSync(file, 'utf8'), saved, 'no new envelope or state rewrite');
    }
  }
  // #send's existing transport retry retains the envelope after restore.
  const questionId = 'retry';
  const prepared = await prepare(job, questionId, text, { receiptsDir: root, readRevision: async () => 9 });
  await send(prepared, { post: async () => ({ answered: true }) });
  const attempts = [];
  let reads = 0;
  const result = await send(prepared, {
    readQuestion: async () => { reads++; return { answer: null }; },
    post: async envelope => {
      attempts.push(structuredClone(envelope));
      if (attempts.length === 1) throw Object.assign(new Error('lost reply'), { kind: 'transport' });
      return { answered: true };
    }, attempts: 2, sleep: async () => {},
  });
  assert.equal(result.answered, true);
  assert.equal(reads, 1);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[0].expected_revision, 9);
  // #settle propagates unavailable readback rather than posting blindly.
  const before = fs.readFileSync(prepared.file, 'utf8');
  const offline = Object.assign(new Error('read unavailable'), { kind: 'transport' });
  await assert.rejects(send(prepared, {
    readQuestion: async () => { throw offline; },
    post: async () => assert.fail('no post after failed readback'),
  }), error => error === offline);
  assert.equal(fs.readFileSync(prepared.file, 'utf8'), before);
  console.log('answer-journal-restore-replay-test ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
