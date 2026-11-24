#!/usr/bin/env node
// The queries that run on a timer or on every owner read must use an index. On the live database (428 MB) these scanned whole
// tables, 2.7 GB per minute, and under memory pressure each scan was a disk read that blocked the event loop for seconds.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { statusEvidence } from '../src/status-evidence.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dalan-read-volume-'));
let now = Date.parse('2026-11-24T00:00:00.000Z');
const limits = { intervalMs: 600000, maxCount: 3, silenceMs: 1200000, leaseMs: 3600000, laneCapacity: 6 };
const open = name => new Store(join(dir, `${name}.db`), { now: () => now, random: () => 0.5, capacity: 6, limits });
const payload = id => ({ schema_version: 1, request_id: id, brief: `read volume ${id}`, inputs: [], expected_output: 'one result', execution_scope: 'read-only' });
const pass = message => console.log(`PASS ${message}`);

// The statements one call runs, each with its query plan.
function plansOf(store, call) {
  const seen = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { seen.push(sql); return prepare(sql); };
  try { call(); } finally { store.db.prepare = prepare; }
  return seen.map(sql => {
    const marks = (sql.match(/\?/g) ?? []).length;
    return { sql: sql.replace(/\s+/g, ' '), plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(marks).fill(null)).map(row => row.detail) };
  });
}
const fullScans = plans => plans.filter(p => /^SCAN (assignments|notifications|progress|reports)$/.test(p));
const find = (statements, text) => { const hit = statements.find(s => s.sql.includes(text)); assert(hit, `no statement containing ${text}`); return hit; };

try {
  const store = open('main');
  const indexes = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
  for (const name of ['notifications_due_live', 'notifications_held', 'progress_request', 'assignments_worker_status']) assert(indexes.has(name), `missing index ${name}`);
  const version = store.db.prepare('PRAGMA user_version').get().user_version;
  store.db.close();
  const reopened = open('main');
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, version, 'the indexes must not change the schema version, so older code can open the database');
  reopened.db.close();
  pass('read indexes exist, are created idempotently, and leave the schema version alone');

  const s = open('plans');
  for (const id of ['a', 'b', 'c']) s.submit(payload(id), { mode: 'none' }, null, 'owner');
  const claim = s.claim('a', 'dot', 'subject', 6);
  s.db.prepare('INSERT INTO progress(request_id,note,created_at) VALUES(?,?,?)').run('a', 'note', s.stamp());

  const due = plansOf(s, () => s.due());
  assert(find(due, 'FROM notifications WHERE kind IN').plan.some(p => p.includes('notifications_due_live')), 'due() must use the partial index');
  const get = plansOf(s, () => s.get('a'));
  assert(find(get, 'FROM progress WHERE request_id').plan.some(p => p.includes('progress_request')), 'get() must find progress by request_id');
  assert.deepEqual(fullScans(get.flatMap(x => x.plan)), [], 'get() scans no whole table');
  const status = plansOf(s, () => s.status({ limits, capacity: 6 }));
  assert.deepEqual(fullScans(status.flatMap(x => x.plan)), [], `status() scans no whole table: ${JSON.stringify(fullScans(status.flatMap(x => x.plan)))}`);
  assert(find(status, 'SELECT DISTINCT target_worker').plan.some(p => p.includes('assignments_worker_status')), 'status() reads worker names from the index');
  const finish = plansOf(s, () => s.finish('a', claim.claim_id, 'completed', 'done', 'done', 'subject'));
  assert(find(finish, "result superseded question").plan.some(p => p.includes('request_id=?')), 'finish() looks up its own notifications by request_id');
  assert.deepEqual(fullScans(find(finish, 'result superseded question').plan), [], 'finish() scans no whole table');
  s.db.close();
  pass('due(), get(), status() and finish() use indexes: no whole-table scan of assignments, notifications, progress or reports');

  // statusEvidence reads only new rows. Its answer must equal reading every row each time.
  const e = open('evidence');
  const denial = /auto-?review|guardian|denied|not approved|paused out of precaution/i;
  const waiting = /auto.?stop|paused out of precaution|(?:resume|confirmation|approval).*(?:required|requested|needed)|(?:waiting|wait).*(?:guardian|confirmation|approval)/i;
  const naive = () => {
    const rows = [
      ...e.db.prepare('SELECT request_id,id row_id,created_at at,note text FROM progress').all().map(r => ({ ...r, source: 'progress' })),
      ...e.db.prepare('SELECT request_id,rowid row_id,created_at at,summary text FROM reports').all().map(r => ({ ...r, source: 'report' })),
      ...e.db.prepare('SELECT request_id,rowid row_id,created_at at,summary text FROM late_evidence').all().map(r => ({ ...r, source: 'late_evidence' })),
    ];
    const summarize = predicate => {
      const matches = rows.filter(r => predicate(r.text)).sort((a, b) => b.at.localeCompare(a.at));
      return { count: new Set(matches.map(r => r.request_id)).size, last_at: matches[0]?.at ?? null, evidence: matches.slice(0, 20).map(({ request_id, row_id, at, source }) => ({ request_id, row_id, at, source })) };
    };
    return { denial_suspected: summarize(t => denial.test(t)), worker_reported_guardian_wait: summarize(t => denial.test(t) && waiting.test(t)) };
  };
  const incremental = () => { const { denial_suspected, worker_reported_guardian_wait } = statusEvidence(e); return { denial_suspected, worker_reported_guardian_wait }; };
  assert.deepEqual(incremental(), naive(), 'empty');
  const texts = ['Guardian auto-stop; confirmation requested', 'plain progress', 'Auto-review denied the change', 'waiting for guardian approval', 'nothing here', 'paused out of precaution'];
  let n = 0;
  for (let round = 0; round < 6; round++) {
    for (const text of texts.slice(0, 2 + round)) {
      const id = `r${n++}`;
      e.submit(payload(id), { mode: 'none' }, null, 'owner');
      now += 1000;
      e.db.prepare('INSERT INTO progress(request_id,note,created_at) VALUES(?,?,?)').run(id, text, e.stamp());
      if (n % 2 === 0) { const c = e.claim(id, 'dot', 'subject', 6); e.finish(id, c.claim_id, 'completed', text, 'result', 'subject'); }
      if (n % 3 === 0) e.db.prepare("INSERT INTO late_evidence(request_id,claim_id,epoch,worker,outcome,summary,result,full_sha256,truncated,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, 'claim_x', 1, 'dot', 'completed', text, 'late', 'sha', 0, e.stamp());
    }
    assert.deepEqual(incremental(), naive(), `round ${round}`);
    assert.deepEqual(incremental(), naive(), `round ${round} repeated with no new rows`);
  }
  assert(naive().denial_suspected.count > 0, 'the fixture must contain denial evidence');
  e.db.close();
  pass('statusEvidence reads only new rows and still equals a full read after every batch of inserts');
} finally { rmSync(dir, { recursive: true, force: true }); }
