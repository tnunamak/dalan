#!/usr/bin/env node
// Prepared Go modules: a repository's go.mod and go.sum alone select a host-prepared module cache that the offline sandbox
// mounts read-only. The test serves a real module through a file:// GOPROXY, so nothing here needs the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'go-modules-test-'));
process.env.HOME = path.join(root, 'home'); // the default prepared store lives under HOME
fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
process.on('exit', () => { try { for (const dir of fs.readdirSync(root)) thaw(path.join(root, dir)); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
const thaw = dir => { try { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return; fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) thaw(path.join(dir, name)); } catch {} };
const { prepareGoModules, resolvePreparedGoModules, pruneGoStore, unsupportedGoModules, goModulesUnsupported } = await import('../src/prepared-go-modules.mjs');
const { runHostBudget } = await import('../src/host-budget.mjs');
const hasGo = fs.existsSync('/usr/bin/go');
const linux = process.platform === 'linux' && hasGo;

const goVersion = !hasGo ? 'go1.21' : spawnSync('/usr/bin/go', ['env', 'GOVERSION'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GOTOOLCHAIN: 'local' } }).stdout.trim();
const goLine = goVersion.replace(/^go(\d+\.\d+).*/, '$1'); // the host's own version: the toolchain never needs to switch here
const run = (cmd, args, cwd, env = {}) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, GOCACHE: path.join(root, 'gocache'), GOMODCACHE: path.join(root, 'gomod'), GOFLAGS: '-modcacherw', ...env } }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout; };

// A module example.org/dep v1.0.0 served from a file:// proxy.
const proxy = path.join(root, 'proxy', 'example.org', 'dep', '@v'); fs.mkdirSync(proxy, { recursive: true });
fs.writeFileSync(path.join(proxy, 'v1.0.0.info'), JSON.stringify({ Version: 'v1.0.0', Time: '2026-01-01T00:00:00Z' }));
fs.writeFileSync(path.join(proxy, 'v1.0.0.mod'), `module example.org/dep\n\ngo ${goLine}\n`);
fs.writeFileSync(path.join(proxy, 'list'), 'v1.0.0\n');
const zipScript = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('example.org/dep@v1.0.0/go.mod',open(sys.argv[2]).read())\nz.writestr('example.org/dep@v1.0.0/dep.go','package dep\\n\\nfunc Answer() int { return 42 }\\n')\nz.close()\n`;
spawnSync('python3', ['-c', zipScript, path.join(proxy, 'v1.0.0.zip'), path.join(proxy, 'v1.0.0.mod')], { stdio: 'inherit' });
const offlineEnv = { GOPROXY: 'file://' + path.join(root, 'proxy'), GOSUMDB: 'off' };

function repo(name, goMod, files = {}) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'go.mod'), goMod);
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
  return fs.realpathSync(dir);
}
const withDep = `module example.com/app\n\ngo ${goLine}\n\nrequire example.org/dep v1.0.0\n`;
const app = repo('app', withDep, {
  'app_test.go': 'package app\n\nimport (\n\t"testing"\n\n\t"example.org/dep"\n)\n\nfunc TestAnswer(t *testing.T) {\n\tif dep.Answer() != 42 {\n\t\tt.Fatal("wrong")\n\t}\n}\n',
  'app.go': 'package app\n',
});
if (hasGo) run('/usr/bin/go', ['mod', 'tidy'], app, { ...offlineEnv, GOTOOLCHAIN: 'local' }); // writes go.sum from the proxy

test('unsupported go.mod shapes are named, and a plain one is not', () => {
  assert.equal(unsupportedGoModules(withDep), null);
  assert.match(unsupportedGoModules('module a\n\nreplace example.org/dep => ../dep\n'), /local replace/);
  assert.match(unsupportedGoModules('module a\n\nreplace (\n\texample.org/dep => /abs/dep\n)\n'), /local replace/);
  assert.equal(unsupportedGoModules('module a\n\nreplace example.org/dep => example.org/fork v1.0.1\n'), null, 'a replace by another module is a download, not a local path');
  assert.equal(goModulesUnsupported(null, true), null, 'no go.mod: nothing to prepare');
  assert.match(goModulesUnsupported(Buffer.from('module a\n'), true), /go\.work/);
});

test('no go.mod is nothing to prepare; unprepared and unsupported are distinct errors', () => {
  const none = fs.realpathSync(fs.mkdtempSync(path.join(root, 'none-')));
  assert.equal(resolvePreparedGoModules(none), null);
  assert.throws(() => resolvePreparedGoModules(app), { code: 'dependencies_unprepared' });
  const local = repo('local', 'module a\n\ngo 1.21\n\nreplace example.org/dep => ../dep\n');
  assert.throws(() => prepareGoModules(local), { code: 'dependencies_unsupported' });
  const work = repo('work', 'module a\n\ngo 1.21\n', { 'go.work': 'go 1.21\n\nuse .\n' });
  assert.throws(() => resolvePreparedGoModules(work), { code: 'dependencies_unsupported' });
});

test('a failed download publishes nothing and leaves no stage behind', { skip: !linux }, () => {
  const bad = repo('bad', withDep);
  fs.copyFileSync(path.join(app, 'go.sum'), path.join(bad, 'go.sum'));
  const cacheDir = path.join(root, 'failed-store');
  assert.throws(() => prepareGoModules(bad, { cacheDir, env: { GOPROXY: 'off' } }), { code: 'dependencies_install_failed' });
  assert.throws(() => resolvePreparedGoModules(bad, { cacheDir }), { code: 'dependencies_unprepared' });
  assert.deepEqual(fs.readdirSync(cacheDir).filter(name => name.startsWith('.stage-')), []);
});

test('prepare publishes a frozen cache keyed by go.mod and go.sum, and any change makes it unprepared', { skip: !linux }, () => {
  const cacheDir = path.join(root, 'store');
  const prepared = prepareGoModules(app, { cacheDir, env: offlineEnv });
  assert.deepEqual(resolvePreparedGoModules(app, { cacheDir }), prepared);
  assert(fs.existsSync(path.join(prepared.treePath, 'example.org', 'dep@v1.0.0', 'dep.go')));
  assert.equal(fs.statSync(path.join(prepared.treePath, 'example.org', 'dep@v1.0.0', 'dep.go')).mode & 0o222, 0, 'frozen: no write bits');
  assert.deepEqual(prepareGoModules(app, { cacheDir, env: offlineEnv }), prepared, 'a second prepare finds the entry');
  fs.appendFileSync(path.join(app, 'go.mod'), '\n// edited\n');
  assert.throws(() => resolvePreparedGoModules(app, { cacheDir }), { code: 'dependencies_unprepared' });
  fs.writeFileSync(path.join(app, 'go.mod'), withDep);
  fs.chmodSync(path.join(path.dirname(prepared.treePath), 'metadata.json'), 0o600);
  fs.writeFileSync(path.join(path.dirname(prepared.treePath), 'metadata.json'), '{"identity":{}}\n');
  assert.throws(() => resolvePreparedGoModules(app, { cacheDir }), { code: 'dependencies_unprepared' }, 'tampered metadata is refused');
});

test('a check that resolves an entry marks it used', { skip: !linux }, () => {
  const cacheDir = path.join(root, 'store-use');
  const prepared = prepareGoModules(app, { cacheDir, env: offlineEnv });
  const meta = path.join(path.dirname(prepared.treePath), 'metadata.json'), old = new Date(Date.now() - 5 * 3600e3);
  fs.utimesSync(meta, old, old);
  resolvePreparedGoModules(app, { cacheDir });
  assert(Date.now() - fs.statSync(meta).mtimeMs < 60e3, 'last use moved to now');
});

// The go store is capped like the node_modules store: the newest N entries by last use stay, an entry under a day old is never touched,
// an older one is renamed and only a later pass, an hour on, deletes it.
test('the Go module store keeps the newest entries by last use and deletes the rest in two passes', async () => {
  const base = path.join(root, 'store-prune'), now = Date.now(), H = 3600e3, D = 24 * H;
  const make = (lock, usedAgo) => {
    const entry = path.join(base, lock, 'k'); fs.mkdirSync(path.join(entry, 'modcache', 'pkg@v1'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(entry, 'modcache', 'pkg@v1', 'a.go'), 'package a\n'); fs.writeFileSync(path.join(entry, 'metadata.json'), '{}\n', { mode: 0o400 });
    fs.chmodSync(path.join(entry, 'modcache', 'pkg@v1'), 0o555); fs.chmodSync(path.join(entry, 'modcache'), 0o555);
    const when = new Date(now - usedAgo); fs.utimesSync(path.join(entry, 'metadata.json'), when, when);
    return entry;
  };
  const busy = make('aa', 10 * D), recent = make('bb', 2 * H), mid = make('cc', 3 * D), stale = make('dd', 5 * D), young = make('ee', 3 * H);
  const first = pruneGoStore({ cacheDir: base, keep: 2, now });
  assert.deepEqual(first.kept.sort(), [recent, young].sort(), 'newest two by last use stay, however old their lock dir is');
  assert.deepEqual(first.renamed.sort(), [busy, mid, stale].sort(), 'older entries are renamed, not deleted');
  assert.equal(first.deleted.length, 0);
  assert(!fs.existsSync(busy) && fs.readdirSync(base).filter(n => n.startsWith('.pruned-')).length === 3);
  assert.equal(pruneGoStore({ cacheDir: base, keep: 2, now: now + 30 * 60e3 }).deleted.length, 0, 'not yet an hour on');
  const later = pruneGoStore({ cacheDir: base, keep: 2, now: now + 2 * H });
  assert.equal(later.deleted.length, 3);
  assert.deepEqual(fs.readdirSync(base).filter(n => n.startsWith('.pruned-')), [], 'the frozen trees were thawed and removed');
  assert(fs.existsSync(recent) && fs.existsSync(young));
  // With no cacheDir it prunes the Go store under HOME, not the node_modules store.
  const { defaultPath } = await import('../src/paths.mjs');
  const homeStore = defaultPath(os.homedir(), '.dot-bridge/prepared-go-modules');
  for (const lock of ['xx', 'yy']) { const meta = path.join(homeStore, lock, 'k', 'metadata.json'); fs.mkdirSync(path.dirname(meta), { recursive: true, mode: 0o700 }); fs.writeFileSync(meta, '{}\n', { mode: 0o400 }); const when = new Date(now - (lock === 'xx' ? 9 : 8) * D); fs.utimesSync(meta, when, when); }
  assert.equal(pruneGoStore({ keep: 1, now }).renamed.length, 1, 'the default Go store under HOME');
  const guarded = make('ff', 5 * H); // one more than keep, but under a day old
  assert.equal(pruneGoStore({ cacheDir: base, keep: 1, now }).renamed.length, 0, 'nothing under a day old is touched');
  assert(fs.existsSync(guarded));
});

const budgets = { cpu_ms: 60000, wall_ms: 90000, memory_bytes: 1024 * 1024 * 1024, processes: 128, disk_write_bytes: 256 * 1024 * 1024, output_bytes: 65536 };
test('the sandbox runs go test offline against the prepared cache, read-only', { skip: !linux && 'Linux systemd/cgroup backend and Go required' }, async () => {
  prepareGoModules(app, { env: offlineEnv }); // the default store under HOME, where a host check looks
  const probe = 'echo GOPROXY=$GOPROXY MODCACHE=$GOMODCACHE; touch "$GOMODCACHE/denied" 2>&1 | head -1; /usr/bin/go test ./... 2>&1';
  const r = await runHostBudget({ dir: app, budgets, enabled: true, phases: [{ name: 'check', argv: ['/usr/bin/bash', '-c', probe] }] });
  const out = r.bytes.toString();
  assert.equal(r.error, null, out); assert.equal(r.exit.code, 0, out);
  assert.match(out, /GOPROXY=off MODCACHE=\/cache\/go\/pkg\/mod/);
  assert.match(out, /Read-only file system/, 'the module cache cannot be written from the sandbox');
  assert.match(out, /ok\s+example\.com\/app/, out);
  assert.equal(r.go_modules.go_mod_sha256.length, 64);
});

test('the sandbox refuses a repository whose cache was never prepared', { skip: !linux && 'Linux systemd/cgroup backend and Go required' }, async () => {
  const fresh = repo('fresh', `module example.com/fresh\n\ngo ${goLine}\n`);
  await assert.rejects(runHostBudget({ dir: fresh, budgets, enabled: true, phases: [{ name: 'check', argv: ['/usr/bin/true'] }] }), { code: 'dependencies_unprepared' });
});
