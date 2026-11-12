#!/usr/bin/env node
// Decision loop: the decide vocabulary and its mapping onto the accept/reject events, latest-wins history, the inbox
// 'undecided' group, the stale sweep.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, decisionTypes } from '../src/store.mjs';
import { dropEmptyPost54FixtureState } from '../src/test-support/pre-worker-fixture.mjs';
import { retainLifecycle } from '../src/lifecycle.mjs';
import { buildInbox, formatInbox, inboxItem } from '../src/inbox.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-'));
const file = path.join(base, 'bridge.db'), t0 = Date.parse('2026-10-01T00:00:00.000Z');
let clock = t0;
const store = new Store(file, { now: () => clock });
const db = store.db;
const rid = n => `req_${n}_aaaaaaaa`;
function add(n, { kind = 'review', finishedAt = new Date(t0).toISOString() } = {}) {
  db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at,source,task_kind) VALUES(?,'{}','h','','','finished',?,'agent',?)").run(rid(n), finishedAt, kind);
  db.prepare("INSERT INTO reports(request_id,claim_id,outcome,summary,result,receipt_id,created_at) VALUES(?,?,'completed','s','r',?,?)").run(rid(n), `claim_${n}`, `report_00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, finishedAt);
  db.prepare('INSERT INTO claims(request_id,claimant,claim_id,claimed_at) VALUES(?,?,?,?)').run(rid(n), 'dot', `claim_${n}`, finishedAt);
}
const events = (n, type) => db.prepare('SELECT reason FROM lifecycle_events WHERE request_id=? AND type=? ORDER BY id').all(rid(n), type).map(e => e.reason);
const rowsOf = n => db.prepare('SELECT decision,actor,via FROM decisions WHERE request_id=? ORDER BY id').all(rid(n)).map(r => ({ ...r }));

assert.equal(db.prepare('PRAGMA user_version').get().user_version,66);
assert.deepEqual(decisionTypes, ['accepted', 'applied', 'useful_no_change', 'useful_negative', 'not_useful', 'stale']);
for (let n = 1; n <= 12; n++) add(n, { kind: n <= 6 ? 'review' : 'build' });

// ---- vocabulary and mapping
store.decide(rid(1), 'accepted', { note: 'good' });
assert.deepEqual(events(1, 'accepted'), ['good']); assert.equal(events(1, 'consumed').length, 1, 'a decision is also the owner read');
store.decide(rid(2), 'applied');
assert.deepEqual(events(2, 'accepted'), ['applied'], 'applied writes the accepted event with an applied marker');
store.decide(rid(3), 'not_useful', { note: 'wrong repo' });
assert.ok(events(3, 'consumed').includes('rejected: wrong repo'), 'not_useful writes the legacy reject event');
store.decide(rid(4), 'useful_no_change'); store.decide(rid(5), 'useful_negative', { note: 'confirms the design' });
for (const n of [4, 5]) { assert.deepEqual(events(n, 'accepted'), []); assert.ok(!events(n, 'consumed').some(r => /^rejected/.test(r ?? ''))); }
assert.throws(() => store.decide(rid(1), 'maybe'), /decision must be one of/);
assert.throws(() => store.decide('req_missing_aaaa', 'accepted'), /not found/);
assert.deepEqual(store.latestDecision(rid(5)).decision, 'useful_negative');

// ---- accept and reject stay aliases
assert.equal(store.verdict(rid(6), true, 'ok').verdict, 'accepted'); assert.deepEqual(rowsOf(6), [{ decision: 'accepted', actor: 'owner', via: 'cli' }]);
assert.equal(store.verdict(rid(7), false, null).verdict, 'rejected'); assert.equal(store.latestDecision(rid(7)).decision, 'not_useful'); assert.deepEqual(events(7, 'consumed').filter(r => r === 'rejected'), ['rejected']);

// ---- append-only: a different decision is added and wins; the same one again is a no-op
store.decide(rid(8), 'useful_no_change'); const dup = store.decide(rid(8), 'useful_no_change'); assert.equal(dup.duplicate, true);
store.decide(rid(8), 'applied');
assert.deepEqual(rowsOf(8).map(r => r.decision), ['useful_no_change', 'applied']); assert.equal(store.latestDecision(rid(8)).decision, 'applied');
assert.throws(() => db.prepare("UPDATE decisions SET decision='accepted'").run(), /append-only/); assert.throws(() => db.prepare('DELETE FROM decisions').run(), /append-only/);
// a legacy event with no decisions row still reads as a decision
db.prepare("INSERT INTO lifecycle_events(request_id,type,at,actor,source,reason) VALUES(?,'accepted','2026-10-01T00:00:00.000Z','owner','live',NULL)").run(rid(9));
assert.equal(store.latestDecision(rid(9)).decision, 'accepted');
// only a finished result can be decided
db.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at) VALUES('req_queued_aaaa','{}','h','','','queued',?)").run(new Date(t0).toISOString());
assert.throws(() => store.decide('req_queued_aaaa', 'accepted'), /only a finished/);

// ---- inbox: read but undecided is asked for; decided and unread are not
const state = n => ({ request_id: rid(n), status: 'finished', inbox: store.ownerInbox(rid(n)) });
db.prepare("INSERT INTO lifecycle_events(request_id,type,at,actor,source,reason) VALUES(?,'consumed','2026-10-01T00:00:00.000Z','owner','live','get')").run(rid(10));
const item10 = inboxItem(state(10));
assert.equal(item10.group, 'undecided'); assert.deepEqual(item10.next, [`dalan decide ${rid(10)} accepted|applied|useful_no_change|useful_negative|not_useful`]);
assert.equal(inboxItem(state(11)).group, 'finished_unread', 'an unread result is still finished_unread');
assert.equal(inboxItem(state(1)), null, 'a decided result is not listed');
db.prepare("INSERT INTO notifications(id,request_id,kind,state,created_at) VALUES('n12',?,'t3','delivered',?)").run(rid(12), new Date(t0).toISOString());
assert.equal(inboxItem(state(12)).group, 'undecided', 'delivered to T3 and unread by the owner still needs a decision');
assert.equal(inboxItem({ ...state(10), inbox: { ...state(10).inbox, decision: undefined } }), null, 'an older bridge without the field is not asked');
const box = buildInbox([state(10), state(11), state(12), state(1)], 'all');
assert.deepEqual(box.counts, { finished_unread: 1, question: 0, undecided: 2, cancelled_unread: 0 });
assert.match(formatInbox(box), /undecided  req_10_aaaaaaaa.*dalan decide req_10_aaaaaaaa accepted\|applied/);
assert.ok(formatInbox(box).indexOf('finished_unread') < formatInbox(box).indexOf('undecided'));

// ---- stale sweep: only old, undecided results; owner decisions override; system actor; no read recorded
clock = t0 + 10 * 86400000;
add(20, { finishedAt: new Date(t0 + 5 * 86400000).toISOString() });  // 5 days old at the sweep: kept
add(21, { finishedAt: new Date(t0 + 1 * 86400000).toISOString() });  // 9 days old: stale
add(22, { finishedAt: new Date(t0 + 2 * 86400000).toISOString() });  // 8 days old, but decided
store.decide(rid(22), 'useful_no_change');
const swept = store.sweepStaleDecisions(7, { now: clock });
assert.ok(swept.includes(rid(21)) && !swept.includes(rid(20)) && !swept.includes(rid(22)));
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.ok(!swept.includes(rid(n)), `decided request ${n} is never swept`);
assert.deepEqual(rowsOf(21), [{ decision: 'stale', actor: 'system', via: 'sweep' }]);
assert.deepEqual(events(21, 'consumed'), [], 'the sweep does not mark a result read');
assert.deepEqual(store.sweepStaleDecisions(7, { now: clock }), [], 'a second sweep finds nothing');
assert.equal(inboxItem(state(21)).group, 'finished_unread', 'stale is not a read, and not undecided');
assert.equal(store.decide(rid(21), 'stale', { actor: 'owner' }).duplicate, true); // only the sweep writes stale
assert.equal(rowsOf(21).length, 1);
store.decide(rid(21), 'applied'); assert.equal(store.latestDecision(rid(21)).decision, 'applied', 'an owner decision after stale wins');
assert.deepEqual(rowsOf(21).map(r => r.decision), ['stale', 'applied']);
add(23, { finishedAt: new Date(t0 + 1 * 86400000).toISOString() }); store.sweepStaleDecisions(7, { now: clock });

db.close();
// ---- migration preserves the legacy read projection durably, not new authority
const migrationNow = Date.parse('2027-02-01T00:00:00.000Z');
const legacyAt = '2026-10-02T00:20:00.000Z', laterIdAt = '2026-10-02T00:10:00.000Z';
function migrationFixture(name, version, { explicit = false, fail = false } = {}) {
  const file = path.join(base, name + '.db'), s = new Store(file), d = s.db;
  dropEmptyPost54FixtureState(d);
  for (const id of ['history', 'prefix', 'unknown', 'explicit']) {
    d.prepare("INSERT INTO assignments(request_id,payload,payload_hash,thread_id,environment_id,status,created_at) VALUES(?,'{}','h','','','finished',?)").run(id, legacyAt);
  }
  const event = d.prepare('INSERT INTO lifecycle_events(request_id,type,at,actor,source,reason) VALUES(?,?,?,?,?,?)');
  event.run('history', 'accepted', legacyAt, 'owner', 'live', 'applied');
  event.run('history', 'consumed', laterIdAt, 'system', 'backfill', 'REJECTEDodd');
  event.run('prefix', 'consumed', legacyAt, 'someone', 'live', 'rejected: kept verbatim');
  event.run('unknown', 'consumed', legacyAt, 'owner', 'live', 'decide');
  event.run('unknown', 'integrated', legacyAt, 'fix-loop', 'live', 'merged');
  event.run('unknown', 'completed', legacyAt, 'system', 'backfill', 'completed');
  event.run('explicit', 'accepted', legacyAt, 'owner', 'live', 'shadow');
  if (explicit) {
    d.prepare("INSERT INTO decisions(request_id,decision,note,actor,via,at) VALUES('explicit','useful_negative','keep','owner','cli',?)").run(laterIdAt);
  } else {
    d.exec('DROP TABLE decisions');
  }
  if (fail) d.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON decisions WHEN NEW.request_id='prefix' BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END;");
  d.exec('PRAGMA user_version=' + version);
  d.close();
  return file;
}
const projectionRows = d => d.prepare('SELECT request_id,decision,note,actor,via,at FROM decisions ORDER BY id').all().map(r => ({...r}));
const expectedHistory = [
  {request_id:'history', decision:'accepted', note:'applied', actor:'owner', via:'legacy-projection', at:legacyAt},
  {request_id:'history', decision:'not_useful', note:'REJECTEDodd', actor:'owner', via:'legacy-projection', at:laterIdAt},
  {request_id:'prefix', decision:'not_useful', note:'rejected: kept verbatim', actor:'owner', via:'legacy-projection', at:legacyAt},
  {request_id:'explicit', decision:'accepted', note:'shadow', actor:'owner', via:'legacy-projection', at:legacyAt},
];
for (const version of [42, 43]) {
  const file = migrationFixture('legacy-' + version, version);
  const seed = new DatabaseSync(file);
  seed.prepare("INSERT INTO lifecycle_events(request_id,type,at,actor,source,reason) VALUES('orphan','accepted',?,'owner','live',NULL)").run(legacyAt);
  const orphanBefore = {...seed.prepare("SELECT * FROM lifecycle_events WHERE request_id='orphan'").get()};
  seed.close();
  let s = new Store(file, {now: () => migrationNow});
  assert.deepEqual({...s.db.prepare("SELECT * FROM lifecycle_events WHERE request_id='orphan'").get()}, orphanBefore, 'upgrade preserves orphan history untouched');
  assert.equal(s.db.prepare("SELECT count(*) n FROM assignments WHERE request_id='orphan'").get().n, 0, 'no assignment is fabricated');
  assert.equal(s.db.prepare("SELECT count(*) n FROM decisions WHERE request_id='orphan'").get().n, 0, 'no orphan decision is persisted');
  assert.equal(s.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(s.latestDecision('orphan').decision, 'accepted', 'read-only legacy projection remains unchanged');
  assert.deepEqual(projectionRows(s.db), expectedHistory, 'upgrade must persist the existing legacy projection');
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,66);
  assert.equal(s.latestDecision('history').decision, 'not_useful', 'source ID order, not timestamp order, determines latest');
  assert.equal(s.latestDecision('unknown'), null, 'read/completion/integration do not imply a decision');
  assert.equal(s.ownerInbox('history').decision, 'not_useful');
  assert.throws(() => s.db.exec("UPDATE decisions SET note='changed'"), /append-only/);
  assert.throws(() => s.db.exec('DELETE FROM decisions'), /append-only/);
  const before = projectionRows(s.db);
  s.db.close();
  s = new Store(file, {now: () => migrationNow});
  assert.deepEqual(projectionRows(s.db), before, 'reopen does not duplicate');
  assert.ok(retainLifecycle(s).rolled_up > 0, 'real guarded retention removes old synthetic source rows');
  assert.equal(s.db.prepare('SELECT count(*) n FROM lifecycle_events').get().n, 0);
  assert.deepEqual(projectionRows(s.db), before, 'decisions survive source retention');
  assert.equal(s.latestDecision('history').at, laterIdAt);
  s.db.close();
  s = new Store(file, {now: () => migrationNow});
  assert.deepEqual(projectionRows(s.db), before);
  s.db.close();
}
const explicitFile = migrationFixture('explicit', 43, {explicit:true});
let migrated = new Store(explicitFile, {now: () => migrationNow});
assert.deepEqual(projectionRows(migrated.db), [
  {request_id:'explicit', decision:'useful_negative', note:'keep', actor:'owner', via:'cli', at:laterIdAt},
  ...expectedHistory.filter(r => r.request_id !== 'explicit'),
], 'all existing explicit history takes precedence over legacy shadow events');
assert.equal(migrated.latestDecision('explicit').decision, 'useful_negative');
const once = projectionRows(migrated.db);
dropEmptyPost54FixtureState(migrated.db);
migrated.db.exec('PRAGMA user_version=43'); migrated.db.close();
migrated = new Store(explicitFile, {now: () => migrationNow});
assert.deepEqual(projectionRows(migrated.db), once, 'replaying migration does not append duplicate projections');
migrated.db.close();
const rollbackFile = migrationFixture('rollback', 43, {explicit:true, fail:true});
assert.throws(() => new Store(rollbackFile), /synthetic projection failure/);
{
  const d = new DatabaseSync(rollbackFile);
  assert.equal(d.prepare('PRAGMA user_version').get().user_version, 43);
  assert.equal(d.prepare('SELECT count(*) n FROM decisions').get().n, 1, 'earlier projected rows rolled back');
  d.exec('DROP TRIGGER fail_projection'); d.close();
}
migrated = new Store(rollbackFile, {now: () => migrationNow});
assert.equal(projectionRows(migrated.db).length, 4, 'retry imports each source row once');
migrated.db.close();
fs.rmSync(base, { recursive: true, force: true });
console.log('decision-test ok');
