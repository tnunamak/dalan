#!/usr/bin/env node
// The loopback probe turns a stalled bridge into a logged number: slow or failed answers, timer lag, and the status snapshot.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLoopbackProbe } from '../src/loopback-probe.mjs';

const pass = message => console.log(`PASS ${message}`);
const listen = handler => new Promise(resolve => { const server = http.createServer(handler); server.listen(0, '127.0.0.1', () => resolve(server)); });

// Fake clock and requests: exact numbers, no sleeping.
{
  let t = 0; const logs = [];
  const answers = [{ status: 404 }, { status: 404 }, { error: 'timeout' }, { status: 404 }];
  const delays = [5, 7, 30000, 1500];
  const probe = createLoopbackProbe({
    url: 'http://127.0.0.1:1/', log: entry => logs.push(entry), intervalMs: 1000, slowMs: 1000, heartbeatEvery: 2,
    clock: () => t, wall: () => 'T', request: async () => { const i = probe.snapshot().samples; t += delays[i]; return answers[i]; },
  });
  for (let i = 0; i < 4; i++) { await probe.tick(); t += 1000; }
  assert.deepEqual(logs.map(l => l.kind), ['loopback_probe', 'loopback_probe_slow', 'loopback_probe_slow'], 'a heartbeat on the second sample, then each slow or failed answer');
  assert.equal(logs[0].max_ms, 7); assert.equal(logs[1].error, 'timeout'); assert.equal(logs[1].ms, 30000);
  assert.equal(logs[2].ms, 1500); assert.equal(logs[2].status, 404);
  const snap = probe.snapshot();
  assert.equal(snap.samples, 4); assert.equal(snap.worst_ms, 30000); assert.equal(snap.failures, 1); assert.equal(snap.last.ms, 1500);
  pass('slow and failed answers are logged with their milliseconds; a heartbeat summarizes normal ones; the snapshot reports worst and failures');
}

// A late timer is a stall even when the answer is fast.
{
  let t = 0; const logs = [];
  const probe = createLoopbackProbe({ url: 'x', log: entry => logs.push(entry), intervalMs: 1000, slowMs: 1000, clock: () => t, request: async () => ({ status: 200 }) });
  await probe.tick();           // expectedAt becomes 1000
  t = 6000;                     // the event loop was blocked for 5 s
  await probe.tick();
  assert.equal(logs.length, 1); assert.equal(logs[0].kind, 'loopback_probe_slow'); assert.equal(logs[0].lag_ms, 5000);
  assert.equal(probe.snapshot().worst_lag_ms, 5000);
  pass('a timer that fires 5 s late is logged as lag');
}

// The real thing: an HTTP listener that answers slowly, one that is gone, and one that answers at once.
{
  const logs = [];
  const slow = await listen((req, res) => setTimeout(() => { res.writeHead(404); res.end(); }, 300));
  const url = `http://127.0.0.1:${slow.address().port}/`;
  const probe = createLoopbackProbe({ url, log: entry => logs.push(entry), slowMs: 200 });
  await probe.tick();
  assert.equal(logs.length, 1); assert.equal(logs[0].kind, 'loopback_probe_slow'); assert(logs[0].ms >= 290, `ms ${logs[0].ms}`); assert.equal(logs[0].status, 404);
  slow.close();
  await probe.tick();
  assert.equal(logs.at(-1).kind, 'loopback_probe_slow'); assert.match(logs.at(-1).error, /ECONNREFUSED|ECONNRESET/);
  const fast = await listen((req, res) => { res.writeHead(421); res.end(); });
  const quiet = [], ok = createLoopbackProbe({ url: `http://127.0.0.1:${fast.address().port}/`, log: entry => quiet.push(entry), slowMs: 200 });
  await ok.tick();
  assert.equal(quiet.length, 0, 'a fast answer, whatever its status, is not logged'); assert.equal(ok.snapshot().last.status, 421);
  fast.close();
  const hung = await listen(() => {});
  const timed = createLoopbackProbe({ url: `http://127.0.0.1:${hung.address().port}/`, log: entry => logs.push(entry), timeoutMs: 150 });
  await timed.tick();
  assert.equal(logs.at(-1).error, 'timeout'); assert(logs.at(-1).ms >= 140);
  hung.closeAllConnections(); hung.close();
  pass('against real listeners: a slow answer, a refused connection, a hung request (timeout) and a fast answer');
}

// start() and stop() own one unref'd timer.
{
  const probe = createLoopbackProbe({ url: 'x', log() {}, intervalMs: 20, request: async () => ({ status: 200 }) });
  probe.start(); probe.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  probe.stop();
  const n = probe.snapshot().samples; assert(n >= 2 && n <= 6, `samples ${n}`);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(probe.snapshot().samples, n, 'stop() ends the timer');
  pass('start() is idempotent and stop() ends the timer');
}
