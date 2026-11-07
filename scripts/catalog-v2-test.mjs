#!/usr/bin/env node
// Catalog v2 gate: worker tools are gone, every tool carries annotations, and three fixed tools
// (list_tools, call_tool_read, call_tool_write) dispatch to the server-side tool registry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const home = fs.mkdtempSync(path.join(tempRoot, 'dalan-catalog-v2-'));
fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true });
const port = Number(process.env.E2E_CATALOG_V2_PORT || 8813);
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: root, env: { ...process.env, HOME: home, DALAN_ENABLE_T3_TOOLS: '1', DALAN_LEGACY_PROFILE: '1', DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_AUTH_MODE: '', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let ready = false;
child.stdout.on('data', c => { if (String(c).includes('MCP listening')) ready = true; });
child.stderr.on('data', () => {});
try {
  for (let i = 0; i < 200 && !ready; i++) await new Promise(r => setTimeout(r, 50));
  assert(ready, 'server startup');
  const secret = fs.readFileSync(path.join(home, '.config/dot-bridge/env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc = async (method, params = {}) => (await (await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json()).result;
  const call = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    return { isError: result.isError, text: result.content[0].text };
  };

  const tools = (await rpc('tools/list')).tools;
  const names = tools.map(tool => tool.name);
  assert.deepEqual(names, ['list_pending', 'claim', 'get', 'ack_message', 'progress', 'finish', 'list_files', 'read_file', 'apply_patch', 'run_check', 'workspace_result', 'artifact_chunk', 't3_thread_list', 't3_thread_read', 't3_thread_create', 't3_thread_send', 't3_thread_wait', 't3_thread_set', 'notify_owner', 'list_tools', 'call_tool_read', 'call_tool_write'], 'exact stable tool list');
  for (const removed of ['capabilities']) assert(!names.includes(removed), `${removed} must be gone`);
  assert(!JSON.stringify(tools).includes('extensions'), 'no extensions anywhere in the catalog');

  const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const W = (idempotentHint, openWorldHint = false) => ({ readOnlyHint: false, destructiveHint: false, idempotentHint, openWorldHint });
  const expected = {
    list_pending: READ, get: READ, list_files: READ, read_file: READ, workspace_result: READ, t3_thread_list: READ, t3_thread_read: READ, t3_thread_wait: READ, t3_thread_create: W(false), t3_thread_send: W(false), t3_thread_set: W(true),
    list_tools: READ, call_tool_read: READ,
    claim: W(true), ack_message: W(true), progress: W(false), finish: W(true), apply_patch: W(false), run_check: W(false), artifact_chunk: W(true),
    notify_owner: W(false, true), call_tool_write: W(false),
  };
  for (const tool of tools) assert.deepEqual(tool.annotations, expected[tool.name], `${tool.name} annotations`);
  assert.deepEqual(Object.keys(expected).sort(), [...names].sort(), 'annotation table covers the catalog');

  // The three registry tools: fixed schemas, fixed generic descriptions.
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  assert.deepEqual(byName.list_tools.inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  const dispatchProps = ['arguments', 'idempotency_key', 'schema_hash', 'tool'];
  for (const name of ['call_tool_read', 'call_tool_write']) {
    const s = byName[name].inputSchema;
    assert.equal(s.additionalProperties, false, `${name} strict top level`);
    assert.deepEqual(Object.keys(s.properties).sort(), dispatchProps);
    assert.equal(s.properties.tool.type, 'string');
    assert.equal(s.properties.arguments.type, 'object');
    assert.equal(s.properties.arguments.additionalProperties, true, `${name} arguments is an open object`);
    assert.equal(s.properties.schema_hash.type, 'string');
    assert.equal(s.properties.idempotency_key.type, 'string');
    assert.equal(s.properties.idempotency_key.maxLength, 128);
  }
  assert.deepEqual(byName.call_tool_read.inputSchema.required.sort(), ['arguments', 'tool'], 'hash and key are optional for reads');
  assert.deepEqual(byName.call_tool_write.inputSchema.required.sort(), ['arguments', 'idempotency_key', 'schema_hash', 'tool'], 'hash and key are required for writes');
  assert.match(byName.list_tools.description, /call .*first/i);
  for (const name of ['list_tools', 'call_tool_read', 'call_tool_write']) assert(byName[name].description.length < 300, `${name} description is short`);
  for (const description of tools.map(t => t.description)) assert(!/extension|capabilities|owner_message/i.test(description), 'descriptions never mention extensions or registered tools');

  // Dispatch goes to the registry; an unregistered store lists nothing.
  const listed = await call('list_tools', {});
  assert.equal(listed.isError, false, listed.text);
  const parsedList = JSON.parse(listed.text);
  assert.deepEqual(Object.keys(parsedList).sort(), ['registry_version', 'tools']);
  assert(Number.isSafeInteger(parsedList.registry_version));
  assert.deepEqual(parsedList.tools, []);
  for (const name of ['call_tool_read', 'call_tool_write']) {
    const unknown = await call(name, { tool: 'nope', arguments: {}, schema_hash: 'a'.repeat(64), idempotency_key: 'k' });
    assert.equal(unknown.isError, true, `${name} unknown tool is an error result`);
    assert.match(unknown.text, /tool_unavailable/);
    for (const bad of [{}, { tool: 'x' }, { arguments: {} }, { tool: 1, arguments: {} }, { tool: 'x', arguments: [] }, { tool: 'x', arguments: 'a' }, { tool: 'x', arguments: {}, extra: 1 }, { tool: 'x', arguments: {}, schema_hash: 1 }, { tool: 'x', arguments: {}, idempotency_key: 'k'.repeat(129) }]) {
      const refused = await call(name, bad);
      assert.equal(refused.isError, true, `${name} ${JSON.stringify(bad)} refused`);
    }
  }
  assert.equal((await call('list_tools', { x: 1 })).isError, true, 'list_tools takes no arguments');
  assert.equal((await call('list_pending', { extensions: {} })).isError, true, 'extensions is not a field');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise(r => child.once('exit', r));
  fs.rmSync(home, { recursive: true, force: true });
}

// The dispatch seam: the registry's error codes map to isError results, never transport errors.
const { createToolRegistry, RegistryError } = await import('../src/tool-registry.mjs');
const { Store } = await import('../src/store.mjs');
const seamHome = fs.mkdtempSync(path.join(tempRoot, 'dalan-catalog-v2-seam-'));
try {
  const store = new Store(path.join(seamHome, 'bridge.db'));
  const registry = createToolRegistry({ store });
  assert.deepEqual(registry.listTools('w').tools, []);
  await assert.rejects(registry.callTool({ worker: 'w', tool: 'nope', class: 'read', args: {} }), e => e instanceof RegistryError && e.code === 'tool_unavailable');
  store.db.close();
} finally { fs.rmSync(seamHome, { recursive: true, force: true }); }
console.log('PASS catalog v2');
