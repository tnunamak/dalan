#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestLog, listGenerations, readLines } from '../src/request-log.mjs';
import armorEvasionCases from './armor-evasion-corpus.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-bridge-request-log-'));
const file = name => path.join(root, name);
const entries = name => [...readLines(name)].map(JSON.parse);
const row = id => ({ at: '2026-10-10T00:00:00.000Z', id, text: 'é🙂\nwhole line' });
try {
  const log = file('requests.jsonl'), append = createRequestLog(log, { maxBytes: 100, keep: 4 });
  const written = Array.from({ length: 9 }, (_, i) => row(i));
  for (const entry of written) append(entry);
  assert.deepEqual(entries(log), written, 'rotation lost, duplicated or split a line');
  assert.deepEqual(listGenerations(log), [4, 3, 2, 1].map(n => `${log}.${n}`).concat(log));
  for (const name of listGenerations(log)) {
    assert.equal(fs.statSync(name).mode & 0o777, 0o600);
    assert(fs.readFileSync(name, 'utf8').endsWith('\n'));
  }
  append(row(9)); append(row(10));
  assert.equal(listGenerations(log).length, 5, 'retains at most four archives plus current');
  assert.deepEqual(entries(log), Array.from({ length: 9 }, (_, i) => row(i + 2)), 'only the oldest generation is evicted');
  console.log('PASS request log rotation: whole UTF-8 lines, oldest-first history, 0600 and bounded retention');

  const redactedFile = file('redacted.jsonl');
  createRequestLog(redactedFile)({ kind: 'request', request_id: 'req-1', code: 403, cookie: 'opaque-example', nested: { API_SECRET: 'opaque-example' }, text: 'authorization: opaque-example' });
  const redactedLine = fs.readFileSync(redactedFile, 'utf8');
  assert(!redactedLine.includes('opaque-example'));
  assert.match(redactedLine, /"request_id":"req-1"/);
  assert.match(redactedLine, /"code":403/);
  const markerFile = file('markers.jsonl'), markerLog = createRequestLog(markerFile);
  for (const name of ['fold-intraword-both-label-words', 'fold-intraword-control', 'control-greek-i-confusable']) {
    markerLog({ text: armorEvasionCases.find(item => item.name === name).text });
  }
  const escaped = armorEvasionCases.find(item => item.name === 'container-json-unicode-control').text;
  markerLog({ text: escaped.slice(0, escaped.indexOf('-----END')) + '"}' });
  assert(!fs.readFileSync(markerFile, 'utf8').includes('U1lOVEhFVElDX0JPRFlfQQ=='), 'private body leaked to request log');
  const probes = [
    { m: 'got error token=ABCsDEF123456 tail' }, { m: 'failed: authorization: Bearer ABCDEF123456' }, { m: 'x\ntoken=ABCDEF1234' },
    { m: '{"token":"ABCDEF123456"}' }, { m: 'password=Summer2026!' }, { m: 'cookie: a=b; c=d' },
    { pass: 'ABCDEF123456' }, { refresh: 'ABCDEF123456' }, { cookies: { a: 'ABCDEF123456' } }, { code: '4/0ABCDEF123456' },
  ];
  const probeFile = file('probes.jsonl');
  const probeLog = createRequestLog(probeFile);
  for (const p of probes) probeLog(p);
  const probeText = fs.readFileSync(probeFile, 'utf8');
  for (const needle of ['ABCsDEF', 'ABCDEF12', 'Summer2026', 'c=d', '4/0ABC', 'DEF123456']) assert(!probeText.includes(needle), `leaked ${needle}`);
  assert.match(probeText.split('\n')[0], /tail/, 'text after the secret stays');
  const started = Date.now();
  createRequestLog(file('long.jsonl'))({ m: 'authtokencode!'.repeat(30000) });
  assert(Date.now() - started < 2000, 'long strings are capped before matching');
  console.log('PASS request log redacts opaque sensitive fields before serialization');

  // Startup must account for bytes already present, and a reduced KEEP must prune older archives.
  const restart = createRequestLog(log, { maxBytes: 1, keep: 2 });
  restart(row(11));
  assert.deepEqual(listGenerations(log), [`${log}.2`, `${log}.1`, log]);
  assert.deepEqual(entries(log), [row(8), row(9), row(10), row(11)]);
  assert.deepEqual(entries(`${log}.1`), [row(10)]);
  console.log('PASS request log restart: preexisting bytes trigger rotation and reduced retention is enforced');

  const cheap = file('cheap.jsonl'), stat = fs.statSync;
  let stats = 0;
  fs.statSync = (...args) => { stats++; return stat(...args); };
  try {
    const write = createRequestLog(cheap, { maxBytes: 10000, keep: 4 });
    for (let i = 0; i < 20; i++) write(row(i));
    assert.equal(stats, 1, 'only stat at startup, not for each append');
  } finally { fs.statSync = stat; }
  console.log('PASS request log size tracking: one startup stat');

  const history = file('history.jsonl');
  fs.writeFileSync(`${history}.10`, 'oldest\npartial tail');
  fs.writeFileSync(`${history}.2`, 'middle\n');
  fs.writeFileSync(`${history}.1`, 'é'.repeat(32767) + '🙂\n');
  fs.writeFileSync(history, 'latest\nincomplete');
  fs.writeFileSync(`${history}.bak`, 'not a generation\n');
  fs.writeFileSync(`${history}.01`, 'not a generation\n');
  assert.deepEqual([...readLines(history)], ['oldest', 'middle', 'é'.repeat(32767) + '🙂', 'latest']);
  fs.unlinkSync(history);
  assert.equal([...readLines(history)].length, 3, 'history remains readable without active file');
  assert.deepEqual([...readLines(file('missing'), { missingOk: true })], []);
  assert.throws(() => [...readLines(file('missing'))], { code: 'ENOENT' });
  console.log('PASS request log reader: numeric order, missing active file, incomplete tails and UTF-8 chunk boundary');

  const live = file('live.jsonl'), write = createRequestLog(live, { maxBytes: 1, keep: 1 });
  write(row(0)); write(row(1));
  const reader = readLines(live);
  assert.deepEqual(JSON.parse(reader.next().value), row(0));
  write(row(2)); write(row(3)); // retire both files while the reader holds its snapshot
  assert.deepEqual([...reader].map(JSON.parse), [row(1)]);
  assert.deepEqual(entries(live), [row(2), row(3)]);
  console.log('PASS request log reader keeps its snapshot across concurrent rotation and eviction');

  for (const [key, option] of [['maxBytes', 'DALAN_LOG_MAX_BYTES'], ['keep', 'DALAN_LOG_KEEP']]) {
    for (const value of ['', 'no', 0, -1, 1.5, Infinity]) {
      assert.throws(() => createRequestLog(file('invalid'), { [key]: value }), new RegExp(option));
    }
  }
  console.log('PASS request log rejects invalid rotation settings');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
