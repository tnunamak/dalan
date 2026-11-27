import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../index.mjs';

test('canonical JSON rejects accessor-backed input without reading a presentation field', () => {
  let reads = 0;
  const record = Object.defineProperty({ id: 'fixture' }, 'summary', {
    enumerable: true, configurable: true,
    get() { reads++; return 'computed display'; },
  });
  const items = ['saved'];
  Object.defineProperty(items, '0', {
    enumerable: true,
    get() { reads++; return 'computed item'; },
  });
  for (const input of [record, items])
    assert.throws(() => canonicalJson(input, 'invalid_fixture'), { code: 'invalid_fixture' });
  assert.equal(reads, 0);
  Object.defineProperty(record, 'summary', { enumerable: false });
  assert.equal(canonicalJson(record), '{"id":"fixture"}');
});
