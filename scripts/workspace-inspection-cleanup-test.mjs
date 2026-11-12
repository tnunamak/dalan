import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp/dalan-ws-inspect-'));
process.env.HOME = home;
process.env.DALAN_WORKSPACE_ROOT = path.join(home, 'work');
const { Workspace, restoreOutsideWritable, treeDigest } = await import('../src/workspace.mjs');
const run = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const originalLstat = fs.lstatSync;
const originalExists = fs.existsSync;
const originalRead = fs.readFileSync;
const only = process.env.ONLY;

try {
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  run(['init', '-q'], repo);
  run(['config', 'user.email', 'test@example.com'], repo);
  run(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  run(['add', '.'], repo);
  run(['commit', '-qm', 'base'], repo);

  // A failed parent inspection must not authorize recursive removal of an added path.
  if (!only || only === 'parents') {
    const scratch = fs.mkdtempSync(path.join(home, 'scratch-'));
    const before = await treeDigest(repo, scratch);
    const dir = path.join(repo, 'blocked');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    const file = path.join(dir, 'nested', 'untracked.txt');
    fs.writeFileSync(file, 'keep me\n');
    fs.lstatSync = function (name, ...args) {
      if (String(name) === dir) throw Object.assign(new Error('injected inspection failure'), { code: 'EACCES' });
      return originalLstat.call(this, name, ...args);
    };
    const restored = await restoreOutsideWritable({ dir: repo, scratch, preTree: before.sha256, writable: () => false });
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep me\n', 'the file remains after an unknown parent check');
    assert.match(restored.error, /restore_incomplete/);
    console.log('PASS failed ancestor inspection does not delete added workspace paths');
  }

  // An unknown workspace mirror association must block eviction of all candidate mirrors.
  if (!only || only === 'mirrors') {
    fs.lstatSync = originalLstat;
    const mirrors = path.join(process.env.DALAN_WORKSPACE_ROOT, 'mirrors');
    const mirror = path.join(mirrors, 'fixture.git');
    fs.mkdirSync(mirror, { recursive: true });
    fs.writeFileSync(path.join(mirror, 'HEAD'), 'ref: refs/heads/main\n');
    const marker = path.join(mirror, 'dot-last-used');
    fs.writeFileSync(marker, '');
    const old = new Date(Date.now() - 8 * 86400000);
    fs.utimesSync(marker, old, old);
    const workspace = path.join(home, 'workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, '.git'), `gitdir: ${path.join(mirror, 'worktrees', 'request-unknown')}\n`);
    const realRead = fs.readFileSync;
    fs.readFileSync = function (name, ...args) {
      if (String(name) === path.join(workspace, '.git')) throw Object.assign(new Error('injected inspection failure'), { code: 'EACCES' });
      return realRead.call(this, name, ...args);
    };
    const row = { request_id: 'request-unknown', path: workspace };
    const receiver = {
      store: { db: { prepare(sql) { return { all: () => sql.includes('FROM workspaces') ? [row] : [] }; } } },
      freeBytes: async () => 0,
    };
    const removed = await Workspace.prototype.sweepMirrors.call(receiver, true, 1);
    assert.equal(removed, 0, 'unknown workspace ownership prevents mirror eviction');
    assert.ok(fs.existsSync(mirror), 'the mirror remains');
    console.log('PASS unknown workspace mirror inspection preserves candidate mirrors');
  }

  // A path stat error must preserve the workspace row; only confirmed absence releases it.
  if (!only || only === 'workspace') {
    fs.readFileSync = originalRead;
    fs.existsSync = function (name) {
      if (String(name) === path.join(process.env.DALAN_WORKSPACE_ROOT, 'worktrees', 'request-expired')) return false;
      return originalExists.call(this, name);
    };
    fs.lstatSync = function (name, ...args) {
      if (String(name) === path.join(process.env.DALAN_WORKSPACE_ROOT, 'worktrees', 'request-expired')) throw Object.assign(new Error('injected path inspection failure'), { code: 'EACCES' });
      return originalLstat.call(this, name, ...args);
    };
    const workspace = path.join(process.env.DALAN_WORKSPACE_ROOT, 'worktrees', 'request-expired');
    fs.mkdirSync(workspace, { recursive: true });
    const mirror = path.join(process.env.DALAN_WORKSPACE_ROOT, 'mirrors', 'fixture.git');
    const gitdir = path.join(mirror, 'worktrees', 'request-expired');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.git'), `gitdir: ${gitdir}\n`);
    fs.writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(workspace, '.git')}\n`);
    let deleted = false;
    const row = { request_id: 'request-expired', path: workspace, fetched_at: 'now', status: 'finished', finished_at: new Date(0).toISOString(), cancelled_at: null };
    const receiver = {
      store: { db: { prepare(sql) { return {
        all: () => sql.includes('FROM workspaces') ? [row] : [],
        get: () => row,
        run: () => { deleted = true; },
      }; } } },
      activeChecks: new Set(),
      freeBytes: async () => 100 * 2 ** 30,
      ignoredWrittenFile: () => path.join(home, 'ignored.json'),
      sweepOrphanCaches: async () => 0,
      sweepSharedCaches: async () => 0,
      sweepMirrors: async () => 0,
    };
    const summary = await Workspace.prototype.sweepExpired.call(receiver, () => {});
    assert.equal(deleted, false, 'unknown path status keeps the workspace record');
    assert.equal(summary.workspaces_removed, 0);
    console.log('PASS workspace path inspection failure retains the workspace row');
  }
} finally {
  fs.lstatSync = originalLstat;
  fs.existsSync = originalExists;
  fs.readFileSync = originalRead;
  fs.rmSync(home, { recursive: true, force: true });
}
