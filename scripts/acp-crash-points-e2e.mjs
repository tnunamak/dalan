#!/usr/bin/env node
// P1b: kill the real facade at externally gated boundaries; resume its durable identity.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, waitFor } from './acp-probe-fixture.mjs';
import { CONTINUE_PROMPT } from '../src/acp-bridge.mjs';
for (const point of ['after-submit', 'claimed-hold', 'result-before-delivery', 'session-load-mid-hold']) {
  await fixture(async f => {
    const rid = `probe_${point.replaceAll('-', '_')}`, result = `RESULT ${rid}`;
    let gateReached = false;
    f.hook(async ({ url, body }) => {
      if (point === 'after-submit' && url.pathname === '/submit') {
        f.rows.set(rid, { request_id: rid, assignment: body.assignment, status: 'queued' });
        gateReached = true; return true; // Commit submit, withhold acknowledgement and work-id message.
      }
      return false;
    });
    // Stop synchronously after the real atomic terminal receipt write, before
    // the event loop can send the result. Production source stays unmodified.
    const preload = join(f.home, 'crash-after-receipt.mjs');
    await writeFile(preload, `import fs from 'node:fs';
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const result = rename.call(this, from, to);
  if (String(to).startsWith(process.env.DOT_ACP_STATE_DIR) && String(to).endsWith('.json')) {
    const saved = JSON.parse(fs.readFileSync(to, 'utf8'));
    if (saved.pending?.terminal) process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
`);
    const a = await f.adapter(point === 'result-before-delivery' ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}), sid = (await a.newSession(f.cwd)).sessionId;
    let oldSettled = false;
    const old = a.prompt(sid, `[dot-decision:${rid}]\nCrash probe ${point}`).then(r => { oldSettled = true; return r; });
    await waitFor(() => f.rows.has(rid), 'one submitted job');
    if (point === 'after-submit') {
      await waitFor(() => gateReached, 'submit acknowledgement withheld');
      assert.equal(a.rawText('agent_message_chunk'), '', 'crash precedes work-id message');
    } else {
      f.rows.get(rid).status = 'claimed';
      await waitFor(() => a.rawText('agent_thought_chunk').includes('worker claimed'), 'claimed held turn');
      if (point === 'result-before-delivery') {
        f.finish(rid, result);
        await waitFor(() => a.child.signalCode === 'SIGKILL', 'crash after terminal receipt');
        await a.exited;
        assert.equal((await f.state(sid)).pending.terminal.text.includes(result), true, 'result durably recorded before crash');
      }
      if (point !== 'result-before-delivery') assert.equal(oldSettled, false, 'claimed turn remains held');
    }
    assert.ok(!a.rawText('agent_message_chunk').includes(result), 'no delivery before crash');
    a.kill('SIGKILL'); await a.exited; await old;
    f.hook(async () => false);
    const b = await f.adapter();
    let resumeSid = sid;
    if (point === 'claimed-hold') resumeSid = (await b.newSession(f.cwd)).sessionId;
    else assert.ok(!(await b.loadSession(sid, f.cwd)).error);
    let settled = false;
    const resumed = b.prompt(resumeSid, point === 'claimed-hold' ? `[dot-decision:${rid}]\nCrash probe ${point}` : CONTINUE_PROMPT).then(r => { settled = true; return r; });
    await waitFor(() => b.rawText('agent_message_chunk').includes(`Work ${rid}`), 'same work re-attached');
    if (point === 'session-load-mid-hold') {
      await waitFor(() => b.rawText('agent_thought_chunk').includes('worker claimed'), 'loaded session still held');
      assert.equal(settled, false);
    }
    f.finish(rid, result);
    await waitFor(() => settled, 'one final delivery');
    assert.equal((await resumed).result?.stopReason, 'end_turn');
    assert.equal(f.calls.filter(c => c.route === '/submit').length, 1, 'exactly one submit call');
    assert.equal(f.rows.size, 1, 'exactly one assignment');
    const deliveries = [a, b].flatMap(x => x.updates).filter(u => u.sessionUpdate === 'agent_message_chunk' && u.content.text.includes(result));
    assert.equal(deliveries.length, 1, 'exactly one result delivery across processes');
    assert.equal((await f.state(resumeSid)).pending, null);
    assert.equal((await f.state(resumeSid)).completed.length, 1);
    assert.deepEqual([...a.errors, ...b.errors], []);
    console.log(`PASS P1b ${point}: submits=1 deliveries=1`);
  });
}
