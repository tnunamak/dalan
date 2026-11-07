// How to tell the user to run this CLI again: `dalan` when that name on PATH is this same file (a normal npm install),
// `npx dalan` under npx or `npm exec` (npm sets npm_command=exec): that PATH entry is npx's temporary bin, which the
// user's shell does not have. Otherwise node and the absolute path, so a checkout works without being on PATH.
import fs from 'node:fs';
import path from 'node:path';

const defaultBin = path.resolve(import.meta.dirname, '..', 'bin/dalan.mjs');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function cliCommand(argv1, env = process.env) {
  const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
  const self = real(path.resolve(argv1 ?? defaultBin));
  const onPath = self && (env.PATH ?? '').split(path.delimiter).some(dir => dir && real(path.join(dir, 'dalan')) === self);
  if (onPath) return env.npm_command === 'exec' ? 'npx dalan' : 'dalan';
  return `node ${shellQuote(self ?? path.resolve(argv1 ?? defaultBin))}`;
}
