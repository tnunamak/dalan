#!/usr/bin/env node
// Prepared npm workspaces: the lock plus every workspace manifest and local tarball select a host-prepared tree set (the root
// node_modules and each workspace's own), mounted read-only beside the source. The fixture needs no registry: its only
// dependencies are two local tarballs of different versions, so npm hoists one and nests the other under a workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'ws-prepared-test-')));
process.env.HOME = path.join(root, 'home'); // the default prepared store lives under HOME
fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
const thaw = dir => { try { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return; fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) thaw(path.join(dir, name)); } catch {} };
process.on('exit', () => { thaw(root); fs.rmSync(root, { recursive: true, force: true }); });
const { npmCliPath, prepareNodeModules, resolvePreparedNodeModules, addScratchMountpoints, unsupportedDependencies, localInputFiles } = await import('../src/prepared-node-modules.mjs');
const { runHostBudget } = await import('../src/host-budget.mjs');
const linux = process.platform === 'linux';
const npm = (cwd, ...args) => { const r = spawnSync(process.execPath, [npmCliPath(), ...args], { cwd, encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true', npm_config_cache: path.join(root, 'npm-cache') } }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); };
const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), typeof text === 'string' ? text : JSON.stringify(text)); };

function tarball(dir, name, version, body) {
  const pkg = path.join(root, `pack-${name}-${version}`);
  put(pkg, 'package.json', { name, version, main: 'index.js' }); put(pkg, 'index.js', body);
  npm(pkg, 'pack', '--pack-destination', pkg);
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(pkg, `${name}-${version}.tgz`), path.join(dir, 'vendor', `${name}-${version}.tgz`));
}
function repo(name) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  tarball(dir, 'tarpkg', '1.0.0', 'module.exports = 1;\n'); tarball(dir, 'tarpkg', '2.0.0', 'module.exports = 2;\n');
  put(dir, 'package.json', { name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'], dependencies: { tarpkg: 'file:./vendor/tarpkg-1.0.0.tgz' } });
  put(dir, 'packages/a/package.json', { name: 'a', version: '1.0.0', dependencies: { tarpkg: 'file:../../vendor/tarpkg-2.0.0.tgz', b: '1.0.0' } });
  put(dir, 'packages/a/index.js', "module.exports = { own: require('tarpkg'), sibling: require('b') };\n");
  put(dir, 'packages/b/package.json', { name: 'b', version: '1.0.0' });
  put(dir, 'packages/b/index.js', "module.exports = 'b';\n");
  npm(dir, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund');
  return dir;
}
const source = repo('source');
const read = file => fs.readFileSync(path.join(source, file));

test('workspaces and local tarballs are supported; links, link: specs and escaping paths are not', () => {
  assert.equal(unsupportedDependencies(read('package.json'), read('package-lock.json')), null);
  assert.deepEqual(localInputFiles(read('package-lock.json')), ['packages/a/package.json', 'packages/b/package.json', 'vendor/tarpkg-1.0.0.tgz', 'vendor/tarpkg-2.0.0.tgz']);
  const lock = JSON.parse(read('package-lock.json'));
  const mutate = change => { const copy = structuredClone(lock); change(copy.packages); return JSON.stringify(copy); };
  assert.match(unsupportedDependencies(read('package.json'), mutate(p => { p['node_modules/c'] = { resolved: 'elsewhere/c', link: true }; })), /local or link/, 'a link that is not a workspace');
  assert.match(unsupportedDependencies(read('package.json'), mutate(p => { p['../escape'] = { version: '1.0.0' }; })), /workspace path/);
  assert.match(unsupportedDependencies(read('package.json'), mutate(p => { p['packages/b'].dependencies = { x: 'link:../x' }; })), /local or link/);
  assert.match(unsupportedDependencies(read('package.json'), mutate(p => { p['packages/b'].dependencies = { x: 'file:../x' }; })), /local or link/, 'a file: directory, not a tarball');
  assert.match(unsupportedDependencies(JSON.stringify({ name: 'r', workspaces: ['packages/*'] }), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } })), /workspaces/);
});

test('prepare publishes the root tree and each workspace tree, frozen, and any manifest change makes it unprepared', { skip: !linux }, () => {
  const cacheDir = path.join(root, 'store');
  assert.throws(() => resolvePreparedNodeModules(source, { cacheDir }), { code: 'dependencies_unprepared' });
  const prepared = prepareNodeModules(source, { cacheDir });
  assert.deepEqual(resolvePreparedNodeModules(source, { cacheDir }), prepared);
  assert.deepEqual(prepared.workspaceTrees.map(tree => tree.path), ['packages/a']);
  assert.equal(fs.readFileSync(path.join(prepared.treePath, 'tarpkg', 'index.js'), 'utf8').trim(), 'module.exports = 1;');
  assert.equal(fs.readFileSync(path.join(prepared.workspaceTrees[0].treePath, 'tarpkg', 'index.js'), 'utf8').trim(), 'module.exports = 2;');
  assert.equal(fs.readlinkSync(path.join(prepared.treePath, 'a')), '../packages/a', 'the workspace link points at the source checkout');
  assert.equal(fs.statSync(path.join(prepared.treePath, 'tarpkg', 'index.js')).mode & 0o222, 0, 'frozen');
  assert.equal(prepared.workspaces['packages/a'].length, 64);
  for (const tree of [prepared.treePath, prepared.workspaceTrees[0].treePath]) for (const name of ['.cache', '.vite', '.vite-temp', '.vitest', '.vitest-cache']) { const st = fs.lstatSync(path.join(tree, name)); assert(st.isDirectory() && !(st.mode & 0o222), `${name} is an empty read-only mount point for the sandbox's scratch tmpfs`); assert.deepEqual(fs.readdirSync(path.join(tree, name)), []); }
  // An entry published before the mount points existed gets them back when anything resolves it, still read-only.
  const rootTree = prepared.treePath; fs.chmodSync(rootTree, 0o755); fs.rmdirSync(path.join(rootTree, '.vite-temp')); fs.chmodSync(rootTree, 0o555);
  // A second repair that read the mode while the first had the tree writable must not restore the write bit.
  fs.chmodSync(rootTree, 0o755); fs.rmSync(path.join(rootTree, '.vite-temp'), { recursive: true, force: true }); addScratchMountpoints(rootTree); assert.equal(fs.statSync(rootTree).mode & 0o222, 0);
  resolvePreparedNodeModules(source, { cacheDir });
  assert(fs.lstatSync(path.join(rootTree, '.vite-temp')).isDirectory()); assert.equal(fs.statSync(rootTree).mode & 0o222, 0);
  const original = read('packages/a/package.json');
  fs.appendFileSync(path.join(source, 'packages/a/package.json'), '\n');
  assert.throws(() => resolvePreparedNodeModules(source, { cacheDir }), { code: 'dependencies_unprepared' }, 'a changed workspace manifest');
  fs.writeFileSync(path.join(source, 'packages/a/package.json'), original);
  const tarball1 = path.join(source, 'vendor/tarpkg-1.0.0.tgz'), saved = fs.readFileSync(tarball1);
  fs.appendFileSync(tarball1, 'x');
  assert.throws(() => resolvePreparedNodeModules(source, { cacheDir }), { code: 'dependencies_unprepared' }, 'a changed local tarball');
  fs.writeFileSync(tarball1, saved);
  // A link in a prepared tree may only point at a workspace named by the identity.
  thaw(path.dirname(prepared.treePath));
  fs.symlinkSync('/etc/passwd', path.join(prepared.treePath, 'escape'));
  assert.throws(() => resolvePreparedNodeModules(source, { cacheDir }), { code: 'dependencies_unprepared' });
  fs.unlinkSync(path.join(prepared.treePath, 'escape'));
  fs.symlinkSync('../packages/missing', path.join(prepared.treePath, 'elsewhere'));
  assert.throws(() => resolvePreparedNodeModules(source, { cacheDir }), { code: 'dependencies_unprepared' }, 'a link to a path that is not a workspace');
});

test('two checkouts with one lock and different workspace manifests keep separate entries', { skip: !linux }, () => {
  const cacheDir = path.join(root, 'store-coexist'), other = path.join(root, 'source-other');
  fs.cpSync(source, other, { recursive: true });
  fs.writeFileSync(path.join(other, 'packages/b/package.json'), JSON.stringify({ name: 'b', version: '1.0.0', scripts: { test: 'true' } }));
  const first = prepareNodeModules(source, { cacheDir }), second = prepareNodeModules(other, { cacheDir });
  assert.equal(first.lock_sha256, second.lock_sha256, 'the lock is shared');
  assert.notEqual(first.treePath, second.treePath, 'each identity has its own slot');
  assert.notEqual(first.workspaces['packages/b'] ?? first.manifest_sha256, second.workspaces['packages/b'] ?? second.manifest_sha256);
  assert.deepEqual(resolvePreparedNodeModules(source, { cacheDir }), first, 'the first entry survives the second preparation');
  assert.deepEqual(resolvePreparedNodeModules(other, { cacheDir }), second);
});

const budgets = { cpu_ms: 60000, wall_ms: 90000, memory_bytes: 1024 * 1024 * 1024, processes: 128, disk_write_bytes: 128 * 1024 * 1024, output_bytes: 65536 };
test('the sandbox resolves the root tree, the workspace tree and the workspace links, read-only', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  prepareNodeModules(source); // the default store under HOME, where a host check looks
  const probe = [
    'cd /workspace && /runtime/node -e "console.log(\'ROOT\', require(\'tarpkg\'))"',
    'cd /workspace/packages/a && /runtime/node -e "const m = require(\'./index.js\'); console.log(\'WS\', m.own, m.sibling)"',
    'touch /workspace/packages/a/node_modules/denied 2>&1 | head -1',
    'cd /workspace && /runtime/node -e "console.log(\'LINK\', require(\'a\').own)"',
  ].join('\n');
  const r = await runHostBudget({ dir: source, budgets, enabled: true, phases: [{ name: 'check', argv: ['/usr/bin/bash', '-c', probe] }] });
  const out = r.bytes.toString();
  assert.equal(r.error, null, out); assert.equal(r.exit.code, 0, out);
  assert.match(out, /ROOT 1/); assert.match(out, /WS 2 b/); assert.match(out, /Read-only file system/); assert.match(out, /LINK 2/);
  assert.equal(r.dependencies.workspaces['packages/a'].length, 64);
});

test('the sandbox refuses a workspace manifest that differs from the prepared one', { skip: !linux && 'Linux systemd/cgroup backend required' }, async () => {
  fs.appendFileSync(path.join(source, 'packages/b/package.json'), '\n');
  await assert.rejects(runHostBudget({ dir: source, budgets, enabled: true, phases: [{ name: 'check', argv: ['/usr/bin/true'] }] }), { code: 'dependencies_unprepared' });
});
