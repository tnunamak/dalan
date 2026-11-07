#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as projects from '../src/projects.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-completeness-'));
  let repo = path.join(home, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(repo, 'scope'));
  fs.writeFileSync(path.join(repo, 'scope', 'file.txt'), 'scope blob\n');
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'outside blob\n');
  fs.symlinkSync('nonexistent-target', path.join(repo, 'scope', 'link'));
  git('add', '.');
  // A gitlink names a commit in another repository; it need not exist here.
  git('update-index', '--add', '--cacheinfo', '160000', '1234567890123456789012345678901234567890', 'scope/submodule');
  git('commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const mirror = path.join(home, 'mirror.git');
  execFileSync('git', ['clone', '-q', '--bare', '--no-hardlinks', repo, mirror]);
  repo = mirror;
  const remove = oid => fs.unlinkSync(path.join(repo, 'objects', oid.slice(0, 2), oid.slice(2)));
  return { repo, git, sha, remove, close: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function rejectsMissing(f, type, oid, file) {
  assert.throws(() => projects.verifyFetchedCommit(f.repo, f.sha, 'base'), error => {
    // The requester cannot repair the bridge's mirror: this is infrastructure, not invalid input.
    assert.equal(error.code, 'DOT_BRIDGE_INFRASTRUCTURE');
    assert.equal(error.mirrorIncomplete, true);
    assert.equal(error.message, `base SHA ${f.sha}: the bridge's mirror is incomplete: missing ${type} ${oid} for ${file} under the pinned commit.`);
    assert.ok(!error.message.includes(f.repo));
    return true;
  });
}

test('B1: missing blob is refused with its OID and path', () => {
  const f = fixture();
  try { const oid = f.git('rev-parse', 'HEAD:scope/file.txt'); f.remove(oid); rejectsMissing(f, 'blob', oid, 'scope/file.txt'); }
  finally { f.close(); }
});
test('B2: intact mirror admits dangling symlink and external submodule', () => {
  const f = fixture();
  try { assert.doesNotThrow(() => projects.verifyFetchedCommit(f.repo, f.sha, 'base')); }
  finally { f.close(); }
});
test('B3: missing subtree is refused with its tree OID and path', () => {
  const f = fixture();
  try { const oid = f.git('rev-parse', 'HEAD:scope'); f.remove(oid); rejectsMissing(f, 'tree', oid, 'scope'); }
  finally { f.close(); }
});
test('the check covers the whole tree, not only the job scope', () => {
  const f = fixture();
  try { const oid = f.git('rev-parse', 'HEAD:outside.txt'); f.remove(oid); rejectsMissing(f, 'blob', oid, 'outside.txt'); }
  finally { f.close(); }
});
test('absent commit retains the existing invalid-input message', () => {
  const f = fixture();
  try {
    assert.throws(() => projects.verifyFetchedCommit(f.repo, '0'.repeat(40), 'base'),
      { code: 'DOT_BRIDGE_INVALID_INPUT', message: 'base SHA does not identify a fetched GitHub commit' });
  } finally { f.close(); }
});
