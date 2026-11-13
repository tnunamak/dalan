// The one default bridge home. `dalan service install` records it in a small pointer file; every other command reads it, so nobody
// exports DALAN_HOME. DALAN_HOME still wins when it is set. The pointer lives in the real user's config directory, never in the home it names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './as-files.mjs';

export const DEFAULT_SERVICE_HOME = '.local/share/dalan-service';
export const homePointerPath = (env = process.env) => path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(env.HOME || os.homedir(), '.config'), 'dalan', 'home');

// The recorded home, or null when none is recorded or the record is not a usable bridge home (absolute, a real directory with a Dalan config).
export function readDefaultHome(env = process.env) {
  let text;
  try { text = fs.readFileSync(homePointerPath(env), 'utf8'); } catch { return null; }
  const home = text.trim();
  if (!home || home.includes('\n') || !path.isAbsolute(home) || path.resolve(home) !== home) return null;
  try { if (!fs.statSync(path.join(home, '.config')).isDirectory()) return null; } catch { return null; }
  return home;
}

export function recordDefaultHome(home, env = process.env) {
  if (!path.isAbsolute(home)) throw new Error('the default home must be an absolute path');
  const file = homePointerPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, `${path.resolve(home)}\n`);
  fs.chmodSync(file, 0o600);
  return file;
}

export function forgetDefaultHome(home, env = process.env) {
  const file = homePointerPath(env);
  try { if (fs.readFileSync(file, 'utf8').trim() === path.resolve(home)) fs.rmSync(file); } catch { /* nothing recorded */ }
}

// DALAN_HOME, then the recorded home, then the service default. `service` commands use this for --home.
export const serviceHomeFor = (env = process.env) => path.resolve(env.DALAN_HOME || readDefaultHome(env) || path.join(env.HOME || os.homedir(), DEFAULT_SERVICE_HOME));
