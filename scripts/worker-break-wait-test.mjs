#!/usr/bin/env node
// The adapter's wait loop bounds a usage break (worker_break) by OUTAGE_MS and ends that bound when the worker is active again.
// This evaluates the real waitLoop from bin/dot-acp-agent.mjs with a scripted `call`, a real AbortSignal and real timers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../bin/dot-acp-agent.mjs', import.meta.url), 'utf8');
const start = source.indexOf('\nasync function waitLoop('), end = source.indexOf('\nasync function readRowOrThrow(', start);
assert.ok(start >= 0 && end > start, 'waitLoop not found');
const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers do not hold the process open
setTimeout(() => { console.error('FAIL worker-break-wait-test exceeded 10 s (a wait was not bounded)'); process.exit(1); }, 10000).unref();
const OUTAGE_MS = 150;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// `steps` entries: a status string, {status, after: ms to wait first}, or 'hang' (pending until its signal aborts).
// `breakActive` is what the bridge's owner-states reply reports in refill.break_active: true, false, or 'absent' (an older
// bridge without the field) or null (no reply).
function scenario(steps, breakActive = false, confirmMs = 20) {
  let index = 0;
  const ctl = { cancelled: false, pending: { rid: 'fixture' }, abort: new AbortController() };
  const seen = [];
  const run = runInNewContext(source.slice(start, end) + '\nwaitLoop', {
    Date, AbortSignal, Math, encodeURIComponent, HEARTBEAT_MS: 10, OUTAGE_MS, RECOVERY_CHECK_MS: 500,
    sleep, transient: () => false, publishPending: () => {},
    // Signal-aware like the real one: an aborted signal means no reply. The bridge answers after confirmMs.
    heartbeat: async (_s, _c, say, _note, signal) => {
      await say('agent_thought_chunk', 'heartbeat');
      await sleep(confirmMs);
      if (signal.aborted) return null;
      return breakActive === null ? null : { refill: breakActive === 'absent' ? {} : { break_active: breakActive } };
    },
    call: async (_path, _rid, { signal }) => {
      const step = steps[index++];
      assert.ok(step, 'unexpected extra wait');
      if (step === 'hang') {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      }
      const { status, after = 0 } = typeof step === 'string' ? { status: step } : step;
      if (after) await sleep(after);
      return { status };
    },
    refuse: (message, details) => Object.assign(new Error(message), details),
    readRowOrThrow: async () => ({}), resultText: async () => 'synthetic result', trackBuild: () => {},
  });
  return { completion: run({}, ctl, async (channel, text) => seen.push([channel, text])), seen, ctl };
}

// 1. A break that never ends is refused, even when the wait request is stalled (the real abort signal ends it).
{
  const t = Date.now();
  const s = scenario(['worker_break', 'hang'], true);
  await assert.rejects(s.completion, { failure_type_source: 'dot_acp_worker_break' });
  assert.ok(Date.now() - t < OUTAGE_MS * 4, 'stalled wait was not bounded by the break deadline');
}
// 2. Repeated breaks past the deadline are refused.
{
  const s = scenario([{ status: 'worker_break', after: 0 }, { status: 'worker_break', after: OUTAGE_MS + 20 }, 'finished']);
  await assert.rejects(s.completion, { failure_type_source: 'dot_acp_worker_break' });
}
// 3. Break, then the bridge reports no active break (the worker recovered) and healthy work runs past the original deadline:
//    not refused.
{
  const s = scenario(['worker_break', { status: 'timeout', after: OUTAGE_MS + 30 }, { status: 'timeout', after: 20 }, 'finished'], false);
  assert.equal((await s.completion).text, 'synthetic result');
}
// 4. After recovery, a second break gets a fresh limit (is not refused at once by the first one's deadline).
{
  const s = scenario(['worker_break', { status: 'timeout', after: OUTAGE_MS + 30 }, 'worker_break', 'finished'], false);
  assert.equal((await s.completion).text, 'synthetic result');
}
// 4b. A break that is still active: a single notice and then quiet polls do not cancel the limit.
for (const [label, active] of [['still active', true], ['older bridge without the field', 'absent'], ['bridge gave no answer', null]]) {
  const s = scenario(['worker_break', { status: 'timeout', after: OUTAGE_MS + 30 }, 'finished'], active);
  await assert.rejects(s.completion, { failure_type_source: 'dot_acp_worker_break' }, `quiet poll ended the break limit: ${label}`);
}
{
  const s = scenario(['worker_break', 'timeout', { status: 'timeout', after: OUTAGE_MS + 30 }, 'finished'], true);
  await assert.rejects(s.completion, { failure_type_source: 'dot_acp_worker_break' }, 'a quiet poll before the deadline ended the break limit');
}
// 4c. A terminal reply that arrives after the deadline still wins.
{
  const s = scenario(['worker_break', { status: 'finished', after: OUTAGE_MS + 30 }], true);
  assert.equal((await s.completion).text, 'synthetic result');
}
// 4d. The wait is cut off at the limit, but the bridge confirms the break ended: the confirmation is not aborted by the expired
//     break signal, and the turn goes on. If the break is still active, the turn is refused.
{
  const s = scenario(['worker_break', 'hang', 'finished'], false);
  assert.equal((await s.completion).text, 'synthetic result');
}
{
  const s = scenario(['worker_break', 'hang', 'finished'], true);
  await assert.rejects(s.completion, { failure_type_source: 'dot_acp_worker_break' });
}
// 4e. Cancel while that confirmation is in flight returns cancelled, not a break refusal.
{
  const s = scenario(['worker_break', 'hang'], true, 300);
  setTimeout(() => { s.ctl.cancelled = true; s.ctl.abort.abort(); }, OUTAGE_MS + 60);
  assert.equal((await s.completion).cancelled, true);
}
// 5. Cancel during a break returns cancelled.
{
  const s = scenario(['worker_break', 'hang']);
  setTimeout(() => { s.ctl.cancelled = true; s.ctl.abort.abort(); }, 40);
  assert.equal((await s.completion).cancelled, true);
}
clearInterval(keepAlive);
console.log('worker-break-wait-test: PASS');
