#!/usr/bin/env node
// Scheduling under the rolling-usage estimates, store level with an injected clock. No estimate (claims, tool calls,
// response bytes; hourly or 24 h; configured or learned) holds either class of work: reaching one is reported as
// over_estimate and changes no re-wake, list_pending entry or submit event. What remains is ordering: agent-requested
// (normal) work is named and listed ahead of background work.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';

// Scheduling cases: idle own claims would add resume entries to list_pending (covered by resume-wake-test).
process.env.DOT_BRIDGE_RESUME_IDLE_MS = '0';
import { explainStatus } from '../src/status-evidence.mjs';

const home = await mkdtemp(join(tmpdir(), 'dalan-bridge-fairness-'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const MIN = 60000, HOUR = 3600000, key = `whsec_${randomBytes(32).toString('base64')}`;
let now = Date.parse('2026-10-09T00:00:00.000Z');
const payload = id => ({ schema_version: 1, request_id: id, brief: `fairness ${id}`, inputs: [{ revision: 'abc' }], expected_output: 'one result', execution_scope: 'read-only' });
const base = { intervalMs: 10 * MIN, maxCount: 3, silenceMs: 20 * MIN, leaseMs: HOUR, laneCapacity: 6, rewakeMs: 90000, rewakeWindowMs: 48 * HOUR, breakSilenceMs: 20 * MIN, breakProbeMs: 30 * MIN, maxClaimsPerHour: 30, maxToolCallsPerHour: 1000, maxResponseBytesPerHour: 2500000 };
const fresh = (name, limits = base) => { const s = new Store(join(home, `${name}.db`), { now: () => now, capacity: 100, limits, backgroundMaxInFlight: 10 }); s.subscribe('sub_a', 'http://127.0.0.1/hook', key, new Date(now + 480 * HOUR).toISOString()); return s; };
const submit = (s, id, priority) => s.submit(payload(id), 'thread-x', 'e', 'owner', false, null, priority);
const deliverAll = s => s.db.prepare("UPDATE notifications SET state='delivered',attempt_started_at=COALESCE(attempt_started_at,?) WHERE kind='event' AND state IN ('pending','sending','failed')").run(s.stamp());
const calls = (s, n) => { for (let i = 0; i < n; i++) s.recordWorkerCall('dot', 'get'); };
// What the last tick named: the request ids of new rewake events.
const tickNamed = (s, limits) => {
  const before = s.db.prepare("SELECT count(*) n FROM notifications WHERE wake_kind='rewake'").get().n;
  const result = s.reannounceQueued(limits);
  const named = s.db.prepare("SELECT request_id FROM notifications WHERE wake_kind='rewake' ORDER BY rowid").all().slice(before).map(r => r.request_id);
  return { ...result, named };
};
// Each estimate, reached: one hourly estimate per kind, and the 24 h estimate.
const gates = {
  claims_per_hour: { limits: { ...base, maxClaimsPerHour: 1 }, trip: s => { submit(s, 'burn', 'normal'); s.claim('burn', 'dot', 'local-principal', 6); } },
  tool_calls_per_hour: { limits: { ...base, maxToolCallsPerHour: 5 }, trip: s => calls(s, 6) },
  response_bytes_per_hour: { limits: { ...base, maxResponseBytesPerHour: 100000 }, trip: s => { s.recordWorkerCall('dot', 'read_file'); s.recordResponseBytes('dot', 'read_file', 100000); } },
  tool_calls_per_24h: { limits: { ...base, maxToolCallsPerHour: 100000, maxToolCallsPer24h: 10 }, trip: s => calls(s, 11) },
};
const nothingHeld = (u, name) => u.over_estimate.includes(name) && !u.rewake_throttled && !u.submit_throttled && !u.normal_rewake_throttled && JSON.stringify(u.holding) === '{"rewake":[],"submit":[]}';

try {
  // Priority orders work and never hides or refuses it: normal first (oldest first), background after, at any normal age.
  {
    const s = fresh('normal-precedence');
    submit(s, 'bg1', 'background'); now += 1;
    submit(s, 'bg2', 'background'); now += 1;
    submit(s, 'n1', 'normal');
    const normals = ['n1'];
    for (const age of [0, 5 * MIN, 10 * MIN, MIN, 30 * MIN]) {
      now += age;
      normals.push(`n_${now}`); submit(s, normals.at(-1), 'normal');
      const ids = s.listPending().map(x => x.request_id);
      assert(ids.join() === [...normals, 'bg1', 'bg2'].join(), `normal first (oldest first), background after, at any normal age: ${ids}`);
      const rows = s.queuedRows().map(x => x.request_id);
      assert(rows.join() === ids.join(), `queuedRows must match list_pending order: ${rows} vs ${ids}`);
    }
    assert(s.claim('bg1', 'dot', 'local-principal', 6).claim_id, 'background claim must not be refused because normal work is waiting');
    assert(s.db.prepare("SELECT count(*) n FROM assignments WHERE status='queued' AND priority='normal'").get().n > 0, 'normal work still queued after the background claim');
    s.db.close();
    console.log('PASS priority orders list_pending and queuedRows, never hides or refuses background work');
  }

  // An item that stays among the claimable ones 10 minutes after it first was, or that the worker passes over by claiming three
  // items listed behind it, is marked skipped_by_worker, moves behind its peers, is reported, and clears on claim. A full house
  // forgets the clock: waiting for a lane is not a skip.
  {
    const s = fresh('skipped-by-worker');
    submit(s, 'n1', 'normal'); now += 1; submit(s, 'n2', 'normal'); now += 1; submit(s, 'bg1', 'background');
    const poll = free => { now += 1000; s.recordListed(s.listPending(), free); };
    for (let i = 0; i < 25; i++) poll(0);
    assert(s.skippedByDot().length === 0, 'no free lane: waiting for a lane is not a skip');
    poll(1); now += 9 * MIN; poll(1);
    assert(s.get('n1').skipped_by_worker === null, 'nine minutes of claimable polls must not mark');
    poll(0); now += 2 * MIN; poll(1); now += 9 * MIN; poll(1);
    assert(s.get('n1').skipped_by_worker === null, 'a full house resets the eligible clock');
    now += 2 * MIN; poll(1);
    assert(s.get('n1').skipped_by_worker !== null, 'ten minutes claimable, never claimed: marked: ' + JSON.stringify(s.get('n1').skipped_by_worker));
    assert(s.get('n2').skipped_by_worker === null && s.get('bg1').skipped_by_worker === null, 'only the item in the claimable position is marked');
    assert(s.listPending().map(x => x.request_id).join() === 'n2,n1,bg1', 'skipped normal goes behind its normal peers: ' + s.listPending().map(x => x.request_id));
    assert(s.queuedRows().map(x => x.request_id).join() === 'n2,n1,bg1', 'queuedRows follows');
    const st = s.status({ limits: base });
    assert(st.skipped_by_worker.count === 1 && st.skipped_by_worker.request_ids.join() === 'n1', 'status.skipped_by_worker: ' + JSON.stringify(st.skipped_by_worker));
    assert(s.claim('n1', 'dot', 'local-principal', 6).claim_id && s.get('n1').skipped_by_worker === null && s.skippedByDot().length === 0, 'claim clears the mark');
    s.db.close();
    console.log('PASS skipped_by_worker is marked after 10 claimable minutes, reorders, reports, and clears on claim');
  }

  // Passed over: claims of items listed behind it, which the worker saw it list, mark it at the third.
  {
    const s = fresh('passed-over');
    for (const id of ['old', 'b1', 'b2', 'b3', 'b4']) { submit(s, id, 'background'); now += 1000; }
    const claim = id => { now += 1000; s.claim(id, 'dot', 'local-principal', 6); };
    claim('b1'); // 'old' was never listed to the worker: new work ordering ahead of an unseen item is not a pass-over
    assert(s.get('old').skipped_by_worker === null && s.db.prepare("SELECT passed_over n FROM assignments WHERE request_id='old'").get().n === 0, 'an item the worker has not listed is not passed over');
    s.recordListed(s.listPending(), 5); now += 1000;
    claim('b2'); claim('b3');
    assert(s.get('old').skipped_by_worker === null, 'two pass-overs do not mark');
    claim('b4');
    assert(s.get('old').skipped_by_worker?.passed_over === 3, 'third pass-over marks: ' + JSON.stringify(s.get('old').skipped_by_worker));
    now += 4 * MIN; submit(s, 'b5', 'background'); now += 1000; submit(s, 'b6', 'background'); now += 1000;
    claim('b6'); // b5 ordered ahead of b6 but listed after the worker's last poll: not a pass-over
    assert(s.db.prepare("SELECT passed_over n FROM assignments WHERE request_id='b5'").get().n === 0, 'unseen item: no pass-over');
    s.db.close();
    console.log('PASS claims of later-listed items mark a seen item skipped_by_worker at the third; unseen ones never count');
  }

  for (const [name, gate] of Object.entries(gates)) {
    // normal and background both queued, the estimate reached: the re-wake still goes out and names the agent's task first
    let s = fresh(`mixed-${name}`, gate.limits);
    submit(s, 'bg1', 'background'); submit(s, 'n1', 'normal'); deliverAll(s); gate.trip(s); deliverAll(s); now += 2 * MIN;
    const u = s.rollingUsage(gate.limits);
    assert(nothingHeld(u, name), `${name}: estimate not reached, or something is held: ${JSON.stringify(u)}`);
    let t = tickNamed(s, gate.limits);
    assert(t.announced === 1 && t.named.join() === 'n1' && t.throttled === undefined, `${name}: re-wake did not name the agent task: ${JSON.stringify(t)}`);
    assert(s.listPending().map(x => x.request_id).join() === 'n1,bg1', `${name}: list_pending: ${JSON.stringify(s.listPending())}`);
    s.db.close();

    // only background queued: woken and listed, not held
    s = fresh(`bg-${name}`, gate.limits);
    submit(s, 'bg1', 'background'); deliverAll(s); gate.trip(s); deliverAll(s); now += 2 * MIN;
    t = tickNamed(s, gate.limits);
    assert(t.announced === 1 && t.named.join() === 'bg1' && t.throttled === undefined, `${name}: background held by an estimate: ${JSON.stringify(t)}`);
    assert(s.listPending().map(x => x.request_id).join() === 'bg1', `${name}: background hidden from list_pending by an estimate`);
    s.db.close();

    // only agent work queued: woken; a submit event is never held
    s = fresh(`n-${name}`, gate.limits);
    submit(s, 'n1', 'normal'); deliverAll(s); gate.trip(s); deliverAll(s); now += 2 * MIN;
    t = tickNamed(s, gate.limits);
    assert(t.named.join() === 'n1', `${name}: agent task held by an estimate: ${JSON.stringify(t)}`);
    const wakes = s.db.prepare("SELECT count(*) n FROM notifications WHERE request_id=? AND wake_kind='submit'");
    submit(s, 'n2', 'normal'); submit(s, 'bg2', 'background');
    assert(wakes.get('n2').n === 1 && wakes.get('bg2').n === 1, `${name}: submit event held`);
    // the send-time check does not drop a queued re-wake for an estimate
    assert(s.rewakeStale({ subscription_id: s.activeSubscriptions()[0].id, request_id: 'n1' }) === null, `${name}: queued re-wake dropped for an estimate`);
    s.db.close();
    console.log(`PASS ${name}: reaching the estimate reports over_estimate and holds nothing (re-wake, list_pending, submit events, send-time check)`);
  }

  // swept: every estimate against every queue mix wakes work, never background ahead of an agent task
  for (const [gateName, gate] of [['none', null], ...Object.entries(gates)]) {
    for (const queue of [['normal'], ['background'], ['normal', 'background'], ['background', 'normal', 'background']]) {
      const lim = gate?.limits ?? base, s = fresh(`sweep-${gateName}-${queue.join('-')}`, lim);
      queue.forEach((priority, i) => submit(s, `q${i}${priority[0]}`, priority)); deliverAll(s);
      if (gate) gate.trip(s); deliverAll(s); now += 2 * MIN;
      const t = tickNamed(s, lim), hasNormal = queue.includes('normal');
      assert(t.announced === 1 && t.named.length > 0, `${gateName}/${queue}: work not woken: ${JSON.stringify(t)}`);
      assert(!(hasNormal && t.named.some(id => id.endsWith('b'))), `${gateName}/${queue}: background woken ahead of an agent task: ${JSON.stringify(t)}`);
      assert(!hasNormal || t.named.some(id => id.endsWith('n')), `${gateName}/${queue}: an agent task was not named: ${JSON.stringify(t)}`);
      s.db.close();
    }
  }
  console.log('PASS swept every estimate against every queue mix: work is always woken, agent work ahead of background');

  // far over an estimate holds nothing either (the old agent headroom of 1.5x is gone)
  {
    const lim = { ...base, maxToolCallsPerHour: 10 }, s = fresh('far-over', lim);
    submit(s, 'bg1', 'background'); submit(s, 'n1', 'normal'); deliverAll(s); calls(s, 100); now += 2 * MIN;
    assert(nothingHeld(s.rollingUsage(lim), 'tool_calls_per_hour') && tickNamed(s, lim).named.join() === 'n1', 'agent task held at 10x an estimate');
    s.db.close();
    console.log('PASS ten times an estimate still holds nothing');
  }

  // a limit learned from a break is an estimate like the others: reported with its source, holds nothing
  {
    const s = fresh('learned', base); submit(s, 'bg1', 'background'); submit(s, 'n1', 'normal'); deliverAll(s);
    // what learnFromBreak writes: 70% of the busiest hour, as the effective hourly tool-call limit (above the 25% floor of 250)
    s.db.prepare("INSERT INTO learned_limits(name,value,break_id,ledger_bytes,at) VALUES('tool_calls_per_hour',300,1,0,?)").run(s.stamp());
    calls(s, 310); now += 2 * MIN;
    const after = s.rollingUsage(base);
    assert(after.max_tool_calls_per_hour === 300 && nothingHeld(after, 'tool_calls_per_hour'), 'learned hourly limit holds or is not reported: ' + JSON.stringify(after));
    const over = s.overEstimate(base);
    assert(over.length === 1 && over[0].name === 'tool_calls_per_hour' && over[0].used === 310 && over[0].limit === 300 && over[0].configured === 1000 && over[0].learned === 300 && over[0].break_id === 1, 'overEstimate: ' + JSON.stringify(over));
    deliverAll(s); const named = tickNamed(s, base).named; assert(named.join() === 'n1', 'under a learned limit the re-wake names agent work first: ' + named);
    s.db.close();
    console.log('PASS a learned limit is reported by overEstimate with configured, learned and break, and holds nothing');
  }

  // the explain token names the estimates reached and no longer reports a throttle
  {
    const gate = gates.tool_calls_per_hour;
    let s = fresh('explain', gate.limits); submit(s, 'n1', 'normal'); deliverAll(s);
    assert(!/over_estimate|throttle=/.test(explainStatus(s.status({ limits: gate.limits }))), 'explain names an estimate before it is reached');
    gate.trip(s);
    const text = explainStatus(s.status({ limits: gate.limits }));
    assert(/ over_estimate=tool_calls_per_hour$/.test(text) && !/throttle=|holding:|agent_work/.test(text), 'explain: ' + text);
    s.db.close();
    console.log('PASS explain names over_estimate, not a throttle');
  }
  console.log('PASS gate fairness test');
} finally { await rm(home, { recursive: true, force: true }); }
