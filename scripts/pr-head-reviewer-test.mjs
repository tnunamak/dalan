#!/usr/bin/env node
// PR-head reviewer: assignment construction against the bridge's own submit lint, dedupe, gating, thread mapping, run flow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(process.env.HOME ?? os.tmpdir(), '.tmp-prh-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.HOME = tmp; // no submission policy file: the lint uses its built-in rules only
const { validateSubmission } = await import('../src/submission-policy.mjs');
const m = await import('../src/pr-head-reviewer.mjs');
const defaultCfg = { ...m.DEFAULTS, bridge_db: ':memory:', t3_db: ':memory:' };
const cfg = { ...defaultCfg, owners: ['example-connectors', 'example-owner'], repos: ['example-partner/sample-ui', 'example-partner/sample-service'], exclude_owners: ['excluded-account', 'excluded-platform', 'excluded-org'] };
const now = Date.parse('2026-10-16T00:00:00Z');
const sha = c => c.repeat(40), HEAD = sha('a'), BASE = sha('b');
const pr = { repo: 'example-connectors/sample-data', number: 42, head: HEAD, base: sha('c') };
const files = ['src/app.ts', 'src/routes/[id]/page.tsx', 'docs/readme.md', 'package.json', 'tests/app.test.ts'];

// 1. Request id: deterministic, bounded, within [-\w]{8,128}.
assert.equal(m.requestId('example-connectors/sample-data', 42, HEAD), 'prh-example-connectors-sample-data-42-aaaaaaaaaaaa');
assert.match(m.requestId('a.b/c.d', 1, HEAD), /^[-\w]{8,128}$/);
assert.match(m.requestId('o/' + 'x'.repeat(100), 123456, HEAD), /^[-\w]{8,128}$/);
assert.equal(m.requestId('o/' + 'x'.repeat(100), 123456, HEAD).slice(-20), '-123456-aaaaaaaaaaaa');
assert.equal(m.objectiveKey('o/r', 7), 'pr:o/r#7');

// Invalid --only input fails before I/O, including a missing value and malformed run options.
assert.deepEqual(m.parseOnly('example-connectors/sample-data#42'), { repo: 'example-connectors/sample-data', number: 42 });
for (const value of [undefined, null, '', '--dry-run', 'o/r', 'o/r#', 'o/r#0', 'o/r#-1', 'o/r#1x', 'o/r#1/2', 'o/r#9007199254740992', 'o/r#1\n']) {
  assert.throws(() => m.parseOnly(value), /^Error: invalid --only: expected owner\/repo#number$/);
}
for (const only of [{}, { repo: 'o/r' }, { number: 1 }, { repo: 'o/r', number: '1' }, { repo: 'bad', number: 1 }, { repo: 'o/r', number: 0 }]) {
  const calls = [];
  const deps = new Proxy({}, { get: (_, key) => { calls.push(key); assert.fail('invalid only reached I/O'); } });
  await assert.rejects(() => m.run({ cfg, deps, only }), /invalid --only/);
  assert.deepEqual(calls, [], 'no status, search or submission before argument validation');
}
// 2. A normal PR: scope is exactly the changed files, and the bridge's own lint accepts it.
let plan = m.planReview(pr, { files, mergeBase: BASE }, cfg, now);
assert.ok(!plan.skip, plan.skip);
const a = plan.assignment;
assert.deepEqual(a.scope_paths, files);
assert.deepEqual(a.inputs, [{ github_repo: 'example-connectors/sample-data', base_sha: BASE, head_sha: HEAD }]);
assert.equal(a.execution_scope, 'read-only');
assert.equal(a.request_id, 'prh-example-connectors-sample-data-42-aaaaaaaaaaaa');
assert.ok(plan.diff && !plan.excluded.length);
assert.equal(a.valid_until, '2026-10-16T04:00:00Z');
// The brief names no path: no host path, no '..', nothing path-shaped but the repository slug.
assert.ok(!/\.\.|~|\$HOME|\/home\/|\/tmp\//.test(a.brief));
assert.deepEqual((a.brief.match(/[\w.-]+\/[\w./-]+/g) ?? []).filter(t => t !== 'example-connectors/sample-data'), []);
// The assignment passes validateSubmission with a stub scanInput exactly as the bridge would run it (diff files = scope).
validateSubmission(a, { scanInput: () => ({ files, diffFiles: files, diff: '', symlinks: [] }), excludeSensitive: true });
// And the lint bites: a brief naming an outside host path is refused, so the check above is not vacuous.
assert.throws(() => validateSubmission({ ...a, brief: `${a.brief} Also read ~/.ssh/id_rsa` }, { scanInput: () => ({ files, diffFiles: files, diff: '', symlinks: [] }) }), /sensitive/);

// 3. No merge base: reviewed at the head, no diff, base_sha is the head.
plan = m.planReview(pr, { files, mergeBase: null }, cfg, now);
assert.deepEqual(plan.assignment.inputs, [{ github_repo: 'example-connectors/sample-data', base_sha: HEAD }]);
assert.ok(!plan.diff && /not available/.test(plan.assignment.brief));

// 4. A sensitive changed file leaves the scope (the bridge refuses any diff that touches one); the rest is reviewed at the head.
plan = m.planReview(pr, { files: [...files, '.env.production', 'config/auth-token.json', 'deploy/server.key'], mergeBase: BASE }, cfg, now);
assert.ok(!plan.skip, plan.skip);
assert.deepEqual(plan.assignment.scope_paths, files);
assert.deepEqual(plan.excluded.sort(), ['.env.production', 'config/auth-token.json', 'deploy/server.key']);
assert.ok(!plan.diff && plan.assignment.inputs[0].head_sha === undefined);
// All changed files sensitive: nothing to review, no submission.
assert.match(m.planReview(pr, { files: ['.env', 'keys/id_rsa'], mergeBase: BASE }, cfg, now).skip, /every changed file is excluded as sensitive/);
assert.match(m.planReview(pr, { files: [], mergeBase: BASE }, cfg, now).skip, /changes no files/);
// Any other lint refusal skips with the reason instead of looping.
assert.match(m.planReview(pr, { files, mergeBase: BASE }, cfg, now, () => { throw new Error('brief: too long'); }).skip, /^lint: brief: too long/);

// 5. More than max_scope_paths files: the deepest directory level that fits; still lint-clean.
const many = Array.from({ length: 400 }, (_, i) => `packages/p${i % 20}/src/f${i}.ts`);
plan = m.planReview(pr, { files: many, mergeBase: BASE }, cfg, now);
assert.ok(!plan.skip, plan.skip);
assert.ok(plan.scope.length <= 150 && plan.scope.length > 0);
assert.ok(many.every(f => plan.scope.some(s => f === s || f.startsWith(`${s}/`))), 'every changed file stays covered');
assert.deepEqual(m.collapseScope(['a/b.ts', 'a/c.ts'], { maxPaths: 150, maxBytes: 8000 }), ['a/b.ts', 'a/c.ts']);
assert.deepEqual(m.collapseScope(['a/b/c.ts', 'a/b/d.ts', 'a/e/f.ts'], { maxPaths: 2, maxBytes: 8000 }), ['a/b', 'a/e/f.ts'].length === 2 ? m.collapseScope(['a/b/c.ts', 'a/b/d.ts', 'a/e/f.ts'], { maxPaths: 2, maxBytes: 8000 }) : []);
assert.deepEqual(m.collapseScope(['a/b/c.ts', 'a/b/d.ts', 'a/e/f.ts'], { maxPaths: 2, maxBytes: 8000 }), ['a/b', 'a/e']);
assert.ok(m.collapseScope(many, { maxPaths: 1000, maxBytes: 500 }).join('\n').length <= 500);

// 6. Gating from status JSON.
const status = (over = {}) => ({ paused: false, counts: [{ status: 'claimed', count: 5 }, { status: 'queued', count: 3 }, { status: 'finished', count: 9 }], max_claimed_outer_assignments: 6, worker_break: { active: false, source: null }, claim_denied: { capacity_hold_until: null }, queued_expired: { count: 0 }, ...over });
assert.deepEqual(m.gate(status(), cfg, now), { slots: 4, claimed: 5, queued: 3, lanes: 6 });                 // 6 + 6 - 8
assert.equal(m.gate(status({ counts: [{ status: 'claimed', count: 6 }, { status: 'queued', count: 6 }] }), cfg, now).slots, 0);
assert.equal(m.gate(status({ counts: [{ status: 'claimed', count: 6 }, { status: 'queued', count: 20 }] }), cfg, now).slots, 0, 'never negative');
assert.equal(m.gate(status({ counts: [], queued_expired: { count: 0 } }), cfg, now).slots, 12);
assert.equal(m.gate(status({ counts: [{ status: 'queued', count: 4 }], queued_expired: { count: 3 } }), cfg, now).queued, 1, 'expired queued rows are not live');
assert.equal(m.gate(status(), { ...cfg, headroom: 0 }, now).slots, 0 + Math.max(0, 6 - 8));
assert.match(m.gate(status({ paused: true, pause_reason: 'maintenance' }), cfg, now).hold, /paused/);
assert.match(m.gate(status({ worker_break: { active: true, source: 'owner' } }), cfg, now).hold, /worker_break/);
assert.ok(m.gate(status({ worker_break: { active: true, source: 'inferred' } }), cfg, now).slots >= 0, 'an inferred break holds nothing');
assert.match(m.gate(status({ claim_denied: { capacity_hold_until: '2026-10-16T01:00:00Z' } }), cfg, now).hold, /capacity hold/);
assert.equal(typeof m.gate(status({ claim_denied: { capacity_hold_until: '2026-10-15T23:00:00Z' } }), cfg, now).slots, 'number', 'a lapsed hold is not a hold');

// 7. Dedupe against a bridge db.
const bridge = new DatabaseSync(':memory:');
bridge.exec('create table assignments (request_id text primary key, payload text, status text, created_at text, objective_key text, revision text)');
const put = (id, status, input, objective = null, revision = null) => bridge.prepare('insert into assignments values (?,?,?,?,?,?)').run(id, JSON.stringify({ inputs: [input] }), status, '2026-10-15T00:00:00Z', objective, revision);
put('own-queued', 'queued', { github_repo: 'example-connectors/sample-data', base_sha: BASE, head_sha: sha('1') });
put('feeder-old', 'finished', { github_repo: 'example-connectors/sample-data', base_sha: sha('2') });
put('cancelled-one', 'cancelled', { github_repo: 'example-connectors/sample-data', base_sha: BASE, head_sha: sha('3') });
put('other-repo', 'finished', { github_repo: 'example-connectors/other', base_sha: BASE, head_sha: sha('4') });
put('by-objective', 'claimed', { github_repo: 'x/y', base_sha: BASE }, 'pr:example-connectors/sample-data#42', sha('5'));
assert.equal(m.findCovered(bridge, 'example-connectors/sample-data', 42, sha('1')).request_id, 'own-queued', 'head_sha match, repo case-insensitive');
assert.equal(m.findCovered(bridge, 'example-connectors/sample-data', 42, sha('2')).request_id, 'feeder-old', 'lone base_sha pin counts');
assert.equal(m.findCovered(bridge, 'example-connectors/sample-data', 42, sha('3')), null, 'cancelled does not cover');
assert.equal(m.findCovered(bridge, 'example-connectors/sample-data', 42, sha('4')), null, 'same head in another repo does not cover');
assert.equal(m.findCovered(bridge, 'example-connectors/sample-data', 42, sha('5')).request_id, 'by-objective', 'objective + revision');
assert.equal(m.findCovered(bridge, 'example-connectors/sample-data', 43, sha('5')), null, 'objective for another PR does not cover');
assert.equal(m.findCovered(bridge, 'example-connectors/sample-data', 42, sha('9')), null, 'a new head is uncovered');
assert.equal(m.findCovered(bridge, 'example-connectors/sample-data', 42, BASE), null, 'a separate head_sha prevents matching the old base_sha');

// 8. PR -> thread mapping.
const t3 = new DatabaseSync(':memory:');
t3.exec('create table orchestration_v2_projection_threads (thread_id text primary key, archived_at text, deleted_at text, payload_json text)');
const thread = (id, prs, { archived = null, deleted = null, parent = null, root = null, settled = null } = {}) => t3.prepare('insert into orchestration_v2_projection_threads values (?,?,?,?)').run(id, archived, deleted, JSON.stringify({ pullRequests: prs, lineage: { parentThreadId: parent, rootThreadId: root }, settledAt: settled }));
const link = (number, linkedAt, repository = 'example-connectors/sample-data') => ({ repository, number, linkedAt, url: `https://github.com/${repository}/pull/${number}` });
thread('old-live-thread', [link(42, '2026-10-01T00:00:00Z')]);
thread('new-live-thread', [link(42, '2026-10-05T00:00:00Z'), link(7, '2026-10-05T00:00:00Z', 'o/r')]);
thread('archived-newer', [link(42, '2026-10-09T00:00:00Z')], { archived: '2026-10-10T00:00:00Z' });
thread('deleted-thread', [link(43, '2026-10-09T00:00:00Z')], { deleted: '2026-10-10T00:00:00Z' });
thread('mcp:00000000-0000-4000-8000-000000000003', [link(44, '2026-10-02T00:00:00Z')]);
thread('bad id', [link(45, '2026-10-02T00:00:00Z')]);
const index = m.threadIndex(t3);
assert.equal(index.get('example-connectors/sample-data#42'), 'new-live-thread', 'live beats archived, newest link wins');
assert.equal(index.get('o/r#7'), 'new-live-thread');
assert.equal(index.has('example-connectors/sample-data#43'), false, 'deleted threads are not targets');
assert.equal(index.get('example-connectors/sample-data#44'), 'mcp:00000000-0000-4000-8000-000000000003');
assert.equal(index.has('example-connectors/sample-data#45'), false, 'an id the delivery flag would refuse is never chosen');
assert.deepEqual(m.deliveryFor(index, 'example-connectors/sample-data', 42, cfg), { delivery: 't3:new-live-thread', via: 'pr-link' });
assert.deepEqual(m.deliveryFor(index, 'example-connectors/sample-data', 99, { ...cfg, report_thread_id: 'report-thread-1' }), { delivery: 't3:report-thread-1', via: 'report-thread' });
assert.deepEqual(m.deliveryFor(index, 'example-connectors/sample-data', 99, cfg), { delivery: 'none', via: 'none' });
// The report thread key: the new name, the deprecated earlier name, and the new name winning when both are present.
{
  const { legacyReportThreadKey } = await import('../src/legacy-names.mjs');
  const write = obj => { const f = path.join(tmp, `config-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  assert.equal(m.loadConfig(write({ report_thread_id: 'report-thread-new' })).report_thread_id, 'report-thread-new');
  const old = m.loadConfig(write({ [legacyReportThreadKey]: 'report-thread-old' }));
  assert.equal(old.report_thread_id, 'report-thread-old', 'the deprecated key is still read');
  assert.equal(legacyReportThreadKey in old, false, 'the deprecated key is not carried into the config');
  assert.equal(m.loadConfig(write({ [legacyReportThreadKey]: 'report-thread-old', report_thread_id: 'report-thread-new' })).report_thread_id, 'report-thread-new');
  assert.equal(m.loadConfig(write({})).report_thread_id, null);
  assert.throws(() => m.loadConfig(write({ surprise_key: 1 })), /unknown config key surprise_key/);
}

// 9. Repository and PR selection.
assert.deepEqual(defaultCfg.owners, [], 'repository owners have no private defaults');
assert.deepEqual(defaultCfg.repos, [], 'repository lists have no private defaults');
const reviewCfg = { ...defaultCfg, repos: ['example-partner/sample-ui', 'example-partner/sample-service'], exclude_owners: ['excluded-org', 'excluded-platform', 'excluded-account'] };
assert.deepEqual(m.reviewRepos(['example-connectors/a', 'example-owner/b', 'excluded-org/c', 'excluded-platform/d', 'excluded-account/e', 'example-owner/b'], reviewCfg), ['example-connectors/a', 'example-owner/b', 'example-partner/sample-ui', 'example-partner/sample-service']);
const day = 86400000, at = d => new Date(now - d * day).toISOString();
const sel = m.selectPrs([
  { number: 1, isDraft: true, updatedAt: at(2) }, { number: 2, isDraft: true, updatedAt: at(9) }, { number: 3, isDraft: false, updatedAt: at(10) },
  { number: 4, isDraft: false, updatedAt: at(40) }, { number: 5, isDraft: false, updatedAt: at(1), author: { is_bot: true } }, { number: 6, isDraft: false, updatedAt: at(1) },
], cfg, now).map(p => p.number);
assert.deepEqual(sel, [6, 3, 1], 'ready first then newest; stale, old drafts and bot PRs dropped');

// 10. Whole run with fake I/O: gating, limits, dedupe, delivery, refusal memory, dry-run.
const prRow = (number, headChar, extra = {}) => ({ number, headRefOid: sha(headChar), baseRefOid: sha('c'), title: `t${number}`, isDraft: false, updatedAt: at(1), headRefName: 'b', url: 'u', author: { is_bot: false }, ...extra });
const makeDeps = (over = {}) => {
  const submits = [], d = {
    submits,
    now: () => now,
    status: async () => status({ counts: [{ status: 'claimed', count: 6 }, { status: 'queued', count: 8 }] }), // 12 - 14 -> overridden per test
    searchPrs: async ({ owner, repo }) => (await d.listPrs(repo ?? (owner.toLowerCase() === 'example-connectors' ? 'example-connectors/sample-data' : owner + '/empty'))).map(p => ({ ...p, repository: { nameWithOwner: repo ?? 'example-connectors/sample-data' } })),
    prDetails: async (repo, number) => { const p = (await d.listPrs(repo)).find(p => p.number === number); return { head: { sha: p.headRefOid }, base: { sha: p.baseRefOid } }; },
    listPrs: async repo => (repo === 'example-connectors/sample-data' ? [prRow(42, '1'), prRow(43, '2'), prRow(44, '3'), prRow(45, '4')] : []),
    prFiles: async () => ['src/a.ts'], mergeBase: async () => BASE,
    openBridge: () => ({ prepare: q => bridge.prepare(q), close() {} }), openT3: () => ({ prepare: q => t3.prepare(q), close() {} }),
    submit: async (assignment, meta) => { submits.push({ assignment, meta }); return { ok: true, error: null }; },
    ...over,
  };
  return d;
};
const lines = [];
const runOnce = (deps, opts = {}, dir = fs.mkdtempSync(path.join(tmp, 'state-'))) => m.run({ cfg: { ...cfg, report_thread_id: 'report-thread-1' }, deps, stateDir: dir, print: l => lines.push(JSON.parse(l)), ...opts }).then(s => ({ s, dir }));
// bridge covers head '1' (own-queued, PR 42) and head '2' (feeder-old, PR 43); 2 slots -> submits 44 and 45 only.
bridge.prepare('update assignments set payload=? where request_id=?').run(JSON.stringify({ inputs: [{ github_repo: 'example-connectors/sample-data', base_sha: BASE, head_sha: sha('1') }] }), 'own-queued');
let deps = makeDeps({ status: async () => status({ counts: [{ status: 'claimed', count: 6 }, { status: 'queued', count: 4 }] }) });
let { s, dir } = await runOnce(deps);
assert.equal(s.slots, 2);
assert.deepEqual(deps.submits.map(x => x.assignment.request_id), ['prh-example-connectors-sample-data-44-333333333333', 'prh-example-connectors-sample-data-45-444444444444']);
assert.deepEqual(deps.submits[1].meta, { delivery: 't3:report-thread-1', objective: 'pr:example-connectors/sample-data#45', head: sha('4') });
assert.equal(deps.submits[0].meta.delivery, 't3:mcp:00000000-0000-4000-8000-000000000003', 'linked thread wins over the report thread');
assert.ok(lines.some(l => l.event === 'skip' && l.reason === 'covered' && l.pr === 42));
assert.ok(lines.some(l => l.event === 'skip' && l.reason === 'covered' && l.pr === 43));
const logged = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(logged.length >= 4 && logged.every(l => l.at && l.event), 'one JSON line per decision');

// A linked delegate routes to its nearest live owner, without waking the child.
{
  const delegate = 'thread:delegated-task:command%3Ax';
  thread('owner-thread-1', []);
  thread(delegate, [link(46, '2026-10-16T00:00:00Z')], { parent: 'owner-thread-1', root: 'owner-thread-1' });
  assert.equal(m.delegateOwner(t3, delegate), 'owner-thread-1');
  thread('root-thread-1', []);
  thread('settled-owner-1', [], { parent: 'root-thread-1', root: 'root-thread-1', settled: '2026-10-15T00:00:00Z' });
  thread('thread:delegated-task:nested', [], { parent: 'settled-owner-1', root: 'root-thread-1' });
  assert.equal(m.delegateOwner(t3, 'thread:delegated-task:nested'), 'root-thread-1', 'skip a settled parent for a live root');
  thread('thread:delegated-task:orphan', [], { parent: 'missing-owner', root: 'root-thread-1' });
  assert.equal(m.delegateOwner(t3, 'thread:delegated-task:orphan'), 'root-thread-1', 'root survives a missing parent');
  thread('thread:delegated-task:no-owner', [], { parent: 'missing-owner' });
  assert.equal(m.delegateOwner(t3, 'thread:delegated-task:no-owner'), null);
  thread('archived-owner-1', [], { archived: '2026-10-15T00:00:00Z', parent: 'root-thread-1', root: 'root-thread-1' });
  thread('thread:delegated-task:archived-parent', [], { parent: 'archived-owner-1', root: 'root-thread-1' });
  assert.equal(m.delegateOwner(t3, 'thread:delegated-task:archived-parent'), 'root-thread-1');
  thread('deleted-owner-1', [], { deleted: '2026-10-15T00:00:00Z', root: 'root-thread-1' });
  thread('thread:delegated-task:deleted-parent', [], { parent: 'deleted-owner-1', root: 'root-thread-1' });
  assert.equal(m.delegateOwner(t3, 'thread:delegated-task:deleted-parent'), 'root-thread-1');
  const d = makeDeps({ status: async () => status({ counts: [] }),
    listPrs: async repo => repo === pr.repo ? [prRow(46, '6')] : [] });
  const { s, dir } = await runOnce(d);
  assert.equal(s.submitted, 1);
  assert.equal(d.submits.length, 1);
  assert.equal(d.submits[0].meta.delivery, 't3:owner-thread-1');
  const logs = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(logs.some(l => l.event === 'delivery-fallback' && l.pr === 46 && l.reason === 'delegate thread'
    && l.from === `t3:${delegate}` && l.delivery === 't3:owner-thread-1'));
  thread('thread:delegated-task:no-owner-linked', [link(47, '2026-10-16T00:00:00Z')]);
  const noOwner = makeDeps({ status: async () => status({ counts: [] }),
    listPrs: async repo => repo === pr.repo ? [prRow(47, '7')] : [] });
  await runOnce(noOwner);
  assert.equal(noOwner.submits[0].meta.delivery, 't3:report-thread-1', 'report thread receives a result when no owner is live');
}

// A refused submit is remembered: the next run skips it for the cooldown and moves on; it does not loop within a run.
deps = makeDeps({ submit: async (a, mt) => { deps.submits.push({ a, mt }); return { ok: false, error: 'sensitive scope path: x' }; }, status: async () => status({ counts: [] }) });
({ s, dir } = await runOnce(deps, { maxSubmits: 2 }));
assert.equal(deps.submits.length, 2, 'bounded: one attempt per PR');
assert.equal(s.refused, 2);
deps.submits.length = 0;
({ s } = await runOnce(deps, { maxSubmits: 3 }, dir));
assert.deepEqual(deps.submits, [], 'both refused heads sit out their cooldown; nothing else is open');
assert.ok(lines.some(l => l.event === 'skip' && l.reason === 'refused earlier'));
// Every failed HTTP submit is remembered, including 503; a new head and the six-hour boundary can retry.
for (const httpStatus of [301, 400, 401, 409, 429, 500, 503]) {
  const error = JSON.stringify({ error: 'submit failed', kind: 'http', http_status: httpStatus });
  deps = makeDeps({ listPrs: async repo => repo === 'example-connectors/sample-data' ? [prRow(44, '3')] : [], submit: async (a, mt) => { deps.submits.push({ a, mt }); return { ok: false, error }; }, status: async () => status({ counts: [] }) });
  ({ s, dir } = await runOnce(deps));
  assert.equal(deps.submits.length, 1);
  const id = deps.submits[0].a.request_id, saved = new m.State(dir);
  assert.equal(saved.data.refused[id], new Date(now).toISOString());
  assert.equal(saved.data.reasons[id], error);
  deps.submits.length = 0;
  deps.now = () => now + 6 * 3600000 - 1;
  ({ s } = await runOnce(deps, {}, dir));
  assert.equal(deps.submits.length, 0, 'failure is remembered until six hours');
  deps.listPrs = async repo => repo === 'example-connectors/sample-data' ? [prRow(44, '9')] : [];
  await runOnce(deps, {}, dir);
  assert.equal(deps.submits.length, 1, 'a new head is eligible');
  deps.submits.length = 0;
  deps.listPrs = async repo => repo === 'example-connectors/sample-data' ? [prRow(44, '3')] : [];
  deps.now = () => now + 6 * 3600000;
  await runOnce(deps, {}, dir);
  assert.equal(deps.submits.length, 1, 'the original head retries at six hours');
}
// A submit-time defer is a narrow hold: retry next run, without a policy-refusal cooldown.
for(const error of ['deferred: usage break is active',JSON.stringify({error:'deferred: usage break is active',verdict:'defer',http_status:409})]) {
  let attempts=0; const d=makeDeps({status:async()=>status({counts:[]}),listPrs:async repo=>repo==='example-connectors/sample-data'?[prRow(44,'3')]:[],submit:async()=>{attempts++;return {ok:false,error};}});
  const first=await runOnce(d); assert.equal(first.s.hold,error); assert.equal(first.s.refused,0); assert.deepEqual(new m.State(first.dir).data.refused,{});
  d.submit=async()=>{attempts++;return {ok:true,error:null};}; const second=await runOnce(d,{},first.dir); assert.equal(second.s.submitted,1); assert.equal(attempts,2);
}
// File count gate: the default boundary and a custom cap, with no real submissions.
assert.equal(m.DEFAULTS.max_changed_files, 200);
for (const [count, cap, submitted] of [[200, 200, 1], [201, 200, 0], [452, 200, 0], [3, 2, 0], [3, 3, 1]]) {
  deps = makeDeps({ listPrs: async repo => repo === 'example-connectors/sample-data' ? [prRow(44, '3')] : [], status: async () => status({ counts: [] }), prFiles: async () => Array.from({ length: count }, (_, i) => `src/f${i}.ts`) });
  ({ s } = await runOnce(deps, { cfg: { ...cfg, max_changed_files: cap } }));
  assert.equal(deps.submits.length, submitted);
  if (!submitted) assert.ok(lines.some(l => l.event === 'skip' && l.reason === 'too many changed files' && l.changed_files === count && l.max_changed_files === cap));
}
// A force push during file enumeration discards the stale snapshot without a cooldown or watermark.
{
  let head = sha('3'), pulls = 0;
  const d = makeDeps({ status: async () => status({ counts: [] }),
    listPrs: async repo => repo === pr.repo ? [prRow(44, '3')] : [],
    prDetails: async () => { pulls++; return { head: { sha: head }, base: { sha: BASE } }; },
    prFiles: async () => { head = sha('9'); return ['src/a.ts']; } });
  const { s, dir } = await runOnce(d);
  assert.equal(pulls, 3, 'one closed-PR check for the tracked request on #42, then two reads of #44'); assert.equal(s.skipped, 1); assert.equal(s.errors, 0);
  assert.equal(d.submits.length, 0);
  assert.ok(lines.some(l => l.reason === 'PR head changed while fetching files' && l.latest_head === sha('9')));
  const saved = new m.State(dir);
  assert.deepEqual(saved.data.refused, {}); assert.equal(saved.data.last_successful_run, undefined);
  await runOnce(d, {}, dir);
  assert.equal(d.submits.length, 1, 'stable new head is reviewed on the next run');
}
// Removed files never enter the pinned-head scope; deletion-only PRs skip without cooldown.
for (const live of [false, true]) {
  const d = makeDeps({ status: async () => status({ counts: [] }),
    listPrs: async repo => repo === pr.repo ? [prRow(44, '3')] : [],
    prFiles: async () => [{ filename: 'src/deleted.ts', status: 'removed' },
      ...(live ? [{ filename: 'src/a.ts', status: 'modified' }, { filename: 'src/new.ts', status: 'added' }] : [])] });
  const { s, dir } = await runOnce(d, { cfg: { ...cfg, max_changed_files: live ? 200 : 0 } });
  assert.equal(s.submitted, live ? 1 : 0); assert.equal(s.errors, 0);
  assert.deepEqual(new m.State(dir).data.refused, {});
  if (live) assert.deepEqual(d.submits[0].assignment.scope_paths, ['src/a.ts', 'src/new.ts']);
  else {
    assert.ok(lines.some(l => l.reason === 'only deletions'));
    assert.equal(new m.State(dir).data.last_successful_run, new Date(now).toISOString());
    await runOnce(d, {}, dir); assert.equal(d.submits.length, 0);
  }
}
// Exercise the actual submit argv builder with a fake runner; never invoke dot-worker.
{
  const calls = [], io = m.realDeps(cfg, async (...args) => { calls.push(args); return { code: 0, stdout: '{}', stderr: '' }; });
  assert.equal((await io.submit(a, { delivery: 't3:report-thread-1', objective: 'pr:o/r#7', head: HEAD })).ok, true);
  assert.deepEqual(calls, [[cfg.dot_worker, [
    'submit', '--stdin', '--json', '--background', '--exclude-sensitive', '--allow-scope-prune',
    '--deliver', 't3:report-thread-1', '--objective-key', 'pr:o/r#7', '--revision', HEAD,
    '--task-kind', 'review', '--source', 'agent',
  ], { input: JSON.stringify(a), timeout: 180000 }]]);
}
// max_submits_per_run bounds the run even with free lanes.
deps = makeDeps({ status: async () => status({ counts: [] }) });
({ s } = await runOnce(deps, { maxSubmits: 1 }));
assert.equal(deps.submits.length, 1);
// Holds: nothing is listed or submitted.
for (const hold of [status({ paused: true }), status({ worker_break: { active: true, source: 'owner' } }), status({ claim_denied: { capacity_hold_until: '2026-10-16T01:00:00Z' } })]) {
  let listed = 0;
  deps = makeDeps({ status: async () => hold, prDetails: async () => ({ state: 'open' }), listPrs: async () => { listed++; return []; } });
  ({ s } = await runOnce(deps));
  assert.ok(s.hold && !deps.submits.length && !listed);
}
// No free lane: nothing is listed either.
deps = makeDeps({ status: async () => status({ counts: [{ status: 'claimed', count: 6 }, { status: 'queued', count: 6 }] }), listPrs: async () => { throw new Error('must not list'); } });
({ s } = await runOnce(deps)); assert.equal(s.submitted, 0);
// --dry-run submits and writes nothing; --only narrows to one PR.
deps = makeDeps({ status: async () => status({ counts: [] }) });
({ s, dir } = await runOnce(deps, { dryRun: true, only: { repo: 'example-connectors/sample-data', number: 44 } }));
assert.equal(deps.submits.length, 0); assert.equal(s.submitted, 1);
assert.deepEqual(fs.readdirSync(dir), [], 'dry run writes no state or log');
assert.ok(lines.filter(l => l.event === 'would-submit').at(-1).request_id.includes('-44-'));


// 12. Exercise real gh argv/response parsing through a fake runner. No live gh or submissions.
{
  const budgetCfg = { ...cfg, owners: ['example-connectors', 'example-connectors', 'example-owner', 'excluded-account'],
    repos: ['example-connectors/sample-data', 'extra/one', 'extra/one', 'excluded-account/hidden'], exclude_owners: ['excluded-account', 'excluded-platform', 'excluded-org'], exclude_repos: ['example-connectors/excluded'], report_thread_id: 'report-thread-1' };
  const calls = [], submissions = [], logs = [];
  let cached = false;
  const response = (body, etag) => ({ code: 0, stderr: '', stdout: 'HTTP/2.0 200 OK\r\nETag: ' + etag + '\r\n\r\n' + JSON.stringify(body) });
  const row = (repo, number, extra = {}) => ({ number, repository: { nameWithOwner: repo }, isDraft: false, updatedAt: new Date(now).toISOString(), author: { login: 'person' }, ...extra });
  const io = m.realDeps(budgetCfg, async (cmd, args) => {
    assert.equal(cmd, 'gh', 'other I/O is replaced; never invoke a real command');
    calls.push(args);
    if (args[0] === 'search') return { code: 0, stderr: '', stdout: JSON.stringify(args.includes('example-connectors') ? [
      row('example-connectors/sample-data', 44), row('example-connectors/excluded', 98), row('example-connectors/archived', 99, { repository: { nameWithOwner: 'example-connectors/archived', isArchived: true } }),
      row('excluded-account/hidden', 100), row('example-connectors/bot', 101, { author: { login: 'robot[bot]' } }),
    ] : []) };
    assert.equal(args[0], 'api');
    assert.ok(!args.includes('pr') && !args.includes('view'));
    if (cached) {
      assert.ok(args.includes('-H')); assert.ok(args.includes('If-None-Match: "' + (args[1].endsWith('/files') ? 'files' : 'pull') + '"'));
      return { code: 1, stderr: '', stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n' };
    }
    return args[1].endsWith('/files') ? response([{ filename: 'src/a.ts' }], '"files"') : response({ head: { sha: HEAD }, base: { sha: BASE }, state: 'open' }, '"pull"');
  });
  Object.assign(io, { now: () => now, status: async () => status({ counts: [] }),
    openBridge: () => ({ prepare: q => bridge.prepare(q), close() {} }), openT3: () => ({ prepare: q => t3.prepare(q), close() {} }),
    submit: async (assignment, meta) => { submissions.push({ assignment, meta: { ...meta } }); return { ok: true }; } });
  const budgetDir = fs.mkdtempSync(path.join(tmp, 'budget-'));
  const options = { cfg: budgetCfg, deps: io, stateDir: budgetDir, print: l => logs.push(JSON.parse(l)) };
  let result = await m.run(options);
  assert.equal(result.submitted, 1);
  assert.equal(calls.filter(a => a[0] === 'search').length, 3, 'one search per distinct allowed owner plus extra repo');
  assert.deepEqual(calls.filter(a => a[0] === 'api').map(a => a[1]), ['repos/example-connectors/sample-data/pulls/42', 'repos/example-connectors/sample-data/pulls/44', 'repos/example-connectors/sample-data/pulls/44/files', 'repos/example-connectors/sample-data/pulls/44'], 'excluded and archived PRs never fetched; head rechecked after files');
  assert.ok(calls.filter(a => a[0] === 'search').every(a => !a.some(v => v.startsWith('updated:'))), 'first run has no timestamp filter');
  assert.deepEqual(result.gh_calls, { search: 3, pull: 3, files: 1 });
  assert.ok(logs.some(l => l.event === 'gh-calls' && l.counts.search === 3));
  assert.equal(new m.State(budgetDir).data.last_successful_run, new Date(now).toISOString());
  assert.deepEqual(submissions[0].assignment.inputs, [{ github_repo: 'example-connectors/sample-data', base_sha: HEAD }], 'base tip must not be used as a merge base');
  cached = true; calls.length = 0;
  result = await m.run(options);
  assert.equal(result.submitted, 1, 'both 304 bodies are served from persisted cache');
  assert.equal(result.gh_calls.not_modified, 4);
  assert.ok(calls.filter(a => a[0] === 'search').every(a => a.includes('updated:>=2026-10-15T23:50:00.000Z')));
  // Protected delivery refusal tries the report thread, then quiet delivery, keeping identity/scope unchanged.
  let attempts = [];
  io.submit = async (assignment, meta) => { attempts.push({ assignment, meta: { ...meta } }); return meta.delivery === 'none' ? { ok: true } : { ok: false, error: 'protected T3 destination' }; };
  result = await m.run(options);
  assert.equal(result.submitted, 1); assert.equal(result.refused, 0);
  assert.equal(attempts.length, 3); assert.equal(attempts[1].meta.delivery, 't3:report-thread-1');
  assert.equal(attempts[2].meta.delivery, 'none');
  assert.deepEqual(attempts[1].assignment, attempts[0].assignment);
  assert.ok(logs.some(l => l.event === 'delivery-fallback' && l.pr === 44 && l.reason === 'protected T3 destination'));
}
// A rate limit at search, pull or files stops all subsequent work; the next run makes zero gh calls.
for (const stage of ['search', 'pull', 'files']) {
  const dir = fs.mkdtempSync(path.join(tmp, 'limited-')), calls = [], logs = [];
  const reset = Math.ceil((Date.now() + 7200000) / 1000);
  const io = m.realDeps(cfg, async (cmd, args) => {
    calls.push(args);
    const kind = args[0] === 'search' ? 'search' : args[1].endsWith('/files') ? 'files' : 'pull';
    if (kind === stage) return { code: 1, stderr: 'gh: HTTP 429 rate limit', stdout: 'HTTP/2.0 429 Too Many Requests\r\nX-RateLimit-Reset: ' + reset + '\r\n\r\n{}' };
    if (kind === 'search') return { code: 0, stderr: '', stdout: JSON.stringify([{ number: 44, repository: { nameWithOwner: pr.repo }, updatedAt: new Date(now).toISOString(), isDraft: false }]) };
    return { code: 0, stderr: '', stdout: 'HTTP/2.0 200 OK\r\n\r\n' + JSON.stringify({ head: { sha: HEAD }, base: { sha: BASE } }) };
  });
  Object.assign(io, { now: () => now, status: async () => status({ counts: [] }),
    openBridge: () => ({ prepare: q => bridge.prepare(q), close() {} }), openT3: () => ({ prepare: q => t3.prepare(q), close() {} }),
    submit: async () => { assert.fail('no submission after a rate limit'); } });
  const opts = { cfg, deps: io, stateDir: dir, print: l => logs.push(JSON.parse(l)) };
  const result = await m.run(opts);
  assert.equal(result.errors, 1); assert.equal(result.hold, 'GitHub rate limit');
  const saved = new m.State(dir);
  assert.equal(saved.data.backoff_until, new Date(reset * 1000).toISOString());
  assert.equal(saved.data.last_successful_run, undefined);
  const count = calls.length;
  assert.equal(count, stage === 'search' ? 2 : stage === 'pull' ? 1 : 7, 'the closed-PR check of tracked #42 is the first pull');
  assert.ok(logs.some(l => l.event === 'rate-limit'));
  await m.run(opts); assert.equal(calls.length, count, 'persisted backoff prevents all gh calls');
}
// Pagination must not reuse the first-page ETag for a multi-page collection.
{
  const state = new m.State(fs.mkdtempSync(path.join(tmp, 'pages-')));
  let calls = 0;
  const io = m.realDeps(cfg, async (cmd, args) => {
    calls++; assert.ok(args.includes('--paginate')); assert.ok(!args.includes('-H'));
    return { code: 0, stderr: '', stdout:
      'HTTP/2.0 200 OK\r\nETag: "one"\r\nLink: <https://api.github.com/repos/o/r/pulls/1/files?page=2>; rel="next"\r\n\r\n[{"filename":"src/a.ts"}]\n' +
      'HTTP/2.0 200 OK\r\nETag: "two"\r\n\r\n[{"filename":"src/b.ts"}]\n' };
  });
  io.beginRun(state, false);
  assert.deepEqual(await io.prFiles('o/r', 1), [{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }]);
  assert.deepEqual(await io.prFiles('o/r', 1), [{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }]);
  assert.equal(calls, 2);
}
for (const response of [
  { code: 1, stderr: 'gh: HTTP 403', stdout: 'HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1792130000\r\n\r\n{}' },
  { code: 1, stderr: 'API rate limit exceeded', stdout: '' },
  { code: 0, stderr: '', stdout: 'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n{}' },
]) {
  const io = m.realDeps(cfg, async () => response);
  await assert.rejects(() => io.prDetails('o/r', 1), m.GitHubRateLimit);
}
// Not a limit: a plain 403 (permissions) is an ordinary per-PR error, and a 200 whose body mentions "rate limit" is data.
{ const io = m.realDeps(cfg, async () => ({ code: 1, stderr: 'gh: HTTP 403 forbidden', stdout: 'HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 4000\r\n\r\n{}' }));
  await assert.rejects(() => io.prDetails('o/r', 1), e => !(e instanceof m.GitHubRateLimit)); }
{ const body = JSON.stringify({ head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) }, title: 'Respect the API rate limit' });
  const io = m.realDeps(cfg, async () => ({ code: 0, stderr: '', stdout: 'HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 4000\r\n\r\n' + body }));
  await io.prDetails('o/r', 1).catch(e => { assert.ok(!(e instanceof m.GitHubRateLimit), 'a body mentioning rate limit set a backoff'); }); }
// A tool/authorization denial mentioning the destination must never trigger a retry.
for (const error of ['Guardian denied: protected T3 destination', 'protected T3 destination: authorization denied']) {
  const attempted = [];
  const d = makeDeps({ status: async () => status({ counts: [] }),
    listPrs: async repo => repo === pr.repo ? [prRow(44, '3')] : [],
    submit: async (a, meta) => { attempted.push({ a, meta }); return { ok: false, error }; } });
  const { s } = await runOnce(d);
  assert.equal(attempted.length, 1); assert.equal(s.refused, 1);
}
// Previously remembered protected-policy refusals must not keep the PR in cooldown.
{
  const dir = fs.mkdtempSync(path.join(tmp, 'protected-history-')), saved = new m.State(dir);
  saved.refuse(m.requestId(pr.repo, 44, sha('3')), now, 'protected T3 destination');
  saved.save(now, cfg.refusal_cooldown_hours);
  const d = makeDeps({ status: async () => status({ counts: [] }),
    listPrs: async repo => repo === pr.repo ? [prRow(44, '3')] : [] });
  const { s } = await runOnce(d, {}, dir);
  assert.equal(s.submitted, 1); assert.equal(s.skipped, 0);
  assert.equal(d.submits.length, 1); assert.equal(d.submits[0].meta.delivery, 't3:report-thread-1');
}
// A partial/capacity-limited scan must not advance the incremental watermark.
{
  const d = makeDeps({ status: async () => status({ counts: [] }) });
  const { dir } = await runOnce(d, { maxSubmits: 1 });
  assert.equal(new m.State(dir).data.last_successful_run, undefined);
}

// A merged or closed PR cancels its queued and claimed requests (reason pr_closed), before the capacity gate; open PRs are untouched.
{
  const rows = [['trk-closed-q', 'queued', 'pr:example-connectors/sample-data#90'], ['trk-closed-c', 'claimed', 'pr:example-connectors/sample-data#90'], ['trk-open', 'queued', 'pr:example-connectors/sample-data#92'], ['trk-done', 'finished', 'pr:example-connectors/sample-data#90']];
  for (const [id, st, objective] of rows) put(id, st, { github_repo: 'example-connectors/sample-data' }, objective, sha('9'));
  put('trk-input', 'queued', { github_repo: 'example-connectors/sample-data', pr_number: 91 });
  const states = { 90: 'closed', 91: 'closed', 92: 'open' }, details = [], cancels = [];
  const full = { status: async () => status({ counts: [{ status: 'claimed', count: 6 }, { status: 'queued', count: 20 }] }),
    prDetails: async (repo, number) => { details.push(`${repo}#${number}`); return { state: states[number] ?? 'open' }; },
    cancel: async (id, reason) => { cancels.push([id, reason]); } };
  const first = await runOnce(makeDeps(full), { dryRun: true });
  assert.deepEqual(cancels, [], 'dry run cancels nothing');
  assert.deepEqual(lines.filter(l => l.event === 'would-cancel').map(l => l.request_id).sort(), ['trk-closed-c', 'trk-closed-q', 'trk-input']);
  details.length = 0;
  const { s } = await runOnce(makeDeps(full));
  assert.deepEqual(cancels.sort(), [['trk-closed-c', 'pr_closed'], ['trk-closed-q', 'pr_closed'], ['trk-input', 'pr_closed']], 'closed PRs cancelled with the reason; open and finished untouched');
  assert.equal(s.cancelled, 3);
  assert.equal(details.filter(d => d === 'example-connectors/sample-data#90').length, 1, 'one pulls call per PR per run, however many requests it has');
  // a failing cancel is logged, not fatal; the rest still run
  const failing = []; 
  const r = await runOnce(makeDeps({ ...full, cancel: async id => { failing.push(id); if (id === 'trk-closed-c') throw new Error('boom'); } }));
  assert.equal(failing.length, 3); assert.equal(r.s.cancelled, 2);
  assert.ok(lines.some(l => l.event === 'error' && l.stage === 'pr-closed-check' && /boom/.test(l.error)));
  bridge.prepare("delete from assignments where request_id like 'trk-%'").run();
}

// 11. Lock: a second holder is refused, a stale lock is taken over.
const lockDir = path.join(tmp, 'lock');
const release = m.acquireLock(lockDir);
assert.equal(typeof release, 'function'); assert.equal(m.acquireLock(lockDir), null);
release(); fs.writeFileSync(path.join(lockDir, 'run.lock'), '999999999');
assert.equal(typeof m.acquireLock(lockDir), 'function', 'a dead holder does not block');

// Both reviewer destinations must sanitize error text before serialization.
{
  // Known formats only; generic long-run heuristics were dropped (docs/redaction.md).
  const material = `ghp_${'ABCDEF123456abcdef'.repeat(2)}`;
  const start = lines.length;
  const { dir } = await runOnce(makeDeps({ status: async () => status({ counts: [] }), searchPrs: async () => { throw new Error(material); } }));
  const printed = JSON.stringify(lines.slice(start));
  const stored = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8');
  assert(!printed.includes(material) && printed.includes('[redacted secret]'), 'reviewer print must mask error material');
  assert(!stored.includes(material) && stored.includes('[redacted secret]'), 'reviewer file must mask error material');
}
console.log('pr-head-reviewer-test ok');
