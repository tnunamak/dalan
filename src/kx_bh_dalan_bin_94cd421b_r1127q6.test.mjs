import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('unquoted extra alert words are refused before the publisher runs', t => {
  const root = mkdtempSync(join(tmpdir(), 'dalan-alert-arity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'src'));
  const cli = join(root, 'bin', 'dot-alert.mjs');
  copyFileSync(new URL('../bin/dot-alert.mjs', import.meta.url), cli);
  writeFileSync(join(root, 'src', 'alerts.mjs'), "export async function publishAlert() { console.log('fixture publisher called'); }");
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
  const invalid = invoke('fixture title', 'truncated', 'body');
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /usage: dalan-alert TITLE MESSAGE/);
  const valid = invoke('fixture title', 'intact body');
  assert.ifError(valid.error);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /fixture publisher called/);
});
