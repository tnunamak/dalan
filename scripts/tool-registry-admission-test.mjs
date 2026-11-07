// The registry admits a bounded number of calls per verified worker per minute, across every tool name, before it looks up
// a tool, refuses, replays or writes an audit row. A worker without any grant cannot grow the audit log.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createToolRegistry, RegistryError, LIMITS } from '../src/tool-registry.mjs';

const scratchBase = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratchBase, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchBase, 'tool-registry-admission-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const BUDGET = 50;
let counter = 0;
function fixture() {
  const store = new Store(path.join(scratch, `bridge-${counter++}.db`));
  const time = { ms: Date.parse('2026-11-05T00:00:00Z') };
  const runs = [];
  const echo = { run: async ({ args }) => { runs.push(args); return { echoed: args }; } };
  const audited = [];
  const registry = createToolRegistry({ store, now: () => time.ms, handlers: { echo }, admissionPerMinute: BUDGET, audit: row => audited.push(row) });
  return { store, registry, time, runs, audited };
}
const logRows = store => store.db.prepare('SELECT count(*) n FROM tool_registry_log').get().n;
const refusalCount = (store, worker) => store.db.prepare('SELECT value FROM tool_registry_meta WHERE key=?').get(`admission_refused:${worker}`)?.value ?? 0;
const outcome = async promise => { try { await promise; return 'ok'; } catch (e) { assert(e instanceof RegistryError, e.stack); return e.code; } };
const schema = { type: 'object', properties: { text: { type: 'string', maxLength: 50 } }, required: ['text'] };
const spec = (extra = {}) => ({ name: 'echo_tool', description: 'echo', inputSchema: schema, class: 'read', handler: { kind: 'echo' }, ...extra });

test('the default admission budget is a positive per-worker number that covers one tool at its own limit', () => {
  assert(Number.isInteger(LIMITS.admissionPerMinute) && LIMITS.admissionPerMinute >= LIMITS.callsPerMinute);
});

test('1,000 calls to a missing tool by a worker with no grant leave at most the budget in audit rows', async () => {
  const { store, registry, audited } = fixture();
  const before = logRows(store);
  const codes = new Set();
  for (let i = 0; i < 1000; i++) {
    // Rotating tool names must not give each name a fresh budget.
    codes.add(await outcome(registry.callTool({ worker: 'dot', tool: i % 2 ? 'missing_tool' : `missing_${i}`, class: 'read', args: {} })));
  }
  assert.deepEqual([...codes].sort(), ['rate_limited', 'tool_unavailable']);
  assert(logRows(store) - before <= BUDGET, `audit rows added: ${logRows(store) - before}`);
  assert(audited.length <= BUDGET, `audit sink calls: ${audited.length}`);
  assert.equal(refusalCount(store, 'dot'), 1000 - BUDGET, 'the over-budget calls are counted in one row, not logged one by one');
  assert.equal(store.db.prepare("SELECT count(*) n FROM tool_registry_meta WHERE key LIKE 'admission_refused:%'").get().n, 1);
});

test('the over-budget refusal has the rate-limit shape and comes before lookup, for read and write calls', async () => {
  const { registry } = fixture();
  for (let i = 0; i < BUDGET; i++) assert.equal(await outcome(registry.callTool({ worker: 'dot', tool: 'missing_tool', class: 'read', args: {} })), 'tool_unavailable');
  for (const cls of ['read', 'write']) {
    await assert.rejects(registry.callTool({ worker: 'dot', tool: 'missing_tool', class: cls, args: {} }), e => e instanceof RegistryError && e.code === 'rate_limited' && e.message === 'too many calls; retry later');
  }
});

test('replaying a completed idempotency key without limit is refused past the budget', async () => {
  const { store, registry, runs, time } = fixture();
  registry.register(spec()); registry.grant('echo_tool', 'dot');
  const hash = registry.listTools('dot').tools[0].schema_hash;
  const call = () => registry.callTool({ worker: 'dot', tool: 'echo_tool', class: 'read', args: { text: 'x' }, schema_hash: hash, idempotency_key: 'same-key' });
  assert.equal((await call()).ok, true);
  const before = logRows(store);
  let replayed = 0, refused = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await outcome(call());
    if (r === 'ok') replayed++; else if (r === 'rate_limited') refused++; else assert.fail(r);
  }
  assert.equal(replayed, BUDGET - 1, 'the first call and the replays share the budget');
  assert.equal(refused, 1000 - (BUDGET - 1));
  assert(logRows(store) - before <= BUDGET, `audit rows added: ${logRows(store) - before}`);
  assert.equal(runs.length, 1, 'the handler ran once');
  time.ms += 61_000;
  assert.equal((await call()).replayed, true, 'a new minute admits calls again');
});

test('one worker over its budget does not use up another worker\'s budget', async () => {
  const { registry, store } = fixture();
  for (let i = 0; i < 200; i++) await outcome(registry.callTool({ worker: 'noisy', tool: 'missing_tool', class: 'read', args: {} }));
  assert.equal(await outcome(registry.callTool({ worker: 'quiet', tool: 'missing_tool', class: 'read', args: {} })), 'tool_unavailable');
  assert.equal(refusalCount(store, 'quiet'), 0);
});
