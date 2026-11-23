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
const OUTAGE_MS = 150;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// `steps` entries: a status string, {status, after: ms to wait first}, or 'hang' (pending until its signal aborts).
function scenario(steps) {
  let index = 0;
  const ctl = { cancelled: false, pending: { rid: 'fixture' }, abort: new AbortController() };
  const seen = [];
  const run = runInNewContext(source.slice(start, end) + '\nwaitLoop', {
    Date, AbortSignal, Math, encodeURIComponent, HEARTBEAT_MS: 10, OUTAGE_MS,
    sleep, transient: () => false, publishPending: () => {},
    heartbeat: async (_s, _c, say) => say('agent_thought_chunk', 'heartbeat'),
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
  const s = scenario(['worker_break', 'hang']);
  await assert.rejects(s.completion, { failure_type_source: 'dot_acp_worker_break' });
  assert.ok(Date.now() - t < OUTAGE_MS * 4, 'stalled wait was not bounded by the break deadline');
}
// 2. Repeated breaks past the deadline are refused.
{
  const s = scenario([{ status: 'worker_break', after: 0 }, { status: 'worker_break', after: OUTAGE_MS + 20 }, 'finished']);
  await assert.rejects(s.completion, { failure_type_source: 'dot_acp_worker_break' });
}
// 3. Break, then healthy work (timeout heartbeats) lasting beyond the original deadline, then completion: not refused.
{
  const s = scenario(['worker_break', { status: 'timeout', after: OUTAGE_MS + 30 }, { status: 'timeout', after: 20 }, 'finished']);
  assert.equal((await s.completion).text, 'synthetic result');
}
// 4. After recovery, a second break gets a fresh limit (is not refused at once by the first one's deadline).
{
  const s = scenario(['worker_break', { status: 'timeout', after: OUTAGE_MS + 30 }, 'worker_break', 'finished']);
  assert.equal((await s.completion).text, 'synthetic result');
}
// 5. Cancel during a break returns cancelled.
{
  const s = scenario(['worker_break', 'hang']);
  setTimeout(() => { s.ctl.cancelled = true; s.ctl.abort.abort(); }, 40);
  assert.equal((await s.completion).cancelled, true);
}
clearInterval(keepAlive);
console.log('worker-break-wait-test: PASS');
