import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('an unreadable skip report fails only its segment and preserves the summary', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'dalan-unreadable-report-'));
  try {
    const scripts = path.join(fixture, 'scripts');
    await mkdir(scripts);
    await copyFile(new URL('./test-segments.mjs', import.meta.url), path.join(scripts, 'test-segments.mjs'));
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({
      scripts: { test: 'node scripts/test-segments.mjs' }
    }));
    const node = "'" + process.execPath.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(path.join(scripts, 'test-segments.json'), JSON.stringify([
      node + ' scripts/segment-one.mjs',
      node + ' scripts/segment-two.mjs'
    ]));
    await writeFile(path.join(scripts, 'segment-one.mjs'),
      "import { mkdirSync } from 'node:fs'; mkdirSync(process.env.DALAN_TEST_SKIP_REPORT);\n");
    await writeFile(path.join(scripts, 'segment-two.mjs'),
      "console.log('later segment really ran');\n");

    const result = spawnSync(process.execPath, ['scripts/test-segments.mjs'], {
      cwd: fixture, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: fixture, TMPDIR: fixture, npm_config_script_shell: '/bin/sh' }
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^later segment really ran$/m, result.stdout + result.stderr);
    assert.match(result.stdout, /^TEST SEGMENTS: 2 total, 1 passed, 1 failed, 0 skipped$/m);
    assert.match(result.stdout, /^FAIL #1\/2 exit=1: .*\(unreadable skip report\)$/m);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
