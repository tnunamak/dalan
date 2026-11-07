// A worker can put a credential-shaped string in its finish report. The owner reads it masked over HTTP; the
// database keeps the exact text so a retried finish with the same body is still the same finish.
import assert from 'node:assert/strict';
import { DotBridgeAdapter } from './conformance/adapter-dot-bridge.mjs';

const TOKEN = 'ghp_' + 'Q'.repeat(36);
const adapter = new DotBridgeAdapter({});
const ok = r => { assert.equal(r.error, undefined, JSON.stringify(r)); assert.ok(r.value); return r.value; };
try {
  await adapter.init(); await adapter.reset();
  const job = 'mask', id = adapter.requestId(job), owner = adapter.ownerToken(job);
  const assignment = { schema_version: 1, request_id: id, brief: 'Read a file', inputs: [], execution_scope: 'read-only', expected_output: 'text' };
  ok(await adapter.admin('POST', '/submit', { assignment, delivery: 'none', owner_token: owner }));
  const grant = ok(await adapter.mcp('W1', 'claim', { request_id: id, claimant: 'W1', acquisition_id: 'mask-acq', lease_ms: 60000 }));
  const finish = { request_id: id, claim_id: grant.claim_id, outcome: 'completed', summary: `found ${TOKEN}`, result: `the key is ${TOKEN}` };
  ok(await adapter.mcp('W1', 'finish', finish));
  const stored = adapter.q('SELECT summary,result FROM reports WHERE request_id=?', id)[0];
  assert.ok(stored.result.includes(TOKEN), 'the database keeps the exact text');
  const got = ok(await adapter.admin('GET', `/get?id=${id}&peek=1`, undefined, owner));
  assert.ok(!JSON.stringify(got).includes(TOKEN), 'owner get leaks the token');
  assert.ok(got.report.result.includes('the key is '), 'the rest of the text is kept');
  const waited = ok(await adapter.admin('GET', `/wait?id=${id}&timeout=1&peek=1`, undefined, owner));
  assert.ok(!JSON.stringify(waited).includes(TOKEN), 'owner wait leaks the token');
  const again = await adapter.mcp('W1', 'finish', finish);
  assert.equal(again.error, undefined, 'a retried finish with the same body is still recognised');
  console.log('owner report credential mask: ok');
} finally { await adapter.close(); }
