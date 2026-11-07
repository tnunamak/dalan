#!/usr/bin/env node
// The T3 top-level tools test must pass where there is no git repository and no origin/main ref, as in an
// npm tarball or a fresh copy. This runs it in a copy of the tracked files that has no .git directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const files = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
if (files.status !== 0) {
  // Already outside a git checkout: run the test here, which is the case this guard is for.
  const run = spawnSync(process.execPath, ['scripts/t3-top-level-tools-test.mjs'], { cwd: root, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const copy = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'dalan-t3-noref-'));
try {
  for (const rel of files.stdout.split('\0').filter(Boolean)) {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
    fs.cpSync(from, path.join(copy, rel), { verbatimSymlinks: true });
  }
  if (fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(copy, 'node_modules'));
  assert.equal(fs.existsSync(path.join(copy, '.git')), false);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(copy) };
  const run = spawnSync(process.execPath, ['scripts/t3-top-level-tools-test.mjs'], { cwd: copy, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `t3-top-level-tools-test failed in a copy with no git:\n${run.stdout}\n${run.stderr}`);
  console.log('t3-top-level-tools-noref-test: ok');
} finally {
  fs.rmSync(copy, { recursive: true, force: true });
}
