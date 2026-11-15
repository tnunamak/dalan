#!/usr/bin/env node
// Characterization only. Run with node scripts/characterize-native-submit-e2e.mjs.
// Source pin: cb6b119196f025ac8cbbf93f0ee8bd0a30221654. No production changes.
// Reconciles b901/627244/06088 patch d5b52c10ac50781cee4218d0042ab563984aee018116869c5f1d1f6cdd9c0bb2.
// Store constructor/time/temp DB: src/store.mjs:290-343; schema rows:328-333,
// command receipts:836-837. Harness: scripts/question-lifecycle-test.mjs:19-25.
// Positional keyed submit contract: src/store.mjs:1268-1269 and
// scripts/submit-command-key-test.mjs:10-11.
// F01/F02/F24: checkRetry src/store.mjs:1213-1265, especially1254-1261;
// insert/receipt transaction:1268-1279,1321-1345.
// F03: finish delegates/transactions2637-2645; finishOnce2658-2687.
// Native revision-envelope behavior is outside these supplied Store-method
// fixtures; the explicit GAP below is not an invented runtime observation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';

const payload = request_id => ({
  schema_version: 1, request_id, brief: 'native submit characterization',
  inputs: [], expected_output: 'one retained result', execution_scope: 'read-only',
});
const submit = (store, body, key, delivery = {mode: 'none'}) =>
  store.submit(body, delivery, null, 'owner', false, null, 'normal', null,
    body, null, undefined, null, 'none', null, null, key);
const open = file => new Store(file, {
  now: () => 1000000, limits: {leaseMs: 100}, resumeIdleMs: 0,
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assignmentSQL = 'SELECT * FROM assignments WHERE request_id=?';
const commandSQL = 'SELECT * FROM owner_submit_commands WHERE request_id=?';
const countSQL = 'SELECT count(*) AS n FROM assignments WHERE request_id=?';

if (process.argv[2] === '--submit-racer') {
  const [file, id, key, barrier, index] = process.argv.slice(3);
  const store = open(file);
  try {
    fs.writeFileSync(barrier + '.' + index, 'ready');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(barrier)) {
      if (Date.now() > deadline) throw new Error('submit racer barrier timeout');
      await sleep(10);
    }
    const receipt = submit(store, payload(id), key);
    const evidence = {
      assignment: store.db.prepare(assignmentSQL).get(id),
      command: store.db.prepare(commandSQL).get(id),
      count: store.db.prepare(countSQL).get(id),
    };
    assert.equal(evidence.count.n, 1, JSON.stringify({sql: countSQL, evidence}));
    assert.equal(evidence.command.receipt, JSON.stringify({...receipt, duplicate:false}),
      JSON.stringify({sql: commandSQL, evidence}));
    console.log(JSON.stringify({receipt, evidence}));
  } finally { store.db.close(); }
} else {
  const root = fs.mkdtempSync(path.join(
    process.env.DOT_BRIDGE_TEST_TMP ?? os.tmpdir(), 'dalan-characterize-submit-'));
  const file = path.join(root, 'state.db');
  let store;
  let asserted = 0, gaps = 0;
  const gap = (id, message) => { gaps++; console.log('GAP ' + id + ': ' + message); };
  const rows = id => ({
    assignments: store.db.prepare(assignmentSQL).all(id),
    count: store.db.prepare(countSQL).get(id),
    claims: store.db.prepare('SELECT * FROM claims WHERE request_id=?').all(id),
    commands: store.db.prepare(commandSQL).all(id),
    reports: store.db.prepare('SELECT * FROM reports WHERE request_id=?').all(id),
    events: store.db.prepare('SELECT * FROM lifecycle_events WHERE request_id=? ORDER BY id').all(id),
    notifications: store.db.prepare('SELECT * FROM notifications WHERE request_id=? ORDER BY id').all(id),
  });
  const evidence = id => JSON.stringify({
    sql: [assignmentSQL, commandSQL, countSQL, 'SELECT * FROM claims WHERE request_id=?',
      'SELECT * FROM reports WHERE request_id=?',
      'SELECT * FROM lifecycle_events WHERE request_id=? ORDER BY id',
      'SELECT * FROM notifications WHERE request_id=? ORDER BY id'],
    rows: rows(id),
  });
  const same = (actual, expected, id) => {
    assert.deepEqual(actual, expected, evidence(id)); asserted++;
  };
  try {
    store = open(file);
    const body = payload('characterize_F01'), key = 'creation-F01';
    submit(store, body, key); // Deliberately discard the first response.
    const committed = rows(body.request_id);
    same(committed.assignments.length, 1, body.request_id);
    same(committed.count.n, 1, body.request_id);
    same(committed.commands.length, 1, body.request_id);
    const original = JSON.parse(committed.commands[0].receipt);
    store.db.close(); store = undefined; store = open(file);
    same(submit(store, body, key), {...original, duplicate:true}, body.request_id);
    same(rows(body.request_id), committed, body.request_id);

    // Two independent SQLite processes race to replay the same committed key.
    const barrier = path.join(root, 'retry-go');
    const children = [];
    try {
      for (let index=0; index<2; index++) {
        const child = spawn(process.execPath, [
          fileURLToPath(import.meta.url), '--submit-racer', file,
          body.request_id, key, barrier, String(index),
        ], {stdio: ['ignore','pipe','pipe']});
        let stdout='', stderr='';
        child.stdout.on('data', b => stdout += b);
        child.stderr.on('data', b => stderr += b);
        const done = new Promise((resolve,reject) => {
          child.on('error', reject);
          child.on('close', code => {
            if (code !== 0) return reject(new Error('racer: ' + stderr));
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
          });
        });
        // Attach rejection handling immediately while waiting for the barrier.
        done.catch(() => {});
        children.push({child,done});
      }
      const deadline = Date.now()+10000;
      while (!children.every((_,i)=>fs.existsSync(barrier+'.'+i))) {
        if (Date.now()>deadline) throw new Error('retry racers not ready');
        await sleep(10);
      }
      fs.writeFileSync(barrier,'go');
      let raceTimer;
      const results = await (async()=>{try{return await Promise.race([
        Promise.all(children.map(c=>c.done)),
        new Promise((_,reject)=> {
          raceTimer=setTimeout(()=>reject(new Error('retry racers timed out')),10000);
        }),
      ]);}finally{clearTimeout(raceTimer);}})();
      for (const result of results) {
        same(result.receipt,{...original,duplicate:true},body.request_id);
        same(result.evidence.command.receipt,committed.commands[0].receipt,body.request_id);
      }
      same(rows(body.request_id),committed,body.request_id);
    } finally {
      for (const {child} of children)
        if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
      await Promise.allSettled(children.map(c=>c.done));
    }

    // F02: both payload and destination conflict preserve all durable rows,
    // including the exact stored receipt string, not a reconstructed object.
    for (const [changed,delivery] of [
      [{...body,brief:'different intent'},{mode:'none'}],
      [body,{mode:'t3',threadId:'different-fixture-destination'}],
    ]) {
      const before=rows(body.request_id);
      assert.throws(()=>submit(store,changed,key,delivery),/^Error: KEY_CONFLICT:/,
        evidence(body.request_id)); asserted++;
      same(rows(body.request_id),before,body.request_id);
      same(rows(body.request_id).commands[0].receipt,committed.commands[0].receipt,body.request_id);
    }

    // F03: completion precedes the retry; the original queued admission receipt
    // is replayed, but durable terminal state and the worker's report survive.
    const grant=store.claim(body.request_id,'W1','subject-1',100);
    const claimed=rows(body.request_id);
    same(claimed.claims.length,1,body.request_id);
    same(claimed.claims[0].claim_id,grant.claim_id,body.request_id);
    same(claimed.claims[0].subject,'subject-1',body.request_id);
    store.finish(body.request_id,grant.claim_id,'completed','done','retained result','subject-1');
    const terminal=rows(body.request_id);
    same(terminal.assignments[0].status,'finished',body.request_id);
    same(terminal.reports.length,1,body.request_id);
    same(terminal.reports[0].result,'retained result',body.request_id);
    store.db.close(); store=undefined; store=open(file);
    same(submit(store,body,key),{...original,duplicate:true},body.request_id);
    same(rows(body.request_id),terminal,body.request_id);

    // F24: explicit retention-loss simulation, only in this private fixture.
    const lost=payload('characterize_F24'), lostKey='creation-F24';
    submit(store,lost,lostKey);
    store.db.prepare('DELETE FROM owner_submit_commands WHERE request_id=?').run(lost.request_id);
    const afterLoss=rows(lost.request_id);
    same(afterLoss.commands.length,0,lost.request_id);
    same(afterLoss.assignments.length,1,lost.request_id);
    same(afterLoss.count.n,1,lost.request_id);
    store.db.close(); store=undefined; store=open(file);
    assert.throws(()=>submit(store,lost,lostKey),
      /^Error: EXISTS: assignment already submitted under another command/,
      evidence(lost.request_id)); asserted++;
    same(rows(lost.request_id),afterLoss,lost.request_id);
    gap('F24','receipt loss with retained assignment refuses EXISTS (another command), not reconciliation unavailable; no second assignment is created');

    // The permitted patterns expose legacy Store submit/claim/finish, not a
    // native revision-bearing worker-command envelope. Do not fabricate one or
    // mutate revision tables and pretend that was a Store-method journey.
    gap('F01','native revision-advanced retry seam not exercised: allowed Store harnesses do not expose the native worker revision command; command_conflict is reported by the brief, not asserted here');
    console.log('PASS characterize ' + asserted + ' asserted, ' + gaps + ' gaps');
  } finally {
    try { store?.db.close(); }
    finally { fs.rmSync(root,{recursive:true,force:true}); }
  }
}
