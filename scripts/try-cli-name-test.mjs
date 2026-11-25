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

test('a null PATH falls back to the node and quoted path form', () => {
  assert.equal(cliCommand(bin, { PATH: null }), `node '${fs.realpathSync(bin)}'`);
});

test('another dalan on PATH is not taken for this one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'dalan'), '#!/bin/sh\n');
    assert.match(cliCommand(bin, { PATH: dir }), /^node '/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('under npx the CLI is named npx @tnunamak/dalan, because npx puts its temporary bin on PATH only for that run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-cli-'));
  try {
    fs.symlinkSync(bin, path.join(dir, 'dalan'));
    // npm sets npm_command=exec for both `npx @tnunamak/dalan` and `npm exec @tnunamak/dalan`.
    assert.equal(cliCommand(path.join(dir, 'dalan'), { PATH: dir, npm_command: 'exec' }), 'npx @tnunamak/dalan');
    assert.equal(cliCommand(path.join(dir, 'dalan'), { PATH: dir, npm_command: 'run-script' }), 'dalan');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const executable of [true, false]) {
  test(`an earlier ${executable ? 'executable' : 'non-executable'} dalan ${executable ? 'shadows' : 'does not shadow'} this CLI`, { skip: process.platform === 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'try-cli-'));
    try {
      const earlier = path.join(root, 'earlier');
      const later = path.join(root, 'later');
      fs.mkdirSync(earlier);
      fs.mkdirSync(later);
      const other = path.join(earlier, 'dalan');
      fs.writeFileSync(other, '#!/bin/sh\n');
      fs.chmodSync(other, executable ? 0o755 : 0o644);
      fs.symlinkSync(bin, path.join(later, 'dalan'));
      assert.equal(cliCommand(bin, { PATH: [earlier, later].join(path.delimiter) }),
        executable ? `node '${fs.realpathSync(bin)}'` : 'dalan');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('an earlier dalan disappearing during realpath does not hide the next executable', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'try-cli-'));
  try {
    const earlier = path.join(root, 'earlier');
    const later = path.join(root, 'later');
    fs.mkdirSync(earlier);
    fs.mkdirSync(later);
    const disappearing = path.join(earlier, 'dalan');
    fs.symlinkSync(bin, disappearing);
    fs.symlinkSync(bin, path.join(later, 'dalan'));
    const realpath = fs.realpathSync;
    const resolve = t.mock.method(fs, 'realpathSync', (candidate, ...args) => {
      if (candidate === disappearing) {
        throw Object.assign(new Error('candidate disappeared'), { code: 'ENOENT' });
      }
      return realpath(candidate, ...args);
    });
    assert.equal(cliCommand(bin, { PATH: [earlier, later].join(path.delimiter) }), 'dalan');
    assert.ok(resolve.mock.calls.some(call => call.arguments[0] === disappearing));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
