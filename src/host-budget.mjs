import { readEnv } from './env.mjs';
import fs from 'node:fs';
import {resolvePreparedNodeModules} from './prepared-node-modules.mjs';
import {resolvePreparedGoModules} from './prepared-go-modules.mjs';
import path from 'node:path';
import {prepareHostReceipts,assertHostReceiptIsolation,readVerifiedHostStop} from './host-budget-receipts.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

// The fixed production unit reserves one active envelope per Unix user.
// The 2 GiB memory ceiling covers the heaviest measured suite-class workload
// on the deployment host (a 1592 MB peak in the test-sandbox run ledger,
// 2026-11-24) with about 27% margin; one unit runs per user at a time.
export const HOST_BUDGET_CEILINGS = Object.freeze({ cpu_ms: 120000, wall_ms: 180000, memory_bytes: 2 * 1024 ** 3, processes: 128, disk_write_bytes: 256 * 1024 ** 2, output_bytes: 1024 ** 2 });
// A workload the kernel OOM-killed is not restarted at once: the same workload
// on the same unit fails fast with reason "oom" until this delay passes, so a
// caller's restart loop cannot re-kill it second after second. The production
// unit is shared by every job of a Unix user, so the key includes the workload:
// one job's memory kill must not fail another job's check.
export const HOST_CHECK_OOM_RETRY_DELAY_MS = 60_000;
const oomKilledReservations = new Map();
const minima = { cpu_ms: 50, wall_ms: 100, memory_bytes: 128 * 1024 ** 2, processes: 16, disk_write_bytes: 1024 ** 2, output_bytes: 1024 };
const service = fileURLToPath(new URL('./host-budget-service.mjs', import.meta.url));
const stopRecorder = fileURLToPath(new URL('./host-budget-stop.mjs', import.meta.url));
const cgroupReader = fileURLToPath(new URL('./host-cgroup.mjs', import.meta.url));
const processSignaler = fileURLToPath(new URL('./signal-sandbox-processes.py', import.meta.url));

export function resolveHostStopEvidence(receipts, pipeStop) {
  const evidence=receipts?readVerifiedHostStop({receiptDir:receipts.receiptDir,checkRunId:receipts.checkRunId}):pipeStop;
  if(!evidence) return null;
  return {...evidence,verified:evidence.verified===true&&Array.isArray(evidence.remaining_pids)&&evidence.remaining_pids.length===0};
}

export function parseHostBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 6) throw new Error('host_budget requires cpu_ms, wall_ms, memory_bytes, processes, disk_write_bytes, output_bytes');
  const result = {};
  for (const key of Object.keys(HOST_BUDGET_CEILINGS)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < minima[key] || value[key] > HOST_BUDGET_CEILINGS[key]) throw new Error(`invalid host_budget.${key}: expected ${minima[key]}..${HOST_BUDGET_CEILINGS[key]}`);
    result[key] = value[key];
  }
  for(const key of ['memory_bytes','disk_write_bytes']) if(result[key]%4096!==0) throw new Error(`invalid host_budget.${key}: expected a multiple of 4096`);
  return result;
}

const propertyArg = value => '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

export const provesHostNotStarted = ({ spawnError, pid, stopped }) => !!(spawnError && !pid && !stopped);

function markOomKilledReservation(key, at) {
  for (const [reservation, killedAt] of oomKilledReservations) if (at - killedAt >= HOST_CHECK_OOM_RETRY_DELAY_MS) oomKilledReservations.delete(reservation);
  oomKilledReservations.set(key, at);
}

// Nothing was launched: the caller marks the check failed with reason "oom"
// instead of handing the same workload back to the kernel that just killed it.
function deferredOomReservation({ unit, budgets, killedAt, at }) {
  return { unit, dependencies: null, exit: { code: 125 }, budgets, usage: null, usage_complete: false, bytes: Buffer.alloc(0), phases: [],
    error: `oom: ${unit} was kernel-killed and is not restarted at once (retry after ${Math.ceil((killedAt + HOST_CHECK_OOM_RETRY_DELAY_MS - at) / 1000)}s)`,
    stop: { verified: false, reason: 'oom', service_result: 'oom-kill', invocation_id: null, remaining_pids: null, oom_kill: null },
    notStarted: true, timedOut: false, cancelled: false, truncated: false, duration_ms: 0 };
}

export async function runHostBudget(options) {
  let spawned=false;
  try { return await runHostBudgetAttempt(options,()=>{spawned=true;}); }
  catch(error) { if(spawned) error.hostInvoked=true;throw error; }
}

async function runHostBudgetAttempt({ dir, budgets, phases, maskPaths = [], sourceExemptions = [], checkRunId, receiptDir, cancelled = () => false, onStarted, onOutputStarted, enabled = readEnv('DALAN_HOST_CHECKS') === '1', now = () => performance.now() }, onSpawned) {
  if (!enabled) throw new Error('host_execution_disabled: set DALAN_HOST_CHECKS=1 to opt in');
  if (process.platform !== 'linux') throw new Error(`host budget backend unavailable on ${process.platform}`);
  budgets = parseHostBudget(budgets);
  if (!Array.isArray(phases) || !phases.length || phases.length > 2 || phases.some(p => !['install', 'check'].includes(p.name) || !Array.isArray(p.argv) || !p.argv.length || p.argv.some(a => typeof a !== 'string' || a.includes('\0')))) throw new Error('invalid host phases');
  const receipts=prepareHostReceipts({checkRunId,receiptDir});
  const workingDir=fs.realpathSync(dir);
  const dependencies=resolvePreparedNodeModules(workingDir);
  const goModules=resolvePreparedGoModules(workingDir);
  const protectedPaths=['node_modules','package.json','package-lock.json','go.mod','go.sum'];
  const overlaps=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
  for(const name of [...maskPaths,...sourceExemptions.map(entry=>entry.path)]) {
    if(typeof name!=='string'||!name||path.posix.normalize(name)!==name||name.startsWith('/')||name==='..'||name.startsWith('../')||protectedPaths.some(p=>overlaps(name,p))) throw new Error('dependencies_invalid: overlay overlaps dependency inputs');
  }
  if(dependencies) for(const entry of sourceExemptions) {
    const host=fs.realpathSync(entry.hostPath), tree=fs.realpathSync(dependencies.treePath);
    if(host===tree||host.startsWith(tree+path.sep)||tree.startsWith(host+path.sep)) throw new Error('dependencies_invalid: overlay exposes dependency tree');
  }
  if(receipts) {
    assertHostReceiptIsolation(receipts.receiptDir,[workingDir,'/usr','/lib','/lib64','/etc/alternatives',process.execPath,
      path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm'),service,stopRecorder,
      cgroupReader,processSignaler,
      fileURLToPath(new URL('./host-budget-storage.py',import.meta.url)),fileURLToPath(new URL('./host-budget-seccomp.py',import.meta.url)),
      ...sourceExemptions.map(entry=>entry.hostPath),...(dependencies?[dependencies.treePath]:[]),...(goModules?[goModules.treePath]:[])]);
  }
  const config = { dir: workingDir, budgets, phases, maskPaths, sourceExemptions, dependencies, goModules, node: process.execPath, ...(receipts?{receipts}:{}) };
  const serialized = JSON.stringify(config);
  if (Buffer.byteLength(serialized) > 65536) throw new Error('host budget configuration exceeds 64 KiB');
  const properties = [
    'Type=exec', 'Nice=10', `MemoryMax=${budgets.memory_bytes}`, 'MemorySwapMax=0', `TasksMax=${budgets.processes}`,
    'CPUQuota=100%', 'CPUQuotaPeriodSec=10ms', `RuntimeMaxSec=${budgets.wall_ms}ms`,
    'KillMode=control-group', 'KillSignal=SIGKILL', 'TimeoutStopSec=1s', 'SendSIGKILL=yes', 'OOMPolicy=continue',
    'LimitCORE=0', 'UMask=0077',
    `ExecStopPost=${[process.execPath, stopRecorder,...(receipts?['--check-run-id',receipts.checkRunId,'--receipt-dir',receipts.receiptDir]:[])].map(propertyArg).join(' ')}`,
  ];
  // Test suites isolate their reservation without changing the production default.
  const suffix = process.env.NODE_ENV === 'production' ? undefined : process.env.DALAN_HOST_CHECK_UNIT_SUFFIX;
  if (suffix && !/^[a-zA-Z0-9-]{1,80}$/.test(suffix)) throw new Error('invalid DALAN_HOST_CHECK_UNIT_SUFFIX');
  const unit = `dot-bridge-host-check${suffix ? '-' + suffix : ''}.service`;
  const oomKey = `${unit}#${createHash('sha256').update(JSON.stringify({ dir: workingDir, phases, budgets })).digest('hex')}`;
  const oomKilledAt = oomKilledReservations.get(oomKey);
  if (oomKilledAt !== undefined && now() - oomKilledAt < HOST_CHECK_OOM_RETRY_DELAY_MS) return deferredOomReservation({ unit, budgets, killedAt: oomKilledAt, at: now() });
  const args = ['--user', '--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`, ...properties.map(p => `--property=${p}`), '--', process.execPath, service];
  const started=performance.now();
  const child = spawn('/usr/bin/systemd-run', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  onSpawned();
  child.stdin.write(serialized+'\n');
  let buffer = '', message = null, stopped = null, pid = null, diagnostic = '', callbackError = null, cancellationSent = false, cpuExceeded = false;
  const launched = [];
  const partial = new Map();
  let partialUsage = null;
  const cancel = () => { if(!cancellationSent){cancellationSent=true;child.stdin.write('cancel\n');} };
  // Trusted supervisor messages only: guest stdout/stderr never reach this pipe
  // directly. Still cap transport before parsing, including a broken supervisor.
  // Output appears once in partial frames and once in the final receipt; the
  // fixed allowance covers 10 reports per second at the maximum wall budget.
  const transportCap = budgets.output_bytes * 3 + 1048576;
  let received = 0;
  child.stdout.on('data', chunk => {
    received += chunk.length;
    if (received > transportCap) { cancel(); return; }
    buffer += chunk.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.event === 'pid') pid = event.pid;
        if (event.event === 'started' && phases.some(p => p.name === event.phase)) {
          launched.push(event.phase);
          if (onStarted) Promise.resolve(onStarted({ pid, unit, phase: event.phase })).catch(e => { callbackError = e; cancel(); });
        }
        if (event.event === 'output_started' && onOutputStarted) Promise.resolve(onOutputStarted({ pid, unit, phase: event.phase })).catch(e => { callbackError = e; cancel(); });
        if (event.event === 'partial' && launched.includes(event.phase)) {
          const chunks = partial.get(event.phase) ?? [];
          chunks.push(Buffer.from(event.output, 'base64'));
          partial.set(event.phase, chunks);
          partialUsage = event.usage;
        }
        if (event.event === 'result') {
          // Both supervisors report here; EOF cleanup cannot undo an observed limit.
          cpuExceeded ||= event.result?.error === 'budget exceeded: cpu';
          message = event.result;
        }
        if (event.event === 'stopped') stopped = event.stop;
      } catch { diagnostic = 'invalid supervisor response'; }
    }
  });
  child.stderr.on('data', chunk => { if (diagnostic.length < 8192) diagnostic += chunk.toString('utf8').slice(0, 8192 - diagnostic.length); });
  child.stdin.on('error', () => {});
  const poll = setInterval(() => { if (cancelled()) cancel(); }, 50);
  const exit = await new Promise(resolve => { child.once('error', e => resolve({ code: null, error: e.message })); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearInterval(poll);
  child.stdin.end();
  if (callbackError) throw callbackError;
  // ExecStopPost runs after systemd has killed/reaped every process in the unit,
  // even on OOM, RuntimeMaxSec, or loss of the main supervisor. No PID sweep or
  // application TTL can certify a still-running tree as stopped.
  const stopEvidence=resolveHostStopEvidence(receipts,stopped);
  const stop = { verified: stopEvidence?.verified === true, reason: stopEvidence?.verified ? 'systemd_control_group_stopped' : 'service_stop_not_observed', service_result: stopped?.result ?? null, invocation_id: stopEvidence?.invocationId ?? stopped?.invocation_id ?? null, remaining_pids: stopEvidence?.remaining_pids ?? stopped?.remaining_pids ?? null, oom_kill: stopped?.oom_kill ?? null };
  if ((stopped?.oom_kill ?? 0) > 0 || stopped?.result === 'oom-kill') markOomKilledReservation(oomKey, now());
  let error = cpuExceeded ? 'budget exceeded: cpu' : message?.error ?? null;
  if (stopped?.oom_kill > 0 || stopped?.result === 'oom-kill') error = 'budget exceeded: memory';
  else if (stopped?.result === 'timeout') error = 'budget exceeded: wall';
  else if (stopped && !message) error = stopped.result === 'signal' ? 'supervisor interrupted' : `host preparation failed: ${diagnostic.trim() || stopped.exit_status || 'supervisor exited without a receipt'}`;
  else if (!stopped) error = pid ? 'host budget stop unverified: no service stop receipt' : `host budget admission failed: ${diagnostic.trim() || exit.error || 'service unavailable or busy'}`;
  if (stopped && !stop.verified) error = 'host budget stop unverified';
  const phaseResults = launched.map(name => {
    const p = (message?.phases ?? []).find(result => result.name === name);
    return p ? { ...p, bytes: Buffer.from(p.output, 'base64'), stop } : { name, exit: { code: 125 }, output: '', bytes: Buffer.concat(partial.get(name) ?? []), stop };
  });
  const bytes = Buffer.concat(phaseResults.map(p => p.bytes)).subarray(0, budgets.output_bytes);
  const notStarted=provesHostNotStarted({spawnError:exit.error,pid,stopped}); // stderr is not trusted for this decision.
  const usage = message?.usage ? { ...partialUsage, ...message.usage } : partialUsage;
  return { unit, dependencies: dependencies ? {lock_sha256:dependencies.lock_sha256,manifest_sha256:dependencies.manifest_sha256,runtime:dependencies.runtime} : null, go_modules: goModules ? {go_mod_sha256:goModules.go_mod_sha256,go_sum_sha256:goModules.go_sum_sha256,runtime:goModules.runtime} : null, exit: error ? { code: 125 } : message?.exit ?? { code: 125 }, error, budgets, usage, usage_complete: !!message?.usage && !!message?.phases?.length && stopped?.result !== 'timeout' && !stopped?.oom_kill, bytes, phases: phaseResults, stop, notStarted, timedOut: error === 'budget exceeded: wall', cancelled: !!message?.cancelled, truncated: error === 'budget exceeded: output', duration_ms: Math.round(performance.now()-started) };
}
