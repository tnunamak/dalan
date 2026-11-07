// Reattach capability: HMAC-SHA256(secret, id). The secret is created once (mode 0600, published atomically). The token is
// derived, not stored, so it is the same after an adapter restart.
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Read the secret, create it on first use. A file that is not exactly 0600 or is too short is an error, never replaced.
export function readOrCreateSecret(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const read = () => {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) throw Object.assign(new Error(`${file} must be mode 0600 (found ${mode.toString(8)})`), { code: 'state_permissions' });
    const secret = fs.readFileSync(file, 'utf8').trim();
    if (secret.length < 32) throw new Error(`${file} is too short`);
    return secret;
  };
  try { return read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // link() fails with EEXIST when another creator won: the file appears complete or not at all, and the first one is kept.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  try { fs.linkSync(tmp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { fs.rmSync(tmp, { force: true }); }
  return read();
}

export const ownerToken = (secret, id) => createHmac('sha256', secret).update(id).digest('hex');
