// Atomic private JSON files. Directories are 0700, files 0600, a file with any other mode is refused, and a session id
// is validated before a path is built from it.
import fs from 'node:fs';
import path from 'node:path';

// A version-4 UUID: the form randomUUID() produces.
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw Object.assign(new Error('invalid session id'), { code: 'invalid_session_id' });
  return id;
}

export function assertPrivate(file) {
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o600) throw Object.assign(new Error(`${file} must be mode 0600 (found ${mode.toString(8)})`), { code: 'state_permissions' });
}

// `<dir>/<id><suffix>` for a validated id.
export const sessionPath = (dir, id, suffix = '.json') => path.join(dir, `${assertSessionId(id)}${suffix}`);

// Write temp file then rename: a crash leaves the previous record, never a partial one.
export function writeJsonPrivate(file, value, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// null when the file does not exist; throws state_permissions when it is not exactly 0600.
export function readJsonPrivate(file) {
  try { assertPrivate(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const removePrivate = file => fs.rmSync(file, { force: true });
