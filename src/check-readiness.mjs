import { gitEnv } from './git-env.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assignmentInput, mirrorPath, checkSpecsAt, prepareGithubRepo } from './projects.mjs';
import { hostCheckAuthorization } from './host-execution-policy.mjs';

// The check sandbox ro-binds the host /usr and puts /usr/bin on PATH, so presence in /usr/bin on the host is the honest signal.
const sandboxBinDirs = ['/usr/bin'];
const lockfileNames = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'go.sum'];

const testDir = /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/;
const testFile = /\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|(?:^|\/)test_[^/]+\.py$|^scripts\/[^/]*-(?:test|e2e)\.mjs$/;
const regressionAsk = /\bregression[- ]tests?\b/i;
const regressionNegated = /\b(?:no|not|without|never|don't|do not|skip)\b[^.\n]{0,40}\bregression[- ]tests?\b/i;

const clean = p => p === './...' ? p : p.replace(/^\.\//, '').replace(/\/$/, '');

export const isConventionalTest = file => testDir.test(file) || testFile.test(file);

// A scope entry is a test path by convention, when it equals, contains or sits inside a path the check links to its tests,
// or when it is a directory whose tree at base_sha already holds a conventional test file (colocated tests: src/x.test.ts, pkg/x_test.go).
export function isTestScopePath(entry, linked = null, treeFiles = null) {
  const p = clean(entry);
  if (isConventionalTest(p)) return true;
  if (treeFiles && p !== './...') { const files = typeof treeFiles === 'function' ? treeFiles() : treeFiles; if (files.some(f => (p === '.' || p === '' || f.startsWith(`${p}/`)) && isConventionalTest(f))) return true; }
  // `./...` (Go) runs tests beside the code in every package, so any directory in scope can hold the new test.
  if ((linked || []).includes('./...') && !/\.[^/]+$/.test(p.split('/').pop())) return true;
  return (linked || []).map(clean).filter(l => l && !l.endsWith('...')).some(l => p === '.' || p === l || p.startsWith(`${l}/`) || l.startsWith(`${p}/`));
}

export function asksForRegressionTest(text) {
  return regressionAsk.test(text || '') && !regressionNegated.test(text || '');
}

// Returns null when fine, else the error message naming the rule.
export function regressionTestRule(assignment, linkedPaths = null, treeFiles = null) {
  if (assignment.execution_scope !== 'implementation' || !asksForRegressionTest(assignment.expected_output)) return null;
  const scope = assignment.scope_paths || [];
  if (scope.some(p => isTestScopePath(p, linkedPaths, treeFiles))) return null;
  return `regression_test_scope: expected_output asks for a regression test but no scope_paths entry is a test path (conventional test/, tests/, __tests__/, spec/, *.test.*, *.spec.*, *_test.*, test_*.py, scripts/*-test.mjs, scripts/*-e2e.mjs, a directory that already holds such a test${linkedPaths ? `, or linked test paths: ${linkedPaths.join(', ')}` : ''}); add the test file or its directory to scope_paths`;
}

const versionParts = v => v.split('.').map(n => Number.parseInt(n, 10) || 0);
export function versionAtLeast(have, need) {
  const a = versionParts(have), b = versionParts(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

function hostBinary(name, dirs) {
  return dirs.some(dir => { try { const f = `${dir}/${name}`; return fs.statSync(f).isFile() && (fs.accessSync(f, fs.constants.X_OK), true); } catch { return false; } });
}

// Every file path at the pinned commit; read only when a scope directory needs the colocated-test lookup.
function repoFiles(mirror, sha) {
  const r = spawnSync('git', ['-C', mirror, 'ls-tree', '-r', '-z', '--name-only', sha], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
  if (r.error || r.status !== 0) throw new Error(`BLOCKED: cannot list files at ${sha.slice(0, 12)} for the regression-test rule`);
  return r.stdout.split('\0').filter(Boolean);
}

function inRepo(mirror, sha, file) {
  return spawnSync('git', ['-C', mirror, 'cat-file', '-e', `${sha}:${file}`], { timeout: 10000, env: gitEnv() }).status === 0;
}

// Static probe of one check's prerequisites. Returns {unmet: string[], skipped: [{what, reason}]}.
export function probePrerequisites(spec, { mirror, sha, binDirs = sandboxBinDirs, nodeVersion = process.versions.node }) {
  const unmet = [], skipped = [], p = spec.prerequisites;
  if (!p) skipped.push({ what: `prerequisites of ${spec.id}`, reason: spec.prerequisites_reason });
  else {
    for (const bin of p.binaries || []) if (!hostBinary(bin, binDirs)) unmet.push(`binary ${bin} not found in ${binDirs.join(':')}`);
    if (p.lockfile) {
      const wanted = p.lockfile === true ? lockfileNames : [p.lockfile];
      if (!wanted.some(f => inRepo(mirror, sha, f))) unmet.push(p.lockfile === true ? `no lockfile at ${sha.slice(0, 12)} (looked for ${wanted.join(', ')})` : `lockfile ${p.lockfile} missing at ${sha.slice(0, 12)}`);
    }
    if (p.runtime) {
      const [name, need] = p.runtime.split('>=');
      if (name === 'node') { if (!versionAtLeast(nodeVersion, need)) unmet.push(`runtime node ${nodeVersion} is older than required >=${need}`); }
      else skipped.push({ what: `runtime ${p.runtime}`, reason: 'host version probe exists for node only' });
    }
  }
  if (spec.readiness_argv) skipped.push({ what: `readiness_argv of ${spec.id}`, reason: 'declared but not run at admission: running a repository-declared command needs the sandboxed checkout, and it is unsafe on the host' });
  return { unmet, skipped };
}

// Admission gate for a new implementation assignment. Metadata comes from the pinned base_sha, the same way availableChecksFor reads it.
// Only the default check blocks; unmet prerequisites of other checks come back as warnings.
// The host-prerequisite probes (binaries in /usr/bin, lockfile, runtime) exist because the bridge runs the check. With execution
// none or worker nobody on this host runs it, so those probes do not apply and an unreadable check file does not block the job.
export function admitImplementation(assignment, options = {}) {
  if (assignment.execution_scope !== 'implementation') return null;
  const { execution = 'host', worker, ...probeOptions } = options;
  const input = assignmentInput(assignment);
  const mirror = fs.existsSync(mirrorPath(input.github_repo,{worker})) ? mirrorPath(input.github_repo,{worker}) : prepareGithubRepo(input,{worker});
  let specs;
  try { specs = checkSpecsAt(input.github_repo, mirror, input.base_sha); }
  catch (error) { if (execution === 'host') throw new Error(`BLOCKED: check metadata unreadable at ${input.base_sha.slice(0, 12)}: ${error.message}`); specs = {}; }
  let tree = null;
  const treeFiles = () => tree ??= repoFiles(mirror, input.base_sha);
  const rule = regressionTestRule(assignment, specs.default?.test_paths ?? null, treeFiles);
  if (rule) throw new Error(rule);
  if (execution !== 'host') return { probed: [], warnings: [], skipped: [{ what: 'host check prerequisites', reason: `execution=${execution}: the bridge host runs no check for this job` }] };
  const blocking = [], warnings = [], skipped = [], probed = [];
  const defaultRunnable = !hostCheckAuthorization(input.github_repo, 'default').refusal;
  for (const [id, spec] of Object.entries(specs)) {
    const result = probePrerequisites(spec, { mirror, sha: input.base_sha, ...probeOptions });
    probed.push(id);
    skipped.push(...result.skipped);
    for (const item of result.unmet) (id === 'default' && defaultRunnable ? blocking : warnings).push(`${id}: ${item}`);
  }
  if (blocking.length) throw new Error(`BLOCKED: check prerequisites unmet: ${blocking.join('; ')}`);
  return { probed, warnings, skipped };
}
