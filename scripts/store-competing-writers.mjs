// Independent SQLite connections in worker threads. Start together, or hold the first write lock before starting rivals.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';

export async function competingWrites(file, operations, { firstHoldsLock = false, busyTimeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw new Error('invalid test writer busy timeout');
  const workers = [], results = [];
  try {
    for (const operation of operations) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { file, operation, busyTimeoutMs } });
      workers.push(worker);
      await once(worker, 'message'); // each connection is ready before the start barrier
      results.push(new Promise((resolve, reject) => {
        worker.on('message', m => { if (m.result !== undefined || m.error) resolve(m); });
        worker.once('error', reject);
        worker.once('exit', code => { if (code) reject(new Error(`store worker exited ${code}`)); });
      }));
    }
    if (firstHoldsLock) {
      const locked = once(workers[0], 'message');
      workers[0].postMessage('go');
      const [message] = await locked;
      if (!message.locked) throw new Error('first writer did not hold the transaction');
      for (const w of workers.slice(1)) w.postMessage('go');
    } else for (const w of workers) w.postMessage('go');
    return await Promise.all(results);
  } finally { await Promise.all(workers.map(w => w.terminate())); }
}

if (!isMainThread) {
  const store = new Store(workerData.file), op = workerData.operation;
  store.db.exec(`PRAGMA busy_timeout=${workerData.busyTimeoutMs}`);
  if (op.holdMs) {
    const transaction = store.transaction.bind(store);
    store.transaction = fn => transaction(() => {
      const result = fn();
      parentPort.postMessage({ locked: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, op.holdMs);
      return result;
    });
  }
  parentPort.postMessage({ ready: true });
  await once(parentPort, 'message');
  try { parentPort.postMessage({ result: store[op.method](...op.args) }); }
  catch (e) { parentPort.postMessage({ error: e.message }); }
  finally { store.db.close(); parentPort.close(); }
}
