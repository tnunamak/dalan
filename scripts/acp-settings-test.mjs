// The ACP adapter accepts every worker name that Dalan accepts, and its default model label
// names the configured worker, not a vendor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { startAdapter } from './acp-client.mjs';

const root = fs.mkdtempSync(join(os.tmpdir(), 'acp-settings-'));
const base = { HOME: root, XDG_STATE_HOME: join(root, 'state'), DOT_ACP_SOCKET: join(root, 'no-bridge.sock'), DOT_ACP_LABEL: '' };
let failed = 0;
async function check(name, env, expected) {
  const a = startAdapter({ ...base, ...env }, root);
  try {
    // An adapter that refuses its settings exits at start; fail fast instead of waiting on a dead pipe.
    const died = a.exited.then(r => { throw new Error(`adapter exited at start (${r.code ?? r.signal}): ${a.stderr().trim().split('\n').pop()}`); });
    await Promise.race([a.init(), died]);
    const s = await Promise.race([a.newSession(root), died]);
    assert.ok(s, `session/new failed: ${a.stderr().slice(-300)}`);
    const label = s.configOptions[0].options[0].name;
    assert.equal(label, expected);
    assert.deepEqual(a.errors, []);
    console.log(`ok ${name}`);
  } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
  finally { a.kill('SIGTERM'); await a.exited; }
}
await check('a worker name with an underscore starts the adapter and names the worker', { DOT_ACP_WORKER: 'review_bot' }, 'Dalan worker: review_bot');
await check('a worker name with a hyphen names the worker', { DOT_ACP_WORKER: 'chat-gpt' }, 'Dalan worker: chat-gpt');
await check('without DOT_ACP_WORKER the default label names no vendor', { DOT_ACP_WORKER: '' }, 'Dalan worker');
await check('DOT_ACP_LABEL still overrides the label', { DOT_ACP_WORKER: 'review_bot', DOT_ACP_LABEL: 'Review bot' }, 'Review bot');
fs.rmSync(root, { recursive: true, force: true });
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
