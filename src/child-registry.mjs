// A trial's child processes (the public-route ssh, the bridge) are listed in a registry outside every trial home. If the trial's own
// process is killed without cleanup, the children keep running; the next trial sweeps the registry and ends the ones whose owner is
// gone. A child is ended only when its PID still has the exact command line recorded for it: never by PID alone.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const childRegistry = (env = process.env) => path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'dalan', 'trial-children');
export const commandOf = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
};

// Records one child. Returns a function that removes the record; call it once the child has exited.
export function registerChild({ registry, child, processCmd = commandOf, owner = process.pid }) {
  if (!Number.isInteger(child?.pid)) return () => {};
  const file = path.join(registry, `${child.pid}.json`);
  try {
    fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, cmd: processCmd(child.pid), owner, ownerCmd: processCmd(owner) }), { mode: 0o600 });
  } catch { return () => {}; }
  return () => fs.rmSync(file, { force: true });
}

// Ends every listed child whose owner no longer runs. Returns the PIDs it ended.
export async function sweepChildren({ registry, processCmd = commandOf, kill = (pid, sig) => process.kill(pid, sig), clock = { sleep }, graceMs = 2000 }) {
  let names = []; try { names = fs.readdirSync(registry).filter(n => n.endsWith('.json')); } catch { return []; }
  const ended = [];
  for (const name of names) {
    const file = path.join(registry, name);
    let rec; try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fs.rmSync(file, { force: true }); continue; }
    if (Number.isInteger(rec.owner) && rec.owner !== process.pid && rec.ownerCmd && processCmd(rec.owner) === rec.ownerCmd) continue; // its trial still runs
    const same = () => Number.isInteger(rec.pid) && Boolean(rec.cmd) && processCmd(rec.pid) === rec.cmd;
    if (same()) {
      try { kill(rec.pid, 'SIGTERM'); } catch { /* gone */ }
      for (let waited = 0; waited < graceMs && same(); waited += 100) await clock.sleep(100);
      if (same()) { try { kill(rec.pid, 'SIGKILL'); } catch { /* gone */ } }
      ended.push(rec.pid);
    }
    fs.rmSync(file, { force: true });
  }
  return ended;
}
