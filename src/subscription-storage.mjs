import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Serializes first-open migration and cleanup across Store processes, not normal Store operations.
export function acquireSubscriptionStorage(file) {
  if (file === ':memory:') return { key: randomBytes(32), release() {} };
  const dir = `${fs.realpathSync(file)}.secrets`;
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Persist the directory entry before any encrypted database transaction.
  const parentFd = fs.openSync(path.dirname(dir), 'r'); try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('subscription storage directory is invalid');
  const lockFile = path.join(dir, 'owner.sqlite');
  try { fs.closeSync(fs.openSync(lockFile, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const lockStat = fs.lstatSync(lockFile);
  if (!lockStat.isFile() || (lockStat.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && lockStat.uid !== process.getuid())) throw new Error('subscription storage lock is invalid');
  const lock = new DatabaseSync(lockFile);
  try { lock.exec('PRAGMA busy_timeout=30000; BEGIN EXCLUSIVE'); } catch (error) { lock.close(); throw error; }
  return {
    loadKey(required) {
      const keyFile = path.join(dir, 'storage.key');
      if (!fs.existsSync(keyFile)) {
        if (required) throw new Error('subscription storage key is missing');
        const temp = path.join(dir, `.storage-key-${randomBytes(16).toString('hex')}.tmp`);
        try {
          const fd = fs.openSync(temp, 'wx', 0o600);
          try { fs.writeFileSync(fd, randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          try { fs.linkSync(temp, keyFile); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { fs.rmSync(temp, { force: true }); }
      }
      const keyStat = fs.lstatSync(keyFile);
      if (!keyStat.isFile() || (keyStat.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && keyStat.uid !== process.getuid())) throw new Error('subscription storage key is invalid');
      const key = fs.readFileSync(keyFile);
      if (key.length !== 32) throw new Error('subscription storage key is invalid');
      // Also sync a recovered key's directory before committing encrypted rows.
      const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return key;
    },
    release() { lock.close(); },
  };
}

export class SubscriptionCodec {
  constructor(key) { this.key = key; }
  seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }
  open(value, context) {
    try {
      const [version, nonce, tag, data, extra] = value.split('.');
      if (version !== 'v1' || extra !== undefined || !nonce || !tag || data === undefined) throw new Error();
      const iv = Buffer.from(nonce, 'base64url'), auth = Buffer.from(tag, 'base64url');
      if (iv.length !== 12 || auth.length !== 16) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
      cipher.setAuthTag(auth); cipher.setAAD(Buffer.from(context));
      return Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8');
    } catch { throw new Error('subscription storage is damaged or its key is invalid'); }
  }
}
