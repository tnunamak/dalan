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
  const next = store.nextQueued(3, null, 'dot').next_queued;
  assert(next.length === 3 && next[0].request_id === 't-impl' && next[0].execution_scope === 'implementation' && next[0].scope_paths_total === 2, 'next_queued lacks triage fields: ' + JSON.stringify(next[0]));
  assert(Object.keys(next[0]).includes('title'), 'next_queued lost its title');
  log('next_queued entries carry the same triage fields');
}
console.log('list-triage-test: ok');
