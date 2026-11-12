// Cleanup debt and Gozar home resolution through the route seam. No Gozar executable is run, so there is no recovery command to
// replay: a relative GOZAR_HOME is pinned to the launch directory once, and a stop with debt reports what Gozar said.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildQuery, gozarHomeFor, startSessionRoute, targetFor } from '../src/gozar-routes.mjs';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';

const yes = async () => true;

test('a relative GOZAR_HOME resolves against the launch directory, not a later one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gozar-home-cwd-'));
  const originalCwd = process.cwd();
  const launch = path.join(root, 'launch');
  const other = path.join(root, 'other-shell');
  fs.mkdirSync(launch, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  try {
    process.chdir(launch);
    const home = gozarHomeFor({ GOZAR_HOME: './controller' });
    process.chdir(other);
    assert.equal(home, path.join(fs.realpathSync(launch), 'controller'));
    assert.equal(path.isAbsolute(home), true);
    assert.equal(gozarHomeFor({ GOZAR_HOME: './controller' }), path.join(fs.realpathSync(other), 'controller'));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stop with cleanup debt reports Gozar\'s own words and does not claim removal', async () => {
  const gozar = createFakeGozar();
  const home = path.join(os.tmpdir(), 'gozar-debt-home');
  const route = await startSessionRoute({ gozar, query: buildQuery({ home, target: targetFor(45678), usage: { kind: 'session', lifetimeMs: 5000 } }), consent: yes });
  gozar.fake.setCleanupDebt('fixture pending');
  const result = await route.stop();
  assert.equal(result.removed, false);
  assert.match(result.detail, /cleanup debt.*fixture pending/);
  assert.doesNotMatch(result.detail, /gozar (expose|stop)\b/, 'no provider command is ever printed');
});
