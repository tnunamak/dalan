#!/usr/bin/env node
// Regression coverage for two test-runner races: reusing a closed ephemeral port and killing
// a child process after it has already exited.
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { reservedPort, ephemeralRange } from '../src/test-support/port.mjs';
import { killIfAlive } from '../src/test-support/process.mjs';

const [low, high] = ephemeralRange();
const listenZero = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const old = await listenZero();
assert.ok(old >= low && old <= high, `listen(0) port ${old} outside ${low}-${high}`);
// The kernel may hand a closed ephemeral port to the next listen(0); a later bind of it then fails.
const holders = [];
let reused = false;
for (let i = 0; i < 2000 && !reused; i++) {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); holders.push(s);
  if (s.address().port === old) reused = true;
}
if (reused) {
  const late = net.createServer(); late.listen(old, '127.0.0.1');
  const [error] = await once(late, 'error'); assert.equal(error.code, 'EADDRINUSE');
}
for (const s of holders) s.close();
console.log(`PASS listen(0) gives ephemeral ports (${old} in ${low}-${high})${reused ? '; the kernel reassigned it and a late bind failed EADDRINUSE' : ''}`);

for (let i = 0; i < 20; i++) {
  const port = await reservedPort();
  assert.ok(port < low && port < 32768, `reservedPort ${port} is inside the ephemeral range`);
  const s = net.createServer(); s.listen(port, '127.0.0.1'); await once(s, 'listening'); s.close();
}
console.log('PASS reservedPort returns bindable ports below the ephemeral range');

const child = spawn(process.execPath, ['-e', '']); await once(child, 'exit');
assert.throws(() => process.kill(child.pid, 'SIGKILL'), { code: 'ESRCH' }, 'a raw kill of an exited pid should throw ESRCH');
assert.equal(killIfAlive(child.pid, 'SIGKILL'), false);
console.log('PASS killing an exited pid throws ESRCH; killIfAlive treats it as already gone');
