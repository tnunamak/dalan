import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DotBridgeAdapter } from './adapter-dot-bridge.mjs';
import { validateProfileCorpus } from './profile-version.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixtures = path.join(here, 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'MANIFEST.json'), 'utf8'));
const schemaText = Object.fromEntries(['command', 'event', 'reply'].map(name => [name, fs.readFileSync(path.join(fixtures, `${name}.schema.json`), 'utf8')]));
const traces = fs.readdirSync(path.join(fixtures, 'traces')).sort().map(file => JSON.parse(fs.readFileSync(path.join(fixtures, 'traces', file), 'utf8')));
assert.deepEqual(validateProfileCorpus({ manifest, schemaText, traces }), [], 'the pinned profile, schemas, and all traces must validate');
const weakenedTrace = structuredClone(traces); weakenedTrace[0].steps.pop();
assert.match(validateProfileCorpus({ manifest, schemaText, traces: weakenedTrace }).join('\n'), /T01 trace content/);
const brokenControl = structuredClone(traces); brokenControl.find(trace => trace.id === 'T10').steps.find(step => step.control).expect.now = -1;
assert.match(validateProfileCorpus({ manifest, schemaText, traces: brokenControl }).join('\n'), /T10 trace content/);
assert.match(validateProfileCorpus({ manifest: { ...manifest, profileVersion: 1 }, schemaText, traces }).join('\n'), /unsupported fixture profile version/);
assert.match(validateProfileCorpus({ manifest: { ...manifest, docSha256: '0'.repeat(64) }, schemaText, traces }).join('\n'), /source identity or hash/);
assert.match(validateProfileCorpus({ manifest: { ...manifest, traces: 0 }, schemaText, traces }).join('\n'), /manifest trace count must be 42/);
const unknownVersionTraces = structuredClone(traces); unknownVersionTraces[0].steps[0].input.command.v = 1;
assert.match(validateProfileCorpus({ manifest, schemaText, traces: unknownVersionTraces }).join('\n'), /trace content does not match/);

const adapter = new DotBridgeAdapter();
await adapter.init();
try {
  await adapter.reset();
  const command = { v: 0, op: 'submit', job: 'version-v0', key: 'submit-v0', body: { source: 'git:BASE', scope: 'read:fixture', policy: 'P0', destination: 'owner-inbox', retainUntil: 1000 } };
  const accepted = await adapter.invoke('owner', command);
  assert.equal(accepted.reply.ok, true, 'profile v0 must be accepted');
  const refused = await adapter.invoke('owner', { ...command, v: 1, job: 'version-v1' });
  assert.deepEqual(refused.reply, { ok: false, code: 'INVALID' }, 'unsupported profile versions use the documented INVALID error');
  assert.deepEqual(refused.native, [], 'unsupported profile versions must not reach the native adapter');
  assert.equal(adapter.q1('SELECT count(*) n FROM assignments WHERE request_id=?', adapter.requestId('version-v1')).n, 0, 'unsupported versions must have no effects');
} finally { await adapter.close(); }
