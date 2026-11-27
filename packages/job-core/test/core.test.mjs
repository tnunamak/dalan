import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertClaimAuthority, canonicalJson, canonicalValue, decide } from '../index.mjs';

test('canonical JSON does not mutate deep-frozen request data while ordering keys', () => {
  const row = Object.freeze({ z: 'last', a: 'first' });
  const payload = Object.freeze({ rows: Object.freeze([row]) });
  assert.equal(canonicalJson(payload), '{"rows":[{"a":"first","z":"last"}]}');
  assert.deepEqual(Object.keys(row), ['z', 'a']);
  assert.equal(payload.rows[0], row);
});

test('canonical JSON requires the caller to encode raw bytes explicitly', () => {
  assert.throws(() => canonicalJson({ payload: new Uint8Array([65, 66]) }, 'invalid_payload'), {
    code: 'invalid_payload', message: 'invalid_payload',
  });
  assert.equal(canonicalJson({ payload: [65, 66] }), '{"payload":[65,66]}');
});

test('canonical JSON keeps Unicode keys and values in deterministic key order', () => {
  const document = { '中': ['茶'], 'é': 'été', a: '🐟' };
  assert.equal(canonicalJson(document), '{"a":"🐟","é":"été","中":["茶"]}');
});

test('a non-renewal decision at revision zero contains only the advance effect', () => {
  assert.deepEqual(decide({ revision: 0 }, { expectedRevision: 0, operation: 'record' }, {}), {
    events: [],
    effects: [{ type: 'advance_revision', expectedRevision: 0 }],
  });
});

test('a receipt revision represented as text is not treated like the numeric revision', () => {
  const snapshot = Object.freeze({ revision: 4 });
  assert.throws(() => decide(snapshot, { expectedRevision: '4', operation: 'record' }, {}), { code: 'revision_conflict' });
  assert.deepEqual(snapshot, { revision: 4 });
});

test('an integral-looking lease string is refused rather than modifying the previous deadline', () => {
  const snapshot = Object.freeze({ revision: 4, leaseUntil: 50 });
  const command = { expectedRevision: 4, operation: 'renew', args: { leaseMs: '8' } };
  assert.throws(() => decide(snapshot, command, { now: 10, maxLeaseMs: 8 }), { code: 'invalid_lease' });
  assert.equal(snapshot.leaseUntil, 50);
});

test('canonical JSON sorts nested keys and preserves array order', () => {
  assert.equal(canonicalJson({ z: [3, 1, 2, { b: 2, a: 1 }], a: true }), '{"a":true,"z":[3,1,2,{"a":1,"b":2}]}');
  assert.throws(() => canonicalJson({ bad: Infinity }, 'bad_value'), { code: 'bad_value' });
});

test('canonical JSON follows JSON index ordering for numeric-looking keys', () => {
  const entries = [
    ['z', 'tail'], ['10', 'ten'], ['4294967295', 'not-an-index'],
    ['01', 'leading-zero'], ['2', 'two'], ['4294967294', 'last-index'],
  ];
  const expected = '{"2":"two","10":"ten","4294967294":"last-index","01":"leading-zero","4294967295":"not-an-index","z":"tail"}';
  assert.equal(canonicalJson(Object.fromEntries(entries)), expected);
  assert.equal(canonicalJson(Object.fromEntries([...entries].reverse())), expected);
});

test('canonical JSON ignores non-enumerable presentation data on a plain object', () => {
  const value = { shown: 'fixture' };
  Object.defineProperty(value, 'label', { value: 'presentation only' });
  assert.equal(canonicalJson(value), '{"shown":"fixture"}');
});

test('canonical JSON keeps indexed array data separate from presentation properties', () => {
  const values = [2, 1];
  Object.assign(values, { label: 'presentation only' });
  assert.equal(canonicalJson(values), '[2,1]');
});

test('canonical JSON writes negative zero as zero in object and array values', () => {
  const expected = '{"array":[0,{"n":0}],"n":0}';
  assert.equal(canonicalJson({ n: -0, array: [-0, { n: -0 }] }), expected);
  assert.equal(canonicalJson({ n: 0, array: [0, { n: 0 }] }), expected);
});

test('canonical JSON rejects a missing array cell rather than inventing an explicit null', () => {
  const incomplete = ['first', 'second'];
  delete incomplete[1];
  assert.throws(() => canonicalJson(incomplete, 'invalid_fixture'), { code: 'invalid_fixture' });
  assert.equal(canonicalJson(['first', null]), '["first",null]');
});

test('canonical JSON rejects an undefined array cell instead of serializing it as null', () => {
  assert.throws(() => canonicalJson({ values: [1, undefined] }), {
    name: 'Error', code: 'invalid_json', message: 'invalid_json',
  });
});

test('canonical JSON rejects an undefined object member nested in an array instead of dropping it', () => {
  assert.throws(() => canonicalJson({ rows: [{ count: 1, optional: undefined }] }), {
    name: 'Error', code: 'invalid_json', message: 'invalid_json',
  });
});

test('canonical JSON rejects a Date rather than silently converting it to text', () => {
  assert.throws(() => canonicalJson({ created: new Date(0) }, 'unsupported_value'), {
    name: 'Error', code: 'unsupported_value', message: 'unsupported_value',
  });
});

test('claim authority requires matching epoch and an unexpired deadline', () => {
  const command = { job: 'j', subject: 's', worker: 'w', claim: 'c', epoch: 2 };
  const authority = { ...command, active: true, leaseUntil: 10 };
  assert.doesNotThrow(() => assertClaimAuthority(command, authority, 9));
  assert.throws(() => assertClaimAuthority(command, { ...authority, epoch: 1 }, 9), { code: 'stale_authority' });
  assert.throws(() => assertClaimAuthority(command, authority, 10), { code: 'lease_expired' });
});


test('claim authority requires explicit boolean activation, not truthiness', () => {
  const command = Object.freeze({ job: 'j', subject: 's', worker: 'w', claim: 'c', epoch: 2 });
  const lease = Object.freeze({ ...command, leaseUntil: 1 });
  for (const active of [1, 'true', null]) {
    const authority = Object.freeze({ ...lease, active });
    assert.throws(() => assertClaimAuthority(command, authority, 0), { code: 'stale_authority' });
  }
  assert.doesNotThrow(() => assertClaimAuthority(command, { ...lease, active: true }, 0));
});

test('renewal requires an explicit, positive integral caller ceiling', () => {
  const snapshot = Object.freeze({ revision: 7 });
  const command = Object.freeze({ expectedRevision: 7, operation: 'renew', args: Object.freeze({ leaseMs: 1 }) });
  for (const context of [undefined, { now: 3 }, { now: 3, maxLeaseMs: 0 }, { now: 3, maxLeaseMs: 1.5 }]) {
    assert.throws(() => decide(snapshot, command, context), { code: 'invalid_lease' });
  }
  assert.deepEqual(decide(snapshot, command, { now: 3, maxLeaseMs: 1 }), {
    events: [], effects: [{ type: 'advance_revision', expectedRevision: 7 }], leaseUntil: 4,
  });
});

test('renewal reports invalid lease when duration is missing, zero, or fractional', () => {
  const snapshot = Object.freeze({ revision: 2 });
  for (const args of [undefined, {}, { leaseMs: 0 }, { leaseMs: 1.5 }]) {
    assert.throws(() => decide(snapshot, { expectedRevision: 2, operation: 'renew', args },
      { now: 10, maxLeaseMs: 9 }), { code: 'invalid_lease' });
  }
  assert.deepEqual(snapshot, { revision: 2 });
});

test('a stale revision is reported before validating a renewal duration', () => {
  const command = { expectedRevision: 1, operation: 'renew', args: { leaseMs: 0 } };
  assert.throws(() => decide({ revision: 2 }, command, { now: 10, maxLeaseMs: 9 }),
    { code: 'revision_conflict' });
});

test('a matching but unrepresentable finish revision produces no decision', () => {
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const snapshot = Object.freeze({ revision });
    const command = Object.freeze({ expectedRevision: revision, operation: 'finish' });
    assert.throws(() => decide(snapshot, command), { code: 'invalid_revision', message: 'invalid_revision' });
    assert.deepEqual(snapshot, { revision });
  }
});

test('renewal refuses missing or invalid server clock context before emitting an effect', () => {
  const snapshot = Object.freeze({ revision: 4 });
  const command = Object.freeze({
    expectedRevision: 4, operation: 'renew', args: Object.freeze({ leaseMs: 2 }),
  });
  for (const context of [undefined, { now: -1, maxLeaseMs: 8 },
    { now: 10.5, maxLeaseMs: 8 }, { now: 10, maxLeaseMs: 0 }]) {
    assert.throws(() => decide(snapshot, command, context), {
      code: 'invalid_lease', message: 'invalid_lease',
    });
    assert.deepEqual(snapshot, { revision: 4 });
  }
  assert.equal(decide(snapshot, command, { now: 10, maxLeaseMs: 8 }).leaseUntil, 12);
});

test('revision and lease decisions use supplied time', () => {
  const command = { expectedRevision: 2, operation: 'renew', args: { leaseMs: 7 } };
  assert.deepEqual(decide({ revision: 2 }, command, { now: 10, maxLeaseMs: 9 }), {
    events: [], effects: [{ type: 'advance_revision', expectedRevision: 2 }], leaseUntil: 17,
  });
  assert.throws(() => decide({ revision: 3 }, command, { now: 10, maxLeaseMs: 9 }), { code: 'revision_conflict' });
  assert.throws(() => decide({ revision: 2 }, command, { now: 10, maxLeaseMs: 6 }), { code: 'invalid_lease' });
  assert.throws(() => decide({ revision: Number.MAX_SAFE_INTEGER }, { ...command, expectedRevision: Number.MAX_SAFE_INTEGER }, { now: 10, maxLeaseMs: 9 }), { code: 'invalid_revision' });
});

test('claim authority is tied to each exact command identity and active status', () => {
  const command = { job: 'job-a', subject: 'subject-a', worker: 'worker-a', claim: 'claim-a', epoch: 2 };
  const authority = { ...command, active: true, leaseUntil: 20 };
  for (const [field, different] of [['job', 'job-b'], ['subject', 'subject-b'], ['worker', 'worker-b'], ['claim', 'claim-b'], ['active', false]]) {
    assert.throws(() => assertClaimAuthority(command, { ...authority, [field]: different }, 19),
      { code: 'stale_authority' }, field);
  }
  assert.throws(() => assertClaimAuthority(command, { ...authority, leaseUntil: 20.5 }, 19), { code: 'lease_expired' });
});

test('renew accepts the exact maximum and rejects invalid duration shape or overflow', () => {
  const snapshot = { revision: 4 };
  const command = { expectedRevision: 4, operation: 'renew' };
  const context = { now: 10, maxLeaseMs: 8 };
  assert.equal(decide(snapshot, { ...command, args: { leaseMs: 8 } }, context).leaseUntil, 18);
  for (const args of [{}, { leaseMs: 0 }, { leaseMs: 0.5 }, { leaseMs: 2, extra: true }]) {
    assert.throws(() => decide(snapshot, { ...command, args }, context), { code: 'invalid_lease' });
  }
  assert.throws(() => decide(snapshot, { ...command, args: { leaseMs: 2 } },
    { ...context, now: Number.MAX_SAFE_INTEGER - 1 }), { code: 'invalid_lease' });
});

test('renew accepts a deadline equal to the largest safe integer', () => {
  const ceiling = Number.MAX_SAFE_INTEGER;
  const command = { expectedRevision: 4, operation: 'renew', args: { leaseMs: 2 } };

  assert.equal(decide({ revision: 4 }, command, {
    now: ceiling - 2, maxLeaseMs: 2,
  }).leaseUntil, ceiling);
});

test('canonical JSON rejects unsupported leaves while keeping the caller-specific error code', () => {
  for (const unsupported of [undefined, new Date(0), 1n]) {
    assert.throws(() => canonicalJson({ nested: [unsupported] }, 'bad_argument'), { code: 'bad_argument' });
  }
  assert.equal(canonicalJson({ nested: [null, false, 0, ''] }), '{"nested":[null,false,0,""]}');
});


test('canonical JSON keeps the invalid-value diagnostic for a cyclic fixture', () => {
  const rows = [];
  rows.push(rows);
  assert.throws(() => canonicalJson(rows), {
    code: 'invalid_json', message: 'invalid_json',
  });
  assert.throws(() => canonicalJson({ rows }, 'bad_argument'), {
    code: 'bad_argument', message: 'bad_argument',
  });
});
test('canonical JSON permits a shared object to appear in sibling branches', () => {
  const shared = { z: 'last', a: 'first' };
  assert.equal(
    canonicalJson({ right: [shared], left: shared }),
    '{"left":{"a":"first","z":"last"},"right":[{"a":"first","z":"last"}]}'
  );
});

test('canonical JSON treats shared branches like independently allocated equal branches', () => {
  const shared = { values: ['second', 'first'] };
  assert.equal(
    canonicalJson([shared, shared]),
    canonicalJson([{ values: ['second', 'first'] }, { values: ['second', 'first'] }])
  );
  assert.deepEqual(shared, { values: ['second', 'first'] });
});

test('canonical JSON preserves empty containers and escaped literal text', () => {
  const text = 'line 1\nline "2"\\';
  assert.equal(canonicalJson({ text, object: {}, array: [] }),
    JSON.stringify({ array: [], object: {}, text }));
});

test('canonical JSON does not normalize distinct Unicode strings', () => {
  const composed = '\u00e9';
  const decomposed = 'e\u0301';
  assert.deepEqual(JSON.parse(canonicalJson([composed, decomposed])), [composed, decomposed]);
  assert.notEqual(canonicalJson(composed), canonicalJson(decomposed));
});

test('canonical JSON gives numbered display rows a stable order across insertion orders', () => {
  const first = Object.fromEntries([['10', 'ten'], ['2', 'two'], ['title', 'Rows'], ['note', 'Ready']]);
  const second = Object.fromEntries([['note', 'Ready'], ['2', 'two'], ['title', 'Rows'], ['10', 'ten']]);
  const expected = '{"2":"two","10":"ten","note":"Ready","title":"Rows"}';
  assert.equal(canonicalJson(first), expected);
  assert.equal(canonicalJson(second), expected);
});

test('canonical JSON omits non-enumerable display metadata but preserves explicit null', () => {
  const row = { title: 'Plan', note: null };
  Object.defineProperty(row, 'displayCache', {value: 'Ready', enumerable: false});
  assert.equal(canonicalJson(row), '{"note":null,"title":"Plan"}');
  assert.equal(row.displayCache, 'Ready');
});

test('canonical output can be edited without changing its source document', () => {
  const entry = Object.freeze({ label: 'source' });
  const source = Object.freeze({ entries: Object.freeze([entry, entry]) });
  const result = canonicalValue(source);

  assert.deepEqual(result, source);
  result.entries[0].label = 'edited';
  result.entries.push({ label: 'added' });
  assert.deepEqual(result.entries, [{ label: 'edited' }, { label: 'source' }, { label: 'added' }]);
  assert.deepEqual(source.entries, [{ label: 'source' }, { label: 'source' }]);
});

test('canonical JSON is stable after a JSON round trip', () => {
  const source = { z: [{ b: 2, a: false }, null], a: 'fixture' };
  const canonical = canonicalJson(source);

  assert.equal(canonical, '{"a":"fixture","z":[{"a":false,"b":2},null]}');
  assert.equal(canonicalJson(JSON.parse(canonical)), canonical);
});

test('canonical JSON preserves finite decimal and exponent values', () => {
  const metadata = { small: 1e-7, fraction: 1.25, large: 1e21 };
  const canonical = canonicalJson(metadata);

  assert.equal(canonical, '{"fraction":1.25,"large":1e+21,"small":1e-7}');
  assert.deepEqual(JSON.parse(canonical), metadata);
});

test('ordinary progress needs no renewal context and leaves inputs unchanged', () => {
  const snapshot = Object.freeze({ revision: 5, leaseUntil: 40 });
  const command = Object.freeze({
    expectedRevision: 5, operation: 'progress', args: Object.freeze({ note: 'fixture' }),
  });
  assert.deepEqual(decide(snapshot, command), {
    events: [], effects: [{ type: 'advance_revision', expectedRevision: 5 }],
  });
  assert.deepEqual(snapshot, { revision: 5, leaseUntil: 40 });
  assert.deepEqual(command.args, { note: 'fixture' });
});

test('the last incrementable revision can still produce an ordinary finish effect', () => {
  const revision = Number.MAX_SAFE_INTEGER - 1;
  assert.deepEqual(decide({ revision }, { expectedRevision: revision, operation: 'finish' }), {
    events: [], effects: [{ type: 'advance_revision', expectedRevision: revision }],
  });
});

test('canonical JSON rejects a Map instead of dropping its entries', () => {
  assert.throws(() => canonicalJson({rows: new Map([['fixture', 1]])}, 'invalid_report'), {code: 'invalid_report'});
});

test('canonical JSON rejects boxed scalars instead of coercing them', () => {
  assert.throws(() => canonicalJson([Object(false)]), {code: 'invalid_json'});
});

test('canonical JSON keeps punctuation in object field names without turning it into structure', () => {
  const value = { 'two words': true, 'quoted"field': 'fixture', 'line\nbreak': 1 };
  const encoded = canonicalJson(value);
  assert.equal(encoded, '{"line\\nbreak":1,"quoted\\"field":"fixture","two words":true}');
  assert.deepEqual(JSON.parse(encoded), value);
});

test('matching claim coordinates with unusable stored deadlines fail with lease_expired', () => {
  const command = { job: 'fixture-job', subject: 'fixture-subject', worker: 'dot', claim: 'fixture-claim', epoch: 1 };
  const base = { ...command, active: true };
  for (const leaseUntil of [undefined, null, '200', 200.5, Infinity]) {
    assert.throws(() => assertClaimAuthority(command, { ...base, leaseUntil }, 100), { code: 'lease_expired' });
  }
  assert.doesNotThrow(() => assertClaimAuthority(command, { ...base, leaseUntil: 200 }, 100));
});

test('canonical JSON preserves a scalar protocol value without wrapping it', () => {
  for (const [input, expected] of [[null, 'null'], [false, 'false'], [0, '0'], ['', '""']]) {
    assert.equal(canonicalJson(input), expected);
  }
});

test('renewal at the initial supplied clock advances a frozen revision without altering it', () => {
  const snapshot = Object.freeze({ revision: 0, leaseUntil: 50 });
  const command = Object.freeze({ expectedRevision: 0, operation: 'renew', args: Object.freeze({ leaseMs: 10 }) });
  const context = Object.freeze({ now: 0, maxLeaseMs: 10 });
  assert.deepEqual(decide(snapshot, command, context), {
    events: [], effects: [{ type: 'advance_revision', expectedRevision: 0 }], leaseUntil: 10,
  });
  assert.equal(snapshot.leaseUntil, 50);
});

test('renewal resolves a new deadline from the supplied clock, not the previous lease', () => {
  const snapshot = { revision: 8, leaseUntil: 120 };
  const command = { operation: 'renew', expectedRevision: 8, args: { leaseMs: 10 } };
  const early = decide(snapshot, command, { now: 100, maxLeaseMs: 20 });
  const late = decide(snapshot, command, { now: 105, maxLeaseMs: 20 });
  assert.deepEqual([early.leaseUntil, late.leaseUntil], [110, 115]);
  assert.deepEqual(late.effects, early.effects);
  assert.equal(snapshot.leaseUntil, 120);
});

test('ordinary decision output omits leaseUntil when serialized rather than sending null', () => {
  const effect = decide({ revision: 1 }, { operation: 'progress', expectedRevision: 1 });
  const wire = JSON.parse(canonicalJson(effect));
  assert.equal(Object.hasOwn(wire, 'leaseUntil'), false);
  assert.deepEqual(wire.effects, [{ expectedRevision: 1, type: 'advance_revision' }]);
});
