#!/usr/bin/env node
// Upgrading to schema 65 keeps every row's worker and the data of the renamed break table and skip marker.
//   1. Only the pre-35 fixture proves the backfill. A database from before schema 35 had a single worker; the columns are
//      added with an empty default, so without the backfill the old rows would lose their worker.
//   2. A database already at schema 35 or later keeps its stored worker names and its stored column default; this case
//      shows the rename keeps data and does not prove the backfill.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';

const temp = path.join(os.homedir(), '.tmp');
fs.mkdirSync(temp, { recursive: true });
const home = fs.mkdtempSync(path.join(temp, 'neutral-schema-upgrade-'));
const AT = '2026-10-01T00:00:00.000Z';
const payload = id => JSON.stringify({ schema_version: 1, request_id: id, brief: `job ${id}`, inputs: [], expected_output: 'report', execution_scope: 'read-only' });
const insertAssignment = (db, id, worker, skippedAt = null) => {
  const columns = ['request_id', 'payload', 'payload_hash', 'thread_id', 'environment_id', 'status', 'created_at', 'skipped_by_dot_at', ...(worker ? ['target_worker'] : [])];
  db.prepare(`INSERT INTO assignments(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    .run(id, payload(id), `hash_${id}`, 't', 'e', 'queued', AT, skippedAt, ...(worker ? [worker] : []));
};
const insertMessage = (db, id, worker) => {
  const columns = ['message_id', 'text', 'text_sha256', 'preview', 'created_at', ...(worker ? ['target_worker'] : [])];
  db.prepare(`INSERT INTO messages(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(id, `text ${id}`, `sha_${id}`, `text ${id}`, AT, ...(worker ? [worker] : []));
};
const insertBreak = db => {
  db.prepare("INSERT INTO dot_breaks(since,until,reason,source,end_source,usage,created_at) VALUES(?,?,?,?,?,?,?)").run(AT, '2026-10-01T01:00:00.000Z', 'fixture break', 'owner', 'owner', '{}', AT);
  const id = db.prepare('SELECT max(id) id FROM dot_breaks').get().id;
  db.prepare('INSERT INTO break_notices(break_id,target,request_ids,notification_id,created_at) VALUES(?,?,?,?,?)').run(id, 'queued-target', '["req_a"]', null, AT);
  return id;
};
const rows = (db, sql) => db.prepare(sql).all().map(r => ({ ...r }));
// The names a database from before schema 65 used for the break table and the skip marker.
const assertRenamed = (db, breakId) => {
  const names = rows(db, "SELECT name FROM sqlite_master WHERE name LIKE '%breaks%'").map(r => r.name);
  assert.ok(names.includes('worker_breaks') && names.includes('worker_breaks_one_active'), `renamed table and index: ${names}`);
  assert.ok(!names.some(n => n.startsWith('dot_breaks')), `no old table or index name remains: ${names}`);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='break_notices'").get().sql, /REFERENCES "?worker_breaks"?\(id\)/, 'the break_notices foreign key follows the rename');
  assert.deepEqual(rows(db, 'SELECT b.reason, n.target FROM break_notices n JOIN worker_breaks b ON b.id=n.break_id WHERE b.id=' + breakId), [{ reason: 'fixture break', target: 'queued-target' }], 'break_notices still joins');
  assert.equal(db.prepare("SELECT count(*) n FROM pragma_table_info('assignments') WHERE name='skipped_by_dot_at'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM pragma_table_info('assignments') WHERE name='skipped_at'").get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
};

try {
  // ---- 1. before schema 35: rows have no worker column yet
  {
    const file = path.join(home, 'pre35.db');
    const old = new Store(file);
    preWorkerFixture(old);
    assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 34);
    assert.equal(old.db.prepare("SELECT count(*) n FROM pragma_table_info('assignments') WHERE name='target_worker'").get().n, 0);
    insertAssignment(old.db, 'req_old_1', null, AT);
    insertAssignment(old.db, 'req_old_2', null);
    insertMessage(old.db, 'msg_old_1', null);
    const breakId = insertBreak(old.db);
    old.db.close();
    const upgraded = new Store(file);
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 65);
    assert.deepEqual(rows(upgraded.db, 'SELECT request_id, target_worker FROM assignments ORDER BY request_id'),
      [{ request_id: 'req_old_1', target_worker: 'dot' }, { request_id: 'req_old_2', target_worker: 'dot' }], 'rows from before schema 35 keep the one worker they had');
    assert.deepEqual(rows(upgraded.db, 'SELECT message_id, target_worker FROM messages'), [{ message_id: 'msg_old_1', target_worker: 'dot' }]);
    assert.deepEqual(rows(upgraded.db, 'SELECT request_id, skipped_at FROM assignments ORDER BY request_id'), [{ request_id: 'req_old_1', skipped_at: AT }, { request_id: 'req_old_2', skipped_at: null }], 'skip marker data survives the rename');
    assertRenamed(upgraded.db, breakId);
    // The columns were added with an empty default, so the stored schema text does not name the old worker.
    assert.doesNotMatch(upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE name='assignments'").get().sql, /target_worker TEXT NOT NULL DEFAULT 'dot'/);
    upgraded.db.close();
  }

  // ---- 2. at schema 35 or later under the earlier step: the stored default is 'dot' and rows name their worker
  {
    const file = path.join(home, 'post35.db');
    new Store(file).db.close();
    const raw = new DatabaseSync(file, { defensive: false });
    // Write the schema text as the earlier v35 step did, and use the earlier names for the break table and skip marker.
    raw.exec(`PRAGMA writable_schema=ON;
      UPDATE sqlite_master SET sql=replace(sql,'target_worker TEXT NOT NULL DEFAULT ''''','target_worker TEXT NOT NULL DEFAULT ''dot''') WHERE type='table' AND name IN ('assignments','messages');
      PRAGMA writable_schema=OFF;`);
    raw.close();
    const old = new Store(file);
    old.db.exec('ALTER TABLE worker_breaks RENAME TO dot_breaks; ALTER TABLE assignments RENAME COLUMN skipped_at TO skipped_by_dot_at; PRAGMA user_version=62;');
    assert.match(old.db.prepare("SELECT sql FROM sqlite_master WHERE name='assignments'").get().sql, /target_worker TEXT NOT NULL DEFAULT 'dot'/, 'fixture carries the earlier default');
    insertAssignment(old.db, 'req_dot', 'dot', AT);
    insertAssignment(old.db, 'req_acme', 'acme');
    insertMessage(old.db, 'msg_dot', 'dot');
    insertMessage(old.db, 'msg_acme', 'acme');
    const breakId = insertBreak(old.db);
    old.db.close();
    const upgraded = new Store(file);
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 65);
    assert.deepEqual(rows(upgraded.db, 'SELECT request_id, target_worker, skipped_at FROM assignments ORDER BY request_id'),
      [{ request_id: 'req_acme', target_worker: 'acme', skipped_at: null }, { request_id: 'req_dot', target_worker: 'dot', skipped_at: AT }], 'each row keeps its worker');
    assert.deepEqual(rows(upgraded.db, 'SELECT message_id, target_worker FROM messages ORDER BY message_id'), [{ message_id: 'msg_acme', target_worker: 'acme' }, { message_id: 'msg_dot', target_worker: 'dot' }]);
    assertRenamed(upgraded.db, breakId);
    // Documented difference: a database that was already at schema 35 keeps the default in its stored schema text.
    assert.match(upgraded.db.prepare("SELECT sql FROM sqlite_master WHERE name='assignments'").get().sql, /target_worker TEXT NOT NULL DEFAULT 'dot'/);
    upgraded.db.close();
    // Reopening a migrated database changes nothing.
    const again = new Store(file);
    assert.deepEqual(rows(again.db, 'SELECT request_id, target_worker FROM assignments ORDER BY request_id').map(r => r.target_worker), ['acme', 'dot']);
    again.db.close();
  }
  console.log('PASS neutral schema upgrade: rows keep their worker, the break table and skip marker keep their data under neutral names');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
