import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// null means inspection could not establish liveness. Callers must retain the slot in that state.
export function liveWaiter(held, { platform = process.platform, run = execFileSync, readFile = fs.readFileSync, probe = pid => process.kill(pid, 0) } = {}) {
  if (!Number.isSafeInteger(held?.pid) || held.pid <= 0) return null;
  try { probe(held.pid); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') return null;
  }

  let command;
  try {
    command = platform === 'darwin'
      ? run('/bin/ps', ['-p', String(held.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 })
      : platform === 'linux' ? readFile(`/proc/${held.pid}/cmdline`, 'utf8') : null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { probe(held.pid); } catch (probeError) { if (probeError.code === 'ESRCH') return false; }
    }
    return null;
  }
  if (typeof command !== 'string' || !command) return null;
  return command.includes('wait') && command.includes('--drained');
}
