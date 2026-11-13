// The owner's saved public-route choice, written by `dalan setup`. One small file in the user's config directory, outside every
// trial home, so a deleted trial never loses it and a trial never writes it.
//
// Version 2 stores only what Dalan owns: the requirements it asked for, the Gozar state home, the Gozar route id (an opaque
// string that Dalan never interprets), the durable route id, the pinned origin and the bridge home. Everything about how a route is
// provided belongs to Gozar. A file of any other version fails closed: it is reported, never guessed at or rewritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const SETTING_VERSION = 2;
const KEYS = ['version', 'requirements', 'gozarHome', 'routeName', 'routeId', 'origin', 'bridgeHome'];
export const routeSettingPath = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'dalan', 'route.json');
export const migrationJournalPath = (env = process.env) => path.join(path.dirname(routeSettingPath(env)), 'route-migration.json');

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = value => value === null || (typeof value === 'string' && value.length > 0);

// Throws a message when a setting is not exactly the version-2 shape.
export function validateSetting(value) {
  if (!isRecord(value)) throw new Error('the saved route setting is not an object');
  if (value.version !== SETTING_VERSION) throw new Error(`the saved route setting has version ${JSON.stringify(value.version)}; this Dalan reads version ${SETTING_VERSION}`);
  const extra = Object.keys(value).filter(key => !KEYS.includes(key));
  if (extra.length) throw new Error(`the saved route setting has unknown fields (${extra.join(', ')})`);
  if (!isRecord(value.requirements)) throw new Error('the saved route setting has no requirements');
  for (const key of ['gozarHome']) if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) throw new Error(`the saved route setting needs an absolute ${key}`);
  for (const key of ['routeName', 'routeId', 'origin', 'bridgeHome']) if (!nullableString(value[key])) throw new Error(`the saved route setting has an invalid ${key}`);
  if (value.origin !== null) {
    let url; try { url = new URL(value.origin); } catch { /* checked below */ }
    if (!url || url.protocol !== 'https:' || url.origin !== value.origin) throw new Error('the saved route setting origin is not an https origin');
  }
  return value;
}

// What the file holds: { state: 'none' } (no file), { state: 'current', setting } (version 2) or { state: 'legacy' | 'unreadable' }.
// A legacy file is any file that is not version 2 (the 0.6 shape had no version). It is never edited in place.
export function inspectRouteSetting(env = process.env) {
  let text;
  try { text = fs.readFileSync(routeSettingPath(env), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { state: 'none' }; return { state: 'unreadable', reason: error.code ?? error.message }; }
  let value;
  try { value = JSON.parse(text); } catch { return { state: 'unreadable', reason: 'not JSON' }; }
  if (isRecord(value) && !('version' in value)) return { state: 'legacy', value };
  try { return { state: 'current', setting: validateSetting(value) }; } catch (error) { return { state: 'unreadable', reason: error.message }; }
}

export function readRouteSetting(env = process.env) {
  const found = inspectRouteSetting(env);
  return found.state === 'current' ? found.setting : null;
}

function writePrivateAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const dirFd = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

export function writeRouteSetting(setting, env = process.env) {
  validateSetting(setting);
  const file = routeSettingPath(env);
  writePrivateAtomic(file, `${JSON.stringify(Object.fromEntries(KEYS.map(key => [key, setting[key]])))}\n`);
  return file;
}

// ---- the migration journal ---------------------------------------------------------------------------------------------------------
// One fsynced record per step of a move from a 0.6 route: prepared, old-owner-fenced, gozar-adopted, dalan-committed. `transfer` is
// Gozar's opaque hand-back data, written before the old owner takes over again.
export const JOURNAL_PHASES = ['prepared', 'old-owner-fenced', 'gozar-adopted', 'dalan-committed'];
export function writeJournal(journal, env = process.env) {
  if (!JOURNAL_PHASES.includes(journal.phase)) throw new Error(`unknown migration phase ${journal.phase}`);
  writePrivateAtomic(migrationJournalPath(env), `${JSON.stringify({ version: 1, ...journal })}\n`);
}
export function readJournal(env = process.env) {
  let value;
  try { value = JSON.parse(fs.readFileSync(migrationJournalPath(env), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`the route migration journal is unreadable (${error.code ?? 'not JSON'}); leaving the old route untouched`); }
  if (!isRecord(value) || value.version !== 1 || !JOURNAL_PHASES.includes(value.phase)) throw new Error('the route migration journal has an unknown version or phase; leaving the old route untouched');
  return value;
}
export function removeJournal(env = process.env) { fs.rmSync(migrationJournalPath(env), { force: true }); }
