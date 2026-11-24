#!/usr/bin/env node
// list_pending items carry the triage fields a coordinator needs to decide which queued jobs are independent:
// repository pin, execution scope, scope and output paths, priority and review.
// Response data only: the tool description and input schema are unchanged (catalog-golden-test proves that).
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';

const home = await mkdtemp(join(tmpdir(), 'dalan-list-triage-'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const log = message => console.log(`PASS ${message}`);
const SHA = 'a'.repeat(40);
let now = Date.parse('2026-11-24T00:00:00.000Z');
const store = new Store(join(home, 'bridge.db'), { now: () => now, capacity: 6 });
const body = (id, extra = {}) => ({ schema_version: 1, request_id: id, brief: `triage test ${id}`, inputs: [{ github_repo: 'tnunamak/dalan', base_sha: SHA }], expected_output: 'one result', execution_scope: 'read-only', ...extra });
const item = id => store.listPending('dot').find(x => x.request_id === id);

store.submit(body('t-impl', { execution_scope: 'implementation', scope_paths: ['src/a.mjs', 'src/b.mjs'], output_paths: ['src/new.mjs'] }), 't', 'e', 'owner');
now += 1000;
store.submit(body('t-read'), 't', 'e', 'owner', false, null, 'background');
now += 1000;
const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.mjs`);
store.submit(body('t-many', { execution_scope: 'implementation', scope_paths: many }), 't', 'e', 'owner');

{
  const a = item('t-impl');
  assert(a.execution_scope === 'implementation', 'execution_scope missing: ' + JSON.stringify(a));
  assert(JSON.stringify(a.repos) === JSON.stringify([{ github_repo: 'tnunamak/dalan', base_sha: SHA }]), 'repos missing: ' + JSON.stringify(a.repos));
  assert(JSON.stringify(a.scope_paths) === '["src/a.mjs","src/b.mjs"]' && a.scope_paths_total === 2, 'scope_paths missing: ' + JSON.stringify(a));
  assert(JSON.stringify(a.output_paths) === '["src/new.mjs"]' && a.output_paths_total === 1, 'output_paths missing: ' + JSON.stringify(a));
  assert(a.priority === 'normal' && a.review === false, 'priority/review missing: ' + JSON.stringify(a));
  assert(a.title === 'triage test t-impl' && a.kind === 'assignment' && typeof a.created_at === 'string', 'existing fields changed: ' + JSON.stringify(a));
  log('implementation item lists repo pin, scope, output paths, priority and review');
}
{
  const r = item('t-read');
  assert(r.execution_scope === 'read-only' && r.priority === 'background', 'read-only/background item: ' + JSON.stringify(r));
  assert(!('scope_paths' in r) && !('output_paths' in r), 'absent paths must be absent, not empty: ' + JSON.stringify(r));
  log('read-only background item omits absent path lists');
}
{
  const m = item('t-many');
  assert(m.scope_paths.length === 10 && m.scope_paths_total === 25 && m.scope_paths[9] === 'src/f9.mjs', 'scope_paths not capped at 10 with a total: ' + JSON.stringify(m));
  log('long path lists are capped at 10 and carry the total');
}
{
  // A scheduler must read a total above the shown length as "scope not fully shown", so outputs carry totals too.
  store.submit(body('t-out', { execution_scope: 'implementation', output_paths: many, scope_paths: ['src/x.mjs', 7, null] }), 't', 'e', 'owner');
  const o = item('t-out');
  assert(o.output_paths.length === 10 && o.output_paths_total === 25, 'output_paths not capped with a total: ' + JSON.stringify(o));
  assert(JSON.stringify(o.scope_paths) === '["src/x.mjs"]' && o.scope_paths_total === 1, 'non-string paths must be dropped: ' + JSON.stringify(o));
  log('output paths are capped with a total; non-string paths are dropped');
}
{
  store.submit(body('t-two', { inputs: [{ github_repo: 'a/b', base_sha: SHA }, { github_repo: 'c/d' }, { revision: 'x' }] }), 't', 'e', 'owner', true);
  const w = item('t-two');
  assert(JSON.stringify(w.repos) === JSON.stringify([{ github_repo: 'a/b', base_sha: SHA }, { github_repo: 'c/d' }]), 'repos: ' + JSON.stringify(w.repos));
  assert(w.review === true, 'review true expected: ' + JSON.stringify(w));
  store.submit({ schema_version: 1, request_id: 't-norepo', brief: 'no repo', inputs: [{ revision: 'abc' }], expected_output: 'x', execution_scope: 'read-only' }, 't', 'e', 'owner');
  assert(!('repos' in item('t-norepo')), 'repos must be absent without a repository input');
  log('several repositories, a review job and a job without a repository');
}
{
  // A destination-blocked row keeps its old shape (id, title, time, blocked): it is not claimable, so no scope, output path or total is announced.
  store.submit(body('t-blk', { execution_scope: 'implementation', scope_paths: ['src/a.mjs'], output_paths: ['src/new.mjs'] }), 't', 'e', 'owner');
  store.db.prepare('INSERT INTO destination_blocks(request_id,body) VALUES(?,?)').run('t-blk', JSON.stringify({ error: 'destination_changed' }));
  const snap = store.destinationSnapshot.bind(store), appr = store.destinationApproval.bind(store);
  store.destinationSnapshot = () => ({ revision: 'r', policy: { allowed: false } });
  store.destinationApproval = () => null;
  const b = item('t-blk');
  const queuedIds = store.nextQueued(50, null, 'dot').next_queued.map(x => x.request_id);
  store.destinationSnapshot = snap; store.destinationApproval = appr;
  assert(b && b.blocked === true, 'row did not become blocked: ' + JSON.stringify(b));
  for (const k of ['execution_scope', 'repos', 'scope_paths', 'scope_paths_total', 'output_paths', 'output_paths_total', 'priority', 'review']) assert(!(k in b), `blocked row exposes ${k}: ` + JSON.stringify(b));
  assert(JSON.stringify(Object.keys(b)) === '["kind","request_id","title","created_at","blocked"]', 'blocked row shape changed: ' + JSON.stringify(Object.keys(b)));
  assert(!queuedIds.includes('t-blk'), 'blocked row offered in next_queued');
  log('a destination-blocked row announces no triage fields and is not in next_queued');
  store.db.prepare('DELETE FROM destination_blocks WHERE request_id=?').run('t-blk');
}
{
  // Two same-pin jobs whose shown prefixes are disjoint and whose omitted tails overlap: next_queued must carry both totals, so a
  // scheduler can see that the shown lists are not the whole scope (a total above the shown length means overlap is unknown).
  const tail = Array.from({ length: 5 }, (_, i) => `src/tail${i}.mjs`);
  const mk = (id, p) => store.submit(body(id, { execution_scope: 'implementation', scope_paths: [...Array.from({ length: 10 }, (_, i) => `${p}${i}.mjs`), ...tail], output_paths: [...Array.from({ length: 10 }, (_, i) => `out/${p}${i}.mjs`), ...tail, 7] }), 't', 'e', 'owner');
  mk('t-cap1', 'src/p'); mk('t-cap2', 'src/q');
  const n = store.nextQueued(50, null, 'dot').next_queued.filter(x => x.request_id.startsWith('t-cap'));
  assert(n.length === 2, 'capped jobs missing from next_queued: ' + JSON.stringify(n));
  for (const e of n) {
    assert(e.scope_paths.length === 10 && e.scope_paths_total === 15, 'next_queued scope cap/total: ' + JSON.stringify(e));
    assert(e.output_paths.length === 10 && e.output_paths_total === 15 && e.output_paths.every(p => typeof p === 'string'), 'next_queued output cap/total or non-string entry: ' + JSON.stringify(e));
  }
  assert(n[0].scope_paths.every(p => !n[1].scope_paths.includes(p)), 'fixture must have disjoint shown prefixes');
  log('capped totals and string-only output entries survive next_queued');
}
{
  // Resume entries keep the next_queued shape they always had (request_id only); the projection must not add or carry keys for them.
  // This pins today's behavior only. That a resume entry can take a slot ahead of fresh work is an older behavior and not changed here.
  const real = store.listPending.bind(store);
  store.listPending = () => [{ kind: 'assignment', request_id: 'r-resume', resume: true, idle_seconds: 130, previous_epoch: 1, note: 'resume' }, ...real('dot')];
  const next = store.nextQueued(2, null, 'dot').next_queued;
  store.listPending = real;
  assert(JSON.stringify(next[0]) === '{"request_id":"r-resume"}', 'resume entry changed shape: ' + JSON.stringify(next[0]));
  log('a resume entry in next_queued is unchanged');
}
{
  const next = store.nextQueued(3, null, 'dot').next_queued;
  assert(next.length === 3 && next[0].request_id === 't-impl' && next[0].execution_scope === 'implementation' && next[0].scope_paths_total === 2, 'next_queued lacks triage fields: ' + JSON.stringify(next[0]));
  assert(Object.keys(next[0]).includes('title'), 'next_queued lost its title');
  log('next_queued entries carry the same triage fields');
}
console.log('list-triage-test: ok');
