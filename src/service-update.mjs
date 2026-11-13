import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { defaultPath } from './paths.mjs';
import { acquireUpdateLock } from './service-update-lock.mjs';
import { writeAtomic } from './as-files.mjs';
import { latestRelease as defaultLatest, installRelease as defaultInstall, probeService as defaultProbe, probeCandidate as defaultCandidate, controlService as defaultControl } from './service-update-runtime.mjs';

const PACKAGE = '@tnunamak/dalan';
const HEALTH_TIMEOUT_MS = 30_000;
const fail = message => { throw new Error(message); };
const privateDir = dir => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
function readReceipt(home) {
  const file = path.join(defaultPath(home, '.config/dot-bridge'), 'service-install.json');
  let st, value;
  try { st = fs.lstatSync(file); value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(`service receipt is missing or invalid: ${file}`); }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) fail(`${file} must be a private regular file`);
  if (!value || value.schema_version !== 1 || value.home !== home || !value.unit) fail(`${file} has an unsupported service receipt`);
  return { file, value };
}
function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
function canonicalCatalogs(catalogs) {
  return canonical(Object.fromEntries(Object.keys(catalogs ?? {}).sort().map(worker => [worker,
    [...(catalogs[worker] ?? [])].sort((a, b) => String(a?.name).localeCompare(String(b?.name)))])));
}
function configurationDigest(home, receipt) {
  const root = defaultPath(home, '.config/dot-bridge');
  const hash = createHash('sha256');
  hash.update(canonical({ enable_workspace: !!receipt.enable_workspace, enable_t3: !!receipt.enable_t3 }));
  for (const name of ['workers.json', 'workers-repos.json', 'as.json', 'as-jwks.json', 'as-cookie-keys.json', 'as-storage.key', 'operator.key', 'env']) {
    const file = path.join(root, name);
    let st;
    try { st = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') { hash.update(`missing:${name}`); continue; } throw error; }
    if (!st.isFile() || st.isSymbolicLink()) fail(`configuration input must be a regular file: ${file}`);
    hash.update(`file:${name}:${st.mode & 0o777}:`); hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}
function completeCatalogs(a, b, workers) {
  if (!a?.catalogs || !b?.catalogs) return false;
  const keysA = Object.keys(a.catalogs).sort(), keysB = Object.keys(b.catalogs).sort();
  if (canonical(keysA) !== canonical(keysB) || canonical(keysA) !== canonical([...workers].sort())) return false;
  return true;
}
function catalogsEqual(a, b, workers) {
  return completeCatalogs(a, b, workers) && canonicalCatalogs(a.catalogs) === canonicalCatalogs(b.catalogs);
}
// A 0.6.0 or 0.6.1 server has no /service-check, so its catalogs are unknown (stored as {}); nothing can be compared against them.
const hasCatalogs = catalogs => !!catalogs && Object.keys(catalogs).length > 0;
function releaseVersion(r, current) {
  if (!r || r.name !== PACKAGE || typeof r.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(r.version) || typeof r.dist?.integrity !== 'string' || !r.dist.integrity.startsWith('sha512-')) fail('registry returned invalid stable release metadata');
  const parts = s => s.split('.').map(Number), a = parts(r.version), b = parts(current);
  if (!/^\d+\.\d+\.\d+$/.test(current) || a.some(n => !Number.isSafeInteger(n))) fail('installed service version is not a stable semantic version');
  return a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2]);
}
function atomic(file, text) {
  privateDir(path.dirname(file)); writeAtomic(file, text);
}
const failedFile = home => path.join(home, 'update-failed.json');
function readFailed(home) {
  try {
    const v = JSON.parse(fs.readFileSync(failedFile(home), 'utf8'));
    return typeof v?.version === 'string' && typeof v.integrity === 'string' ? v : null;
  } catch { return null; }
}
function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(src), dst); return; }
  if (!st.isDirectory() && !st.isFile()) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: st.mode & 0o777 });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name));
    fs.chmodSync(dst, st.mode & 0o777);
  } else { fs.copyFileSync(src, dst); fs.chmodSync(dst, st.mode & 0o777); }
}
function replaceTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  if (fs.existsSync(src)) copyTree(src, dst);
}
function snapshot(home, txn) {
  const target = path.join(txn, 'snapshot.pending'); fs.rmSync(target, { recursive: true, force: true }); privateDir(target);
  const roots = {};
  for (const item of ['.config', '.local']) {
    const src = path.join(home, item);
    if (fs.existsSync(src)) {
      const st = fs.lstatSync(src);
      if (!st.isDirectory() || st.isSymbolicLink()) fail(`cannot snapshot non-directory service state: ${src}`);
      roots[item] = true; copyTree(src, path.join(target, item));
    } else roots[item] = false;
  }
  atomic(path.join(target, '.snapshot-complete.json'), JSON.stringify({ complete: true, roots }));
  const ready = path.join(txn, 'snapshot'); fs.rmSync(ready, { recursive: true, force: true }); fs.renameSync(target, ready); return ready;
}
function validateSnapshot(tx) {
  const root = tx.snapshot;
  let marker;
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('transaction snapshot is not a real directory');
    marker = JSON.parse(fs.readFileSync(path.join(root, '.snapshot-complete.json'), 'utf8'));
  } catch { fail('transaction snapshot is missing or incomplete; refusing to restore service state'); }
  if (marker.complete !== true || !marker.roots || typeof marker.roots['.config'] !== 'boolean' || typeof marker.roots['.local'] !== 'boolean') fail('transaction snapshot completion marker is invalid');
  for (const item of ['.config', '.local']) {
    const file = path.join(root, item), exists = fs.existsSync(file);
    if (exists !== marker.roots[item]) fail(`transaction snapshot is incomplete for ${item}; refusing to restore service state`);
    if (exists) { const st = fs.lstatSync(file); if (!st.isDirectory() || st.isSymbolicLink()) fail(`transaction snapshot is invalid for ${item}`); }
  }
}
function unitPath(receipt, home) {
  if (!/^[A-Za-z0-9_.@-]+$/.test(String(receipt.unit ?? ''))) fail('invalid service unit name in receipt');
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = receipt.unit_dir || path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config'), 'systemd/user');
  if (!path.isAbsolute(dir) || dir.includes('\n')) fail('invalid service unit directory in receipt');
  const name = String(receipt.unit).endsWith('.service') ? String(receipt.unit) : `${receipt.unit}.service`;
  return path.join(dir, name);
}
// A 0.6.0 or 0.6.1 receipt names no package, node binary or unit directory. Read them from the unit that runs the service,
// so the first update adopts the install with no hand step and keeps the node binary the service already uses.
function adoptInstall(receipt, home) {
  if (receipt.repo && receipt.node && receipt.unit_dir) return receipt;
  const file = unitPath(receipt, home);
  let text;
  try { const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) fail('not a regular file'); text = fs.readFileSync(file, 'utf8'); }
  catch { fail(`cannot read the service unit to adopt this install: ${file}`); }
  // 0.6.0 and 0.6.1 wrote WorkingDirectory with a trailing slash; compare normalized paths and record the normalized repo.
  const written = text.match(/^WorkingDirectory=(.+)$/m)?.[1], exec = text.match(/^ExecStart=(\S+) (\S+)$/m);
  const repo = written && path.isAbsolute(written) ? path.resolve(written) : null;
  if (!repo || !exec || !path.isAbsolute(exec[2]) || path.resolve(exec[2]) !== path.join(repo, 'src/server.mjs') || !path.isAbsolute(exec[1])) fail(`service unit does not contain a supported Dalan command: ${file}`);
  return { ...receipt, repo: receipt.repo ?? repo, node: receipt.node ?? exec[1], unit_dir: receipt.unit_dir ?? path.dirname(file) };
}
function rewriteUnit(file, current, home) {
  if (!fs.existsSync(file)) fail(`service unit is missing: ${file}`);
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) fail(`service unit must be a regular file: ${file}`);
  const before = fs.readFileSync(file, 'utf8');
  const oldRepoWritten = before.match(/^WorkingDirectory=(.+)$/m)?.[1];
  const oldRepo = oldRepoWritten && path.isAbsolute(oldRepoWritten) ? path.resolve(oldRepoWritten) : oldRepoWritten;
  const exec = before.match(/^ExecStart=(.+)$/m)?.[1];
  if (!oldRepo || !exec || !exec.endsWith('/src/server.mjs')) fail(`service unit does not contain a supported Dalan command: ${file}`);
  const after = before.split('\n').map(line => /^WorkingDirectory=/.test(line) ? `WorkingDirectory=${current}` : /^ExecStart=/.test(line) ? line.replace(/\/src\/server\.mjs(?:\s.*)?$/, `${path.sep}src${path.sep}server.mjs`) : line).join('\n');
  // Preserve the selected package in ExecStart, including its node executable prefix.
  const fixed = after.replaceAll(`${oldRepo}/src/server.mjs`, `${current}/src/server.mjs`);
  const lines = fixed.split('\n').filter(l => !/^ExecStartPre=.*\sservice recover\s/.test(l));
  const i = lines.findIndex(l => /^ExecStart=/.test(l));
  const execLine = lines[i].slice('ExecStart='.length), nodeBin = execLine.slice(0, execLine.indexOf(' '));
  lines.splice(i + 1, 0, `ExecStartPre=${nodeBin} ${current}/bin/dalan.mjs service recover --home ${home} --quiet`);
  atomic(file, lines.join('\n')); fs.chmodSync(file, st.mode & 0o777); return before;
}
function select(home, repo) {
  const current = path.join(home, 'current'), tmp = path.join(home, `.current-${randomUUID()}`);
  fs.symlinkSync(path.relative(home, repo), tmp); fs.renameSync(tmp, current);
}
function prune(home, active, previous) {
  const root = path.join(home, 'versions'); if (!fs.existsSync(root)) return;
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.isSymbolicLink()).map(d => d.name).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
  const keep = new Set([active, previous]);
  for (const name of dirs) { if (keep.size >= 3) break; keep.add(name); }
  for (const name of dirs) if (!keep.has(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}
async function probeReady(probe, home, receipt, healthTimeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = performance.now() + healthTimeoutMs;
  let error;
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now();
    try { return await probe(home, receipt, { timeout: Math.max(1, Math.min(remaining, 1000)) }); }
    catch (e) {
      error = e;
      const delay = Math.min(150, Math.max(0, deadline - performance.now()));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(`service health check timed out after ${healthTimeoutMs}ms${error ? `: ${error.message}` : ''}`);
}
function readJournal(home) {
  const file = path.join(home, 'update-transaction.json');
  let txStat;
  try { txStat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!txStat.isFile() || txStat.isSymbolicLink() || (txStat.mode & 0o777) !== 0o600) fail('update transaction must be a private regular file');
  let tx;
  try { tx = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('update transaction is invalid JSON'); }
  const oldReceipt = tx?.oldReceipt;
  if (tx.home !== home || !oldReceipt || oldReceipt.home !== home || oldReceipt.schema_version !== 1 || !oldReceipt.unit ||
      !tx.oldRepo || !tx.oldVersion || !tx.snapshot || !['prepared', 'switched', 'committed'].includes(tx.phase)) fail('invalid interrupted update transaction');
  if (tx.unitFile !== (oldReceipt.unit && oldReceipt.platform !== 'darwin' ? unitPath(oldReceipt, home) : null) || !tx.oldCatalogs || typeof tx.oldCatalogs !== 'object') fail('update transaction control data is invalid');
  if (path.resolve(tx.snapshot) !== path.join(home, 'update-backup', 'snapshot')) fail('update transaction snapshot path is invalid');
  return { file, tx };
}
// Put the old package, unit and saved state back on disk. Touches no service and probes nothing.
function restoreFiles(home, tx) {
  validateSnapshot(tx);
  select(home, tx.oldRepo);
  if (tx.unitFile && tx.oldUnit != null) atomic(tx.unitFile, tx.oldUnit);
  for (const item of ['.config', '.local']) replaceTree(path.join(tx.snapshot, item), path.join(home, item));
}
function discardJournal(home, tx) {
  fs.rmSync(path.join(home, 'update-transaction.json'), { force: true });
  fs.rmSync(path.dirname(tx.snapshot), { recursive: true, force: true });
}
function restoreFromJournal(home, tx) {
  if (tx.phase === 'committed') {
    fs.rmSync(path.join(home, 'update-transaction.json'), { force: true });
    try { fs.rmSync(path.dirname(tx.snapshot), { recursive: true, force: true }); } catch { /* committed service stays selected */ }
    return;
  }
  if (tx.phase === 'switched') restoreFiles(home, tx);
  discardJournal(home, tx);
}
// Run at service start (ExecStartPre): finish filesystem recovery without touching systemd.
export function recoverService({ home }) {
  home = path.resolve(home ?? fail('home is required'));
  if (!fs.existsSync(path.join(home, 'update-transaction.json'))) return { outcome: 'nothing_pending' };
  let release;
  try { release = acquireUpdateLock(home); }
  catch (error) { if (/already running/.test(error.message)) return { outcome: 'update_running' }; throw error; }
  try {
    const journal = readJournal(home);
    if (!journal) return { outcome: 'nothing_pending' };
    restoreFromJournal(home, journal.tx);
    return { outcome: 'recovered' };
  } finally { release(); }
}
async function recover(home, control, probe, healthTimeoutMs) {
  const journal = readJournal(home);
  if (!journal) return;
  const { tx } = journal, oldReceipt = tx.oldReceipt;
  if (tx.phase === 'committed') return restoreFromJournal(home, tx);
  if (tx.phase === 'prepared') {
    await control(oldReceipt, 'restart');
    const live = await probeReady(probe, home, { ...oldReceipt, repo: tx.oldRepo }, healthTimeoutMs);
    if (live.version !== tx.oldVersion || hasCatalogs(tx.oldCatalogs) && !catalogsEqual({ catalogs: tx.oldCatalogs }, live, Object.keys(tx.oldCatalogs))) fail('interrupted update recovery could not verify old service');
  } else {
    validateSnapshot(tx);
    await control(oldReceipt, 'stop'); restoreFiles(home, tx);
    await control(oldReceipt, 'daemon-reload'); await control(oldReceipt, 'restart');
    const live = await probeReady(probe, home, { ...oldReceipt, repo: tx.oldRepo }, healthTimeoutMs);
    if (tx.oldCatalogs && (live.version !== tx.oldVersion || hasCatalogs(tx.oldCatalogs) && !catalogsEqual({ catalogs: tx.oldCatalogs }, live, Object.keys(tx.oldCatalogs)))) fail('interrupted update recovery restored selection but old service health failed');
  }
  discardJournal(home, tx);
}
function actualWorkers(home) {
  const file = path.join(defaultPath(home, '.config/dot-bridge'), 'workers.json');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`cannot read configured workers: ${file}`); }
  const workers = Object.keys(value?.workers ?? {}).sort();
  if (!workers.length) fail('configured worker set is empty');
  return workers;
}
export async function updateService({ home, check = false, yes = false, retry = false }, seams = {}) {
  if (check && retry) fail('--retry cannot be used with --check');
  home = path.resolve(home ?? fail('home is required'));
  const latest = seams.latestRelease ?? defaultLatest, install = seams.installRelease ?? defaultInstall;
  const probe = seams.probeService ?? defaultProbe, candidateProbe = seams.probeCandidate ?? defaultCandidate;
  const control = seams.controlService ?? defaultControl, pruneVersions = seams.pruneVersions ?? prune;
  const healthTimeoutMs = seams.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs <= 0) fail('healthTimeoutMs must be a positive finite duration');
  if (check) {
    const receipt = adoptInstall(readReceipt(home).value, home), active = fs.existsSync(path.join(home, 'current')) ? fs.realpathSync(path.join(home, 'current')) : receipt.repo;
    if (!active) fail('current service repository is missing');
    const current = JSON.parse(fs.readFileSync(path.join(active, 'package.json'), 'utf8')).version;
    const r = await latest(receipt); const forward = releaseVersion(r, current);
    const result = { outcome: forward ? 'update_available' : 'up_to_date', current_version: current, latest_version: r.version };
    if (!forward) result.outcome = 'up_to_date';
    atomic(path.join(home, 'update-result.json'), JSON.stringify({ ...result, timestamp: new Date().toISOString() })); return result;
  }
  privateDir(home);
  const releaseLock = acquireUpdateLock(home);
  const resultFile = path.join(home, 'update-result.json');
  let result, attempted;
  try {
    await recover(home, control, probe, healthTimeoutMs);
    const { value: storedReceipt, file: receiptFile } = readReceipt(home);
    const receipt = adoptInstall(storedReceipt, home);
    let current = path.join(home, 'current');
    let oldRepo = fs.existsSync(current) ? fs.realpathSync(current) : receipt.repo;
    if (!oldRepo || !fs.existsSync(oldRepo)) fail('current service repository is missing');
    const oldVersion = JSON.parse(fs.readFileSync(path.join(oldRepo, 'package.json'), 'utf8')).version;
    const workers = actualWorkers(home);
    const r = await latest(receipt), forward = releaseVersion(r, oldVersion);
    if (!forward) { result = { outcome: 'up_to_date', current_version: oldVersion, latest_version: r.version }; return result; }
    const failed = readFailed(home);
    if (!retry && failed && failed.version === r.version && failed.integrity === r.dist.integrity) {
      result = { outcome: 'skipped_failed_release', current_version: oldVersion, latest_version: r.version, failed_version: failed.version, message: `Release ${r.version} was rolled back earlier; not retrying automatically. Run dalan service update --retry to try it again.` };
      return result;
    }
    attempted = r;
    const installed = await install(home, r);
    const candidate = path.resolve(installed), versions = path.resolve(home, 'versions');
    if (candidate !== path.join(versions, r.version, 'node_modules', '@tnunamak', 'dalan') || !candidate.startsWith(`${versions}${path.sep}`) || fs.realpathSync(candidate) !== candidate) fail('candidate repository does not match exact package version path');
    const packageInfo = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
    if (packageInfo.name !== PACKAGE || packageInfo.version !== r.version) fail('installed candidate package identity does not match registry release');
    const base = await probe(home, receipt), legacy = base.legacy === true;
    const configBeforeCandidate = configurationDigest(home, receipt);
    const tested = await candidateProbe(home, receipt, candidate);
    if (configurationDigest(home, receipt) !== configBeforeCandidate) fail('service configuration changed during candidate self-check; retry update');
    if (base.version !== oldVersion || tested.version !== r.version) fail('service probe returned an unexpected package version');
    if (!completeCatalogs(legacy ? tested : base, tested, workers)) fail('candidate self-check failed or worker catalogs are incomplete');
    const changedCatalog = !legacy && !catalogsEqual(base, tested, workers);
    if (changedCatalog && !yes) {
      result = { outcome: 'connector_refresh_required', current_version: oldVersion, candidate_version: r.version, connector_refresh_required: true, message: 'Worker tool catalogs changed. Run dalan service update --yes with the same --home to switch, then refresh hosted connectors.' };
      prune(home, oldVersion, r.version);
      return result;
    }
    // A catalog difference requires explicit consent; exact parity may proceed without it.
    const digestBeforeRecheck = configurationDigest(home, receipt);
    const liveAgain = await probe(home, receipt);
    if (liveAgain.version !== oldVersion || !legacy && !catalogsEqual(base, liveAgain, workers)) fail('live worker catalog changed during update; retry after connector refresh');
    if (configurationDigest(home, receipt) !== digestBeforeRecheck || digestBeforeRecheck !== configBeforeCandidate) fail('service configuration changed during update; retry after connector refresh');
    // A macOS agent runs the package through the home's `current` link, so a switch needs no plist rewrite.
    const unitFile = receipt.unit && receipt.platform !== 'darwin' ? unitPath(receipt, home) : null;
    const txDir = path.join(home, 'update-backup'); privateDir(txDir);
    const tx = { home, oldRepo, candidate, snapshot: path.join(txDir, 'snapshot'), unitFile, oldUnit: unitFile && fs.existsSync(unitFile) ? fs.readFileSync(unitFile, 'utf8') : null, oldCatalogs: base.catalogs ?? {}, oldVersion, oldReceipt: { ...receipt }, phase: 'prepared' };
    if (unitFile && tx.oldUnit == null) fail(`service unit is missing: ${unitFile}`);
    atomic(path.join(home, 'update-transaction.json'), JSON.stringify(tx));
    try {
      await control(receipt, 'stop');
      if (configurationDigest(home, receipt) !== configBeforeCandidate) fail('service configuration changed while stopping; update cancelled');
      snapshot(home, txDir);
      if (configurationDigest(home, receipt) !== configBeforeCandidate) fail('service configuration changed while preparing switch; update cancelled');
      tx.phase = 'switched'; atomic(path.join(home, 'update-transaction.json'), JSON.stringify(tx));
      atomic(defaultPath(home, '.config/dot-bridge', 'service-catalog.json'), JSON.stringify({ version: r.version, catalogs: tested.catalogs }));
      select(home, candidate);
      if (unitFile) rewriteUnit(unitFile, current, home);
      await control(receipt, 'daemon-reload'); await control(receipt, 'restart');
      const live = await probeReady(probe, home, { ...receipt, repo: candidate }, healthTimeoutMs);
      if (live.version !== r.version || !completeCatalogs(tested, live, workers) || !catalogsEqual(tested, live, workers)) fail('updated service health or worker catalogs failed');
      receipt.repo = candidate; receipt.version = r.version;
      atomic(receiptFile, JSON.stringify(receipt));
      fs.rmSync(defaultPath(home, '.config/dot-bridge', 'service-catalog.json'), { force: true });
      const committedTx = { ...tx, phase: 'committed' };
      try { atomic(path.join(home, 'update-transaction.json'), JSON.stringify(committedTx)); }
      catch (error) {
        let journal;
        try { journal = JSON.parse(fs.readFileSync(path.join(home, 'update-transaction.json'), 'utf8')); }
        catch { error.preserveCandidate = true; throw error; }
        if (journal.phase === 'committed' && journal.home === home) {
          tx.phase = 'committed';
          try { fs.rmSync(failedFile(home), { force: true }); } catch { /* see above */ }
          result = { outcome: 'updated', previous_version: oldVersion, version: r.version, cleanup_warning: `committed journal is visible but its durability check failed: ${error.message}; recovery data was preserved` };
          return result;
        }
        if (journal.phase !== 'switched') { error.preserveCandidate = true; throw error; }
        throw error;
      }
      tx.phase = 'committed';
      result = { outcome: 'updated', previous_version: oldVersion, version: r.version, ...(legacy ? { adopted_legacy_server: true } : {}) };
      try { fs.rmSync(failedFile(home), { force: true }); } catch { /* stale record only skips the same release */ }
      const cleanupWarnings = [];
      try { fs.rmSync(path.join(home, 'update-transaction.json'), { force: true }); } catch (error) { cleanupWarnings.push(`transaction marker cleanup failed: ${error.message}`); }
      try { fs.rmSync(txDir, { recursive: true, force: true }); } catch (error) { cleanupWarnings.push(`backup cleanup failed: ${error.message}`); }
      try { pruneVersions(home, r.version, oldVersion); } catch (error) { cleanupWarnings.push(`version pruning failed: ${error.message}`); }
      if (cleanupWarnings.length) result.cleanup_warning = cleanupWarnings.join('; ');
    } catch (error) {
      if (error.preserveCandidate) {
        const uncertain = new Error(`update commit state is uncertain; candidate and recovery data were preserved: ${error.message}`);
        uncertain.updateOutcome = 'rollback_failed';
        throw uncertain;
      }
      let rollbackError;
      try {
        if (tx.phase === 'switched') validateSnapshot(tx);
        await control(receipt, 'stop'); select(home, oldRepo); if (unitFile && tx.oldUnit != null) atomic(unitFile, tx.oldUnit);
        if (tx.phase === 'switched') for (const item of ['.config', '.local']) replaceTree(path.join(txDir, 'snapshot', item), path.join(home, item));
        await control(receipt, 'daemon-reload'); await control(receipt, 'restart');
        const restored = await probeReady(probe, home, { ...receipt, repo: oldRepo }, healthTimeoutMs);
        if (restored.version !== oldVersion || !legacy && !catalogsEqual(base, restored, workers)) fail('old service health verification failed');
        fs.rmSync(path.join(home, 'update-transaction.json'), { force: true }); fs.rmSync(txDir, { recursive: true, force: true });
      } catch (e) { rollbackError = e; }
      if (rollbackError) { const e = new Error(`update failed: ${error.message}; rollback failed: ${rollbackError.message}`); e.updateOutcome = 'rollback_failed'; throw e; }
      error.updateOutcome = 'rolled_back';
      throw error;
    }
    return result;
  } catch (error) {
    result = { outcome: error.updateOutcome ?? 'failed', error: error.message };
    if (attempted && (result.outcome === 'rolled_back' || result.outcome === 'rollback_failed')) {
      try { atomic(failedFile(home), JSON.stringify({ version: attempted.version, integrity: attempted.dist.integrity, outcome: result.outcome, timestamp: new Date().toISOString() })); } catch { /* best effort */ }
    }
    throw error;
  } finally {
    try { if (result) atomic(resultFile, JSON.stringify({ ...result, timestamp: new Date().toISOString() })); }
    finally { releaseLock(); }
  }
}

export function serviceStatus({ home }) {
  home = path.resolve(home ?? fail('home is required'));
  const { value: receipt } = readReceipt(home), current = path.join(home, 'current');
  let version = receipt.version;
  if (fs.existsSync(current)) version = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(current), 'package.json'), 'utf8')).version;
  let last_result = null;
  try { last_result = JSON.parse(fs.readFileSync(path.join(home, 'update-result.json'), 'utf8')); } catch { /* no update attempt */ }
  return { version, auto_update: receipt.auto_update ?? false, last_result, failed_release: readFailed(home)?.version ?? null };
}
