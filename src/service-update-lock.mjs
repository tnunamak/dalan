import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Keep the inode: deleting a lock file would let a new caller lock a different file.
// SQLite's exclusive lock is released by the kernel even if the updater is killed.
export function acquireUpdateLock(home) {
  return acquirePrivateLock(path.join(home, 'update-lock.sqlite'), 'another service update is already running');
}

export function acquirePrivateLock(file, busyMessage) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  fs.closeSync(fd);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error('service lock must be a private regular file');
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch (error) { db.close(); if (error.errcode === 5 || error.errcode === 6) throw new Error(busyMessage); throw error; }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try { db.exec('ROLLBACK'); } finally { db.close(); }
  };
}
