import { defaultPath,workspaceRoot } from './paths.mjs';
import { readEnv } from './env.mjs';
import { fetchMirror } from './mirror-fetch.mjs';
import { gitEnv } from './git-env.mjs';
import { parseHostBudget } from './host-budget.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const fullSha = /^[a-f0-9]{40}$/;
const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const mirrorRoot = worker => worker ? path.join(workspaceRoot(), 'mirrors', 'workers', safeWorker(worker)) : path.join(workspaceRoot(), 'mirrors');
function safeWorker(worker) { if(typeof worker!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(worker)) throw new Error('invalid verified worker');return worker; }
const overrideFile = () => readEnv('DALAN_CHECKS_FILE') || defaultPath(os.homedir(),'.config/dot-bridge/checks.json');
// Discovery reads only this allowlist. The integrator shares it so changes to
// discovery inputs or ecosystem lockfiles always require owner approval.
export const CHECK_INPUT_FILES = Object.freeze(['.dalan.json','.dot-bridge.json','package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','pyproject.toml','pytest.ini','uv.lock','Cargo.toml','Cargo.lock','go.mod','go.sum','Makefile']);
const checkMetadataFiles = new Set(CHECK_INPUT_FILES);
const CHECK_METADATA_MAX_BYTES = 1024 * 1024;

function runGit(args, opts = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 12 * 1024 * 1024, ...opts, env: gitEnv(opts.env) });
  if (result.error || result.status !== 0) throw new Error(`git failed: ${redact((result.stderr || result.error?.message || '').slice(0, 500))}`);
  return result.stdout.trim();
}

// Check definitions and detected project metadata come only from regular files directly inside the checkout. O_NOFOLLOW closes
// the lstat/open race for symlinks; reads are capped so discovery cannot allocate based on untrusted file size.
function openCheckMetadata(dir, name) {
  if (!checkMetadataFiles.has(name)) throw new Error('invalid check metadata path');
  let checkout;
  try { checkout = fs.realpathSync(dir); } catch { throw new Error('check metadata directory unavailable'); }
  const file = path.join(checkout, name);
  if (path.dirname(file) !== checkout) throw new Error('invalid check metadata path');
  let entry;
  try { entry = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('cannot inspect check metadata'); }
  if (entry.isSymbolicLink()) throw new Error('check metadata symlinks are not allowed');
  if (!entry.isFile()) throw new Error('check metadata must be a regular file');
  let fd;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(file, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('check metadata must be a regular file');
    return { fd, size: stat.size };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === 'ELOOP') throw new Error('check metadata symlinks are not allowed');
    if (error.message === 'check metadata must be a regular file') throw error;
    throw new Error('cannot open check metadata');
  }
}

function hasCheckMetadata(dir, name) {
  const opened = openCheckMetadata(dir, name);
  if (!opened) return false;
  fs.closeSync(opened.fd);
  return true;
}

function readCheckMetadata(dir, name, maxBytes = CHECK_METADATA_MAX_BYTES) {
  const opened = openCheckMetadata(dir, name);
  if (!opened) return null;
  try {
    if (opened.size > maxBytes) throw new Error('check metadata exceeds the size limit');
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    const count = fs.readSync(opened.fd, bytes, 0, bytes.length, 0);
    if (count > maxBytes) throw new Error('check metadata exceeds the size limit');
    return bytes.subarray(0, count).toString('utf8');
  } catch (error) {
    if (error.message === 'check metadata exceeds the size limit') throw error;
    throw new Error('cannot read check metadata');
  } finally { fs.closeSync(opened.fd); }
}

function parseCheckMetadata(text) {
  try { return JSON.parse(text); } catch { throw new Error('invalid check metadata JSON'); }
}

export function githubAuthRecovery(error) {
  if (!/could not read (?:Username|Password)|authentication failed|terminal prompts disabled|repository not found|gh:\s*(?:not found|not installed)|not logged in|no oauth token|not authenticated/i.test(error?.message ?? '')) return null;
  return Object.assign(new Error('GitHub authentication failed. Install GitHub CLI, run `gh auth login` as the bridge service user, or set GH_TOKEN in the bridge service environment; confirm `gh` is on the service PATH, then retry the job.'), { code: 'DOT_BRIDGE_INFRASTRUCTURE' });
}

function redact(value) {
  return String(value).replace(/https:\/\/[^/@\s]+@/g, 'https://<redacted>@');
}

export function loadCapacity(file = defaultPath(os.homedir(),'.config/dot-bridge/limits.json')) {
  if (!fs.existsSync(file)) return 1;
  if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error('limits policy must be mode 0600');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')).max_claimed_outer_assignments ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error('invalid max_claimed_outer_assignments');
  return value;
}

export function assignmentInput(assignment) {
  if (!['read-only', 'implementation'].includes(assignment.execution_scope)) throw new Error('invalid execution_scope: expected one of read-only, implementation');
  if (assignment.inputs?.length !== 1) throw new Error('one pinned GitHub input required');
  const input = assignment.inputs[0];
  if (!validRepo(input.github_repo) || !fullSha.test(input.base_sha || '')) throw new Error('github_repo and full base_sha required');
  if (input.head_sha && !fullSha.test(input.head_sha)) throw new Error('invalid head SHA');
  if (input.input_patch !== undefined && (typeof input.input_patch !== 'string' || Buffer.byteLength(input.input_patch) > 262144)) throw new Error('invalid input patch');
  // A read-only input_patch is a local patch under review: the workspace applies it, read_file sees the patched tree and
  // workspace_result shows the diff, without publishing the patch to GitHub.
  return input;
}

function cloneUrl(repo) {
  const key = `DALAN_GITHUB_URL_${repo.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const value = readEnv(key) || `${process.env.GITHUB_CLONE_BASE_URL || 'https://github.com'}/${repo}.git`;
  if (/^https:\/\/[^/@\s]+@/.test(value)) throw new Error('GitHub clone URL must not embed credentials');
  return value;
}

export function hostGitEnv() {
  const askpass = path.join(workspaceRoot(), 'github-askpass');
  fs.mkdirSync(workspaceRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "x-access-token\\n" ;;\n  *Password*) exec gh auth token ;;\nesac\n', { mode: 0o700 });
  fs.chmodSync(askpass, 0o700);
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass };
}

export function mirrorPath(repo,{worker}={}) {
  if (!validRepo(repo)) throw new Error('invalid github_repo');
  const [owner, name] = repo.split('/');
  return path.join(mirrorRoot(worker), owner, `${name}.git`);
}

function validRepo(repo) {
  return repoName.test(repo || '') && repo.split('/').every(part => part !== '.' && part !== '..' && !part.includes('..'));
}

const COMPLETENESS_MAX_BUFFER = 32 * 1024 * 1024;

// Proves the pinned commit and every tree and blob under it are present in the mirror. A commit object alone is not
// enough: a mirror can hold the commit and lack an object below it, and the job then fails later in the scope scan.
export function verifyFetchedCommit(mirror, sha, label) {
  // A promisor remote must not fetch lazily inside admission; a missing object stays missing.
  const options = { encoding: 'utf8', timeout: 30000, maxBuffer: COMPLETENESS_MAX_BUFFER, env: { ...gitEnv(), GIT_NO_LAZY_FETCH: '1' } };
  const result = spawnSync('git', ['-C', mirror, 'rev-parse', '--quiet', '--verify', `${sha}^{commit}`], { ...options, maxBuffer: 1024 });
  if (!result.error && (result.status === 1 || result.status === 0 && result.stdout.trim() !== sha)) throw Object.assign(new Error(`${label} SHA does not identify a fetched GitHub commit`), { code: 'DOT_BRIDGE_INVALID_INPUT' });
  if (result.error || result.status !== 0) throw Object.assign(new Error('GitHub revision verification unavailable'), { code: 'DOT_BRIDGE_INFRASTRUCTURE' });
  const unavailable = error => Object.assign(new Error(error?.code === 'ENOBUFS' || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ? `GitHub mirror completeness verification unavailable: the ${label} tree listing exceeds ${COMPLETENESS_MAX_BUFFER / 1024 / 1024} MiB`
    : error?.code === 'ETIMEDOUT' ? `GitHub mirror completeness verification unavailable: the ${label} check timed out`
      : 'GitHub mirror completeness verification unavailable'), { code: 'DOT_BRIDGE_INFRASTRUCTURE' });
  // The requester cannot repair the bridge's mirror, so this is an infrastructure fault, not an input error.
  const missing = (type, oid, file) => Object.assign(new Error(`${label} SHA ${sha}: the bridge's mirror is incomplete: missing ${type} ${oid} for ${file} under the pinned commit.`), { code: 'DOT_BRIDGE_INFRASTRUCTURE', mirrorIncomplete: true });
  // -z preserves paths with whitespace; -t includes tree OIDs for diagnostics. Gitlinks belong to another repository;
  // symlinks are ordinary blob objects, never filesystem targets to follow.
  const listing = spawnSync('git', ['-C', mirror, 'ls-tree', '-r', '-t', '-z', sha], options);
  if (listing.error) throw unavailable(listing.error);
  const entries = (listing.stdout || '').split('\0').filter(Boolean).map(entry => {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]*)$/.exec(entry);
    if (!match) throw unavailable();
    return { type: match[2], oid: match[3], file: match[4] };
  }).filter(entry => entry.type !== 'commit');
  if (listing.status !== 0) {
    // Git versions word this differently: "Could not read <oid>", "unable to read tree (<oid>)", "not a tree object".
    const oid = /(?:unable to read tree|not a tree object|could not read)\s*\(?([a-f0-9]{40})\)?/i.exec(listing.stderr || '')?.[1];
    if (!oid) throw unavailable();
    const entry = entries.find(entry => entry.oid === oid);
    throw missing('tree', oid, entry?.file || 'the root tree');
  }
  // Identical files share one object; check each object once.
  const unique = [...new Map(entries.map(entry => [entry.oid, entry])).values()];
  if (!unique.length) return;
  // One batch process, fed through stdin rather than one process per object.
  const batch = spawnSync('git', ['-C', mirror, 'cat-file', '--batch-check'], { ...options, input: unique.map(entry => entry.oid).join('\n') + '\n' });
  if (batch.error || batch.status !== 0) throw unavailable(batch.error);
  const lines = batch.stdout.trimEnd().split('\n');
  if (lines.length !== unique.length) throw unavailable();
  for (let i = 0; i < unique.length; i++) {
    const entry = unique[i];
    if (lines[i] === `${entry.oid} missing`) throw missing(entry.type, entry.oid, entry.file);
    if (!lines[i].startsWith(`${entry.oid} ${entry.type} `) || !/^\d+$/.test(lines[i].split(' ')[2] || '')) throw unavailable();
  }
}

export function prepareGithubRepo(input,{worker}={}) {
  requireGithubAvailable();
  const mirror = mirrorPath(input.github_repo,{worker});
  fs.mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 });
  const env = hostGitEnv();
  // Fetch attempts isolate temporary packs and publish complete objects before refs.
  // Leave time for pin/tree validation inside the 180-second admission scan.
  // The fetch and its corruption retry share this budget and settle all writers.
  // The completeness repair below fetches a second time; both fetches share one 120-second budget.
  const pins=[['base',input.base_sha],...(input.head_sha?[['head',input.head_sha]]:[])];
  const deadline=performance.now()+120000;
  const fetch = options => {
    const budget=Math.floor(deadline-performance.now());
    if(budget<=0) throw Object.assign(new Error('GitHub mirror fetch timed out before the incomplete mirror could be refetched'),{code:'DOT_BRIDGE_INFRASTRUCTURE'});
    try { fetchMirror(mirror, cloneUrl(input.github_repo), env, budget, pins.map(([,sha])=>sha), options); }
    catch (error) {
      const lines=String(error.message).split(/\r?\n/);
      const missing=pins.find(([,sha])=>lines.some(line=>line.endsWith(`not our ref ${sha}`)||line.endsWith(`couldn't find remote ref ${sha}`)));
      if(missing) throw Object.assign(new Error(`${missing[0]} SHA cannot be fetched from the GitHub repository`),{code:'DOT_BRIDGE_INVALID_INPUT'});
      throw githubAuthRecovery(error) || error;
    }
  };
  const verify = () => { for (const [label, sha] of pins) verifyFetchedCommit(mirror, sha, label); };
  fetch();
  try { verify(); }
  catch (error) {
    if (!error.mirrorIncomplete) throw error;
    // A fetch of pins the mirror already claims to have transfers nothing, so an object lost from the mirror
    // stays lost. Refetch once, ignoring what the mirror claims, then verify again.
    fetch({ refetch: true });
    try { verify(); }
    catch (again) {
      if (again.mirrorIncomplete) again.message += ' A refetch did not repair it. Operator: repair or recreate this repository\'s bridge mirror, then resubmit.';
      throw again;
    }
  }
  return mirror;
}

export function projectFor(assignment) {
  const input = assignmentInput(assignment);
  return { input, mirror: prepareGithubRepo(input), policy: { artifact_retention_days: 14 } };
}

const argvOk = v => Array.isArray(v) && v.length && v.every(x => typeof x === 'string' && x && !x.includes('\0'));
const relPath = p => typeof p === 'string' && p && !p.includes('\0') && !p.includes('\\') && !p.startsWith('/') && !p.split('/').some(x => x === '..');
const runtimeSpec = /^[a-z][a-z0-9_.-]*>=\d+(?:\.\d+)*$/;
// Prerequisites are all-or-nothing per field: null means unknown, an empty binaries list means "needs nothing beyond the runtime".
function normalizePrerequisites(p, id) {
  if (p === undefined || p === null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) throw new Error(`invalid prerequisites ${id}`);
  const { binaries = null, lockfile = null, runtime = null } = p;
  if (binaries !== null && (!Array.isArray(binaries) || binaries.some(b => typeof b !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(b)))) throw new Error(`invalid prerequisite binaries ${id}`);
  if (lockfile !== null && lockfile !== true && !(relPath(lockfile))) throw new Error(`invalid prerequisite lockfile ${id}`);
  if (runtime !== null && !(typeof runtime === 'string' && runtimeSpec.test(runtime))) throw new Error(`invalid prerequisite runtime ${id}`);
  return binaries === null && lockfile === null && runtime === null ? null : { binaries, lockfile, runtime };
}

// A declared test path counts as named when argv holds it as a whole element or as a whole word inside one (a `bash -c` script).
export function argvNamesPath(argv, p) {
  const bare = p.replace(/^\.\//, '').replace(/\/$/, '');
  const re = new RegExp(`(?:^|[\\s'"=]|\\./)${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(?=$|[\\s'";&|)/])`);
  return argv.some(x => re.test(x));
}
// Test-file-like tokens an argv names (for `bash -c` scripts: words inside the script text).
export const testFileName = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.(?:py|go|sh)|(?:^|\/)test_[^/]+\.py)$/;
export function argvTestFiles(argv) {
  const found = [];
  for (const el of argv) for (const tok of String(el).split(/[\s'"=;&|()<>]+/)) {
    const t = tok.replace(/^\.\//, '');
    if (t && !t.startsWith('-') && !t.startsWith('/') && !t.includes('$') && testFileName.test(t)) found.push(t);
  }
  return [...new Set(found)];
}

export function normalizeCheck(check, id = 'default', derived = {}) {
  if (!argvOk(check.argv)) throw new Error(`invalid check ${id}`);
  if (check.install_argv && !argvOk(check.install_argv)) throw new Error(`invalid install ${id}`);
  const timeout_ms = check.timeout_ms ?? 120000;
  const output_bytes = check.output_bytes ?? 262144;
  if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 900000) throw new Error(`invalid timeout ${id}`);
  if (!Number.isInteger(output_bytes) || output_bytes < 1024 || output_bytes > 1048576) throw new Error(`invalid output cap ${id}`);
  if (check.readiness_argv !== undefined && !argvOk(check.readiness_argv)) throw new Error(`invalid readiness ${id}`);
  if (check.test_paths !== undefined && (!Array.isArray(check.test_paths) || !check.test_paths.length || !check.test_paths.every(relPath))) throw new Error(`invalid test_paths ${id}`);
  // A declared test file is a promise about what argv runs: it must be named in argv, so the id, the list and the command cannot drift apart.
  // Directories stay informational because a command like `npm run test:sandbox` reaches them through a script.
  for (const p of check.test_paths ?? []) if (testFileName.test(p) && !argvNamesPath(check.argv, p)) throw new Error(`test_paths ${id}: ${p} is not named in argv`);
  const prerequisites = normalizePrerequisites(check.prerequisites ?? derived.prerequisites, id);
  const test_paths = (check.test_paths ?? derived.test_paths)?.map(p => p === './...' ? p : p.replace(/^\.\//, '').replace(/\/$/, '')) ?? null;
  return {
    id, argv: check.argv, install_argv: check.install_argv || null, timeout_ms, output_bytes,
    ...(check.host_budget === undefined ? {} : { host_budget: parseHostBudget(check.host_budget) }),
    prerequisites, prerequisites_reason: prerequisites ? null : derived.prerequisites_reason || 'not declared',
    readiness_argv: check.readiness_argv || null,
    test_paths, test_paths_reason: test_paths ? null : derived.test_paths_reason || 'not declared',
  };
}

// Paths a package.json test script names (files or directories); null when it names none.
function scriptTestPaths(script) {
  const found = [];
  for (const token of String(script).split(/\s+/)) {
    if (!/^[\w@.\/-]+$/.test(token) || token.startsWith('-') || token.startsWith('..') || token.startsWith('/') || /^[a-z]+:\/\//.test(token)) continue;
    if (token.includes('/') || /\.(?:[cm]?[jt]sx?|py|sh)$/.test(token)) found.push(token.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  return found.length ? [...new Set(found)].slice(0, 200) : null;
}

function pytestPaths(dir) {
  const ini = /^\s*testpaths\s*[=:]\s*(.+)$/m.exec(readCheckMetadata(dir, 'pytest.ini') ?? '');
  if (ini) return ini[1].trim().split(/\s+/).filter(relPath);
  const toml = /^\s*testpaths\s*=\s*\[([^\]]*)\]/m.exec(readCheckMetadata(dir, 'pyproject.toml') ?? '');
  if (toml) return [...toml[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]).filter(relPath);
  return [];
}

function packageManager(dir) {
  if (hasCheckMetadata(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (hasCheckMetadata(dir, 'yarn.lock')) return 'yarn';
  return 'npm';
}

function hasPackageDependencies(pkg) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(key => pkg[key] && Object.keys(pkg[key]).length);
}

// The owner's checks.json parsed from an owner-owned mode-0600 regular file; {} when absent.
export function ownerChecks() {
  const file = overrideFile();
  let entry;
  try { entry = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('cannot read check override configuration'); }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o777) !== 0o600) throw new Error('check override file must be an owner-owned mode-0600 regular file');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > CHECK_METADATA_MAX_BYTES) throw new Error('cannot read check override configuration');
    return parseCheckMetadata(fs.readFileSync(fd, 'utf8'));
  } catch (error) { throw new Error(error.message === 'invalid check metadata JSON' ? error.message : 'cannot read check override configuration'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Return only a fresh owner-configured definition. Repository metadata can
// describe checks, but it cannot supply this authority or an owner budget.
export function ownerCheck(repo, checkId) {
  const data = ownerChecks();
  const check = data?.[repo]?.checks?.[checkId];
  if (!check) return null;
  try { return normalizeCheck(check, checkId); } catch { return null; }
}

const repoCheckFile=dir=>hasCheckMetadata(dir,'.dalan.json')?'.dalan.json':'.dot-bridge.json';

function overrideCheck(repo, dir, checkId) {
  const ownerFile = overrideFile();
  for (const file of [ownerFile, path.join(dir, repoCheckFile(dir))]) {
    const ownerConfig = file === ownerFile;
    let text;
    if (ownerConfig) {
      if (!fs.existsSync(file)) continue;
      if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error('check override file must be mode 0600');
      try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error('cannot read check override configuration'); }
    } else {
      text = readCheckMetadata(dir, repoCheckFile(dir));
      if (text === null) continue;
    }
    const data = parseCheckMetadata(text);
    const source = ownerConfig ? data[repo] : data;
    if (source?.checks?.[checkId]) {
      try { return { spec: normalizeCheck(source.checks[checkId], checkId), from: ownerConfig ? 'owner_config' : 'workspace_file' }; }
      catch { throw new Error('invalid check metadata'); }
    }
  }
  return null;
}

export function detectCheck(repo, dir, checkId = 'default') { return detectCheckWithOrigin(repo, dir, checkId)?.spec ?? null; }

// A repository definition can tighten an owner budget, but its command never
// supplies host execution authority when an owner definition is required.
export function workspaceCheck(repo, dir, checkId) {
  const text = readCheckMetadata(dir, repoCheckFile(dir));
  if (text === null) return null;
  const check = parseCheckMetadata(text)?.checks?.[checkId];
  if (!check) return null;
  try { return normalizeCheck(check, checkId); } catch { throw new Error('invalid check metadata'); }
}

// Where the resolved definition came from: the owner's checks.json, the checkout's own .dot-bridge.json, or detection from repo files.
export function detectCheckWithOrigin(repo, dir, checkId = 'default') {
  const override = overrideCheck(repo, dir, checkId);
  if (override) return override;
  const spec = detectFromFiles(dir, checkId);
  return spec ? { spec, from: 'detected' } : null;
}

function detectFromFiles(dir, checkId) {
  if (checkId !== 'default') return null;
  const packageText = readCheckMetadata(dir, 'package.json');
  if (packageText !== null) {
    const pkg = parseCheckMetadata(packageText);
    if (pkg.scripts?.test) {
      const manager = packageManager(dir);
      const hasLockfile = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some(file => hasCheckMetadata(dir, file));
      const install_argv = hasPackageDependencies(pkg) || hasLockfile
        ? manager === 'pnpm' ? ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']
          : manager === 'yarn' ? ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts']
            : hasCheckMetadata(dir, 'package-lock.json') ? ['/runtime/node', '/runtime/npm/bin/npm-cli.js', 'ci', '--ignore-scripts']
              : ['/runtime/node', '/runtime/npm/bin/npm-cli.js', 'install', '--ignore-scripts', '--package-lock=false']
        : null;
      const engines = /^\s*>=\s*(\d+(?:\.\d+)*)\s*$/.exec(pkg.engines?.node ?? '');
      const lockfile = manager === 'pnpm' ? 'pnpm-lock.yaml' : manager === 'yarn' ? 'yarn.lock' : install_argv?.includes('ci') ? 'package-lock.json' : null;
      const paths = scriptTestPaths(pkg.scripts.test);
      return normalizeCheck({ argv: manager === 'npm' ? ['/runtime/node', '/runtime/npm/bin/npm-cli.js', 'test'] : [manager, 'test'], install_argv }, 'default', {
        prerequisites: { binaries: manager === 'npm' ? [] : [manager], lockfile, runtime: engines ? `node>=${engines[1]}` : null },
        test_paths: paths, test_paths_reason: 'package.json test script names no files or directories' });
    }
  }
  const pyproject = readCheckMetadata(dir, 'pyproject.toml');
  const pytest = readCheckMetadata(dir, 'pytest.ini');
  if (pyproject !== null || pytest !== null) {
    const paths = pytestPaths(dir);
    return normalizeCheck({ install_argv: ['uv', 'sync'], argv: ['uv', 'run', 'pytest'] }, 'default', { prerequisites: { binaries: ['uv'], lockfile: null, runtime: null }, test_paths: paths.length ? paths : null, test_paths_reason: 'no pytest testpaths configured' });
  }
  if (hasCheckMetadata(dir, 'Cargo.toml')) return normalizeCheck({ install_argv: ['cargo', 'fetch'], argv: ['cargo', 'test'] }, 'default', { prerequisites: { binaries: ['cargo'], lockfile: null, runtime: null }, test_paths: ['tests'] });
  if (hasCheckMetadata(dir, 'go.mod')) return normalizeCheck({ install_argv: ['go', 'mod', 'download'], argv: ['go', 'test', './...'] }, 'default', { prerequisites: { binaries: ['go'], lockfile: null, runtime: null }, test_paths: ['./...'] });
  const makefile = readCheckMetadata(dir, 'Makefile');
  if (makefile !== null && /^test:/m.test(makefile)) return normalizeCheck({ argv: ['make', 'test'] }, 'default', { prerequisites: { binaries: ['make'], lockfile: null, runtime: null }, test_paths_reason: 'Makefile test target does not name test paths' });
  return null;
}

export function availableChecks(repo, dir) {
  const ids = new Set();
  const ownerFile = overrideFile();
  for (const file of [ownerFile, path.join(dir, repoCheckFile(dir))]) {
    const ownerConfig = file === ownerFile;
    let text;
    if (ownerConfig) {
      if (!fs.existsSync(file)) continue;
      if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error('check override file must be mode 0600');
      try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error('cannot read check override configuration'); }
    } else {
      text = readCheckMetadata(dir, repoCheckFile(dir));
      if (text === null) continue;
    }
    let source;
    try {
      const data = parseCheckMetadata(text);
      source = ownerConfig ? data[repo] : data;
      for (const [id, check] of Object.entries(source?.checks || {})) {
        normalizeCheck(check, id);
        ids.add(id);
      }
    } catch {
      throw new Error('invalid check metadata');
    }
  }
  if (detectCheck(repo, dir, 'default')) ids.add('default');
  return [...ids].sort();
}

// Check metadata at a pinned commit, read with `git show` into a temp dir (no worktree). Calls fn(dir).
export function withCheckMetadata(mirror, sha, fn) {
  const caches = path.join(workspaceRoot(), 'caches');
  fs.mkdirSync(caches, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(caches, 'check-metadata-'));
  try {
    const entries = spawnSync('git', ['-C', mirror, 'ls-tree', '-z', '--full-tree', sha, '--', ...checkMetadataFiles], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env: gitEnv() });
    if (entries.error || entries.status !== 0) throw new Error('cannot inspect pinned check metadata');
    const pinnedFiles = new Set();
    for (const entry of entries.stdout.split('\0')) {
      if (!entry) continue;
      const separator = entry.indexOf('\t');
      if (separator < 0) throw new Error('cannot inspect pinned check metadata');
      const [mode] = entry.slice(0, separator).split(' ');
      const file = entry.slice(separator + 1);
      if (!checkMetadataFiles.has(file)) continue;
      if (mode !== '100644' && mode !== '100755') throw new Error('check metadata must be a regular file');
      pinnedFiles.add(file);
    }
    for (const file of checkMetadataFiles) {
      if (!pinnedFiles.has(file)) continue;
      const found = spawnSync('git', ['-C', mirror, 'show', `${sha}:${file}`], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env: gitEnv() });
      if (found.status === 0) fs.writeFileSync(path.join(dir, file), found.stdout);
      else throw new Error(`cannot read check metadata: ${file}`);
    }
    return fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Every check spec (id -> normalized spec) at a pinned commit.
export function checkSpecsAt(repo, mirror, sha) {
  return withCheckMetadata(mirror, sha, dir => Object.fromEntries(availableChecks(repo, dir).map(id => [id, detectCheck(repo, dir, id)])));
}

export function requireGithubAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 }); }
  catch { throw new Error('git unavailable for GitHub workspace operation'); }
}
