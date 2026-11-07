#!/usr/bin/env node
// completeJsonLines ignores a half-written tail instead of throwing, and a real concurrent append shows that tail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { completeJsonLines } from './jsonl.mjs';

assert.deepEqual(completeJsonLines(''), []);
assert.deepEqual(completeJsonLines('{"a":1}'), [], 'an unterminated only line is incomplete');
assert.deepEqual(completeJsonLines('{"a":1}\n{"b":'), [{a:1}], 'a torn tail is skipped');
assert.deepEqual(completeJsonLines('{"a":1}\n\n{"b":2}\n'), [{a:1},{b:2}]);
assert.throws(() => completeJsonLines('{"a":\n'), SyntaxError, 'a terminated broken line is still an error');

// Mechanism: a writer appending ~900-byte lines while we read. Parse every read with the helper; it never throws.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-bridge-jsonl-')), file = path.join(dir, 'log.jsonl');
const writer = spawn(process.execPath, ['-e', `const fs=require('fs');const pad='x'.repeat(900);for(let i=0;i<60000;i++)fs.appendFileSync(${JSON.stringify(file)},JSON.stringify({i,pad})+'\\n');`]);
let reads = 0, torn = 0;
const until = Date.now() + 4000;
try {
  while (Date.now() < until && writer.exitCode === null) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8'); reads++;
    if (text && !text.endsWith('\n')) torn++;
    completeJsonLines(text);
  }
} finally { writer.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`PASS jsonl: complete lines only (${reads} concurrent reads, ${torn} saw a torn tail)`);
