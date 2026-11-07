// The JSON-Schema subset that registered tools use. Everything it cannot check must be refused at register time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSchema, validateValue, SchemaError, SUBSET_LIMITS } from '../src/schema-subset.mjs';

const refuses = schema => { try { compileSchema(schema); } catch (e) { assert(e instanceof SchemaError, String(e)); return e.message; } assert.fail('expected SchemaError'); };
const errorsFor = (schema, value) => validateValue(compileSchema(schema), value);

test('unsupported keywords are refused at compile time, so nothing is silently unvalidated', () => {
  for (const keyword of ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'const', 'format', 'patternProperties', 'dependencies', '$defs', 'default', 'uniqueItems', 'multipleOf', 'propertyNames', 'contains']) {
    assert.match(refuses({ type: 'object', properties: {}, [keyword]: {} }), new RegExp(keyword.replace('$', '\\$')), keyword);
  }
  assert.match(refuses({ type: 'object', properties: { a: { type: 'string', format: 'email' } } }), /format/, 'nested too');
  assert.match(refuses({ type: 'object', properties: { a: { type: 'array', items: { oneOf: [] } } } }), /oneOf/);
  refuses({ type: ['string', 'null'] });
  refuses({ type: 'null' });
  refuses({ type: 'object', additionalProperties: true });
  refuses({ type: 'object', additionalProperties: { type: 'string' } });
});

test('additionalProperties:false is enforced at every object level, including arrays of objects', () => {
  const schema = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } }, list: { type: 'array', items: { type: 'object', properties: { c: { type: 'integer' } } } } } };
  assert.deepEqual(errorsFor(schema, { a: { b: 'x' }, list: [{ c: 1 }] }), []);
  assert.equal(errorsFor(schema, { z: 1 }).length, 1, 'top level');
  assert.equal(errorsFor(schema, { a: { b: 'x', z: 1 } }).length, 1, 'nested object');
  assert.equal(errorsFor(schema, { list: [{ c: 1 }, { c: 2, z: 1 }] }).length, 1, 'object inside an array');
});

test('types, required, enum, lengths, numeric bounds, items', () => {
  const schema = { type: 'object', required: ['s', 'n'], properties: {
    s: { type: 'string', minLength: 2, maxLength: 5 }, n: { type: 'integer', minimum: 1, maximum: 10 }, x: { type: 'number' },
    e: { type: 'string', enum: ['a', 'b'] }, b: { type: 'boolean' }, arr: { type: 'array', items: { type: 'string', maxLength: 3 }, maxItems: 2, minItems: 1 } } };
  assert.deepEqual(errorsFor(schema, { s: 'ab', n: 1, x: 1.5, e: 'a', b: true, arr: ['abc'] }), []);
  assert.equal(errorsFor(schema, { n: 1 }).length, 1, 'missing required');
  assert.equal(errorsFor(schema, { s: 'a', n: 1 }).length, 1, 'minLength');
  assert.equal(errorsFor(schema, { s: 'abcdef', n: 1 }).length, 1, 'maxLength');
  assert.equal(errorsFor(schema, { s: 'ab', n: 0 }).length, 1, 'minimum');
  assert.equal(errorsFor(schema, { s: 'ab', n: 11 }).length, 1, 'maximum');
  assert.equal(errorsFor(schema, { s: 'ab', n: 1.5 }).length, 1, 'integer');
  assert.equal(errorsFor(schema, { s: 'ab', n: '1' }).length, 1, 'string is not an integer');
  assert.equal(errorsFor(schema, { s: 'ab', n: 1, x: NaN }).length, 1);
  assert.equal(errorsFor(schema, { s: 'ab', n: 1, e: 'c' }).length, 1, 'enum');
  assert.equal(errorsFor(schema, { s: 'ab', n: 1, b: 'true' }).length, 1, 'boolean');
  assert.equal(errorsFor(schema, { s: 'ab', n: 1, arr: [] }).length, 1, 'minItems');
  assert.equal(errorsFor(schema, { s: 'ab', n: 1, arr: ['a', 'b', 'c'] }).length, 1, 'maxItems');
  assert.equal(errorsFor(schema, { s: 'ab', n: 1, arr: ['abcd'] }).length, 1, 'items');
  assert.equal(errorsFor(schema, 'text').length, 1, 'not an object');
  assert.equal(errorsFor(schema, [{ s: 'ab', n: 1 }]).length, 1, 'array is not an object');
  assert.equal(errorsFor(schema, null).length, 1);
});

test('strings and arrays always have a cap, even when the schema omits one', () => {
  const compiled = compileSchema({ type: 'object', properties: { s: { type: 'string' }, a: { type: 'array', items: { type: 'integer' } } } });
  assert.equal(compiled.properties.s.maxLength, SUBSET_LIMITS.defaultString);
  assert.equal(compiled.properties.a.maxItems, SUBSET_LIMITS.defaultArray);
  assert.equal(validateValue(compiled, { s: 'x'.repeat(SUBSET_LIMITS.defaultString + 1) }).length, 1);
  assert.equal(compileSchema({ type: 'object', properties: { s: { type: 'string', maxLength: 10 ** 9 } } }).properties.s.maxLength, SUBSET_LIMITS.defaultString, 'a larger cap is lowered');
});

test('pattern: only the closed form is admitted; it matches, and invalid or unsafe patterns are refused', () => {
  const schema = { type: 'object', properties: { id: { type: 'string', pattern: '^job-[0-9]{1,8}$', maxLength: 20 } } };
  assert.deepEqual(errorsFor(schema, { id: 'job-12' }), []);
  assert.equal(errorsFor(schema, { id: 'JOB-12' }).length, 1);
  const withPattern = pattern => ({ type: 'object', properties: { id: { type: 'string', pattern } } });
  assert.match(refuses(withPattern('a'.repeat(SUBSET_LIMITS.maxPattern + 1))), /pattern/);
  for (const good of ['^[a-f0-9]{64}$', '^[a-fA-F0-9]{64}$', '^[A-Za-z0-9_-]+$', '^[a-z0-9_]{1,64}$', '^job-[0-9]{1,8}$', '^\\d{4}$', '^[a-z]*$', '^[a-z.]{2,}$']) compileSchema(withPattern(good));
  for (const bad of ['(a+)+$', '(a*)*', '(a|aa)+$', '(.*a){10}', '(a+)*b', '(\\d+)+', '(a|b*)+', '(a?)+', '(a?){2,}', '^(([a-z])+.)+[A-Z]([a-z])+$', '(a)\\1', '(?<n>a)\\k<n>', '(?=a)b', '(?!a)b', '(?<=a)b', '(?<!a)b', '(', '[a-', '\\',
    '^(a|b)$', '^(ab)?c$', '^\\d{3}-\\d{4}$', '^(foo|bar)-[0-9]+$', '^(?:ab)?c$', '^https?://[a-z]+$', '^[a-z]+', '[a-z]+$', '^[^a]+$', '^[\\w]+$', '^.+$', '^[a-z]+[0-9]+$', '^[a-z]$']) {
    assert.match(refuses(withPattern(bad)), /pattern.*only the form/, bad);
  }
  refuses({ type: 'object', properties: { n: { type: 'integer', pattern: '^1$' } } });
});

test('evil input against a safe pattern cannot hang: strings are length-capped before the pattern runs', () => {
  const schema = { type: 'object', properties: { s: { type: 'string', pattern: '^[a-z]+$', maxLength: 50 } } };
  const started = Date.now();
  assert.equal(errorsFor(schema, { s: `${'a'.repeat(100000)}!` }).length, 1);
  assert(Date.now() - started < 500);
});

test('nesting depth is capped at 6 in schemas and in values', () => {
  const nest = depth => depth === 0 ? { type: 'string' } : { type: 'object', properties: { n: nest(depth - 1) } };
  compileSchema(nest(SUBSET_LIMITS.maxDepth - 1));
  assert.match(refuses(nest(SUBSET_LIMITS.maxDepth + 1)), /deep/);
  const loose = { type: 'object', properties: { n: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } } } } };
  assert.match(refuses(loose), /deep/);
  const schema = compileSchema(nest(SUBSET_LIMITS.maxDepth - 1));
  let value = 'x'; for (let i = 0; i < SUBSET_LIMITS.maxDepth - 1; i++) value = { n: value };
  assert.deepEqual(validateValue(schema, value), []);
  let deep = 'x'; for (let i = 0; i < 40; i++) deep = { n: deep };
  assert.equal(validateValue(schema, deep).length >= 1, true, 'a value nested far past the cap is refused, not recursed into');
});

test('total serialized size of a value is capped at 64 KiB; the schema size is capped too', () => {
  const schema = compileSchema({ type: 'object', properties: { list: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 8000 } } } });
  const big = { list: Array.from({ length: 20 }, () => 'y'.repeat(4000)) };
  assert(JSON.stringify(big).length > SUBSET_LIMITS.maxBytes);
  assert.match(validateValue(schema, big).join(), /size/);
  assert.deepEqual(validateValue(schema, { list: ['y'.repeat(100)] }), []);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(validateValue(schema, cyclic).length >= 1, true);
  const properties = {}; for (let i = 0; i < 32; i++) properties[`p${i}`] = { type: 'string', description: 'd'.repeat(2500) };
  assert.match(refuses({ type: 'object', properties }), /large|size/);
});

test('prototype keys are refused in schemas and values; messages never echo values', () => {
  assert.match(refuses({ type: 'object', properties: JSON.parse('{"__proto__":{"type":"string"}}') }), /__proto__/);
  const schema = compileSchema({ type: 'object', properties: { a: { type: 'string', maxLength: 3 } } });
  assert.equal(validateValue(schema, JSON.parse('{"a":"x","__proto__":{"b":1}}')).length >= 1, true);
  assert.equal(validateValue(schema, JSON.parse('{"a":"x","constructor":1}')).length >= 1, true);
  const secret = 'very-private-value-12345';
  assert(!validateValue(schema, { a: secret, [secret]: secret }).join().includes(secret));
});

test('pattern: every earlier slow pattern is refused', () => {
  const withPattern = pattern => ({ type: 'object', properties: { s: { type: 'string', pattern, maxLength: 8000 } } });
  for (const bad of ['^a+a+a+a+a+$', '^a*a*$', '^.*foo.*$', '^[a-z]+[a-z]+$', '^a{1,}a{2,}$', '^(a|b)+c+$', '^a{0,2000}a{0,2000}$', `^${'a{0,16}'.repeat(6)}$`, 'a*(a|aa)(a|aa)(a|aa)(a|aa)(a|aa)(a|aa)$', '^(a|aa)(a|aa)$', '^(a*b|c)(d|dd)$',
    'a*b', 'a{0,16}a{0,16}a{0,16}a{0,16}b', '^a|b', '^a*a{0,16}a{0,16}a{0,16}a{0,16}$', '^a*a{4000}b$', '^a*a?a?a{4000}b$', '^(a*)a{4000}b$', '^[a-z]*(-[a-z]{1,10})?$']) assert.match(refuses(withPattern(bad)), /pattern/, bad);
});

test('every admitted form finishes fast on an 8,000 character adversarial input', () => {
  const inputs = [`${'a'.repeat(7999)}!`, `job-${'1'.repeat(7995)}!`, `${'0'.repeat(7999)}g`];
  for (const pattern of ['^[a-z]+$', '^[a-z]*$', '^[a-f0-9]{64}$', '^job-[0-9]+$', '^aaaa[a-z]{0,9999}$', '^[a-z0-9_-]{1,}$', '^\\d+$']) {
    const compiled = compileSchema({ type: 'object', properties: { s: { type: 'string', pattern, maxLength: 8000 } } });
    for (const s of inputs) {
      const started = process.hrtime.bigint();
      validateValue(compiled, { s });
      assert(Number(process.hrtime.bigint() - started) / 1e6 < 50, pattern);
    }
  }
});
