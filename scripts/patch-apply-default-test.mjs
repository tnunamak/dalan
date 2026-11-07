#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPatch } from '../src/patch-apply.mjs';

const scratch = path.join(os.homedir(), '.tmp', 'dalan-integrator');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const fixture = fs.mkdtempSync(path.join(scratch, 'patch-apply-default-'));
const repo = path.join(fixture, 'repo');
const globalConfig = path.join(fixture, 'global.gitconfig');
fs.mkdirSync(repo);
const git = (...args) => {
  const result = spawnSync('git', ['-C', repo, '-c', 'user.name=patch apply test', '-c', 'user.email=patch-apply@example.invalid', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

git('init', '--quiet', '-b', 'main');
fs.writeFileSync(path.join(repo, 'note.txt'), 'before\n');
git('add', 'note.txt');
git('commit', '-m', 'base', '--quiet');
const baseSha = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(repo, 'note.txt'), 'after \n');
const diff = spawnSync('git', ['-C', repo, 'diff', '--binary'], { encoding: 'utf8' });
assert.equal(diff.status, 0, diff.stderr);
const patch = Buffer.from(diff.stdout + '\n');
fs.writeFileSync(path.join(fixture, 'patch.diff'), patch);
fs.writeFileSync(path.join(repo, 'note.txt'), 'before\n');
const configured = spawnSync('git', ['config', '--file', globalConfig, 'apply.whitespace', 'error'], { encoding: 'utf8' });
assert.equal(configured.status, 0, configured.stderr);
const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
try {
  const visibleConfig = spawnSync('git', ['-C', repo, 'config', '--get', 'apply.whitespace'], { encoding: 'utf8' });
  assert.equal(visibleConfig.status, 0, visibleConfig.stderr);
  assert.equal(visibleConfig.stdout.trim(), 'error');
  const directApply = spawnSync('git', ['-C', repo, 'apply', '-'], { input: patch, encoding: 'utf8' });
  assert.notEqual(directApply.status, 0, 'Git itself must reject this patch with the configured policy');
  assert.match(directApply.stderr, /whitespace/i);
  assert.throws(() => applyPatch({ dir: repo, patch, sha256: digest(patch), baseSha }), /whitespace/i,
    'existing callers must inherit Git apply.whitespace=error from their configured global file');
  assert.equal(fs.readFileSync(path.join(repo, 'note.txt'), 'utf8'), 'before\n', 'a rejected patch leaves the checkout unchanged');
  console.log('patch-apply-default-test: existing callers retain inherited Git whitespace policy');
} finally {
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
  if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
}
