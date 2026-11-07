#!/usr/bin/env node
// A directory with more files than one page can be listed in full: each truncated page names the cursor for the next.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardedFiles } from '../src/workspace.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-list-cursor-'));
try {
  fs.mkdirSync(path.join(dir, 'scripts'));
  for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(dir, 'scripts', `f${String(i).padStart(3, '0')}.mjs`), '');
  fs.mkdirSync(path.join(dir, 'scripts', 'sub'));
  fs.writeFileSync(path.join(dir, 'scripts', 'sub', 'deep.mjs'), '');
  const first = guardedFiles(dir, 'scripts', 200, null);
  assert.equal(first.files.length, 200);
  assert.equal(first.truncated, true);
  const second = guardedFiles(dir, 'scripts', 200, null, first.files.at(-1));
  assert.equal(second.truncated, false);
  assert.equal(second.files.length, 51, 'the second page holds the 50 remaining files and the nested one');
  const all = [...first.files, ...second.files];
  assert.equal(new Set(all).size, 251, 'no file is listed twice or missed');
  assert(all.includes('scripts/sub/deep.mjs'));
  assert.throws(() => guardedFiles(dir, 'scripts', 200, null, 'scripts/missing.mjs'), /cursor not found/);
  console.log('PASS list_files pages through a 251-file directory with a cursor');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
