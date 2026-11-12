// A trial's child processes (the public-route ssh, the bridge) are listed in a registry outside every trial home. If the trial's own
// process is killed without cleanup, the children keep running; the next trial sweeps the registry and ends them only after the
// recorded owner is confirmed gone and the child's recorded identity still matches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processCommand } from './process-inspection.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const childRegistry = (env = process.env) => path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'dalan', 'trial-children');

// Kept for callers that need only a command string. Cleanup uses the three-state processCommand result below.
export const commandOf = pid => {
  const identity = processCommand(pid);
  return identity.state === 'present' ? identity.command : null;
};

const inspect = (processCmd, pid) => {
  try {
    const result = processCmd(pid);
    if (result && typeof result === 'object' && ['present', 'absent', 'unknown'].includes(result.state)) return result;
    // Older injected inspectors returned a command string or null. A null result cannot prove absence.
    if (typeof result === 'string' && result) return { state: 'present', command: result, start: null };
  } catch { /* a failed inspection is unknown */ }
  return { state: 'unknown' };
};

const childMatches = (identity, record) => {
  if (identity.state === 'absent') return 'gone';
  if (identity.state !== 'present' || !record.cmd) return 'unknown';
  if (record.cmd !== identity.command) return 'different';
  if (record.start && !identity.start) return 'unknown';
  if (record.start && record.start !== identity.start) return 'different';
  return 'same';
};

// Records one child. Returns a function that removes its record after the child exits.
export function registerChild({ registry, child, processCmd = processCommand, owner = process.pid }) {
  if (!Number.isInteger(child?.pid)) return () => {};
  const file = path.join(registry, `${child.pid}.json`);
  try {
    fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
    const childIdentity = inspect(processCmd, child.pid);
    const ownerIdentity = inspect(processCmd, owner);
    fs.writeFileSync(file, JSON.stringify({
      pid: child.pid,
      cmd: childIdentity.state === 'present' ? childIdentity.command : null,
      start: childIdentity.state === 'present' ? childIdentity.start ?? null : null,
      owner,
      ownerCmd: ownerIdentity.state === 'present' ? ownerIdentity.command : null,
      ownerStart: ownerIdentity.state === 'present' ? ownerIdentity.start ?? null : null,
    }), { mode: 0o600 });
  } catch { return () => {}; }
  return () => fs.rmSync(file, { force: true });
}

// Ends listed children only after the recorded owner is known to be gone or its PID has a different start identity.
export async function sweepChildren({ registry, processCmd = processCommand, kill = (pid, sig) => process.kill(pid, sig), clock = { sleep }, graceMs = 2000 }) {
  let names = [];
  try { names = fs.readdirSync(registry).filter(n => n.endsWith('.json')); } catch { return []; }
  const ended = [];
  for (const name of names) {
    const file = path.join(registry, name);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;

    if (!Number.isInteger(record.owner)) continue;
    const owner = inspect(processCmd, record.owner);
    const ownerGone = owner.state === 'absent';
    const ownerReused = owner.state === 'present' && Boolean(record.ownerStart) && Boolean(owner.start) && owner.start !== record.ownerStart;
    if (!ownerGone && !ownerReused) continue;

    let childState = childMatches(inspect(processCmd, record.pid), record);
    if (childState === 'unknown') continue;
    if (childState === 'same') {
      try { kill(record.pid, 'SIGTERM'); } catch { /* inspect again: a signal error does not prove exit */ }
      for (let waited = 0; waited < graceMs; waited += 100) {
        await clock.sleep(100);
        childState = childMatches(inspect(processCmd, record.pid), record);
        if (childState !== 'same') break;
      }
      if (childState === 'same') {
        try { kill(record.pid, 'SIGKILL'); } catch { /* inspect again before releasing the record */ }
        childState = childMatches(inspect(processCmd, record.pid), record);
      }
      if (childState === 'same' || childState === 'unknown') continue;
      ended.push(record.pid);
    }
    // An absent or reused child PID has no process left that this record can safely own.
    fs.rmSync(file, { force: true });
  }
  return ended;
}
