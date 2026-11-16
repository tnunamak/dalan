import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeWorkerInstructions, WORKER_INSTRUCTIONS, WORKER_INSTRUCTIONS_FILE } from '../src/worker-instructions.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-instructions-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, home, file: path.join(home, WORKER_INSTRUCTIONS_FILE) };
}
const temps = home => fs.readdirSync(home).filter(name =>
  name.startsWith('.' + WORKER_INSTRUCTIONS_FILE + '.') && name.endsWith('.tmp'));
function checkGuidance(file) {
  assert.equal(fs.lstatSync(file).isFile(), true);
  assert.equal(fs.readFileSync(file, 'utf8'), WORKER_INSTRUCTIONS);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}

test('replaces the old guidance with a complete private regular file', t => {
  const { home, file } = fixture(t);
  fs.writeFileSync(file, 'old guidance', { mode: 0o644 });
  assert.equal(writeWorkerInstructions(home), file);
  checkGuidance(file);
  assert.deepEqual(temps(home), []);
});

test('replaces a target symlink without writing or chmodding its outside referent', t => {
  const { root, home, file } = fixture(t);
  const sentinel = path.join(root, 'outside-sentinel');
  fs.writeFileSync(sentinel, 'leave this alone', { mode: 0o640 });
  const mode = fs.statSync(sentinel).mode;
  try { fs.symlinkSync(sentinel, file, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('symlink creation is unavailable on this Windows host'); return;
    }
    throw error;
  }
  assert.equal(writeWorkerInstructions(home), file);
  checkGuidance(file);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'leave this alone');
  assert.equal(fs.statSync(sentinel).mode, mode);
  assert.deepEqual(temps(home), []);
});

test('a partial temp write followed by ENOSPC keeps the old target and removes the temp', t => {
  const { home, file } = fixture(t);
  fs.writeFileSync(file, 'old guidance', { mode: 0o600 });
  const failure = Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
  let writes = 0;
  const injected = { ...fs, writeFileSync(target, ...args) {
    writes++;
    assert.notEqual(target, file, 'never write through the published target');
    assert.equal(fs.readFileSync(file, 'utf8'), 'old guidance', 'old file survives until rename');
    fs.writeFileSync(target, 'partial');
    throw failure;
  } };
  assert.throws(() => writeWorkerInstructions(home, { fs: injected }), error => error === failure);
  assert.equal(writes, 1, 'the injected write was exercised');
  assert.equal(fs.readFileSync(file, 'utf8'), 'old guidance');
  assert.deepEqual(temps(home), []);
});

test('first publication leaves only the complete guidance and no sibling temp', t => {
  const { home, file } = fixture(t);
  writeWorkerInstructions(home);
  checkGuidance(file);
  assert.deepEqual(fs.readdirSync(home), [WORKER_INSTRUCTIONS_FILE]);
});

for (const operation of ['fsyncSync', 'renameSync']) test(operation + ' failure preserves the old copy', t => {
  const { home, file } = fixture(t);
  fs.writeFileSync(file, 'old guidance');
  const failure = Object.assign(new Error('synthetic ' + operation + ' failure'), { code: 'EIO' });
  let calls = 0;
  const injected = { ...fs, [operation](...args) { calls++; throw failure; } };
  assert.throws(() => writeWorkerInstructions(home, { fs: injected }), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old guidance');
  assert.deepEqual(temps(home), []);
});

test('writes, syncs and closes the private descriptor before renaming the target', t => {
  const { home, file } = fixture(t);
  fs.writeFileSync(file, 'old guidance');
  const events = [];
  let privateFd, privatePath;
  const injected = {
    ...fs,
    openSync(name, flags, mode) {
      assert.equal(path.dirname(name), home);
      assert.notEqual(name, file);
      assert.equal(flags, 'wx');
      assert.equal(mode, 0o600);
      privatePath = name;
      privateFd = fs.openSync(name, flags, mode);
      events.push('open');
      return privateFd;
    },
    writeFileSync(fd, text) {
      assert.equal(fd, privateFd);
      assert.equal(fs.readFileSync(file, 'utf8'), 'old guidance');
      events.push('write'); return fs.writeFileSync(fd, text);
    },
    fchmodSync(fd, mode) {
      assert.equal(fd, privateFd); assert.equal(mode, 0o600);
      events.push('mode'); return fs.fchmodSync(fd, mode);
    },
    fsyncSync(fd) {
      assert.equal(fd, privateFd); events.push('sync'); return fs.fsyncSync(fd);
    },
    closeSync(fd) {
      assert.equal(fd, privateFd); events.push('close'); return fs.closeSync(fd);
    },
    renameSync(from, to) {
      assert.equal(from, privatePath); assert.equal(to, file);
      assert.deepEqual(events, ['open', 'write', 'mode', 'sync', 'close']);
      assert.equal(fs.readFileSync(file, 'utf8'), 'old guidance');
      events.push('rename'); return fs.renameSync(from, to);
    },
  };
  writeWorkerInstructions(home, { fs: injected });
  assert.deepEqual(events, ['open', 'write', 'mode', 'sync', 'close', 'rename']);
  checkGuidance(file);
  assert.deepEqual(temps(home), []);
});
