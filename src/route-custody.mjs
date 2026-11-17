import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './as-files.mjs';

function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('Private route custody is unavailable.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('Private route custody is unavailable.');
}

// The per-user filesystem boundary protects the key. Only authenticated ciphertext and opaque IDs are stored.
export function routeSecretBackend(dir) {
  const refPath = (scopeId, handle) => path.join(dir, createHash('sha256').update(JSON.stringify([scopeId, handle])).digest('hex'));
  const keyFile = path.join(dir, 'key');
  const key = (create = false) => {
    if (create && !fs.existsSync(keyFile)) {
      const staged = path.join(dir, randomUUID());
      const bytes = randomBytes(32);
      try {
        writeAtomic(staged, bytes);
        try { fs.linkSync(staged, keyFile); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { bytes.fill(0); fs.rmSync(staged, { force: true }); }
    }
    return readPrivate(keyFile);
  };
  const decode = (scopeId, handle) => {
    privateDirectory(dir);
    const file = refPath(scopeId, handle);
    const ciphertext = readPrivate(file);
    const material = key();
    try {
      const decipher = createDecipheriv('aes-256-gcm', material, ciphertext.subarray(0, 12));
      decipher.setAAD(Buffer.from(path.basename(file)));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      const partial = decipher.update(ciphertext.subarray(28));
      try { return Buffer.concat([partial, decipher.final()]); } finally { partial.fill(0); }
    } finally { material.fill(0); }
  };
  return {
    async put({ scopeId, bytes }) {
      privateDirectory(dir);
      const handle = randomUUID(), target = refPath(scopeId, handle);
      const nonce = randomBytes(12), material = key(true);
      try {
        const cipher = createCipheriv('aes-256-gcm', material, nonce);
        cipher.setAAD(Buffer.from(path.basename(target)));
        const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
        writeAtomic(target, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
        return { handle };
      } finally { material.fill(0); }
    },
    async withSecret({ scopeId, handle }, use) {
      let bytes;
      try { bytes = decode(scopeId, handle); }
      catch { throw new Error('Private route credential is unavailable.'); }
      try { return await use(bytes); } finally { bytes.fill(0); }
    },
    async presence({ scopeId, handle }) {
      try { decode(scopeId, handle).fill(0); return { known: true, value: true }; }
      catch (error) {
        if (error.code === 'ENOENT' && error.path === refPath(scopeId, handle)) return { known: true, value: false };
        return { known: false, reason: 'custody-unavailable' };
      }
    },
    async delete({ scopeId, handle }) {
      privateDirectory(dir);
      try { fs.unlinkSync(refPath(scopeId, handle)); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Private route credential removal is unconfirmed.'); }
      const fd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { deleted: true };
    },
  };
}

export function routeCustodyPath(env, gozarHome) {
  const root = env.XDG_CONFIG_HOME || path.join(env.HOME, '.config');
  const scope = createHash('sha256').update(gozarHome).digest('hex').slice(0, 24);
  return path.join(root, 'dalan', 'route-custody', scope);
}
