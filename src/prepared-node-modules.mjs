import { defaultPath } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runtime = () => ({ node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch });
const store = options => path.resolve(options.cacheDir ?? defaultPath(os.homedir(),'.dot-bridge/prepared-node-modules'));
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const recovery = source => `dalan prepare-deps ${shellQuote(path.resolve(source))}`;

function readRegular(file, optional = false) {
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
function inputs(source) {
  const root = path.resolve(source);
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw failure('dependencies_invalid', 'source directory must be canonical');
  const lock = readRegular(path.join(root, 'package-lock.json'), true);
  if (!lock) return null;
  const manifest = readRegular(path.join(root, 'package.json'));
  let pkg, data;
  try { pkg = JSON.parse(manifest); data = JSON.parse(lock); } catch { throw failure('dependencies_invalid', 'invalid manifest or lock JSON'); }
  if (pkg.workspaces || ![2, 3].includes(data.lockfileVersion) || !data.packages || typeof data.packages !== 'object') throw failure('dependencies_unsupported', 'only root npm lockfiles without workspaces are supported');
  for (const [name, entry] of Object.entries(data.packages)) {
    if (entry?.link || (name && !name.startsWith('node_modules/')) || /^(file:|link:|workspace:)/i.test(entry?.resolved ?? '')) throw failure('dependencies_unsupported', 'local or workspace dependencies are unsupported');
    for (const group of ['dependencies','devDependencies','optionalDependencies']) for (const value of Object.values(entry?.[group] ?? {})) if (typeof value === 'string' && /^(file:|link:|workspace:)/i.test(value)) throw failure('dependencies_unsupported', 'local or workspace dependencies are unsupported');
  }
  const identity = { lock_sha256: hash(lock), manifest_sha256: hash(manifest), runtime: runtime() };
  return { root, lock, manifest, identity, key: hash(JSON.stringify(identity.runtime)) };
}
function checkDirectory(dir, privateMode = false) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & (privateMode ? 0o077 : 0o022))) throw failure('dependencies_invalid', 'unsafe cache directory ownership or mode');
}
function checkParents(dir) {
  for (let p = dir; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || (s.uid !== process.getuid() && s.uid !== 0) || (s.mode & 0o022)) throw failure('dependencies_invalid', 'unsafe cache parent');
    if (p === '/') break;
  }
}
function validateTree(root) {
  const walk = dir => {
    const st = fs.lstatSync(dir);
    if (st.uid !== process.getuid() || (!st.isSymbolicLink() && (st.mode & 0o222))) throw failure('dependencies_invalid', 'dependency tree ownership or mode invalid');
    if (st.isSymbolicLink()) {
      const target = fs.realpathSync(dir);
      if (!target.startsWith(root + path.sep)) throw failure('dependencies_invalid', 'dependency link escapes tree');
    } else if (st.isDirectory()) for (const name of fs.readdirSync(dir)) walk(path.join(dir, name));
    else if (!st.isFile()) throw failure('dependencies_invalid', 'special file in dependency tree');
  };
  walk(root);
}
function entryPath(base, input) { return path.join(base, input.identity.lock_sha256, input.key); }
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function lookup(input, base) {
  const entry = entryPath(base, input);
  try {
    checkParents(base); checkDirectory(base, true); checkDirectory(path.dirname(entry), true); checkDirectory(entry, true);
    const metaPath = path.join(entry, 'metadata.json'), st = fs.lstatSync(metaPath);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o222)) throw new Error('bad metadata');
    const metadata = JSON.parse(readRegular(metaPath));
    if (JSON.stringify(metadata.identity) !== JSON.stringify(input.identity)) throw new Error('identity mismatch');
    const treePath = path.join(entry, 'node_modules'); validateTree(treePath);
    return { treePath, ...input.identity };
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
  return input ? lookup(input, store(options)) : null;
}
export function prepareNodeModules(sourceDir, options = {}) {
  const input = inputs(sourceDir);
  if (!input) throw failure('dependencies_invalid', 'root package-lock.json required');
  const base = store(options);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  checkParents(base); checkDirectory(base, true);
  const lockDir = path.join(base, input.identity.lock_sha256);
  fs.mkdirSync(lockDir, { mode: 0o700, recursive: true }); checkDirectory(lockDir, true);
  const destination = entryPath(base, input);
  if (fs.existsSync(destination)) {
    try { return lookup(input, base); }
    catch(error) { if(!options.replaceInvalid)throw error; }
  }
  const stage = fs.mkdtempSync(path.join(base, '.stage-'));
  try {
    fs.writeFileSync(path.join(stage, 'package.json'), input.manifest, { mode: 0o600 });
    fs.writeFileSync(path.join(stage, 'package-lock.json'), input.lock, { mode: 0o600 });
    const env = options.env ?? process.env, execPath = options.execPath ?? process.execPath;
    const npm = npmCliPath({ execPath, env });
    const run = spawnSync(execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, env: { ...env, npm_config_ignore_scripts: 'true' }, stdio: 'ignore' });
    if (run.error || run.status !== 0) {
      const exit = run.error ? `error: ${run.error.message}` : run.signal ? `signal ${run.signal}` : `exit status ${run.status}`;
      throw failure('dependencies_install_failed', `npm ci failed (ran ${npm}; ${exit}); no preparation published`);
    }
    const tree = path.join(stage, 'node_modules');
    if (!fs.existsSync(tree)) fs.mkdirSync(tree, { mode: 0o700 });
    const freeze = dir => { const s = fs.lstatSync(dir); if (s.isSymbolicLink()) return; if (s.isDirectory()) for (const name of fs.readdirSync(dir)) freeze(path.join(dir, name)); else if (!s.isFile()) throw failure('dependencies_invalid', 'special file in dependency tree'); fs.chmodSync(dir, s.mode & 0o555); };
    freeze(tree); validateTree(tree);
    fs.rmSync(path.join(stage, 'package.json')); fs.rmSync(path.join(stage, 'package-lock.json'));
    fs.writeFileSync(path.join(stage, 'metadata.json'), JSON.stringify({ identity: input.identity }) + '\n', { mode: 0o400 });
    if(fs.existsSync(destination)) {
      // Recheck after npm: a concurrent owner preparation may have finished.
      try { return lookup(input,base); }
      catch(error) { if(!options.replaceInvalid)throw error; }
      // Preserve old inodes for any active read-only mount. An explicit owner
      // repair publishes new bytes without modifying a running check's input.
      fs.renameSync(destination,path.join(base,'.replaced-'+randomUUID()));
    }
    // The private publication directory remains owner-writable for explicit recovery.
    fs.renameSync(stage, destination);
    return lookup(input, base);
  } finally { if (fs.existsSync(stage)) {
    const thaw = dir => { const st=fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return; fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) thaw(path.join(dir,name)); };
    thaw(stage); fs.rmSync(stage, { recursive: true, force: true });
  } }
}

// Prepare in a child process so a minutes-long `npm ci` does not stop the bridge's event loop. The child is the same
// `dalan prepare-deps` the owner runs by hand, so it publishes to the same private store and under the same checks.
// Callers must only pass a source whose manifest and lock the owner already trusts (a pinned base commit).
const inFlight = new Map();
const listStages = base => { try { return fs.readdirSync(base).filter(name => name.startsWith('.stage-')); } catch { return []; } };
export function prepareNodeModulesInChild(sourceDir, { timeoutMs = 600000, env = process.env } = {}) {
  const root = fs.realpathSync(sourceDir);
  const input = inputs(root);
  if (!input) return Promise.resolve(null);
  const key = `${input.identity.lock_sha256}:${input.key}`;
  const running = inFlight.get(key);
  if (running) return running;
  const cli = fileURLToPath(new URL('../bin/dot-worker.mjs', import.meta.url));
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => /^(PATH|HOME|LANG|TMPDIR|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|npm_config_.*|(https?|no)_proxy)$/i.test(name)));
  const base = store({});
  const stagesBefore = new Set(listStages(base));
  const done = new Promise((resolve, reject) => {
    // Own process group: npm runs under the CLI's synchronous spawn, so killing the CLI alone would leave npm installing.
    const child = spawn(process.execPath, [cli, 'prepare-deps', root, '--json'], { env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', chunk => { if (out.length < 1 << 20) out += chunk; });
    child.stderr.on('data', chunk => { if (err.length < 1 << 16) err += chunk; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(failure('dependencies_install_failed', `automatic preparation could not start: ${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        // The killed CLI cannot clean up after itself: remove the staging directories it left, never ones that existed before.
        for (const name of listStages(base)) if (!stagesBefore.has(name)) fs.rmSync(path.join(base, name), { recursive: true, force: true });
        return reject(failure('dependencies_install_failed', `automatic preparation failed (timed out after ${Math.round(timeoutMs / 1000)} s)`));
      }
      if (code !== 0) return reject(failure('dependencies_install_failed', `automatic preparation failed (exit ${code}): ${err.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`));
      try { resolve(JSON.parse(out)); } catch { reject(failure('dependencies_install_failed', 'automatic preparation printed no result')); }
    });
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, done);
  return done;
}
