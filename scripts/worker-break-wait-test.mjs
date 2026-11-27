#!/usr/bin/env node
// A worker usage break holds the child turn through the old OUTAGE_MS limit; requester cancel still interrupts it.
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

// Repeated breaks, quiet polls, and absent recovery evidence never fail the turn.
for (const active of [true, false, 'absent', null]) {
  const s = scenario(['worker_break', {status:'timeout',after:OUTAGE_MS+30}, 'worker_break', 'finished'],active);
  assert.equal((await s.completion).text,'synthetic result');
  assert.ok(s.seen.some(([channel,text])=>channel==='agent_message_chunk' && /usage break.*expected end/.test(text)));
}
// A terminal reply after the old deadline still finishes the original turn.
{
  const s=scenario(['worker_break',{status:'finished',after:OUTAGE_MS+30}],true);
  assert.equal((await s.completion).text,'synthetic result');
}
// A stalled wait stays held past the old break deadline, then requester cancel releases it.
{
  const s=scenario(['worker_break','hang'],true);
  let settled=false;s.completion.then(()=>{settled=true;});
  await sleep(OUTAGE_MS+60);assert.equal(settled,false);
  s.ctl.cancelled=true;s.ctl.abort.abort();
  assert.equal((await s.completion).cancelled,true);
}
clearInterval(keepAlive);
console.log('worker-break-wait-test: PASS (6 held-break and cancel scenarios)');
