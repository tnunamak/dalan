#!/usr/bin/env node
// C4: typed control events on a real Store file. Every case reads the rows back from SQLite.
//   1. A held wake writes `wake_held` (reason parent_stopped) in the same transaction as the hold, once per hold,
//      and the held wake shows in the owner inbox until the parent runs again.
//   2. cancel and abandon write `withdraw_work` / `detach` with the scope they controlled, and say what they did not control.
//   3. A denied stop (F23) records the requested scope and an unknown outcome, never success.
//   4. A database from before this step keeps its events and accepts the new types after the migration.
//   5. The migration refuses unknown columns, keeps the AUTOINCREMENT high-water mark, and rebuilds a partial CHECK list.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { controlTypes, lifecycleTypes, controlScopeText } from '../src/lifecycle.mjs';
import { buildInbox, formatInbox, inboxGroups } from '../src/inbox.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dalan-c4-'));
const pass = message => console.log(`PASS ${message}`);
const payload = (id, extra = {}) => ({ schema_version: 1, request_id: id, brief: `typed control ${id}`, inputs: [], expected_output: 'one result', execution_scope: 'read-only', ...extra });
const events = (s, id, ...types) => s.db.prepare(`SELECT type,at,actor,reason,scope,outcome,claim_id,epoch FROM lifecycle_events WHERE request_id=? ${types.length ? `AND type IN (${types.map(() => '?').join(',')})` : ''} ORDER BY id`).all(id, ...types).map(e => ({ ...e }));
const t3Job = (s, id) => {
  s.db.prepare('INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,delivery) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, JSON.stringify(payload(id)), 'hash', 'thread-c4', 'env-c4', 'claimed', new Date().toISOString(), 't3:thread-c4');
};
const notice = (s, id, kind, request, state = 'sending') => s.db.prepare("INSERT INTO notifications(id,kind,request_id,created_at,state) VALUES(?,?,?,?,?)").run(id, kind, request, new Date().toISOString(), state);

try {
  // ---- vocabulary
  assert.deepEqual(controlTypes, ['detach', 'interrupt_foreground', 'withdraw_work', 'revoke_grant']);
  for (const type of [...controlTypes, 'wake_held']) assert.ok(lifecycleTypes.includes(type), `${type} is a lifecycle type`);
  pass('the control vocabulary and wake_held are lifecycle types');

  // ---- 1. held wake: event in the hold transaction, once per hold, shown in the inbox
  {
    const s = new Store(join(dir, 'hold.db'));
    t3Job(s, 'req_hold');
    notice(s, 'evt_hold', 't3', 'req_hold');
    s.holdDelivery('evt_hold', 'thread held: latest run interrupted');
    const held = events(s, 'req_hold', 'wake_held');
    assert.equal(held.length, 1, 'the hold wrote one wake_held event');
    assert.deepEqual([held[0].reason, held[0].scope, held[0].outcome], ['parent_stopped', 'wake:evt_hold', 'unknown'], 'typed reason, the wake as scope, and the wake not delivered');
    assert.deepEqual({ ...s.db.prepare("SELECT kind,state,held_kind FROM notifications WHERE id='evt_hold'").get() }, { kind: 'wait', state: 'pending', held_kind: 't3' });

    s.holdDelivery('evt_hold', 'thread held: latest run interrupted');
    assert.equal(events(s, 'req_hold', 'wake_held').length, 1, 'a second hold of a row that is already held writes nothing');

    const inbox = s.ownerInbox('req_hold');
    assert.deepEqual({ ...inbox.held_wake }, { kind: 't3', reason: 'parent_stopped', detail: 'thread held: latest run interrupted', since: held[0].at, notification_id: 'evt_hold' });
    const rows = [{ request_id: 'req_hold', status: 'claimed', inbox }];
    const built = buildInbox(rows, 'all');
    assert.ok(inboxGroups.includes('held_wake'));
    assert.equal(built.counts.held_wake, 1);
    const line = formatInbox(built).split('\n').find(l => l.includes('req_hold'));
    assert.match(line, /^held_wake {2}req_hold/);
    assert.match(line, /wake held: parent_stopped/);
    assert.match(line, /thread held: latest run interrupted/);

    assert.equal(s.releaseHeld('evt_hold'), true);
    assert.equal(s.ownerInbox('req_hold').held_wake, null, 'a released wake is no longer shown as held');
    pass('a held wake writes wake_held: parent_stopped once and shows in the inbox until released');

    // The event is part of the hold transaction: a failure between the writes leaves neither.
    t3Job(s, 'req_atomic');
    notice(s, 'evt_atomic', 't3', 'req_atomic');
    const quiet = s.quietDelivery.bind(s);
    s.quietDelivery = () => { throw new Error('crash inside the hold'); };
    assert.throws(() => s.holdDelivery('evt_atomic', 'thread held: x'), /crash inside/);
    s.quietDelivery = quiet;
    assert.equal(events(s, 'req_atomic', 'wake_held').length, 0, 'no wake_held event without the hold');
    assert.equal(s.db.prepare("SELECT held_kind FROM notifications WHERE id='evt_atomic'").get().held_kind, null);
    s.holdDelivery('evt_atomic', 'thread held: x');
    assert.equal(events(s, 'req_atomic', 'wake_held').length, 1);
    pass('wake_held lands in the same transaction as the hold');

    // A finished result that is held is one inbox line, with the hold shown on it, not two lines.
    t3Job(s, 'req_two');
    notice(s, 'evt_two', 'blocker', 'req_two');
    s.holdDelivery('evt_two', 'thread held: latest run interrupted');
    const two = s.ownerInbox('req_two');
    const withQuestion = { request_id: 'req_two', status: 'claimed', inbox: { ...two, unanswered_blocker: { text: 'QUESTION: which branch?', at: new Date().toISOString() } } };
    const merged = buildInbox([withQuestion], 'all');
    assert.equal(merged.total, 1, 'one line per request');
    assert.equal(merged.items[0].group, 'question');
    assert.equal(merged.items[0].wake_held.reason, 'parent_stopped');
    assert.match(formatInbox(merged), /wake held: parent_stopped/);
    s.db.close();
    pass('a held wake on a request that is already in the inbox marks that line');
  }

  // ---- 2. cancel and abandon: typed event with scope, and text that says what was and was not controlled
  {
    let now = Date.parse('2026-11-15T00:00:00.000Z');
    const s = new Store(join(dir, 'withdraw.db'), { now: () => now, random: () => 0.5 });
    s.submit(payload('req_cancel_claimed'), { mode: 'none' }, null, 'owner');
    const claim = s.claim('req_cancel_claimed', 'dot', 'subject_a', 6, null, 'dot', 'run-a');
    const cancelled = s.cancel('req_cancel_claimed', 'no longer needed');
    assert.equal(cancelled.compute_stopped, false);
    const [withdraw] = events(s, 'req_cancel_claimed', 'withdraw_work');
    assert.deepEqual([withdraw.scope, withdraw.outcome, withdraw.actor, withdraw.reason], ['job:req_cancel_claimed', 'done', 'owner', 'no longer needed']);
    assert.equal(withdraw.claim_id, claim.claim_id, 'the withdrawal names the claim that was in force');
    const text = controlScopeText('withdraw_work', { ref: 'job:req_cancel_claimed', claimed: true });
    assert.match(text.controlled, /authority/);
    assert.match(text.not_controlled, /worker compute.*may still run/i);
    assert.equal(text.ref, 'job:req_cancel_claimed');
    const queuedText = controlScopeText('withdraw_work', { ref: 'job:q', claimed: false });
    assert.match(queuedText.not_controlled, /nothing was running/i);

    s.submit(payload('req_cancel_queued'), { mode: 'none' }, null, 'owner');
    s.cancelIfQueued('req_cancel_queued');
    assert.deepEqual(events(s, 'req_cancel_queued', 'withdraw_work').map(e => [e.scope, e.outcome]), [['job:req_cancel_queued', 'done']]);

    s.submit(payload('req_abandon'), { mode: 'none' }, null, 'owner');
    const claimed = s.claim('req_abandon', 'dot', 'subject_a', 6, null, 'dot', 'run-b');
    s.abandon('req_abandon', { actor: 'operator', reason: 'stuck' });
    const [detach] = events(s, 'req_abandon', 'detach');
    assert.deepEqual([detach.scope, detach.outcome, detach.actor, detach.reason], [`claim:${claimed.claim_id}@1`, 'done', 'operator', 'stuck']);
    assert.match(controlScopeText('detach', { ref: detach.scope }).not_controlled, /worker.*session.*not stopped/i);
    assert.deepEqual(events(s, 'req_abandon').map(e => e.type), ['queued', 'claimed', 'detach', 'abandoned', 'queued'], 'the typed request comes first, then the existing abandoned and queued events, which stay last');
    s.db.close();
    pass('cancel writes withdraw_work and abandon writes detach, each with the scope it controlled');
  }

  // ---- 3. F23: a denied stop records what was asked and an unknown outcome
  {
    const s = new Store(join(dir, 'stop.db'));
    s.submit(payload('req_stop'), { mode: 'none' }, null, 'owner');
    const scope = 'thread:env-c4/thread-c4#run:3';
    s.recordControl('req_stop', 'interrupt_foreground', { scope, denied: 'stop denied: permission_denied' });
    const [denied] = events(s, 'req_stop', 'interrupt_foreground');
    assert.deepEqual([denied.scope, denied.outcome], [scope, 'unknown'], 'requested scope kept, outcome unknown');
    assert.match(denied.reason, /stop denied: permission_denied/);
    assert.notEqual(denied.outcome, 'done');
    assert.notEqual(denied.outcome, 'confirmed');

    // A stop that was not denied and had no observation is also only a request. Only an observation confirms.
    s.recordControl('req_stop', 'interrupt_foreground', { scope });
    assert.equal(events(s, 'req_stop', 'interrupt_foreground')[1].outcome, 'unknown', 'a request without an observation is unknown');
    s.recordControl('req_stop', 'interrupt_foreground', { scope, confirmed: true });
    assert.equal(events(s, 'req_stop', 'interrupt_foreground')[2].outcome, 'confirmed');
    s.recordControl('req_stop', 'revoke_grant', { scope: 'grant:t3:thread-c4' });
    assert.equal(events(s, 'req_stop', 'revoke_grant')[0].outcome, 'unknown');

    assert.throws(() => s.recordControl('req_stop', 'interrupt_foreground', {}), /scope/, 'a control event with no scope is refused');
    assert.throws(() => s.recordControl('req_stop', 'interrupt_foreground', { scope: '   ' }), /scope/);
    assert.throws(() => s.recordControl('req_stop', 'claimed', { scope }), /control type/, 'only the control vocabulary goes through recordControl');
    assert.throws(() => s.recordControl('req_stop', 'interrupt_foreground', { scope, denied: 'x', confirmed: true }), /denied.*confirmed|confirmed.*denied/, 'a denial cannot also confirm');
    assert.equal(s.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id='req_stop' AND outcome='confirmed' AND reason LIKE '%denied%'").get().n, 0);
    s.db.close();
    pass('a denied stop records the requested scope and an unknown outcome, never success');
  }

  // Schema 72 rebuilt lifecycle_events with the control types; an older file must reopen from the version before that step.
  const beforeControlStep = 71;
  // ---- 4. migration: a database from before this step keeps its events and gains the new types
  {
    const path = join(dir, 'upgrade.db');
    const s = new Store(path);
    s.submit(payload('req_old'), { mode: 'none' }, null, 'owner');
    s.claim('req_old', 'dot', 'subject_a', 6, null, 'dot', 'run-c');
    const fresh = s.db.prepare("SELECT sql FROM sqlite_master WHERE name='lifecycle_events'").get().sql;
    const before = s.db.prepare('SELECT type,at,actor,source,reason,worker FROM lifecycle_events ORDER BY id').all().map(e => ({ ...e }));
    const schemaOf = db => Object.fromEntries(db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='lifecycle_events' ORDER BY name").all().map(r => [r.name, r.sql]));
    const freshSchema = schemaOf(s.db);
    const version = s.db.prepare('PRAGMA user_version').get().user_version;
    s.db.close();

    // Put the table back the way the previous release shaped it: the old type list, no scope or outcome columns.
    const raw = new DatabaseSync(path);
    const oldTypes = lifecycleTypes.filter(t => !controlTypes.includes(t) && t !== 'wake_held');
    raw.exec('DROP TABLE lifecycle_events');
    raw.exec(`CREATE TABLE lifecycle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, claim_id TEXT, epoch INTEGER, type TEXT NOT NULL CHECK(type IN (${oldTypes.map(t => `'${t}'`).join(',')})), at TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('live','backfill')), reason TEXT, worker TEXT NOT NULL DEFAULT 'unknown');
      CREATE INDEX lifecycle_events_request ON lifecycle_events(request_id,id);
      CREATE INDEX lifecycle_events_type_at ON lifecycle_events(type,at);
      CREATE TRIGGER lifecycle_events_no_update BEFORE UPDATE ON lifecycle_events BEGIN SELECT RAISE(ABORT,'lifecycle events are append-only'); END;
      CREATE TRIGGER lifecycle_events_no_delete BEFORE DELETE ON lifecycle_events WHEN NOT EXISTS (SELECT 1 FROM lifecycle_retention WHERE id=1 AND cutoff IS NOT NULL AND old.at<cutoff) BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only'); END;`);
    const insert = raw.prepare("INSERT INTO lifecycle_events(request_id,type,at,actor,source,reason,worker) VALUES('req_old',?,?,?,?,?,?)");
    for (const e of before) insert.run(e.type, e.at, e.actor, e.source, e.reason, e.worker);
    raw.exec(`PRAGMA user_version=${beforeControlStep}`);
    assert.throws(() => raw.exec("INSERT INTO lifecycle_events(request_id,type,at,actor,source) VALUES('x','wake_held','t','a','live')"), /CHECK constraint failed/, 'the old table rejects the new type');
    raw.close();

    const upgraded = new Store(path);
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, version);
    assert.deepEqual(upgraded.db.prepare('SELECT type,at,actor,source,reason,worker FROM lifecycle_events ORDER BY id').all().map(e => ({ ...e })), before, 'every event survives, in order');
    assert.deepEqual(schemaOf(upgraded.db), freshSchema, 'an upgraded table, its indexes and its triggers read exactly like a fresh one');
    assert.equal(freshSchema.lifecycle_events, fresh);
    upgraded.recordControl('req_old', 'withdraw_work', { scope: 'job:req_old' });
    assert.equal(events(upgraded, 'req_old', 'withdraw_work').length, 1);
    assert.throws(() => upgraded.db.exec("UPDATE lifecycle_events SET reason='x'"), /append-only/, 'the append-only triggers came back');
    assert.throws(() => upgraded.db.exec("DELETE FROM lifecycle_events"), /append-only/);
    const nextId = upgraded.db.prepare('SELECT max(id) m FROM lifecycle_events').get().m;
    assert.equal(nextId, before.length + 1, 'ids continue after the rebuilt rows');
    upgraded.db.close();
    pass('a database from before this step keeps its events, gets the new types, and matches a fresh schema');
  }
  // ---- 5. migration edge cases found in review: unknown columns, AUTOINCREMENT high-water mark, partial CHECK lists
  {
    // A database file as the previous release left it: a table with the given type list, plus whatever the caller adds.
    const oldShape = (name, { types, extraColumn = '', rows = 3 }) => {
      const path = join(dir, `${name}.db`);
      const s = new Store(path);
      const version = s.db.prepare('PRAGMA user_version').get().user_version;
      s.db.close();
      const raw = new DatabaseSync(path);
      raw.exec('DROP TABLE lifecycle_events');
      raw.exec(`CREATE TABLE lifecycle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, claim_id TEXT, epoch INTEGER, type TEXT NOT NULL CHECK(type IN (${types.map(t => `'${t}'`).join(',')})), at TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('live','backfill')), reason TEXT, worker TEXT NOT NULL DEFAULT 'unknown'${extraColumn});
        CREATE INDEX lifecycle_events_request ON lifecycle_events(request_id,id);
        CREATE INDEX lifecycle_events_type_at ON lifecycle_events(type,at);
        CREATE TRIGGER lifecycle_events_no_update BEFORE UPDATE ON lifecycle_events BEGIN SELECT RAISE(ABORT,'lifecycle events are append-only'); END;
        CREATE TRIGGER lifecycle_events_no_delete BEFORE DELETE ON lifecycle_events WHEN NOT EXISTS (SELECT 1 FROM lifecycle_retention WHERE id=1 AND cutoff IS NOT NULL AND old.at<cutoff) BEGIN SELECT RAISE(ABORT, 'lifecycle events are append-only'); END;`);
      for (let i = 0; i < rows; i++) raw.prepare("INSERT INTO lifecycle_events(request_id,type,at,actor,source) VALUES('req_edge','queued',?, 'owner','live')").run(`2026-01-0${i + 1}T00:00:00.000Z`);
      raw.exec(`PRAGMA user_version=${beforeControlStep}`);
      return { path, raw, version };
    };
    const noControl = lifecycleTypes.filter(t => !controlTypes.includes(t) && t !== 'wake_held');
    const snapshot = db => ({
      schema: db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all().map(r => ({ ...r })),
      rows: db.prepare('SELECT * FROM lifecycle_events ORDER BY id').all().map(r => ({ ...r })),
      seq: db.prepare("SELECT seq FROM sqlite_sequence WHERE name='lifecycle_events'").get()?.seq,
      version: db.prepare('PRAGMA user_version').get().user_version,
    });

    // (1) A column this release does not know is never dropped: the migration refuses, names it, and changes nothing.
    {
      const { path, raw } = oldShape('unknown-col', { types: noControl, extraColumn: ', audit_tag TEXT' });
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.exec('DROP TRIGGER lifecycle_events_no_update');
      raw.exec("UPDATE lifecycle_events SET audit_tag='keep-me'");
      raw.exec("CREATE TRIGGER lifecycle_events_no_update BEFORE UPDATE ON lifecycle_events BEGIN SELECT RAISE(ABORT,'lifecycle events are append-only'); END");
      const before = snapshot(raw);
      raw.close();
      assert.throws(() => new Store(path), /audit_tag/, 'the refusal names the unexpected column');
      const after = new DatabaseSync(path);
      assert.deepEqual(snapshot(after), before, 'nothing changed: schema, rows (audit_tag included), sequence and version');
      assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name='lifecycle_events_pre71'").get(), undefined, 'no half-renamed table is left');
      after.close();
      pass('migration refuses unknown columns without changing data');
    }

    // (2) Ids are never reused: the new table's sequence is the larger of the old high-water mark and the copied max id.
    {
      const { path, raw } = oldShape('sequence', { types: noControl });
      raw.exec("UPDATE sqlite_sequence SET seq=100 WHERE name='lifecycle_events'"); // ids 4..100 were retained away
      raw.close();
      const s = new Store(path);
      s.submit(payload('req_seq'), { mode: 'none' }, null, 'owner');
      const ids = s.db.prepare('SELECT id FROM lifecycle_events ORDER BY id').all().map(r => r.id);
      assert.deepEqual(ids.slice(0, 3), [1, 2, 3], 'old rows keep their ids');
      assert.ok(ids.slice(3).every(id => id > 100), `new events continue past the old high-water mark, got ${ids}`);
      s.db.close();
      pass('migration preserves AUTOINCREMENT after the high ids were retained away');
    }

    // (3) A CHECK that lists wake_held but lacks another current type is still rebuilt.
    {
      const { path, raw } = oldShape('partial', { types: [...noControl, 'wake_held'] });
      assert.throws(() => raw.exec("INSERT INTO lifecycle_events(request_id,type,at,actor,source) VALUES('x','revoke_grant','t','a','live')"), /CHECK constraint failed/);
      raw.close();
      const s = new Store(path);
      const insert = s.db.prepare("INSERT INTO lifecycle_events(request_id,type,at,actor,source) VALUES('req_edge',?,'2026-02-01T00:00:00.000Z','owner','live')");
      for (const type of lifecycleTypes) insert.run(type);
      assert.equal(s.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE at='2026-02-01T00:00:00.000Z'").get().n, lifecycleTypes.length);
      s.db.close();
      pass('partial CHECK upgrades accept every lifecycleTypes member');
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
