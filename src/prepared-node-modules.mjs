import { defaultPath } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
    const npm = path.join(path.dirname(process.execPath), 'npm');
    const run = spawnSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, env: { ...process.env, npm_config_ignore_scripts: 'true' }, stdio: 'ignore' });
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
