// Test-harness preload for the server process under test (node --import). It adds NO product seam:
//  1. A trusted, frozen test clock. Date.now()/new Date() return BASE + <offset in the clock file>.
//     Only the harness writes the file; the server cannot move it. Real timers (setTimeout) are untouched.
//  2. A manual scheduler. The server's 500 ms `maintain` interval (lease sweep, expiry sweeps) and `drain` interval
//     (notification delivery) are captured instead of scheduled. The harness runs both, in that order, with SIGUSR2
//     and reads an ack counter file, so "advance" never expires anything implicitly and "expire" is a separate,
//     explicit scheduler tick.
import fs from 'node:fs';

const clockFile = process.env.CONFORMANCE_CLOCK_FILE;
const ackFile = process.env.CONFORMANCE_TICK_ACK_FILE;
const base = Number(process.env.CONFORMANCE_BASE_MS);
if (!clockFile || !ackFile || !Number.isSafeInteger(base)) throw new Error('clock-preload: CONFORMANCE_* env missing');

const RealDate = Date;
const fakeNow = () => base + Number(fs.readFileSync(clockFile, 'utf8').trim() || 0);
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(fakeNow()); else super(...args); }
  static now() { return fakeNow(); }
}
globalThis.Date = FakeDate;

const realSetInterval = globalThis.setInterval;
const drains = [];
globalThis.setInterval = function patchedSetInterval(fn, ms, ...rest) {
  if (ms === 500 && ['maintain', 'runDrain'].includes(fn?.name)) { drains.push(fn); return { unref() { return this; }, ref() { return this; } }; }
  return realSetInterval(fn, ms, ...rest);
};
let acked = 0;
process.on('SIGUSR2', async () => {
  try { for (const fn of drains) await fn(); }
  finally { acked += 1; fs.writeFileSync(ackFile, String(acked)); }
});
