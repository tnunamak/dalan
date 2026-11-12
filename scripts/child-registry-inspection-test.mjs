import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sweepChildren } from '../src/child-registry.mjs';

const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'child-registry-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const makeRegistry = name => {
  const registry = path.join(root, name);
  fs.mkdirSync(registry, { recursive: true });
  return registry;
};
const addRecord = (registry, name, record) => fs.writeFileSync(path.join(registry, `${name}.json`), JSON.stringify(record));
const record = overrides => ({ pid: 22, cmd: 'node --child 22', start: 'child-1', owner: 11, ownerCmd: null, ownerStart: null, ...overrides });
const identity = (state, command, start) => ({ state, ...(command ? { command } : {}), ...(start ? { start } : {}) });

test('an unknown owner with no recorded command keeps its child and registry entry', async () => {
  const registry = makeRegistry('unknown-owner');
  addRecord(registry, 'trial', record());
  const identities = new Map([
    [11, identity('unknown')],
    [22, identity('present', 'node --child 22', 'child-1')],
  ]);
  const killed = [];
  const ended = await sweepChildren({
    registry,
    processCmd: pid => identities.get(pid) ?? identity('unknown'),
    kill: (pid, signal) => killed.push([pid, signal]),
    clock: { sleep: async () => {} },
  });
  assert.deepEqual(ended, []);
  assert.deepEqual(killed, []);
  assert.ok(fs.existsSync(path.join(registry, 'trial.json')));
});

test('a present owner with legacy identity data is kept; a start mismatch proves PID reuse', async () => {
  const registry = makeRegistry('owner-identity');
  addRecord(registry, 'legacy', record({ ownerStart: null }));
  addRecord(registry, 'reused', record({ pid: 23, cmd: 'node --child 23', start: 'child-2', owner: 12, ownerStart: 'owner-old' }));
  const identities = new Map([
    [11, identity('present', 'node trial owner', 'owner-current')],
    [12, identity('present', 'node unrelated', 'owner-new')],
    [22, identity('present', 'node --child 22', 'child-1')],
    [23, identity('present', 'node --child 23', 'child-2')],
  ]);
  const killed = [];
  const ended = await sweepChildren({
    registry,
    processCmd: pid => identities.get(pid) ?? identity('unknown'),
    kill(pid, signal) {
      killed.push([pid, signal]);
      identities.set(pid, identity('absent'));
    },
    clock: { sleep: async () => {} },
  });
  assert.deepEqual(ended, [23]);
  assert.deepEqual(killed, [[23, 'SIGTERM']]);
  assert.ok(fs.existsSync(path.join(registry, 'legacy.json')));
  assert.equal(fs.existsSync(path.join(registry, 'reused.json')), false);
});

test('unknown child inspection and corrupt records retain cleanup debt', async () => {
  const registry = makeRegistry('unknown-child');
  addRecord(registry, 'unknown', record({ owner: 31 }));
  fs.writeFileSync(path.join(registry, 'corrupt.json'), '{');
  fs.writeFileSync(path.join(registry, 'null.json'), 'null');
  fs.writeFileSync(path.join(registry, 'array.json'), '[]');
  const ended = await sweepChildren({
    registry,
    processCmd: pid => pid === 31 ? identity('absent') : identity('unknown'),
    kill() { assert.fail('unknown process identity must not be signalled'); },
    clock: { sleep: async () => {} },
  });
  assert.deepEqual(ended, []);
  assert.ok(fs.existsSync(path.join(registry, 'unknown.json')));
  assert.ok(fs.existsSync(path.join(registry, 'corrupt.json')));
  assert.ok(fs.existsSync(path.join(registry, 'null.json')));
  assert.ok(fs.existsSync(path.join(registry, 'array.json')));
});

test('confirmed owner absence permits cleanup of a matching child', async () => {
  const registry = makeRegistry('absent-owner');
  addRecord(registry, 'trial', record({ owner: 41 }));
  const identities = new Map([
    [41, identity('absent')],
    [22, identity('present', 'node --child 22', 'child-1')],
  ]);
  const ended = await sweepChildren({
    registry,
    processCmd: pid => identities.get(pid) ?? identity('unknown'),
    kill(pid, signal) {
      assert.deepEqual([pid, signal], [22, 'SIGTERM']);
      identities.set(pid, identity('absent'));
    },
    clock: { sleep: async () => {} },
  });
  assert.deepEqual(ended, [22]);
  assert.equal(fs.existsSync(path.join(registry, 'trial.json')), false);
});

test('a failed signal keeps its record while the same child remains present', async () => {
  const registry = makeRegistry('failed-signal');
  addRecord(registry, 'trial', record({ owner: 51 }));
  const ended = await sweepChildren({
    registry,
    processCmd: pid => pid === 51 ? identity('absent') : identity('present', 'node --child 22', 'child-1'),
    kill() { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
    clock: { sleep: async () => {} },
    graceMs: 0,
  });
  assert.deepEqual(ended, []);
  assert.ok(fs.existsSync(path.join(registry, 'trial.json')));
});
