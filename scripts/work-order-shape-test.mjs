#!/usr/bin/env node
// A malformed submission field is a typed rejection from the real compiler, never a TypeError from byte accounting.
import assert from 'node:assert/strict';
import { compileWorkOrder, accountBytes } from '../src/work-order.mjs';

const base = { schema_version: 1, request_id: 'shape-1', brief: 'Review the change.', inputs: [], expected_output: 'A verdict.', execution_scope: 'read-only', scope_paths: [] };
// Mirrors the source: the validator refuses the order, so expanded stays null and accounting sees only the submitted payload.
const deps = {
  render: a => structuredClone(a),
  shapeOk() {},
  validate() { throw new Error('unknown scope path: src/a.ts'); },
  admitExecution() {},
  admitReadiness: async () => ({}),
  preflight: async () => null,
  state: () => ({ paused: false, queued: 0 }),
  kind: () => 'review',
};
const compile = payload => compileWorkOrder({ assignment: payload }, deps);
const cases = [
  { name: 'brief as a number', payload: { ...base, brief: 123 }, field: 'brief' },
  { name: 'scope_paths as a string', payload: { ...base, scope_paths: 'src/a.ts' }, field: 'scope_paths' },
];

for (const { name, payload, field } of cases) {
  const before = JSON.stringify(payload);
  const order = await compile(payload);
  assert.equal(order.verdict, 'reject', `${name}: a malformed field is a reject`);
  assert.ok(order.reasons.some(r => r.field === field && r.code === 'invalid_field'), `${name}: typed reason names ${field}`);
  assert.equal(order.bytes.brief, null, `${name}: no success-shaped brief count`);
  assert.equal(order.bytes.instructions, null, `${name}: no success-shaped instruction count`);
  assert.ok(order.bytes.invalid_fields.includes(field), `${name}: byte accounting lists ${field} as invalid`);
  assert.equal(JSON.stringify(payload), before, `${name}: the assignment is not mutated`);
  console.log(`PASS ${name}: typed reject ${order.reasons.find(r => r.field === field).code}`);
}

// Byte accounting on its own must not throw for these shapes either; it reports the malformed fields instead.
assert.deepEqual(accountBytes({ ...base, brief: 123 }, null).invalid_fields, ['brief']);
assert.deepEqual(accountBytes({ ...base, scope_paths: 'src/a.ts' }, null).invalid_fields, ['scope_paths']);
// A well-formed payload keeps its real counts and carries no invalid list.
const ok = accountBytes(base, null);
assert.equal(ok.brief, Buffer.byteLength(base.brief, 'utf8'));
assert.equal(ok.invalid_fields, undefined);
console.log('PASS accountBytes: malformed fields reported, well-formed counts unchanged');

// Infrastructure failures are not verdicts and must still propagate.
const infra = Object.assign(new Error('scanner unavailable'), { code: 'DOT_BRIDGE_INFRASTRUCTURE' });
await assert.rejects(compileWorkOrder({ assignment: base }, { ...deps, validate() { throw infra; } }), { code: 'DOT_BRIDGE_INFRASTRUCTURE' });
console.log('PASS infrastructure errors still propagate');
console.log('work-order-shape-test: PASS');
