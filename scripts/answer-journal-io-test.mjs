import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { answerThroughJournal, journalPath, prepare, readJournal, reconcile, send } from '../src/answer-journal.mjs';

const job = 'synthetic-job';
const questionId = 'question-io';
const text = 'Synthetic answer only';

function fixture(t) {
  const receiptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-answer-io-'));
  t.after(() => fs.rmSync(receiptsDir, { recursive: true, force: true }));
  return { receiptsDir, file: journalPath(receiptsDir, job, questionId) };
}

function recordingIo(calls, overrides = {}) {
  return new Proxy(fs, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args) => {
        calls.push({ op: key, args });
        return Reflect.apply(value, target, args);
      };
    },
  });
}

test('send writes and syncs committed state through the injected io', async t => {
  const { receiptsDir, file } = fixture(t);
  const calls = [];
  const io = recordingIo(calls);
  const prepared = await prepare(job, questionId, text, { receiptsDir, io, readRevision: async () => 7 });
  assert.ok(calls.some(c => c.op === 'readFileSync' && c.args[0] === file));
  calls.length = 0; // Observe send alone, not the preparation writes.
  const reply = { answered: true };
  assert.equal(await send(prepared, { io, post: async envelope => {
    assert.equal(envelope.expected_revision, 7);
    return reply;
  } }), reply);
  const writes = calls.filter(c => c.op === 'writeSync');
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].args[1]).state, 'committed');
  const renames = calls.filter(c => c.op === 'renameSync');
  assert.equal(renames.length, 1);
  assert.equal(renames[0].args[1], file);
  assert.equal(calls.filter(c => c.op === 'fsyncSync').length, 2);
  assert.equal(readJournal(file, job, questionId, io).state, 'committed');
});

test('failed committed rename preserves and re-sends the original envelope', async t => {
  const { receiptsDir, file } = fixture(t);
  const calls = [];
  let failCommit = true;
  const crash = new Error('synthetic committed-state rename failure');
  const io = recordingIo(calls, {
    renameSync(from, to) {
      calls.push({ op: 'renameSync', args: [from, to] });
      const staged = JSON.parse(fs.readFileSync(from, 'utf8'));
      if (to === file && staged.state === 'committed' && failCommit) {
        failCommit = false;
        throw crash;
      }
      return fs.renameSync(from, to);
    },
  });
  let revisions = 0;
  const envelopes = [];
  const deps = {
    receiptsDir, io,
    readRevision: async () => { revisions++; return 7; },
    post: async envelope => { envelopes.push({ ...envelope }); return { answered: true }; },
  };
  await assert.rejects(answerThroughJournal({ job, questionId, text, ...deps }), error => error === crash);
  const saved = readJournal(file, job, questionId, io);
  assert.equal(saved.state, 'prepared');
  assert.equal(saved.expected_revision, 7);
  const links = calls.filter(c => c.op === 'linkSync').length;
  assert.equal(links, 1);
  await answerThroughJournal({ job, questionId, text, ...deps });
  assert.equal(revisions, 1); // No new prepare/revision fetch after the simulated crash.
  assert.equal(calls.filter(c => c.op === 'linkSync').length, links);
  assert.equal(envelopes.length, 2);
  assert.deepEqual(envelopes[1], envelopes[0]);
  assert.deepEqual(envelopes[0], {
    id: job, question_id: questionId, command_key: 'answer:' + questionId,
    expected_revision: 7, text,
  });
  assert.equal(readJournal(file, job, questionId, io).state, 'committed');
});

test('reconcile reads and confirms saved state using injected io', async t => {
  const { receiptsDir, file } = fixture(t);
  const calls = [];
  const io = recordingIo(calls);
  await prepare(job, questionId, text, { receiptsDir, io, readRevision: async () => 7 });
  calls.length = 0;
  assert.deepEqual(await reconcile(job, questionId, {
    receiptsDir, io, readQuestion: async () => ({ answer: text }),
  }), { state: 'confirmed' });
  assert.ok(calls.some(c => c.op === 'readFileSync' && c.args[0] === file));
  assert.ok(calls.some(c => c.op === 'writeSync' && JSON.parse(c.args[1]).state === 'committed'));
  assert.equal(calls.filter(c => c.op === 'renameSync').length, 1);
  assert.equal(calls.filter(c => c.op === 'fsyncSync').length, 2);
});
