// How to tell the user to run this CLI again: `dalan` when that name on PATH is this same file (a normal npm install),
// `npx @tnunamak/dalan` under npx or `npm exec` (npm sets npm_command=exec): that PATH entry is npx's temporary bin, which the
// user's shell does not have. Otherwise node and the absolute path, so a checkout works without being on PATH.
import fs from 'node:fs';
import path from 'node:path';

const defaultBin = path.resolve(import.meta.dirname, '..', 'bin/dalan.mjs');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function cliCommand(argv1, env = process.env) {
  const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
  const self = real(path.resolve(argv1 ?? defaultBin));
  let firstOnPath = null;
  for (const dir of env.PATH == null ? [] : env.PATH.split(path.delimiter)) {
    const candidate = path.join(dir || '.', 'dalan');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    firstOnPath = real(candidate);
    if (firstOnPath !== null) break;
  }
  const onPath = self && firstOnPath === self;
  if (onPath) return env.npm_command === 'exec' ? 'npx @tnunamak/dalan' : 'dalan';
  return `node ${shellQuote(self ?? path.resolve(argv1 ?? defaultBin))}`;
}
