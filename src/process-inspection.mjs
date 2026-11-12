import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// Inspection failure is not evidence of exit. Read Linux start ticks on both sides of ps so command and identity belong
// to the same process. macOS supplies its start timestamp and command in one ps snapshot, with a fixed locale and timezone.
export const processCommand = (pid, { platform = process.platform, run = spawnSync, readFile = fs.readFileSync, probe = pid => process.kill(pid, 0) } = {}) => {
  const unknown = { state: 'unknown' }, absent = { state: 'absent' };
  if (!Number.isInteger(pid) || pid <= 0) return unknown;
  const startTicks = () => {
    const stat = readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('invalid process start time');
    return fields[19];
  };
  try {
    const before = platform === 'linux' ? startTicks() : null;
    if (!['linux', 'darwin'].includes(platform)) return unknown;
    const out = run('ps', ['-p', String(pid), '-o', platform === 'darwin' ? 'lstart=,command=' : 'command='], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    if (out.error || out.status !== 0 || !out.stdout?.trim()) {
      // Even ps exit 1 can be an inspection failure; only ESRCH confirms absence.
      try { probe(pid); } catch (error) { if (error.code === 'ESRCH') return absent; }
      return unknown;
    }
    if (platform === 'linux') {
      const after = startTicks();
      return before === after ? { state: 'present', command: out.stdout.trim(), start: before } : unknown;
    }
    const match = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(out.stdout.trim());
    return match ? { state: 'present', command: match[2], start: match[1].replace(/\s+/g, ' ') } : unknown;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) {
      try { probe(pid); } catch (probeError) { if (probeError.code === 'ESRCH') return absent; }
    }
    return unknown;
  }
};
