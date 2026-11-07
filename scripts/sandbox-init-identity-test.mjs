#!/usr/bin/env node
// A reported init PID must name a live direct child born no earlier than its launcher.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { initIdentity, processStart, classify } from '../src/sandbox-supervisor.mjs';

if (process.platform !== 'linux') {
  console.log('SKIP init identity: Linux /proc is required');
  process.exit(77);
}

const child = spawn(process.execPath, ['-e', 'process.title="init (fixture)";process.send("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const exited = once(child, 'exit');
try {
  await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(10000) }), exited.then(() => { throw new Error('fixture exited before ready'); })]);
  const start = processStart(child.pid);
  assert.ok(Number.isInteger(start), 'real /proc stat parsed despite parentheses in comm');
  const valid = initIdentity(child.pid, process.pid, start);
  assert.deepEqual(valid, { pid: child.pid, start }, 'control: live direct child is a valid init identity');
  assert.equal(initIdentity(child.pid, child.pid, start), null, 'a live but unrelated PID cannot become the recorded init');
  assert.equal(initIdentity(child.pid, process.pid, start + 1), null, 'a process born before the launcher cannot become its init');
  assert.equal(initIdentity(String(child.pid), process.pid, start), null, 'only integer PID reports are accepted');
  assert.equal(classify(child.pid, { init: valid }).reason, 'namespace_init_alive', 'valid identity provides the namespace-link backstop');
  child.kill('SIGKILL'); await exited;
  assert.equal(initIdentity(child.pid, process.pid, start), null, 'an exited init cannot be recorded as alive');
  console.log('PASS real init identity binds PID to direct parent, birth time and liveness before enabling the stop-verification backstop');
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
