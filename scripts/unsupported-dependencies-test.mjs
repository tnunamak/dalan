import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'unsupported-deps-'));
process.env.HOME = home;
const { unsupportedDependencies } = await import('../src/prepared-node-modules.mjs');
const { Workspace } = await import('../src/workspace.mjs');

// Which manifests and locks the host can never prepare, so run_check is not offered for them.
const pkg = extra => JSON.stringify({ name: 'f', version: '1.0.0', ...extra });
const lock = (packages = {}, extra = {}) => JSON.stringify({ name: 'f', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'f', version: '1.0.0' }, ...packages }, ...extra });
const reason = /workspaces|local or link|lockfiles of version/;

assert.equal(unsupportedDependencies(pkg(), lock({ 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' } })), null, 'a plain registry lockfile is supported');
assert.equal(unsupportedDependencies(pkg(), null), null, 'no lockfile: nothing to prepare, not unsupported');
assert.equal(unsupportedDependencies('{not json', lock()), null, 'unparseable input is left to the normal refusal path');
assert.match(unsupportedDependencies(pkg({ workspaces: ['packages/*'] }), lock()), reason, 'workspaces');
assert.match(unsupportedDependencies(pkg(), lock({ 'node_modules/p': { resolved: 'packages/p', link: true } })), reason, 'linked package');
assert.match(unsupportedDependencies(pkg(), lock({ 'packages/p': { version: '1.0.0' } })), reason, 'a package outside node_modules');
assert.match(unsupportedDependencies(pkg(), lock({ 'node_modules/a': { resolved: 'file:../a' } })), reason, 'file: resolution');
assert.match(unsupportedDependencies(pkg(), lock({ '': { name: 'f', dependencies: { a: 'workspace:*' } } })), reason, 'workspace: dependency');
assert.match(unsupportedDependencies(pkg(), lock({}, { lockfileVersion: 1 })), reason, 'lockfileVersion 1');
console.log('PASS unsupported dependencies are recognised without preparing');

// A Go repository is offered or withheld by the same rule: go.mod with a local replace, or a go.work file, cannot be prepared.
{
  const goDir = fs.realpathSync(fs.mkdtempSync(path.join(home, 'go-')));
  const verdict = () => Workspace.prototype.dependenciesUnsupported.call({}, null, goDir, 'dot');
  fs.writeFileSync(path.join(goDir, 'go.mod'), 'module a\n\ngo 1.21\n');
  assert.equal(verdict(), null, 'a plain go.mod is supported');
  fs.writeFileSync(path.join(goDir, 'go.mod'), 'module a\n\ngo 1.21\n\nreplace example.org/dep => ../dep\n');
  assert.match(verdict(), /local replace/, 'a local replace is withheld');
  fs.writeFileSync(path.join(goDir, 'go.mod'), 'module a\n\ngo 1.21\n'); fs.writeFileSync(path.join(goDir, 'go.work'), 'go 1.21\n');
  assert.match(verdict(), /go\.work/, 'go.work is withheld');
  console.log('PASS Go repositories are withheld on a local replace or go.work');
}

// The verdict for a pinned base is memoised: a second claim or get on the same base reads nothing, and the memo is bounded.
try {
  const git = (dir, ...args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, 'repo-')));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(repo, 'package.json'), pkg({ workspaces: ['packages/*'] }));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), lock());
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'workspaces');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const asg = name => ({ execution_scope: 'implementation', inputs: [{ github_repo: `example-owner/${name}`, base_sha: sha }] });
  let mirrors = 0, mirror = repo;
  const self = { mirrorFor: () => { mirrors++; return mirror; } };
  const check = name => Workspace.prototype.dependenciesUnsupported.call(self, asg(name), null, 'dot');

  assert.match(check('r0'), reason, 'first call reads the base');
  assert.equal(mirrors, 1);
  // Move the mirror away: only a memo hit can still answer, and it must not touch the mirror again.
  const gone = `${repo}.moved`; fs.renameSync(repo, gone); mirror = repo;
  assert.match(check('r0'), reason, 'second call on the same base is answered from memory');
  assert.equal(mirrors, 1, 'second call did not look at the mirror');
  // A missing mirror is an unknown, not a verdict: nothing is memoised for it.
  assert.equal(check('absent'), null);
  assert.equal(self.unsupportedMemo.has(`example-owner/absent@${sha}`), false, 'a failed read is not remembered');
  fs.renameSync(gone, repo);
  assert.match(check('absent'), reason, 'once the mirror is back the real verdict is read');

  // Bounded to 256, least recently used out.
  for (let i = 1; i < 300; i++) { check(`r${i}`); if (i === 100) check('r0'); }
  assert.equal(self.unsupportedMemo.size, 256);
  assert.equal(self.unsupportedMemo.has(`example-owner/r1@${sha}`), false, 'an old, untouched entry is evicted');
  assert.equal(self.unsupportedMemo.has(`example-owner/r299@${sha}`), true, 'the newest entry is kept');
  assert.equal(self.unsupportedMemo.has(`example-owner/r0@${sha}`), true, 'an entry used again after r1 was stored is kept');
  console.log('PASS unsupported verdict is memoised per pinned base, bounded, and never remembered for an unreadable mirror');
} finally {
  spawnSync('chmod', ['-R', 'u+w', home]); fs.rmSync(home, { recursive: true, force: true });
}
