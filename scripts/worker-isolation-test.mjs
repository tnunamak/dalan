#!/usr/bin/env node
// Worker isolation: two approved connections that share ONE token `sub` and differ only in `azp` must not see, claim,
// read, touch or hear about each other's work. Every check is independent and reports PASS/FAIL, so the same file can be run
// against code from before the change and show which assertions that code fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID, randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.mjs';
import { preWorkerFixture } from '../src/test-support/pre-worker-fixture.mjs';
import { skipCheck } from '../src/test-support/skipped-check.mjs';
import { prepublicSkip, readPrepublicFixture } from '../src/test-support/prepublic-fixtures.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = process.env.DOT_BRIDGE_ISOLATION_TMP??path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'dbi-'));
const BASE_COMMIT = '27a0a2d'; // the last commit before worker identity: the migration check builds its old database with this code
const failures = [];
const only = process.env.WI_ONLY ? new Set(process.env.WI_ONLY.split(',')) : null;
async function check(name, fn) {
  if (only && !only.has(name)) return;
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}: ${String(error.stack ?? error).split('\n').slice(0, 12).join(' | ')}`); }
}
// Pre-public release source archives live outside the repository (see prepublic-fixtures.mjs).
const historyArchive = revision => `src/test-support/worker-history/${revision}.tgz`;
const skipped = [];
async function historicalCheck(name, revisions, fn) {
  if (only && !only.has(name)) return;
  const skip = prepublicSkip(...revisions.map(historyArchive));
  if (!skip) return check(name, fn);
  skipped.push(name); skipCheck(name, skip);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const workersModule = () => import('../src/workers.mjs'); // absent before the change: checks that need it fail, the rest still run
const hours = n => n * 3600000;
const assignment = (id, brief = `isolation ${id}`) => ({ schema_version: 1, request_id: id, brief, inputs: [{ revision: 'abc' }], expected_output: 'one result', execution_scope: 'read-only' });
const rid = label => `req_${label}_${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------- Part 1: the Store, with an injected profile and clock
const ISS = 'https://idp.example/realm';
const profileJson = {
  workers: {
    dot: { connections: [{ issuer: ISS, subject: 'owner', client_id: 'client-dot' }], capabilities: ['t3'] },
    lark: { connections: [{ issuer: ISS, subject: 'owner', client_id: 'client-lark' }] },
    grok: { connections: [{ issuer: ISS, subject: 'owner', client_id: 'client-grok' }] }
  }
};
async function fixture(name) {
  const { parseWorkers } = await workersModule();
  let now = Date.parse('2026-10-22T00:00:00Z');
  const store = new Store(path.join(root, `${name}.db`), { now: () => now, capacity: 6, workers: parseWorkers(profileJson) });
  const future = new Date(now + hours(48)).toISOString();
  const subs = {};
  for (const worker of ['dot', 'lark', 'grok']) { subs[worker] = `sub_${worker}`; store.subscribe(subs[worker], `http://127.0.0.1/${worker}`, 'whsec_test', future, 'owner', worker, profileJson.workers[worker].connections[0]); }
  const owner = 'owner-token';
  const submit = (id, target) => store.submit(assignment(id), { mode: 'none' }, null, owner, false, null, 'normal', null, assignment(id), null, target);
  const events = (subscription, extra = '') => store.db.prepare(`SELECT request_id,message_id,wake_kind,state FROM notifications WHERE kind='event' AND subscription_id=? ${extra} ORDER BY rowid`).all(subscription);
  return { store, subs, submit, events, advance: ms => { now += ms; }, now: () => now };
}
const requestsFor = rows => rows.map(r => r.request_id).filter(Boolean).sort();

await check('submit wakes only subscriptions whose worker can see the target (worker, two named workers)', async () => {
  const { store, subs, submit, events } = await fixture('fanout');
  const a = rid('a'), b = rid('b'), p = rid('p');
  submit(a, 'dot'); submit(b, 'lark'); submit(p, 'grok');
  assert.deepEqual(requestsFor(events(subs.dot)), [a]);
  assert.deepEqual(requestsFor(events(subs.lark)), [b]);
  assert.deepEqual(requestsFor(events(subs.grok)), [p]);
  store.db.close();
});

await check('a subscription made later replays only what its worker can see', async () => {
  const { store, subs, submit, events } = await fixture('replay');
  const a = rid('a'), b = rid('b'), p = rid('p');
  submit(a, 'dot'); submit(b, 'lark'); submit(p, 'grok');
  store.unsubscribe(subs.lark); store.db.prepare("DELETE FROM notifications WHERE subscription_id=?").run(subs.lark);
  store.subscribe(subs.lark, 'http://127.0.0.1/lark', 'whsec_test', new Date(store.nowMs() + hours(48)).toISOString(), 'owner', 'lark', profileJson.workers.lark.connections[0]);
  assert.deepEqual(requestsFor(events(subs.lark)), [b], 'the replay named a job the worker may not see');
  store.db.close();
});

await check('owner notes, requeue after abandon and lightweight tell reach only visible subscriptions', async () => {
  const { store, subs, submit, events } = await fixture('notes');
  const a = rid('a');
  submit(a, 'dot');
  store.db.prepare('DELETE FROM notifications').run();
  store.note(a, 'a note for the worker only');
  assert.equal(events(subs.dot).length, 1); assert.equal(events(subs.lark).length, 0); assert.equal(events(subs.grok).length, 0);
  const claim = store.claim(a, 'c1', 'owner', 6, null, 'dot');
  store.db.prepare("UPDATE notifications SET state='delivered'").run();
  store.abandon(a, { actor: 'operator' });
  assert.equal(events(subs.lark).length, 0, 'abandon requeue woke another worker');
  assert.ok(events(subs.dot, "AND wake_kind='submit'").length >= 1 && claim.claim_id);
  const tellLark = store.tell('hello lark', 'lark'), tellDot = store.tell('hello worker');
  assert.deepEqual(events(subs.lark).filter(e => e.message_id).map(e => e.message_id), [tellLark.message_id]);
  assert.deepEqual(events(subs.dot).filter(e => e.message_id).map(e => e.message_id), [tellDot.message_id]);
  store.db.close();
});

await check('re-wake names only work the subscription worker can see', async () => {
  const { store, subs, submit, events, advance } = await fixture('rewake');
  const a = rid('a'), b = rid('b'), p = rid('p');
  submit(a, 'dot'); submit(b, 'lark'); submit(p, 'grok');
  store.db.prepare("UPDATE notifications SET state='delivered'").run();
  advance(hours(1));
  store.reannounceQueued({ ...store.limits, rewakeMs: 60000 });
  assert.deepEqual(requestsFor(events(subs.dot, "AND wake_kind='rewake'")), [a]);
  assert.deepEqual(requestsFor(events(subs.lark, "AND wake_kind='rewake'")), [b]);
  assert.deepEqual(requestsFor(events(subs.grok, "AND wake_kind='rewake'")), [p]);
  for (const worker of ['dot', 'lark', 'grok']) for (const row of store.rewakeCandidates(subs[worker])) assert.ok(store.mayAct(worker, row.request_id), `${worker} offered ${row.request_id}`);
  store.db.close();
});

await check('a retry or replay row for a target the subscription cannot see is suppressed before sending', async () => {
  const { store, subs, submit } = await fixture('retry');
  const a = rid('a');
  submit(a, 'dot');
  store.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,body,created_at,wake_kind) VALUES('evt_stray','event',?,?,'{}',?,'submit')").run(a, subs.lark, store.stamp());
  assert.equal(store.startAttempt('evt_stray', null), null);
  assert.equal(store.db.prepare("SELECT state FROM notifications WHERE id='evt_stray'").get().state, 'suppressed');
  store.db.close();
});

await check('claims record the worker; lanes and capacity are keyed by worker even for one shared subject', async () => {
  const { store, submit } = await fixture('lanes');
  const a1 = rid('a1'), a2 = rid('a2'), b1 = rid('b1'), p = rid('p');
  submit(a1, 'dot'); submit(a2, 'dot'); submit(b1, 'lark'); submit(p, 'grok');
  const first = store.claim(a1, 'dot', 'owner', 1, null, 'dot');
  assert.throws(() => store.claim(a2, 'dot', 'owner', 1, null, 'dot'), /^Error: capacity_full$/);
  assert.equal(store.claim(b1, 'lark', 'owner', 1, null, 'lark').duplicate, false, 'the other worker shares no capacity');
  assert.equal(store.activeClaims('owner','dot').length, 1); assert.equal(store.activeClaims('owner','lark').length, 1);
  assert.equal(store.db.prepare('SELECT worker FROM claims WHERE request_id=?').get(a1).worker, 'dot');
  assert.equal(store.laneState('owner','lark',6,1).free_lanes, 0);
  assert.equal(store.laneState('owner','grok',6,1).free_lanes, 1);
  // same claim_id, same subject, different worker: no progress, no finish, no lease touch
  assert.throws(() => store.progress(a1, first.claim_id, 'x', 'owner', false, 'lark'), /^Error: invalid claim$/);
  assert.throws(() => store.finish(a1, first.claim_id, 'completed', 's', 'r', 'owner', null, 'lark'), /^Error: invalid claim$/);
  const before = store.db.prepare('SELECT last_claim_activity_at t FROM claims WHERE request_id=?').get(a1).t;
  store.touchClaim(a1, first.claim_id, 'owner', 'lark');
  assert.equal(store.db.prepare('SELECT last_claim_activity_at t FROM claims WHERE request_id=?').get(a1).t, before);
  const third = store.claim(p, 'g1', 'owner', 6, null, 'grok', 'grok-run');
  assert.equal(store.claim(p, 'g1', 'owner', 6, null, 'grok', 'grok-run').claim_id, third.claim_id, 'retry by the same acquisition is the same claim');
  store.finish(p, third.claim_id, 'completed', 's', 'r', 'owner', null, 'grok');
  assert.equal(store.db.prepare('SELECT worker FROM reports WHERE request_id=?').get(p).worker, 'grok');
  store.db.close();
});

await check('default idle resume distinguishes acquisitions, preserves busy state, and waits for lease expiry after 120 seconds idle', async () => {
  assert.equal(process.env.DOT_BRIDGE_RESUME_IDLE_MS, undefined, 'default idle coverage requires the environment override to be unset');

  const active = await fixture('default-resume-active');
  try {
    const id=rid('active-acquisition');active.submit(id,'dot');
    const first=active.store.claim(id,'dot','owner',6,null,'dot','active-run-a');
    active.store.note(id,'first note');
    const duplicate=active.store.claim(id,'dot','owner',6,null,'dot','active-run-a');
    assert.equal(duplicate.claim_id,first.claim_id);assert.equal(duplicate.epoch,1);assert.equal(duplicate.duplicate,true);
    assert.equal(active.store.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(id).n,1,'same-acquisition retry wrote a second lifecycle event');
    active.store.note(id,'cursor must not move on a rejected retry');
    const before=active.store.db.prepare('SELECT claim_id,acquisition_id,epoch,last_claim_activity_at,last_seen_note_seq,tool_calls,last_tool_at FROM claims WHERE request_id=?').get(id);
    const eventsBefore=active.store.db.prepare('SELECT count(*) n FROM lifecycle_events WHERE request_id=?').get(id).n;
    assert.throws(()=>active.store.claim(id,'dot','owner',6,null,'dot'),/"error":"claim_busy"/,'missing acquisition ID reused an active claim');
    assert.throws(()=>active.store.claim(id,'dot','owner',6,null,'dot','active-run-b'),/"error":"claim_busy"/,'different acquisition ID reused an active claim');
    assert.deepEqual(active.store.db.prepare('SELECT claim_id,acquisition_id,epoch,last_claim_activity_at,last_seen_note_seq,tool_calls,last_tool_at FROM claims WHERE request_id=?').get(id),before,'rejected retries changed claim activity or note cursor');
    assert.equal(active.store.db.prepare('SELECT count(*) n FROM lifecycle_events WHERE request_id=?').get(id).n,eventsBefore,'rejected retries wrote a lifecycle event');
    assert.equal(active.store.activeClaims('owner','dot').length,1,'rejected retry changed active capacity');
    assert.equal(active.store.progress(id,first.claim_id,'known claim_id still works','owner',false,'dot').recorded,true,'known claim_id lost its authority');

    const noId=rid('first-without-acquisition');active.submit(noId,'dot');
    const original=active.store.claim(noId,'dot','owner',6,null,'dot');
    assert.ok(original.claim_id,'a first claim without an acquisition ID was refused');
    const retry=active.store.claim(noId,'dot','owner',6,null,'dot');
    assert.equal(retry.claim_id,original.claim_id); assert.equal(retry.duplicate,true);
    assert.equal(active.store.progress(noId,original.claim_id,'known claim_id still works','owner',false,'dot').recorded,true);
  } finally { active.store.db.close(); }

  const beforeBoundary=await fixture('default-resume-119999');
  try {
    const id=rid('idle-before-boundary');beforeBoundary.submit(id,'dot');
    const first=beforeBoundary.store.claim(id,'dot','owner',6,null,'dot','boundary-run');
    beforeBoundary.advance(119999);
    const retry=beforeBoundary.store.claim(id,'dot','owner',6,null,'dot','boundary-run');
    assert.equal(retry.claim_id,first.claim_id);assert.equal(retry.epoch,1);assert.equal(retry.duplicate,true,'119999ms rotated an active acquisition');
  } finally { beforeBoundary.store.db.close(); }

  const atBoundary=await fixture('default-resume-120000');
  try {
    const id=rid('idle-at-boundary');atBoundary.submit(id,'dot');
    const first=atBoundary.store.claim(id,'dot','owner',6,null,'dot','old-run');
    assert.equal(atBoundary.store.progress(id,first.claim_id,'progress survives resume','owner',false,'dot').recorded,true);
    atBoundary.advance(119999);atBoundary.store.get(id); // get does not refresh claim activity
    assert.equal(atBoundary.store.isIdleClaim(atBoundary.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id)),false);
    atBoundary.advance(1);
    const stamp=atBoundary.store.stamp();
    atBoundary.store.db.prepare("INSERT INTO check_jobs(id,request_id,claim_id,check_id,diff_sha256,status,started_at) VALUES(?,?,?,'default','', 'running',?)").run('running-check',id,first.claim_id,stamp);
    assert.equal(atBoundary.store.isIdleClaim(atBoundary.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id)),false,'running check did not block idle rotation');
    const before=atBoundary.store.db.prepare('SELECT claim_id,epoch,acquisition_id,last_claim_activity_at FROM claims WHERE request_id=?').get(id);
    assert.throws(()=>atBoundary.store.claim(id,'dot','owner',6,null,'dot','new-run'),/"error":"claim_busy"/,'running check allowed a claim rotation');
    assert.deepEqual(atBoundary.store.db.prepare('SELECT claim_id,epoch,acquisition_id,last_claim_activity_at FROM claims WHERE request_id=?').get(id),before,'busy running-check retry changed the old claim');
    assert.equal(atBoundary.store.activeClaims('owner','dot').length,1,'idle observation freed capacity before rotation');
    const deadline=Date.parse(before.last_claim_activity_at)+atBoundary.store.limits.leaseMs;
    assert.throws(()=>atBoundary.store.claim(id,'dot','owner',6,null,'dot','new-run'),/"error":"claim_busy"/,'idle claim rotated before its lease expired');
    assert.deepEqual(atBoundary.store.db.prepare('SELECT claim_id,epoch,acquisition_id,last_claim_activity_at FROM claims WHERE request_id=?').get(id),before,'early regrant changed the old grant');
    atBoundary.advance(deadline-atBoundary.now()+1);
    assert.throws(()=>atBoundary.store.claim(id,'dot','owner',6,null,'dot','new-run'),/claim_effects_unverified/,'expiry released a running check');
    atBoundary.store.db.prepare("UPDATE check_jobs SET status='interrupted' WHERE id='running-check'").run();
    assert.throws(()=>atBoundary.store.claim(id,'dot','owner',6,null,'dot','new-run'),/claim_effects_unverified/,'terminal status alone proved host cessation');
    // This Store unit fixture launched no process. Seed the trusted stop fact;
    // the real host-recovery tests separately exercise receipt verification.
    atBoundary.store.db.prepare("UPDATE check_jobs SET stop_verified=1 WHERE id='running-check'").run();
    const resumed=atBoundary.store.claim(id,'dot','owner',6,null,'dot','new-run');
    assert.equal(resumed.resumed,true);assert.equal(resumed.epoch,2);assert.notEqual(resumed.claim_id,first.claim_id);
    assert.equal(atBoundary.store.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(id).n,2,'resume must add one lifecycle event');
    assert.ok(atBoundary.store.get(id).progress.some(item=>item.note==='progress survives resume'),'resume lost prior progress');
    assert.throws(()=>atBoundary.store.progress(id,first.claim_id,'stale','owner',false,'dot'),/claim_superseded/,'old claim_id was not fenced after resume');
  } finally { atBoundary.store.db.close(); }

  for(const [label,acquisition] of [['keyed','same-run'],['unkeyed',undefined]]) for(const age of [119999,120000]) {
    const boundary=await fixture(`default-resume-${label}-${age}`);
    try {
      const id=rid(`idle-${label}-${age}`);boundary.submit(id,'dot');
      const first=boundary.store.claim(id,'dot','owner',6,null,'dot',acquisition);
      boundary.store.note(id,'owner note must be seen on retry');
      const noteSeq=boundary.store.db.prepare('SELECT max(sequence) n FROM owner_notes WHERE request_id=?').get(id).n;
      boundary.advance(age);
      const retried=boundary.store.claim(id,'dot','owner',6,null,'dot',acquisition);
      const persisted=boundary.store.db.prepare('SELECT claim_id,epoch,acquisition_id,last_claim_activity_at,last_seen_note_seq FROM claims WHERE request_id=?').get(id);
      assert.equal(retried.claim_id,first.claim_id,`${label} retry at ${age}ms changed the grant`);
      assert.equal(retried.epoch,first.epoch); assert.equal(retried.duplicate,true); assert.equal(retried.resumed,undefined);
      assert.equal(persisted.claim_id,first.claim_id); assert.equal(persisted.epoch,1);
      assert.equal(persisted.acquisition_id,acquisition??null);
      assert.equal(persisted.last_claim_activity_at,new Date(boundary.now()).toISOString(),'retry did not refresh claim activity');
      assert.equal(persisted.last_seen_note_seq,noteSeq,'retry did not advance the owner-note cursor');
      assert.equal(boundary.store.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE request_id=? AND type='claimed'").get(id).n,1,'same-input retry wrote another claimed lifecycle event');
      assert.equal(boundary.store.isIdleClaim(persisted),false,'successful retry left the claim idle');
    } finally { boundary.store.db.close(); }
  }
});

await check('listing, queue hints and messages show a worker only what it may see', async () => {
  const { store, submit } = await fixture('hints');
  const a = rid('a'), a2 = rid('a2'), b = rid('b'), p = rid('p');
  submit(a, 'dot'); submit(a2, 'dot'); submit(b, 'lark'); submit(p, 'grok');
  const ids = worker => store.listPending(worker).filter(x => x.kind === 'assignment').map(x => x.request_id).sort();
  assert.deepEqual(ids('dot'), [a, a2].sort()); assert.deepEqual(ids('lark'), [b]); assert.deepEqual(ids('grok'), [p]);
  assert.equal(store.laneState('owner','lark',6,6).queued, 1);
  assert.deepEqual((store.nextQueued(3, null, 'lark').next_queued ?? []).map(x => x.request_id), [b]);
  const claim = store.claim(a, 'dot', 'owner', 6, null, 'dot');
  assert.deepEqual((store.finish(a, claim.claim_id, 'completed', 's', 'r', 'owner', null, 'dot').next_queued ?? []).map(x => x.request_id), [a2], 'finish hint named another worker\'s job');
  const m = store.tell('only for lark', 'lark');
  assert.deepEqual(store.listPending('lark').filter(x => x.kind === 'message').map(x => x.message_id), [m.message_id]);
  assert.equal(store.listPending('dot').filter(x => x.kind === 'message').length, 0);
  assert.throws(() => store.getMessage(m.message_id, 'dot'), /^Error: message not found$/);
  assert.throws(() => store.ackMessage(m.message_id, 'dot'), /^Error: message not found$/);
  assert.equal(store.getMessage(m.message_id, 'lark').status, 'pending');
  store.db.close();
});

await check('the target is a column: payload and retry identity are unchanged, a retry naming another worker conflicts', async () => {
  const { store, submit } = await fixture('retry-id');
  const a = rid('a');
  submit(a, 'lark');
  assert.equal(submit(a, 'lark').duplicate, true);
  assert.equal(store.submit(assignment(a), { mode: 'none' }, null, 'owner-token').duplicate, true, 'a retry that names no worker asserts nothing');
  assert.throws(() => submit(a, 'dot'), /request_id conflict/);
  const row = store.db.prepare('SELECT payload,target_worker FROM assignments WHERE request_id=?').get(a);
  assert.equal(row.target_worker, 'lark'); assert.equal(row.payload, JSON.stringify(assignment(a)), 'payload must not carry the target');
  assert.equal(store.get(a).target_worker, 'lark');
  store.db.close();
});

await check('workers.json: absent means the legacy worker; malformed or unsafe input fails closed; resolution denies unknown and conflicting connections', async () => {
  const { loadWorkers, parseWorkers, resolveWorker, canSee, hasCapability, LEGACY_PROFILE } = await workersModule(), profile0 = () => parseWorkers(profileJson);
  assert.equal(loadWorkers(path.join(root, 'no-such-workers.json')), LEGACY_PROFILE);
  assert.equal(resolveWorker(LEGACY_PROFILE, { subject: 'anyone', client_id: 'anything' }), 'dot');
  assert.ok(hasCapability(LEGACY_PROFILE, 'dot', 't3')); assert.ok(canSee(LEGACY_PROFILE, 'dot', 'dot')); assert.ok(!canSee(LEGACY_PROFILE, 'dot', 'pool')); assert.ok(!canSee(profile0(), 'lark', 'pool'));
  const profile = parseWorkers(profileJson), principal = client_id => ({ issuer: ISS, subject: 'owner', client_id });
  assert.equal(resolveWorker(profile, principal('client-lark')), 'lark');
  assert.throws(() => resolveWorker(profile, principal('client-unknown')), /^Error: unknown_connection$/);
  assert.throws(() => resolveWorker(profile, principal(null)), /^Error: unknown_connection$/);
  assert.throws(() => resolveWorker(profile, { ...principal('client-lark'), issuer: 'https://other.example' }), /^Error: unknown_connection$/);
  assert.throws(() => resolveWorker(profile, { ...principal('client-lark'), subject: 'someone-else' }), /^Error: unknown_connection$/);
  const twice = parseWorkers({ workers: { one: { connections: [{ issuer: ISS, subject: 'owner', client_id: 'x' }] }, two: { connections: [{ issuer: ISS, subject: 'owner', client_id: 'x' }] } } });
  assert.throws(() => resolveWorker(twice, principal('x')), /^Error: conflicting_connection$/);
  const byGrant = parseWorkers({ workers: { cimd: { connections: [{ issuer: ISS, subject: 'owner', connection_id: 'conn-1' }] } } });
  assert.equal(resolveWorker(byGrant, { ...principal('shared-cimd-client'), connection_id: 'conn-1' }), 'cimd');
  assert.throws(() => resolveWorker(byGrant, { ...principal('shared-cimd-client'), connection_id: 'conn-2' }), /^Error: unknown_connection$/);
  assert.throws(() => resolveWorker(byGrant, principal('shared-cimd-client')), /^Error: unknown_connection$/);
  // A different allowed subject that presents the same connection_id is not the worker the operator named.
  assert.throws(() => resolveWorker(byGrant, { ...principal('shared-cimd-client'), subject: 'other-allowed', connection_id: 'conn-1' }), /^Error: unknown_connection$/);
  // Every external record must name its subject; connection_id and client_id are extra pins, never a replacement.
  assert.throws(() => parseWorkers({ workers: { cimd: { connections: [{ issuer: ISS, connection_id: 'conn-1' }] } } }), /subject/);
  assert.throws(() => parseWorkers({ workers: { cimd: { connections: [{ issuer: ISS, client_id: 'c', connection_id: 'conn-1' }] } } }), /subject/);
  assert.equal(resolveWorker(profile, { local: true, subject: 'local-principal' }), 'dot');
  assert.ok(!hasCapability(profile, 'lark', 't3') && hasCapability(profile, 'dot', 't3'));
  const mode = fs.mkdtempSync(path.join(root, 'mode-')), file = path.join(mode, 'workers.json');
  fs.writeFileSync(file, JSON.stringify(profileJson), { mode: 0o644 });
  fs.chmodSync(file, 0o644); // the umask may have narrowed the create mode
  assert.throws(() => loadWorkers(file), /mode 0600/);
  fs.chmodSync(file, 0o600); assert.equal(loadWorkers(file).workers.size, 3);
  for (const bad of ['{', '[]', '{"workers":{}}', '{"workers":{"pool":{"connections":[{"issuer":"i","subject":"s","client_id":"c"}]}}}', '{"workers":{"a":{"connections":[]}}}', '{"workers":{"a":{"connections":[{"issuer":"i","subject":"s"}]}}}',
    '{"workers":{"a":{"connections":[{"issuer":"i","subject":"s","client_id":"c","extra":1}]}}}', '{"workers":{"a":{"connections":[{"issuer":"i","subject":"s","client_id":"c"}],"capabilities":["root"]}}}', '{"workers":{"a":{"connections":[{"issuer":"i","subject":"s","client_id":"c"}],"pool":"yes"}}}', '{"workers":{"A b":{}}}', '{"workers":{},"extra":1}']) {
    fs.writeFileSync(file, bad, { mode: 0o600 });
    assert.throws(() => loadWorkers(file), /./, `accepted ${bad}`);
  }
  // pool is not offered: neither a pool key nor a worker named pool is quietly accepted
  const conn = '"connections":[{"issuer":"i","subject":"s","client_id":"c"}]';
  for (const pooled of [`{"workers":{"a":{${conn},"pool":true}}}`, `{"workers":{"a":{${conn},"pool":false}}}`]) { fs.writeFileSync(file, pooled, { mode: 0o600 }); assert.throws(() => loadWorkers(file), /\.pool is not supported/, pooled); }
  fs.writeFileSync(file, `{"workers":{"pool":{${conn}}}}`, { mode: 0o600 }); assert.throws(() => loadWorkers(file), /"pool" is reserved/);
});


await check('denials and capacity holds come only from the target worker: a non-target report changes neither', async () => {
  const { store, subs, submit, events, advance } = await fixture('denials');
  const a = rid('a'), m1 = rid('m1'), m2 = rid('m2');
  submit(a, 'dot'); submit(m1, 'lark'); submit(m2, 'lark');
  const held = store.claim(m1, 'lark', 'owner', 6, null, 'lark');
  const snapshot = () => JSON.stringify({ rows: store.db.prepare('SELECT * FROM claim_denials ORDER BY request_id').all(), dot: store.capacityHoldUntil('dot'), denied: store.deniedQueued('dot') });
  const before = snapshot();
  // lark names the worker's request, plain and with a capacity claim: nothing is recorded, nothing is held
  store.progress(m1, held.claim_id, `Claim ${a} was denied by the reviewer.`, 'owner', false, 'lark');
  store.progress(m1, held.claim_id, `Claim ${a} was denied: capacity exceeded.`, 'owner', false, 'lark');
  store.finish(m1, held.claim_id, 'blocked', `Claim ${a} was denied: capacity exceeded.`, 'nothing else', 'owner', null, 'lark');
  assert.equal(snapshot(), before, 'a non-target report changed a denial or hold');
  assert.equal(store.claimDenial(a), null);
  // the target worker can still report about its own queued work, and the hold stays its own
  const held2 = store.claim(m2, 'lark', 'owner', 6, null, 'lark');
  const m3 = rid('m3'); submit(m3, 'lark');
  store.progress(m2, held2.claim_id, `Claim ${m3} was denied: capacity exceeded.`, 'owner', false, 'lark');
  assert.equal(store.claimDenial(m3).capacity, true);
  assert.equal(store.capacityHoldUntil('dot'), null, 'lark\'s capacity denial holds the dot');
  assert.notEqual(store.capacityHoldUntil('lark'), null);
  store.db.prepare("UPDATE notifications SET state='delivered'").run();
  advance(hours(1));
  store.reannounceQueued({ ...store.limits, rewakeMs: 60000 });
  assert.deepEqual(requestsFor(events(subs.dot, "AND wake_kind='rewake'")), [a], 'the worker lost its re-wake to another worker\'s denial');
  store.db.close();
});

await check('a worker missing from the profile sees nothing: no fan-out, no delivery, and its persisted subscription is retired', async () => {
  const { parseWorkers, visibleTargets, canSee } = await workersModule();
  const { store, subs, submit, events } = await fixture('ghost');
  const profile = parseWorkers(profileJson);
  assert.deepEqual(visibleTargets(profile, 'ghost'), []); assert.equal(canSee(profile, 'ghost', 'ghost'), false); assert.equal(canSee(profile, 'ghost', 'dot'), false);
  const future = new Date(store.nowMs() + hours(48)).toISOString();
  store.subscribe('sub_ghost', 'http://127.0.0.1/ghost', 'whsec_test', future, 'owner', 'ghost');
  const a = rid('a'), g = rid('g');
  submit(a, 'dot'); submit(g, 'ghost');
  assert.deepEqual(events('sub_ghost'), [], 'a worker outside the profile was woken');
  store.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,body,created_at,wake_kind) VALUES('evt_ghost','event',?,'sub_ghost','{}',?,'submit')").run(g, store.stamp());
  assert.equal(store.startAttempt('evt_ghost', null), null, 'a stored event was delivered to a worker outside the profile');
  store.db.prepare("INSERT INTO notifications(id,kind,request_id,subscription_id,body,created_at,wake_kind) VALUES('evt_ghost2','event',?,'sub_ghost','{}',?,'submit')").run(a, store.stamp());
  assert.deepEqual(store.retireUnknownSubscriptions(), ['sub_ghost']);
  assert.equal(store.db.prepare("SELECT state FROM subscriptions WHERE id='sub_ghost'").get().state, 'revoked');
  assert.equal(store.db.prepare("SELECT state FROM notifications WHERE id='evt_ghost2'").get().state, 'suppressed');
  assert.ok(store.activeSubscriptions().every(sub => sub.id !== 'sub_ghost'));
  assert.ok(events(subs.dot).length >= 1);
  store.db.close();
});

await check('worker usage breaks, probe budget and claim-rate accounting touch only the worker', async () => {
  const { store, subs, submit, events, advance } = await fixture('breaks');
  const a = rid('a'), b = rid('b');
  submit(a, 'dot'); submit(b, 'lark');
  store.setBreak('owner says the worker is on a break');
  store.db.prepare("UPDATE notifications SET state='delivered'").run();
  advance(hours(1)); // inside the probe interval: the dot is held, lark must not be
  store.reannounceQueued({ ...store.limits, rewakeMs: 60000, breakProbeMs: hours(3) });
  assert.deepEqual(requestsFor(events(subs.dot, "AND wake_kind='rewake'")), [], 'the worker should wait for its probe');
  assert.deepEqual(requestsFor(events(subs.lark, "AND wake_kind='rewake'")), [b], 'a worker break delayed another worker');
  store.db.prepare("UPDATE notifications SET state='delivered'").run();
  advance(hours(4)); // probe due: one dot probe, and lark still gets its own re-wake in the same tick
  const tick = store.reannounceQueued({ ...store.limits, rewakeMs: 60000, breakProbeMs: hours(3) });
  assert.equal(events(subs.dot, "AND wake_kind='rewake'").length, 1); assert.equal(events(subs.lark, "AND wake_kind='rewake'").length, 2);
  assert.equal(tick.probe, true);
  // claim-rate accounting: other workers\' claims are not the worker\'s rate
  const m = [rid('m1'), rid('m2')]; for (const id of m) submit(id, 'lark');
  for (const id of m) store.claim(id, 'lark', 'owner', 6, null, 'lark');
  store.claim(a, 'dot', 'owner', 6, null, 'dot');
  assert.equal(store.rollingUsage().claims_last_hour, 1, 'lark claims counted as worker claims');
  store.db.close();
});

await check('legacy profile: capacity and lanes stay per subject, exactly as before the change', async () => {
  const store = new Store(path.join(root, 'legacy-lanes.db'), { capacity: 2 });
  for (const id of ['l1', 'l2', 'l3', 'l4'].map(x => rid(x))) store.submit(assignment(id), { mode: 'none' }, null, 'owner-token');
  const [l1, l2, l3, l4] = store.listPending().map(x => x.request_id);
  store.claim(l1, 'dot', 'owner', 2, null, 'dot'); store.claim(l2, 'dot', 'owner', 2, null, 'dot');
  assert.throws(() => store.claim(l3, 'dot', 'owner', 2, null, 'dot'), /^Error: capacity_full$/);
  assert.equal(store.claim(l3, 'dot', 'other', 2, null, 'dot').duplicate, false, 'a second subject has its own lanes in the legacy profile');
  assert.equal(store.freeLanes('owner','dot',6,2), 0); assert.equal(store.freeLanes('other','dot',6,2), 1);
  assert.ok(l4);
  store.db.close();
});

await check('usage attribution is bound to the claim event\'s request target, not to who holds the claim row later', async () => {
  const { store, submit } = await fixture('attribution');
  const a = rid('a'), m = rid('m');
  submit(a, 'dot'); submit(m, 'lark');
  store.claim(m, 'lark', 'owner', 6, null, 'lark'); store.claim(a, 'dot', 'owner', 6, null, 'dot');
  assert.equal(store.rollingUsage().claims_last_hour, 1, 'only the worker\'s claim counts');
  // whoever holds the row afterwards (a takeover, a repair, a migration) does not move an event that was already written
  assert.throws(()=>store.db.prepare("UPDATE claims SET worker='lark' WHERE request_id=?").run(a), /immutable/);
  store.db.prepare("UPDATE claims SET subject='other' WHERE request_id=?").run(a);
  assert.equal(store.rollingUsage().claims_last_hour, 1, 'the worker\'s claim event moved with the claim row');
  store.db.close();
});

await check('break inference reads only the worker\'s own webhook acks: a lark-only ack infers no worker break', async () => {
  const { store, subs, submit, advance } = await fixture('infer');
  const a = rid('a');
  submit(a, 'dot');
  store.recordWorkerCall('owner', 'list_pending'); // the dot\'s last call
  advance(hours(1));
  store.eventResult(subs.lark, 200); // lark\'s webhook answered after that call
  assert.equal(store.inferBreak(), null, 'a lark ack inferred a worker break');
  store.eventResult(subs.dot, 200);
  assert.notEqual(store.inferBreak(), null, 'the worker\'s own ack still infers a break');
  store.db.close();
});

await check('attribution survives profile deletion, worker removal and connection revocation without reclassification', async () => {
  const { store, submit, advance }=await fixture('persist');
  const d=rid('d'),m=rid('m');submit(d,'dot');submit(m,'lark');
  store.claim(d,'dot','owner',6,null,'dot');const lark=store.claim(m,'lark','owner',6,null,'lark');
  store.recordWorkerCall('owner','get','dot');store.recordWorkerCall('owner','get','lark');
  store.recordResponseBytes('owner','get',100,'dot');store.recordResponseBytes('owner','get',900,'lark');
  advance(60000);
  const snapshot=()=>JSON.stringify({rolling:store.rollingUsage(),usage:store.usageBefore(store.nowMs()),claims:store.db.prepare('SELECT worker,subject FROM claims ORDER BY request_id').all(),subs:store.db.prepare('SELECT worker FROM subscriptions ORDER BY id').all()});
  const before=snapshot();
  const {LEGACY_PROFILE,parseWorkers}=await workersModule();
  for(const profile of [LEGACY_PROFILE,parseWorkers({workers:{dot:profileJson.workers.dot}}),parseWorkers({workers:{dot:profileJson.workers.dot,lark:{connections:[{issuer:ISS,subject:'owner',client_id:'replacement'}]}}})]) {
    store.workers=profile;store.retireUnknownSubscriptions();assert.equal(snapshot(),before);
    assert.equal(store.rollingUsage().claims_last_hour,1);assert.equal(store.rollingUsage().response_bytes_last_hour,100);
  }
  assert.throws(()=>store.db.prepare("UPDATE claims SET worker='dot' WHERE request_id=?").run(m),/immutable/);
  assert.throws(()=>store.db.prepare("UPDATE claims SET lane_key='changed' WHERE request_id=?").run(m),/recorded per epoch/);
  assert.throws(()=>store.db.prepare("UPDATE worker_calls SET worker='dot' WHERE worker='lark'").run(),/immutable/);
  assert.throws(()=>store.db.prepare("UPDATE assignments SET target_worker='dot' WHERE request_id=?").run(m),/immutable/);
  assert.throws(()=>store.db.prepare("UPDATE subscriptions SET worker='dot' WHERE id='sub_lark'").run(),/immutable/);
  store.db.close();
});

await check('a lark-only ack never infers a worker break after deleting the profile',async()=>{
  const {store,submit,subs,advance}=await fixture('ack-persist');submit(rid('q'),'dot');
  store.recordWorkerCall('owner','get','dot');advance(hours(1));store.eventResult(subs.lark,200);
  store.workers=(await workersModule()).LEGACY_PROFILE;store.retireUnknownSubscriptions();
  assert.equal(store.inferBreak(),null);store.db.close();
});

await check('connection revocation retires its subscription without changing recorded worker attribution',async()=>{
  const {store}=await fixture('revoke');
  store.subscribe('sub_conn','http://127.0.0.1/conn','whsec_test',new Date(store.nowMs()+hours(48)).toISOString(),'owner','lark',{issuer:ISS,subject:'owner',client_id:'client-lark'});
  store.workers=(await workersModule()).parseWorkers({workers:{dot:profileJson.workers.dot,lark:{connections:[{issuer:ISS,subject:'owner',client_id:'replacement'}]}}});
  assert.ok(store.retireUnknownSubscriptions().includes('sub_conn'));
  assert.deepEqual({...store.db.prepare("SELECT worker,state FROM subscriptions WHERE id='sub_conn'").get()},{worker:'lark',state:'revoked'});
  store.db.close();
});

await check('a verified worker re-subscribe replaces a revoked connection without updating immutable facts', async () => {
  const {parseWorkers}=await workersModule(), file=path.join(root,'rotated.db');
  const connection=client_id=>({issuer:ISS,subject:'owner',client_id});
  const profile=client_id=>parseWorkers({workers:{dot:{connections:[connection(client_id)]}}});
  let store=new Store(file,{workers:profile('old-client')});
  const expires=new Date(Date.now()+hours(48)).toISOString(),url='http://127.0.0.1/rotated';
  store.subscribe('sub_dot',url,'secret',expires,'owner','dot',connection('old-client'));
  const id=rid('rotate');store.submit(assignment(id),{mode:'none'},null,'owner');
  store.db.close();store=new Store(file,{workers:profile('new-client')});
  assert.equal(store.activeSubscriptions().length,0);
  assert.equal(store.db.prepare("SELECT state FROM subscriptions WHERE id='sub_dot'").get().state,'revoked');
  assert.throws(()=>store.subscribe('sub_dot',url,'secret',expires,'owner','dot',connection('old-client')),/unknown_connection/);
  store.subscribe('sub_dot',url,'secret',expires,'owner','dot',connection('new-client'));
  assert.equal(store.activeSubscriptions().length,1);
  assert.equal(store.subscriptionConnection(store.activeSubscriptions()[0]).client_id,'new-client');
  assert.equal(store.db.prepare("SELECT count(*) n FROM notifications WHERE subscription_id='sub_dot' AND state='pending'").get().n,1);
  assert.throws(()=>store.db.exec("UPDATE subscriptions SET connection=NULL"),/immutable/);
  assert.throws(()=>store.subscribe('sub_dot',url,'secret',expires,'owner','lark',connection('new-client')),/worker conflict/);
  store.db.close();
});

await check('subscriber capacity, send-time checks and liveness survive both profile switches and mixed recorded lanes', async () => {
  const {parseWorkers,LEGACY_PROFILE}=await workersModule();
  for(const reverse of [false,true]) for(const existing of [false,true]) {
    const file=path.join(root,`switch-${reverse}-${existing}.db`),profile=parseWorkers(profileJson);
    let now=Date.parse('2026-10-22T00:00:00Z'),store=new Store(file,{now:()=>now,capacity:2,workers:reverse?profile:LEGACY_PROFILE});
    const connection={issuer:ISS,subject:'owner',client_id:'client-dot'},expires=new Date(now+hours(48)).toISOString();
    store.subscribe('sub_switch','http://127.0.0.1/switch','secret',expires,'owner','dot',connection);
    const ids=Array.from({length:3},()=>rid('switch'));
    for(const id of ids) store.submit(assignment(id),{mode:'none'},null,'owner');
    if(existing) store.claim(ids[0],'dot','owner',2);
    const recorded=store.db.prepare('SELECT request_id,lane_key,lane_scope FROM claims').all();
    store.db.close();store=new Store(file,{now:()=>now,capacity:2,workers:reverse?LEGACY_PROFILE:profile});
    assert.deepEqual(store.db.prepare('SELECT request_id,lane_key,lane_scope FROM claims').all(),recorded);
    for(let i=existing?1:0;i<2;i++) store.claim(ids[i],'dot','owner',2);
    if(!existing) assert.throws(()=>store.claim(ids[2],'dot','owner',2),/capacity_full/);
    store.db.exec("UPDATE notifications SET state='delivered'");now+=hours(3);
    store.db.prepare('UPDATE claims SET last_claim_activity_at=?').run(store.stamp());
    const sub=store.activeSubscriptions()[0];
    assert.equal(store.db.prepare("SELECT 1 FROM pragma_table_info('subscriptions') WHERE name='lane_key'").get(),undefined);
    assert.equal(store.subscriptionFreeLanes(sub,2,2),0);
    assert.equal(store.reannounceQueued({...store.limits,laneCapacity:2,rewakeMs:0}).announced,0);
    assert.equal(store.rewakeStale({subscription_id:sub.id,request_id:ids[2]}),'no free lane');
    assert.equal(store.liveness().items.find(row=>row.request_id===ids[2]).class,'at_capacity_healthy');
    assert.equal(store.status().dispatch.free_lanes,0);
    store.db.close();
  }
});

await check('claim admission counts recorded lanes after either profile switch and excludes takeover targets',async()=>{
  const {parseWorkers,LEGACY_PROFILE}=await workersModule(),profile=parseWorkers(profileJson);
  for(const reverse of [false,true]) {
    const file=path.join(root,`admission-switch-${reverse}.db`);
    let now=Date.parse('2026-10-22T00:00:00Z'),store=new Store(file,{now:()=>now,capacity:2,workers:reverse?profile:LEGACY_PROFILE});
    const ids=Array.from({length:3},()=>rid('admission'));
    for(const id of ids) store.submit(assignment(id),{mode:'none'},null,'owner');
    const claims=ids.slice(0,2).map(id=>store.claim(id,'dot','owner',2,null,'dot','admission-run'));
    const recorded=store.db.prepare('SELECT request_id,lane_key,lane_scope FROM claims ORDER BY request_id').all();
    store.db.close();store=new Store(file,{now:()=>now,capacity:2,workers:reverse?LEGACY_PROFILE:profile});
    assert.throws(()=>store.claim(ids[2],'dot','owner',2),/capacity_full/);
    assert.deepEqual(store.db.prepare('SELECT request_id,lane_key,lane_scope FROM claims ORDER BY request_id').all(),recorded);
    assert.equal(store.subscriptionFreeLanes({principal:'owner',worker:'dot'},2,2),0);
    // Retrying a held claim stays idempotent at capacity; a takeover excludes its own target from the count.
    assert.equal(store.claim(ids[0],'dot','owner',2,null,'dot','admission-run').claim_id,claims[0].claim_id);
    now+=hours(2);
    assert.notEqual(store.claim(ids[0],'replacement','owner',2,null,'dot','replacement-run').claim_id,claims[0].claim_id);
    store.abandon(ids[1],{actor:'owner',reason:'free a recorded lane'});
    assert.ok(store.claim(ids[2],'dot','owner',2).claim_id);
    assert.equal(store.subscriptionFreeLanes({principal:'owner',worker:'dot'},2,2),0);
    store.db.close();
  }
});

await check('status uses only worker subscriptions regardless of insertion and verification order',async()=>{
  const {parseWorkers}=await workersModule(),profile=structuredClone(profileJson);
  profile.workers.lark.connections[0].subject='lark-owner';
  for(const order of [['lark','dot'],['dot','lark']]) {
    let now=Date.parse('2026-10-22T00:00:00Z'),dotVerified;
    const store=new Store(':memory:',{now:()=>now,capacity:2,workers:parseWorkers(profile)});
    for(const worker of order) {
      now+=1000;const principal=worker==='dot'?'owner':'lark-owner';
      store.subscribe(`sub_${worker}`,`http://127.0.0.1/${worker}`,'secret',new Date(now+hours(48)).toISOString(),principal,worker,{issuer:ISS,subject:principal,client_id:`client-${worker}`});
      if(worker==='dot') dotVerified=store.stamp();
      else if(!dotVerified) {assert.equal(store.status().subscription.state,'absent');assert.equal(store.status().subscriptions_active,0);}
    }
    for(let i=0;i<2;i++) {const payload=assignment(rid('status-full'));store.submit(payload,{mode:'none'},null,'owner');store.claim(payload.request_id,'dot','owner',2);}
    const status=store.status();
    assert.equal(status.dispatch.state,'full');assert.equal(status.dispatch.free_lanes,0);
    assert.equal(status.subscription.principal,'owner');assert.equal(status.subscription.last_verified_at,dotVerified);
    assert.equal(status.subscriptions_active,1);
    store.unsubscribe('sub_dot');const revoked=store.status();
    assert.equal(revoked.subscription.state,'revoked');assert.equal(revoked.subscription.principal,'owner');assert.equal(revoked.subscriptions_active,0);
    store.db.close();
  }
});

await check('status separates worker facts and never invents capacity',async()=>{
  const {parseWorkers}=await workersModule();let now=Date.parse('2026-10-22T00:00:00Z');
  const store=new Store(':memory:',{now:()=>now,capacity:6,workers:parseWorkers(profileJson)});
  const put=(worker,label)=>{const payload=assignment(rid(label));store.submit(payload,{mode:'none'},null,'owner',false,null,'normal',null,payload,null,worker);return payload.request_id;};
  const dot=put('dot','status-dot'),lark=put('lark','status-lark');put('dot','status-dot-queued');put('dot','status-dot-queued-2');put('lark','status-lark-queued');
  store.claim(dot,'dot-agent','owner',6,null,'dot');store.claim(lark,'lark-agent','owner',6,null,'lark');
  store.recordWorkerCall('dot-owner','list_pending','dot');const dotCall=store.stamp();now+=1000;store.recordWorkerCall('lark-owner','list_pending','lark');
  let status=store.status();
  assert.equal(status.by_worker.lark.active_claims,1);
  assert.equal(status.by_worker.dot.active_claims,1);
  assert.equal(status.by_worker.lark.queued_live,1);
  assert.equal(status.by_worker.dot.queued_live,2);
  assert.equal(status.by_worker.lark.last_call_at,store.stamp());
  assert.equal(status.by_worker.dot.last_call_at,dotCall);
  assert.equal(status.counts_scope,'global');
  assert.equal(status.liveness_scope,'dot');
  assert.equal(status.claimed_outer_count,1);
  assert.equal(status.counts.find(row=>row.status==='claimed').count,2);
  assert.equal(status.by_worker.lark.counts.find(row=>row.status==='claimed').count,1);
  assert.equal(status.by_worker.lark.capacity.free_lanes,null,'no subscription cannot prove available capacity');
  assert.equal(status.by_worker.dot.capacity.free_lanes,null,'no subscription cannot prove available capacity');
  assert.equal(status.dispatch.free_lanes,null,'legacy Worker dispatch cannot invent a fallback principal');
  store.subscribe('lark-a','http://127.0.0.1/lark-a','secret',new Date(now+hours(48)).toISOString(),'owner','lark',profileJson.workers.lark.connections[0]);
  store.subscribe('lark-b','http://127.0.0.1/lark-b','secret',new Date(now+hours(48)).toISOString(),'owner','lark',profileJson.workers.lark.connections[0]);
  store.subscribe('dot-a','http://127.0.0.1/dot-a','secret',new Date(now+hours(48)).toISOString(),'owner','dot',profileJson.workers.dot.connections[0]);
  const before=JSON.stringify({assignments:store.db.prepare('SELECT request_id,status FROM assignments ORDER BY request_id').all(),claims:store.db.prepare('SELECT request_id,state FROM claims ORDER BY request_id').all(),notifications:store.db.prepare('SELECT id,state FROM notifications ORDER BY id').all()});
  status=store.status();
  assert.equal(status.by_worker.lark.capacity.free_lanes,5,'duplicate subscriptions must not add lanes');
  assert.equal(status.by_worker.dot.capacity.free_lanes,5);
  assert.equal(status.by_worker.lark.capacity.scope,'worker');
  assert.equal(status.by_worker.dot.capacity.source,'subscription_policy');
  assert.deepEqual(status.by_worker.lark.capacity.lane_evidence,[{lane_scope:'worker',lane_key:'lark'}]);
  assert.equal(status.by_worker.lark.active_claims,1,'claims must not be counted once per subscription');
  const after=JSON.stringify({assignments:store.db.prepare('SELECT request_id,status FROM assignments ORDER BY request_id').all(),claims:store.db.prepare('SELECT request_id,state FROM claims ORDER BY request_id').all(),notifications:store.db.prepare('SELECT id,state FROM notifications ORDER BY id').all()});
  assert.equal(after,before,'status must not write admission, claim, or delivery state');
  now+=2*hours(1);status=store.status();
  assert.equal(status.by_worker.lark.stale_claims.count,1);
  assert.equal(status.by_worker.dot.stale_claims.count,1);
  assert.equal(status.by_worker.lark.queue_classes.transport_failing,1);
  assert.equal(status.by_worker.dot.queue_classes.transport_failing,2);
  const expired=put('lark','status-expired');
  store.db.prepare('UPDATE assignments SET valid_until=? WHERE request_id=?').run(new Date(now-1).toISOString(),expired);
  const expiryStatus=store.status().by_worker.lark;
  assert.equal(expiryStatus.queued_live,1);
  assert.equal(expiryStatus.counts.find(row=>row.status==='queued').count,1,'worker counts must exclude expired queued work');
  assert.equal(expiryStatus.queued_expired.count,1);
  store.unsubscribe('lark-a');store.unsubscribe('lark-b');
  status=store.status();
  assert.equal(status.by_worker.lark.capacity.free_lanes,null,'revoked subscriptions cannot prove current capacity');
  store.subscribe('lark-expired','http://127.0.0.1/lark-expired','secret',new Date(now-1).toISOString(),'owner','lark',profileJson.workers.lark.connections[0]);
  assert.equal(store.status().by_worker.lark.capacity.free_lanes,null,'expired subscriptions cannot prove current capacity');
  assert.equal(status.dispatch.free_lanes,5,'legacy Worker status retains subscription-backed capacity');
  store.db.close();

  const legacy=new Store(':memory:',{now:()=>now,capacity:6});
  const legacySingle=new Store(':memory:',{now:()=>now,capacity:6});
  const single=assignment(rid('legacy-single'));legacySingle.submit(single,{mode:'none'},null,'owner');
  legacySingle.claim(single.request_id,'legacy-agent','legacy-owner',6);
  legacySingle.subscribe('legacy-sub','http://127.0.0.1/legacy','secret',new Date(now+hours(48)).toISOString(),'legacy-owner','dot',null);
  assert.equal(legacySingle.status().dispatch.free_lanes,5,'valid legacy Worker subscription retains its principal-scoped capacity');
  assert.equal(legacySingle.status().dispatch.state,'supply_gap');
  legacySingle.db.close();
  for(const principal of ['legacy-a','legacy-b']) {
    const payload=assignment(rid(principal));legacy.submit(payload,{mode:'none'},null,'owner');
    legacy.claim(payload.request_id,`${principal}-agent`,principal,6);
    legacy.subscribe(`sub-${principal}`,`http://127.0.0.1/${principal}`,'secret',new Date(now+hours(48)).toISOString(),principal,'dot',null);
  }
  const ambiguous=legacy.status().by_worker.dot.capacity;
  assert.equal(ambiguous.state,'unknown','legacy subject scopes cannot be merged into one pool');
  assert.equal(ambiguous.unknown_reason,'ambiguous_principal_scope');
  assert.deepEqual(Object.keys(ambiguous.by_principal).sort(),['legacy-a','legacy-b']);
  legacy.db.close();

  // A profile change cannot turn an old subject-scoped lane into a shared pool.
  const mixed=new Store(':memory:',{now:()=>now,capacity:6});
  const payload=assignment(rid('old-subject'));mixed.submit(payload,{mode:'none'},null,'owner');
  mixed.claim(payload.request_id,'old-agent','old-owner',6);
  mixed.workers=parseWorkers({workers:{dot:{connections:[{issuer:ISS,subject:'new-owner',client_id:'client-dot'}]}}});
  mixed.subscribe('new-sub','http://127.0.0.1/new','secret',new Date(now+hours(48)).toISOString(),'new-owner','dot',{issuer:ISS,subject:'new-owner',client_id:'client-dot'});
  assert.equal(mixed.status().by_worker.dot.capacity.state,'unknown','one unmatched legacy lane still makes aggregate worker capacity ambiguous');
  mixed.db.close();

  const capped=new Store(':memory:',{now:()=>now,capacity:6,workers:parseWorkers(profileJson)});
  capped.limits={...capped.limits,laneCapacity:2,intervalMs:1000};
  capped.subscribe('capped-lark','http://127.0.0.1/capped','secret',new Date(now+hours(48)).toISOString(),'owner','lark',profileJson.workers.lark.connections[0]);
  for(let i=0;i<3;i++){
    const p=assignment(rid('capped'));capped.submit(p,{mode:'none'},null,'owner',false,null,'normal',null,p,null,'lark');
    if(i<2)capped.claim(p.request_id,'capped-'+i,'owner',6,null,'lark');
  }
  capped.db.prepare("UPDATE notifications SET state='delivered' WHERE kind='event'").run();
  now+=3000;capped.recordWorkerCall('owner','progress','lark');
  const full=capped.status().by_worker.lark;
  assert.equal(full.capacity.free_lanes,0);
  assert.equal(full.queue_classes.at_capacity_healthy,1,'liveness must use the same lane policy as capacity evidence');
  assert.equal(full.queue_classes.alive_not_claiming,0);
  capped.db.close();

  const breaks=new Store(':memory:',{now:()=>now,workers:parseWorkers(profileJson)});
  for(const worker of ['dot','lark']){const p=assignment(rid('break-'+worker));breaks.submit(p,{mode:'none'},null,'owner',false,null,'normal',null,p,null,worker);}
  breaks.startBreak({since:breaks.stamp(),reason:'synthetic Dot-only break',source:'owner'});now+=3*hours(1);
  assert.equal(breaks.status().by_worker.dot.unclaimed_after_reannounce.count,0);
  assert.equal(breaks.status().by_worker.lark.unclaimed_after_reannounce.count,1,'Worker breaks must not pause Lark queue age');
  breaks.db.close();
});

await check('queued_without_active_subscription counts only live worker work',async()=>{
  const {parseWorkers}=await workersModule();let now=Date.parse('2026-10-22T00:00:00Z');
  const store=new Store(':memory:',{now:()=>now,workers:parseWorkers(profileJson)});
  const put=(worker,valid_until)=>{const payload={...assignment(rid('subscription-gap')),...(valid_until?{valid_until}:{})};store.submit(payload,{mode:'none'},null,'owner',false,null,'normal',null,payload,null,worker);};
  put('lark');assert.equal(store.status().queued_without_active_subscription,false);
  put('dot',new Date(now-1000).toISOString());assert.equal(store.status().queued_without_active_subscription,false);
  put('dot');assert.equal(store.status().queued_without_active_subscription,true);
  const expires=new Date(now+hours(48)).toISOString();
  store.subscribe('sub_lark','http://127.0.0.1/lark','secret',expires,'owner','lark',profileJson.workers.lark.connections[0]);
  assert.equal(store.status().queued_without_active_subscription,true);
  store.subscribe('sub_dot','http://127.0.0.1/dot','secret',expires,'owner','dot',profileJson.workers.dot.connections[0]);
  assert.equal(store.status().queued_without_active_subscription,false);store.db.close();
});

await check('max_queued and background capacity count only their target worker and still enforce its own cap', async () => {
  const {store}=await fixture('queue-caps');store.backgroundMaxInFlight=2;
  const put=(worker,priority='normal',cap=null)=>{
    const payload=assignment(rid('cap'));
    return store.submit(payload,{mode:'none'},null,'owner',false,null,priority,null,payload,cap,worker);
  };
  for(let i=0;i<3;i++) put('lark');
  assert.ok(put('dot','normal',1).request_id);
  assert.throws(()=>put('dot','normal',1),/queue is full/);
  for(let i=0;i<2;i++) put('lark','background');
  assert.throws(()=>put('lark','background'),/background_capacity_full/);
  const claimed=put('dot','background');store.claim(claimed.request_id,'dot','owner',6,null,'dot');
  assert.ok(put('dot','background').request_id);
  assert.throws(()=>put('dot','background'),/background_capacity_full/);
  store.db.close();
});

// ---------------------------------------------------------------- Part 2: the real server, OAuth mode, one subject, many clients
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
const jwks = http.createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${jwks.address().port}/realm`, audience = 'https://dot-bridge.example.test';
const token = (azp, extra = {}) => {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 600, sub: 'owner', scope: 'dot-bridge.read dot-bridge.work', ...(azp ? { azp } : {}), ...extra })).toString('base64url');
  return `${head}.${claims}.${sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url')}`;
};
const hooks = []; // every webhook delivery: which subscription heard about which request or message
const hookServer = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  if (message.type === 'verification') return res.end(JSON.stringify({ challenge: message.challenge }));
  hooks.push({ sub: req.headers['x-mcp-subscription-id'], request_id: message.data?.request_id ?? null, message_id: message.data?.message_id ?? null });
  res.end('ok');
});
await new Promise(resolve => hookServer.listen(0, '127.0.0.1', resolve));
const ntfy = http.createServer(async (req, res) => { for await (const chunk of req); res.end('ok'); });
await new Promise(resolve => ntfy.listen(0, '127.0.0.1', resolve));

async function startServer(name, workers, { allowed = 'owner', rawWorkers = null, prepare = null, cwd = repo, reuse = false, envOverrides = {} } = {}) {
  const home = path.join(root, name), config = path.join(home, '.config/dot-bridge');
  if (!reuse) {
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true }); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'oauth.env'), `OAUTH_ISSUER=${issuer}\nOAUTH_AUDIENCE=${audience}\nOAUTH_JWKS_URI=${issuer.replace('/realm', '/jwks')}\nOAUTH_ALLOWED_SUBJECTS=${allowed}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'limits.json'), JSON.stringify({ max_claimed_outer_assignments: 3 }), { mode: 0o600 }); // room for queue hints to name a next job
  fs.writeFileSync(path.join(config, 'alerts.env'), `NTFY_URL=http://127.0.0.1:${ntfy.address().port}/alert\n`, { mode: 0o600 });
  // An install that predates workers.json already has a database; a bare home does not (and must name its worker).
  if (!workers && !rawWorkers && !envOverrides.NO_EXISTING_DB) { fs.mkdirSync(path.join(home, '.local/share/dot-bridge'), { recursive: true }); { const fixture = new DatabaseSync(path.join(home, '.local/share/dot-bridge/bridge.db')); fixture.exec('PRAGMA user_version=1'); fixture.close(); } }
  if (workers || rawWorkers) fs.writeFileSync(path.join(config, 'workers.json'), rawWorkers ?? JSON.stringify(workers), { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'bin/t3code'), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,data:{threads:[{id:'thread_a',projectId:'project_fake',updatedAt:'2026-10-09T00:00:00.000Z'}]}}));\n`, { mode: 0o755 });
  }
  if (prepare) await prepare(home);
  const env = { ...process.env,DALAN_ENABLE_T3_TOOLS:'1', HOME: home, DOT_BRIDGE_PORT: '0', DOT_BRIDGE_AUTH_MODE: 'oauth', DOT_BRIDGE_TEST_OAUTH: '1', DOT_BRIDGE_ENABLE_WORKSPACE: '1', DOT_BRIDGE_ALLOW_PRIVATE_WEBHOOKS: '1', DOT_BRIDGE_WORKSPACE_ROOT: path.join(home, 'work'), PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, ...envOverrides };
  delete env.DOT_BRIDGE_WORKERS_FILE;
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let port = null, stderr = '', exited = null;
  child.stdout.on('data', b => { const m = /MCP listening on 0\.0\.0\.0:(\d+)/.exec(String(b)); if (m) port = Number(m[1]); });
  child.stderr.on('data', b => { stderr += b; });
  let done = false; // exit code is null for a signal, so a separate flag says the process is gone
  child.once('exit', code => { exited = code; done = true; });
  for (let i = 0; i < 200 && port === null && !done; i++) await sleep(50);
  const server = { name, home, env, child, get exited() { return exited; }, get stderr() { return stderr; }, port };
  server.stop = async () => { if (done) return; child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); };
  if (port === null) return server;
  const secret = fs.readFileSync(path.join(config, 'env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  server.dbPath = path.join(home, '.local/share/dot-bridge/bridge.db');
  server.rpc = async (bearer, method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  // A tool call: {ok, value} on success, {ok:false, error} with the exact error text otherwise.
  server.tool = async (bearer, name, args = {}) => {
    const { status, body } = await server.rpc(bearer, 'tools/call', { name, arguments: args });
    if (status !== 200) return { ok: false, status, error: JSON.stringify(body) };
    const text = body.result.content[0].text;
    return body.result.isError ? { ok: false, error: text } : { ok: true, value: JSON.parse(text) };
  };
  server.cli = (args, input) => { const r = spawnSync(process.execPath, ['bin/dot-worker.mjs', ...args], { cwd: repo, env, input, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  server.submit = (id, worker, extra = []) => server.cli(['submit', '--stdin', '--json', ...(worker ? ['--worker', worker] : []), ...extra], JSON.stringify(assignment(id)));
  return server;
}
const dbRead = (server, sql, ...args) => { const db = new DatabaseSync(server.dbPath, { readOnly: true }); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const readSubscriptionConnection = async (server, id) => { const { SubscriptionCodec } = await import('../src/subscription-storage.mjs'); const codec = new SubscriptionCodec(fs.readFileSync(`${server.dbPath}.secrets/storage.key`)); return JSON.parse(codec.open(dbRead(server, 'SELECT connection FROM subscriptions WHERE id=?', id)[0].connection, `subscriptions:${id}:connection`)); };

const T = { dot: token('client-dot'), lark: token('client-lark'), grok: token('client-grok') };
const servers = [];
const liveProfile = JSON.parse(JSON.stringify(profileJson).replaceAll(ISS, issuer)); // the same workers, bound to the test IdP's issuer
const server = await startServer('main', liveProfile);
servers.push(server);
try {
  assert.notEqual(server.port, null, `server did not start: ${server.stderr}`);
  const t3Names = ['t3_thread_list', 't3_thread_read', 'notify_owner'];

  await check('status CLI preserves worker-scoped evidence',async()=>{
    const id=rid('status-cli');assert.equal(server.submit(id,'lark').code,0);
    const claim=await server.tool(T.lark,'claim',{request_id:id,claimant:'status-cli-worker'});assert(claim.ok,claim.error);
    const read=server.cli(['status','--json']);assert.equal(read.code,0,read.stderr);
    const status=JSON.parse(read.stdout);
    assert.equal(status.by_worker.lark.active_claims,1);assert.equal(status.by_worker.dot.active_claims,0);
    assert(status.by_worker.lark.last_call_at);assert.equal(status.by_worker.lark.capacity.state,'unknown');
    assert.equal(status.by_worker.lark.capacity.free_lanes,null);assert.equal(status.dispatch.free_lanes,null);
    assert.equal(status.dispatch.scope,'dot');assert.equal(status.liveness_scope,'dot');assert.equal(status.counts_scope,'global');
    assert.equal((await server.tool(T.lark,'finish',{request_id:id,claim_id:claim.value.claim_id,outcome:'completed',summary:'synthetic status test',result:'fixture'})).ok,true);
  });

  await check('an unknown or missing azp gets no worker at all (403 unknown_connection), for tools and subscriptions alike', async () => {
    for (const bearer of [token('client-stranger'), token(null), token('client-dot', { azp: 'client-other' })]) {
      const list = await server.rpc(bearer, 'tools/list');
      assert.equal(list.status, 403); assert.equal(list.body.error, 'unknown_connection');
      const call = await server.rpc(bearer, 'tools/call', { name: 'list_pending', arguments: {} });
      assert.equal(call.status, 403);
      const sub = await server.rpc(bearer, 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: `http://127.0.0.1:${hookServer.address().port}/x`, secret: `whsec_${randomBytes(32).toString('base64')}` } });
      assert.equal(sub.status, 403);
    }
  });

  await check('client_id is the fallback when azp is absent, and a connection_id claim alone does not make a worker', async () => {
    assert.equal((await server.rpc(token(null, { client_id: 'client-lark' }), 'tools/list')).status, 200);
    assert.equal((await server.rpc(token('client-stranger', { connection_id: 'client-lark' }), 'tools/list')).status, 403);
  });

  await check('tools/list drops the T3 tools and notify_owner for a worker without the t3 capability, and keeps them for the worker', async () => {
    const names = async bearer => (await server.rpc(bearer, 'tools/list')).body.result.tools.map(t => t.name);
    const dot = await names(T.dot), lark = await names(T.lark), grok = await names(T.grok);
    for (const name of t3Names) { assert.ok(dot.includes(name), `worker lost ${name}`); assert.ok(!lark.includes(name), `lark sees ${name}`); assert.ok(!grok.includes(name), `grok sees ${name}`); }
    for (const name of ['list_pending', 'claim', 'get', 'finish', 'artifact_chunk']) assert.ok(lark.includes(name));
  });

  await check('a worker without the t3 capability cannot call T3 tools or notify_owner; the worker can; the refusal is audited', async () => {
    for (const name of t3Names) {
      const args = name.startsWith('notify_') ? { text: 'hi' } : name === 't3_thread_read' ? { threadId: 'thread_a' } : {};
      const refused = await server.tool(T.lark, name, args);
      assert.equal(refused.ok, false, `lark ran ${name}`); assert.match(refused.error, /^(?:worker_capability_denied|unknown tool)$/);
    }
    assert.equal((await server.tool(T.dot, 't3_thread_list', { status: 'all' })).ok, true);
    assert.equal((await server.tool(T.dot, 'notify_owner', { text: 'hi' })).ok, true);
    const denied = dbRead(server, "SELECT tool FROM t3_audit WHERE worker='lark' AND result_status='denied: worker_capability_denied'");
    assert.equal(denied.length, t3Names.length, `one bounded denial per call: ${denied.length}`);
  });

  // The webhook receiver is one URL for every worker: the subscription ID (not the URL) must tell them apart.
  const hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`, subscribed = {};
  const subscribe = async worker => { const r = await server.rpc(T[worker], 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: hookUrl, secret: `whsec_${randomBytes(32).toString('base64')}` } }); return r.body?.result?.id ?? null; };
  subscribed.dot = await subscribe('dot'); subscribed.lark = await subscribe('lark');
  await check('two workers with one subject and one webhook URL get two distinct subscriptions', async () => {
    assert.ok(subscribed.dot && subscribed.lark); assert.notEqual(subscribed.dot, subscribed.lark);
    assert.deepEqual(dbRead(server, 'SELECT id,worker FROM subscriptions ORDER BY worker').map(r => r.worker), ['dot', 'lark']);
  });

  const ids = { a: rid('a'), a2: rid('a2'), b: rid('b'), b2: rid('b2'), p: rid('p'), none: rid('none') };
  await check('submit --worker: unknown names are refused with the configured names; a retry naming another worker conflicts', async () => {
    const unknown = server.submit(rid('x'), 'nobody');
    assert.notEqual(unknown.code, 0); assert.match(unknown.stderr + unknown.stdout, /unknown worker \\?"nobody\\?"; configured workers: dot, lark, grok/);
    const pooled = server.submit(rid('x'), 'pool'); assert.notEqual(pooled.code, 0); assert.match(pooled.stderr + pooled.stdout, /worker \\?"pool\\?" is not supported/);
    const accepted = server.submit(ids.a, 'dot'); assert.equal(accepted.code, 0, accepted.stderr);
    const conflict = server.submit(ids.a, 'lark'); assert.notEqual(conflict.code, 0); assert.match(conflict.stderr + conflict.stdout, /conflict/);
    const retry = server.submit(ids.a, null); assert.equal(retry.code, 0, retry.stderr); assert.equal(JSON.parse(retry.stdout).duplicate, true);
  });
  for (const [id, worker] of [[ids.a2, 'dot'], [ids.b, 'lark'], [ids.b2, 'lark']]) server.submit(id, worker);
  // Profile mode no longer falls back to dot: a submit that names no worker is refused (the id then goes to worker explicitly).
  const unnamed = server.submit(ids.none, null); assert.notEqual(unnamed.code, 0); assert.match(unnamed.stderr, /use --worker NAME; configured: /);
  server.submit(ids.none, 'dot');

  await check('the target is stored in a column and shown by the owner get next to the finishing worker', async () => {
    const rows = Object.fromEntries(dbRead(server, 'SELECT request_id,target_worker FROM assignments').map(r => [r.request_id, r.target_worker]));
    assert.deepEqual([rows[ids.a], rows[ids.b], rows[ids.none]], ['dot', 'lark', 'dot']);
    assert.equal(JSON.parse(server.cli(['get', ids.b, '--json']).stdout).target_worker, 'lark');
  });

  await check('events: each worker\'s subscription hears only about its own jobs', async () => {
    for (let i = 0; i < 80 && !(hooks.some(h => h.sub === subscribed.dot && h.request_id === ids.a) && hooks.some(h => h.sub === subscribed.lark && h.request_id === ids.b)); i++) await sleep(100);
    await sleep(1500);
    const heard = sub => hooks.filter(h => h.sub === sub).map(h => h.request_id);
    assert.ok(heard(subscribed.dot).includes(ids.a) && heard(subscribed.lark).includes(ids.b), 'owners were not woken');
    for (const mine of [ids.b, ids.b2]) assert.ok(!heard(subscribed.dot).includes(mine), `worker heard ${mine}`);
    for (const theirs of [ids.a, ids.a2, ids.none]) assert.ok(!heard(subscribed.lark).includes(theirs), `lark heard ${theirs}`);
  });

  // A third worker subscribing late must not be replayed anyone else's jobs; then a job for it is submitted.
  subscribed.grok = await subscribe('grok');
  server.submit(ids.p, 'grok');
  await check('a late subscriber is replayed nothing of other workers\' jobs and hears only its own', async () => {
    for (let i = 0; i < 80 && !hooks.some(h => h.sub === subscribed.grok && h.request_id === ids.p); i++) await sleep(100);
    await sleep(1500);
    const heard = sub => hooks.filter(h => h.sub === sub).map(h => h.request_id).filter(Boolean);
    assert.deepEqual(heard(subscribed.grok), [ids.p]);
    assert.ok(!heard(subscribed.dot).includes(ids.p) && !heard(subscribed.lark).includes(ids.p));
  });

  await check('list_pending shows each worker only its own jobs', async () => {
    const listed = async worker => (await server.tool(T[worker], 'list_pending')).value.assignments.map(a => a.request_id).sort();
    assert.deepEqual(await listed('dot'), [ids.a, ids.a2, ids.none].sort());
    assert.deepEqual(await listed('lark'), [ids.b, ids.b2].sort());
    assert.deepEqual(await listed('grok'), [ids.p]);
  });

  await check('a non-target claim, get and ack fail exactly as for a request that does not exist', async () => {
    const ghost = rid('ghost');
    for (const [tool, args] of [['claim', id => ({ request_id: id, claimant: 'lark' })], ['get', id => ({ request_id: id })]]) {
      const missing = await server.tool(T.lark, tool, args(ghost)), hidden = await server.tool(T.lark, tool, args(ids.a));
      assert.equal(hidden.ok, false, `lark ${tool} on the worker's job succeeded`); assert.equal(hidden.error, missing.error);
    }
    assert.equal((await server.tool(T.lark, 'claim', { request_id: ids.p, claimant: 'lark' })).error, (await server.tool(T.lark, 'claim', { request_id: ghost, claimant: 'lark' })).error, 'lark claimed grok\'s job');
    assert.equal(dbRead(server, "SELECT status FROM assignments WHERE request_id=?", ids.a)[0].status, 'queued');
  });

  // The worker claims its job; the lark then holds the worker's real claim_id (the strongest probe) and tries everything.
  const dotClaim = (await server.tool(T.dot, 'claim', { request_id: ids.a, claimant: 'dot' })).value;
  const larkClaim = (await server.tool(T.lark, 'claim', { request_id: ids.b, claimant: 'lark' })).value;
  await check('claim and finish queue hints name only what that worker may see', async () => {
    assert.ok(dotClaim && larkClaim, 'claims failed');
    assert.equal(dotClaim.queued_after_claim, 2, 'worker sees its two other jobs'); assert.deepEqual(dotClaim.next_queued.map(x => x.request_id).sort(), [ids.a2, ids.none].sort());
    assert.equal(larkClaim.queued_after_claim, 1); assert.deepEqual(larkClaim.next_queued.map(x => x.request_id), [ids.b2]);
    assert.ok(!JSON.stringify(larkClaim).includes(ids.a), 'lark claim response leaks the worker\'s job');
  });

  await check('progress, finish, workspace tools and artifact_chunk by another worker fail as for a nonexistent request, and touch nothing', async () => {
    assert.ok(dotClaim?.claim_id, 'no worker claim');
    const activity = () => dbRead(server, 'SELECT last_claim_activity_at t,last_progress_at p FROM claims WHERE request_id=?', ids.a)[0];
    const before = activity(); await sleep(30);
    const art = `art_${randomUUID()}`, cases = {
      progress: id => ({ request_id: id, claim_id: dotClaim.claim_id, note: 'probe' }),
      finish: id => ({ request_id: id, claim_id: dotClaim.claim_id, outcome: 'completed', summary: 's', result: 'r' }),
      list_files: id => ({ request_id: id, claim_id: dotClaim.claim_id }),
      read_file: id => ({ request_id: id, claim_id: dotClaim.claim_id, path: 'README.md' }),
      apply_patch: id => ({ request_id: id, claim_id: dotClaim.claim_id, patch: 'diff --git a/x b/x\n' }),
      run_check: id => ({ request_id: id, claim_id: dotClaim.claim_id, check_id: 'default' }),
      workspace_result: id => ({ request_id: id, claim_id: dotClaim.claim_id }),
      artifact_chunk: id => ({ request_id: id, claim_id: dotClaim.claim_id, artifact_id: art, offset: 0, data_base64: Buffer.from('x').toString('base64'), final: true })
    };
    for (const [tool, args] of Object.entries(cases)) {
      const missing = await server.tool(T.lark, tool, args(rid('ghost'))), hidden = await server.tool(T.lark, tool, args(ids.a));
      assert.equal(hidden.ok, false, `lark ${tool} on the worker's job succeeded`); assert.equal(hidden.error, missing.error, `${tool} told hidden from missing`);
    }
    // Malformed input must not tell hidden from missing either: validation runs the same way for both.
    for (const [tool, args] of [['progress', { claim_id: 'x', note: 'probe' }], ['finish', { claim_id: 'x', outcome: 'completed', summary: 's', result: 'r' }], ['list_files', { claim_id: 'x' }], ['artifact_chunk', { claim_id: 'x', artifact_id: 'bad', offset: 0, data_base64: '!' }]]) {
      const missing = await server.tool(T.lark, tool, { request_id: rid('ghost'), ...args }), hidden = await server.tool(T.lark, tool, { request_id: ids.a, ...args });
      assert.equal(hidden.error, missing.error, `${tool} with malformed input told hidden from missing`);
    }
    assert.deepEqual(activity(), before, 'another worker touched the lease or progress clock');
    assert.equal(dbRead(server, 'SELECT count(*) n FROM artifacts WHERE request_id=?', ids.a)[0].n, 0);
    assert.equal(dbRead(server, 'SELECT count(*) n FROM progress WHERE request_id=?', ids.a)[0].n, 0);
  });

  await check('the owning worker still works: progress, workspace result, upload, finish record the worker', async () => {
    const ok = async (name, args) => { const r = await server.tool(T.dot, name, args); assert.equal(r.ok, true, `${name}: ${r.error}`); return r; };
    await ok('progress', { request_id: ids.a, claim_id: dotClaim.claim_id, note: 'mine' });
    await ok('workspace_result', { request_id: ids.a, claim_id: dotClaim.claim_id });
    const bytes = Buffer.from('report'), art = `art_${randomUUID()}`;
    await ok('artifact_chunk', { request_id: ids.a, claim_id: dotClaim.claim_id, artifact_id: art, offset: 0, data_base64: bytes.toString('base64'), final: true, sha256: createHash('sha256').update(bytes).digest('hex') });
    const finished = await server.tool(T.dot, 'finish', { request_id: ids.a, claim_id: dotClaim.claim_id, outcome: 'completed', summary: 'done', result: 'ok', artifact_ids: [art] });
    assert.equal(finished.ok, true, finished.error);
    assert.deepEqual((finished.value.next_queued ?? []).map(x => x.request_id).sort(), [ids.a2, ids.none].sort(), 'finish hint');
    assert.equal(dbRead(server, 'SELECT worker FROM reports WHERE request_id=?', ids.a)[0].worker, 'dot');
    const owner = JSON.parse(server.cli(['get', ids.a, '--json']).stdout);
    assert.equal(owner.target_worker, 'dot'); assert.equal(owner.report.worker, 'dot'); assert.equal(owner.claim.worker, 'dot');
  });

  await check('artifact aliases are request-scoped: foreign and absent aliases have equal errors and create at offset 0', async () => {
    const c1 = (await server.tool(T.dot, 'claim', { request_id: ids.a2, claimant: 'dot' })).value, c2 = (await server.tool(T.dot, 'claim', { request_id: ids.none, claimant: 'dot' })).value;
    assert.ok(c1 && c2, 'worker claims failed');
    const bytes = Buffer.from('foreign'), foreign = `art_${randomUUID()}`, absent = `art_${randomUUID()}`;
    const chunk = (claim, request, artifact, offset, final = false) => server.tool(T.dot, 'artifact_chunk', { request_id: request, claim_id: claim.claim_id, artifact_id: artifact, offset, data_base64: bytes.toString('base64'), final, ...(final ? { sha256: createHash('sha256').update(bytes).digest('hex') } : {}) });
    const shape = (result, artifact) => JSON.stringify(result).replaceAll(artifact, '<id>'); // the only difference allowed is the id itself
    assert.equal((await chunk(c1, ids.a2, foreign, 0, true)).ok, true);
    // offset 5: both are "wrong upload offset"
    assert.equal(shape(await chunk(c2, ids.none, foreign, 5), foreign), shape(await chunk(c2, ids.none, absent, 5), absent));
    // offset 0: both create, with the same response; the foreign id is not refused and does not touch the other request's artifact
    const viaForeign = await chunk(c2, ids.none, foreign, 0, true), viaAbsent = await chunk(c2, ids.none, absent, 0, true);
    assert.equal(viaForeign.ok, true, viaForeign.error); assert.equal(shape(viaForeign, foreign), shape(viaAbsent, absent));
    const rows = dbRead(server, 'SELECT request_id,id,size,sealed FROM artifacts WHERE client_artifact_id=? ORDER BY request_id', foreign);
    assert.deepEqual(rows.map(r => r.request_id).sort(), [ids.a2, ids.none].sort());
    assert.equal(new Set(rows.map(r=>r.id)).size,2,'global IDs must remain unique');
    assert.ok(rows.every(r=>r.id!==foreign));
    assert.equal((await server.tool(T.dot, 'finish', { request_id: ids.none, claim_id: c2.claim_id, outcome: 'completed', summary: 's', result: 'r', artifact_ids: [foreign, absent] })).ok, true);
    assert.equal((await server.tool(T.dot, 'finish', { request_id: ids.a2, claim_id: c1.claim_id, outcome: 'completed', summary: 's', result: 'r', artifact_ids: [foreign] })).ok, true);
    for (const request of [ids.a2,ids.none]) {
      const got=server.cli(['get',request,'--json']); assert.equal(got.code,0,got.stderr);
      const globalId=JSON.parse(got.stdout).artifacts.find(a=>rows.some(r=>r.request_id===request&&r.id===a.id)).id;
      const out=path.join(root,`dl-${request}`),download=server.cli(['artifact',globalId,'--output',out,'--json']);
      assert.equal(download.code,0,download.stderr);assert.deepEqual(fs.readFileSync(out),bytes);
    }
    assert.notEqual(server.cli(['artifact',foreign,'--output',path.join(root,'alias-download'),'--json']).code,0,'CLI accepted a request alias');
  });

  await check('owner notes and lightweight tell are delivered only to the target worker', async () => {
    const note = server.cli(['note', ids.b, 'only', 'for', 'lark', '--json']); assert.equal(note.code, 0, note.stderr);
    const told = JSON.parse(server.cli(['tell', '--worker', 'lark', 'psst', 'lark', '--json']).stdout), plain = JSON.parse(server.cli(['tell', 'for', 'the', 'dot', '--json']).stdout);
    for (let i = 0; i < 80 && !(hooks.some(h => h.sub === subscribed.lark && h.message_id === told.message_id) && hooks.some(h => h.sub === subscribed.dot && h.message_id === plain.message_id)); i++) await sleep(100);
    await sleep(1000);
    const heard = sub => hooks.filter(h => h.sub === sub);
    assert.ok(heard(subscribed.lark).some(h => h.message_id === told.message_id) && !heard(subscribed.dot).some(h => h.message_id === told.message_id), 'tell --worker lark');
    assert.ok(heard(subscribed.dot).some(h => h.message_id === plain.message_id) && !heard(subscribed.lark).some(h => h.message_id === plain.message_id), 'plain tell goes to the worker');
    assert.equal(heard(subscribed.dot).filter(h => h.request_id === ids.b).length, 0, 'owner note for the lark woke the worker');
    const listedBy = async worker => (await server.tool(T[worker], 'list_pending')).value.assignments.filter(a => a.kind === 'message').map(a => a.message_id);
    assert.deepEqual(await listedBy('lark'), [told.message_id]); assert.deepEqual(await listedBy('dot'), [plain.message_id]);
    assert.equal((await server.tool(T.dot, 'get', { request_id: told.message_id })).error, (await server.tool(T.dot, 'get', { request_id: 'msg_nonexistent_1' })).error);
    assert.equal((await server.tool(T.dot, 'ack_message', { message_id: told.message_id })).ok, false);
    assert.equal((await server.tool(T.lark, 'get', { request_id: ids.b })).value.owner_notes.length, 1);
    assert.equal((await server.tool(T.dot, 'get', { request_id: ids.b })).ok, false);
  });

  await check('public get hides the global owner-note cursor while the owner view retains it', async () => {
    const cursorA = rid('cursor-a'), cursorB = rid('cursor-b');
    assert.equal(server.submit(cursorA, 'dot').code, 0);
    assert.equal(server.submit(cursorB, 'lark').code, 0);
    const firstNote = server.cli(['note', cursorB, 'visible', 'one', '--json']);
    assert.equal(firstNote.code, 0, firstNote.stderr);
    const acquisition_id='cursor-b-run';
    const claimed = await server.tool(T.lark, 'claim', { request_id: cursorB, claimant: 'lark', acquisition_id });
    const before = await server.tool(T.lark, 'get', { request_id: cursorB });
    const ownerBeforeCmd = server.cli(['get', cursorB, '--json']);
    assert.equal(ownerBeforeCmd.code, 0, ownerBeforeCmd.stderr);
    const hiddenNote = server.cli(['note', cursorA, 'hidden', 'note', '--json']);
    assert.equal(hiddenNote.code, 0, hiddenNote.stderr);
    const secondNote = server.cli(['note', cursorB, 'visible', 'two', '--json']);
    assert.equal(secondNote.code, 0, secondNote.stderr);
    const after = await server.tool(T.lark, 'get', { request_id: cursorB });
    const retried = await server.tool(T.lark, 'claim', { request_id: cursorB, claimant: 'lark', acquisition_id });
    const ownerAfterCmd = server.cli(['get', cursorB, '--json']);
    assert.equal(ownerAfterCmd.code, 0, ownerAfterCmd.stderr);
    const ownerACmd = server.cli(['get', cursorA, '--json']);
    assert.equal(ownerACmd.code, 0, ownerACmd.stderr);
    for (const [name, response] of Object.entries({ claimed, before, after, retried })) assert.equal(response.ok, true, `${name} MCP call failed: ${JSON.stringify(response)}`);
    const ownerBefore = JSON.parse(ownerBeforeCmd.stdout), ownerAfter = JSON.parse(ownerAfterCmd.stdout), ownerA = JSON.parse(ownerACmd.stdout);
    assert.ok(Number.isInteger(ownerBefore.claim.last_seen_note_seq));
    assert.equal(ownerAfter.claim.last_seen_note_seq, ownerBefore.claim.last_seen_note_seq + 2);
    assert.equal(ownerAfter.target_worker, 'lark'); assert.equal(ownerAfter.claim.worker, 'lark');
    assert.deepEqual(ownerAfter.owner_notes.map(n => n.text), ['visible one', 'visible two']);
    assert.deepEqual(ownerA.owner_notes.map(n => n.text), ['hidden note']);
    assert.deepEqual(before.value.owner_notes.map(n => n.text), ['visible one']);
    assert.deepEqual(after.value.owner_notes.map(n => n.text), ['visible one', 'visible two']);
    assert.equal(retried.value.claim_id, claimed.value.claim_id);
    assert.equal(retried.value.duplicate, true);
    for (const [name, response] of Object.entries({ claimed: claimed.value, before: before.value, after: after.value, retried: retried.value })) {
      assert.equal(Object.hasOwn(response, 'last_seen_note_seq'), false, `${name} exposes the cursor at top level`);
      assert.equal(Object.hasOwn(response.claim ?? {}, 'last_seen_note_seq'), false, `${name} exposes the cursor in claim`);
      const json = JSON.stringify(response);
      assert.equal(json.includes('hidden note'), false, `${name} exposes another worker's note`);
      assert.equal(json.includes(cursorA), false, `${name} exposes another worker's request ID`);
    }
  });
} finally {
  for (const s of servers) await s.stop();
}

await check('a profile with two records matching one connection denies it (conflicting_connection)', async () => {
  const dup = { workers: { one: { connections: [{ issuer, subject: 'owner', client_id: 'client-x' }] }, two: { connections: [{ issuer, subject: 'owner', client_id: 'client-x' }] }, dot: { connections: [{ issuer, subject: 'owner', client_id: 'client-dot' }] } } };
  const conflicting = await startServer('conflict', dup);
  try {
    assert.notEqual(conflicting.port, null, conflicting.stderr);
    const denied = await conflicting.rpc(token('client-x'), 'tools/list');
    assert.equal(denied.status, 403); assert.equal(denied.body.error, 'conflicting_connection');
    assert.equal((await conflicting.rpc(token('client-dot'), 'tools/list')).status, 200);
  } finally { await conflicting.stop(); }
});

await check('a malformed workers.json stops the server at startup (fail closed)', async () => {
  const broken = await startServer('broken', null, { rawWorkers: '{"workers":{"a":{"connections":[]}}}' });
  try { assert.equal(broken.port, null); assert.notEqual(broken.exited, 0); assert.match(broken.stderr, /workers/i); }
  finally { await broken.stop(); }
});

await check('a fresh home with no workers.json refuses to start and names the fix; DALAN_LEGACY_PROFILE=1 opts into the legacy worker', async () => {
  const fresh = await startServer('fresh-no-profile', null, { envOverrides: { NO_EXISTING_DB: '1' } });
  try {
    assert.equal(fresh.port, null);
    assert.match(fresh.stderr, /no worker is configured.*dalan init --worker NAME/s);
    assert.ok(!fs.existsSync(path.join(fresh.home, '.local/share/dot-bridge/bridge.db')) && !fs.existsSync(path.join(fresh.home, '.local/share/dalan/bridge.db')), 'a refused start creates no database');
  } finally { await fresh.stop(); }
  const optIn = await startServer('fresh-opt-in', null, { envOverrides: { NO_EXISTING_DB: '1', DALAN_LEGACY_PROFILE: '1' } });
  try { assert.notEqual(optIn.port, null, optIn.stderr); } finally { await optIn.stop(); }
});
await check('legacy profile (no workers.json): every client is the worker, with its full catalog and the old behavior', async () => {
  const legacy = await startServer('legacy', null);
  try {
    assert.notEqual(legacy.port, null, legacy.stderr);
    const hook=`http://127.0.0.1:${hookServer.address().port}/legacy`;
    const subscription=(await legacy.rpc(token('client-one'),'events/subscribe',{name:'assignment.available',arguments:{},delivery:{mode:'webhook',url:hook,secret:`whsec_${randomBytes(32).toString('base64')}`}})).body.result;
    assert.equal(subscription.id,'sub_'+createHash('sha256').update(`owner\0${hook}\0assignment.available\0{}`).digest('hex').slice(0,32));
    const id = rid('legacy');
    assert.equal(legacy.submit(id, null).code, 0);
    for (const bearer of [token('client-one'), token(null), token('client-two')]) {
      const names = (await legacy.rpc(bearer, 'tools/list')).body.result.tools.map(t => t.name);
      assert.ok(names.includes('t3_thread_list') && names.includes('notify_owner'));
      assert.deepEqual((await legacy.tool(bearer, 'list_pending')).value.assignments.map(a => a.request_id), [id]);
    }
    const unknownName = legacy.submit(rid('x'), 'lark'); assert.notEqual(unknownName.code, 0); assert.match(unknownName.stderr + unknownName.stdout, /configured workers: dot/);
    assert.equal(legacy.submit(rid('x2'), 'dot').code, 0);
    assert.equal((await legacy.tool(token('client-one'), 'claim', { request_id: id, claimant: 'dot' })).ok, true);
    assert.equal((await legacy.tool(token('client-two'), 't3_thread_list', { status: 'all' })).ok, true);
  } finally { await legacy.stop(); }
});

await check('legacy HTTP: with no workers.json, capacity stays per subject (a second allowed subject has its own lanes)', async () => {
  const legacy = await startServer('ls', null, { allowed: 'owner,other' });
  try {
    assert.notEqual(legacy.port, null, legacy.stderr);
    const ids = [1, 2, 3, 4].map(n => rid(`cap${n}`)); for (const id of ids) legacy.submit(id, null);
    const owner = token('c1'), other = token('c2', { sub: 'other' });
    for (const id of ids.slice(0, 3)) assert.equal((await legacy.tool(owner, 'claim', { request_id: id, claimant: 'dot' })).ok, true);
    assert.equal((await legacy.tool(owner, 'claim', { request_id: ids[3], claimant: 'dot' })).error, 'capacity_full');
    const second = await legacy.tool(other, 'claim', { request_id: ids[3], claimant: 'dot' });
    assert.equal(second.ok, true, `second subject was refused: ${second.error}`);
  } finally { await legacy.stop(); }
});

await check('a worker removed from workers.json keeps no webhook after a restart (HTTP)', async () => {
  const { parseWorkers } = await workersModule();
  const gone = JSON.parse(JSON.stringify(profileJson).replaceAll(ISS, issuer));
  const dotOnly = { workers: { dot: gone.workers.dot } };
  const removed = await startServer('removed', dotOnly, { prepare: home => {
    const dir = path.join(home, '.local/share/dot-bridge'); fs.mkdirSync(dir, { recursive: true });
    const before = new Store(path.join(dir, 'bridge.db'), { workers: parseWorkers(gone) });
    before.subscribe('sub_removed', `http://127.0.0.1:${hookServer.address().port}/removed`, `whsec_${randomBytes(32).toString('base64')}`, new Date(Date.now() + hours(48)).toISOString(), 'owner', 'lark');
    before.submit(assignment(rid('m')), { mode: 'none' }, null, 'owner-token', false, null, 'normal', null, undefined, null, 'lark');
    before.db.close();
  } });
  try {
    assert.notEqual(removed.port, null, removed.stderr);
    await sleep(2500);
    assert.deepEqual(hooks.filter(h => h.sub === 'sub_removed'), [], 'a removed worker\'s webhook was called');
    assert.equal(dbRead(removed, "SELECT state FROM subscriptions WHERE id='sub_removed'")[0].state, 'revoked');
  } finally { await removed.stop(); }
});

await check('old-build ID-only artifact UPDATE and DELETE each affect one request when live worker uploads reuse an alias',async()=>{
  const server=await startServer('ids',liveProfile),rows=[],alias=`art_${randomUUID()}`;
  try {
    for(const text of ['first','second']) {
      const request=rid('sql');assert.equal(server.submit(request,'dot').code,0);
      const claim=(await server.tool(T.dot,'claim',{request_id:request,claimant:'dot'})).value;assert.ok(claim);
      const bytes=Buffer.from(text),sha256=createHash('sha256').update(bytes).digest('hex');
      assert.equal((await server.tool(T.dot,'artifact_chunk',{request_id:request,claim_id:claim.claim_id,artifact_id:alias,offset:0,data_base64:bytes.toString('base64'),final:true,sha256})).ok,true);
      rows.push({request,id:dbRead(server,'SELECT id FROM artifacts WHERE request_id=?',request)[0].id,size:bytes.length});
    }
    await server.stop();const db=new DatabaseSync(server.dbPath);
    try {
      const updated=db.prepare('UPDATE artifacts SET size=size+1 WHERE id=?').run(rows[0].id).changes;
      const sibling=db.prepare('SELECT size FROM artifacts WHERE request_id=?').get(rows[1].request)?.size;
      const deleted=db.prepare('DELETE FROM artifacts WHERE id=?').run(rows[0].id).changes;
      const remaining=db.prepare('SELECT count(*) n FROM artifacts WHERE request_id=?').get(rows[1].request).n;
      assert.deepEqual({updated,sibling,deleted,remaining},{updated:1,sibling:rows[1].size,deleted:1,remaining:1});
    } finally {db.close();}
  } finally {await server.stop();}
});

await check('CLI cache selects each global artifact unambiguously after two requests reuse one upload alias',async()=>{
  const server=await startServer('cli',liveProfile);
  try {
    assert.notEqual(server.port,null,server.stderr);
    const alias=`art_${randomUUID()}`,rows=[];
    for(const text of ['first request bytes','second request bytes']) {
      const request=rid('cache');assert.equal(server.submit(request,'dot').code,0);
      const held=(await server.tool(T.dot,'claim',{request_id:request,claimant:'dot'})).value;assert.ok(held);
      const bytes=Buffer.from(text),digest=createHash('sha256').update(bytes).digest('hex');
      const upload=await server.tool(T.dot,'artifact_chunk',{request_id:request,claim_id:held.claim_id,artifact_id:alias,offset:0,data_base64:bytes.toString('base64'),final:true,sha256:digest});assert.equal(upload.ok,true,upload.error);
      assert.equal((await server.tool(T.dot,'finish',{request_id:request,claim_id:held.claim_id,outcome:'completed',summary:'done',result:'done',artifact_ids:[alias]})).ok,true);
      const get=server.cli(['get',request,'--json']);assert.equal(get.code,0,get.stderr);
      rows.push({request,id:JSON.parse(get.stdout).artifacts[0].id,bytes});
    }
    // Both get calls have populated the cache. Each saved global ID must still select its own request and bytes.
    for(const row of rows) {
      const out=path.join(root,`cache-${row.request}`),got=server.cli(['artifact',row.id,'--output',out,'--json']);
      assert.equal(got.code,0,got.stderr);assert.deepEqual(fs.readFileSync(out),row.bytes);
    }
  } finally {await server.stop();}
});

await check('HTTP mixed-scope list, claim and late-finish hints have no phantom lane or skip evidence',async()=>{
  let server=await startServer('mixed-scope-hints',null,{prepare:home=>fs.writeFileSync(path.join(home,'.config/dot-bridge/limits.json'),JSON.stringify({max_claimed_outer_assignments:2}))});
  try {
    const [r1,r2,r3,waiting]=Array.from({length:4},()=>rid('mixed-hint'));
    for(const request of [r1,r2,r3,waiting]) assert.equal(server.submit(request,'dot').code,0);
    const first=await server.tool(T.dot,'claim',{request_id:r1,claimant:'dot'});assert.equal(first.ok,true,first.error);
    assert.equal((await server.tool(T.dot,'claim',{request_id:r2,claimant:'dot'})).ok,true);
    await server.stop();
    // Seed old eligibility while stopped, so test setup never races the delivery writer.
    const db=new DatabaseSync(server.dbPath);
    try {db.prepare('UPDATE assignments SET eligible_since=? WHERE request_id=?').run(new Date(Date.now()-11*60000).toISOString(),waiting);} finally {db.close();}
    fs.writeFileSync(path.join(server.home,'.config/dot-bridge/workers.json'),JSON.stringify(liveProfile),{mode:0o600});
    server=await startServer('mixed-scope-hints',null,{reuse:true});assert.notEqual(server.port,null,server.stderr);
    assert.equal(server.cli(['abandon',r2,'--reason','mixed-scope test']).code,0);
    const claimed=await server.tool(T.dot,'claim',{request_id:r3,claimant:'dot'});assert.equal(claimed.ok,true,claimed.error);
    assert.equal(claimed.value.free_lanes,0);assert.equal(claimed.value.next_action,undefined);assert.equal(claimed.value.next_queued,undefined);
    const listed=await server.tool(T.dot,'list_pending');assert.equal(listed.ok,true,listed.error);assert.equal(listed.value.free_lanes,0);
    const markers=dbRead(server,'SELECT eligible_since,skipped_at FROM assignments WHERE request_id=?',waiting)[0];
    assert.equal(markers.eligible_since,null);assert.equal(markers.skipped_at,null);
    assert.equal((await server.tool(T.dot,'claim',{request_id:waiting,claimant:'dot'})).error,'capacity_full');
    // A late finish frees no lane: cancel one legacy claim, refill it, then finish that cancelled claim.
    assert.equal(server.cli(['cancel',r1]).code,0);
    const prior=dbRead(server,'SELECT last_claim_activity_at FROM claims WHERE request_id=?',r2)[0];
    const tooEarly=await server.tool(T.dot,'claim',{request_id:r2,claimant:'dot'});
    assert.match(tooEarly.error,/claim_busy: prior lease has not expired/,'a live abandoned lease was reclaimed early');
    assert.equal(dbRead(server,'SELECT last_claim_activity_at FROM claims WHERE request_id=?',r2)[0].last_claim_activity_at,prior.last_claim_activity_at,'early regrant changed its lease');
    await server.stop();
    const deadlineDb=new DatabaseSync(server.dbPath);
    try {deadlineDb.prepare('UPDATE claims SET last_claim_activity_at=?,lease_deadline_at=?,lease_boot_id=NULL,lease_deadline_monotonic_ms=NULL WHERE request_id=?').run(new Date(Date.now()-3600001).toISOString(),new Date(Date.now()-1).toISOString(),r2);} finally {deadlineDb.close();}
    server=await startServer('mixed-scope-hints',null,{reuse:true});assert.notEqual(server.port,null,server.stderr);
    const refilled=await server.tool(T.dot,'claim',{request_id:r2,claimant:'dot'});assert.equal(refilled.ok,true,refilled.error);assert.equal(refilled.value.free_lanes,0);
    const finished=await server.tool(T.dot,'finish',{request_id:r1,claim_id:first.value.claim_id,outcome:'completed',summary:'late',result:'late'});
    assert.equal(finished.ok,false);assert.match(finished.error,/assignment_cancelled/);
    assert.equal((await server.tool(T.dot,'list_pending')).value.free_lanes,0);
  } finally {await server.stop();}
});

await check('HTTP worker client rotation restores wakes with the stable ID; legacy subscription ID is unchanged',async()=>{
  let server=await startServer('client-rotation',liveProfile);
  const params={name:'assignment.available',arguments:{},delivery:{mode:'webhook',url:`http://127.0.0.1:${hookServer.address().port}/rotation`,secret:`whsec_${randomBytes(32).toString('base64')}`}};
  try {
    const first=(await server.rpc(T.dot,'events/subscribe',params)).body.result.id;
    await server.stop();
    const changed=structuredClone(liveProfile);changed.workers.dot.connections[0].client_id='client-dot-new';
    fs.writeFileSync(path.join(server.home,'.config/dot-bridge/workers.json'),JSON.stringify(changed));
    server=await startServer('client-rotation',null,{reuse:true});assert.notEqual(server.port,null,server.stderr);
    const response=await server.rpc(token('client-dot-new'),'events/subscribe',params);
    assert.equal(response.body.result.id,first);
    assert.equal((await readSubscriptionConnection(server, first)).client_id,'client-dot-new');
    assert.equal((await server.rpc(T.dot,'events/subscribe',params)).status,403);
    const request=rid('rotated-http');assert.equal(server.submit(request,'dot').code,0);
    for(let i=0;i<100&&!hooks.some(h=>h.sub===first&&h.request_id===request);i++) await sleep(50);
    assert.ok(hooks.some(h=>h.sub===first&&h.request_id===request),'rotated client received no wake');
  } finally {await server.stop();}
  const legacy=await startServer('legacy-sub-id',null);
  try {
    const response=await legacy.rpc(T.dot,'events/subscribe',params);
    const expected='sub_'+createHash('sha256').update(`owner\0${params.delivery.url}\0assignment.available\0{}`).digest('hex').slice(0,32);
    assert.equal(response.body.result.id,expected);
  } finally {await legacy.stop();}
});

await check('HTTP restart after deleting workers.json keeps usage and claim attribution unchanged',async()=>{
  let server=await startServer('pf',liveProfile);
  try {
    assert.notEqual(server.port,null,server.stderr);
    for(const worker of ['dot','lark']) {
      const request=rid('history');assert.equal(server.submit(request,worker).code,0);
      assert.equal((await server.tool(T[worker],'claim',{request_id:request,claimant:worker})).ok,true);
    }
    const usage=s=>{const status=JSON.parse(s.cli(['status','--json']).stdout);return [status.throttle.claims_last_hour,status.throttle.tool_calls_last_hour,status.throttle.response_bytes_last_hour];};
    const before=usage(server),claims=dbRead(server,'SELECT request_id,worker,subject FROM claims ORDER BY request_id');
    await server.stop();fs.rmSync(path.join(server.home,'.config/dot-bridge/workers.json'));
    server=await startServer('pf',null,{reuse:true,envOverrides:{DOT_BRIDGE_LEGACY_PROFILE:'1'}});assert.notEqual(server.port,null,server.stderr);
    assert.deepEqual(usage(server),before);assert.deepEqual(dbRead(server,'SELECT request_id,worker,subject FROM claims ORDER BY request_id'),claims);
    assert.equal(usage(server)[0],1,'profile deletion reclassified the lark claim as worker');
  } finally {await server.stop();}
});

await check('an external OAuth host refuses a missing profile after one has been loaded', async () => {
  let host = await startServer('profile-missing', liveProfile);
  const request = rid('missing-profile');
  const unmapped = token('client-stranger');
  try {
    assert.notEqual(host.port, null, host.stderr);
    assert.equal(host.submit(request, 'dot').code, 0);
    assert.equal((await host.rpc(unmapped, 'tools/list')).status, 403);
    await host.stop();
    fs.rmSync(path.join(host.home, '.config/dot-bridge/workers.json'));
    host = await startServer('profile-missing', null, { reuse: true });
    if (host.port !== null) {
      const fallback = await host.tool(unmapped, 'list_pending');
      assert.equal(fallback.ok, true, 'the unmapped token did not reproduce legacy worker resolution');
      assert.ok(fallback.value.assignments.some(row => row.request_id === request), 'the unmapped token did not see the worker assignment');
    }
    assert.equal(host.port, null, 'a previously profiled host must refuse a missing workers.json');
    assert.match(host.stderr, /workers\.json.*DALAN_LEGACY_PROFILE=1/);
    assert.equal(host.exited, 1);
  } finally { await host.stop(); }
});

await check('a fresh external OAuth host with no profile still starts as the legacy worker', async () => {
  const host = await startServer('fresh-legacy', null);
  const request = rid('fresh-legacy');
  try {
    assert.notEqual(host.port, null, host.stderr);
    assert.equal(host.submit(request, null).code, 0);
    const listed = await host.tool(token('client-stranger'), 'list_pending');
    assert.equal(listed.ok, true, 'fresh legacy host refused its established fallback');
    assert.ok(listed.value.assignments.some(row => row.request_id === request));
  } finally { await host.stop(); }
});

await check('DOT_BRIDGE_LEGACY_PROFILE=1 explicitly permits legacy mode after profile removal', async () => {
  let host = await startServer('legacy-override', liveProfile);
  const request = rid('legacy-override');
  try {
    assert.notEqual(host.port, null, host.stderr);
    assert.equal(host.submit(request, 'dot').code, 0);
    await host.stop();
    fs.rmSync(path.join(host.home, '.config/dot-bridge/workers.json'));
    host = await startServer('legacy-override', null, { reuse: true, envOverrides: { DOT_BRIDGE_LEGACY_PROFILE: '1' } });
    assert.notEqual(host.port, null, host.stderr);
    const listed = await host.tool(token('client-stranger'), 'list_pending');
    assert.equal(listed.ok, true, 'explicit legacy flag did not restore the fallback');
    assert.ok(listed.value.assignments.some(row => row.request_id === request));
  } finally { await host.stop(); }
});

// ---------------------------------------------------------------- Part 3: upgrade and rollback against a database written by the base commit
function schemaFixture(revision) {
  const dir=path.join(repo,'src/test-support/worker-history'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  const bytes=fs.readFileSync(path.join(dir,`${revision}.sql`));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest[revision].sha256,'historical fixture digest');
  return bytes;
}
async function baseStore(revision=BASE_COMMIT) {
  const dir = path.join(root, `src-${revision}`);
  fs.mkdirSync(dir, { recursive: true });
  const archive=readPrepublicFixture(historyArchive(revision));
  const unpack = spawnSync('tar', ['-xz', '-C', dir], { input: archive });
  if (unpack.status !== 0) throw new Error('cannot unpack the base source');
  return (await import(pathToFileURL(path.join(dir, 'src/store.mjs')).href)).Store;
}
const legacySubId = url => 'sub_' + createHash('sha256').update(`owner\0${url}\0assignment.available\0{}`).digest('hex').slice(0, 32);
const dotProfile = client_id => ({ workers: { dot: { connections: [{ issuer, subject: 'owner', client_id }], capabilities: ['t3'] } } });
async function seedHistoricalExternalSubscription(home, { label, url, paused = false, markProfileSeen = false }) {
  const file = path.join(home, '.local/share/dot-bridge/bridge.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const OldStore = await baseStore(), old = new OldStore(file), requestId = rid(label), subscriptionId = legacySubId(url);
  const secret = `whsec_${randomBytes(32).toString('base64')}`;
  old.subscribe(subscriptionId, url, secret, new Date(Date.now() + hours(48)).toISOString(), 'owner');
  if (paused) old.setPause('hold historical subscription during test');
  old.submit(assignment(requestId, `historical callback ${label}`), { mode: 'none' }, null, 'owner-token');
  assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 34, 'fixture must be the real pre-isolation schema');
  assert.equal(old.db.prepare("SELECT 1 FROM pragma_table_info('subscriptions') WHERE name='connection'").get(), undefined, 'pre-isolation external rows have no connection field');
  old.db.close();
  if (markProfileSeen) {
    const { LEGACY_PROFILE } = await workersModule();
    const migrated = new Store(file, { workers: LEGACY_PROFILE, markProfileModeSeen: true, deferSubscriptionRetirement: true });
    migrated.db.close();
  }
  return { file, requestId, subscriptionId, secret };
}
async function waitForDelivery(host, subscriptionId, requestId, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const row = dbRead(host, 'SELECT state FROM notifications WHERE subscription_id=? AND request_id=?', subscriptionId, requestId)[0];
    if (row?.state === 'delivered') return true;
    await sleep(50);
  }
  return false;
}

await historicalCheck('profile_migrated_old_callback_is_retired',[BASE_COMMIT], async () => {
  const url = `http://127.0.0.1:${hookServer.address().port}/legacy-old-client`;
  let seeded;
  const host = await startServer('profile-retire-null', dotProfile('client-dot-new'), {
    prepare: async home => { seeded = await seedHistoricalExternalSubscription(home, { label: 'profile-retire', url }); }
  });
  try {
    assert.notEqual(host.port, null, host.stderr);
    await sleep(1200);
    assert.deepEqual(dbRead(host, 'SELECT state,attempts FROM notifications WHERE subscription_id=?', seeded.subscriptionId).map(row => ({ ...row })), [{ state: 'suppressed', attempts: 0 }], 'pre-isolation wake must be suppressed before an attempt');
    assert.deepEqual(dbRead(host, 'SELECT worker,connection,state FROM subscriptions WHERE id=?', seeded.subscriptionId).map(row => ({ ...row })), [{ worker: 'dot', connection: null, state: 'revoked' }]);
    assert.equal(hooks.some(hook => hook.sub === seeded.subscriptionId && hook.request_id), false, 'old callback URL received a wake');
  } finally { await host.stop(); }
});

await historicalCheck('approved_legacy_connector_resubscribes_and_delivery_resumes',[BASE_COMMIT], async () => {
  const url = `http://127.0.0.1:${hookServer.address().port}/approved-old-client`;
  let seeded;
  const host = await startServer('profile-resubscribe', dotProfile('client-dot-old'), {
    prepare: async home => { seeded = await seedHistoricalExternalSubscription(home, { label: 'profile-resubscribe', url }); }
  });
  try {
    assert.notEqual(host.port, null, host.stderr);
    assert.deepEqual(dbRead(host, 'SELECT worker,connection,state FROM subscriptions WHERE id=?', seeded.subscriptionId).map(row => ({ ...row })), [{ worker: 'dot', connection: null, state: 'revoked' }], 'startup must retire the pre-profile row before re-subscribe');
    assert.deepEqual(dbRead(host, 'SELECT state,attempts FROM notifications WHERE subscription_id=?', seeded.subscriptionId).map(row => ({ ...row })), [{ state: 'suppressed', attempts: 0 }]);
    const params = { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url, secret: seeded.secret } };
    const response = await host.rpc(token('client-dot-old'), 'events/subscribe', params);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.result.id, seeded.subscriptionId);
    assert.equal(await waitForDelivery(host, seeded.subscriptionId, seeded.requestId), true, 'verified re-subscribe did not resume queued delivery');
    const connection = await readSubscriptionConnection(host, seeded.subscriptionId);
    assert.equal(connection.client_id, 'client-dot-old', 're-subscribe did not persist the approved connection');
  } finally { await host.stop(); }
});

await historicalCheck('fresh_legacy_profile_delivers_legacy_callback',[BASE_COMMIT], async () => {
  const url = `http://127.0.0.1:${hookServer.address().port}/legacy-never-profiled`;
  let seeded;
  const host = await startServer('legacy-never-profiled', null, {
    prepare: async home => { seeded = await seedHistoricalExternalSubscription(home, { label: 'legacy-never-profiled', url }); }
  });
  try {
    assert.notEqual(host.port, null, host.stderr);
    assert.deepEqual(dbRead(host, 'SELECT worker,connection,state FROM subscriptions WHERE id=?', seeded.subscriptionId).map(row => ({ ...row })), [{ worker: 'dot', connection: null, state: 'active' }]);
    assert.equal(await waitForDelivery(host, seeded.subscriptionId, seeded.requestId), true, 'legacy subscription stopped delivering');
    assert.deepEqual(dbRead(host, 'SELECT state,attempts FROM notifications WHERE subscription_id=?', seeded.subscriptionId).map(row => ({ ...row })), [{ state: 'delivered', attempts: 1 }]);
  } finally { await host.stop(); }
});

await historicalCheck('legacy_override_delivers_after_profile_seen',[BASE_COMMIT], async () => {
  const url = `http://127.0.0.1:${hookServer.address().port}/legacy-explicit-override`;
  let seeded;
  const host = await startServer('legacy-explicit-override', null, {
    prepare: async home => { seeded = await seedHistoricalExternalSubscription(home, { label: 'legacy-override', url, markProfileSeen: true }); },
    envOverrides: { DOT_BRIDGE_LEGACY_PROFILE: '1' }
  });
  try {
    assert.notEqual(host.port, null, host.stderr);
    assert.deepEqual(dbRead(host, 'SELECT worker,connection,state FROM subscriptions WHERE id=?', seeded.subscriptionId).map(row => ({ ...row })), [{ worker: 'dot', connection: null, state: 'active' }]);
    assert.equal(await waitForDelivery(host, seeded.subscriptionId, seeded.requestId), true, 'explicit legacy mode stopped delivering');
    assert.deepEqual(dbRead(host, 'SELECT state,attempts FROM notifications WHERE subscription_id=?', seeded.subscriptionId).map(row => ({ ...row })), [{ state: 'delivered', attempts: 1 }]);
  } finally { await host.stop(); }
});

await historicalCheck('legacy_callback_is_retired_after_resubscribe_client_replacement',[BASE_COMMIT], async () => {
  const oldUrl = `http://127.0.0.1:${hookServer.address().port}/replaced-old-callback`;
  const newUrl = `http://127.0.0.1:${hookServer.address().port}/replaced-new-callback`;
  let seeded, host = await startServer('profile-client-replaced', dotProfile('client-dot-current'), {
    prepare: async home => { seeded = await seedHistoricalExternalSubscription(home, { label: 'client-replaced', url: oldUrl, paused: true }); }
  });
  try {
    assert.notEqual(host.port, null, host.stderr);
    const replacementParams = { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: newUrl, secret: `whsec_${randomBytes(32).toString('base64')}` } };
    const response = await host.rpc(token('client-dot-current'), 'events/subscribe', replacementParams);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const replacementId = response.body.result.id;
    assert.notEqual(replacementId, seeded.subscriptionId, 'callback URL change must create a separate subscription identity');
    assert.equal((await readSubscriptionConnection(host, replacementId)).client_id, 'client-dot-current');
    await host.stop();

    fs.writeFileSync(path.join(host.home, '.config/dot-bridge/workers.json'), JSON.stringify(dotProfile('client-dot-replacement')));
    host = await startServer('profile-client-replaced', null, { reuse: true });
    assert.notEqual(host.port, null, host.stderr);
    assert.deepEqual(dbRead(host, 'SELECT id,state FROM subscriptions WHERE id IN (?,?) ORDER BY id', seeded.subscriptionId, replacementId).map(row => ({ ...row })), [
      { id: replacementId, state: 'revoked' },
      { id: seeded.subscriptionId, state: 'revoked' }
    ].sort((a, b) => a.id.localeCompare(b.id)), 'replaced client left a callback active');
    assert.deepEqual(dbRead(host, 'SELECT subscription_id,state,attempts FROM notifications WHERE subscription_id IN (?,?) ORDER BY subscription_id', seeded.subscriptionId, replacementId).map(row => ({ ...row })), [
      { subscription_id: replacementId, state: 'suppressed', attempts: 0 },
      { subscription_id: seeded.subscriptionId, state: 'suppressed', attempts: 0 }
    ].sort((a, b) => a.subscription_id.localeCompare(b.subscription_id)));
    assert.equal(hooks.some(hook => [seeded.subscriptionId, replacementId].includes(hook.sub) && hook.request_id), false, 'replaced callbacks received a wake');
  } finally { await host.stop(); }
});

await check('migration identity is durable from a synthesized schema 34; abandoned 5697c20 and 48f1a26 schemas are refused with backup recovery',async()=>{
  for(const revision of ['5697c20','48f1a26']) {
    const file=path.join(root,`rejected-${revision}.db`),db=new DatabaseSync(file);
    db.exec(schemaFixture(revision).toString());db.close();
    assert.throws(()=>new Store(file),/abandoned worker-isolation schema.*restore the pre-isolation backup/);
  }
  const file=path.join(root,'identity-synthesized.db'),old=new Store(file);preWorkerFixture(old);
  assert.equal(old.db.prepare('PRAGMA user_version').get().user_version,34);old.db.close();
  const next=new Store(file);assert.equal(next.db.prepare('PRAGMA user_version').get().user_version,66);
  assert.equal(next.db.prepare('SELECT identity FROM schema_migrations').get().identity,'s1v2-worker-facts-20261022');next.db.close();
});

await historicalCheck('migration identity is durable from the pre-public base release',[BASE_COMMIT],async()=>{
  const Old=await baseStore(),file=path.join(root,'identity.db');new Old(file).db.close();
  const next=new Store(file);assert.equal(next.db.prepare('PRAGMA user_version').get().user_version,66);
  assert.equal(next.db.prepare('SELECT identity FROM schema_migrations').get().identity,'s1v2-worker-facts-20261022');next.db.close();
});

await check('an identified review-build version 35 DB drops the obsolete subscription lane on open',async()=>{
  const file=path.join(root,'review-v35.db'),old=new Store(file);
  old.db.exec("ALTER TABLE subscriptions ADD COLUMN lane_key TEXT NOT NULL DEFAULT 'old-lane'; CREATE TRIGGER subscriptions_lane_key_immutable BEFORE UPDATE OF lane_key ON subscriptions BEGIN SELECT RAISE(ABORT,'immutable'); END;");old.db.close();
  const next=new Store(file);
  assert.equal(next.db.prepare('PRAGMA user_version').get().user_version,66);
  assert.equal(next.db.prepare("SELECT 1 FROM pragma_table_info('subscriptions') WHERE name='lane_key'").get(),undefined);next.db.close();
});

await historicalCheck('migration marks unsupported base subjects unknown and denies their live claims and subscriptions',[BASE_COMMIT],async()=>{
  const Old=await baseStore(),file=path.join(root,'unknown.db'),old=new Old(file);
  const id=rid('unknown');old.submit(assignment(id),{mode:'none'},null,'owner');
  const claim=old.claim(id,'somebody','not-allowed',6);
  old.subscribe('sub_untrusted','http://127.0.0.1/no','whsec_test',new Date(Date.now()+hours(48)).toISOString(),'not-allowed');
  old.recordWorkerCall('not-allowed','get');old.db.close();
  const next=new Store(file,{allowedDotSubjects:['owner']});
  assert.equal(next.db.prepare('SELECT worker FROM claims').get().worker,'unknown');
  assert.deepEqual({...next.db.prepare('SELECT worker,state FROM subscriptions').get()},{worker:'unknown',state:'revoked'});
  assert.equal(next.db.prepare('SELECT worker FROM lifecycle_events WHERE claim_id=? LIMIT 1').get(claim.claim_id).worker,'unknown');
  assert.throws(()=>next.progress(id,claim.claim_id,'not mine','not-allowed'),/invalid claim/);
  assert.equal(next.rollingUsage().claims_last_hour,0);assert.equal(next.rollingUsage().tool_calls_last_hour,0);next.db.close();
});

await historicalCheck('v0.2.0 live claim survives upgrade to schema 66',['v0.2.0'], async () => {
  const OldStore = await baseStore('v0.2.0');
  const file = path.join(root, 'upgrade-020-live-claim.db');
  const now = Date.parse('2026-11-01T00:00:00Z');
  const options = { now: () => now, allowDefaultHomeMigration: true };
  const inFlight = 'upgrade-020-in-flight', queued = 'upgrade-020-queued';
  const subject = 'upgrade-subject';
  let old, current;
  const rows = (db, table) => db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map(row => ({ ...row }));
  const snapshot = db => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    schema: db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row })),
    assignments: rows(db, 'assignments'),
    claims: rows(db, 'claims'),
    progress: rows(db, 'progress'),
    reports: rows(db, 'reports'),
    lifecycle: rows(db, 'lifecycle_events'),
  });
  try {
    old = new OldStore(file, options);
    assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 49);
    old.submit(assignment(inFlight), { mode: 'none' }, null, 'owner');
    old.submit(assignment(queued), { mode: 'none' }, null, 'owner');
    const claim = old.claim(inFlight, 'dot', subject, 6);
    old.progress(inFlight, claim.claim_id, 'recorded by v0.2.0', subject);
    const before = old.get(inFlight);
    assert.equal(before.claim.state, 'active');
    assert.equal(old.get(queued).status, 'queued');
    old.db.close(); old = null;

    current = new Store(file, options);
    assert.equal(current.db.prepare('PRAGMA user_version').get().user_version,66);
    const migrated = current.get(inFlight);
    assert.equal(migrated.status, 'claimed');
    assert.equal(migrated.claim.state, 'active');
    assert.equal(migrated.claim.claim_id, before.claim.claim_id);
    assert.equal(migrated.claim.epoch, before.claim.epoch);
    assert.deepEqual(migrated.progress, before.progress);
    assert.equal(current.get(queued).status, 'queued');
    current.finish(inFlight, claim.claim_id, 'completed', 'finished after upgrade', 'result from old claim', subject);
    const finished = current.get(inFlight);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.report.claim_id, claim.claim_id);
    assert.equal(finished.report.outcome, 'completed');
    assert.equal(finished.report.summary, 'finished after upgrade');
    assert.equal(finished.report.result, 'result from old claim');
    const queuedClaim = current.claim(queued, 'dot', subject, 6);
    assert.ok(queuedClaim.claim_id);
    assert.equal(current.get(queued).claim.state, 'active');
    assert.equal(current.get(queued).claim.claim_id, queuedClaim.claim_id);
    const settled = snapshot(current.db);
    current.db.close(); current = null;

    current = new Store(file, options);
    assert.deepEqual(snapshot(current.db), settled, 'second open changed upgrade/claim/report/progress state');
    current.db.close(); current = null;
    assert.throws(() => new OldStore(file, options),
      /database schema version 66 is newer than supported version 49/);
    current = new Store(file, options);
    assert.deepEqual(snapshot(current.db), settled, 'old-version refusal changed upgraded state');
  } finally {
    old?.db.close();
    current?.db.close();
  }
});

await historicalCheck('upgrade: a live claim and an unsealed upload written by the base code continue unchanged; target_worker is the legacy default',[BASE_COMMIT], async () => {
  const OldStore = await baseStore(), file = path.join(root, 'upgrade.db');
  const old = new OldStore(file), id = rid('live'), queued = rid('queued');
  old.submit(assignment(id), { mode: 'none' }, null, 'owner-token'); old.submit(assignment(queued), { mode: 'none' }, null, 'owner-token');
  const claim = old.claim(id, 'dot', 'owner', 6);
  old.progress(id, claim.claim_id, 'before the upgrade', 'owner');
  const upload = `art_${randomUUID()}`, uploadFile = path.join(root, `${upload}.bin`);
  fs.writeFileSync(uploadFile, 'partial');
  old.db.prepare("INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sha256,sealed,created_at) VALUES(?,?,?,'upload',?,7,NULL,0,?)").run(upload, id, claim.claim_id, uploadFile, old.stamp());
  const oldHash = old.db.prepare('SELECT payload,payload_hash FROM assignments WHERE request_id=?').get(id);
  old.db.close();

  const next = new Store(file, { now: () => Date.now(), capacity: 6, allowedDotSubjects:['owner'] });
  const row = next.db.prepare('SELECT target_worker,payload,payload_hash FROM assignments WHERE request_id=?').get(id);
  assert.equal(row.target_worker, 'dot'); assert.equal(next.db.prepare('SELECT target_worker t FROM assignments WHERE request_id=?').get(queued).t, 'dot');
  assert.equal(row.payload, oldHash.payload); assert.equal(row.payload_hash, oldHash.payload_hash, 'migration touched payload identity');
  const migratedClaim = () => next.db.prepare('SELECT claim_id,epoch,state,worker,subject,acquisition_id FROM claims WHERE request_id=?').get(id);
  const live = migratedClaim();
  assert.deepEqual({ ...live }, { claim_id: claim.claim_id, epoch: 1, state: 'active', worker: 'dot', subject: 'owner', acquisition_id: null });
  assert.equal(next.claim(id, 'dot', 'owner', 6, null, 'dot').claim_id, claim.claim_id, 'unkeyed retry keeps the migrated grant');
  assert.throws(() => next.claim(id, 'dot', 'owner', 6, null, 'dot', 'newly-supplied-run'), /"error":"claim_busy"/, 'a supplied nonce must not be adopted by a historical claim');
  assert.deepEqual(migratedClaim(),live,'refused reacquisition changed historical claim identity');
  assert.equal(next.progress(id, claim.claim_id, 'after the upgrade', 'owner', false, 'dot').recorded, true);
  assert.equal(migratedClaim().acquisition_id,null,'known-ID progress synthesized historical acquisition identity');
  const art = next.db.prepare('SELECT claim_id,sealed,size FROM artifacts WHERE id=?').get(upload);
  assert.deepEqual({ ...art }, { claim_id: claim.claim_id, sealed: 0, size: 7 });
  assert.equal(next.finish(id, claim.claim_id, 'completed', 's', 'r', 'owner', null, 'dot').duplicate, false);
  assert.equal(migratedClaim().acquisition_id,null,'known-ID finish synthesized historical acquisition identity');
  assert.equal(next.db.prepare('SELECT worker FROM reports WHERE request_id=?').get(id).worker, 'dot');
  assert.deepEqual(next.listPending('dot').map(x => x.request_id), [queued]);
  assert.equal(next.submit(assignment(queued), { mode: 'none' }, null, 'owner-token', false, null, 'normal', null, assignment(queued), null, 'dot').duplicate, true, 'an old row is a retry for worker dot');
  assert.throws(() => next.submit(assignment(queued), { mode: 'none' }, null, 'owner-token', false, null, 'normal', null, assignment(queued), null, 'lark'), /request_id conflict/);
  next.db.close();
});

await historicalCheck('payload and payload_hash for the same submission are byte-identical to the base code, with and without a target',[BASE_COMMIT], async () => {
  const OldStore = await baseStore(), id = rid('same');
  const old = new OldStore(path.join(root, 'same-old.db')), next = new Store(path.join(root, 'same-new.db'));
  old.submit(assignment(id), { mode: 'none' }, null, 'owner-token'); next.submit(assignment(id), { mode: 'none' }, null, 'owner-token', false, null, 'normal', null, assignment(id), null, 'lark');
  const pick = s => s.db.prepare('SELECT payload,payload_hash FROM assignments WHERE request_id=?').get(id);
  assert.deepEqual({ ...pick(next) }, { ...pick(old) });
  old.db.close(); next.db.close();
});

await historicalCheck('upgrade through the real server: an in-flight upload continues under its existing claim_id and finish records the worker',[BASE_COMMIT], async () => {
  const OldStore = await baseStore(), id = rid('inflight'), art = `art_${randomUUID()}`, head = Buffer.from('partial-'), tail = Buffer.from('rest-of-it');
  let claimId = null;
  const live = await startServer('upgrade-live', null, { prepare: home => {
    const dir = path.join(home, '.local/share/dot-bridge'), artifactDir = path.join(home, 'work/artifacts');
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(artifactDir, { recursive: true });
    const old = new OldStore(path.join(dir, 'bridge.db'));
    old.submit(assignment(id), { mode: 'none' }, null, 'owner-token');
    claimId = old.claim(id, 'dot', 'owner', 6).claim_id;
    fs.writeFileSync(path.join(artifactDir, art), head);
    old.db.prepare("INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sha256,sealed,created_at) VALUES(?,?,?,'upload',?,?,NULL,0,?)").run(art, id, claimId, path.join(artifactDir, art), head.length, old.stamp());
    old.db.close();
  } });
  try {
    assert.notEqual(live.port, null, live.stderr);
    const bearer = token('whatever-client');
    const migratedClaim = () => dbRead(live, 'SELECT claim_id,epoch,acquisition_id FROM claims WHERE request_id=?', id).map(row => ({ ...row }));
    const historical = [{ claim_id: claimId, epoch: 1, acquisition_id: null }];
    assert.deepEqual(migratedClaim(),historical,'migration invented a historical acquisition identity');
    const reacquire = await live.tool(bearer, 'claim', { request_id: id, claimant: 'dot' });
    assert.equal(reacquire.ok, true, reacquire.error); assert.equal(reacquire.value.claim_id, claimId);
    const supplied = await live.tool(bearer, 'claim', { request_id: id, claimant: 'dot', acquisition_id: 'newly-supplied-run' });
    assert.match(supplied.error ?? '', /"error":"claim_busy"/, 'a supplied nonce must not be adopted by a historical claim');
    assert.deepEqual(migratedClaim(),historical,'refused reacquisition changed historical claim identity');
    const whole = Buffer.concat([head, tail]);
    const done = await live.tool(bearer, 'artifact_chunk', { request_id: id, claim_id: claimId, artifact_id: art, offset: head.length, data_base64: tail.toString('base64'), final: true, sha256: createHash('sha256').update(whole).digest('hex') });
    assert.equal(done.ok, true, done.error); assert.equal(done.value.sealed, true);
    assert.deepEqual(migratedClaim(),historical,'known-ID upload changed historical claim identity');
    const finished = await live.tool(bearer, 'finish', { request_id: id, claim_id: claimId, outcome: 'completed', summary: 's', result: 'r', artifact_ids: [art] });
    assert.equal(finished.ok, true, finished.error);
    assert.deepEqual(migratedClaim(),historical,'known-ID finish changed historical claim identity');
    assert.deepEqual(dbRead(live, 'SELECT r.worker worker,c.claim_id claim_id FROM reports r JOIN claims c USING(request_id) WHERE request_id=?', id).map(r => ({ ...r })), [{ worker: 'dot', claim_id: claimId }]);
    assert.equal(dbRead(live, 'SELECT target_worker t FROM assignments WHERE request_id=?', id)[0].t, 'dot');
  } finally { await live.stop(); }
});

await check('documented pre-upgrade and rollback backups and restore work without workers.json',async()=>{
  const doc=fs.readFileSync(path.join(repo,'docs/operations.md'),'utf8');
  const block=marker=>/```(?:sh|sql)\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf(`<!-- ${marker} -->`)))[1];
  for(const productRoot of ['dot-bridge','dalan']) for(const withAck of [false,true]) {
  const home=path.join(root,productRoot+(withAck?'-backup-with-acks':'-legacy-backup')),artifacts=path.join(home,'work/artifacts'),dbFile=path.join(home,`.local/share/${productRoot}/bridge.db`);
  const ackFile=path.join(home,`.local/share/${productRoot}/delivery-acks.db`);
  const expand=marker=>block(marker).replaceAll('<home>',home).replaceAll('<config>',path.join(home,'.config'));
  fs.mkdirSync(path.dirname(dbFile),{recursive:true});fs.mkdirSync(path.join(home,`.config/${productRoot}`),{recursive:true});fs.mkdirSync(artifacts,{recursive:true});
  const db=new DatabaseSync(dbFile);db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES('stopped');");db.close();
  if(withAck) {const ack=new DatabaseSync(ackFile);ack.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES('before');");ack.close();fs.chmodSync(ackFile,0o600);}
  fs.writeFileSync(path.join(artifacts,'bytes'),'artifact');
  const run=marker=>spawnSync('bash',['-ec',`dalan() { node ${repo}/bin/dalan.mjs \"$@\"; }\n${expand(marker)}`],{env:{...process.env,HOME:home,DOT_BRIDGE_WORKSPACE_ROOT:path.join(home,'work')},encoding:'utf8'});
  for(const marker of ['pre-upgrade-backup','rollback-backup']) {const result=run(marker);assert.equal(result.status,0,result.stderr);}
  if(withAck) {
    for(const suffix of ['pre-isolation','pre-rollback']) assert.ok(fs.existsSync(`${ackFile}.${suffix}`),'documented backup omitted positive ACK evidence');
    const ack=new DatabaseSync(ackFile);ack.exec("UPDATE proof SET value='newer';");ack.close();
  }
  fs.writeFileSync(path.join(home,`.config/${productRoot}/workers.json`),'discard this later profile');
  fs.writeFileSync(path.join(artifacts,'bytes'),'changed');
  const restored=run('rollback-restore');assert.equal(restored.status,0,restored.stderr);
  assert.equal(fs.existsSync(path.join(home,`.config/${productRoot}/workers.json`)),false);
  assert.equal(fs.readFileSync(path.join(artifacts,'bytes'),'utf8'),'artifact');
  assert.ok(fs.existsSync(`${dbFile}.pre-isolation`));
  if(withAck) {
    let ack=new DatabaseSync(ackFile);assert.equal(ack.prepare('SELECT value FROM proof').get().value,'newer','restore overwrote newer positive ACK evidence');ack.close();
    fs.unlinkSync(ackFile);
    const missingAckRestore=run('rollback-restore');assert.equal(missingAckRestore.status,0,missingAckRestore.stderr);
    ack=new DatabaseSync(ackFile);assert.equal(ack.prepare('SELECT value FROM proof').get().value,'before','restore did not recover a missing ACK ledger');ack.close();
    assert.equal(fs.statSync(ackFile).mode&0o777,0o600);
  }
  }
});

await check('rollback guard refuses a queued partial upload with no active claim and retains both terminal partials',async()=>{
  const doc=fs.readFileSync(path.join(repo,'docs/operations.md'),'utf8');
  const sql=/```sql\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf('<!-- rollback-sql -->')))[1];
  for(const status of ['queued','finished','cancelled']) {
    const store=new Store(':memory:'),payload=assignment(rid('guard'));
    store.submit(payload,{mode:'none'},null,'owner');
    const claim=store.claim(payload.request_id,'dot','owner');
    store.db.prepare("INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sealed,created_at) VALUES('art_partial',?,?,'upload','/unused-test-path',1,0,?)").run(payload.request_id,claim.claim_id,store.stamp());
    if(status==='queued') store.abandon(payload.request_id,{actor:'owner',reason:'claim drained; partial upload remains'});
    if(status==='finished') store.finish(payload.request_id,claim.claim_id,'completed','complete','complete','owner');
    if(status==='cancelled') store.cancel(payload.request_id);
    assert.equal(store.db.prepare("SELECT count(*) n FROM claims c JOIN assignments a USING(request_id) WHERE c.state='active' AND a.status='claimed'").get().n,0);
    if(status==='queued') {assert.throws(()=>store.db.exec(sql),/CHECK constraint failed/);store.db.exec('ROLLBACK');}
    else {store.db.exec(sql);assert.equal(store.db.prepare("SELECT sealed FROM artifacts WHERE id='art_partial'").get().sealed,0);}
    store.db.close();
  }
});

await historicalCheck('rollback: documented backup, pause, upload drain, SQL, old upload/expiry/finish and restore (SIMULATED issuer only)',[BASE_COMMIT], async () => {
  const doc = fs.readFileSync(path.join(repo, 'docs/operations.md'), 'utf8');
  const block = marker => { const at = doc.indexOf(`<!-- ${marker} -->`); assert.notEqual(at, -1, `docs/operations.md has no ${marker} block`); return /```(?:sh|sql)\n([\s\S]*?)```/.exec(doc.slice(at))[1]; };
  const expand = (marker, home) => block(marker).replaceAll('<home>',home).replaceAll('<config>',path.join(home,'.config'));
  // The issuer side is simulated: it issues for the clients it still allows, and a token is valid until it expires.
  const issuerAllowed = new Set(['client-dot', 'client-lark']);
  const issue = (azp, seconds = 300) => { if (!issuerAllowed.has(azp)) throw new Error(`issuer refuses to issue for ${azp}`); return token(azp, { exp: Math.floor(Date.now() / 1000) + seconds }); };
  const live = await startServer('rollback', JSON.parse(JSON.stringify(profileJson).replaceAll(ISS, issuer)));
  let old = null;
  try {
    assert.notEqual(live.port, null, live.stderr);
    const [dotJob, larkJob, larkClaimed] = [rid('rbdot'), rid('rblark'), rid('rbmc')];
    assert.equal(live.submit(dotJob, 'dot').code, 0); assert.equal(live.submit(larkJob, 'lark').code, 0); assert.equal(live.submit(larkClaimed, 'lark').code, 0);
    const larkSub = (await live.rpc(issue('client-lark'), 'events/subscribe', { name: 'assignment.available', arguments: {}, delivery: { mode: 'webhook', url: `http://127.0.0.1:${hookServer.address().port}/rb`, secret: `whsec_${randomBytes(32).toString('base64')}` } })).body.result.id;
    assert.equal((await live.tool(issue('client-lark'), 'claim', { request_id: larkClaimed, claimant: 'lark' })).ok, true);
    await live.tool(issue('client-lark'), 'list_pending'); // lark is a real, active connector
    const alias=`art_${randomUUID()}`,data=Buffer.from('retained worker artifact'),digest=createHash('sha256').update(data).digest('hex');
    const sealed=[];
    for(const worker of ['dot','dot','lark']) {
      const request=rid('sealed');assert.equal(live.submit(request,worker).code,0);
      const held=(await live.tool(issue(`client-${worker}`),'claim',{request_id:request,claimant:worker})).value;
      assert.equal((await live.tool(issue(`client-${worker}`),'artifact_chunk',{request_id:request,claim_id:held.claim_id,artifact_id:alias,offset:0,data_base64:data.toString('base64'),final:true,sha256:digest})).ok,true);
      assert.equal((await live.tool(issue(`client-${worker}`),'finish',{request_id:request,claim_id:held.claim_id,outcome:'completed',summary:'sealed',result:'retained',artifact_ids:[alias]})).ok,true);
      const owner=JSON.parse(live.cli(['get',request,'--json']).stdout);sealed.push({request,worker,id:owner.artifacts[0].id});
    }
    assert.equal(new Set(sealed.map(r=>r.id)).size,3,'concurrent aliases shared a global ID');
    const draining=rid('draining');assert.equal(live.submit(draining,'dot').code,0);
    const drainingClaim=(await live.tool(issue('client-dot'),'claim',{request_id:draining,claimant:'dot'})).value;
    assert.equal((await live.tool(issue('client-dot'),'artifact_chunk',{request_id:draining,claim_id:drainingClaim.claim_id,artifact_id:alias,offset:0,data_base64:data.toString('base64')})).ok,true);
    const terminal=rid('terminal');assert.equal(live.submit(terminal,'dot').code,0);
    const terminalClaim=(await live.tool(issue('client-dot'),'claim',{request_id:terminal,claimant:'dot'})).value;
    assert.equal((await live.tool(issue('client-dot'),'artifact_chunk',{request_id:terminal,claim_id:terminalClaim.claim_id,artifact_id:alias,offset:0,data_base64:data.toString('base64')})).ok,true);
    assert.equal(live.cli(['cancel',terminal]).code,0);
    const sh = (marker, cwd, home = live.home) => spawnSync('bash', ['-ec', `dot-worker() { node ${repo}/bin/dot-worker.mjs "$@"; }\ndalan() { node ${repo}/bin/dalan.mjs "$@"; }\n${expand(marker,home)}`], { cwd, env: { ...live.env, HOME: home }, encoding: 'utf8' });
    const work = fs.mkdtempSync(path.join(root, 'rb-')), dbFile = path.join(live.home, '.local/share/dot-bridge/bridge.db');

    // step 1: revoke at the issuer. A token minted before keeps working until it expires: that is why the doc says to wait.
    const larkToken = issue('client-lark', 9);
    issuerAllowed.delete('client-lark');
    assert.throws(() => issue('client-lark'), /issuer refuses/, 'the issuer still issues for a revoked client');
    // step 2: pause. Without --reason the CLI exits 1, which is why the doc spells it out.
    assert.equal(live.cli(['pause']).code, 1);
    const paused = sh('rollback-pause', work); assert.equal(paused.status, 0, paused.stderr);
    // Claims drain while paused; abandoning needs no new claim or remote dependency.
    assert.equal(live.cli(['abandon',larkClaimed,'--reason','rollback drain']).code,0);
    // The documented SQL must refuse the live upload and claim, with the service stopped.
    await live.stop();
    fs.writeFileSync(path.join(work,'rollback.sql'),block('rollback-sql'));
    const undrained=sh('rollback-apply',work);assert.notEqual(undrained.status,0,'rollback accepted an unsealed upload');
    assert.match(undrained.stderr,/CHECK constraint failed/);
    assert.equal(dbRead(live,'SELECT sealed FROM artifacts WHERE request_id=?',draining)[0].sealed,0);
    const restarted=await startServer('rollback',null,{reuse:true});
    try {
      assert.notEqual(restarted.port,null,restarted.stderr);
      assert.equal((await restarted.tool(issue('client-dot'),'artifact_chunk',{request_id:draining,claim_id:drainingClaim.claim_id,artifact_id:alias,offset:data.length,data_base64:'',final:true,sha256:digest})).ok,true);
      assert.equal((await restarted.tool(issue('client-dot'),'finish',{request_id:draining,claim_id:drainingClaim.claim_id,outcome:'completed',summary:'drained',result:'sealed',artifact_ids:[alias]})).ok,true);
    } finally {await restarted.stop();}
    // step 4: backup only after drain and service stop, as documented.
    const backup = sh('rollback-backup', work); assert.equal(backup.status, 0, backup.stderr);
    assert.ok(fs.existsSync(`${dbFile}.pre-rollback`) && fs.existsSync(path.join(live.home, '.config/dot-bridge/workers.json.pre-rollback')));
    // step 5: the SQL, first with a failing statement: nothing may change, then as written.
    const sql = block('rollback-sql'), trial = path.join(work, 'trial'); fs.mkdirSync(path.join(trial, '.local/share/dot-bridge'), { recursive: true });
    assert.equal(spawnSync('sqlite3', [dbFile, `.backup '${path.join(trial, '.local/share/dot-bridge/bridge.db')}'`]).status, 0); // a consistent copy, WAL included
    fs.writeFileSync(path.join(work, 'rollback.sql'), sql.replace('COMMIT;', 'SELECT * FROM no_such_table;\nCOMMIT;'));
    const failing = sh('rollback-apply', work, trial); assert.notEqual(failing.status, 0, 'a failing statement did not stop the run');
    assert.equal(new DatabaseSync(path.join(trial, '.local/share/dot-bridge/bridge.db')).prepare("SELECT status FROM assignments WHERE request_id=?").get(larkJob).status, 'queued', 'a partial run changed the database');
    fs.writeFileSync(path.join(work, 'rollback.sql'), sql);
    const applied = sh('rollback-apply', work); assert.equal(applied.status, 0, applied.stderr);
    // step 6: remove the profile, start the OLD build on the same home
    fs.rmSync(path.join(live.home, '.config/dot-bridge/workers.json'));
    const baseTree = path.join(root, 'base-tree'); fs.mkdirSync(baseTree, { recursive: true });
    const archive=readPrepublicFixture(historyArchive(BASE_COMMIT));
    assert.equal(spawnSync('tar',['-xz','-C',baseTree],{input:archive}).status,0);
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(baseTree, 'node_modules'));
    old = await startServer('rollback', null, { cwd: baseTree, reuse: true });
    assert.notEqual(old.port, null, old.stderr);
    // the hazard the doc warns about: the old build cannot tell clients apart, so a still-valid lark token reads the worker's queue
    const hazard = await old.tool(larkToken, 'list_pending');
    assert.equal(hazard.ok, true); assert.ok(hazard.value.assignments.some(a => a.request_id === dotJob), 'expected the old build to serve the worker\'s queue to a still-valid lark token (the reason for step 1)');
    // after the token lifetime: the revoked client's token is dead and cannot be reissued
    await sleep(Math.max(0, 10500 - (Date.now() - (Math.floor(JSON.parse(Buffer.from(larkToken.split('.')[1], 'base64url')).exp) * 1000 - 9000))));
    const dead = await old.rpc(larkToken, 'tools/list'); assert.equal(dead.status, 401, 'an expired lark token was still accepted');
    assert.throws(() => issue('client-lark'), /issuer refuses/);
    const dotToken = issue('client-dot');
    const listed = (await old.tool(dotToken, 'list_pending')).value;
    assert.deepEqual(listed.assignments.map(a => a.request_id), [dotJob], 'the old build lists something that is not the worker\'s');
    assert.equal(dbRead(old, 'SELECT state FROM subscriptions WHERE id=?', larkSub).length,0);
    const heardBefore = hooks.filter(h => h.sub === larkSub).length; await sleep(1500); assert.equal(hooks.filter(h => h.sub === larkSub).length, heardBefore, 'the revoked subscription was still called');
    const resumed = sh('rollback-resume', work); assert.equal(resumed.status, 0, resumed.stderr);
    const oldClaim=await old.tool(dotToken,'claim',{request_id:dotJob,claimant:'dot'});assert.equal(oldClaim.ok,true,oldClaim.error);
    assert.equal((await old.tool(dotToken,'get',{request_id:larkJob})).ok,false,'old build exposed a known non-dot ID');
    for(const row of sealed.filter(r=>r.worker==='dot')) {
      const out=path.join(root,`rollback-${row.id}`),download=old.cli(['artifact',row.id,'--output',out,'--json']);
      assert.equal(download.code,0,download.stderr);assert.deepEqual(fs.readFileSync(out),data);
    }
    assert.equal(dbRead(old,'SELECT id FROM artifacts WHERE id=?',sealed.find(r=>r.worker==='lark').id).length,0);
    const partial=dbRead(old,'SELECT id,sealed FROM artifacts WHERE request_id=?',terminal)[0];
    assert.equal(partial.sealed,0,'rollback changed a terminal unsealed row');
    assert.notEqual(old.cli(['artifact',partial.id,'--output',path.join(root,'terminal-partial')]).code,0,'old build downloaded an unsealed terminal artifact');
    // Actual old-build upload and finish; its ID-only writes cannot touch the retained worker rows.
    const oldAlias=alias; // deliberately reuse the original worker alias in an old-build upload
    const oldUpload=await old.tool(dotToken,'artifact_chunk',{request_id:dotJob,claim_id:oldClaim.value.claim_id,artifact_id:oldAlias,offset:0,data_base64:data.toString('base64'),final:true,sha256:digest});
    assert.equal(oldUpload.ok,true,oldUpload.error);
    assert.equal((await old.tool(dotToken,'finish',{request_id:dotJob,claim_id:oldClaim.value.claim_id,outcome:'completed',summary:'old finish',result:'done',artifact_ids:[oldAlias]})).ok,true);
    await old.stop();
    const db=new DatabaseSync(old.dbPath);db.exec('PRAGMA busy_timeout=5000');db.prepare('UPDATE artifacts SET retention_until=? WHERE id=?').run('2000-01-01T00:00:00Z',oldAlias);db.close();
    await old.stop();old=await startServer('rollback',null,{cwd:baseTree,reuse:true});assert.notEqual(old.port,null,old.stderr);
    for(let i=0;i<80&&dbRead(old,'SELECT id FROM artifacts WHERE id=?',oldAlias).length;i++) await sleep(100);
    assert.equal(dbRead(old,'SELECT id FROM artifacts WHERE id=?',oldAlias).length,0,'old build expiry did not delete its upload');
    for(const row of sealed.filter(r=>r.worker==='dot')) assert.deepEqual(dbRead(old,'SELECT size,sha256,sealed FROM artifacts WHERE id=?',row.id).map(r=>({...r})),[{size:data.length,sha256:digest,sealed:1}]);
    // restore, as written: stop the old build, put the backup and profile back, start the new build, re-enable the client
    await old.stop(); old = null;
    const restored = sh('rollback-restore', work); assert.equal(restored.status, 0, restored.stderr);
    issuerAllowed.add('client-lark');
    old = await startServer('rollback', null, { reuse: true });
    assert.notEqual(old.port, null, old.stderr);
    const again = await old.tool(issue('client-lark'), 'list_pending');
    assert.deepEqual(again.value.assignments.map(a => a.request_id).sort(), [larkJob,larkClaimed].sort(), 'lark did not get its drained queue back after the restore');
    assert.deepEqual((await old.tool(issue('client-dot'), 'list_pending')).value.assignments.map(a => a.request_id), [dotJob]);
    assert.equal(dbRead(old,'SELECT request_id FROM reports WHERE request_id=?',dotJob).length,0,'restore retained a report written after rollback');
    assert.match((await old.tool(issue('client-dot'),'claim',{request_id:dotJob,claimant:'dot'})).error,/^bridge paused/);
    const unpaused=sh('rollback-resume',work);assert.equal(unpaused.status,0,unpaused.stderr);
    assert.equal((await old.tool(issue('client-dot'),'claim',{request_id:dotJob,claimant:'dot'})).ok,true,'restored build cannot accept claims after resume');
  } finally { if (old) await old.stop(); await live.stop(); }
});

fs.rmSync(root, { recursive: true, force: true });
jwks.close(); hookServer.close(); ntfy.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log(skipped.length ? `\nPASS worker isolation, ${skipped.length} check(s) skipped` : '\nPASS worker isolation');
process.exit(0);
