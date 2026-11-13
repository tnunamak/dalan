// The `dalan` on PATH is whichever package npm installed first. After the updater installs newer versions side by side under the service home,
// the CLI must run the version the service runs, or the two drift. This runs the service's `current` package instead of this one.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readDefaultHome } from './default-home.mjs';

const real = file => { try { return fs.realpathSync(file); } catch { return null; } };

// The entry script to hand over to, or null to stay in this package. `ownBin` is this package's bin/dalan.mjs.
export function followTarget({ ownBin, env = process.env }) {
  if (env.DALAN_NO_FOLLOW === '1' || env.DALAN_FOLLOWED === '1') return null;
  const home = env.DALAN_HOME ? path.resolve(env.DALAN_HOME) : readDefaultHome(env);
  if (!home) return null;
  const target = real(path.join(home, 'current', 'bin', 'dalan.mjs')), own = real(ownBin);
  return target && own && target !== own ? target : null;
}

// Runs the other package with the same arguments and exits with its status. Never returns.
export function handOver(target, { argv = process.argv.slice(2), env = process.env } = {}) {
  const child = spawn(process.execPath, [target, ...argv], { stdio: 'inherit', env: { ...env, DALAN_FOLLOWED: '1' } });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { process.stderr.write(`dalan: could not run the service's current version (${error.message}); set DALAN_NO_FOLLOW=1 to use this copy\n`); process.exit(1); });
  child.on('exit', (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exit(code ?? 1); });
}
