import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a segment that writes unshaped skip evidence cannot appear to pass', t => {
  const dir = mkdtempSync(join(tmpdir(), 'seg-form-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'home'));
  const runner = join(dir, 'scripts/test-segments.mjs');
  copyFileSync(new URL('../scripts/test-segments.mjs', import.meta.url), runner);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node scripts/test-segments.mjs' } }));
  writeFileSync(join(dir, 'scripts/test-segments.json'), JSON.stringify(['node fixture.mjs', 'node later.mjs']));
  writeFileSync(join(dir, 'fixture.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.DALAN_TEST_SKIP_REPORT, '{}\\n');");
  writeFileSync(join(dir, 'later.mjs'), "console.log('LATER FIXTURE RAN');");
  const result = spawnSync(process.execPath, [runner], {
    cwd: dir, env: { ...process.env, HOME: join(dir, 'home') }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /malformed skip report JSON at line\(s\): 1/);
  assert.match(result.stdout, /LATER FIXTURE RAN/);
});
