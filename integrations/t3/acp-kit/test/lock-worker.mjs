// Child process for lock.test.mjs: argv = lockFile logFile startAtMs holdMs. Exit 0 = held the lock, 3 = busy.
import fs from 'node:fs';
import { acquireLock, LockBusyError } from '../src/lock.mjs';
const [file, log, startAt, holdMs] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* spin to a common start */ }
try {
  const lock = await acquireLock(file);
  fs.appendFileSync(log, `enter ${process.pid}\n`);
  await new Promise(r => setTimeout(r, Number(holdMs)));
  fs.appendFileSync(log, `leave ${process.pid}\n`);
  lock.release();
  process.exit(0);
} catch (e) { process.exit(e instanceof LockBusyError ? 3 : 4); }
