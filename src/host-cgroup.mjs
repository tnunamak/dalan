import fs from 'node:fs';
import path from 'node:path';

// cgroup.procs lists direct membership only. Walk child cgroups so the stop
// receipt covers the whole systemd unit, including nested scopes.
export function readCgroupProcesses(root, selfPid = process.pid) {
  const processes = new Set();
  const visit = directory => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const line of fs.readFileSync(path.join(directory, 'cgroup.procs'), 'utf8').split('\n')) {
      if (line === '') continue;
      // Fail closed: a line that is not a positive integer is unreadable evidence, not an absent process.
      const pid = /^[1-9][0-9]*$/.test(line) ? Number(line) : NaN;
      if (!Number.isSafeInteger(pid)) throw new Error('unreadable cgroup.procs entry');
      if (pid !== selfPid) processes.add(pid);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  return [...processes].sort((a, b) => a - b);
}
