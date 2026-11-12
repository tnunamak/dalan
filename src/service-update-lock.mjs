import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Keep the inode: deleting a lock file would let a new caller lock a different file.
// SQLite's exclusive lock is released by the kernel even if the updater is killed.
export function acquireUpdateLock(home) {
  const file = path.join(home, 'update-lock.sqlite');
  const fd = fs.openSync(file, 'a', 0o600);
  fs.closeSync(fd);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error('service update lock must be a private regular file');
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch (error) { db.close(); if (error.errcode === 5 || error.errcode === 6) throw new Error('another service update is already running'); throw error; }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try { db.exec('ROLLBACK'); } finally { db.close(); }
  };
}
