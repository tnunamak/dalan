#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';

const scratch = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true });
const home = fs.mkdtempSync(path.join(scratch, 'dalan-read-verbs-'));
const data = path.join(home, '.local/share/dalan');
fs.mkdirSync(data, { recursive: true });
const file = path.join(data, 'bridge.db');
const cli = new URL('../bin/dalan.mjs', import.meta.url).pathname;
const run = (verb, ...args) => spawnSync(process.execPath, [cli, verb, '--json', ...args], {
  env: { ...process.env, DALAN_HOME: home, DALAN_NO_FOLLOW: '1' }, encoding: 'utf8', timeout: 10000,
});
const page = (verb, ...args) => {
  const result = run(verb, ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
let store;
try {
  let now = Date.parse('2026-11-01T00:00:00Z');
  store = new Store(file, { now: () => now });
  for (let i = 0; i < 4; i++) {
    // Tie creation times to exercise the ID tiebreaker.
    now = Date.parse(i < 2 ? '2026-11-01T00:00:00Z' : '2026-11-02T00:00:00Z');
    const id = `req_read_000${i}`;
    const payload = { schema_version: 1, request_id: id, brief: `fixture ${i}`, inputs: [{github_repo:'example/repo'}], expected_output: 'report', execution_scope: 'read-only' };
    store.submit(payload, { mode: 'none' }, null, i === 3 ? 'other-owner' : 'fixture-owner', false, null,
      'normal', { source: i === 3 ? 'agent' : 'drainer', task_kind: i === 3 ? 'build' : 'review', objective_key: `fixture:${i}` }, payload, null, i === 3 ? 'muse' : 'dot');
  }
  store.db.prepare("UPDATE assignments SET status='finished' WHERE request_id='req_read_0000'").run();
  store.db.prepare("INSERT INTO reports(request_id,claim_id,outcome,summary,result,receipt_id,created_at,worker) VALUES(?,?,?,?,?,?,?,?)")
    .run('req_read_0000', 'fixture-claim', 'completed', 'done', 'report body', 'fixture-receipt', '2026-11-03T00:00:00.000Z', 'dot');
  store.db.prepare("INSERT INTO decisions(request_id,decision,actor,via,at) VALUES(?,?,?,?,?)")
    .run('req_read_0000','accepted','owner','test','2026-11-03T01:00:00Z');
  store.db.prepare("INSERT INTO lifecycle_events(request_id,type,at,actor,source,worker) VALUES(?,?,?,?,?,?)")
    .run('req_read_0000','completed','2026-11-03T00:00:00.000Z','worker','live','dot');
  store.db.prepare("UPDATE assignments SET status='claimed',valid_until=?,skipped_at=? WHERE request_id='req_read_0001'").run('2026-11-05T00:00:00Z','2026-11-01T01:00:00Z');
  store.db.prepare('INSERT INTO claims(request_id,claimant,claim_id,claimed_at,worker,last_claim_activity_at,acquisition_id) VALUES(?,?,?,?,?,?,?)')
    .run('req_read_0001','fixture','active-claim','2026-11-01T01:00:00Z','dot','2026-11-01T02:00:00Z','handoff-fixture');
  store.db.close(); store = null;
  const before = fs.readFileSync(file);
  const all = page('jobs');
  assert.equal(all.schema_version, 1);
  assert.equal(all.jobs.length, 4);
  assert.equal(all.next_cursor, null);
  const job = all.jobs[0];
  assert.equal(job.result, 'report body');
  assert.equal(job.payload.inputs[0].github_repo, 'example/repo');
  assert.equal(job.decision, 'accepted');
  assert.equal(job.finished_at, '2026-11-03T00:00:00.000Z');
  assert.equal(job.claimed_at, null);
  const claimed = all.jobs[1];
  assert.equal(claimed.claim_state, 'active');
  assert.equal(claimed.claim_worker, 'dot');
  assert.equal(claimed.last_claim_activity_at, '2026-11-01T02:00:00Z');
  assert.equal(claimed.acquisition_id, 'handoff-fixture');
  assert.equal(claimed.valid_until, '2026-11-05T00:00:00Z');
  assert.equal(claimed.skipped_at, '2026-11-01T01:00:00Z');
  for (const field of ['cancelled_at','valid_until','skipped_at','claim_worker','claim_state','abandoned_at','last_claim_activity_at','acquisition_id','report_worker']) assert.ok(Object.hasOwn(job, field), field);
  for (const [flag, value, count] of [['worker','dot',3],['status','queued',2],['kind','review',3],['source','drainer',3],['since','2026-11-02T00:00:00Z',2]]) {
    assert.equal(page('jobs', `--${flag}`, value).jobs.length, count, flag);
  }
  assert.equal(page('jobs','--worker','dot','--status','queued','--kind','review','--source','drainer').jobs.length,1);
  assert.ok(!JSON.stringify(all).includes('owner_hash'));
  const first = page('jobs','--limit','1');
  const ids = [...first.jobs.map(j=>j.request_id)];
  let cursor = first.next_cursor;
  while (cursor) { const next = page('jobs','--limit','1','--cursor',cursor); ids.push(...next.jobs.map(j=>j.request_id)); cursor=next.next_cursor; }
  assert.deepEqual(ids, all.jobs.map(j=>j.request_id));
  const events = page('events','--since','2026-11-03T00:00:00Z','--worker','dot','--type','completed');
  assert.equal(events.schema_version,1); assert.equal(events.events.length,1);
  assert.equal(events.events[0].request_id,'req_read_0000');
  const eventPage = page('events','--limit','2');
  const eventNext = page('events','--limit','2','--cursor',eventPage.next_cursor);
  assert.ok(eventNext.events[0].id > eventPage.events.at(-1).id);
  assert.equal(page('events','--worker','absent').events.length,0);
  assert.equal(page('jobs','--since','all').jobs.length,4);
  assert.equal(page('jobs','--worker=absent').jobs.length,0);
  const missingHome = path.join(home, 'missing');
  fs.mkdirSync(missingHome);
  const missing = spawnSync(process.execPath, [cli,'jobs','--json'], {
    env: { ...process.env, DALAN_HOME: missingHome, DALAN_NO_FOLLOW: '1' }, encoding: 'utf8', timeout: 10000,
  });
  assert.notEqual(missing.status,0);
  assert.equal(JSON.parse(missing.stderr).schema_version,1);
  assert.deepEqual(fs.readdirSync(missingHome), [], 'missing store must not be initialized');
  for (const [verb,args] of [['jobs',['--limit','0']],['jobs',['--since','nonsense']],['jobs',['--cursor','bad']],['events',['--cursor',first.next_cursor]],['events',['--bogus']],['jobs',['--worker']],['jobs',['--owner-key','not-supported']]]) {
    const result=run(verb,...args); assert.notEqual(result.status,0); assert.equal(JSON.parse(result.stderr).schema_version,1); assert.equal(result.stdout,'');
  }
  assert.deepEqual(fs.readFileSync(file), before, 'read verbs must not write the database');
  console.log('PASS read verbs: fields, filters, tied-time cursor, events, schema_version, errors, read-only database');
} finally {
  store?.db.close();
  fs.rmSync(home, { recursive: true, force: true });
}
