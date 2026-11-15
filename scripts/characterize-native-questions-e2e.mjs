#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';

// Characterizes the legacy Store seam at 4d2abf19a1d534c6ec1d85ce67c19f3d405a69ad.
// No HTTP server, host activation, network or product changes.
if (process.argv[2] === '--answer-racer') {
  const [file, id, clock] = process.argv.slice(3);
  const store = new Store(file, { now: () => Number(clock), limits: { leaseMs: 100 }, resumeIdleMs: 0 });
  try {
    store.answerQuestion(id, 'Q', 'child answer');
    console.log(JSON.stringify(store.db.prepare('SELECT * FROM job_questions WHERE request_id=?').get(id)));
  } finally { store.db.close(); }
} else {
  const root = fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP ?? os.tmpdir(), 'characterize-questions-'));
  const file = path.join(root, 'state.db');
  let now = 1000000;
  const open = () => new Store(file, { now: () => now, limits: { leaseMs: 100 }, resumeIdleMs: 0 });
  let store = open();
  let asserted = 0;
  const rows = id => Object.fromEntries(
    ['assignments', 'claims', 'job_questions', 'notifications', 'progress', 'reports', 'lifecycle_events']
      .map(table => [table, store.db.prepare(`SELECT * FROM ${table} WHERE request_id=? ORDER BY rowid`).all(id).map(row => ({ ...row }))]));
  const evidence = (cut, id) => `${cut}: SELECT * FROM assignments/claims/job_questions/notifications/progress/reports/lifecycle_events WHERE request_id=${JSON.stringify(id)}: ${JSON.stringify(rows(id))}`;
  const check = (cut, id, fn) => {
    const proof = evidence(cut, id);
    fn(proof);
    asserted++;
    console.log(proof);
  };
  const job = id => {
    store.submit({ schema_version: 1, request_id: id, brief: 'question characterization fixture',
      inputs: [], expected_output: 'one answer', execution_scope: 'read-only' }, { mode: 'none' }, null, 'owner');
    return store.claim(id, 'W1', 'subject-1', 100);
  };
  const ask = (id, grant) => store.askQuestion(id, grant.claim_id, 'Q', 'choose fixture', 'subject-1');
  const finish = (id, grant) => store.finish(id, grant.claim_id, 'completed', 'done', 'fixture result', 'subject-1');
  try {
    const id = 'questions-durable';
    const grant = job(id);
    const beforeAsk = rows(id);
    // Fail at the outbox insert, after the question row was inserted: neither may commit.
    store.db.exec(`CREATE TEMP TRIGGER fail_question_outbox BEFORE INSERT ON notifications
      WHEN NEW.request_id='questions-durable' AND NEW.body IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END`);
    try {
      check('F04 rollback', id, proof => {
        assert.throws(() => ask(id, grant), /injected outbox failure/, proof);
        assert.deepEqual(rows(id), beforeAsk, evidence('F04 after rollback', id));
      });
    } finally { store.db.exec('DROP TRIGGER fail_question_outbox'); }
    ask(id, grant);
    check('F04 durable outbox', id, proof => {
      const state = rows(id), question = state.job_questions[0];
      assert.equal(state.assignments[0].status, 'claimed', proof);
      assert.equal(state.job_questions.length, 1, proof);
      assert.equal(question.question_id, 'Q', proof);
      assert.equal(question.claim_id, grant.claim_id, proof);
      assert.equal(question.epoch, grant.epoch, proof);
      assert.equal(question.answer, null, proof);
      const notices = state.notifications.filter(row => row.body && JSON.parse(row.body).question_id === 'Q');
      assert.equal(notices.length, 1, proof);
      assert.equal(notices[0].kind, 'wait', proof);
      assert.equal(notices[0].state, 'pending', proof);
      assert.equal(JSON.parse(notices[0].body).epoch, grant.epoch, proof);
    });
    const beforeRestart = rows(id);
    store.db.close(); store = open();
    check('F05 restart unanswered', id, proof => {
      assert.deepEqual(rows(id), beforeRestart, proof);
      assert.equal(rows(id).job_questions[0].answered_at, null, proof);
      assert.equal(rows(id).job_questions[0].consumed_at, null, proof);
    });
    const assignmentBeforeAnswer = rows(id).assignments;
    store.answerQuestion(id, 'Q', 'use fixture');
    check('F10 answer is not completion', id, proof => {
      const state = rows(id);
      assert.deepEqual(state.assignments, assignmentBeforeAnswer, proof);
      assert.equal(state.job_questions[0].answer, 'use fixture', proof);
      assert.notEqual(state.job_questions[0].answered_at, null, proof);
      assert.equal(state.job_questions[0].consumed_at, null, proof);
      assert.equal(state.reports.length, 0, proof);
      assert.throws(() => finish(id, grant), error => error.code === 'QUESTION_OPEN', proof);
      assert.deepEqual(rows(id), state, evidence('F10 refused finish', id));
    });
    store.consumeAnswer(id, grant.claim_id, 'Q', 'subject-1');
    finish(id, grant);
    check('F10 consumed then finished', id, proof => {
      const state = rows(id);
      assert.notEqual(state.job_questions[0].consumed_at, null, proof);
      assert.equal(state.assignments[0].status, 'finished', proof);
      assert.equal(state.reports.length, 1, proof);
      assert.equal(state.reports[0].outcome, 'completed', proof);
    });

    const raceId = 'questions-independent-answer', raceGrant = job(raceId);
    ask(raceId, raceGrant);
    const claimBeforeAnswer = rows(raceId).claims;
    // Keep the worker claim and parent Store open, not a SQLite transaction.
    // A lease is not an exclusive database lock held while waiting for the owner.
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--answer-racer', file, raceId, String(now)],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        try {
          assert.equal(timedOut, false, evidence('F26 child timed out', raceId));
          assert.equal(code, 0, errors + evidence('F26 child exit', raceId));
          assert.equal(JSON.parse(output).answer, 'child answer', evidence('F26 child row', raceId));
          resolve();
        } catch (error) { reject(error); }
      });
    });
    check('F26 owner answer while worker holds claim', raceId, proof => {
      const state = rows(raceId);
      assert.deepEqual(state.claims, claimBeforeAnswer, proof);
      assert.equal(state.assignments[0].status, 'claimed', proof);
      assert.equal(state.job_questions[0].answer, 'child answer', proof);
      assert.equal(state.job_questions[0].consumed_at, null, proof);
      assert.equal(state.reports.length, 0, proof);
    });
    now += 100;
    const successor = store.claim(raceId, 'W2', 'subject-2', 100);
    check('F26 stale question epoch', raceId, proof => {
      const before = rows(raceId);
      assert.equal(before.claims[0].epoch, raceGrant.epoch + 1, proof);
      assert.equal(before.job_questions[0].epoch, raceGrant.epoch, proof);
      assert.throws(() => store.consumeAnswer(raceId, successor.claim_id, 'Q', 'subject-2'),
        error => error.code === 'STALE_EPOCH', proof);
      assert.deepEqual(rows(raceId), before, evidence('F26 refused stale consume', raceId));
    });
    console.log(`PASS characterize ${asserted} asserted, 0 gaps`);
  } finally {
    try { store.db.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}
