#!/usr/bin/env node
// Registry end to end: the real server, the real `dalan tool` admin CLI and a fake `t3-post` executable.
// Adding, granting and removing a tool must never change tools/list; workers reach tools only through the three
// dispatch tools; the registry's error codes surface as isError results.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { reservedPort } from '../src/test-support/port.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });

const startServer = async (extraEnv = {}) => {
  const home = fs.mkdtempSync(path.join(tempRoot, 'dalan-registry-e2e-'));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true });
  const record = path.join(home, 't3-post.jsonl');
  const fake = path.join(home, 'bin', 't3-post');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', chunk => stdin += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
});
`, { mode: 0o755 });
  const port = await reservedPort();
  const env = { ...process.env, HOME: home, PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, DALAN_LEGACY_PROFILE: '1',
    DOT_BRIDGE_PORT: String(port), DOT_BRIDGE_AUTH_MODE: '', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', ...extraEnv };
  const out = [];
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  child.stdout.on('data', c => { out.push(String(c)); if (String(c).includes('MCP listening')) ready = true; });
  child.stderr.on('data', c => out.push(String(c)));
  for (let i = 0; i < 400 && !ready && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
  assert(ready, `server startup: ${out.join('')}`);
  const secret = fs.readFileSync(path.join(home, '.config/dot-bridge/env'), 'utf8').match(/BRIDGE_PATH_SECRET=(.+)/)[1];
  const rpc = async (method, params = {}) => (await (await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json()).result;
  const call = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    return { isError: result.isError, text: result.content[0].text };
  };
  const dalan = args => new Promise((resolve, reject) => execFile(process.execPath, [path.join(root, 'bin/dalan.mjs'), ...args],
    { env, cwd: root, timeout: 30_000 }, (error, stdout, stderr) => error ? reject(new Error(`dalan ${args.join(' ')}: ${stderr || stdout || error.message}`)) : resolve(stdout)));
  const posts = () => fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const stop = async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(r => child.once('exit', r));
    fs.rmSync(home, { recursive: true, force: true });
  };
  const adminSocket = async () => {
    const found = [];
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.name === 'admin.sock') found.push(full); else if (entry.isDirectory()) walk(full); } };
    walk(home);
    return found[0];
  };
  return { home, port, secret, rpc, call, dalan, posts, stop, adminSocket };
};

const FIXED = ['list_pending', 'claim', 'get', 'ack_message', 'progress', 'finish', 'list_tools', 'call_tool_read', 'call_tool_write'];
const leadMessage = {
  name: 'owner_message',
  description: 'Send a question or blocker to the owner.',
  class: 'write',
  inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', maxLength: 2000 } }, required: ['kind', 'text'] },
  handler: { kind: 't3_post', thread_id: 'thread-lead-fixed' },
};
const secondTool = {
  name: 'lead_note', description: 'A second registered tool that is never granted.', class: 'write',
  inputSchema: leadMessage.inputSchema,
  handler: { kind: 't3_post', thread_id: 'thread-lead-fixed' },
};

// The advertised tools/list is fixed per (catalog profile, worker capability) and registry changes never alter it. Both are
// pinned here: profile "stable" and the capabilities of the legacy-mode worker "dot" (notify_owner, no t3 tools).
// What a worker may actually use varies with the registry and is read through list_tools, not tools/list.
const s = await startServer({ DALAN_CATALOG_PROFILE: 'stable' });
try {
  const listBytes = async () => JSON.stringify((await s.rpc('tools/list')).tools);
  const before = await listBytes();
  const names = JSON.parse(before).map(t => t.name);
  assert.deepEqual(names, ['list_pending', 'claim', 'get', 'ack_message', 'progress', 'finish', 'list_files', 'read_file', 'apply_patch', 'run_check', 'workspace_result', 'artifact_chunk', 'notify_owner', 'list_tools', 'call_tool_read', 'call_tool_write'], 'pinned advertised tools for (stable, worker)');
  assert(!names.includes('owner_message'));
  const listing = async () => JSON.parse((await s.call('list_tools', {})).text);
  const write = (tool, args, extra = {}) => s.call('call_tool_write', { tool, arguments: args, ...extra });
  const hashFor = async tool => (await listing()).tools.find(t => t.name === tool)?.schema_hash;

  // (b) default deny: nothing is listed or callable before a grant, and unknown looks the same as ungranted.
  const registrationFile = path.join(s.home, 'owner_message.json');
  fs.writeFileSync(registrationFile, JSON.stringify(leadMessage));
  await s.dalan(['tool', 'add', '--file', registrationFile]);
  const first = await listing();
  assert.deepEqual(first.tools, [], 'ungranted worker sees no tools');
  assert(Number.isSafeInteger(first.registry_version) && first.registry_version >= 1);
  const ungranted = await write('owner_message', { kind: 'question', text: 'hi' }, { schema_hash: 'a'.repeat(64), idempotency_key: 'k-ungranted' });
  const unknownCall = await write('no_such_tool', { kind: 'question', text: 'hi' }, { schema_hash: 'a'.repeat(64), idempotency_key: 'k-unknown' });
  assert.equal(ungranted.isError, true);
  assert.match(ungranted.text, /tool_unavailable/);
  assert.equal(ungranted.text, unknownCall.text, 'unknown and ungranted are the same refusal');
  await s.dalan(['tool', 'grant', 'owner_message', 'someone-else']);
  assert.deepEqual((await listing()).tools, [], 'a grant to another worker does not show here');

  // (G) the local-principal shortcut (no OAuth, legacy profile) resolves every caller to worker "dot", so dot sees only
  // what was granted to "dot". Per-agent identity for local callers is out of scope: they use the admin socket.
  const beforeGrant = await listing();
  await s.dalan(['tool', 'grant', 'owner_message', 'dot']);
  const listed = await listing();
  assert(listed.registry_version > beforeGrant.registry_version, 'a grant moves the registry version');
  assert.equal(listed.tools.length, 1);
  assert.deepEqual(Object.keys(listed.tools[0]).sort(), ['class', 'description', 'input_schema', 'name', 'schema_hash']);
  assert.equal(listed.tools[0].name, 'owner_message');
  assert.equal(listed.tools[0].class, 'write');
  assert.equal(listed.tools[0].description, leadMessage.description);
  assert.equal(listed.tools[0].input_schema.properties.kind.enum.join(), 'question,blocker');
  assert.match(listed.tools[0].schema_hash, /^[0-9a-f]{64}$/);
  const hash = listed.tools[0].schema_hash;

  // The audit seam: the last registry change is visible in status.
  const status = JSON.parse(await s.dalan(['status', '--json']));
  assert.equal(status.last_registry_change.tool, 'owner_message');
  assert.equal(status.last_registry_change.kind, 'grant');

  // A write call without the hash and key never reaches the handler.
  const noHash = await write('owner_message', { kind: 'question', text: 'x' }, { idempotency_key: 'k-nohash' });
  assert.equal(noHash.isError, true);
  assert.match(noHash.text, /schema_hash/);
  const noKey = await write('owner_message', { kind: 'question', text: 'x' }, { schema_hash: hash });
  assert.equal(noKey.isError, true);
  assert.match(noKey.text, /idempotency_key/);
  const stale = await write('owner_message', { kind: 'question', text: 'x' }, { schema_hash: 'b'.repeat(64), idempotency_key: 'k-stale' });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /stale_registry/);
  assert.match(stale.text, /call list_tools again/);
  assert(!stale.text.includes('owner_message') && !stale.text.includes('thread-lead-fixed'), 'no registry contents in the error');
  assert.equal(s.posts().length, 0);

  // (c) a write call posts through the host command with the text on stdin, never in argv; a repeat with the same key does not post again.
  const sent = await write('owner_message', { kind: 'question', text: 'Which branch should I use?' }, { schema_hash: hash, idempotency_key: 'k-1' });
  assert.equal(sent.isError, false, sent.text);
  assert.equal(JSON.parse(sent.text).queued, false);
  let posts = s.posts();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].argv, ['--as', 'dot', '--kind', 'script', '--mode', 'queue', '--thread', 'thread-lead-fixed']);
  assert.equal(posts[0].stdin, '[question] Which branch should I use?');
  const repeat = await write('owner_message', { kind: 'question', text: 'Which branch should I use?' }, { schema_hash: hash, idempotency_key: 'k-1' });
  assert.equal(repeat.isError, false, repeat.text);
  assert.equal(s.posts().length, 1, 'the same idempotency key does not post twice');
  const capacity = await write('owner_message', { kind: 'capacity', text: 'x' }, { schema_hash: hash, idempotency_key: 'k-2' });
  assert.equal(capacity.isError, true);
  assert.match(capacity.text, /invalid_arguments/);
  const second = await write('owner_message', { kind: 'blocker', text: 'Still stuck.' }, { schema_hash: hash, idempotency_key: 'k-3' });
  assert.equal(second.isError, false, second.text);
  assert.equal(JSON.parse(second.text).queued, true, 'a second message inside ten minutes is held');
  assert.equal(s.posts().length, 1, 'the held message was not posted');

  // (d) policy errors are tool results with the registry code.
  const wrongClass = await s.call('call_tool_read', { tool: 'owner_message', arguments: { kind: 'question', text: 'x' } });
  assert.equal(wrongClass.isError, true);
  assert.match(wrongClass.text, /wrong_class/);
  const extraKey = await write('owner_message', { kind: 'question', text: 'x', extensions: { a: 1 } }, { schema_hash: hash, idempotency_key: 'k-4' });
  assert.equal(extraKey.isError, true);
  assert.match(extraKey.text, /invalid_arguments/);
  const extraDispatchKey = await write('owner_message', { kind: 'question', text: 'x' }, { schema_hash: hash, idempotency_key: 'k-5', thread: 'other' });
  assert.equal(extraDispatchKey.isError, true, 'the dispatch tool itself takes no extra fields');
  const longKey = await write('owner_message', { kind: 'question', text: 'x' }, { schema_hash: hash, idempotency_key: 'k'.repeat(129) });
  assert.equal(longKey.isError, true);
  fs.writeFileSync(registrationFile, JSON.stringify(secondTool));
  await s.dalan(['tool', 'add', '--file', registrationFile]);
  const ungrantedRead = await s.call('call_tool_read', { tool: 'lead_note', arguments: { kind: 'question', text: 'x' } });
  assert.equal(ungrantedRead.isError, true);
  assert.match(ungrantedRead.text, /tool_unavailable/);
  // the hash the model saw is stale once the registry moved
  assert.notEqual(await hashFor('owner_message'), undefined);
  await s.dalan(['tool', 'grant', 'lead_note', 'dot']);
  const afterGrant = await write('owner_message', { kind: 'question', text: 'x' }, { schema_hash: hash, idempotency_key: 'k-6' });
  assert.equal(afterGrant.isError, true);
  assert.match(afterGrant.text, /stale_registry/, 'a new grant for the caller moves its hashes');
  assert.equal(s.posts().length, 1);

  // (I) the admin socket is not reachable through the public MCP route, and registry management needs the operator key.
  const publicBase = `http://127.0.0.1:${s.port}`;
  for (const [method, route] of [['GET', '/tools'], ['POST', '/tools/add'], ['POST', '/tools/grant'], ['GET', '/status'], ['GET', `/${s.secret}/tools`], ['POST', `/${s.secret}/tools/add`]]) {
    const response = await fetch(`${publicBase}${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ spec: leadMessage, name: 'owner_message', worker: 'dot' }) : undefined });
    assert.equal(response.status, 404, `${method} ${route} is not served on the public route`);
  }
  const viaMcp = await s.call('tools_add', {});
  assert.equal(viaMcp.isError, true, 'no MCP tool manages the registry');
  const socketPath = await s.adminSocket();
  assert(socketPath, 'admin socket found');
  const adminWithout = (route, method = 'GET', body) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method, headers: { 'content-type': 'application/json' } }, response => {
      let text = ''; response.on('data', c => text += c); response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject); request.end(body);
  });
  assert.notEqual((await adminWithout('/tools')).status, 200, 'the admin socket refuses a request without the operator key');
  assert.notEqual((await adminWithout('/tools/add', 'POST', JSON.stringify({ spec: leadMessage }))).status, 200);

  // (a) revoking and removing changes what the worker may call, never the served tool list.
  await s.dalan(['tool', 'revoke', 'owner_message', 'dot']);
  await s.dalan(['tool', 'revoke', 'lead_note', 'dot']);
  assert.deepEqual((await listing()).tools, []);
  await s.dalan(['tool', 'remove', 'owner_message']);
  await s.dalan(['tool', 'remove', 'lead_note']);
  assert.equal(await listBytes(), before, 'tools/list is byte-identical before and after add, grant and remove');
  assert.equal(JSON.stringify(JSON.parse(before).map(t => t.name)), JSON.stringify(names));
  for (const name of FIXED.filter(n => ['list_tools', 'call_tool_read', 'call_tool_write'].includes(n))) assert(names.includes(name));
} finally {
  await s.stop();
}

// (e) the frozen legacy profile lists no dispatch tools, with a registry present in the store.
const legacy = await startServer({ DALAN_CATALOG_PROFILE: 'legacy-v46' });
try {
  const legacyNames = (await legacy.rpc('tools/list')).tools.map(t => t.name);
  assert.deepEqual(legacyNames, ['list_pending', 'claim', 'get', 'ack_message', 'progress', 'finish',
    'list_files', 'read_file', 'apply_patch', 'run_check', 'workspace_result', 'artifact_chunk']);
  for (const name of ['list_tools', 'call_tool_read', 'call_tool_write']) assert(!legacyNames.includes(name));
} finally {
  await legacy.stop();
}
console.log('PASS registry e2e');
