#!/usr/bin/env node
// `dalan try` tells the user which command to run next. After a normal install that is `dalan`, not node and a path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cliCommand } from '../src/try.mjs';

const bin = path.resolve('bin/dalan.mjs');

test('the CLI is named dalan when dalan on PATH is this same file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-cli-'));
  try {
    fs.symlinkSync(bin, path.join(dir, 'dalan'));
    assert.equal(cliCommand(path.join(dir, 'dalan'), { PATH: `/nonexistent${path.delimiter}${dir}` }), 'dalan');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a checkout run by path is named with node and the quoted path', () => {
  assert.equal(cliCommand(bin, { PATH: '/nonexistent' }), `node '${fs.realpathSync(bin)}'`);
});

test('another dalan on PATH is not taken for this one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'dalan'), '#!/bin/sh\n');
    assert.match(cliCommand(bin, { PATH: dir }), /^node '/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('under npx the CLI is named npx dalan, because npx puts its temporary bin on PATH only for that run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-cli-'));
  try {
    fs.symlinkSync(bin, path.join(dir, 'dalan'));
    // npm sets npm_command=exec for both `npx dalan` and `npm exec dalan`.
    assert.equal(cliCommand(path.join(dir, 'dalan'), { PATH: dir, npm_command: 'exec' }), 'npx dalan');
    assert.equal(cliCommand(path.join(dir, 'dalan'), { PATH: dir, npm_command: 'run-script' }), 'dalan');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
