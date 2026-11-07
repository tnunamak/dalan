#!/usr/bin/env node
// No row may take its owner from a column default. Every INSERT into assignments or messages in src/ must name target_worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve(import.meta.dirname, '../src');
const files = fs.readdirSync(src, { recursive: true }).filter(f => /\.mjs$/.test(f)).map(f => path.join(src, f));
const pattern = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(assignments|messages)\s*\(([^)]*)\)/gi;
let checked = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(pattern)) {
    checked++;
    const columns = match[2].split(',').map(c => c.trim());
    assert.ok(columns.includes('target_worker'), `${path.relative(src, file)}: INSERT INTO ${match[1]} does not name target_worker`);
  }
  // An INSERT without a column list would also rely on defaults.
  assert.doesNotMatch(text, /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:assignments|messages)\s*(?:VALUES|SELECT)/i, `${file}: INSERT without a column list`);
}
assert.ok(checked >= 3, `expected to find the known inserts, found ${checked}`);
console.log(`insert-names-target-worker-test: ${checked} inserts name target_worker`);
