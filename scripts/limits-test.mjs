#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBackgroundMaxInFlight, loadMainThreadIds, t3ReadToolsOff } from '../src/limits.mjs';
import { loadCapacity } from '../src/projects.mjs';
import { loadRedeliveryLimits } from '../src/store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-bridge-limits-'));
const file = path.join(dir, 'limits.json');
const write = (value, mode = 0o600) => { fs.writeFileSync(file, JSON.stringify(value), { mode }); fs.chmodSync(file, mode); };
try {
  assert.deepEqual(loadMainThreadIds(file), [], 'missing file defaults to []');
  assert.equal(loadBackgroundMaxInFlight(file), 4, 'missing background cap defaults');
  assert.equal(t3ReadToolsOff(file), false, 'missing file: read tools on');
  write({ t3_read_tools: 'off' }); assert.equal(t3ReadToolsOff(file), true);
  write({ t3_read_tools: 'on' }); assert.equal(t3ReadToolsOff(file), false);
  write({}); assert.equal(t3ReadToolsOff(file), false, 'missing key: read tools on');
  for (const bad of [false, 'OFF', 0]) { write({ t3_read_tools: bad }); assert.throws(() => t3ReadToolsOff(file), /invalid t3_read_tools/, JSON.stringify(bad)); }
  write({ max_claimed_outer_assignments: 1 });
  assert.deepEqual(loadMainThreadIds(file), [], 'missing key defaults to []');
  write({ main_thread_ids: ['00000000-0000-4000-8000-000000000001'] });
  assert.deepEqual(loadMainThreadIds(file), ['00000000-0000-4000-8000-000000000001']);
  write({ main_thread_ids: ['mcp:00000000-0000-4000-8000-000000000001'] });
  assert.deepEqual(loadMainThreadIds(file), ['mcp:00000000-0000-4000-8000-000000000001'], 'mcp: form accepted');
  for (const bad of ['x', [''], [1], [null], {}, ['short'], ['has space 12345'], ['mcp:'], ['a/b/c/d/e/f/g']]) { write({ main_thread_ids: bad }); assert.throws(() => loadMainThreadIds(file), /invalid main_thread_ids/, JSON.stringify(bad)); }
  write({ main_thread_ids: [] }, 0o644);
  assert.throws(() => loadMainThreadIds(file), /mode 0600/);
  // Every key is independently optional.
  write({ main_thread_ids: ['00000000-0000-4000-8000-000000000001'] });
  assert.equal(loadCapacity(file), 1, 'only main_thread_ids: capacity defaults');
  assert.deepEqual(loadRedeliveryLimits(file), { intervalMs: 600000, maxCount: 3, silenceMs: 1200000, leaseMs: 3600000, laneCapacity: 6, rewakeMs: 90000, rewakeWindowMs: 7200000, rewakeStaleMs: 1200000, breakSilenceMs: 1200000, breakProbeMs: 1800000, maxClaimsPerHour: 90, maxToolCallsPerHour: 1000, maxToolCallsPer24h: 10000, maxResponseBytesPer24h: 100000000, maxResponseBytesPerHour: 8000000 }, 'only main_thread_ids: redelivery defaults');
  // Queue re-wake keys, validated; the legacy re-announce keys of the live file still load.
  write({ queue_rewake_ms: 30000, queue_rewake_window_ms: 600000 });
  assert.deepEqual([loadRedeliveryLimits(file).rewakeMs, loadRedeliveryLimits(file).rewakeWindowMs], [30000, 600000], 'lower re-wake bounds accepted');
  write({ queue_rewake_ms: 3600000, queue_rewake_window_ms: 86400000 });
  assert.deepEqual([loadRedeliveryLimits(file).rewakeMs, loadRedeliveryLimits(file).rewakeWindowMs], [3600000, 86400000], 'upper re-wake bounds accepted');
  for (const bad of [29999, 3600001, 1.5, '90000']) { write({ queue_rewake_ms: bad }); assert.throws(() => loadRedeliveryLimits(file), /invalid queue_rewake_ms/, JSON.stringify(bad)); }
  for (const bad of [599999, 86400001, 1.5, '7200000']) { write({ queue_rewake_window_ms: bad }); assert.throws(() => loadRedeliveryLimits(file), /invalid queue_rewake_window_ms/, JSON.stringify(bad)); }
  write({ queue_rewake_stale_ms: 300000 }); assert.equal(loadRedeliveryLimits(file).rewakeStaleMs, 300000, 'lower stale bound accepted');
  write({ queue_rewake_stale_ms: 86400000 }); assert.equal(loadRedeliveryLimits(file).rewakeStaleMs, 86400000, 'upper stale bound accepted');
  for (const bad of [299999, 86400001, 1.5, '1200000']) { write({ queue_rewake_stale_ms: bad }); assert.throws(() => loadRedeliveryLimits(file), /invalid queue_rewake_stale_ms/, JSON.stringify(bad)); }
  write({ max_claimed_outer_assignments: 10, main_thread_ids: ['00000000-0000-4000-8000-000000000002'], background_max_in_flight: 10, assignment_reannounce_interval_ms: 120000, assignment_reannounce_max_count: 10 });
  assert.deepEqual(loadRedeliveryLimits(file), { intervalMs: 120000, maxCount: 10, silenceMs: 1200000, leaseMs: 3600000, laneCapacity: 6, rewakeMs: 90000, rewakeWindowMs: 7200000, rewakeStaleMs: 1200000, breakSilenceMs: 1200000, breakProbeMs: 1800000, maxClaimsPerHour: 90, maxToolCallsPerHour: 1000, maxToolCallsPer24h: 10000, maxResponseBytesPer24h: 100000000, maxResponseBytesPerHour: 8000000 }, 'live-shaped file with legacy re-announce keys loads');
  // Usage-break and throttle keys: defaults above; bounds validated; each independently optional.
  write({ worker_break_silence_ms: 60000, worker_break_probe_ms: 86400000, max_claims_per_hour: 1, max_tool_calls_per_hour: 100000 });
  assert.deepEqual((({ breakSilenceMs, breakProbeMs, maxClaimsPerHour, maxToolCallsPerHour }) => [breakSilenceMs, breakProbeMs, maxClaimsPerHour, maxToolCallsPerHour])(loadRedeliveryLimits(file)), [60000, 86400000, 1, 100000], 'break/throttle bounds accepted');
  for (const [name, bad] of [['worker_break_silence_ms', 59999], ['worker_break_silence_ms', '1200000'], ['worker_break_probe_ms', 86400001], ['worker_break_probe_ms', 1.5], ['max_claims_per_hour', 0], ['max_claims_per_hour', 1001], ['max_tool_calls_per_hour', 0], ['max_tool_calls_per_hour', 100001]]) { write({ [name]: bad }); assert.throws(() => loadRedeliveryLimits(file), new RegExp(`invalid ${name}`), `${name}=${JSON.stringify(bad)}`); }
  // Response-byte throttle: hourly burst ceiling default 8000000 (100000..1000000000) and rolling 24 h budget default 100000000
  // (1000000..10000000000); see docs/usage.md for the derivation.
  write({ max_response_bytes_per_hour: 100000, max_response_bytes_per_24h: 1000000 });
  assert.deepEqual([loadRedeliveryLimits(file).maxResponseBytesPerHour, loadRedeliveryLimits(file).maxResponseBytesPer24h], [100000, 1000000], 'lower response-byte bounds accepted');
  write({ max_response_bytes_per_hour: 1000000000, max_response_bytes_per_24h: 10000000000, max_tool_calls_per_hour: 330 });
  assert.deepEqual([loadRedeliveryLimits(file).maxResponseBytesPerHour, loadRedeliveryLimits(file).maxResponseBytesPer24h], [1000000000, 10000000000], 'upper response-byte bounds accepted');
  for (const bad of [99999, 1000000001, 1.5, '2500000', null, [2500000]]) { write({ max_response_bytes_per_hour: bad }); if (bad === null) { assert.equal(loadRedeliveryLimits(file).maxResponseBytesPerHour, 8000000, 'null takes the default'); continue; } assert.throws(() => loadRedeliveryLimits(file), /invalid max_response_bytes_per_hour/, JSON.stringify(bad)); }
  for (const bad of [999999, 10000000001, 1.5, '100000000', [1]]) { write({ max_response_bytes_per_24h: bad }); assert.throws(() => loadRedeliveryLimits(file), /invalid max_response_bytes_per_24h/, JSON.stringify(bad)); }
  // Rolling 24 h tool-call budget (default 10000, 10..10000000) next to the hourly ceiling (default 1000).
  write({ max_tool_calls_per_24h: 10 }); assert.equal(loadRedeliveryLimits(file).maxToolCallsPer24h, 10, 'lower 24 h call bound accepted');
  write({ max_tool_calls_per_24h: 10000000 }); assert.equal(loadRedeliveryLimits(file).maxToolCallsPer24h, 10000000, 'upper 24 h call bound accepted');
  for (const bad of [9, 10000001, 1.5, '10000', [1]]) { write({ max_tool_calls_per_24h: bad }); assert.throws(() => loadRedeliveryLimits(file), /invalid max_tool_calls_per_24h/, JSON.stringify(bad)); }
  write({ worker_lane_capacity: 3, max_claimed_outer_assignments: 10 });
  assert.equal(loadRedeliveryLimits(file).laneCapacity, 3, 'worker_lane_capacity is independent of the claim cap'); assert.equal(loadCapacity(file), 10);
  for (const bad of [0, 11, 1.5, '6', [6]]) { write({ worker_lane_capacity: bad }); assert.throws(() => loadRedeliveryLimits(file), /invalid worker_lane_capacity/, JSON.stringify(bad)); }
  write({ claim_lease_ms: 600000, stale_claim_ms: 120000 });
  assert.equal(loadRedeliveryLimits(file).leaseMs, 600000, 'claim_lease_ms wins over the legacy alias');
  write({ stale_claim_ms: 120000 });
  assert.equal(loadRedeliveryLimits(file).leaseMs, 120000, 'legacy stale_claim_ms alias sets the lease');
  for (const bad of [59999, 604800001, 1.5, '3600000']) { write({ claim_lease_ms: bad }); assert.throws(() => loadRedeliveryLimits(file), /invalid claim_lease_ms/, JSON.stringify(bad)); }
  write({ claim_lease_ms: 604800000 });
  assert.equal(loadRedeliveryLimits(file).leaseMs, 604800000, 'upper lease bound accepted');
  write({ max_claimed_outer_assignments: 6 });
  assert.equal(loadCapacity(file), 6);
  assert.deepEqual(loadMainThreadIds(file), [], 'only capacity: main_thread_ids defaults');
  write({});
  assert.equal(loadCapacity(file), 1);
  write({ max_claimed_outer_assignments: 0 });
  assert.throws(() => loadCapacity(file), /invalid max_claimed_outer_assignments/);
  write({ background_max_in_flight: 2 });
  assert.equal(loadBackgroundMaxInFlight(file), 2, 'custom background cap');
  write({ background_max_in_flight: 0 });
  assert.throws(() => loadBackgroundMaxInFlight(file), /invalid background_max_in_flight/);
  console.log('PASS main_thread_ids validation');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
