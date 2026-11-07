#!/usr/bin/env node
// A mid-migration SQLite error must leave the historical schema and in-flight claim intact for a retry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { dropEmptyPost54FixtureState, preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
import { skipCheck } from '../src/test-support/skipped-check.mjs';
import { prepublicSkip, readPrepublicFixture } from '../src/test-support/prepublic-fixtures.mjs';

const temp = path.join(os.homedir(), '.tmp/.tmp');
fs.mkdirSync(temp, { recursive: true });
const home = fs.mkdtempSync(path.join(temp, 'migration-atomicity-'));
const snapshot = db => ({
  version: db.prepare('PRAGMA user_version').get().user_version,
  // Store bootstraps this empty table before migrate(); the worker migration must roll back all other schema writes.
  schema: db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name<>'bridge_state' ORDER BY type,name").all().map(row => ({ ...row })),
  assignments: db.prepare('SELECT * FROM assignments ORDER BY request_id').all().map(row => ({ ...row })),
  claims: db.prepare('SELECT * FROM claims ORDER BY request_id').all().map(row => ({ ...row })),
  events: db.prepare('SELECT * FROM lifecycle_events ORDER BY rowid').all().map(row => ({ ...row })),
});
const payload = { schema_version: 1, request_id: 'in-flight', brief: 'migration fixture', inputs: [], expected_output: 'report', execution_scope: 'read-only' };
// seed(file) writes a schema-34 database holding payload under an in-flight claim and returns its open handle.
async function midMigrationFailure(name, file, seed) {
  let db, current;
  try {
    const { db: seeded, claim } = await seed(file);
    assert.equal(seeded.prepare('PRAGMA user_version').get().user_version, 34);
    // SQLite itself fails after ALTERs and attribution writes, before the v35 migration is complete.
    seeded.exec('CREATE TABLE worker_calls_v35(collision TEXT)');
    const before = snapshot(seeded);
    seeded.close();
    assert.throws(() => new Store(file), /worker_calls_v35 already exists/);
    db = new DatabaseSync(file);
    assert.equal(db.prepare('SELECT count(*) n FROM bridge_state').get().n, 0, 'failed migration recorded no profile state');
    assert.deepEqual(snapshot(db), before, 'failed migration must roll back every schema, attribution and version write');
    db.exec('DROP TABLE worker_calls_v35'); db.close(); db = null;
    current = new Store(file);
    assert.equal(current.db.prepare('PRAGMA user_version').get().user_version, 65);
    assert.equal(current.get(payload.request_id).claim.claim_id, claim.claim_id);
    assert.equal(current.get(payload.request_id).assignment.brief, payload.brief);
    assert.doesNotThrow(() => current.progress(payload.request_id, claim.claim_id, 'continued after retry', 'subject'));
    console.log(`PASS mid-DDL failure: ${name}: the schema-34 database and claim survive; a retry reaches schema 65 and continues the claim`);
  } finally { db?.close(); current?.db.close(); }
}
try {
  const guardDb = new DatabaseSync(':memory:');
  guardDb.exec('CREATE TABLE question_answer_wakes(id INTEGER); INSERT INTO question_answer_wakes VALUES(1); CREATE TABLE job_questions(id INTEGER); INSERT INTO job_questions VALUES(1);');
  assert.throws(() => dropEmptyPost54FixtureState(guardDb), /nonempty question_answer_wakes/);
  assert.equal(guardDb.prepare('SELECT count(*) AS count FROM question_answer_wakes').get().count, 1, 'nonempty wake rows survive refusal');
  assert.equal(guardDb.prepare('SELECT count(*) AS count FROM job_questions').get().count, 1, 'question rows survive refusal');
  guardDb.prepare('DELETE FROM question_answer_wakes').run();
  assert.throws(() => dropEmptyPost54FixtureState(guardDb), /nonempty job_questions/);
  assert.equal(guardDb.prepare('SELECT count(*) AS count FROM job_questions').get().count, 1, 'nonempty questions survive refusal');
  assert.equal(guardDb.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='question_answer_wakes'").get().count, 1, 'empty wake table is also retained when another table refuses downgrade');
  guardDb.close();

  const fixture = new Store(path.join(home, 'fixture.db'));
  try {
    preWorkerFixture(fixture);
    assert.equal(fixture.db.prepare('PRAGMA user_version').get().user_version, 34);
    assert.equal(fixture.db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='connection_id'").get(), undefined,
      'schema-34 fixture must not retain the schema-61 connection column');
    fixture.migrate();
    assert.equal(fixture.db.prepare('PRAGMA user_version').get().user_version,65);
    assert.ok(fixture.db.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='connection_id'").get(),
      'migration 61 recreates the connection column');
  } finally { fixture.db.close(); }

  // A schema-34 database with an in-flight claim, built here by today's Store. It needs no historical source.
  await midMigrationFailure('synthesized schema 34', path.join(home, 'synthesized.db'), async file => {
    const store = new Store(file);
    store.submit(payload, { mode: 'none' }, null, 'owner');
    const claim = store.claim(payload.request_id, 'dot', 'subject', 6);
    preWorkerFixture(store);
    return { db: store.db, claim };
  });

  // The same failure against a database written by the pre-public base release's own Store.
  const BASE_ARCHIVE = 'src/test-support/worker-history/27a0a2d.tgz';
  const baseName = 'pre-public base release';
  const skip = prepublicSkip(BASE_ARCHIVE);
  if (skip) skipCheck(`mid-DDL failure: ${baseName}`, skip);
  else {
    const base = path.join(home, 'base');
    fs.mkdirSync(base);
    assert.equal(spawnSync('tar', ['-xz', '-C', base], { input: readPrepublicFixture(BASE_ARCHIVE) }).status, 0);
    const { Store: OldStore } = await import(pathToFileURL(path.join(base, 'src/store.mjs')));
    await midMigrationFailure(baseName, path.join(home, 'base.db'), async file => {
      const old = new OldStore(file);
      old.submit(payload, { mode: 'none' }, null, 'owner');
      return { db: old.db, claim: old.claim(payload.request_id, 'dot', 'subject', 6) };
    });
  }
} finally { fs.rmSync(home, { recursive: true, force: true }); }
