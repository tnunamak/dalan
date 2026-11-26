import { defaultPath } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runtime = () => ({ node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch });
export const preparedNodeStore = options => path.resolve(options.cacheDir ?? defaultPath(os.homedir(),'.dot-bridge/prepared-node-modules'));
export const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const recovery = source => `dalan prepare-deps ${shellQuote(path.resolve(source))}`;

export function readRegular(file, optional = false) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) throw failure('dependencies_invalid', 'manifest must be a regular file');
    return fs.readFileSync(fd);
  } catch (e) {
    if (optional && e.code === 'ENOENT') return null;
    if (e.code === 'dependencies_invalid') throw e;
    throw failure('dependencies_invalid', 'cannot read regular manifest or lock');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Workspaces and local tarballs are the only local inputs the host can prepare: every one is a file the owner pins by hash.
// A workspace is a lock key outside node_modules (npm's own `ci` checks that the lock matches the manifests); a local tarball is a
// `file:` dependency on a .tgz. Directory links, `link:` and `workspace:` specs stay unsupported.
const SAFE_SEGMENT = /^[A-Za-z0-9_@.+-]+$/;
const safeRelative = value => typeof value === 'string' && value.split('/').every(part => SAFE_SEGMENT.test(part) && part !== '.' && part !== '..' && part !== 'node_modules' && part !== '.git');
const LOCAL_TARBALL = /^file:(?:\.\/)?(.+\.(?:tgz|tar\.gz))$/i;
const tarballPath = spec => { const match = LOCAL_TARBALL.exec(String(spec)); return match && safeRelative(match[1]) ? match[1] : null; };
// A dependency spec names its tarball relative to the package that declares it (`file:../../vendor/x.tgz`); only the lock's `resolved` path, relative to the root, decides which file is read.
const tarballSpec = spec => LOCAL_TARBALL.test(String(spec)) && !String(spec).slice(5).startsWith('/') && !/(^|\/)node_modules(\/|$)/.test(String(spec));
const workspaceKeys = data => Object.keys(data.packages).filter(name => name && !name.startsWith('node_modules/') && !name.includes('/node_modules/'));
function unsupportedReason(pkg, data) {
  if (![2, 3].includes(data.lockfileVersion) || !data.packages || typeof data.packages !== 'object') return 'only npm lockfiles of version 2 or 3 are supported';
  const workspaces = new Set(workspaceKeys(data));
  if (workspaces.size && !pkg.workspaces) return 'the lock lists workspaces the manifest does not declare';
  if (pkg.workspaces && !workspaces.size) return 'only root npm lockfiles with their workspaces are supported';
  for (const name of workspaces) if (!safeRelative(name)) return 'a workspace path is unsupported';
  const local = 'local or link dependencies are unsupported';
  for (const [name, entry] of Object.entries(data.packages)) {
    if (name) {
      if (name.includes('/node_modules/') && !name.startsWith('node_modules/') && !workspaces.has(name.split('/node_modules/')[0])) return local;
      if (entry?.link) { if (!name.startsWith('node_modules/') || !workspaces.has(entry.resolved)) return local; continue; }
      if (/^(file:|link:|workspace:)/i.test(entry?.resolved ?? '') && !tarballPath(entry.resolved)) return local;
    }
    for (const group of ['dependencies','devDependencies','optionalDependencies']) for (const value of Object.values(entry?.[group] ?? {})) if (typeof value === 'string' && /^(file:|link:|workspace:)/i.test(value) && !tarballSpec(value)) return local;
  }
  return null;
}
// The repository-relative files that must match the owner's pinned base for a lock to be prepared from it: each workspace's package.json and each local tarball.
export function localInputFiles(lock) {
  const data = JSON.parse(lock);
  const tarballs = Object.values(data.packages ?? {}).map(entry => tarballPath(entry?.resolved)).filter(Boolean);
  return [...new Set([...workspaceKeys(data).map(name => `${name}/package.json`), ...tarballs])].sort();
}
export function unsupportedDependencies(manifest, lock) {
  if (!lock) return null;
  try { return unsupportedReason(JSON.parse(manifest), JSON.parse(lock)); } catch { return null; }
}
function inputs(source) {
  const root = path.resolve(source);
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw failure('dependencies_invalid', 'source directory must be canonical');
  const lock = readRegular(path.join(root, 'package-lock.json'), true);
  if (!lock) return null;
  const manifest = readRegular(path.join(root, 'package.json'));
  let pkg, data;
  try { pkg = JSON.parse(manifest); data = JSON.parse(lock); } catch { throw failure('dependencies_invalid', 'invalid manifest or lock JSON'); }
  const unsupported = unsupportedReason(pkg, data);
  if (unsupported) throw failure('dependencies_unsupported', unsupported);
  const identity = { lock_sha256: hash(lock), manifest_sha256: hash(manifest), runtime: runtime() };
  // Workspace manifests and local tarballs are read without following symlinks, and their hashes join the identity.
  const files = new Map(), workspaces = workspaceKeys(data).sort();
  for (const name of localInputFiles(lock)) {
    const dir = path.dirname(path.join(root, name));
    if (fs.realpathSync(dir) !== dir) throw failure('dependencies_invalid', 'workspace or tarball path must not contain links');
    files.set(name, readRegular(path.join(root, name)));
  }
  if (workspaces.length) identity.workspaces = Object.fromEntries(workspaces.map(name => [name, hash(files.get(`${name}/package.json`))]));
  const manifests = new Set(workspaces.map(name => `${name}/package.json`));
  const tarballs = [...files.keys()].filter(name => !manifests.has(name));
  if (tarballs.length) identity.local_files = Object.fromEntries(tarballs.map(name => [name, hash(files.get(name))]));
  // The slot under the lock is the runtime alone for a repository without workspaces or local files (layout unchanged, so existing entries
  // stay valid). With them, the full identity selects the slot: two checkouts with one lock and different workspace manifests or
  // tarballs each keep their own entry instead of fighting over one.
  const key = identity.workspaces || identity.local_files
    ? hash(JSON.stringify({ runtime: identity.runtime, manifest_sha256: identity.manifest_sha256, workspaces: identity.workspaces ?? {}, local_files: identity.local_files ?? {} }))
    : hash(JSON.stringify(identity.runtime));
  return { root, lock, manifest, files, workspaces, identity, key };
}
// Remove every write bit under a prepared tree so the sandbox's read-only mount and the owner agree on what the bytes are.
export function freezeTree(dir) { const s = fs.lstatSync(dir); if (s.isSymbolicLink()) return; if (s.isDirectory()) for (const name of fs.readdirSync(dir)) freezeTree(path.join(dir, name)); else if (!s.isFile()) throw failure('dependencies_invalid', 'special file in dependency tree'); fs.chmodSync(dir, s.mode & 0o555); }
// Make a staging tree removable again after freezeTree.
export function thawTree(dir) { const st=fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return; fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) thawTree(path.join(dir,name)); }
export function checkDirectory(dir, privateMode = false) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & (privateMode ? 0o077 : 0o022))) throw failure('dependencies_invalid', 'unsafe cache directory ownership or mode');
}
export function checkParents(dir) {
  for (let p = dir; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || (s.uid !== process.getuid() && s.uid !== 0) || (s.mode & 0o022)) throw failure('dependencies_invalid', 'unsafe cache parent');
    if (p === '/') break;
  }
}
// `place` says where this tree sits in the repository layout (dir: its node_modules' parent, relative to the repository root) and which
// workspace paths a link may point at: npm links each workspace into node_modules, and that target is the source checkout, not this tree.
export function validateTree(root, place = null) {
  const walk = dir => {
    const st = fs.lstatSync(dir);
    if (st.uid !== process.getuid() || (!st.isSymbolicLink() && (st.mode & 0o222))) throw failure('dependencies_invalid', 'dependency tree ownership or mode invalid');
    if (st.isSymbolicLink()) {
      if (place) {
        const inRepo = path.posix.join(place.dir, 'node_modules', path.relative(root, path.dirname(dir)).split(path.sep).join('/'));
        const target = path.posix.normalize(path.posix.join(inRepo, fs.readlinkSync(dir)));
        if (!path.isAbsolute(fs.readlinkSync(dir)) && place.workspaces.includes(target)) return;
        // pnpm: a relative link may also point into the root tree or another allowed importer's tree (place.treeDirs); only lexical targets count.
        if (!path.isAbsolute(fs.readlinkSync(dir)) && place.treeDirs?.some(tree => target === tree || target.startsWith(tree + '/'))) return;
      }
      const target = fs.realpathSync(dir);
      if (!target.startsWith(root + path.sep)) throw failure('dependencies_invalid', 'dependency link escapes tree');
    } else if (st.isDirectory()) for (const name of fs.readdirSync(dir)) walk(path.join(dir, name));
    else if (!st.isFile()) throw failure('dependencies_invalid', 'special file in dependency tree');
  };
  walk(root);
}
function entryPath(base, input) { return path.join(base, input.identity.lock_sha256, input.key); }
// Record that a check resolved this entry: the prune ranks entries by the mtime of metadata.json. Touching at most hourly keeps the
// metadata write rare; an owner-only 0400 file can still have its times set by its owner, and a failure here never fails a lookup.
export function markUsed(entry, now = Date.now()) {
  const meta = path.join(entry, 'metadata.json');
  try { if (now - fs.lstatSync(meta).mtimeMs >= 3600e3) fs.utimesSync(meta, now / 1000, now / 1000); } catch { /* best effort */ }
}
// Tools write caches and temp files under node_modules: vite bundles its config into node_modules/.vite-temp (and fails the whole run when it
// cannot), vitest and vite keep results in .vite, babel, eslint and prettier in .cache. The sandbox mounts the tree read-only, so each of these
// names is a real empty directory in every published tree, and the sandbox mounts a small tmpfs over it (host-budget-storage.py names the same
// directories). The store stays read-only and untouched; the writes vanish with the sandbox. A mount point can only exist if the tree has it.
export const SCRATCH_DIRS = ['.cache', '.vite', '.vite-temp', '.vitest', '.vitest-cache'];
export function addScratchMountpoints(tree) {
  const st = fs.lstatSync(tree);
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  const missing = SCRATCH_DIRS.filter(name => { try { fs.lstatSync(path.join(tree, name)); return false; } catch { return true; } });
  if (!missing.length) return;
  fs.chmodSync(tree, st.mode | 0o200);
  try { for (const name of missing) fs.mkdirSync(path.join(tree, name), { mode: 0o555 }); }
  finally { fs.chmodSync(tree, st.mode & 0o7555); } // never restore a write bit: a concurrent repair may have read the mode inside this one's writable window
}
// An entry published before this existed gets its mount points the next time any lookup validates it (the owner's process owns the store).
// Best effort: without them the check still runs, vite just cannot bundle its config.
export function repairScratchMountpoints(trees) { for (const tree of trees) { try { addScratchMountpoints(tree); } catch { /* see above */ } } }
export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function lookup(input, base) {
  const entry = entryPath(base, input);
  try {
    checkParents(base); checkDirectory(base, true); checkDirectory(path.dirname(entry), true); checkDirectory(entry, true);
    const metaPath = path.join(entry, 'metadata.json'), st = fs.lstatSync(metaPath);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o222)) throw new Error('bad metadata');
    const metadata = JSON.parse(readRegular(metaPath));
    if (JSON.stringify(metadata.identity) !== JSON.stringify(input.identity)) throw new Error('identity mismatch');
    const places = [{ dir: '', treePath: path.join(entry, 'node_modules') }, ...(metadata.trees ?? []).map(name => ({ dir: name, treePath: path.join(entry, 'workspaces', name, 'node_modules') }))];
    // Only workspaces the identity names may have a tree; a recorded tree for any other path is refused.
    if (places.slice(1).some(place => !input.workspaces.includes(place.dir))) throw new Error('unexpected workspace tree');
    const workspaces = input.workspaces.map(name => path.posix.normalize(name));
    for (const place of places) validateTree(place.treePath, { dir: place.dir, workspaces });
    repairScratchMountpoints(places.map(place => place.treePath));
    markUsed(entry);
    return { treePath: places[0].treePath, workspaceTrees: places.slice(1).map(({ dir, treePath }) => ({ path: dir, treePath })), ...input.identity };
  } catch (e) {
    throw failure('dependencies_unprepared', `missing or invalid preparation; owner recovery: ${recovery(input.root)} --replace-invalid`);
  }
}
// The `npm` file beside Node is not always JavaScript: mise installs a Bash wrapper there, and
// running that wrapper under Node fails before npm starts. Find npm's own JavaScript entry point:
// the running npm (`npm_execpath`), then the layouts Node installers use, then the sibling file.
export function npmCliPath({ execPath = process.execPath, env = process.env } = {}) {
  const binDir = path.dirname(execPath);
  const real = file => { try { return fs.realpathSync(file); } catch { return null; } };
  const entry = file => { const resolved = real(file); return resolved && fs.statSync(resolved).isFile() ? resolved : null; };
  const fromEnv = env.npm_execpath && path.basename(env.npm_execpath) === 'npm-cli.js' ? entry(env.npm_execpath) : null;
  const sibling = path.join(binDir, 'npm');
  return fromEnv
    ?? entry(path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    ?? entry(path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    ?? (path.basename(real(sibling) ?? '') === 'npm-cli.js' ? real(sibling) : sibling);
}
export function resolvePreparedNodeModules(sourceDir, options = {}) {
  const input = inputs(sourceDir);
  return input ? lookup(input, preparedNodeStore(options)) : null;
}
export function prepareNodeModules(sourceDir, options = {}) {
  const input = inputs(sourceDir);
  if (!input) throw failure('dependencies_invalid', 'root package-lock.json required');
  const base = preparedNodeStore(options);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  checkParents(base); checkDirectory(base, true);
  const lockDir = path.join(base, input.identity.lock_sha256);
  fs.mkdirSync(lockDir, { mode: 0o700, recursive: true }); checkDirectory(lockDir, true);
  const destination = entryPath(base, input);
  if (fs.existsSync(destination)) {
    try { return lookup(input, base); }
    catch(error) { if(!options.replaceInvalid)throw error; }
  }
  const stage = fs.mkdtempSync(path.join(base, `.stage-${process.pid}-`));
  try {
    // npm runs in work/ with the lock, the root manifest, every workspace manifest and every local tarball; only the node_modules trees are published.
    const work = path.join(stage, 'work');
    fs.mkdirSync(work, { mode: 0o700 });
    fs.writeFileSync(path.join(work, 'package.json'), input.manifest, { mode: 0o600 });
    fs.writeFileSync(path.join(work, 'package-lock.json'), input.lock, { mode: 0o600 });
    for (const [name, bytes] of input.files) { fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(work, name), bytes, { mode: 0o600 }); }
    const env = options.env ?? process.env, execPath = options.execPath ?? process.execPath;
    const npm = npmCliPath({ execPath, env });
    const run = spawnSync(execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: work, env: { ...env, npm_config_ignore_scripts: 'true' }, stdio: 'ignore' });
    if (run.error || run.status !== 0) {
      const exit = run.error ? `error: ${run.error.message}` : run.signal ? `signal ${run.signal}` : `exit status ${run.status}`;
      throw failure('dependencies_install_failed', `npm ci failed (ran ${npm}; ${exit}); no preparation published`);
    }
    const workspaces = input.workspaces.map(name => path.posix.normalize(name));
    const trees = [];
    fs.mkdirSync(path.join(work, 'node_modules'), { recursive: true, mode: 0o700 });
    fs.renameSync(path.join(work, 'node_modules'), path.join(stage, 'node_modules'));
    for (const name of input.workspaces) {
      const tree = path.join(work, name, 'node_modules');
      if (!fs.existsSync(tree)) continue;
      fs.mkdirSync(path.join(stage, 'workspaces', name), { recursive: true, mode: 0o700 });
      fs.renameSync(tree, path.join(stage, 'workspaces', name, 'node_modules')); trees.push(name);
    }
    fs.rmSync(work, { recursive: true, force: true });
    for (const [dir, tree] of [['', path.join(stage, 'node_modules')], ...trees.map(name => [name, path.join(stage, 'workspaces', name, 'node_modules')])]) { addScratchMountpoints(tree); freezeTree(tree); validateTree(tree, { dir, workspaces }); }
    fs.writeFileSync(path.join(stage, 'metadata.json'), JSON.stringify({ identity: input.identity, trees }) + '\n', { mode: 0o400 });
    if(fs.existsSync(destination)) {
      // Recheck after npm: a concurrent owner preparation may have finished.
      try { return lookup(input, base); }
      catch(error) { if(!options.replaceInvalid)throw error; }
      // Preserve old inodes for any active read-only mount. An explicit owner
      // repair publishes new bytes without modifying a running check's input.
      fs.renameSync(destination,path.join(base,'.replaced-'+randomUUID()));
    }
    // The private publication directory remains owner-writable for explicit recovery.
    fs.renameSync(stage, destination);
    return lookup(input, base);
  } finally { if (fs.existsSync(stage)) {
    thawTree(stage); fs.rmSync(stage, { recursive: true, force: true });
  } }
}

// Prepare in a child process so a minutes-long `npm ci` does not stop the bridge's event loop. The child is the same
// `dalan prepare-deps` the owner runs by hand, so it publishes to the same private store and under the same checks.
// Callers must only pass a source whose manifest and lock the owner already trusts (a pinned base commit).
const inFlight = new Map();
// A stage directory names the process that owns it, so a killed child's parent removes exactly that child's stages.
const listStages = (base, pid) => { try { return fs.readdirSync(base).filter(name => name.startsWith(`.stage-${pid}-`)); } catch { return []; } };
export function prepareNodeModulesInChild(sourceDir, { timeoutMs = 600000, env = process.env } = {}) {
  const root = fs.realpathSync(sourceDir);
  const input = inputs(root);
  if (!input) return Promise.resolve(null);
  return prepareInChild({ root, key: `${input.identity.lock_sha256}:${input.key}`, base: preparedNodeStore({}), flags: [], timeoutMs, env });
}
// Shared by every kind of preparation: one in-flight child per key, own process group, stage cleanup after a timeout kill.
export function prepareInChild({ root, key, base, flags, timeoutMs = 600000, env = process.env }) {
  const running = inFlight.get(key);
  if (running) return running;
  const cli = fileURLToPath(new URL('../bin/dot-worker.mjs', import.meta.url));
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => /^(PATH|HOME|LANG|TMPDIR|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|(npm|pnpm)_config_.*|GOPROXY|GOSUMDB|(https?|no)_proxy)$/i.test(name)));
  const done = new Promise((resolve, reject) => {
    // Own process group: npm runs under the CLI's synchronous spawn, so killing the CLI alone would leave npm installing.
    const child = spawn(process.execPath, [cli, 'prepare-deps', root, '--json', ...flags], { env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', chunk => { if (out.length < 1 << 20) out += chunk; });
    child.stderr.on('data', chunk => { if (err.length < 1 << 16) err += chunk; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(failure('dependencies_install_failed', `automatic preparation could not start: ${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        // The killed CLI cannot clean up after itself: remove the staging directories it left (named by its pid), never another preparation's.
        for (const name of listStages(base, child.pid)) { try { thawTree(path.join(base, name)); fs.rmSync(path.join(base, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {} }
        return reject(failure('dependencies_install_failed', `automatic preparation failed (timed out after ${Math.round(timeoutMs / 1000)} s)`));
      }
      if (code !== 0) return reject(failure('dependencies_install_failed', `automatic preparation failed (exit ${code}): ${err.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`));
      try { resolve(JSON.parse(out)); } catch { reject(failure('dependencies_install_failed', 'automatic preparation printed no result')); }
    });
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, done);
  return done;
}
