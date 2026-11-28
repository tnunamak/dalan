import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the retired reviewer command exits 2 with one line and does no review work', () => {
  const cli = fileURLToPath(new URL('../bin/dot-pr-reviewer.mjs', import.meta.url));
  for (const args of [[], ['--dry-run', '--max', '0'], ['--help']]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(run.error);
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'dalan-pr-reviewer: the PR-head reviewer was retired from Dalan in this release; fleet tooling owns PR-head reviews.\n');
  }
});
