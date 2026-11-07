#!/usr/bin/env node
// Separate Store processes racing for the last shared worker lane must admit exactly one claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { parseWorkers } from '../src/workers.mjs';

const workers = parseWorkers({ workers: { dot: {}, lark: {} } }, { builtin: true });
if (process.argv[2] === '--contender') {
  const [, , , file, request, subject] = process.argv;
  const store = new Store(file, { workers });
  process.once('message', () => {
    try { store.claim(request, subject, subject, 1, null, 'dot'); process.send({ ok: true }); }
    catch (error) { process.send({ ok: false, error: error.message }); }
    finally { store.db.close(); process.disconnect(); }
  });
  process.send({ ready: true });
} else {
  const temp = new URL('../.test-home/', import.meta.url);
  fs.mkdirSync(temp, { recursive: true });
  const home = fs.mkdtempSync(path.join(temp.pathname, 'claim-race-'));
  const file = path.join(home, 'bridge.db'), store = new Store(file, { workers });
  const children = [];
  const submit = (id, worker = 'dot') => {
    const payload = { schema_version: 1, request_id: id, brief: 'claim race', inputs: [], expected_output: 'report', execution_scope: 'read-only' };
    store.submit(payload, { mode: 'none' }, null, 'owner', false, null, 'normal', null, payload, null, worker);
  };
  try {
    submit('race-a'); submit('race-b'); submit('other-worker', 'lark');
    for (const [request, subject] of [['race-a', 'subject-a'], ['race-b', 'subject-b']]) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--contender', file, request, subject], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      child.stderr.resume();
      const ready = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(10000) }), once(child, 'exit').then(() => { throw new Error('contender exited before ready'); })]);
      assert.equal(ready[0].ready, true);
    }
    const results = children.map(child => Promise.all([once(child, 'message', { signal: AbortSignal.timeout(10000) }), once(child, 'exit', { signal: AbortSignal.timeout(10000) })]));
    for (const child of children) child.send('claim');
    const outcomes = (await Promise.all(results)).map(([message, exit]) => { assert.equal(exit[0], 0); return message[0]; });
    assert.equal(outcomes.filter(result => result.ok).length, 1, 'only one process may acquire the last worker lane');
    assert.deepEqual(outcomes.filter(result => !result.ok).map(result => result.error), ['capacity_full']);
    assert.equal(store.activeClaims('unrelated-subject', 'dot').length, 1, 'worker lanes count across subjects and DB handles');
    assert.equal(store.db.prepare("SELECT count(*) n FROM lifecycle_events WHERE type='claimed'").get().n, 1, 'loser committed no claim event');
    assert.equal(store.db.prepare("SELECT count(*) n FROM assignments WHERE status='queued' AND target_worker='dot'").get().n, 1);
    assert.equal(store.claim('other-worker', 'lark', 'subject-a', 1, null, 'lark').duplicate, false, 'another worker still has its own lane');
    console.log('PASS concurrent claim processes admit one shared-worker lane; loser leaves no claim event or assignment change');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    store.db.close(); fs.rmSync(home, { recursive: true, force: true });
  }
}
