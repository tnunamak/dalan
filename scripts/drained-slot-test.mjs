#!/usr/bin/env node
// One `wait --drained` waiter per producer. The slot must survive a waiter that dies at any step, and a waiter that is
// suspended for any length of time must never remove the slot of a waiter that started meanwhile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function waiter(home, producer) {
  const env = { ...process.env, HOME: home, DOT_DRAINED_INTERVAL_MS: '100', DOT_DRAINED_UNREACHABLE_MS: '600000' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key];
  const child = spawn(process.execPath, ['bin/dot-worker.mjs', 'wait', '--drained', '--producer-thread', producer, '--timeout', '60'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, exited: false, code: null, stdout: '' };
  child.stdout.on('data', chunk => { state.stdout += chunk; });
  child.on('exit', code => { state.exited = true; state.code = code; });
  return state;
}

test('a replacement runs after a waiter died at the moment it took the slot', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drained-slot-'));
  const stateRoot = path.join(home, '.local/state');
  const drainedDir = () => fs.readdirSync(stateRoot).map(n => path.join(stateRoot, n, 'drained')).find(d => fs.existsSync(d));
  const first = waiter(home, 'producer-a');
  let replacement = null;
  try {
    const slots = () => { try { return fs.readdirSync(drainedDir()).filter(n => n.endsWith('.json')); } catch { return []; } };
    for (let i = 0; i < 200 && !slots().length; i++) await sleep(25);
    const dir = drainedDir();
    const slot = slots()[0];
    assert.ok(slot, 'the first waiter took the slot');
    first.child.kill('SIGKILL');
    while (!first.exited) await sleep(10);
    // What an earlier waiter left when it died right after it created its removal lock.
    fs.mkdirSync(path.join(dir, `${slot}.lock`));
    replacement = waiter(home, 'producer-a');
    await sleep(2500);
    assert.equal(replacement.exited, false, `the replacement ran; it exited with code ${replacement.code}: ${replacement.stdout}`);
    assert.doesNotMatch(replacement.stdout, /already_running/);
  } finally {
    for (const w of [first, replacement]) if (w && !w.exited) w.child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a waiter suspended while it removes a stale slot does not remove the slot of the waiter that started meanwhile', async () => {
  const { takeSlot, releaseSlot } = await import('../src/drained-slot.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drained-slot-unit-'));
  try {
    const slot = path.join(dir, 'p.json');
    const dead = { pid: 111, token: 'dead' }, live = new Set([222, 333]);
    const isLive = entry => live.has(entry.pid);
    // A dead waiter's entry is in the slot.
    assert.equal(takeSlot(slot, dead, { isLive: () => false }), null);
    let b = null;
    const a = takeSlot(slot, { pid: 222, token: 'a' }, {
      isLive,
      // A has read the stale entry and is about to remove it; B starts and takes the slot first.
      beforeRemoval() { b = takeSlot(slot, { pid: 333, token: 'b' }, { isLive }); },
    });
    assert.equal(b, null, 'B took the slot');
    assert.equal(a?.pid, 333, 'A reports B as the live holder');
    assert.deepEqual(fs.readdirSync(slot).map(n => JSON.parse(fs.readFileSync(path.join(slot, n), 'utf8')).pid), [333], 'only B holds the slot');
    releaseSlot(slot, { pid: 333, token: 'b' });
    assert.equal(fs.existsSync(slot), false, 'the slot is gone after the holder leaves');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a leftover from a waiter that died between its steps never makes a replacement report a holder', async () => {
  const { takeSlot } = await import('../src/drained-slot.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drained-slot-unit-'));
  try {
    const slot = path.join(dir, 'p.json');
    // Dead waiter 1 died after it made its private directory; dead waiter 2 died holding an emptied slot.
    fs.mkdirSync(`${slot}.111.x.tmp`);
    fs.mkdirSync(slot);
    assert.equal(takeSlot(slot, { pid: 222, token: 'a' }, { isLive: () => false }), null, 'an empty slot is free');
    fs.rmSync(slot, { recursive: true });
    // A legacy pidfile (a plain file) of a dead waiter.
    fs.writeFileSync(slot, JSON.stringify({ pid: 111 }));
    assert.equal(takeSlot(slot, { pid: 222, token: 'a' }, { isLive: () => false }), null, 'a dead legacy pidfile is replaced');
    assert.equal(takeSlot(slot, { pid: 333, token: 'b' }, { isLive: entry => entry.pid === 222 })?.pid, 222, 'a live holder is reported');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
