#!/usr/bin/env node
// The four T3 worker tools t3_thread_create, t3_thread_send, t3_thread_wait and t3_thread_set are top-level MCP tools again.
// With DALAN_ENABLE_T3_TOOLS=1 they are advertised with the descriptions and input schemas frozen in the T3-on golden file,
// plus the catalog v2 annotations; with it off they are absent and refused. The test reads only the files in this tree, so it
// also runs from a package tarball or a clone with no remote refs. Run with --update only for a deliberate catalog release.
// A T3-enabled worker's direct t3_thread_send reaches a stub t3code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { reservedPort } from '../src/test-support/port.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const goldenPath = path.join(root, 'scripts/fixtures/catalog.t3-on.tools.golden.json');
const FOUR = ['t3_thread_create', 't3_thread_send', 't3_thread_wait', 't3_thread_set'];

// The released definitions of the four tools, as frozen in the golden file.
const updating = process.argv.includes('--update');
const golden = fs.readFileSync(goldenPath, 'utf8');
const releasedTools = FOUR.map(name => JSON.parse(golden).find(tool => tool.name === name));
assert(releasedTools.every(tool => tool?.description && tool?.inputSchema), 'the T3-on golden file defines the four tools');

const start = async enabled => {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'dalan-t3-top-'));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true });
  const record = path.join(home, 't3code.jsonl');
  fs.writeFileSync(path.join(home, 'bin', 't3code'), `#!${process.execPath}
let stdin = '';
process.stdin.on('data', chunk => stdin += chunk);
process.stdin.on('end', () => {
  require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin }) + '\\n');
  console.log(JSON.stringify({ ok: true, data: { thread: { id: 'thread_x' }, message: { messageId: 'message_1' } } }));
});
`, { mode: 0o755 });
  const port = await reservedPort();
  const env = { ...process.env, HOME: home, PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, DALAN_LEGACY_PROFILE: '1', DALAN_CATALOG_PROFILE: 'stable',
    DALAN_ENABLE_T3_TOOLS: enabled ? '1' : '0', DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_AUTH_MODE: '', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1' };
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  child.stdout.on('data', c => { if (String(c).includes('MCP listening')) ready = true; });
  child.stderr.on('data', () => {});
  for (let i = 0; i < 400 && !ready && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
  assert(ready, 'server startup');
  const secret = fs.readFileSync(path.join(home, '.config/dot-bridge/env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc = async (method, params = {}) => (await (await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
  const invocations = () => fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const stop = async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(r => child.once('exit', r)); fs.rmSync(home, { recursive: true, force: true }); };
  return { rpc, invocations, stop };
};

const on = await start(true);
try {
  const tools = (await on.rpc('tools/list')).tools;
  for (const expected of releasedTools) {
    const actual = tools.find(tool => tool.name === expected.name);
    assert(actual, `${expected.name} is advertised with T3 tools on`);
    if (!updating) assert.equal(actual.description, expected.description, `${expected.name} description matches the released definition`);
    if (!updating) assert.deepEqual(actual.inputSchema, expected.inputSchema, `${expected.name} inputSchema matches the released definition`);
    assert.equal(typeof actual.annotations?.readOnlyHint, 'boolean', `${expected.name} has annotations`);
  }
  assert.equal(tools.find(t => t.name === 't3_thread_wait').annotations.readOnlyHint, true);
  for (const name of ['t3_thread_create', 't3_thread_send', 't3_thread_set']) assert.equal(tools.find(t => t.name === name).annotations.readOnlyHint, false);
  const text = JSON.stringify(tools, null, 1) + '\n';
  if (updating) { fs.writeFileSync(goldenPath, text); console.log('t3-on tools golden updated'); }
  else assert.equal(text, golden, 'T3-on tools list changed: this needs a deliberate catalog release');

  // A direct call reaches the stub transport.
  const sent = await on.rpc('tools/call', { name: 't3_thread_send', arguments: { threadId: 'thread_x', message: 'hello from a worker' } });
  assert.equal(sent.isError, false, sent.content[0].text);
  const seen = on.invocations().find(i => i.args.includes('send'));
  assert.equal(seen?.stdin, 'hello from a worker');
} finally { await on.stop(); }

const off = await start(false);
try {
  const names = (await off.rpc('tools/list')).tools.map(t => t.name);
  for (const name of FOUR) {
    assert(!names.includes(name), `${name} absent with T3 tools off`);
    const refused = await off.rpc('tools/call', { name, arguments: { threadId: 'thread_x', message: 'm', prompt: 'p' } });
    assert.equal(refused.isError, true);
  }
  assert.equal(off.invocations().length, 0);
} finally { await off.stop(); }
console.log('PASS t3 top-level tools: released definitions, annotations, golden, direct send, absent when off');
