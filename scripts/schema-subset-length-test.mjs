import assert from 'node:assert/strict';
import { compileSchema, validateValue } from '../src/schema-subset.mjs';

// Exercise the public compile/validate boundary, not JavaScript string length.
const minTwo = compileSchema({ type: 'string', minLength: 2 });
assert.deepEqual(validateValue(minTwo, '😀'), ['value: shorter than 2']);
assert.deepEqual(validateValue(minTwo, '😀😀'), []);
assert.deepEqual(validateValue(minTwo, ''), ['value: shorter than 2']);
assert.deepEqual(validateValue(minTwo, 'a'), ['value: shorter than 2']);
assert.deepEqual(validateValue(minTwo, 'ab'), []);

const maxOne = compileSchema({ type: 'string', maxLength: 1 });
assert.deepEqual(validateValue(maxOne, '😀'), []);
assert.deepEqual(validateValue(maxOne, '😀😀'), ['value: longer than 1']);
assert.deepEqual(validateValue(maxOne, 'ab'), ['value: longer than 1']);
assert.deepEqual(validateValue(maxOne, ''), []);
assert.deepEqual(validateValue(maxOne, 'a'), []);

// A combining sequence has two code points, not one grapheme.
assert.deepEqual(validateValue(minTwo, 'e\u0301'), []);
assert.deepEqual(validateValue(maxOne, 'e\u0301'), ['value: longer than 1']);
console.log('schema-subset-length: passed');
