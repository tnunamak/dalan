import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

test('catalog release refuses an extra branch argument before running Git', t => {
  const root = mkdtempSync(join(tmpdir(), 'dalan-catalog-arity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'stub'));
  const script = join(root, 'bin/catalog-release.sh');
  const trace = join(root, 'git-called');
  copyFileSync(new URL('../bin/catalog-release.sh', import.meta.url), script);
  writeFileSync(join(root, 'stub/git'), '#!/bin/sh\n: > "$TRACE"\nexit 99\n', { mode: 0o700 });
  const result = spawnSync('bash', [script, 'fixture-a', 'fixture-b'], {
    env: { ...process.env, TRACE: trace, PATH: join(root, 'stub') + delimiter + process.env.PATH },
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /usage: catalog-release\.sh <branch>/);
  assert.equal(existsSync(trace), false);
});
