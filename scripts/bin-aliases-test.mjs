import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const { bin } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the package installs only dalan and dalan-* commands', () => {
  assert.deepEqual(Object.keys(bin).filter(name => name !== 'dalan' && !name.startsWith('dalan-')), []);
  for (const name of ['worker', 'acp-agent', 'alert', 'deadman', 'heartbeat', 'pr-reviewer']) assert.ok(bin[`dalan-${name}`], `dalan-${name}`);
});

test('every command points at a file in the package', () => {
  for (const [name, target] of Object.entries(bin)) assert.ok(existsSync(path.join(root, target)), `${name} -> ${target}`);
});

test('dalan-worker uses the bridge home that DALAN_HOME names, like dalan', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'dalan-alias-'));
  const env = { ...process.env, HOME: path.join(scratch, 'home'), DALAN_HOME: path.join(scratch, 'bridge') };
  const paths = name => {
    const run = spawnSync(process.execPath, [path.join(root, bin[name]), 'paths'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  assert.ok(paths('dalan').data_dir.startsWith(env.DALAN_HOME), 'dalan follows DALAN_HOME');
  assert.deepEqual(paths('dalan-worker'), paths('dalan'));
});

test('each dalan-* helper names itself by its installed command in usage and errors', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'dalan-alias-usage-'));
  const env = { ...process.env, HOME: scratch, DOT_DEADMAN_ENV: path.join(scratch, 'missing-env') };
  for (const [name, args] of [['dalan-alert', []], ['dalan-deadman', ['no-such-command']], ['dalan-pr-reviewer', ['--no-such-flag']]]) {
    const run = spawnSync(process.execPath, [path.join(root, bin[name]), ...args], { env, encoding: 'utf8', timeout: 20000 });
    const text = run.stdout + run.stderr;
    assert.notEqual(run.status, 0, `${name}: ${text}`);
    assert.match(text, new RegExp(`\\b${name}\\b`), `${name} should name itself: ${text}`);
    assert.doesNotMatch(text, /\bdot-(alert|deadman|heartbeat|pr-reviewer)\b/, `${name} names a command the package does not install: ${text}`);
  }
});
