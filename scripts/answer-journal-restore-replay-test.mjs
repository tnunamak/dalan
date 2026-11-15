#!/usr/bin/env node
// Base: 481f7a9b6b1b3f9b701d88e35db3cd7c63081e67, plus C7 readback fixes.
// Contracts: src/answer-journal.mjs#prepare freezes the envelope;
// #send owns posting/retries; #settle validates identity; #reconcile never posts.
// bin/dot-worker.mjs#answer supplies readQuestion and post.
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
          return { question_id: questionId, answer: mode === 'same' ? text : mode === 'different' ? 'Other answer' : null };
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
    readQuestion: async () => { reads++; return { question_id: questionId, answer: null }; },
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
  // #settle: absent/malformed/wrong-identity readback is unknown, never pending.
  for (const mode of ['missing', 'null', 'missing-answer', 'undefined-answer', 'wrong-equal', 'wrong-null', 'missing-id', 'invalid-answer']) {
    for (const operation of ['send', 'reconcile', 'conflict']) {
      const q = mode + '-' + operation;
      const p = await prepare(job, q, text, { receiptsDir: root, readRevision: async () => 13 });
      if (operation !== 'conflict') await send(p, { post: async () => ({ answered: true }) });
      const beforeEntry = JSON.parse(fs.readFileSync(p.file, 'utf8'));
      const record = mode === 'missing' ? undefined : mode === 'null' ? null
        : mode === 'missing-answer' ? { question_id: q }
        : mode === 'undefined-answer' ? { question_id: q, answer: undefined }
        : mode === 'wrong-equal' ? { question_id: q + '-other', answer: text }
        : mode === 'wrong-null' ? { question_id: q + '-other', answer: null }
        : mode === 'missing-id' ? { answer: text } : { question_id: q, answer: 42 };
      let posts = 0;
      const deps = { receiptsDir: root, readQuestion: async () => record,
        post: async () => {
          posts++;
          if (operation !== 'conflict') assert.fail('invalid readback must not POST');
          throw Object.assign(new Error('revision_conflict'), { kind: 'http', http_status: 409 });
        } };
      await assert.rejects(operation === 'reconcile'
        ? reconcile(job, q, deps) : send(p, deps), { code: 'answer_state_unknown' });
      assert.equal(posts, operation === 'conflict' ? 1 : 0, 'no POST after invalid readback');
      const after = JSON.parse(fs.readFileSync(p.file, 'utf8'));
      assert.equal(after.state, 'unknown', 'unknown persisted, including wrong equal-text identity');
      assert.deepEqual({ ...after, state: beforeEntry.state }, beforeEntry, 'envelope preserved');
    }
  }
  // #send: transport exhaustion persists uncertainty before rejecting; a later explicit retry
  // retains the original key, text and revision (not a fresh prepare).
  for (const kind of ['transport', 'http']) {
    const q = 'exhaust-' + kind;
    const p = await prepare(job, q, text, { receiptsDir: root, readRevision: async () => 17 });
    const beforeEntry = JSON.parse(fs.readFileSync(p.file, 'utf8'));
    const sent = [];
    const lost = Object.assign(new Error('reply lost'), { kind, ...(kind === 'http' ? { http_status: 503 } : {}) });
    await assert.rejects(send(p, { attempts: 3, sleep: async () => {},
      post: async envelope => { sent.push(structuredClone(envelope)); throw lost; },
    }), error => error === lost);
    assert.equal(sent.length, 3);
    assert(sent.every(e => JSON.stringify(e) === JSON.stringify(sent[0])));
    const after = JSON.parse(fs.readFileSync(p.file, 'utf8'));
    assert.equal(after.state, 'unknown');
    assert.deepEqual({ ...after, state: beforeEntry.state }, beforeEntry);
    const resumed = await prepare(job, q, text, { receiptsDir: root,
      readRevision: async () => assert.fail('unknown attempt must not refresh revision') });
    assert.equal(resumed.entry.state, 'unknown');
    const reply = await send(resumed, { post: async envelope => {
      assert.deepEqual(envelope, sent[0]); return { answered: true };
    } });
    assert.equal(reply.answered, true);
    assert.equal(JSON.parse(fs.readFileSync(p.file, 'utf8')).state, 'committed');
  }
  console.log('answer-journal-restore-replay-test ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
