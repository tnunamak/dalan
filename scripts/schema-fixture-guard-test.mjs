#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { dropEmptyPost54FixtureState } from '../src/test-support/pre-worker-fixture.mjs';

const fixtureParent = path.join(os.homedir(), '.tmp');
fs.mkdirSync(fixtureParent, { recursive: true });
const root = fs.mkdtempSync(path.join(fixtureParent, 'schema-fixture-'));
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
const hasLeaseDeadline = db => !!db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='lease_deadline_at'").get();
const snapshot = db => ({
  schema: db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
  rows: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name}) => [name, db.prepare(`SELECT * FROM \"${name}\"`).all()])),
  version: db.prepare('PRAGMA user_version').get().user_version,
});
const newTables = ['protocol_delivery_attempts', 'protocol_delivery_receipts', 'protocol_stop_enrollments', 'protocol_stop_observations', 'protocol_stop_receipts', 'submit_supersedes', 'destination_approvals', 'destination_blocks'];

try {
  // Existing question-only guard coverage stays valid for minimal in-memory schemas.
  const minimal = new DatabaseSync(':memory:');
  minimal.exec('CREATE TABLE question_answer_wakes(id); INSERT INTO question_answer_wakes VALUES(1); CREATE TABLE job_questions(id); INSERT INTO job_questions VALUES(1);');
  assert.throws(() => dropEmptyPost54FixtureState(minimal), /nonempty question_answer_wakes/);
  assert.equal(hasTable(minimal, 'question_answer_wakes'), true);
  assert.equal(hasTable(minimal, 'job_questions'), true);
  minimal.close();

  const protocolFile = path.join(root, 'protocol.db');
  const protocol = new DatabaseSync(protocolFile);
  protocol.exec(`CREATE TABLE question_answer_wakes(id); CREATE TABLE claims(request_id TEXT, lease_deadline_at TEXT);
    CREATE TABLE protocol_events(value TEXT); INSERT INTO protocol_events VALUES('retained');`);
  assert.throws(() => dropEmptyPost54FixtureState(protocol), /nonempty protocol_events/);
  assert.equal(hasTable(protocol, 'question_answer_wakes'), true, 'empty question table was dropped before the later refusal');
  assert.equal(hasLeaseDeadline(protocol), true, 'lease column was dropped before the later refusal');
  assert.equal(protocol.prepare('SELECT value FROM protocol_events').get().value, 'retained');
  protocol.close();

  const leaseFile = path.join(root, 'lease.db');
  const lease = new DatabaseSync(leaseFile);
  lease.exec(`CREATE TABLE question_answer_wakes(id); CREATE TABLE protocol_jobs(value TEXT);
    CREATE TABLE claims(request_id TEXT, lease_deadline_at TEXT);
    INSERT INTO claims VALUES('fixed-grant','2030-01-01T00:00:00.000Z');`);
  assert.throws(() => dropEmptyPost54FixtureState(lease,{requireEmptyLeaseDeadlines:true}), /nonnull claims\.lease_deadline_at/);
  assert.equal(hasTable(lease, 'question_answer_wakes'), true, 'empty table was dropped before lease refusal');
  assert.equal(hasTable(lease, 'protocol_jobs'), true);
  assert.equal(hasLeaseDeadline(lease), true);
  lease.close();

  // Each new schema table must be checked before any table or column is dropped.
  for (const table of newTables) {
    const guarded = new DatabaseSync(':memory:');
    guarded.exec(`CREATE TABLE question_answer_wakes(id); CREATE TABLE claims(request_id TEXT, lease_deadline_at TEXT); CREATE TABLE \"${table}\"(value TEXT); INSERT INTO \"${table}\" VALUES('retained'); PRAGMA user_version=60;`);
    const before = snapshot(guarded);
    assert.throws(() => dropEmptyPost54FixtureState(guarded), new RegExp(`nonempty ${table}`));
    assert.deepEqual(snapshot(guarded), before, `${table} refusal must preserve every table, row, and schema version`);
    guarded.close();
  }

  const file = path.join(root, 'reopen.db');
  let store = new Store(file);
  const assignment = { schema_version: 1, request_id: 'schema_fixture_claim', brief: 'fixture claim', inputs: [], expected_output: 'report', execution_scope: 'read-only' };
  store.submit(assignment, { mode: 'none' }, null, 'owner');
  const claim = store.claim(assignment.request_id, 'dot', 'subject', 6);
  store.db.prepare('UPDATE claims SET lease_deadline_at=NULL,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?').run(assignment.request_id);
  const beforeFixture = store.db.prepare('SELECT claim_id,lease_ms,lease_deadline_at FROM claims WHERE request_id=?').get(assignment.request_id);
  dropEmptyPost54FixtureState(store.db);
  store.db.exec('PRAGMA user_version=55');
  store.db.close();
  store = new Store(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,65);
  assert.deepEqual({...store.db.prepare('SELECT claim_id,lease_ms,lease_deadline_at FROM claims WHERE request_id=?').get(assignment.request_id)}, {...beforeFixture, lease_deadline_at: new Date(Date.parse(store.db.prepare('SELECT last_claim_activity_at FROM claims WHERE request_id=?').get(assignment.request_id).last_claim_activity_at) + beforeFixture.lease_ms).toISOString()});
  // Opening the store backfills a missing deadline from the claim's last activity and its lease duration.
  assert.equal(store.db.prepare('SELECT claim_id FROM claims WHERE request_id=?').get(assignment.request_id).claim_id, claim.claim_id);
  store.db.close();
  console.log('PASS post-54 fixture guard refuses data loss atomically and an empty historical fixture migrates and reopens with claim identity and lease duration intact');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
