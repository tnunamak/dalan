#!/usr/bin/env node
// Prepared pnpm trees: pnpm-lock.yaml plus the root and importer manifests select a host-prepared tree set that the offline sandbox mounts
// read-only. A fixture registry on loopback (a child process, so the blocking pnpm calls cannot stall it) serves two tiny packages, so the
// suite needs no outside network and never touches the live store: every call passes a temp cacheDir.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'pnpm-prepared-test-')));
const realHome = process.env.HOME;
const thaw = dir => { try { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return; fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) thaw(path.join(dir, name)); } catch {} };
process.on('exit', () => { thaw(root); fs.rmSync(root, { recursive: true, force: true }); });
const { preparePnpm, resolvePreparedPnpm, pnpmUnsupportedReason, pnpmUnsupported, pnpmInputFiles, parseLock } = await import('../src/prepared-pnpm.mjs');
const { validateTree, freezeTree, npmCliPath } = await import('../src/prepared-node-modules.mjs');
const { markUsed } = await import('../src/prepared-node-modules.mjs');
const { pruneNodeStore } = await import('../src/prepared-store-prune.mjs');
const { runHostBudget, HOST_BUDGET_CEILINGS } = await import('../src/host-budget.mjs');

const neutral = path.join(root, 'neutral'); fs.mkdirSync(neutral); fs.writeFileSync(path.join(neutral, 'package.json'), '{}');
const probe = spawnSync('pnpm', ['--version'], { cwd: neutral, encoding: 'utf8' });
const pnpmVersion = probe.status === 0 ? probe.stdout.trim() : null;
const linux = process.platform === 'linux';
const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), typeof text === 'string' ? text : JSON.stringify(text)); };
const cacheOf = name => { const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; };

// ---- fixture registry (child process) ----
const registryScript = path.join(root, 'registry.mjs');
fs.writeFileSync(registryScript, `
import http from 'node:http'; import fs from 'node:fs';
const packages = JSON.parse(process.argv[2]);
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url), origin = 'http://127.0.0.1:' + server.address().port;
  for (const pkg of packages) {
    const tarball = '/' + pkg.name + '/-/' + pkg.name + '-' + pkg.version + '.tgz';
    if (url === '/' + pkg.name) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ name: pkg.name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: { name: pkg.name, version: pkg.version, dist: { tarball: origin + tarball, shasum: pkg.shasum, integrity: pkg.integrity } } } })); }
    if (url === tarball) return res.end(fs.readFileSync(pkg.file));
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`);
let registry, registryUrl;
function packTarball(name, version, body) {
  const dir = path.join(root, `pack-${name}`);
  put(dir, 'package.json', { name, version, main: 'index.js' }); put(dir, 'index.js', body);
  const r = spawnSync(process.execPath, [npmCliPath(), 'pack', '--pack-destination', dir], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const file = path.join(dir, `${name}-${version}.tgz`), bytes = fs.readFileSync(file);
  return { name, version, file, shasum: crypto.createHash('sha1').update(bytes).digest('hex'), integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
}
const emptyRc = path.join(root, 'empty-npmrc'); fs.writeFileSync(emptyRc, '');
const fixtureEnv = {};
const deadRegistryEnv = () => ({ ...process.env, ...fixtureEnv, pnpm_config_registry: 'http://127.0.0.1:9/', pnpm_config_fetch_retries: '0' }); // a pnpm that tries to fetch a missing release must not reach the real registry
const offlineEnv = () => ({ ...process.env, ...fixtureEnv, pnpm_config_registry: registryUrl, pnpm_config_fetch_retries: '0', npm_config_userconfig: emptyRc });
before(async () => {
  if (!pnpmVersion) return;
  // A stand-in `pnpm` release: a lock written under a pinned packageManager records pnpm itself, and pnpm resolves it from the registry.
  const packages = [packTarball('tiny-a', '1.0.0', 'module.exports = "a";\n'), packTarball('tiny-b', '1.0.0', 'module.exports = "b";\n'), packTarball('pnpm', pnpmVersion, 'module.exports = "stand-in";\n')];
  registry = spawn(process.execPath, [registryScript, JSON.stringify(packages)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => { registry.stdout.once('data', chunk => resolve(String(chunk).trim())); registry.once('error', reject); });
  registryUrl = `http://127.0.0.1:${port}/`;
});
after(() => { registry?.kill(); });

// A workspace: root depends on tiny-a; packages/w1 on tiny-b and on packages/w2 (which has no dependencies, so the lock has no importer block for it).
function makeRepo(name) {
  const dir = path.join(root, name);
  const manifest = { name: 'root', version: '1.0.0', private: true, packageManager: `pnpm@${pnpmVersion}`, dependencies: { 'tiny-a': '1.0.0' } };
  put(dir, 'package.json', manifest);
  put(dir, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  put(dir, 'packages/w1/package.json', { name: 'w1', version: '1.0.0', dependencies: { 'tiny-b': '1.0.0', w2: 'workspace:*' } });
  put(dir, 'packages/w1/index.js', "module.exports = [require('tiny-a'), require('tiny-b'), require('w2')];\n");
  put(dir, 'packages/w2/package.json', { name: 'w2', version: '1.0.0', main: 'index.js' });
  put(dir, 'packages/w2/index.js', "module.exports = 'w2';\n");
  const lock = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--registry', registryUrl, '--store-dir', path.join(root, 'lock-store')], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...fixtureEnv, CI: 'true', npm_config_userconfig: emptyRc } });
  if (lock.status !== 0) throw new Error(lock.stderr || lock.stdout);
  return dir;
}
const walkFiles = (dir, visit) => { for (const name of fs.readdirSync(dir)) { const full = path.join(dir, name), st = fs.lstatSync(full); if (st.isSymbolicLink()) continue; if (st.isDirectory()) walkFiles(full, visit); else visit(full, st); } };
const readFrom = dir => file => { try { return fs.readFileSync(path.join(dir, file)); } catch { return null; } };

// ---- pure cases: no pnpm, no registry ----
const lockText = (importers = ['.', 'packages/w1']) => `lockfileVersion: '9.0'\n\nimporters:\n\n${importers.map(name => `  ${name}:\n    dependencies:\n      x:\n        specifier: 1.0.0\n        version: 1.0.0\n`).join('\n')}\npackages:\n\n  x@1.0.0:\n    resolution: {integrity: sha512-aaa}\n`;
const reasonOf = (files) => pnpmUnsupportedReason(name => files[name] === undefined ? null : Buffer.from(files[name]));
const base = (extra = {}) => ({ 'pnpm-lock.yaml': lockText(), 'package.json': JSON.stringify({ packageManager: 'pnpm@12.0.0' }), 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n', ...extra });

test('lock parser: importers come from the project document of a two-document lock', () => {
  const two = `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.0.0\n        version: 12.0.0\n\n---\n${lockText(['.', 'apps/site', "'packages/q'"])}`;
  assert.deepEqual(parseLock(two).importers, ['.', 'apps/site', 'packages/q']);
  assert.match(parseLock("lockfileVersion: '6.0'\nimporters:\n").error, /version 9/);
  assert.match(parseLock("lockfileVersion: '9.0'\n").error, /importers/);
  assert.deepEqual(pnpmInputFiles(Buffer.from(lockText())), ['package.json', 'packages/w1/package.json', 'pnpm-lock.yaml']);
});
test('lock parser: an importer written as `{}` is still an importer', () => {
  assert.deepEqual(parseLock("lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/w2: {}\n").importers, ['.', 'packages/w2']);
});
test('repository settings that run code or reach other hosts are refused however they are spelled', () => {
  const yamlReason = yaml => reasonOf(base({ 'pnpm-workspace.yaml': yaml }));
  const pkg = 'packages:\n  - "packages/*"\n';
  for (const bad of ['"pnpmfile": ./hook.cjs\n', "'registry': https://evil.example/\n", '"configDependencies":\n  x: 1.0.0\n', 'registry : https://evil.example/\n', 'globalPnpmfile: x.cjs\n', 'hooks: {}\n', 'patchedDependencies:\n  x: p\n', 'storeDir: /tmp/x\n'])
    assert.match(yamlReason(pkg + bad), /unsupported|does not understand/, bad);
  for (const bad of ['{packages: [a], registry: https://evil.example/}\n', '? pnpmfile\n: x.cjs\n', '<<: *x\n'])
    assert.match(yamlReason(bad), /does not understand/, bad);
  // pdpp's own settings stay supported.
  assert.equal(yamlReason(pkg + "overrides:\n  a: 1.0.0\n  \"@pdpp/x\": \"workspace:*\"\n# comment\npublicHoistPattern:\n  - \"@types/react\"\nchildConcurrency: 1\nallowBuilds:\n  \"esbuild\": true\nminimumReleaseAgeExclude:\n  - a@1.0.0\n"), null);
  const manifestReason = pnpm => reasonOf(base({ 'package.json': JSON.stringify({ packageManager: 'pnpm@12.0.0', pnpm }) }));
  assert.match(manifestReason({ pnpmfile: 'hook.cjs' }), /pnpm\.pnpmfile/);
  assert.match(manifestReason({ configDependencies: { x: '1.0.0' } }), /pnpm\.configDependencies/);
  assert.equal(manifestReason({ overrides: { a: '1.0.0' } }), null);
  assert.match(reasonOf(base({ 'package.json': '{not json' })), /valid JSON/);
});
test('git, URL, directory and runtime resolutions are refused in block layout as well as one line', () => {
  const block = entry => reasonOf(base({ 'pnpm-lock.yaml': lockText() + entry }));
  assert.match(block("  z@https://example.com/z.tgz:\n    resolution:\n      tarball: https://example.com/z.tgz\n"), /URL dependencies/);
  assert.match(block("  z@git+https://example.com/z.git:\n    resolution:\n      type: git\n      repo: https://example.com/z.git\n      commit: abc\n"), /git/);
  assert.match(block("  node@runtime:20.0.0:\n    resolution:\n      type: binary\n      url: https://nodejs.org/node.tar.gz\n"), /runtime/);
  assert.match(block("  y@file:vendor:\n    resolution:\n      directory: vendor\n      type: directory\n"), /local file/);
});
test('unsupported repositories fail closed with a stated reason', () => {
  assert.equal(reasonOf({}), null, 'no lock: nothing to prepare');
  assert.equal(reasonOf(base()), null, 'a plain workspace is supported');
  assert.match(reasonOf(base({ 'package-lock.json': '{}' })), /both package-lock/);
  assert.match(reasonOf(base({ 'package.json': '{}' })), /packageManager/);
  assert.match(reasonOf(base({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.0.0' }) })), /packageManager/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': "lockfileVersion: '6.0'\nimporters:\n" })), /version 9/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': lockText() + '\npatchedDependencies:\n  x@1.0.0:\n    hash: abc\n    path: patches/x.patch\n' })), /patchedDependencies/);
  assert.match(reasonOf(base({ 'package.json': JSON.stringify({ packageManager: 'pnpm@12.0.0', pnpm: { patchedDependencies: { x: 'p' } } }) })), /patchedDependencies/);
  assert.match(reasonOf(base({ '.npmrc': 'registry=https://evil.example/\n' })), /\.npmrc/);
  assert.match(reasonOf(base({ '.pnpmfile.cjs': 'module.exports = {}' })), /pnpmfile/);
  assert.match(reasonOf(base({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\nregistries:\n  default: https://evil.example/\n' })), /registries/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': lockText(['.', 'packages/a b']) })), /importer path/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': lockText(['.', '../escape']) })), /importer path/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': lockText(['packages/w1']) })), /root importer/);
  const linked = target => lockText(['.', 'packages/w1']).replace('version: 1.0.0\n\n  packages/w1', `version: ${target}\n\n  packages/w1`);
  assert.equal(reasonOf(base({ 'pnpm-lock.yaml': linked('link:packages/w1') })), null, 'a link to an importer');
  assert.equal(reasonOf(base({ 'pnpm-lock.yaml': linked('link:packages/other') })), null, 'a link to a dependency-free workspace package named by the globs');
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': linked('link:../outside') })), /not workspace packages/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': linked('link:vendor/x') })), /not workspace packages/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': linked('file:vendor/x.tgz') })), /not workspace packages/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': lockText() + "  y@file:vendor:\n    resolution: {directory: vendor, type: directory}\n" })), /local file or directory/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': lockText() + "  y@file:vendor/y.tgz:\n    resolution: {tarball: file:vendor/y.tgz}\n" })), /local file or directory/);
  // A git-hosted or URL tarball dependency would make fetch run packaging code or contact a host the lock does not vouch for.
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': lockText() + "  z@https://example.com/z.tgz:\n    resolution: {tarball: https://example.com/z.tgz}\n" })), /git and URL dependencies/);
  assert.match(reasonOf(base({ 'pnpm-lock.yaml': lockText() + "  z@git+https://example.com/z.git:\n    resolution: {commit: abc, repo: https://example.com/z.git, type: git}\n" })), /git and URL dependencies/);
});

// ---- validateTree link rules (synthetic trees) ----
function syntheticEntry() {
  const entry = path.join(root, `tree-${crypto.randomUUID()}`);
  const rootTree = path.join(entry, 'node_modules'), aTree = path.join(entry, 'workspaces/packages/a/node_modules'), bTree = path.join(entry, 'workspaces/packages/b/node_modules');
  for (const dir of [path.join(rootTree, '.pnpm/x@1/node_modules/x'), path.join(aTree, '@s'), bTree, path.join(root, 'outside')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(rootTree, '.pnpm/x@1/node_modules/x/index.js'), '1');
  fs.mkdirSync(path.join(bTree, 'y')); fs.writeFileSync(path.join(bTree, 'y/index.js'), '1');
  return { entry, rootTree, aTree, bTree };
}
const place = (dir, withTrees = true) => ({ dir, workspaces: ['packages/a', 'packages/b'], ...(withTrees ? { treeDirs: ['node_modules', 'packages/a/node_modules', 'packages/b/node_modules'] } : {}) });
test('validateTree: relative links into the root tree, importer trees and importer directories are valid; anything else is refused', () => {
  const { rootTree, aTree, bTree } = syntheticEntry();
  fs.symlinkSync('.pnpm/x@1/node_modules/x', path.join(rootTree, 'x'));                  // inside the root tree
  fs.mkdirSync(path.join(rootTree, '@s')); fs.symlinkSync('../../packages/a', path.join(rootTree, '@s/a')); // importer directory (not in the tree)
  fs.symlinkSync('../../../../node_modules/.pnpm/x@1/node_modules/x', path.join(aTree, '@s/x')); // importer tree -> root tree
  fs.symlinkSync('../../b/node_modules/y', path.join(aTree, 'y'));                       // importer tree -> another importer's tree
  fs.symlinkSync('../../../a', path.join(aTree, '@s/a'));                                // importer tree -> importer directory
  for (const tree of [rootTree, aTree, bTree]) freezeTree(tree);
  validateTree(rootTree, place('')); validateTree(aTree, place('packages/a'));
});
test('validateTree: refused links', () => {
  const refuse = (make, where, expected = /dependency link escapes tree|ENOENT/) => {
    const { rootTree, aTree } = syntheticEntry();
    make({ rootTree, aTree });
    freezeTree(where === 'a' ? aTree : rootTree);
    assert.throws(() => validateTree(where === 'a' ? aTree : rootTree, where === 'a' ? place('packages/a') : place('')), expected);
  };
  refuse(({ aTree, rootTree }) => fs.symlinkSync(path.join(rootTree, '.pnpm/x@1/node_modules/x'), path.join(aTree, 'abs')), 'a');   // absolute into the root tree
  refuse(({ aTree }) => fs.symlinkSync(path.join(root, 'outside'), path.join(aTree, 'abs2')), 'a');                                  // absolute outside
  refuse(({ aTree }) => fs.symlinkSync('../../../../../../outside', path.join(aTree, 'esc')), 'a');                                   // relative escape
  refuse(({ aTree }) => fs.symlinkSync('../../../a/src', path.join(aTree, 'src')), 'a');                                              // inside an importer directory but not the directory itself
  refuse(({ aTree }) => fs.symlinkSync('../../../c/node_modules/z', path.join(aTree, 'other')), 'a');                                  // a tree of a path that is not an importer
  refuse(({ rootTree }) => fs.symlinkSync('../../outside', path.join(rootTree, 'esc')), 'root');                                      // root tree escaping
});
test('validateTree: npm behaviour is unchanged (no treeDirs, no cross-tree links)', () => {
  const { rootTree, aTree } = syntheticEntry();
  fs.symlinkSync('../../../../node_modules/.pnpm/x@1/node_modules/x', path.join(aTree, '@s/x'));
  freezeTree(aTree);
  assert.throws(() => validateTree(aTree, place('packages/a', false)), /escapes tree|ENOENT/);
  freezeTree(rootTree); validateTree(rootTree, place('', false));
});

// ---- real preparation against the fixture registry ----
const real = { skip: !pnpmVersion ? 'pnpm is not installed' : false };
test('copy import keeps the store apart from a frozen tree', real, () => {
  const dir = makeRepo('copy-repo'), store = path.join(root, 'copy-store');
  const env = { ...offlineEnv(), CI: 'true' };
  const run = args => { const r = spawnSync('pnpm', args, { cwd: dir, encoding: 'utf8', env }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); };
  run(['fetch', '--package-import-method=copy', '--store-dir', store]);
  run(['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--package-import-method=copy', '--store-dir', store]);
  const storeFiles = new Map(); walkFiles(store, (file, st) => storeFiles.set(file, st.mode & 0o777));
  assert(storeFiles.size > 0);
  freezeTree(path.join(dir, 'node_modules'));
  for (const [file, mode] of storeFiles) assert.equal(fs.statSync(file).mode & 0o777, mode, `store file mode unchanged: ${file}`);
  let shared = 0; walkFiles(path.join(dir, 'node_modules'), (file, st) => { if (st.nlink > 1) shared++; });
  assert.equal(shared, 0, 'no tree file shares an inode with the store');
  thaw(path.join(dir, 'node_modules'));
});
test('prepare publishes the root tree and each importer tree; identity binds every input', real, () => {
  const dir = makeRepo('repo'), cacheDir = cacheOf('cache-main'), env = offlineEnv();
  assert.throws(() => resolvePreparedPnpm(dir, { cacheDir, env }), { code: 'dependencies_unprepared' });
  const prepared = preparePnpm(dir, { cacheDir, env });
  assert.deepEqual(resolvePreparedPnpm(dir, { cacheDir, env }), prepared);
  assert.equal(prepared.kind, 'pnpm');
  assert.deepEqual(Object.keys(prepared.workspaces), ['packages/w1', 'packages/w2'], 'importers named by the lock, including one written as `{}`');
  assert.deepEqual(prepared.workspaceTrees.map(tree => tree.path), ['packages/w1'], 'a tree only where the install made one');
  assert.equal(prepared.runtime.pnpm, pnpmVersion);
  assert(fs.existsSync(path.join(prepared.treePath, 'tiny-a/index.js')));
  assert(fs.lstatSync(path.join(prepared.workspaceTrees[0].treePath, 'tiny-b')).isSymbolicLink(), 'an importer dependency is a link into the root tree');
  walkFiles(path.dirname(prepared.treePath), (file, st) => { assert.equal(st.mode & 0o222, 0, `${file} is read-only`); assert.equal(st.nlink, 1, `${file} is a copy, not a store hardlink`); });
  assert.deepEqual(prepared, preparePnpm(dir, { cacheDir, env }), 'a second prepare finds the entry');
  assert.deepEqual(fs.readdirSync(cacheDir).filter(name => name.startsWith('.')), [], 'no stage or replaced directory remains');
  assert.equal(fs.statSync(path.join(path.dirname(prepared.treePath), 'metadata.json')).mode & 0o777, 0o400);
  // Each input that is bound by the identity makes the entry unprepared when it changes; one that is not bound does not.
  const mutate = (file, change) => { const before = fs.readFileSync(path.join(dir, file)); fs.writeFileSync(path.join(dir, file), change(before.toString())); return () => fs.writeFileSync(path.join(dir, file), before); };
  for (const [file, change] of [['packages/w1/package.json', text => text.replace('1.0.0', '1.0.1')], ['package.json', text => text.replace('"version":"1.0.0"', '"version":"1.0.1"')], ['pnpm-workspace.yaml', text => text + '# x\n'], ['pnpm-lock.yaml', text => text + '\n']]) {
    const restore = mutate(file, change);
    assert.throws(() => resolvePreparedPnpm(dir, { cacheDir, env }), { code: 'dependencies_unprepared' }, `a changed ${file}`);
    restore();
  }
  put(dir, 'packages/w2/package.json', { name: 'w2', version: '9.9.9' });
  assert.throws(() => resolvePreparedPnpm(dir, { cacheDir, env }), { code: 'dependencies_unprepared' }, 'a dependency-free importer (`{}` in the lock) is bound by the identity too');
});
test('a pinned packageManager the host does not have is refused', real, () => {
  const dir = makeRepo('repo-version');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
  put(dir, 'package.json', { ...manifest, packageManager: 'pnpm@1.2.3' });
  assert.throws(() => preparePnpm(dir, { cacheDir: cacheOf('cache-version'), env: deadRegistryEnv() }), { code: 'dependencies_unsupported', message: /pnpm@1\.2\.3/ });
  assert.match(pnpmUnsupported(readFrom(dir), deadRegistryEnv()), /pnpm@1\.2\.3/);
  put(dir, 'package.json', manifest);
  assert.equal(pnpmUnsupported(readFrom(dir), deadRegistryEnv()), null);
  fs.writeFileSync(path.join(dir, '.npmrc'), 'registry=https://evil.example/\n');
  assert.throws(() => preparePnpm(dir, { cacheDir: cacheOf('cache-npmrc'), env: offlineEnv() }), { code: 'dependencies_unsupported', message: /\.npmrc/ });
  assert.match(pnpmUnsupported(readFrom(dir), deadRegistryEnv()), /\.npmrc/);
});
test('a failed install publishes nothing and leaves no stage', real, () => {
  const dir = makeRepo('repo-fail'), cacheDir = cacheOf('cache-fail');
  assert.throws(() => preparePnpm(dir, { cacheDir, timeoutMs: 120000, env: { ...offlineEnv(), pnpm_config_registry: 'http://127.0.0.1:9/' } }), { code: 'dependencies_install_failed', message: /pnpm (fetch|install) failed.*no preparation published/ });
  assert.deepEqual(fs.readdirSync(cacheDir).filter(name => name.startsWith('.')), [], 'no stage directory');
  for (const lock of fs.readdirSync(cacheDir)) assert.deepEqual(fs.readdirSync(path.join(cacheDir, lock)), [], 'no entry published');
  assert.throws(() => resolvePreparedPnpm(dir, { cacheDir, env: offlineEnv() }), { code: 'dependencies_unprepared' });
});
test('concurrent publishers share one valid entry', real, async () => {
  const dir = makeRepo('repo-race'), home = path.join(root, 'race-home'), cacheDir = path.join(home, '.dalan', 'prepared-node-modules');
  fs.mkdirSync(path.join(home, '.dalan'), { recursive: true, mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cli = fileURLToPath(new URL('../bin/dot-worker.mjs', import.meta.url));
  const launch = () => new Promise(resolve => { const child = spawn(process.execPath, [cli, 'prepare-deps', dir, '--json', '--pnpm'], { env: { ...offlineEnv(), HOME: home, XDG_DATA_HOME: path.join(realHome, '.local/share'), XDG_CACHE_HOME: path.join(realHome, '.cache') }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c); child.on('close', code => resolve({ code, out, err })); });
  const [one, two] = await Promise.all([launch(), launch()]);
  assert.equal(one.code, 0, one.err); assert.equal(two.code, 0, two.err);
  assert.equal(JSON.parse(one.out).treePath, JSON.parse(two.out).treePath);
  assert.deepEqual(resolvePreparedPnpm(dir, { cacheDir, env: offlineEnv() }).treePath, JSON.parse(one.out).treePath);
  assert.deepEqual(fs.readdirSync(cacheDir).filter(name => name.startsWith('.stage-')), [], 'no abandoned stage');
});
test('the sandbox runs a check against the prepared trees', { skip: !pnpmVersion ? 'pnpm is not installed' : !linux ? 'linux only' : false }, async () => {
  const dir = makeRepo('repo-sandbox'), home = path.join(root, 'sandbox-home'), cacheDir = path.join(home, '.dalan', 'prepared-node-modules');
  fs.mkdirSync(path.join(home, '.dalan'), { recursive: true, mode: 0o700 }); fs.chmodSync(home, 0o700);
  preparePnpm(dir, { cacheDir, env: offlineEnv() });
  const check = [{ name: 'check', argv: ['/usr/bin/sh', '-c', 'cd /workspace/packages/w1 && node -e "console.log(JSON.stringify(require(\'./index.js\')))"'] }];
  const options = { dir, enabled: true, budgets: { ...HOST_BUDGET_CEILINGS }, phases: check };
  process.env.HOME = home;
  try {
    const result = await runHostBudget(options);
    assert.equal(result.error, null); assert.equal(result.exit.code, 0, result.bytes.toString());
    assert.match(result.bytes.toString(), /\["a","b","w2"\]/);
    assert.equal(result.dependencies.kind, 'pnpm');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    await assert.rejects(runHostBudget(options), { code: 'dependencies_unsupported' }, 'a second lock is refused at admission');
    fs.rmSync(path.join(dir, 'package-lock.json'));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8') + '\n');
    await assert.rejects(runHostBudget(options), { code: 'dependencies_unprepared' }, 'a changed lock needs its own preparation');
  } finally { process.env.HOME = realHome; }
});

// vite bundles its config into node_modules/.vite-temp and aborts the whole run when it cannot create it: any vitest repository failed in 1.4 s on the
// read-only tree. Each published tree now carries empty scratch mount points and the sandbox puts a small tmpfs over them.
const viteProbe = ["const fs = require('fs');",
  "for (const tree of ['/workspace/node_modules', '/workspace/packages/w1/node_modules']) {",
  "  fs.mkdirSync(tree + '/.vite-temp', { recursive: true });", // what vite does first
  "  fs.writeFileSync(tree + '/.vite-temp/vite.config.mjs.123.mjs', 'export default { ok: true }');",
  "  fs.mkdirSync(tree + '/.cache', { recursive: true }); fs.writeFileSync(tree + '/.cache/x', '1');",
  "}",
  "import('/workspace/node_modules/.vite-temp/vite.config.mjs.123.mjs').then(m => console.log('IMPORTED', JSON.stringify(m.default)));",
  "for (const bad of ['/workspace/node_modules/tiny-a/new.js', '/workspace/node_modules/.other/x']) { try { fs.mkdirSync(require('path').dirname(bad), { recursive: true }); fs.writeFileSync(bad, 'x'); console.log('WROTE', bad); } catch { console.log('REFUSED', bad); } }"].join('\n');
test('vite can bundle its config in the sandbox: scratch mount points get a tmpfs and the store stays read-only', { skip: !pnpmVersion ? 'pnpm is not installed' : !linux ? 'linux only' : false }, async () => {
  const dir = makeRepo('repo-scratch'), home = path.join(root, 'scratch-home'), cacheDir = path.join(home, '.dalan', 'prepared-node-modules');
  fs.mkdirSync(path.join(home, '.dalan'), { recursive: true, mode: 0o700 }); fs.chmodSync(home, 0o700);
  put(dir, 'probe.cjs', viteProbe);
  const prepared = preparePnpm(dir, { cacheDir, env: offlineEnv() });
  const trees = [prepared.treePath, ...prepared.workspaceTrees.map(tree => tree.treePath)];
  for (const tree of trees) for (const name of ['.cache', '.vite', '.vite-temp', '.vitest', '.vitest-cache']) assert(fs.lstatSync(path.join(tree, name)).isDirectory(), `${tree} has ${name}`);
  const run = async () => {
    const options = { dir, enabled: true, budgets: { ...HOST_BUDGET_CEILINGS }, phases: [{ name: 'check', argv: ['/usr/bin/sh', '-c', 'cd /workspace && node probe.cjs'] }] };
    process.env.HOME = home;
    try { return (await runHostBudget(options)).bytes.toString(); } finally { process.env.HOME = realHome; }
  };
  const out = await run();
  assert.match(out, /IMPORTED {"ok":true}/, out);
  assert.match(out, /REFUSED \/workspace\/node_modules\/tiny-a\/new\.js/, 'a package directory is still read-only');
  assert.match(out, /REFUSED \/workspace\/node_modules\/\.other\/x/, 'only the named scratch directories are writable');
  for (const tree of trees) for (const name of ['.cache', '.vite-temp']) assert.deepEqual(fs.readdirSync(path.join(tree, name)), [], `${tree}/${name} in the store stays empty`);
  // An entry published before the scratch mount points existed gets them back the next time anything resolves it, and stays read-only.
  for (const tree of trees) { fs.chmodSync(tree, 0o755); for (const name of ['.cache', '.vite', '.vite-temp', '.vitest', '.vitest-cache']) fs.rmdirSync(path.join(tree, name)); fs.chmodSync(tree, 0o555); }
  resolvePreparedPnpm(dir, { cacheDir, env: offlineEnv() });
  for (const tree of trees) { assert.equal(fs.statSync(tree).mode & 0o222, 0, 'the tree is read-only again'); for (const name of ['.cache', '.vite-temp', '.vitest-cache']) assert(fs.lstatSync(path.join(tree, name)).isDirectory(), `${name} restored in ${tree}`); }
  assert.match(await run(), /IMPORTED {"ok":true}/, 'and vite works again'); 
});

test('a pinned-base checkout is prepared once in a child; a changed lock or a repository .npmrc is not', real, async () => {
  const dir = makeRepo('repo-workspace'), home = path.join(root, 'workspace-home'), cacheDir = path.join(home, '.dalan', 'prepared-node-modules');
  fs.mkdirSync(path.join(home, '.dalan'), { recursive: true, mode: 0o700 }); fs.chmodSync(home, 0o700);
  const git = (...args) => { const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const { Workspace } = await import('../src/workspace.mjs');
  const saved = { HOME: process.env.HOME, registry: process.env.pnpm_config_registry, retries: process.env.pnpm_config_fetch_retries };
  Object.assign(process.env, { HOME: home, pnpm_config_registry: registryUrl, pnpm_config_fetch_retries: '0' });
  try {
    assert.equal(Workspace.prototype.dependenciesUnsupported.call({}, {}, dir), null);
    fs.appendFileSync(path.join(dir, 'pnpm-lock.yaml'), '\n');
    await Workspace.prototype.prepareDependencies.call({}, dir, baseSha);
    assert.throws(() => resolvePreparedPnpm(dir, { cacheDir, env: offlineEnv() }), { code: 'dependencies_unprepared' }, 'a lock that differs from the base is never installed');
    git('checkout', '-q', '--', 'pnpm-lock.yaml');
    await Workspace.prototype.prepareDependencies.call({}, dir, baseSha);
    assert.equal(resolvePreparedPnpm(dir, { cacheDir, env: offlineEnv() }).kind, 'pnpm');
    fs.writeFileSync(path.join(dir, '.npmrc'), 'registry=https://evil.example/\n');
    assert.match(Workspace.prototype.dependenciesUnsupported.call({}, {}, dir), /\.npmrc/);
  } finally { for (const [key, name] of [['HOME', 'HOME'], ['registry', 'pnpm_config_registry'], ['retries', 'pnpm_config_fetch_retries']]) { if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key]; } }
});

// ---- prune ----
function fakeStore(name, ages, now) {
  const base = cacheOf(name), entries = [];
  ages.forEach((age, index) => {
    const lock = crypto.createHash('sha256').update(`lock${index}`).digest('hex'), entry = path.join(base, lock, 'key');
    fs.mkdirSync(path.join(entry, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'node_modules/pkg/index.js'), String(index));
    fs.writeFileSync(path.join(entry, 'metadata.json'), '{}', { mode: 0o400 });
    freezeTree(path.join(entry, 'node_modules'));
    const when = new Date(now - age); fs.utimesSync(path.join(entry, 'metadata.json'), when, when);
    entries.push(entry);
  });
  return { base, entries };
}
const H = 3600e3, D = 24 * H;
test('prune keeps the newest N, spares anything under a day old, and deletes only a later pass at least an hour after', () => {
  const now = Date.now();
  const { base, entries } = fakeStore('prune-store', [3 * H, 1 * H, 2 * H, 10 * D, 8 * D, 9 * D], now); // entries 0..5, ages in ms
  const held = fs.openSync(path.join(entries[3], 'node_modules/pkg/index.js'), 'r'); // a running check reading an entry that will be pruned
  try {
    const first = pruneNodeStore({ cacheDir: base, keep: 2, now });
    assert.deepEqual(first.kept.sort(), [entries[1], entries[2]].sort(), 'the two newest');
    assert.deepEqual(first.skipped_young, [entries[0]], 'a third-newest entry under a day old is left alone');
    assert.equal(first.renamed.length, 3);
    assert.deepEqual(first.deleted, []);
    for (const gone of [entries[3], entries[4], entries[5]]) assert(!fs.existsSync(gone));
    const pruned = fs.readdirSync(base).filter(name => name.startsWith('.pruned-'));
    assert.equal(pruned.length, 3);
    assert.equal(fs.readSync(held, Buffer.alloc(8), 0, 8, 0), 1, 'the open file stays readable after the rename');
    const soon = pruneNodeStore({ cacheDir: base, keep: 2, now: now + 30 * 60e3 });
    assert.deepEqual(soon.deleted, [], 'a pruned directory younger than an hour stays');
    assert.equal(fs.readdirSync(base).filter(name => name.startsWith('.pruned-')).length, 3);
    assert.equal(fs.readSync(held, Buffer.alloc(8), 0, 8, 0), 1);
    const later = pruneNodeStore({ cacheDir: base, keep: 2, now: now + 2 * H });
    assert.equal(later.deleted.length, 3);
    assert.deepEqual(fs.readdirSync(base).filter(name => name.startsWith('.')), []);
    assert(fs.existsSync(entries[0]) && fs.existsSync(entries[1]) && fs.existsSync(entries[2]), 'kept and young entries survive every pass');
  } finally { fs.closeSync(held); }
});
test('prune clears stale replaced and abandoned stage directories only after a day', () => {
  const now = Date.now(), { base } = fakeStore('prune-stale', [10 * D], now);
  for (const name of ['.replaced-aaa', '.stage-1-bbb']) { fs.mkdirSync(path.join(base, name, 'node_modules'), { recursive: true }); fs.writeFileSync(path.join(base, name, 'node_modules/f'), 'x'); }
  const staleStage = path.join(base, '.stage-2-old'); fs.mkdirSync(staleStage); fs.utimesSync(staleStage, new Date(now - 2 * D), new Date(now - 2 * D));
  const early = pruneNodeStore({ cacheDir: base, keep: 4, now });
  assert.deepEqual(early.deleted, [staleStage], 'a stage older than a day goes; a fresh stage and a fresh replaced directory stay');
  assert(fs.existsSync(path.join(base, '.replaced-aaa')) && fs.existsSync(path.join(base, '.stage-1-bbb')));
  const late = pruneNodeStore({ cacheDir: base, keep: 4, now: now + 2 * D });
  assert.equal(late.deleted.length, 2);
  assert.throws(() => pruneNodeStore({ cacheDir: base, keep: 0 }), /keep/);
  assert.deepEqual(pruneNodeStore({ cacheDir: path.join(root, 'no-such-store'), keep: 4 }).kept, []);
});
test('dalan prepare-deps --prune runs against the store under HOME and refuses a bad --keep', () => {
  const home = path.join(root, 'cli-home'), base = path.join(home, '.dalan', 'prepared-node-modules');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 }); fs.chmodSync(home, 0o700); fs.chmodSync(path.join(home, '.dalan'), 0o700);
  const cli = fileURLToPath(new URL('../bin/dot-worker.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, 'prepare-deps', ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  const ok = run('--prune', '--keep', '3', '--json');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).kept, []);
  assert.notEqual(run('--prune', '--keep', '0').status, 0);
  assert.notEqual(run('--prune', '--keep').status, 0);
});

// ---- what the host pnpm is asked to do (a fake pnpm records it; no registry, no network) ----
test('fetch and install run with hooks and scripts off, copy import, and only an allow-listed environment', { skip: linux ? false : 'sh only' }, () => {
  const dir = path.join(root, 'fake-pnpm-repo'), bin = path.join(root, 'fake-pnpm-bin'), log = path.join(root, 'fake-pnpm.log');
  put(dir, 'package.json', { name: 'r', packageManager: 'pnpm@12.0.0' }); put(dir, 'pnpm-lock.yaml', lockText(['.']));
  put(bin, 'pnpm', `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 12.0.0; exit 0; fi\necho "ARGS $*" >> '${log}'\nenv | grep -E '^(npm|pnpm)_config_ignore_scripts=|^SECRET_TOKEN=|^npm_config_userconfig=' | sed 's/^/ENV /' >> '${log}'\n[ "$1" = install ] && mkdir -p node_modules\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
  const cacheDir = cacheOf('cache-fake');
  preparePnpm(dir, { cacheDir, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, SECRET_TOKEN: 'leak' } });
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  const args = name => lines.find(line => line.startsWith(`ARGS ${name} `)) ?? '';
  for (const flag of ['--ignore-pnpmfile', '--package-import-method=copy']) { assert(args('fetch').includes(flag), `fetch ${flag}`); assert(args('install').includes(flag), `install ${flag}`); }
  for (const flag of ['--ignore-scripts', '--offline', '--frozen-lockfile']) assert(args('install').includes(flag), `install ${flag}`);
  assert.equal(lines.filter(line => line === 'ENV npm_config_ignore_scripts=true').length, 2, 'both calls see ignore-scripts through npm_config_*');
  assert.equal(lines.filter(line => line === 'ENV pnpm_config_ignore_scripts=true').length, 2, 'and through pnpm_config_* (fetch has no flag)');
  assert(!lines.some(line => line.startsWith('ENV SECRET_TOKEN')), 'an environment variable outside the allow-list is not passed');
  assert.equal(lines.filter(line => line.startsWith('ENV npm_config_userconfig=')).length, 2, 'an empty user rc replaces the owner rc');
});

// ---- prune against a preparation that is still running, and ranking by last use ----
test('prune leaves the empty lock directory of a preparation that is still fetching', () => {
  const now = Date.now(), { base } = fakeStore('prune-fetching', [10 * D], now);
  const fetching = path.join(base, 'f'.repeat(64)); fs.mkdirSync(fetching, { mode: 0o700 });
  const idle = path.join(base, 'e'.repeat(64)); fs.mkdirSync(idle, { mode: 0o700 }); fs.utimesSync(idle, new Date(now - 2 * D), new Date(now - 2 * D));
  pruneNodeStore({ cacheDir: base, keep: 4, now });
  assert(fs.existsSync(fetching), 'a lock directory the publisher just created survives, so its rename can still land');
  assert(!fs.existsSync(idle), 'one that stayed empty for two days is removed');
});
test('prune ranks by last use: an entry a check resolved lately outlives newer idle ones', () => {
  const now = Date.now(), { base, entries } = fakeStore('prune-last-use', [20 * D, 15 * D, 14 * D, 13 * D], now); // entries 1..3 are newer than 0
  markUsed(entries[0], now); // a check resolved the oldest entry just now
  const result = pruneNodeStore({ cacheDir: base, keep: 3, now });
  assert(fs.existsSync(entries[0]), 'the recently used entry is kept');
  assert.deepEqual(result.renamed, [entries[1]], 'the least recently used goes');
});
