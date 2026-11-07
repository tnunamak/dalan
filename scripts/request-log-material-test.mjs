import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createRequestLog } from '../src/request-log.mjs';
import { redactLogEntry, registerSecret } from '../src/redaction.mjs';

const sentinel = 'ABCDEF123456abcdef'.repeat(3) + 'ABCDEF1234'; // 64 characters
// sentinel stands for a secret the process holds, so the log masks it by value and in its encoded forms. The log has no
// long-run or entropy rule: an unregistered opaque run is not a secret by shape alone.
registerSecret(sentinel);
const short = 'ABCDEF123456abcdefABCDEF123456';
const body = short;
const pem = (begin = 'BEGIN', end = 'END', label = 'PRIVATE KEY') => `-----${begin} ${label}-----\n${body}\n-----${end} ${label}-----`;
function logged(entry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-log-material-'));
  try {
    const file = path.join(dir, 'requests.jsonl');
    createRequestLog(file)(entry);
    return fs.readFileSync(file, 'utf8');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function masks(name, entry, needle = short) {
  test(name, () => {
    const text = logged(entry);
    assert(!text.includes(needle) && text.includes('[redacted secret]'), 'material must be absent and the mask present');
  });
}
masks('object key', { [pem('ВEGIN')]: 'diagnostic' });
masks('safe structured field', { request_id: pem() });
masks('body in another object property', { marker: '-----ВEGIN PRIVATE KEY-----', detail: sentinel }, sentinel);
masks('marker and body in separate array elements', { detail: ['-----ВEGIN PRIVATE KEY-----', body, '-----END PRIVATE KEY-----'] });
masks('body split across array elements', { detail: [sentinel.slice(0, 20), sentinel.slice(20, 39), sentinel.slice(39)] }, sentinel.slice(0, 20));
masks('marker split across array elements', { detail: ['-----BE', 'GIN PRIVATE KEY-----\nABCDEF123456\n-----END PRIVATE KEY-----'] }, 'ABCDEF123456');
masks('own toJSON cannot replace sanitized data', { detail: { text: 'diagnostic', toJSON() { return sentinel; } }, text: sentinel }, sentinel);
masks('function-valued property is not invoked', { detail: { toJSON() { throw new Error('must not execute'); } }, text: sentinel }, sentinel);
masks('END only', { text: `${body}\n-----END PRIVATE KEY-----` });
masks('bare body', { text: [sentinel, sentinel].join('\n') }, sentinel);
masks('oversized split array', { detail: ['ordinary '.repeat(1900), sentinel.slice(0, 20), sentinel.slice(20, 39), sentinel.slice(39)] }, sentinel.slice(0, 20));
masks('base64url material', { text: sentinel + '_-abcDEF123456' }, sentinel);
masks('dashless', { text: `BEGIN PRIVATE KEY\n${body}` });
masks('equals delimiters', { text: pem().replaceAll('-----', '=====') });
// A short body isolates the existing marker-control stripping from the material rule.
for (const code of [...Array.from({ length: 9 }, (_, i) => i), 11, 12, ...Array.from({ length: 18 }, (_, i) => i + 14), ...Array.from({ length: 33 }, (_, i) => i + 127)]) {
  masks(`marker control U+${code.toString(16).padStart(4, '0')}`, { text: `-----BE${String.fromCharCode(code)}GIN PRIVATE KEY-----\nABCDEF123456` }, 'ABCDEF123456');
}
for (const [name, value] of [['Buffer', Buffer.from(sentinel)], ['typed array', new Uint8Array(Buffer.from(sentinel))], ['DataView', new DataView(Uint8Array.from(Buffer.from(sentinel)).buffer)]]) {
  test(`binary ${name}`, () => assert.equal(JSON.parse(logged({ detail: value })).detail, `[binary ${value.byteLength} bytes]`));
}
for (const value of ['abcdef1234567890abcdef1234567890abcdef12', 'IntegrityHashBase64Like0123456789abcdefXYZ', 'ABCDEF123456'.repeat(4), '550e8400-e29b-41d4-a716-446655440000', '2026-10-10T00:00:00.000Z', 'Connection failed while reading the response.']) {
  test(`readable ${value}`, () => assert.equal(JSON.parse(logged({ text: value })).text, value));
}
test('joined array preserves unrelated elements', () => {
  const detail = ['before ', sentinel.slice(0, 20), sentinel.slice(20, 39), sentinel.slice(39), ' after'];
  assert.deepEqual(JSON.parse(logged({ detail })).detail, ['before ', '[redacted secret]', '[redacted secret]', '[redacted secret]', ' after']);
});
for (const pattern of ['-----BEGIN-----', '-BEGIN-PRIVATE-KEY-']) {
  test(`linear scan ${pattern}`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { redactSecrets } from './src/redaction.mjs';
      const input = ${JSON.stringify(pattern)}.repeat(Math.ceil(1048576 / ${pattern.length})).slice(0, 1048576);
      const start = performance.now();
      redactSecrets(input);
      const ms = performance.now() - start;
      console.log(ms.toFixed(1) + ' ms');
      if (ms >= 1000) process.exitCode = 1;
    `], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 0, String(result.error ?? result.stderr));
    console.log(`${pattern}: ${result.stdout.trim()}`);
  });
}

for (const [kind, options, format] of [['ec', { namedCurve: 'P-256' }, 'sec1'], ['rsa', { modulusLength: 1024 }, 'pkcs1']]) {
  const key = generateKeyPairSync(kind, options).privateKey.export({ type: format, format: 'pem' });
  const lines = key.trim().split('\n');
  for (const [name, fragment] of [['without begin', lines.slice(1).join('\n')], ['body only', lines.slice(1, -1).join('\n')], ['tail 120', key.slice(-120)], ['tail 60', key.slice(-60)]]) {
    test(`${kind} ${name} masks short final line`, () => {
      const last = lines.at(-2);
      assert(!logged({ reason: fragment }).includes(last), 'final key line leaked');
    });
  }
}
test('colliding keys scale', () => {
  const value = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`token=ABCDEF123456${i}`, i]));
  const start = performance.now();
  const result = JSON.parse(logged({ value })).value;
  assert.equal(Object.keys(result).length, 20000);
  assert(performance.now() - start < 1000, 'colliding keys took over one second');
});
test('circular and deeply nested values', () => {
  const circular = {}; circular.self = circular;
  let deep = {}; for (let i = 0; i < 5000; i++) deep = { child: deep };
  const result = logged({ circular, deep });
  assert(result.includes('[circular]')); assert(result.includes('[depth]'));
});
test('sparse arrays', () => assert.deepEqual(JSON.parse(logged({ detail: ['a',, 'b'] })).detail, ['a', null, 'b']));
test('correlation ids stay readable', () => {
  const id = 'ABCDEF123456abcdef'.repeat(2) + 'ABCDEF123456';
  const entry = Object.fromEntries(['request_id', 'call_id', 'claim_id', 'event_id', 'message_id', 'subscription_id'].map(key => [key, id]));
  entry.request_ids = [id];
  const result = JSON.parse(logged(entry));
  for (const key of Object.keys(entry)) assert.deepEqual(result[key], entry[key]);
});
test('oversized array bail out', () => assert.deepEqual(JSON.parse(logged({ detail: ['x'.repeat(16385), 'ordinary'] })).detail, ['[redacted secret]', '[redacted secret]']));
test('newline array join catches footer', () => assert(!logged({ detail: ['ABCDEF123456', '-----END PRIVATE KEY-----'] }).includes('ABCDEF123456')));


test('worker name with a long mixed-case value is kept in the request log', () => {
  const name = 'WorkerAlpha0123456789ABCDEFghijklmnopqrstu';
  assert.equal(name.length >= 40, true);
  assert.equal(redactLogEntry({ worker: name }).worker, name);
  assert.notEqual(redactLogEntry({ other: sentinel }).other, sentinel);
});
