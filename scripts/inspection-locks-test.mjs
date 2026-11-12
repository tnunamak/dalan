#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireHomeLock } from '../src/try-hosted.mjs';
import { acquireLock } from '../src/pr-head-reviewer.mjs';
import { takeSlot } from '../src/drained-slot.mjs';
import { liveWaiter } from '../src/drained-owner.mjs';
import { waitForChildExit } from '../src/child-exit.mjs';
import { tryInternals } from '../src/try.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inspection-locks-'));
const denied = Object.assign(new Error('injected EIO'), { code: 'EIO' });
const originalKill = process.kill;
test('a failed process probe keeps a hosted trial lock', () => {
  const hosted = path.join(root, 'hosted'); fs.mkdirSync(hosted);
  const hostedLock = path.join(hosted, '.hosted-lock'); fs.writeFileSync(hostedLock, '123456789');
  process.kill = () => { throw denied; };
  assert.throws(() => acquireHomeLock(hosted), /another trial is using this home/);
  assert.equal(fs.readFileSync(hostedLock, 'utf8'), '123456789', 'unknown hosted-lock owner keeps its lock');
  process.kill = originalKill;
});

test('a failed process probe keeps a reviewer lock', () => {
  const reviewer = path.join(root, 'reviewer'); fs.mkdirSync(reviewer);
  const reviewerLock = path.join(reviewer, 'run.lock'); fs.writeFileSync(reviewerLock, '123456789');
  process.kill = () => { throw denied; };
  assert.equal(acquireLock(reviewer), null, 'unknown reviewer-lock owner blocks a second run');
  assert.equal(fs.readFileSync(reviewerLock, 'utf8'), '123456789', 'unknown reviewer-lock owner keeps its lock');
  process.kill = originalKill;
});

test('an unreadable legacy waiter record remains in the drained slot', () => {
  const slot = path.join(root, 'drained.json'); fs.mkdirSync(slot);
  const malformed = path.join(slot, 'broken.json'); fs.writeFileSync(malformed, '{');
  assert.throws(() => takeSlot(slot, { pid: 222, token: 'new' }, { isLive: () => false }), /invalid waiter entry/);
  assert.equal(fs.readFileSync(malformed, 'utf8'), '{', 'malformed waiter entry is retained');
});

test('unknown waiter liveness keeps its entry', () => {
  const unknownSlot = path.join(root, 'unknown.json'); fs.mkdirSync(unknownSlot);
  const unknown = path.join(unknownSlot, '123-a.json'); fs.writeFileSync(unknown, JSON.stringify({ pid: 123, token: 'a' }));
  assert.throws(() => takeSlot(unknownSlot, { pid: 222, token: 'new' }, { isLive: () => null }), /could not inspect waiter/);
  assert.deepEqual(fs.readdirSync(unknownSlot), ['123-a.json'], 'unknown waiter liveness keeps its entry');
});

test('waiter inspection preserves the three outcomes for a live, different or unknown owner', () => {
  const live = (opts = {}) => liveWaiter({ pid: 123 }, { platform: 'linux', probe() {}, readFile: () => 'node bin/dot-worker.mjs wait --drained' , ...opts });
  assert.equal(live(), true, 'a matching command is live');
  assert.equal(live({ readFile: () => 'node unrelated.mjs' }), false, 'a successfully inspected different command is stale');
  assert.equal(live({ readFile: () => { throw denied; } }), null, 'a failed command inspection remains unknown');
  assert.equal(live({ probe() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }, readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), false, 'confirmed ESRCH is stale');
});

test('a child error does not mark a started process stopped until close', async () => {
  const child = new EventEmitter(); child.pid = 1234;
  let closed = false;
  const stopped = waitForChildExit(child, { onClose: () => { closed = true; } });
  child.emit('error', new Error('injected signal failure'));
  await Promise.resolve();
  assert.equal(closed, false, 'error alone does not prove a started child exited');
  child.emit('close');
  await stopped;
  assert.equal(closed, true, 'close confirms the child exited');
});

test('a child error with no PID confirms spawn failure without waiting for close', async () => {
  const child = new EventEmitter();
  let closed = false;
  const stopped = waitForChildExit(child, { onClose: () => { closed = true; } });
  child.emit('error', new Error('injected spawn failure'));
  await stopped;
  await Promise.resolve();
  assert.equal(closed, true, 'no PID means no child process started');
});

test('admin socket probe distinguishes absence from an inspection failure', async () => {
  const fake = (event, value) => {
    const probe = new EventEmitter();
    let timeout;
    probe.setTimeout = (_ms, callback) => { timeout = callback; };
    probe.destroy = () => {};
    queueMicrotask(() => event === 'timeout' ? timeout() : probe.emit(event, value));
    return probe;
  };
  assert.equal(await tryInternals.socketAnswers('/fake', () => fake('connect')), true);
  assert.equal(await tryInternals.socketAnswers('/fake', () => fake('error', Object.assign(new Error('absent'), { code: 'ECONNREFUSED' }))), false);
  await assert.rejects(tryInternals.socketAnswers('/fake', () => fake('error', denied)), /injected EIO/);
  await assert.rejects(tryInternals.socketAnswers('/fake', () => fake('timeout')), /timed out/);
});

process.on('exit', () => {
  process.kill = originalKill;
  fs.rmSync(root, { recursive: true, force: true });
});
