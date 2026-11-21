import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson, canonicalValue} from '../protocol/canonical.mjs';

test('equivalent nested objects use the same canonical bytes', () => {
  const left = {z:{b:2,a:1}, a:[{z:false,a:null},'value']};
  const right = {a:[{a:null,z:false},'value'], z:{a:1,b:2}};
  assert.deepEqual(Object.keys(canonicalValue(left)), ['a','z']);
  assert.deepEqual(Object.keys(canonicalValue(left).a[0]), ['a','z']);
  assert.deepEqual(Object.keys(canonicalValue(left).z), ['a','b']);
  assert.equal(canonicalJson(left), '{"a":[{"a":null,"z":false},"value"],"z":{"a":1,"b":2}}');
  assert.equal(canonicalJson(left), canonicalJson(right));
});

test('canonical encoding preserves array order', () => {
  const value = {entries:[{b:2,a:1},null,'tail']};
  assert.deepEqual(canonicalValue(value).entries, [{a:1,b:2},null,'tail']);
  assert.notEqual(canonicalJson(value), canonicalJson({entries:[null,{a:1,b:2},'tail']}));
});

test('nested unsupported values preserve default and caller-supplied error codes', () => {
  const invalidCases = [{outer:[{bad:undefined}]},{outer:{nested:[Infinity]}}];
  for (const canonical of [canonicalValue, canonicalJson]) {
    for (const input of invalidCases) {
      assert.throws(() => canonical(input), {code:'invalid_json'});
      assert.throws(() => canonical(input, 'invalid_protocol_value'), {code:'invalid_protocol_value'});
    }
  }
});
