#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-bridge-downgrade-'));
const snapshot = file => {
  const db = new DatabaseSync(file);
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      schema: db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      assignments: db.prepare('SELECT * FROM assignments ORDER BY request_id').all(),
      claims: db.prepare('SELECT * FROM claims ORDER BY request_id').all(),
      events: db.prepare('SELECT * FROM lifecycle_events ORDER BY id').all(),
      marker: db.prepare('SELECT value FROM future_marker').all(),
    };
  } finally { db.close(); }
};
const makeFutureDb = file => {
  const store = new Store(file);
  const assignment = { schema_version: 1, request_id: 'req_future', brief: 'future schema fixture', inputs: [], expected_output: 'report' };
  store.submit(assignment, { mode: 'none' }, null, 'owner');
  store.claim(assignment.request_id, 'dot', 'owner', 6);
  store.db.exec("CREATE TABLE future_marker(value TEXT NOT NULL); INSERT INTO future_marker VALUES('preserve'); PRAGMA user_version=67;");
  store.db.close();
};

try {
  const file = path.join(root, 'bridge.db');
  makeFutureDb(file);
  const before = snapshot(file);
  assert.equal(before.version, 67);
  assert.equal(before.claims[0].request_id, 'req_future');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.local/share/dot-bridge'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true });
  fs.copyFileSync(file, path.join(home, '.local/share/dot-bridge/bridge.db'));
  const server = spawnSync(process.execPath, ['src/server.mjs'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: { ...process.env, HOME: home, DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_PORT: '0' },
    encoding: 'utf8', timeout: 5000,
  });
  const output = `${server.stdout}\n${server.stderr}`;
  assert.ifError(server.error);
  assert.equal(server.signal, null, 'refusal must complete without a timeout or signal');
  assert.equal(server.status, 1, 'server must refuse startup for a future schema');
  assert.match(output, /schema version 67.*supported version 66/);
  assert.match(output, /matching or newer dot-bridge code|consistent compatible backup/);
  assert.doesNotMatch(output, /MCP listening|admin socket/);
  assert.deepEqual(snapshot(path.join(home, '.local/share/dot-bridge/bridge.db')), before, 'startup must not alter schema, claims, lifecycle history, or version');
  assert.throws(() => new Store(file), /schema version 67.*supported version 66/);
  assert.deepEqual(snapshot(file), before, 'refusal must leave future database contents unchanged');

  const unknown = path.join(root, 'unknown-schema.db');
  const unknownDb = new DatabaseSync(unknown);
  unknownDb.exec('CREATE TABLE future_only(value TEXT); INSERT INTO future_only VALUES(\'intact\'); PRAGMA user_version=99;');
  unknownDb.close();
  assert.throws(() => new Store(unknown), /schema version 99.*supported version 66.*Do not reset user_version/);
  const unknownAfter = new DatabaseSync(unknown);
  assert.equal(unknownAfter.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(unknownAfter.prepare('SELECT value FROM future_only').get().value, 'intact');
  assert.equal(unknownAfter.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='assignments'").get().n, 0, 'guard must run before bootstrap DDL');
  assert.throws(() => Store.prototype.migrate.call({ db: unknownAfter, transaction: fn => fn() }), /schema version 99.*supported version 66/);
  unknownAfter.close();

  // Draft builds may have installed any subset of schema 60 before recording its version.
  for (const objects of ['none', 'tables', 'tables-and-triggers']) for (const column of [false, true]) {
    const file59 = path.join(root, `draft-59-${objects}-${column}.db`);
    const draft = new Store(file59);
    const names = ['destination_approvals', 'destination_blocks', 'destination_approvals_immutable', 'destination_approvals_no_delete'];
    const ddl = names.map(name => draft.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name).sql);
    draft.db.exec('DROP TABLE policy_work_orders; DROP TABLE destination_approvals; DROP TABLE destination_blocks; ALTER TABLE claims DROP COLUMN destination_revision; PRAGMA user_version=59;');
    if (objects !== 'none') draft.db.exec(ddl.slice(0, objects === 'tables' ? 2 : 4).join(';') + ';');
    if (column) draft.db.exec('ALTER TABLE claims ADD COLUMN destination_revision TEXT;');
    const id = 'req_draft_59';
    draft.db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,created_at) VALUES(?,?,?,'','',?)")
      .run(id, '{}', 'draft-fixture', new Date().toISOString());
    if (objects !== 'none') {
      draft.db.prepare('INSERT INTO destination_approvals VALUES(?,?,?,?,?)').run(id, 'draft-revision', '{}', '{}', 'draft-time');
      draft.db.prepare('INSERT INTO destination_blocks VALUES(?,?)').run(id, '{"draft":true}');
    }
    assert.equal(draft.db.prepare('PRAGMA user_version').get().user_version, 59);
    draft.db.close();
    const migrated = new Store(file59);
    try {
      assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version,66);
      assert.equal(migrated.db.prepare("SELECT count(*) n FROM pragma_table_info('claims') WHERE name='destination_revision'").get().n, 1);
      for (const name of names) assert.ok(migrated.db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(name));
      assert.equal(migrated.db.prepare('SELECT payload_hash FROM assignments WHERE request_id=?').get(id).payload_hash, 'draft-fixture');
      if (objects !== 'none') {
        assert.equal(migrated.db.prepare('SELECT revision FROM destination_approvals WHERE request_id=?').get(id).revision, 'draft-revision');
        assert.equal(migrated.db.prepare('SELECT body FROM destination_blocks WHERE request_id=?').get(id).body, '{"draft":true}');
        assert.throws(() => migrated.db.prepare('UPDATE destination_approvals SET revision=? WHERE request_id=?').run('changed', id), /immutable/);
        assert.throws(() => migrated.db.prepare('DELETE FROM destination_approvals WHERE request_id=?').run(id), /immutable/);
      }
    } finally { migrated.db.close(); }
    const again = new Store(file59);
    assert.equal(again.db.prepare('PRAGMA user_version').get().user_version,66);
    again.db.close();
  }

  // Schema 61 adds claims.connection_id. A build that added the column but died before recording the version must migrate too,
  // and a grant made before the column existed keeps NULL: the connection is never inferred.
  for (const column of [false, true]) {
    const file60 = path.join(root, `v60-${column}.db`);
    const old = new Store(file60);
    const id = 'req_v60';
    old.submit({ schema_version: 1, request_id: id, brief: 'v60 fixture', inputs: [], expected_output: 'report', execution_scope: 'read-only' }, { mode: 'none' }, null, 'owner');
    old.claim(id, 'dot', 'owner', 6);
    old.db.exec('DROP TABLE policy_work_orders; ALTER TABLE claims DROP COLUMN connection_id; PRAGMA user_version=60;');
    if (column) old.db.exec('ALTER TABLE claims ADD COLUMN connection_id TEXT;');
    old.db.close();
    const migrated61 = new Store(file60);
    try {
      assert.equal(migrated61.db.prepare('PRAGMA user_version').get().user_version,66);
      assert.equal(migrated61.db.prepare("SELECT count(*) n FROM pragma_table_info('claims') WHERE name='connection_id'").get().n, 1);
      assert.equal(migrated61.db.prepare('SELECT connection_id FROM claims WHERE request_id=?').get(id).connection_id, null);
    } finally { migrated61.db.close(); }
  }

  const current = path.join(root, 'current.db');
  const store = new Store(current);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,66);
  store.db.close();
  const reopened = new Store(current);
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,66);
  reopened.db.close();
  console.log('PASS future schema refusal preserves data before startup recovery; unknown identity gets version guidance; current schema reopens');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
