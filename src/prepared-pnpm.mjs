import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hash, failure, markUsed, addScratchMountpoints, repairScratchMountpoints, readRegular, checkDirectory, checkParents, validateTree, freezeTree, thawTree, shellQuote, prepareInChild, preparedNodeStore } from './prepared-node-modules.mjs';

// A pnpm repository's dependencies are prepared on the host (with network) from its lock alone, then mounted read-only like an npm
// workspace tree set: the root node_modules plus each importer's own node_modules. `pnpm fetch` fills a stage-private store from
// pnpm-lock.yaml; an offline frozen install with copy import then assembles the trees (copy, not hardlinks: freezeTree must not change
// store inodes). The sandbox has no network and no pnpm. Same trust rule as npm: the key is file hashes, never a worker's edits.
const recovery = source => `dalan prepare-deps ${shellQuote(path.resolve(source))} --pnpm`;
const SAFE_SEGMENT = /^[A-Za-z0-9_@.+-]+$/;
const safeImporter = value => typeof value === 'string' && value.split('/').every(part => SAFE_SEGMENT.test(part) && part !== '.' && part !== '..' && part !== 'node_modules' && part !== '.git');
// Repository files that make pnpm read repo-controlled settings or run repository code during install.
const SETTINGS_FILES = ['.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpmfile.cjs'];
// pnpm-workspace.yaml is an allow-list, not a deny-list: pnpm reads any top-level key as a setting, and quoted or flow-style spellings of
// registry, pnpmfile or configDependencies keys are real settings that run repository code or reach other hosts. A key that is not here,
// or any YAML shape this line reader does not understand, makes the repository unsupported.
const WORKSPACE_KEYS = new Set(['packages', 'catalog', 'catalogs', 'overrides', 'publicHoistPattern', 'hoistPattern', 'childConcurrency', 'allowBuilds', 'onlyBuiltDependencies', 'ignoredBuiltDependencies', 'neverBuiltDependencies', 'minimumReleaseAge', 'minimumReleaseAgeExclude']);
// package.json#pnpm: the same rule for the root manifest's `pnpm` block.
const MANIFEST_PNPM_KEYS = new Set(['overrides', 'onlyBuiltDependencies', 'ignoredBuiltDependencies', 'neverBuiltDependencies', 'allowBuilds', 'peerDependencyRules']);
export function workspaceYamlReason(yaml) {
  for (const line of String(yaml).split('\n')) {
    if (/^\s*(#|$)/.test(line) || /^[ \t]/.test(line) || /^-(\s|$)/.test(line)) continue; // comments, blank lines, indented values, unindented sequence items
    if (/^---\s*$/.test(line)) continue;
    const key = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z][A-Za-z0-9_]*))\s*:(?:\s|$)/.exec(line);
    if (!key) return 'pnpm-workspace.yaml has a shape this reader does not understand';
    if (!WORKSPACE_KEYS.has(key[1] ?? key[2] ?? key[3])) return `pnpm-workspace.yaml sets ${key[1] ?? key[2] ?? key[3]}, which is unsupported`;
  }
  return null;
}

// importers: keys of the lock's `importers:` block, and the link:/file: specs inside it. A small fail-closed line parser: any shape it
// does not recognise yields null (unsupported) rather than a guess.
export function parseLock(lockText) {
  // pnpm 11+ writes two YAML documents: the environment lock (the pinned pnpm itself), then the project lock. Only the last is the project's.
  const text = String(lockText), lines = text.slice(text.lastIndexOf('\n---\n') + 1).split('\n');
  const version = lines.find(line => /^lockfileVersion:/.test(line));
  if (!version || !/^lockfileVersion:\s*['"]?9\.\d+['"]?\s*$/.test(version)) return { error: 'only pnpm lockfiles of version 9 are supported' };
  const start = lines.findIndex(line => /^importers:\s*$/.test(line));
  if (start < 0) return { error: 'the pnpm lock has no importers block' };
  const importers = [], links = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level block ends importers
    const key = /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s'"#][^:]*)):\s*(?:\{\s*\})?\s*$/.exec(line);
    if (key) { current = key[1] ?? key[2] ?? key[3]; importers.push(current); continue; }
    const spec = /^\s+(?:version|specifier):\s*['"]?(link|file|portal):(\S*?)['"]?\s*$/.exec(line);
    if (spec && current !== null) links.push({ importer: current, kind: spec[1], target: spec[2] });
  }
  // Any line, in any block or flow layout, that names a tarball URL, a git repository, a directory or a downloaded binary runtime.
  const rest = lines.filter(line => /(?:^|[\s{,])(?:tarball|directory|repo|commit|url):\s/.test(line) || /\btype:\s*['"]?(?:git|directory|binary|variations)\b/.test(line));
  return { importers, links, localResolutions: rest.length, patched: lines.some(line => /^patchedDependencies:/.test(line)) };
}

// Workspace package directories come from the `packages:` globs of pnpm-workspace.yaml. A workspace package with no dependencies has no
// importer block in the lock, yet others link to it, so the globs (not only the importers) say which directories a link may name.
export function workspaceGlobs(yaml) {
  const globs = [], lines = String(yaml).split('\n');
  const start = lines.findIndex(line => /^packages:\s*$/.test(line));
  if (start < 0) return globs;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const item = /^\s+-\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (item) globs.push(item[1] ?? item[2] ?? item[3]);
  }
  return globs;
}
const globRegex = glob => new RegExp('^' + glob.replace(/^\.\//, '').replace(/\/$/, '').split('/').map(part => part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')).join('/') + '$');
export function inWorkspaceGlobs(globs, target) {
  const include = globs.filter(glob => !glob.startsWith('!')), exclude = globs.filter(glob => glob.startsWith('!'));
  return include.some(glob => globRegex(glob).test(target)) && !exclude.some(glob => globRegex(glob.slice(1)).test(target));
}
// Real (non-link) directories with a package.json under the globs, to a bounded depth.
function workspaceDirectories(root, globs) {
  const found = [], walk = (rel, depth) => {
    if (depth > 4) return;
    let names; try { names = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ['node_modules', '.git'].includes(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (safeImporter(child) && inWorkspaceGlobs(globs, child) && fs.existsSync(path.join(root, child, 'package.json'))) found.push(child);
      walk(child, depth + 1);
    }
  };
  walk('', 0);
  return found;
}

const manager = manifest => { const match = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/.exec(String(JSON.parse(manifest).packageManager ?? '')); return match ? match[1] : null; };
const safeEnv = env => Object.fromEntries(Object.entries(env).filter(([name]) => /^(PATH|HOME|LANG|TMPDIR|XDG_.*|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|(npm|pnpm)_config_(registry|fetch_retries|fetch_retry_.*)|(https?|no)_proxy)$/i.test(name)));
const versions = new Map(), FAILED_VERSION_TTL_MS = 60e3;
// The version `pnpm` reports for a package.json that pins `packageManager` (pnpm switches to the pinned release when it has it). Run in a
// scratch directory, not the repository, so no repository setting is read. null when pnpm is missing or reports another version.
function hostPnpmVersion(pinned, env, timeout = 5000) {
  const key = `${pinned}\0${env.PATH ?? ''}`;
  const known = versions.get(key);
  if (known && (known.reported !== null || Date.now() - known.at < FAILED_VERSION_TTL_MS)) return known.reported;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dalan-pnpm-version-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'v', packageManager: `pnpm@${pinned}` }));
    const run = spawnSync('pnpm', ['--version'], { cwd: dir, env: { ...safeEnv(env), COREPACK_ENABLE_AUTO_PIN: '0' }, encoding: 'utf8', timeout }); // callers on the claim path keep the 5 s default (spawnSync blocks the bridge); `dalan prepare-deps` allows a download. A failure is remembered for a minute only
    const reported = run.status === 0 ? run.stdout.trim() : null;
    versions.set(key, { reported, at: Date.now() });
    return reported;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Pure verdict from file contents (`read(name)` returns a Buffer or null); null means supported or nothing to prepare. Shared by the offer filter,
// which reads the pinned base commit, and by inputs(), which reads the checkout.
export function pnpmUnsupportedReason(read) {
  const lock = read('pnpm-lock.yaml');
  if (!lock) return null;
  const manifest = read('package.json');
  if (!manifest) return 'a pnpm lock needs a root package.json';
  if (read('package-lock.json')) return 'both package-lock.json and pnpm-lock.yaml are present';
  let pinned, packageJson;
  try { packageJson = JSON.parse(manifest); pinned = manager(manifest); } catch { return 'package.json is not valid JSON'; }
  if (!pinned) return 'package.json must pin packageManager to an exact pnpm version';
  const parsed = parseLock(lock.toString('utf8'));
  if (parsed.error) return parsed.error;
  if (parsed.patched) return 'patchedDependencies are unsupported';
  if (parsed.localResolutions) return 'local file or directory, git and URL dependencies (and downloaded runtimes) are unsupported';
  const importers = new Set(parsed.importers);
  if (!importers.has('.')) return 'the pnpm lock has no root importer';
  for (const name of importers) if (name !== '.' && !safeImporter(name)) return 'an importer path is unsupported';
  const yaml = read('pnpm-workspace.yaml')?.toString('utf8') ?? '', globs = workspaceGlobs(yaml);
  for (const link of parsed.links) {
    const target = link.kind === 'link' ? path.posix.normalize(path.posix.join(link.importer, link.target)) : null;
    if (!target || !(importers.has(target) || (safeImporter(target) && inWorkspaceGlobs(globs, target)))) return 'link or file dependencies that are not workspace packages are unsupported';
  }
  for (const name of SETTINGS_FILES) if (read(name)) return `a repository ${name} is unsupported`;
  const yamlReason = workspaceYamlReason(yaml);
  if (yamlReason) return yamlReason;
  for (const name of Object.keys(packageJson.pnpm ?? {})) if (!MANIFEST_PNPM_KEYS.has(name)) return `package.json sets pnpm.${name}, which is unsupported`;
  return null;
}
// For the offer filter: version check included, memoised per packageManager.
export function pnpmUnsupported(read, env = process.env) {
  const reason = pnpmUnsupportedReason(read);
  if (reason || !read('pnpm-lock.yaml')) return reason;
  const pinned = manager(read('package.json'));
  const reported = hostPnpmVersion(pinned, env);
  return reported === pinned ? null : `the host's pnpm (${reported ?? 'missing'}) is not the pinned packageManager pnpm@${pinned}`;
}
// Repository-relative files that must equal the pinned base for a lock to be prepared from it (pnpm-workspace.yaml is optional).
export function pnpmInputFiles(lock) {
  const parsed = parseLock(lock.toString('utf8'));
  return ['pnpm-lock.yaml', 'package.json', ...(parsed.importers ?? []).filter(name => name !== '.').map(name => `${name}/package.json`)].sort();
}

function inputs(source, env = process.env, versionTimeoutMs = 5000) {
  const root = path.resolve(source);
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw failure('dependencies_invalid', 'source directory must be canonical');
  const read = name => readRegular(path.join(root, name), true);
  const lock = read('pnpm-lock.yaml');
  if (!lock) return null;
  const unsupported = pnpmUnsupportedReason(read);
  if (unsupported) throw failure('dependencies_unsupported', unsupported);
  const manifest = readRegular(path.join(root, 'package.json')), workspaceYaml = read('pnpm-workspace.yaml') ?? Buffer.alloc(0);
  const pinned = manager(manifest);
  const reported = hostPnpmVersion(pinned, env, versionTimeoutMs);
  if (reported !== pinned) throw failure('dependencies_unsupported', `the host's pnpm (${reported ?? 'missing'}) is not the pinned packageManager pnpm@${pinned}`);
  const importers = parseLock(lock.toString('utf8')).importers.filter(name => name !== '.').sort();
  const files = new Map();
  for (const name of importers) {
    const dir = path.join(root, name);
    if (fs.realpathSync(dir) !== dir) throw failure('dependencies_invalid', 'importer path must not contain links');
    for (const settings of SETTINGS_FILES) if (fs.existsSync(path.join(dir, settings))) throw failure('dependencies_unsupported', `an importer ${settings} is unsupported`);
    files.set(name, readRegular(path.join(dir, 'package.json')));
  }
  const linkable = [...new Set([...importers, ...workspaceDirectories(root, workspaceGlobs(workspaceYaml.toString('utf8')))])].sort();
  const runtime = { node: process.version, pnpm: pinned, platform: process.platform, arch: process.arch };
  const identity = { kind: 'pnpm', lock_sha256: hash(lock), manifest_sha256: hash(manifest), workspace_yaml_sha256: hash(workspaceYaml), workspaces: Object.fromEntries(importers.map(name => [name, hash(files.get(name))])), runtime };
  const key = hash(JSON.stringify({ kind: 'pnpm', runtime, manifest_sha256: identity.manifest_sha256, workspace_yaml_sha256: identity.workspace_yaml_sha256, workspaces: identity.workspaces }));
  return { root, lock, manifest, workspaceYaml, hasWorkspaceYaml: read('pnpm-workspace.yaml') !== null, files, importers, linkable, identity, key, pinned };
}
const entryPath = (base, input) => path.join(base, input.identity.lock_sha256, input.key);
const placeFor = (input, dir) => ({ dir, workspaces: input.linkable, treeDirs: ['node_modules', ...input.importers.map(name => `${name}/node_modules`)] });
function lookup(input, base) {
  const entry = entryPath(base, input);
  try {
    checkParents(base); checkDirectory(base, true); checkDirectory(path.dirname(entry), true); checkDirectory(entry, true);
    const metaPath = path.join(entry, 'metadata.json'), st = fs.lstatSync(metaPath);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o222)) throw new Error('bad metadata');
    const metadata = JSON.parse(readRegular(metaPath));
    if (JSON.stringify(metadata.identity) !== JSON.stringify(input.identity)) throw new Error('identity mismatch');
    const places = [{ dir: '', treePath: path.join(entry, 'node_modules') }, ...(metadata.trees ?? []).map(name => ({ dir: name, treePath: path.join(entry, 'workspaces', name, 'node_modules') }))];
    if (places.slice(1).some(place => !input.importers.includes(place.dir))) throw new Error('unexpected workspace tree');
    for (const place of places) validateTree(place.treePath, placeFor(input, place.dir));
    repairScratchMountpoints(places.map(place => place.treePath));
    markUsed(entry);
    return { treePath: places[0].treePath, workspaceTrees: places.slice(1).map(({ dir, treePath }) => ({ path: dir, treePath })), ...input.identity };
  } catch {
    throw failure('dependencies_unprepared', `missing or invalid preparation; owner recovery: ${recovery(input.root)} --replace-invalid`);
  }
}
export function resolvePreparedPnpm(sourceDir, options = {}) {
  const input = inputs(sourceDir, options.env ?? process.env);
  return input ? lookup(input, preparedNodeStore(options)) : null;
}

export function preparePnpm(sourceDir, options = {}) {
  const env = options.env ?? process.env;
  const input = inputs(sourceDir, env, options.versionTimeoutMs ?? 120000);
  if (!input) throw failure('dependencies_invalid', 'root pnpm-lock.yaml required');
  const base = preparedNodeStore(options);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  checkParents(base); checkDirectory(base, true);
  fs.mkdirSync(path.join(base, input.identity.lock_sha256), { mode: 0o700, recursive: true }); checkDirectory(path.join(base, input.identity.lock_sha256), true);
  const destination = entryPath(base, input);
  if (fs.existsSync(destination)) {
    try { return lookup(input, base); }
    catch (error) { if (!options.replaceInvalid) throw error; }
  }
  const stage = fs.mkdtempSync(path.join(base, `.stage-${process.pid}-`));
  try {
    const work = path.join(stage, 'work'), store = path.join(stage, 'store'), cache = path.join(stage, 'cache');
    for (const dir of [work, store, cache]) fs.mkdirSync(dir, { mode: 0o700 });
    const write = (name, bytes) => { fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(work, name), bytes, { mode: 0o600 }); };
    write('pnpm-lock.yaml', input.lock); write('package.json', input.manifest);
    if (input.hasWorkspaceYaml) write('pnpm-workspace.yaml', input.workspaceYaml);
    for (const [name, bytes] of input.files) write(`${name}/package.json`, bytes);
    // Settings come from the host environment only: an empty user and global rc, no repository rc (refused above).
    const empty = path.join(stage, 'empty-npmrc'); fs.writeFileSync(empty, '', { mode: 0o600 });
    // HOME stays the owner's so pnpm finds the pinned release it switches to; the stage-private store and XDG_CACHE_HOME (pnpm's metadata cache) hold everything this install fetches: the offline install reads the package metadata that fetch cached.
    const childEnv = { ...safeEnv(env), XDG_CACHE_HOME: cache, CI: 'true', COREPACK_ENABLE_AUTO_PIN: '0', npm_config_userconfig: empty, npm_config_globalconfig: empty,
      // `pnpm fetch` has no --ignore-scripts flag; a lifecycle or prepare script must not run on the host during fetch either.
      npm_config_ignore_scripts: 'true', pnpm_config_ignore_scripts: 'true' };
    const run = (args, label) => {
      const result = spawnSync('pnpm', args, { cwd: work, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 20, timeout: options.timeoutMs ?? 600000, env: childEnv });
      if (result.error || result.status !== 0) {
        const exit = result.error ? `error: ${result.error.message}` : result.signal ? `signal ${result.signal}` : `exit status ${result.status}`;
        const detail = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
        throw failure('dependencies_install_failed', `pnpm ${label} failed (${exit}${detail ? `: ${detail}` : ''}); no preparation published`);
      }
    };
    // fetch also fills the virtual store (node_modules/.pnpm), so it needs copy import too: hardlinks there would survive into the published tree.
    run(['fetch', '--ignore-pnpmfile', '--package-import-method=copy', '--store-dir', store], 'fetch');
    run(['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--package-import-method=copy', '--store-dir', store], 'install');
    const trees = [];
    fs.mkdirSync(path.join(work, 'node_modules'), { recursive: true, mode: 0o700 });
    fs.renameSync(path.join(work, 'node_modules'), path.join(stage, 'node_modules'));
    for (const name of input.importers) {
      const tree = path.join(work, name, 'node_modules');
      if (!fs.existsSync(tree)) continue;
      fs.mkdirSync(path.join(stage, 'workspaces', name), { recursive: true, mode: 0o700 });
      fs.renameSync(tree, path.join(stage, 'workspaces', name, 'node_modules')); trees.push(name);
    }
    for (const name of ['work', 'store', 'cache']) fs.rmSync(path.join(stage, name), { recursive: true, force: true });
    fs.rmSync(empty, { force: true });
    for (const [dir, tree] of [['', path.join(stage, 'node_modules')], ...trees.map(name => [name, path.join(stage, 'workspaces', name, 'node_modules')])]) { addScratchMountpoints(tree); freezeTree(tree); validateTree(tree, placeFor(input, dir)); }
    fs.writeFileSync(path.join(stage, 'metadata.json'), JSON.stringify({ identity: input.identity, trees }) + '\n', { mode: 0o400 });
    if (fs.existsSync(destination)) {
      try { return lookup(input, base); }
      catch (error) { if (!options.replaceInvalid) throw error; }
      // Keep the old inodes for any running read-only mount; the new bytes go to a new path.
      fs.renameSync(destination, path.join(base, '.replaced-' + randomUUID()));
    }
    try { fs.renameSync(stage, destination); }
    catch (error) { // another publisher won the race: reuse its entry when it is valid, otherwise report the original failure
      try { return lookup(input, base); } catch { throw error; }
    }
    return lookup(input, base);
  } finally {
    if (fs.existsSync(stage)) { thawTree(stage); fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
}

export function preparePnpmInChild(sourceDir, { timeoutMs = 600000, env = process.env } = {}) {
  const root = fs.realpathSync(sourceDir);
  const input = inputs(root, env);
  if (!input) return Promise.resolve(null);
  return prepareInChild({ root, key: `pnpm:${input.identity.lock_sha256}:${input.key}`, base: preparedNodeStore({}), flags: ['--pnpm'], timeoutMs, env });
}
