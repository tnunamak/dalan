import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryAgent, isLoaded, removeAgents, setUpdateAgent, launchdLabels, MARKER } from '../src/service-launchd.mjs';

const label = 'xyz.dalan.fixture';
const seams = result => ({ uid: 501, spawn(command, args) {
  assert.equal(command, 'launchctl');
  assert.deepEqual(args, ['print', `user/501/${label}`]);
  return result;
} });

test('launchctl print distinguishes loaded, label-specific absence and unknown', () => {
  const loaded = seams({ status: 0, stdout: 'service = { pid = 123; }', stderr: '' });
  assert.equal(queryAgent(label, loaded).state, 'loaded');
  assert.equal(isLoaded(label, loaded), true);
  for (const stream of ['stdout', 'stderr']) {
    const absent = seams({ status: 113, [stream]: `Bad request.\nCould not find service "${label}" in domain for user/501` });
    assert.equal(queryAgent(label, absent).state, 'absent');
    assert.equal(isLoaded(label, absent), false);
  }
  for (const result of [
    { status: 1, stderr: 'Operation not permitted' },
    { status: 113, stderr: '' },
    { status: 113, stderr: 'Could not find service "another.label" in domain for user/501' },
    { error: new Error('spawn launchctl ENOENT') },
    { status: null, signal: 'SIGTERM' },
  ]) {
    assert.equal(queryAgent(label, seams(result)).state, 'unknown');
    assert.throws(() => isLoaded(label, seams(result)), /Cannot determine whether launchd service/);
  }
});

test('unknown state on either label preserves both plists before teardown', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const unit = 'fixture', labels = Object.values(launchdLabels(unit));
  for (const label of labels) fs.writeFileSync(path.join(dir, `${label}.plist`), MARKER);
  for (const unknown of labels) {
    const calls = [];
    const seam = { uid: 501, spawn(command, args) {
      calls.push(args);
      assert.equal(args[0], 'print', 'no launchctl mutation before all states are known');
      const label = args[1].split('/').at(-1);
      return label === unknown ? { status: 1, stderr: 'Operation not permitted' } : { status: 0 };
    } };
    assert.throws(() => removeAgents({ unit, unit_dir: dir }, seam), /Cannot determine whether launchd service/);
    for (const label of labels) assert.equal(fs.readFileSync(path.join(dir, `${label}.plist`), 'utf8'), MARKER);
    assert(calls.length > 0);
  }
  assert.throws(() => setUpdateAgent({ receipt: { unit, unit_dir: dir }, enabled: false }, {
    uid: 501, spawn: () => ({ status: 1, stderr: 'Operation not permitted' }),
  }), /Cannot determine whether launchd service/);
  for (const label of labels) assert.equal(fs.readFileSync(path.join(dir, `${label}.plist`), 'utf8'), MARKER);
});
