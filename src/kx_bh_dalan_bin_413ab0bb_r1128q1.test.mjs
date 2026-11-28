import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('reviewer requires an explicit decimal --max before consulting config', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dalan-reviewer-max-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'bin'));
  await mkdir(join(home, 'src'));
  const cli = join(home, 'bin', 'dot-pr-reviewer.mjs');
  await copyFile(new URL('../bin/dot-pr-reviewer.mjs', import.meta.url), cli);
  await writeFile(join(home, 'src', 'pr-head-reviewer.mjs'), `
    const unexpected = () => { throw new Error('reviewer ran with an invalid cap'); };
    export const paths = {};
    export const loadConfig = unexpected, acquireLock = unexpected, parseOnly = unexpected,
      realDeps = unexpected, run = unexpected;
  `);
  for (const raw of [' ', '1e3', '0x10', '9007199254740992']) {
    const result = spawnSync(process.execPath, [cli, '--dry-run', '--max', raw], {
      encoding: 'utf8', timeout: 5000, env: { HOME: home, USERPROFILE: home },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'dalan-pr-reviewer: --max expects a non-negative integer', JSON.stringify(raw));
  }
});
