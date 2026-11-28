import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('an inexact numeric PR cap is refused before configuration or review work', t => {
  const root = mkdtempSync(join(tmpdir(), 'dalan-review-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'src'));
  const cli = join(root, 'bin', 'dot-pr-reviewer.mjs');
  copyFileSync(new URL('../bin/dot-pr-reviewer.mjs', import.meta.url), cli);
  writeFileSync(join(root, 'src/pr-head-reviewer.mjs'), `
    export const paths = { config: 'fixture', stateDir: 'fixture' };
    export function loadConfig() { console.log('fixture config accessed'); return {}; }
    export const realDeps = () => ({});
    export function run({ maxSubmits }) { console.log('cap=' + maxSubmits); }
    export function acquireLock() { throw new Error('no lock in the fixture'); }
    export function parseOnly() { throw new Error('no target in the fixture'); }
  `);
  const invoke = max => spawnSync(process.execPath, [cli, '--dry-run', '--max', max], { encoding: 'utf8', timeout: 5000 });
  const invalid = invoke('9007199254740993');
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /--max expects a non-negative integer/);
  const valid = invoke('0');
  assert.ifError(valid.error);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /cap=0/);
});
