import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Test-only process-tree supervision helpers. Production host checks use the
// systemd control-group stop receipt instead of this namespace and PID scan.

// bwrap and pasta inherit every fd the bridge process leaves open without close-on-exec. Node's spawn only wires fds 0..2, so this
// launcher closes every other fd it was handed, then execs the real command. It lists /proc/self/fd (so a sparse fd such as 700 is
// found as surely as fd 3) and uses bash because only bash can close a multi-digit fd (`exec 700>&-`); dash cannot. The glob is
// expanded before the loop starts, so closing the directory fd it used is harmless. No redirection wraps the loop: a saved copy of
// stderr would itself be one of the fds in the list.
export const LAUNCHER = '/usr/bin/bash';
const CLOSE_FDS = 'for f in /proc/self/fd/*; do n=${f##*/}; case $n in 0|1|2) ;; *) eval "exec $n>&-" ;; esac; done; exec "$@"';
export const withClosedFds = (command, args) => [LAUNCHER, ['-c', CLOSE_FDS, 'dot-launcher', command, ...args]];

// bwrap --info-fd 3 reports the sandbox's pid-namespace inode and its child pid once the namespace exists. The launcher script that
// execs bwrap opens the fd on a bridge-owned file (pasta closes inherited fds, so a pipe cannot cross it).
export const INFO_FD = 3;
export async function readSandboxInfo(file, { gone = () => false, timeoutMs = 20000, pollMs = 5 } = {}) {
  const end = performance.now() + timeoutMs;
  for (;;) {
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isInteger(info['pid-namespace'])) return info;
    } catch {}
    if (gone() || performance.now() >= end) return null;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

// TEST-ONLY. stat() and pidNamespace() map an unreadable /proc entry to "gone", which is wrong for proof. Production stop evidence comes
// from the durable cgroup receipts (host-budget-receipts.mjs), never from this module.
const numeric = /^[0-9]+$/;
// "pid (comm) S ppid pgrp ..." where comm may contain spaces and parentheses, so cut at the last ')'. Field 22 is the start time in clock
// ticks since boot: with the pid it names one process for ever, which a bare pid does not (pids are reused).
function stat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]), start: Number(rest[19]) };
  } catch { return null; }
}
const alive = s => s && s.state !== 'Z' && s.state !== 'X';
const pidNamespace = pid => { try { return fs.readlinkSync(`/proc/${pid}/ns/pid`); } catch { return null; } };
export const processStart = pid => stat(pid)?.start ?? null;
// The namespace init: only a process that is a direct child of the sandbox launcher and no older than it can be recorded as the init.
export function initIdentity(initPid, launcherPid, sandboxStart) {
  const s = Number.isInteger(initPid) ? stat(initPid) : null;
  return alive(s) && s.ppid === launcherPid && (sandboxStart === null || s.start >= sandboxStart) ? { pid: initPid, start: s.start } : null;
}

// Does this process belong to the sandbox? It must be alive, started no earlier than the sandbox, and either be in the sandbox's pid
// namespace or process group, or be exactly the recorded namespace init (pid and start time). A bare pid never counts.
export function classify(pid, { nsInode = null, pgid = null, sandboxStart = null, init = null }) {
  const s = stat(pid);
  if (!alive(s)) return null;
  if (init && pid === init.pid && s.start === init.start) return { pid, start: s.start, reason: 'namespace_init_alive' };
  if (sandboxStart !== null && s.start < sandboxStart) return null;
  const inNs = nsInode !== null && pidNamespace(pid) === `pid:[${nsInode}]`;
  if (inNs) return { pid, start: s.start, reason: 'in_sandbox_pid_namespace' };
  if (pgid !== null && s.pgrp === pgid) return { pid, start: s.start, reason: 'in_process_group' };
  return null;
}
// A process that made itself non-dumpable hides its ns link from us, so the namespace init is checked as well: the kernel does not let a
// pid-namespace init finish exiting until every other task in the namespace is gone.
export function remainingProcesses(scope) {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!numeric.test(entry)) continue;
    const hit = classify(Number(entry), scope);
    if (hit) found.push(hit);
  }
  return found;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const signalHelper = fileURLToPath(new URL('./signal-sandbox-processes.py', import.meta.url));
export function signalSandboxProcesses(processes, scope) {
  if (!processes.length) return [];
  const result=spawnSync('/usr/bin/python3',[signalHelper],{input:JSON.stringify({processes,scope}),encoding:'utf8',timeout:2000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin'}});
  if (result.status!==0) return [];
  try { const pids=JSON.parse(result.stdout);return Array.isArray(pids)?pids.filter(Number.isSafeInteger):[]; } catch { return []; }
}
// Waits for the sandbox to be empty. After `graceMs` it SIGKILLs what is left, then waits again. Before each kill the process is
// classified again. The signal helper opens a pidfd, checks the same identity and scope, then signals that pidfd so a later PID reuse
// cannot redirect SIGKILL to another process.
export async function verifyStopped({ graceMs = 1000, sweepMs = 2000, pollMs = 20, scan = remainingProcesses, recheck = (entry, scope) => classify(entry.pid, scope), signal = signalSandboxProcesses, ...scope }) {
  const hasScope=Number.isSafeInteger(scope.nsInode)&&scope.nsInode>0 || Number.isSafeInteger(scope.pgid)&&scope.pgid>0 || Number.isSafeInteger(scope.init?.pid)&&Number.isSafeInteger(scope.init?.start);
  if (!hasScope) {
    return { verified: false, remaining: [], swept: [], reason: 'sandbox_scope_unavailable' };
  }
  let remaining = scan(scope), swept = [];
  const waitFor = async ms => { for (const end = performance.now() + ms; remaining.length && performance.now() < end;) { await sleep(pollMs); remaining = scan(scope); } };
  await waitFor(graceMs);
  if (remaining.length) {
    const eligible=[];
    for (const entry of remaining) {
      const again = recheck(entry, scope);
      if (again && again.start === entry.start) eligible.push(entry);
    }
    try { swept.push(...signal(eligible,scope)); } catch {}
    await waitFor(sweepMs);
  }
  return { verified: remaining.length === 0, remaining, swept };
}
