import { defaultPath } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hash, failure, readRegular, checkDirectory, checkParents, validateTree, freezeTree, thawTree, shellQuote, prepareInChild } from './prepared-node-modules.mjs';

// A Go repository's dependencies and its pinned toolchain live in one module cache, prepared on the host (with network)
// from go.mod and go.sum alone, then mounted read-only at the sandbox's GOMODCACHE. The sandbox has no network, so the cache
// is the only way a check can get the Go toolchain a go.mod asks for (`go 1.26.0` switches to golang.org/toolchain in this cache)
// and the modules it imports. Same trust rule as prepared node_modules: the key is the file hashes, never the worker's edits.
const GO = '/usr/bin/go';
const store = options => path.resolve(options.cacheDir ?? defaultPath(os.homedir(), '.dot-bridge/prepared-go-modules'));
const recovery = source => `dalan prepare-deps ${shellQuote(path.resolve(source))} --go`;
let hostGo;
const hostGoVersion = () => {
  if (hostGo !== undefined) return hostGo;
  const run = spawnSync(GO, ['env', 'GOVERSION'], { env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), GOTOOLCHAIN: 'local', GOFLAGS: '' }, encoding: 'utf8', timeout: 20000 });
  hostGo = run.status === 0 ? run.stdout.trim() : null;
  return hostGo;
};

// Why the host cannot prepare this go.mod (null when it can). A local `replace` or a go.work file points outside go.mod and go.sum.
export function unsupportedGoModules(goMod) {
  for (const match of String(goMod).matchAll(/=>\s*(\S+)/g)) if (/^(\.|\/)/.test(match[1])) return 'a local replace directive is unsupported';
  return null;
}
function inputs(source) {
  const root = path.resolve(source);
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw failure('dependencies_invalid', 'source directory must be canonical');
  const mod = readRegular(path.join(root, 'go.mod'), true);
  if (!mod) return null;
  if (fs.existsSync(path.join(root, 'go.work'))) throw failure('dependencies_unsupported', 'go.work is unsupported');
  const unsupported = unsupportedGoModules(mod.toString('utf8'));
  if (unsupported) throw failure('dependencies_unsupported', unsupported);
  const sum = readRegular(path.join(root, 'go.sum'), true) ?? Buffer.alloc(0);
  const version = hostGoVersion();
  if (!version) throw failure('dependencies_unsupported', `${GO} is unavailable on this host`);
  const runtime = { go: version, platform: process.platform, arch: process.arch };
  const identity = { go_mod_sha256: hash(mod), go_sum_sha256: hash(sum), runtime };
  return { root, mod, sum, identity, name: hash(`${identity.go_mod_sha256}:${identity.go_sum_sha256}`), key: hash(JSON.stringify(runtime)) };
}
const entryPath = (base, input) => path.join(base, input.name, input.key);
function lookup(input, base) {
  const entry = entryPath(base, input);
  try {
    checkParents(base); checkDirectory(base, true); checkDirectory(path.dirname(entry), true); checkDirectory(entry, true);
    const metaPath = path.join(entry, 'metadata.json'), st = fs.lstatSync(metaPath);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o222)) throw new Error('bad metadata');
    const metadata = JSON.parse(readRegular(metaPath));
    if (JSON.stringify(metadata.identity) !== JSON.stringify(input.identity)) throw new Error('identity mismatch');
    const treePath = path.join(entry, 'modcache'); validateTree(treePath);
    return { treePath, ...input.identity };
  } catch {
    throw failure('dependencies_unprepared', `missing or invalid preparation; owner recovery: ${recovery(input.root)}`);
  }
}
export function resolvePreparedGoModules(sourceDir, options = {}) {
  const input = inputs(sourceDir);
  return input ? lookup(input, store(options)) : null;
}
// For the offer filter: the reason from go.mod and the presence of go.work, null when there is no go.mod.
export function goModulesUnsupported(goMod, goWork) { return goMod ? (goWork ? 'go.work is unsupported' : unsupportedGoModules(goMod.toString('utf8'))) : null; }

export function prepareGoModules(sourceDir, options = {}) {
  const input = inputs(sourceDir);
  if (!input) throw failure('dependencies_invalid', 'root go.mod required');
  const base = store(options);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  checkParents(base); checkDirectory(base, true);
  fs.mkdirSync(path.join(base, input.name), { mode: 0o700, recursive: true }); checkDirectory(path.join(base, input.name), true);
  const destination = entryPath(base, input);
  if (fs.existsSync(destination)) {
    try { return lookup(input, base); }
    catch (error) { if (!options.replaceInvalid) throw error; }
  }
  const stage = fs.mkdtempSync(path.join(base, '.stage-'));
  try {
    const work = path.join(stage, 'work'), cache = path.join(stage, 'modcache');
    for (const dir of [work, cache, path.join(stage, 'home'), path.join(stage, 'gopath')]) fs.mkdirSync(dir, { mode: 0o700 });
    // The go command records telemetry counters (and may start a helper) under HOME at exit; "off" keeps the stage quiet so removing it cannot race.
    fs.mkdirSync(path.join(stage, 'home', '.config', 'go', 'telemetry'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stage, 'home', '.config', 'go', 'telemetry', 'mode'), 'off\n', { mode: 0o600 });
    fs.writeFileSync(path.join(work, 'go.mod'), input.mod, { mode: 0o600 });
    fs.writeFileSync(path.join(work, 'go.sum'), input.sum, { mode: 0o600 });
    const env = options.env ?? process.env;
    const proxyEnv = Object.fromEntries(Object.entries(env).filter(([name]) => /^(LANG|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|GOPROXY|GOSUMDB|(https?|no)_proxy)$/i.test(name)));
    // GOTOOLCHAIN=auto lets `go mod download` fetch the toolchain go.mod asks for into the same cache; -modcacherw lets us delete
    // a failed stage. Nothing here runs repository code: download only fetches and verifies archives against go.sum.
    const run = spawnSync(GO, ['mod', 'download'], { cwd: work, stdio: 'ignore', timeout: options.timeoutMs ?? 600000, env: { ...proxyEnv, PATH: '/usr/bin:/bin', HOME: path.join(stage, 'home'), GOPATH: path.join(stage, 'gopath'), GOMODCACHE: cache, GOFLAGS: '-modcacherw', GOWORK: 'off', GOTOOLCHAIN: 'auto' } });
    if (run.error || run.status !== 0) {
      const exit = run.error ? `error: ${run.error.message}` : run.signal ? `signal ${run.signal}` : `exit status ${run.status}`;
      throw failure('dependencies_install_failed', `go mod download failed (${exit}); no preparation published`);
    }
    // A go.sum that download had to extend is incomplete: the sandbox build would fail on it, so publish nothing.
    if (!fs.readFileSync(path.join(work, 'go.sum')).equals(input.sum)) throw failure('dependencies_install_failed', 'go.sum is incomplete for go.mod; no preparation published');
    freezeTree(cache); validateTree(cache);
    fs.writeFileSync(path.join(stage, 'metadata.json'), JSON.stringify({ identity: input.identity }) + '\n', { mode: 0o400 });
    for (const name of ['work', 'home', 'gopath']) fs.rmSync(path.join(stage, name), { recursive: true, force: true });
    if (fs.existsSync(destination)) {
      try { return lookup(input, base); }
      catch (error) { if (!options.replaceInvalid) throw error; }
      // Keep the old inodes for any running read-only mount; the new bytes go to a new path.
      fs.renameSync(destination, path.join(base, '.replaced-' + randomUUID()));
    }
    fs.renameSync(stage, destination);
    return lookup(input, base);
  } finally {
    if (fs.existsSync(stage)) { thawTree(stage); fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
}

// Same detached child the node preparation uses, so a minutes-long download does not stop the bridge's event loop.
export function prepareGoModulesInChild(sourceDir, { timeoutMs = 600000, env = process.env } = {}) {
  const root = fs.realpathSync(sourceDir);
  const input = inputs(root);
  if (!input) return Promise.resolve(null);
  return prepareInChild({ root, key: `go:${input.name}:${input.key}`, base: store({}), flags: ['--go'], timeoutMs, env });
}
