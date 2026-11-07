// Test-only preload: stop every fork immediately before SQLite opens the ownership database.
// One gate-file creation releases all armed children, rather than serial IPC messages releasing them one by one.
import fs from 'node:fs';
import path from 'node:path';

const gate = process.env.AS_START_GATE;
if (gate) {
  const stat = fs.lstatSync;
  let armed = false;
  fs.lstatSync = function (file, ...args) {
    const value = stat.call(this, file, ...args);
    if (!armed && path.basename(String(file)) === 'as-owner.sqlite') {
      armed = true;
      process.send({ asStartReady: true });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(gate)) {
        if (Date.now() >= deadline) throw new Error('AS start barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
      const startAt = BigInt(fs.readFileSync(gate, 'utf8'));
      while (process.hrtime.bigint() < startAt) {
        if (startAt - process.hrtime.bigint() > 2000000n) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
    }
    return value;
  };
}

export const barrierPreload = new URL('./as-start-barrier.mjs', import.meta.url).href;
export function armStartBarrier(child) {
  child.asStartReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AS child never reached start barrier')), 15000);
    child.on('message', message => { if (message.asStartReady) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('AS child exited before release')); });
  });
  return child;
}
export async function releaseStartBarrier(children, file) {
  await Promise.all(children.map(child => child.asStartReady));
  fs.writeFileSync(file, String(process.hrtime.bigint() + 50000000n));
}
