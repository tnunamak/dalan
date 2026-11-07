#!/usr/bin/env node
// Replays a synthetic queue sequence against a Store with an injected clock. Three claims
// of later-listed work must mark the older queued item as skipped_by_worker.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';

// Scheduling cases: idle own claims would add resume entries to list_pending (covered by resume-wake-test).
process.env.DOT_BRIDGE_RESUME_IDLE_MS = '0';

const home = await mkdtemp(join(tmpdir(), 'dalan-bridge-skip-evidence-'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const STUCK = 'synthetic-stuck-item', SUBJECT = 'local-principal', MIN = 60000;
const fixture = JSON.parse(await readFile(new URL('./fixtures/skip-evidence-live.json', import.meta.url), 'utf8'));
const payload = id => ({ schema_version: 1, request_id: id, brief: `replay ${id}`, inputs: [{ revision: 'abc' }], expected_output: 'one result', execution_scope: 'read-only' });
const limits = { intervalMs: 10 * MIN, maxCount: 3, silenceMs: 20 * MIN, leaseMs: 3600000, laneCapacity: 6, rewakeMs: 90000, rewakeWindowMs: 48 * 3600000, breakSilenceMs: 20 * MIN, breakProbeMs: 30 * MIN };
try {
  let now = Date.parse(fixture.events[0].at);
  const s = new Store(join(home, 'replay.db'), { now: () => now, capacity: 6, limits, backgroundMaxInFlight: 10 });
  const priority = Object.fromEntries(fixture.items.map(i => [i.id, i.priority]));
  const timeline = [...fixture.events.map(e => ({ ...e, kind: 'event' })), ...fixture.polls.map(at => ({ at, kind: 'poll' }))].sort((a, b) => a.at.localeCompare(b.at));
  const claimIds = new Map(), submitted = new Set(), polls = [];
  let markedAt = null;
  for (const step of timeline) {
    now = Date.parse(step.at);
    if (step.kind === 'poll') {
      const listed = s.listPending(), free = s.freeLanes(SUBJECT,'dot',6,6);
      s.recordListed(listed, free);
      const pos = listed.findIndex(x => x.request_id === STUCK);
      polls.push({ at: step.at, free, pos: pos + 1, ids: listed.map(x => x.request_id) });
      continue;
    }
    if (!priority[step.id]) continue;
    if (step.type === 'queued' && !submitted.has(step.id)) { s.submit(payload(step.id), 'thread-x', 'e', 'owner', false, null, priority[step.id]); submitted.add(step.id); }
    else if (step.type === 'claimed' && submitted.has(step.id) && s.get(step.id).status === 'queued') { claimIds.set(step.id, s.claim(step.id, 'dot', SUBJECT, 6).claim_id); }
    else if (step.type === 'completed' && claimIds.has(step.id)) s.finish(step.id, claimIds.get(step.id), 'completed', 'done', 'done');
    else if (step.type === 'cancelled' && submitted.has(step.id)) s.cancel(step.id);
    else if (step.type === 'abandoned' && claimIds.has(step.id)) { s.abandon(step.id, { actor: 'system', reason: 'replay' }); claimIds.delete(step.id); }
    if (!markedAt && s.hasAssignment(STUCK) && s.get(STUCK).skipped_by_worker) markedAt = step.at;
  }
  const stuckPolls = polls.filter(p => p.pos > 0);
  assert(stuckPolls.length >= 4, `the replay lists the stuck item during the synthetic sequence: ${stuckPolls.length}`);
  assert(s.get(STUCK).status === 'queued', 'replay ends with the stuck item still queued');
  assert(markedAt && markedAt <= '2000-01-01T00:03:30.000Z', `three later claims mark the item as skipped: ${markedAt}`);
  assert(s.get(STUCK).skipped_by_worker.passed_over >= 3, 'three later claims pass over the queued item');
  const last = s.listPending().filter(x => x.kind === 'assignment'), lastBackground = last.filter(x => priority[x.request_id] === 'background');
  assert(lastBackground.length > 1 && lastBackground.at(-1).request_id === STUCK, `once skipped it sits behind its background peers: ${lastBackground.map(x => x.request_id)}`);
  // Before it was marked the item was at the head for free lanes: the worker had it in its claimable window.
  const headBefore = polls.filter(p => p.at < markedAt && p.pos > 0 && p.pos <= p.free);
  assert(headBefore.length > 0, 'the item was inside the claimable window before it was marked skipped');
  console.log(`PASS replay of ${polls.length} synthetic polls: item in claimable window ${headBefore.length}x, marked skipped_by_worker at ${markedAt}, ends behind its background peers`);
  s.db.close();
} finally { await rm(home, { recursive: true, force: true }); }
