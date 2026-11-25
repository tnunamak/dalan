import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliCommand } from '../src/cli-name.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-cli-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selfDir = path.join(root, 'S');
  const newDir = path.join(root, 'NEW');
  const oldDir = path.join(root, 'OLD');
  for (const dir of [selfDir, newDir, oldDir]) fs.mkdirSync(dir);
  const selfPath = path.join(selfDir, 'self.mjs');
  fs.writeFileSync(selfPath, '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.writeFileSync(path.join(oldDir, 'dalan'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync(selfPath, path.join(newDir, 'dalan'));
  return { root, selfPath, newDir, oldDir };
}

test('first PATH entry resolves to this CLI', t => {
  const { selfPath, newDir, oldDir } = fixture(t);
  assert.equal(cliCommand(selfPath, { PATH: [newDir, oldDir].join(path.delimiter) }), 'dalan');
});

test('an earlier different CLI requires the absolute node fallback', t => {
  const { selfPath, newDir, oldDir } = fixture(t);
  const command = cliCommand(selfPath, { PATH: [oldDir, newDir].join(path.delimiter) });
  const quotedSelf = "'" + fs.realpathSync(selfPath).replaceAll("'", "'\\''") + "'";
  assert.notEqual(command, 'dalan');
  assert.equal(command, 'node ' + quotedSelf);
});

test('empty and missing PATH directories are skipped', t => {
  const { root, selfPath, newDir } = fixture(t);
  assert.equal(cliCommand(selfPath, {
    PATH: ['', path.join(root, 'missing'), newDir].join(path.delimiter),
  }), 'dalan');
});

test('npm exec keeps its npx rerun command', t => {
  const { selfPath, newDir } = fixture(t);
  assert.equal(cliCommand(selfPath, { PATH: newDir, npm_command: 'exec' }), 'npx @tnunamak/dalan');
});
