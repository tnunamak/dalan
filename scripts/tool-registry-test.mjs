// The tool registry: default-deny policy, argument validation, rate limit, audit, and a tools/list that never moves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { createToolRegistry, createT3PostHandler, RegistryError, LIMITS } from '../src/tool-registry.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const scratchBase = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratchBase, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchBase, 'tool-registry-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function fixture({ handlers = {}, clock, callsPerMinute } = {}) {
  const store = new Store(path.join(scratch, `bridge-${counter++}.db`));
  const time = { ms: Date.parse('2026-11-05T00:00:00Z') };
  const calls = [];
  const echo = { run: async ({ args }) => { calls.push(args); return { echoed: args }; } };
  const registry = createToolRegistry({ store, now: clock ?? (() => time.ms), handlers: { echo, ...handlers }, callsPerMinute });
  return { store, registry, time, calls };
}
const schema = { type: 'object', properties: { text: { type: 'string', maxLength: 50 }, n: { type: 'integer' } }, required: ['text'] };
const spec = (extra = {}) => ({ name: 'echo_tool', description: 'echo', inputSchema: schema, class: 'read', handler: { kind: 'echo' }, ...extra });

let keyCounter = 0;
const hashOf = (registry, worker, tool) => registry.listTools(worker).tools.find(t => t.name === tool)?.schema_hash;
// Dispatch the way a well-behaved client does: the hash comes from list_tools, the key is new for every call.
const dispatch = (registry, { worker = 'dot', tool, class: cls = 'read', args, ...rest }) =>
  registry.callTool({ worker, tool, class: cls, args, schema_hash: hashOf(registry, worker, tool), idempotency_key: `key-${keyCounter++}`, ...rest });
const code = async (promise) => { try { await promise; } catch (e) { assert(e instanceof RegistryError, e.stack); return e.code; } assert.fail('expected RegistryError'); };
const codeSync = (fn) => { try { fn(); } catch (e) { assert(e instanceof RegistryError, String(e)); return e.code; } assert.fail('expected RegistryError'); };

test('unknown tool, not granted, disabled', async () => {
  const { registry } = fixture();
  assert.equal(await code(dispatch(registry, { worker: 'dot', tool: 'nope', class: 'read', args: {} })), 'tool_unavailable');
  registry.register(spec());
  assert.equal(await code(dispatch(registry, { worker: 'dot', tool: 'echo_tool', class: 'read', args: { text: 'x' } })), 'tool_unavailable');
  registry.grant('echo_tool', 'dot');
  assert.deepEqual((await dispatch(registry, { worker: 'dot', tool: 'echo_tool', class: 'read', args: { text: 'x' } })).ok, true);
  assert.equal(await code(dispatch(registry, { worker: 'other', tool: 'echo_tool', class: 'read', args: { text: 'x' } })), 'tool_unavailable');
  registry.setEnabled('echo_tool', false);
  assert.equal(await code(dispatch(registry, { worker: 'dot', tool: 'echo_tool', class: 'read', args: { text: 'x' } })), 'tool_unavailable');
  assert.deepEqual(registry.listTools('dot').tools, []);
  registry.revoke('echo_tool', 'dot');
});

test('class must match in both directions', async () => {
  const { registry } = fixture();
  registry.register(spec({ name: 'reader' })); registry.register(spec({ name: 'writer', class: 'write' }));
  for (const t of ['reader', 'writer']) registry.grant(t, 'dot');
  const args = { text: 'x' };
  assert.equal(await code(dispatch(registry, { worker: 'dot', tool: 'writer', class: 'read', args })), 'wrong_class');
  assert.equal(await code(dispatch(registry, { worker: 'dot', tool: 'reader', class: 'write', args })), 'wrong_class');
  assert.equal((await dispatch(registry, { worker: 'dot', tool: 'writer', class: 'write', args })).ok, true);
});

test('arguments are validated; unknown keys, wrong types, size and prototype keys are refused', async () => {
  const { registry, calls } = fixture();
  registry.register(spec()); registry.grant('echo_tool', 'dot');
  const call = args => dispatch(registry, { worker: 'dot', tool: 'echo_tool', class: 'read', args });
  assert.equal(await code(call({ text: 'x', extra: 1 })), 'invalid_arguments'); // schema omits additionalProperties
  assert.equal(await code(call({ text: 5 })), 'invalid_arguments');
  assert.equal(await code(call({})), 'invalid_arguments');
  assert.equal(await code(call({ text: 'x'.repeat(51) })), 'invalid_arguments');
  assert.equal(await code(call({ text: 'x'.repeat(100000) })), 'invalid_arguments');
  assert.equal(await code(call(JSON.parse('{"text":"x","__proto__":{"a":1}}'))), 'invalid_arguments');
  assert.equal(await code(call(JSON.parse('{"text":"x","constructor":1}'))), 'invalid_arguments');
  assert.equal(await code(call('text')), 'invalid_arguments');
  assert.equal(calls.length, 0, 'no handler ran for refused arguments');
  assert.equal((await call({ text: 'ok', n: 2 })).ok, true);
});

test('register refuses bad schema, unknown handler kind, delete/overwrite handlers, duplicates', () => {
  const { registry } = fixture({ handlers: { wiper: { destructive: true, run: async () => ({}) } } });
  assert.equal(codeSync(() => registry.register(spec({ inputSchema: { type: 'object', $ref: '#/x' } }))), 'invalid_schema');
  assert.equal(codeSync(() => registry.register(spec({ inputSchema: { type: 'array' } }))), 'invalid_schema');
  assert.equal(codeSync(() => registry.register(spec({ inputSchema: { type: 'object', properties: { a: { type: 'weird' } } } }))), 'invalid_schema');
  assert.equal(codeSync(() => registry.register(spec({ handler: { kind: 'shell' } }))), 'unknown_handler_kind');
  assert.equal(codeSync(() => registry.register(spec({ handler: { kind: 'delete_file' } }))), 'unknown_handler_kind');
  assert.equal(codeSync(() => registry.register(spec({ handler: { kind: 'wiper' } }))), 'forbidden_handler');
  assert.equal(codeSync(() => registry.register(spec({ handler: { kind: 'echo', operation: 'delete' } }))), 'forbidden_handler');
  assert.equal(codeSync(() => registry.register(spec({ handler: { kind: 'echo', mode: 'overwrite' } }))), 'forbidden_handler');
  assert.equal(codeSync(() => registry.register(spec({ class: 'admin' }))), 'invalid_tool');
  assert.equal(codeSync(() => registry.register(spec({ name: 'call_tool_write' }))), 'invalid_tool');
  registry.register(spec());
  assert.equal(codeSync(() => registry.register(spec())), 'duplicate_tool');
  assert.equal(registry.list().length, 1);
});


test('owner list uses registration hashes without weakening caller hashes or grants', async () => {
  const { registry, store, calls } = fixture();
  const registration = registry.register(spec());
  assert.equal(registry.list()[0].schema_hash, registration.schema_hash);
  registry.grant('echo_tool', 'dot');
  registry.grant('echo_tool', 'other');
  const dotHash = hashOf(registry, 'dot', 'echo_tool');
  const otherHash = hashOf(registry, 'other', 'echo_tool');
  assert.notEqual(dotHash, otherHash);
  assert.notEqual(dotHash, registration.schema_hash);
  assert.equal(registry.list()[0].schema_hash, registration.schema_hash);
  assert.equal(store.db.prepare("SELECT schema_hash FROM tool_registry_log WHERE kind='register'").get().schema_hash, registration.schema_hash);
  assert.equal(await code(dispatch(registry, { tool: 'echo_tool', args: { text: 'x' }, schema_hash: registration.schema_hash })), 'stale_registry');
  assert.equal(await code(dispatch(registry, { tool: 'echo_tool', args: { text: 'x' }, schema_hash: otherHash })), 'stale_registry');
  registry.register(spec({ name: 'second' }));
  registry.grant('second', 'dot');
  assert.notEqual(hashOf(registry, 'dot', 'echo_tool'), dotHash);
  assert.equal(hashOf(registry, 'other', 'echo_tool'), otherHash);
  assert.equal(registry.list()[0].schema_hash, registration.schema_hash);
  assert.equal(await code(dispatch(registry, { tool: 'echo_tool', args: { text: 'x' }, schema_hash: dotHash })), 'stale_registry');
  registry.revoke('echo_tool', 'dot');
  assert.equal(await code(dispatch(registry, { tool: 'echo_tool', args: { text: 'x' }, schema_hash: dotHash })), 'tool_unavailable');
  assert.equal(calls.length, 0, 'no handler ran for owner, foreign, stale or revoked authority');
  assert.equal(registry.list()[0].schema_hash, registration.schema_hash);
});
test('handler failure is reported as handler_failed and results are redacted and capped', async () => {
  const secret = 'ghp_' + randomBytes(18).toString('hex');
  const { registry } = fixture({ handlers: {
    boom: { run: async () => { throw new Error('secret detail'); } },
    leak: { run: async () => ({ text: `token ${secret}` }) },
    big: { run: async () => ({ blob: 'z'.repeat(200000) }) },
  } });
  for (const kind of ['boom', 'leak', 'big']) { registry.register(spec({ name: kind, handler: { kind } })); registry.grant(kind, 'dot'); }
  const call = tool => dispatch(registry, { worker: 'dot', tool, class: 'read', args: { text: 'x' } });
  assert.equal(await code(call('boom')), 'handler_failed');
  const leaked = JSON.stringify((await call('leak')).result);
  assert(!leaked.includes(secret), 'secret redacted');
  const big = JSON.stringify((await call('big')).result);
  assert(big.length < 40000, 'result capped');
});

test('listForWorker returns only granted tools with schema hash', () => {
  const { registry } = fixture();
  registry.register(spec({ name: 'a' })); registry.register(spec({ name: 'b' }));
  registry.grant('a', 'dot');
  const list = registry.listTools('dot').tools;
  assert.deepEqual(list.map(t => t.name), ['a']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['class', 'description', 'input_schema', 'name', 'schema_hash']);
  assert.match(list[0].schema_hash, /^[a-f0-9]{64}$/);
  assert.equal(list[0].input_schema.additionalProperties, false);
  assert.deepEqual(registry.listTools('nobody').tools, []);
});

test('audit rows carry digests, outcomes and schema hashes, never argument values', async () => {
  const { registry, store } = fixture();
  registry.register(spec()); registry.grant('echo_tool', 'dot');
  const value = 'very-private-value-12345';
  await dispatch(registry, { worker: 'dot', tool: 'echo_tool', class: 'read', args: { text: value } });
  await code(dispatch(registry, { worker: 'dot', tool: 'echo_tool', class: 'read', args: { text: value, extra: value } }));
  await code(dispatch(registry, { worker: 'dot', tool: 'echo_tool', class: 'write', args: { text: value } }));
  registry.remove('echo_tool');
  const rows = store.db.prepare('SELECT * FROM tool_registry_log ORDER BY id').all();
  assert(rows.length >= 6);
  assert(!JSON.stringify(rows).includes(value), 'no argument values in the audit log');
  const kinds = rows.map(r => `${r.kind}:${r.outcome}`);
  assert(kinds.includes('register:ok') && kinds.includes('grant:ok') && kinds.includes('remove:ok'));
  assert(kinds.includes('call:ok') && kinds.includes('call:invalid_arguments') && kinds.includes('call:wrong_class'));
  assert(rows.find(r => r.kind === 'register').schema_hash.match(/^[a-f0-9]{64}$/));
  assert(rows.find(r => r.kind === 'call' && r.outcome === 'ok').args_digest.match(/^[a-f0-9]{64}$/));
});

const postSchema = { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['kind', 'text'] };
const postSpec = (extra = {}) => ({ name: 'owner_message', description: 'Message the owner', class: 'write', inputSchema: postSchema, handler: { kind: 't3_post', thread_id: 'thread-lead' }, ...extra });
const postFixture = () => {
  const posts = [];
  const store = new Store(path.join(scratch, `class-${counter++}.db`));
  const t3 = createT3PostHandler({ store, post: async p => { posts.push(p); } });
  const registry = createToolRegistry({ store, handlers: { t3_post: t3 } });
  return { store, registry, posts };
};

test('a handler kind declares its effect class: t3_post cannot be registered as read', async () => {
  const { registry, posts } = postFixture();
  assert.throws(() => registry.register(postSpec({ class: 'read' })), e => e instanceof RegistryError && e.code === 'invalid_tool' && /t3_post/.test(e.message) && /write/.test(e.message));
  assert.deepEqual(registry.list(), []);
  registry.register(postSpec());
  registry.grant('owner_message', 'dot');
  assert.equal(await code(dispatch(registry, { tool: 'owner_message', class: 'read', args: { kind: 'question', text: 'x' } })), 'wrong_class');
  assert.deepEqual(posts, []);
});

test('a stored t3_post row with class read is served and enforced as write', async () => {
  const { store, registry, posts } = postFixture();
  registry.register(postSpec());
  registry.grant('owner_message', 'dot');
  store.db.prepare("UPDATE registered_tools SET class='read' WHERE name='owner_message'").run();
  assert.equal(registry.listTools('dot').tools[0].class, 'write');
  const args = { kind: 'question', text: 'x' };
  assert.equal(await code(dispatch(registry, { tool: 'owner_message', class: 'read', args })), 'wrong_class');
  assert.equal(await code(registry.callTool({ worker: 'dot', tool: 'owner_message', class: 'write', args, idempotency_key: 'k1' })), 'stale_registry');
  assert.deepEqual(posts, []);
  assert.equal((await dispatch(registry, { tool: 'owner_message', class: 'write', args })).ok, true);
  assert.equal(posts.length, 1);
});

const queueRow = (store, thread = 'thread-lead', worker = 'dot') =>
  store.db.prepare('INSERT INTO tool_outbox(tool,worker,kind,text,created_at,thread_id,idempotency_key,args_digest) VALUES(?,?,?,?,?,?,?,?)')
    .run('owner_message', worker, 'question', 'old', '2026-11-05T00:00:00.000Z', thread, null, null);
const unsent = store => store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL').get().n;
const failOutboxDeletes = store => store.db.exec("CREATE TRIGGER outbox_boom BEFORE DELETE ON tool_outbox BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");

test('an authority change and its outbox cleanup are one transaction', () => {
  for (const [label, change, stillTrue] of [
    ['remove', r => r.remove('owner_message'), r => r.list().length === 1],
    ['revoke', r => r.revoke('owner_message', 'dot'), r => r.list()[0].workers.includes('dot')],
    ['disable', r => r.setEnabled('owner_message', false), r => r.list()[0].enabled === true],
  ]) {
    const { store, registry } = postFixture();
    registry.register(postSpec());
    registry.grant('owner_message', 'dot');
    queueRow(store);
    const version = registry.registryVersion();
    failOutboxDeletes(store);
    assert.throws(() => change(registry), /simulated crash/, label);
    assert.equal(stillTrue(registry), true, `${label}: the authority change rolled back with the failed cleanup`);
    assert.equal(unsent(store), 1, label);
    assert.equal(registry.registryVersion(), version, label);
    assert.equal(store.db.isTransaction, false, label);
    store.db.exec('DROP TRIGGER outbox_boom');
    change(registry);
    assert.equal(unsent(store), 0, label);
  }
});

test('registering a name discards unsent rows left under it', () => {
  const { store, registry } = postFixture();
  queueRow(store);
  registry.register(postSpec());
  assert.equal(unsent(store), 0);
});

test('queued rows the timer can never deliver are pruned, so hasHeld cannot stay true', async () => {
  const posts = [];
  const store = new Store(path.join(scratch, `prune-${counter++}.db`));
  const t3 = createT3PostHandler({ store, post: async p => { posts.push(p); } });
  const registry = createToolRegistry({ store, handlers: { t3_post: t3 } });
  registry.register(postSpec());
  registry.grant('owner_message', 'dot');
  queueRow(store, '');
  queueRow(store, 'thread-elsewhere');
  queueRow(store, 'thread-lead', 'stranger');
  assert.equal(t3.hasHeld(), false);
  assert.equal(unsent(store), 0);
  queueRow(store, '');
  assert.equal(await t3.flushDue(), 0);
  assert.equal(unsent(store), 0);
  queueRow(store);
  assert.equal(t3.hasHeld(), true);
  assert.equal(await t3.flushDue(), 1);
  assert.equal(posts.length, 1);
});

test('the documented owner_message example registers as written', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'worker-clients.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## Operator-registered tools'));
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)[1].replaceAll('THREAD_ID', 'thread-1'));
  assert.equal(example.class, 'write');
  const { registry } = postFixture();
  assert.equal(registry.register(example).name, 'owner_message');
  assert.equal(codeSync(() => postFixture().registry.register({ ...example, class: 'read' })), 'invalid_tool');
});

test('owner_message: kinds, length, fixed thread, sender label, one per 10 minutes with merge, failure keeps queue', async () => {
  const posts = []; let failNext = null;
  const post = async p => { if (failNext) { const e = failNext; failNext = null; throw e; } posts.push(p); };
  let time = Date.parse('2026-11-05T00:00:00Z');
  const store = new Store(path.join(scratch, `lead-${counter++}.db`));
  const t3 = createT3PostHandler({ store, post, now: () => time });
  const registry = createToolRegistry({ store, now: () => time, handlers: { t3_post: t3 } });
  registry.register({ name: 'owner_message', description: 'Message the owner', class: 'write',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', maxLength: 2000 } }, required: ['kind', 'text'] },
    handler: { kind: 't3_post', thread_id: 'thread-lead' } });
  assert.equal(codeSync(() => registry.register({ name: 'bad_post', description: 'x', class: 'write', inputSchema: { type: 'object', properties: {} }, handler: { kind: 't3_post' } })), 'invalid_tool');
  registry.grant('owner_message', 'dot');
  const send = (args, worker = 'dot') => dispatch(registry, { worker, tool: 'owner_message', class: 'write', args });

  assert.equal(await code(send({ kind: 'capacity', text: 'x' })), 'invalid_arguments');
  assert.equal(await code(send({ kind: 'question', text: 'x'.repeat(2001) })), 'invalid_arguments');
  assert.equal(await code(send({ kind: 'question', text: 'x', thread: 'other' })), 'invalid_arguments');

  assert.equal((await send({ kind: 'question', text: 'first' })).ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadId, 'thread-lead');
  assert.equal(posts[0].label, 'dot');
  assert.equal(posts[0].asOwner, undefined, 'never posted as the owner');
  assert.match(posts[0].text, /first/);

  time += 60_000; assert.equal((await send({ kind: 'question', text: 'second' })).result.queued, true);
  time += 60_000; assert.equal((await send({ kind: 'blocker', text: 'third' })).result.queued, true);
  assert.equal(posts.length, 1, 'over-limit messages are held, not sent');
  time += 10 * 60_000;
  failNext = Object.assign(new Error('t3 unavailable'), { exitCode: 3 });
  assert.equal(await code(send({ kind: 'question', text: 'fourth' })), 'handler_failed');
  assert.equal(posts.length, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL").get().n, 3, 'failed send keeps every message queued');
  failNext = null; time += 60_000;
  assert.equal((await send({ kind: 'question', text: 'fifth' })).ok, true);
  assert.equal(posts.length, 2);
  for (const word of ['second', 'third', 'fourth', 'fifth']) assert.match(posts[1].text, new RegExp(word), `merged message holds ${word}`);
  assert.match(posts[1].text, /blocker/);
  assert.equal(store.db.prepare("SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL").get().n, 0);
});

test('registering or removing a tool leaves the served tools/list byte for byte identical', { timeout: 60000 }, async () => {
  const home = path.join(scratch, 'server-home');
  fs.mkdirSync(path.join(home, '.config/dot-bridge'), { recursive: true, mode: 0o700 });
  const port = await reservedPort();
  // The advertised list is fixed per modern catalog profile and global T3 setting. Registry changes never alter it.
  const env = { HOME: home, DALAN_HOME: home, DALAN_LEGACY_PROFILE: '1', DALAN_CATALOG_PROFILE: 'stable', PATH: process.env.PATH, NODE_ENV: 'test', DOT_BRIDGE_ALLOW_INSECURE_PUBLIC: '1', DOT_BRIDGE_BIND_HOST: '127.0.0.1', DOT_BRIDGE_PORT: String(port) };
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => errors += d);
  try {
    for (let i = 0; i < 400 && !/MCP listening/.test(output) && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
    assert(/MCP listening/.test(output), 'server started: ' + errors);
    const secret = /BRIDGE_PATH_SECRET=(.+)/.exec(fs.readFileSync(path.join(home, '.config/dot-bridge/env'), 'utf8'))[1];
    const listBytes = async () => (await fetch(`http://127.0.0.1:${port}/${secret}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).text();
    const cli = (...args) => spawnSync(process.execPath, ['bin/dalan.mjs', 'tool', ...args], { cwd: root, env, encoding: 'utf8' });
    const specFile = path.join(scratch, 'tool.json');
    fs.writeFileSync(specFile, JSON.stringify({ name: 'cli_tool', description: 'x', class: 'write', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', maxLength: 2000 } }, required: ['kind', 'text'] }, handler: { kind: 't3_post', thread_id: 'thread-x' } }));
    const before = await listBytes();
    assert(before.length > 100);
    let r = cli('add', '--file', specFile, '--json'); assert.equal(r.status, 0, r.stderr + r.stdout);
    r = cli('grant', 'cli_tool', 'dot', '--json'); assert.equal(r.status, 0, r.stderr);
    r = cli('list', '--json'); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).tools.map(t => t.name), ['cli_tool']);
    assert.deepEqual(JSON.parse(r.stdout).tools[0].workers, ['dot']);
    const during = await listBytes();
    r = cli('revoke', 'cli_tool', 'dot', '--json'); assert.equal(r.status, 0, r.stderr);
    r = cli('remove', 'cli_tool', '--json'); assert.equal(r.status, 0, r.stderr);
    const after = await listBytes();
    assert.equal(during, before); assert.equal(after, before);
    const status = spawnSync(process.execPath, ['bin/dalan.mjs', 'status', '--json'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).last_registry_change.kind, 'remove');
  } finally {
    if (child.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); });
  }
});

// ---- default delivery: the host `t3-post` command -----------------------------------------------------------------
function fakeT3Post() {
  const dir = fs.mkdtempSync(path.join(scratch, 'fakebin-'));
  const log = path.join(dir, 'calls.log'), stdinFile = path.join(dir, 'stdin.txt'), exitFile = path.join(dir, 'exit');
  fs.writeFileSync(exitFile, '0');
  const errorToken = randomBytes(18).toString('hex');
  fs.writeFileSync(path.join(dir, 't3-post'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nprintf '@@END@@\\n' >> '${log}'\ncat > '${stdinFile}'\ncode=$(cat '${exitFile}')\n[ "$code" = 0 ] || echo "boom token=${errorToken}" >&2\nexit "$code"\n`, { mode: 0o755 });
  return {
    dir, errorToken, setExit: n => fs.writeFileSync(exitFile, String(n)),
    argv: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('@@END@@\n').filter(Boolean).map(c => c.split('\n').filter(Boolean)),
    stdin: () => fs.readFileSync(stdinFile, 'utf8'),
  };
}
async function withPath(dir, fn) {
  const saved = process.env.PATH; process.env.PATH = `${dir}:${saved}`;
  try { return await fn(); } finally { process.env.PATH = saved; }
}

test('default delivery spawns t3-post: argv, stdin message, exit 3 keeps queue, timer flush sends later', async () => {
  const fake = fakeT3Post();
  await withPath(fake.dir, async () => {
    let time = Date.parse('2026-11-05T00:00:00Z');
    const store = new Store(path.join(scratch, `t3p-${counter++}.db`));
    const t3 = createT3PostHandler({ store, now: () => time });
    const registry = createToolRegistry({ store, now: () => time, handlers: { t3_post: t3 } });
    registry.register({ name: 'owner_message', description: 'Message the owner', class: 'write',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', maxLength: 2000 } }, required: ['kind', 'text'] },
      handler: { kind: 't3_post', thread_id: 'thread-lead' } });
    registry.grant('owner_message', 'dot');
    const send = args => dispatch(registry, { worker: 'dot', tool: 'owner_message', class: 'write', args });
    const secretText = 'unique-body-$(touch pwned)-"quoted"';

    fake.setExit(3);
    assert.equal(await code(send({ kind: 'question', text: secretText })), 'handler_failed');
    assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL').get().n, 1, 'exit 3 keeps the message queued');
    const first = fake.argv()[0];
    assert.deepEqual(first, ['--as', 'dot', '--kind', 'script', '--mode', 'queue', '--thread', 'thread-lead']);
    assert(!first.join(' ').includes('unique-body'), 'message is never in argv');
    assert.match(fake.stdin(), /unique-body/);
    assert(!fs.existsSync(path.join(root, 'pwned')));

    fake.setExit(0);
    assert.equal(await t3.flushDue(), 1, 'timer flush sends the held message');
    assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL').get().n, 0);
    assert.equal(fake.argv().length, 2);
    assert.match(fake.stdin(), /unique-body/);

    // rate window: a held message is not flushed until the window has passed
    time += 60_000;
    assert.equal((await send({ kind: 'blocker', text: 'later' })).result.queued, true);
    assert.equal(await t3.flushDue(), 0, 'inside the rate window');
    time += 10 * 60_000;
    assert.equal(await t3.flushDue(), 1, 'after the window');
    assert.match(fake.stdin(), /later/);

    // other nonzero exit: handler_failed, message kept, error text redacted
    fake.setExit(1);
    time += 11 * 60_000;
    let err; try { await send({ kind: 'question', text: 'x' }); } catch (e) { err = e; }
    assert.equal(err.code, 'handler_failed');
    assert(!String(err.message).includes(fake.errorToken));
    assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL').get().n, 1);
  });
});

test('default delivery: spawn failure and timeout keep the message; sender name is sanitised', async () => {
  const store = new Store(path.join(scratch, `t3p-${counter++}.db`));
  const t = (opts) => createT3PostHandler({ store, now: () => Date.parse('2026-11-05T00:00:00Z'), ...opts });
  await assert.rejects(() => t({ command: 'no-such-t3-post-cmd' }).run(callArgs()));
  const fake = fakeT3Post();
  fs.writeFileSync(path.join(fake.dir, 't3-post'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  const started = Date.now();
  await withPath(fake.dir, () => assert.rejects(() => t({ timeoutMs: 200 }).run(callArgs())));
  assert(Date.now() - started < 3000, 'killed on timeout');
  assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL').get().n, 2);
  const ok = fakeT3Post();
  await withPath(ok.dir, () => t({}).run(callArgs('Do.T Worker/é!')));
  assert.equal(ok.argv()[0][1], 'Do-T-Worker---', 'only characters t3-post accepts');
});
test('the owner_message budget is shared by every t3_post tool', async () => {
  const store = new Store(path.join(scratch, `t3p-${counter++}.db`));
  const handler = createT3PostHandler({ store, now: () => Date.parse('2026-11-05T00:00:00Z'), post: async () => {}, hourlyCap: 2 });
  const as = (tool, worker) => ({ ...callArgs(worker), tool });
  await handler.run(as('owner_message', 'w1'));
  await handler.run(as('other_message', 'w2'));
  await assert.rejects(() => handler.run(as('owner_message', 'w3')), error => error.code === 'rate_limited');
  await assert.rejects(() => handler.run(as('third_message', 'w4')), error => error.code === 'rate_limited');
});

test('concurrent calls with one idempotency key run the handler once', async () => {
  const dbPath = path.join(scratch, `bridge-${counter++}.db`);
  const store = new Store(dbPath);
  const other = new Store(dbPath);
  let ticks = 0, runs = 0, release; // ticks counts clock reads once armed: 2 is the expiry sweep, 3 comes after the lookup
  const gate = new Promise(resolve => { release = resolve; });
  // A twin process reserves the key after this call's lookup and before its own reservation.
  const clock = () => { if (ticks && ++ticks === 3) other.db.prepare("INSERT INTO tool_idempotency(worker,tool,key,state,outcome,created_at,lease_expires_at) VALUES('dot','echo_tool','twin','pending',NULL,'2026-11-05T00:00:00.000Z','2026-11-05T00:00:45.000Z')").run(); return Date.parse('2026-11-05T00:00:00Z'); };
  const slow = { run: async () => { runs++; await gate; return {}; } };
  const registry = createToolRegistry({ store, now: clock, handlers: { echo: slow } });
  registry.register(spec({ class: 'write' })); registry.grant('echo_tool', 'dot');
  const hash = hashOf(registry, 'dot', 'echo_tool');
  const call = key => registry.callTool({ worker: 'dot', tool: 'echo_tool', class: 'write', args: { text: 'x' }, schema_hash: hash, idempotency_key: key });
  ticks = 1;
  const lost = await code(call('twin'));
  ticks = 0;
  assert.equal(lost, 'in_progress', 'the loser gets the in-progress refusal, not a raw database error');
  assert.equal(runs, 0);
  // Overlapping calls in one process: one handler run, the other refused while it is pending.
  const first = call('same');
  const second = await code(call('same'));
  assert.equal(second, 'in_progress');
  release();
  assert.equal((await first).ok, true);
  assert.equal(runs, 1);
  assert.equal((await call('same')).replayed, true, 'after it finishes, the stored result is replayed');
  assert.equal(runs, 1);
});

function callArgs(worker = 'dot') {
  return { tool: 'owner_message', worker, args: { kind: 'question', text: 'hi' }, config: { thread_id: 'thread-lead' } };
}

test('no owner fallback: delivery never uses t3code threads send', () => {
  const src = fs.readFileSync(path.join(root, 'src/tool-registry.mjs'), 'utf8');
  assert(!/threads['",\s]+send/.test(src) && !/callT3/.test(src) && !/\[agent:/.test(src));
});

test('server runs the outbox flush on a 60 s unref timer', () => {
  const src = fs.readFileSync(path.join(root, 'src/server.mjs'), 'utf8');
  assert(/setInterval\([^\n]*flushDue[^\n]*60000\)\.unref\(\)/.test(src));
});

// ======================================================================================================================
// Hardening: one enforcement function with a fixed order, schema-hash pinning, idempotency, a real validator, caps.
// ======================================================================================================================
const lastCode = async promise => { try { await promise; } catch (e) { assert(e instanceof RegistryError, String(e)); return { code: e.code, message: e.message }; } assert.fail('expected RegistryError'); };
const hashSchema = { type: 'object', properties: { text: { type: 'string', maxLength: 50 } }, required: ['text'] };

test('enforcement order: lookup, grant, class, hash, idempotency, arguments, rate limit, handler; each refusal fires alone', async () => {
  const { registry, calls } = fixture({ callsPerMinute: 2 });
  registry.register(spec({ name: 'reader' })); registry.register(spec({ name: 'writer', class: 'write' }));
  registry.grant('reader', 'dot'); registry.grant('writer', 'dot');
  const good = { text: 'x' };
  const hash = () => hashOf(registry, 'dot', 'writer');
  const call = o => registry.callTool({ worker: 'dot', tool: 'writer', class: 'write', args: good, schema_hash: hash(), idempotency_key: 'k-order', ...o });

  // 1. lookup is an exact match; nothing is normalised
  for (const tool of ['Writer', 'writer ', ' writer', 'WRITER', 'writer\n', 'writer\u0000', '', 5, null, undefined, {}]) assert.equal((await lastCode(call({ tool }))).code, 'tool_unavailable', JSON.stringify(tool));
  // unknown and ungranted are indistinguishable, even when everything else is wrong too
  const unknown = await lastCode(call({ tool: 'nope', class: 'read', schema_hash: 'bad', idempotency_key: undefined, args: 5 }));
  const ungranted = await lastCode(call({ worker: 'other', class: 'read', schema_hash: 'bad', idempotency_key: undefined, args: 5 }));
  assert.deepEqual(unknown, ungranted);
  assert.equal(unknown.code, 'tool_unavailable');
  // 2. class, even when the hash, the key and the arguments are wrong too
  assert.equal((await lastCode(call({ class: 'read', schema_hash: 'bad', idempotency_key: undefined, args: 5 }))).code, 'wrong_class');
  assert.equal((await lastCode(call({ class: 'admin' }))).code, 'wrong_class');
  // 3. hash, even when the key and the arguments are wrong too
  assert.equal((await lastCode(call({ schema_hash: 'bad', idempotency_key: undefined, args: 5 }))).code, 'stale_registry');
  assert.equal((await lastCode(call({ schema_hash: undefined }))).code, 'stale_registry', 'a write call must carry the hash');
  // 4. the idempotency key, even when the arguments are wrong too
  for (const key of [undefined, '', 5, 'k'.repeat(129)]) assert.equal((await lastCode(call({ idempotency_key: key, args: 5 }))).code, 'invalid_arguments', String(key));
  assert.match((await lastCode(call({ idempotency_key: undefined }))).message, /idempotency_key/);
  // 5. arguments, before the rate limit
  assert.equal((await lastCode(call({ idempotency_key: 'k-bad', args: { text: 5 } }))).code, 'invalid_arguments');
  assert.equal(calls.length, 0, 'no handler ran for any refusal');
  // 6. rate limit (2 per minute) after valid arguments; bad arguments still report invalid_arguments past the limit
  assert.equal((await call({ idempotency_key: 'k-1' })).ok, true);
  assert.equal((await call({ idempotency_key: 'k-2' })).ok, true);
  assert.equal((await lastCode(call({ idempotency_key: 'k-3' }))).code, 'rate_limited');
  assert.equal((await lastCode(call({ idempotency_key: 'k-4', args: { text: 5 } }))).code, 'invalid_arguments');
  assert.equal(calls.length, 2);
  // a rate-limited call did not consume its key
  const { registry: other, calls: otherCalls, time } = fixture({ callsPerMinute: 1 });
  other.register(spec({ class: 'write' })); other.grant('echo_tool', 'dot');
  const again = () => other.callTool({ worker: 'dot', tool: 'echo_tool', class: 'write', args: good, schema_hash: hashOf(other, 'dot', 'echo_tool'), idempotency_key: 'same' });
  assert.equal((await again()).replayed, undefined);
  assert.equal((await lastCode(other.callTool({ worker: 'dot', tool: 'echo_tool', class: 'write', args: good, schema_hash: hashOf(other, 'dot', 'echo_tool'), idempotency_key: 'second' }))).code, 'rate_limited');
  time.ms += 61_000;
  assert.equal((await other.callTool({ worker: 'dot', tool: 'echo_tool', class: 'write', args: good, schema_hash: hashOf(other, 'dot', 'echo_tool'), idempotency_key: 'second' })).ok, true);
  assert.equal(otherCalls.length, 2);
});

test('every refusal has a machine-readable code and the error text holds no registry contents', async () => {
  const { registry } = fixture();
  const description = 'PRIVATE-DESCRIPTION-9f3';
  registry.register(spec({ name: 'visible_tool', description, class: 'write' }));
  registry.register(spec({ name: 'secret_other_tool', description: 'x' }));
  registry.grant('visible_tool', 'dot');
  const base = { worker: 'dot', tool: 'visible_tool', class: 'write', args: { text: 'x' }, schema_hash: hashOf(registry, 'dot', 'visible_tool'), idempotency_key: 'k' };
  const refusals = {
    tool_unavailable: [{ tool: 'secret_other_tool' }, { tool: 'nope' }],
    wrong_class: [{ class: 'read' }], stale_registry: [{ schema_hash: 'x'.repeat(64) }], invalid_arguments: [{ args: { text: 5 } }],
  };
  for (const [wanted, variants] of Object.entries(refusals)) for (const variant of variants) {
    const { code: got, message } = await lastCode(registry.callTool({ ...base, ...variant }));
    assert.equal(got, wanted);
    for (const secret of [description, 'secret_other_tool', 'echo_tool', 'visible_tool', '"echo"']) if (wanted !== 'invalid_arguments') assert(!message.includes(secret), `${wanted} leaked ${secret}`);
    assert(!message.includes(description) && !message.includes('secret_other_tool'));
  }
  assert.equal((await lastCode(registry.callTool({ ...base, schema_hash: 'x' }))).message, 'call list_tools again');
});

test('list_tools carries a monotonic registry_version that moves on every registry change and survives restarts', () => {
  const { registry, store } = fixture();
  const versions = [registry.listTools('dot').registry_version];
  const step = () => versions.push(registry.listTools('dot').registry_version);
  registry.register(spec()); step();
  registry.grant('echo_tool', 'dot'); step();
  registry.setEnabled('echo_tool', false); step();
  registry.setEnabled('echo_tool', true); step();
  registry.revoke('echo_tool', 'dot'); step();
  registry.grant('echo_tool', 'dot'); step();
  registry.remove('echo_tool'); step();
  for (let i = 1; i < versions.length; i++) assert(versions[i] > versions[i - 1], `step ${i}: ${versions.join(',')}`);
  assert(Number.isSafeInteger(versions[0]));
  assert.equal(codeSync(() => registry.register(spec({ class: 'admin' }))), 'invalid_tool');
  assert.equal(registry.listTools('dot').registry_version, versions.at(-1), 'a refused change does not move the version');
  const reopened = createToolRegistry({ store, handlers: { echo: { run: async () => ({}) } } });
  assert.equal(reopened.listTools('dot').registry_version, versions.at(-1));
  assert.equal(registry.listTools('nobody').registry_version, versions.at(-1), 'the version is global; the tool list is per caller');
});

test('schema hash covers name, description, schema, class, handler kind and config, and the caller grant set', async () => {
  const { registry, store } = fixture({ handlers: { other_kind: { configKeys: ['thread_id'], run: async () => ({}) }, echo2: { run: async () => ({}) } } });
  registry.register(spec({ name: 'subject', handler: { kind: 'other_kind', thread_id: 'thread-a' } }));
  registry.grant('subject', 'dot'); registry.grant('subject', 'other');
  const base = hashOf(registry, 'dot', 'subject');
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.notEqual(hashOf(registry, 'other', 'subject'), base, 'the hash is specific to the caller');
  assert.equal(hashOf(registry, 'dot', 'subject'), base, 'and stable');
  const mutate = (column, value) => { store.db.prepare(`UPDATE registered_tools SET ${column}=? WHERE name='subject'`).run(value); };
  const row = () => store.db.prepare("SELECT * FROM registered_tools WHERE name='subject'").get();
  const seen = new Set([base]);
  const change = (column, value) => {
    const saved = row()[column]; mutate(column, value);
    const next = hashOf(registry, 'dot', 'subject');
    assert(!seen.has(next), `${column} change moves the hash`); seen.add(next); mutate(column, saved);
    assert.equal(hashOf(registry, 'dot', 'subject'), base, `${column} restored`);
  };
  change('description', 'a different description');
  change('input_schema', JSON.stringify({ type: 'object', properties: { text: { type: 'string', maxLength: 51 } }, required: ['text'], additionalProperties: false }));
  change('class', 'write');
  change('handler', JSON.stringify({ kind: 'echo2' }));
  change('handler', JSON.stringify({ kind: 'other_kind', thread_id: 'thread-b' }));
  registry.register(spec({ name: 'second', handler: { kind: 'echo2' } }));
  registry.grant('second', 'dot');
  assert.notEqual(hashOf(registry, 'dot', 'subject'), base, 'a new grant for the caller moves every hash for the caller');
  assert(!seen.has(hashOf(registry, 'dot', 'subject')));
  // the new hash is what the call requires; the old one is stale
  const stale = await lastCode(registry.callTool({ worker: 'dot', tool: 'subject', class: 'read', args: { text: 'x' }, schema_hash: base }));
  assert.equal(stale.code, 'stale_registry');
  assert.equal((await registry.callTool({ worker: 'dot', tool: 'subject', class: 'read', args: { text: 'x' }, schema_hash: hashOf(registry, 'dot', 'subject') })).ok, true);
});

test('a changed handler target is a stale hash even though the input schema is unchanged (the rug pull)', async () => {
  const { registry, store, calls } = fixture();
  registry.register(spec({ class: 'write' })); registry.grant('echo_tool', 'dot');
  const seen = hashOf(registry, 'dot', 'echo_tool');
  store.db.prepare("UPDATE registered_tools SET handler=? WHERE name='echo_tool'").run(JSON.stringify({ kind: 'echo', redirected: true }));
  const refused = await lastCode(registry.callTool({ worker: 'dot', tool: 'echo_tool', class: 'write', args: { text: 'x' }, schema_hash: seen, idempotency_key: 'k' }));
  assert.equal(refused.code, 'stale_registry');
  assert.equal(calls.length, 0);
});

test('read calls may omit the hash and key; a wrong hash is still refused; write calls need both', async () => {
  const { registry, calls } = fixture();
  registry.register(spec({ name: 'r' })); registry.register(spec({ name: 'w', class: 'write' }));
  registry.grant('r', 'dot'); registry.grant('w', 'dot');
  const args = { text: 'x' };
  assert.equal((await registry.callTool({ worker: 'dot', tool: 'r', class: 'read', args })).ok, true);
  assert.equal((await registry.callTool({ worker: 'dot', tool: 'r', class: 'read', args })).ok, true, 'no key, no memory: it runs again');
  assert.equal(calls.length, 2);
  assert.equal((await lastCode(registry.callTool({ worker: 'dot', tool: 'r', class: 'read', args, schema_hash: 'bad' }))).code, 'stale_registry');
  assert.equal((await lastCode(registry.callTool({ worker: 'dot', tool: 'w', class: 'write', args, idempotency_key: 'k' }))).code, 'stale_registry');
  assert.equal((await lastCode(registry.callTool({ worker: 'dot', tool: 'w', class: 'write', args, schema_hash: hashOf(registry, 'dot', 'w') }))).code, 'invalid_arguments');
});

test('idempotency: the outcome is stored before the handler runs and a repeat returns it without re-running', async () => {
  let during;
  const { registry, store, calls, time } = fixture({ handlers: { watch: { run: async ({ args }) => { during = store.db.prepare('SELECT * FROM tool_idempotency').all(); calls.push(args); return { n: calls.length }; } } } });
  registry.register(spec({ handler: { kind: 'watch' }, class: 'write' })); registry.grant('echo_tool', 'dot');
  const send = (key, args = { text: 'x' }, worker = 'dot') => registry.callTool({ worker, tool: 'echo_tool', class: 'write', args, schema_hash: hashOf(registry, worker, 'echo_tool'), idempotency_key: key });
  const first = await send('key-a');
  assert.equal(first.result.n, 1);
  assert.equal(during.length, 1, 'a row existed while the handler ran');
  assert.equal(during[0].worker, 'dot'); assert.equal(during[0].tool, 'echo_tool'); assert.equal(during[0].key, 'key-a');
  const repeat = await send('key-a');
  assert.deepEqual(repeat.result, first.result);
  assert.equal(repeat.replayed, true);
  assert.equal(calls.length, 1, 'the handler did not run again');
  // the stored outcome wins even when the repeat carries different, or invalid, arguments
  assert.equal((await send('key-a', { text: 5 })).replayed, true);
  assert.equal(calls.length, 1);
  // a new key runs
  assert.equal((await send('key-b')).result.n, 2);
  // survives a restart of the registry object
  const reopened = createToolRegistry({ store, now: () => time.ms, handlers: { watch: { run: async () => { throw new Error('must not run'); } } } });
  assert.equal((await reopened.callTool({ worker: 'dot', tool: 'echo_tool', class: 'write', args: { text: 'x' }, schema_hash: hashOf(reopened, 'dot', 'echo_tool'), idempotency_key: 'key-a' })).replayed, true);
});

test('idempotency keys are scoped to worker and tool, and expire after 7 days', async () => {
  const { registry, store, calls, time } = fixture();
  registry.register(spec({ name: 'one', class: 'write' })); registry.register(spec({ name: 'two', class: 'write' }));
  for (const tool of ['one', 'two']) for (const worker of ['dot', 'w2']) registry.grant(tool, worker);
  const send = (tool, worker, key = 'shared') => registry.callTool({ worker, tool, class: 'write', args: { text: 'x' }, schema_hash: hashOf(registry, worker, tool), idempotency_key: key });
  await send('one', 'dot'); await send('one', 'w2'); await send('two', 'dot'); await send('two', 'w2');
  assert.equal(calls.length, 4, 'same key, different worker or tool: each runs once');
  await send('one', 'dot'); await send('two', 'w2');
  assert.equal(calls.length, 4);
  time.ms += 6 * 86_400_000;
  await send('one', 'dot');
  assert.equal(calls.length, 4, 'still remembered after 6 days');
  time.ms += 86_400_000 + 1000;
  await send('one', 'dot');
  assert.equal(calls.length, 5, 'forgotten after 7 days');
  assert(store.db.prepare('SELECT count(*) n FROM tool_idempotency').get().n <= 5, 'expired rows are removed');
});

test('idempotency after a failure: only a provable non-delivery may run again with the same key', async () => {
  let mode = 'timeout'; let runs = 0;
  const { registry } = fixture({ handlers: { flaky: { run: async () => {
    runs++;
    if (mode === 'timeout') throw Object.assign(new Error('x'), { userMessage: 'timed out' });
    if (mode === 'not_delivered') throw Object.assign(new Error('x'), { userMessage: 'not sent', notDelivered: true });
    return { done: true };
  } } } });
  registry.register(spec({ handler: { kind: 'flaky' }, class: 'write' })); registry.grant('echo_tool', 'dot');
  const send = key => registry.callTool({ worker: 'dot', tool: 'echo_tool', class: 'write', args: { text: 'x' }, schema_hash: hashOf(registry, 'dot', 'echo_tool'), idempotency_key: key });
  assert.equal((await lastCode(send('k-timeout'))).code, 'handler_failed');
  mode = 'ok';
  assert.equal((await lastCode(send('k-timeout'))).code, 'handler_failed', 'delivery is unknown: the stored failure is returned');
  assert.equal(runs, 1, 'and the handler did not run again');
  mode = 'not_delivered';
  assert.equal((await lastCode(send('k-safe'))).code, 'handler_failed');
  mode = 'ok';
  assert.equal((await send('k-safe')).result.done, true, 'provably undelivered: the same key may retry');
  assert.equal(runs, 3);
  assert.equal((await send('k-safe')).replayed, true, 'and the success is remembered');
  assert.equal(runs, 3);
});

test('a call whose first attempt is still inside its lease is not run twice', async () => {
  const { registry, store, calls } = fixture();
  registry.register(spec({ class: 'write' })); registry.grant('echo_tool', 'dot');
  store.db.prepare("INSERT INTO tool_idempotency(worker,tool,key,state,outcome,created_at,lease_expires_at) VALUES('dot','echo_tool','crashed','pending',NULL,'2026-11-05T00:00:00.000Z','2026-11-05T00:00:45.000Z')").run();
  const refused = await lastCode(registry.callTool({ worker: 'dot', tool: 'echo_tool', class: 'write', args: { text: 'x' }, schema_hash: hashOf(registry, 'dot', 'echo_tool'), idempotency_key: 'crashed' }));
  assert.equal(refused.code, 'in_progress');
  assert.equal(calls.length, 0);
});

test('a handler never takes its target from arguments', async () => {
  const posts = [];
  const store = new Store(path.join(scratch, `target-${counter++}.db`));
  const registry = createToolRegistry({ store, handlers: { t3_post: createT3PostHandler({ store, post: async p => { posts.push(p); } }) } });
  registry.register({ name: 'owner_message', description: 'Message the owner', class: 'write', handler: { kind: 't3_post', thread_id: 'thread-fixed' },
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', maxLength: 2000 }, thread_id: { type: 'string', maxLength: 64 }, threadId: { type: 'string', maxLength: 64 } }, required: ['kind', 'text'] } });
  registry.grant('owner_message', 'dot');
  await dispatch(registry, { tool: 'owner_message', class: 'write', args: { kind: 'question', text: 'hi', thread_id: 'thread-evil', threadId: 'thread-evil' } });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].threadId, 'thread-fixed');
});

test('registered tools use the real validator: nested objects, patterns, depth; unsupported keywords are refused at register time', async () => {
  const { registry, calls } = fixture();
  const nested = { type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'string', pattern: '^[a-z]+$', maxLength: 10 }, tags: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } } }, required: ['inner'] } }, required: ['outer'] };
  registry.register(spec({ inputSchema: nested })); registry.grant('echo_tool', 'dot');
  const call = args => dispatch(registry, { tool: 'echo_tool', class: 'read', args });
  assert.equal((await call({ outer: { inner: 'abc', tags: [{ id: 1 }] } })).ok, true);
  assert.equal(await code(call({ outer: { inner: 'abc', extra: 1 } })), 'invalid_arguments', 'unknown key one level down');
  assert.equal(await code(call({ outer: { inner: 'abc', tags: [{ id: 1, extra: 1 }] } })), 'invalid_arguments', 'unknown key inside an array of objects');
  assert.equal(await code(call({ outer: { inner: 'ABC' } })), 'invalid_arguments', 'pattern');
  assert.equal(await code(call({ outer: {} })), 'invalid_arguments', 'nested required');
  assert.equal(await code(call({ outer: { inner: 'abc', tags: [{ id: 'x' }] } })), 'invalid_arguments', 'nested type');
  assert.equal(calls.length, 1);
  const size = await code(call({ outer: { inner: 'abc', tags: Array.from({ length: 100 }, () => ({ id: 1 })), pad: 'x'.repeat(70000) } }));
  assert.equal(size, 'invalid_arguments');
  for (const [name, inputSchema] of [
    ['ref', { type: 'object', properties: { a: { $ref: '#/x' } } }],
    ['oneof', { type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } }],
    ['unsafe pattern', { type: 'object', properties: { a: { type: 'string', pattern: '(a+)+$' } } }],
    ['too deep', { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'object', properties: { e: { type: 'object', properties: { f: { type: 'object', properties: { g: { type: 'string' } } } } } } } } } } } } } } }],
  ]) assert.equal(codeSync(() => registry.register(spec({ name: `bad_${name.replace(' ', '_')}`, inputSchema }))), 'invalid_schema', name);
});

test('results are redacted and capped at 32 KiB with truncated:true', async () => {
  const secret = 'ghp_' + randomBytes(18).toString('hex');
  const { registry } = fixture({ handlers: { big: { run: async () => ({ text: `${secret} ${'z'.repeat(200000)}` }) }, medium: { run: async () => ({ text: 'q'.repeat(20000) }) } } });
  for (const kind of ['big', 'medium']) { registry.register(spec({ name: kind, handler: { kind } })); registry.grant(kind, 'dot'); }
  const big = (await dispatch(registry, { tool: 'big', args: { text: 'x' } })).result;
  const text = JSON.stringify(big);
  assert.equal(big.truncated, true);
  assert(text.length <= 32768, `capped: ${text.length}`);
  assert(!text.includes(secret));
  const medium = (await dispatch(registry, { tool: 'medium', args: { text: 'x' } })).result;
  assert.equal(medium.truncated, undefined, '20 KB fits the cap');
  assert.equal(medium.text.length, 20000);
});

// ---- owner_message: global budgets, retries, and the post log ----------------------------------------------------------
function leadFixture(opts = {}) {
  const posts = []; const behaviour = { fail: null };
  const post = async p => { if (behaviour.fail) throw behaviour.fail; posts.push(p); };
  const time = { ms: Date.parse('2026-11-05T00:00:00Z') };
  const store = new Store(path.join(scratch, `lead-${counter++}.db`));
  const t3 = createT3PostHandler({ store, post, now: () => time.ms, ...opts });
  const registry = createToolRegistry({ store, now: () => time.ms, handlers: { t3_post: t3 }, callsPerMinute: 1000 });
  registry.register({ name: 'owner_message', description: 'Message the owner', class: 'write',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', maxLength: 2000 } }, required: ['kind', 'text'] },
    handler: { kind: 't3_post', thread_id: 'thread-lead' } });
  const send = (worker, args = { kind: 'question', text: 'hi' }, key) => { registry.grant('owner_message', worker); return dispatch(registry, { worker, tool: 'owner_message', class: 'write', args, ...(key ? { idempotency_key: key } : {}) }); };
  return { posts, behaviour, time, store, registry, send, t3 };
}

test('owner_message global budget: 6 per hour and 30 per day across workers; held and retried messages count', async () => {
  const { posts, time, send, store } = leadFixture();
  const workers = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];
  for (const w of workers.slice(0, 6)) assert.equal((await send(w)).ok, true);
  assert.equal(posts.length, 6);
  assert.equal((await lastCode(send('w7'))).code, 'rate_limited', 'the seventh message in an hour');
  assert.equal((await lastCode(send('w1'))).code, 'rate_limited', 'a held message would count too, so it is refused at the cap');
  assert.equal(posts.length, 6);
  // held messages count: inside the per-worker window w1 sends again, is held, and still uses budget
  time.ms += 61 * 60_000;
  assert.equal((await send('w1')).ok, true); // sent (window passed)
  assert.equal((await send('w1')).result.queued, true); // held inside the 10-minute window
  const hourRows = store.db.prepare("SELECT outcome FROM tool_post_log WHERE outcome != 'rate_limited'").all();
  assert.equal(hourRows.length, 8, 'six sent, one sent, one held');
  // daily cap: fill to 30 over several hours
  let total = hourRows.length;
  let step = 0;
  while (total < 30) {
    time.ms += 61 * 60_000; step++;
    for (const w of workers.slice(0, Math.min(6, 30 - total))) { await send(w); total++; }
    assert(step < 10, 'loop guard');
  }
  time.ms += 61 * 60_000; // hourly budget is free again, the daily one is not
  assert.equal((await lastCode(send('w2'))).code, 'rate_limited', 'the 31st message in 24 hours');
  time.ms += 24 * 3_600_000;
  assert.equal((await send('w2')).ok, true, 'a day later it works again');
});

test('owner_message: every post is logged with its kind and outcome; retries are separate rows', async () => {
  const { send, store, behaviour } = leadFixture();
  await send('w1', { kind: 'blocker', text: 'first secret-body' });
  await send('w1', { kind: 'question', text: 'second' });
  behaviour.fail = Object.assign(new Error('boom'), { exitCode: 1 });
  await lastCode(send('w2', { kind: 'question', text: 'third' }));
  const rows = store.db.prepare('SELECT worker, message_kind, outcome FROM tool_post_log ORDER BY id').all();
  assert.deepEqual(rows.map(r => `${r.worker}:${r.message_kind}:${r.outcome}`), ['w1:blocker:sent', 'w1:question:held', 'w2:question:failed']);
  assert(!JSON.stringify(store.db.prepare('SELECT * FROM tool_post_log').all()).includes('secret-body'), 'no message text in the log');
});

test('owner_message exit 3: the same key retries without a duplicate outbox row; any other failure does not retry', async () => {
  const { posts, store, behaviour, send, time } = leadFixture();
  behaviour.fail = Object.assign(new Error('t3 busy'), { exitCode: 3 });
  assert.equal((await lastCode(send('w1', { kind: 'question', text: 'retry me' }, 'key-3'))).code, 'handler_failed');
  assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL').get().n, 1);
  behaviour.fail = null;
  assert.equal((await send('w1', { kind: 'question', text: 'retry me' }, 'key-3')).ok, true);
  assert.equal(posts.length, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox').get().n, 1, 'no duplicate row');
  assert.equal((await send('w1', { kind: 'question', text: 'retry me' }, 'key-3')).replayed, true);
  assert.equal(posts.length, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM tool_post_log').get().n, 2, 'both attempts are logged and count against the budget');
  time.ms += 11 * 60_000;
  behaviour.fail = Object.assign(new Error('exit 1'), { exitCode: 1 });
  assert.equal((await lastCode(send('w1', { kind: 'question', text: 'other' }, 'key-1'))).code, 'handler_failed');
  behaviour.fail = null;
  assert.equal((await lastCode(send('w1', { kind: 'question', text: 'other' }, 'key-1'))).code, 'handler_failed', 'delivery unknown: no re-run under the same key');
});

const settleSoon = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('overlapping flushes post each queued message exactly once', async () => {
  const gated = []; const posted = [];
  const post = p => new Promise(resolve => gated.push(() => { posted.push(p.text); resolve(); }));
  const { time, send, t3 } = leadFixture({ post });
  const release = async () => { for (let i = 0; i < 20; i++) { await settleSoon(); while (gated.length) gated.shift()(); } };
  const a = send('w1', { kind: 'question', text: 'alpha' });
  const b = send('w1', { kind: 'question', text: 'beta' });
  const timer = t3.flushDue();
  await release();
  await Promise.all([a, b, timer]);
  time.ms += 11 * 60_000;
  const later = t3.flushDue();
  await release();
  await later;
  const all = posted.join('\n');
  assert.equal(all.split('alpha').length - 1, 1, `alpha posted once: ${JSON.stringify(posted)}`);
  assert.equal(all.split('beta').length - 1, 1, `beta posted once: ${JSON.stringify(posted)}`);
});

test('timer retries of a failing post stay inside the hourly and daily budget', async () => {
  const attemptTimes = [];
  const notSent = Object.assign(new Error('t3 busy'), { exitCode: 3 });
  const { time, send, t3 } = leadFixture({ post: async () => { attemptTimes.push(time.ms); throw notSent; } });
  assert.equal((await lastCode(send('w1', { kind: 'question', text: 'retry' }))).code, 'handler_failed');
  for (let minute = 1; minute <= 120; minute++) { time.ms += 60_000; await t3.flushDue(); }
  for (const start of attemptTimes) assert(attemptTimes.filter(t => t >= start && t < start + 3_600_000).length <= 6, 'no hour holds more than 6 attempts');
  assert(attemptTimes.length <= 13, `two hours: ${attemptTimes.length} attempts`);
  assert(attemptTimes.length >= 6, 'it still retries when the budget allows');
});

test('a post that may have been delivered is marked uncertain, surfaced and not retried by the timer', async () => {
  let attempts = 0;
  const { time, send, t3, registry, store } = leadFixture({ post: async () => { attempts++; throw Object.assign(new Error('timed out'), { exitCode: 1 }); } });
  assert.equal((await lastCode(send('w1', { kind: 'question', text: 'maybe' }))).code, 'handler_failed');
  for (let minute = 1; minute <= 120; minute++) { time.ms += 60_000; await t3.flushDue(); }
  assert.equal(attempts, 1);
  assert.equal(t3.hasHeld(), false);
  assert.equal(registry.list()[0].uncertain, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL AND uncertain_at IS NOT NULL').get().n, 1);
});

test('t3_post never falls back to owner posting: a failing t3-post leaves every other command uncalled', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'nofallback-'));
  const log = path.join(dir, 'other-commands.log');
  for (const name of ['t3code', 't3', 'curl', 'wget', 't3-send']) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho ${name} >> '${log}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 't3-post'), '#!/bin/sh\ncat >/dev/null\nexit 3\n', { mode: 0o755 });
  await withPath(dir, async () => {
    const store = new Store(path.join(scratch, `nofb-${counter++}.db`));
    const handler = createT3PostHandler({ store, now: () => Date.parse('2026-11-05T00:00:00Z') });
    const registry = createToolRegistry({ store, handlers: { t3_post: handler } });
    registry.register({ name: 'owner_message', description: 'm', class: 'write', handler: { kind: 't3_post', thread_id: 'thread-lead' },
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', maxLength: 2000 } }, required: ['kind', 'text'] } });
    registry.grant('owner_message', 'dot');
    assert.equal(await code(dispatch(registry, { tool: 'owner_message', class: 'write', args: { kind: 'question', text: 'x' } })), 'handler_failed');
    assert.equal(fs.existsSync(log), false, 'no other command ran');
    assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL').get().n, 1, 'the message stays queued');
  });
});

// ---- Pending reservations carry a lease (handler timeout + margin) so a crash cannot lose the write forever --------
const LEASE_MS = LIMITS.idempotencyLeaseMs;
const sendWith = (registry, key, worker = 'dot') => registry.callTool({ worker, tool: 'echo_tool', class: 'write', args: { text: 'x' }, schema_hash: hashOf(registry, worker, 'echo_tool'), idempotency_key: key });
// A handler that never finishes in time: the call is abandoned the way a crashed process abandons it.
function hangingFixture() {
  const state = { runs: 0, hang: true, gates: [] };
  const handler = { run: async () => { state.runs++; if (state.hang) await new Promise(resolve => state.gates.push(resolve)); return { run: state.runs }; } };
  const f = fixture({ handlers: { echo: handler } });
  f.registry.register(spec({ class: 'write' })); f.registry.grant('echo_tool', 'dot');
  return { ...f, state };
}

test('lease: the lease is the handler timeout plus a margin', () => {
  assert(LEASE_MS >= 15_000 + 30_000);
});

test('lease: a retry inside the lease is refused as in progress and the handler does not run', async () => {
  const { registry, state, time } = hangingFixture();
  void sendWith(registry, 'crash').catch(() => {});
  assert.equal(state.runs, 1);
  time.ms += LEASE_MS - 1000;
  const err = await sendWith(registry, 'crash').catch(e => e);
  assert(err instanceof RegistryError);
  assert.equal(err.code, 'in_progress');
  assert.match(err.message, /retry/);
  assert.match(err.message, /\b1\b/, 'names the seconds left');
  assert.equal(state.runs, 1);
});

test('lease: a retry after the lease runs the handler once and stores the result', async () => {
  const { registry, state, time, store } = hangingFixture();
  void sendWith(registry, 'crash').catch(() => {});
  time.ms += LEASE_MS + 1;
  state.hang = false;
  const retry = await sendWith(registry, 'crash');
  assert.equal(retry.ok, true);
  assert.equal(state.runs, 2);
  assert.equal(store.db.prepare("SELECT state FROM tool_idempotency WHERE key='crash'").get().state, 'done');
  assert.equal((await sendWith(registry, 'crash')).replayed, true);
  assert.equal(state.runs, 2);
});

// A handler whose every attempt has its own gate and its own result, so a late finisher is told apart from the taker.
function attemptFixture() {
  const attempts = [];
  const handler = { run: async () => {
    const id = attempts.length + 1;
    const attempt = { id }; attempts.push(attempt);
    await new Promise((resolve, reject) => { attempt.succeed = resolve; attempt.fail = reject; });
    return { attempt: id };
  } };
  const f = fixture({ handlers: { echo: handler } });
  f.registry.register(spec({ class: 'write' })); f.registry.grant('echo_tool', 'dot');
  return { ...f, attempts };
}
const rowState = (store, key) => store.db.prepare('SELECT state, outcome FROM tool_idempotency WHERE key=?').get(key);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('lease: a late success from the abandoned first attempt cannot overwrite the pending taker or its result', async () => {
  const { registry, attempts, time, store } = attemptFixture();
  const first = sendWith(registry, 'late').catch(e => e);
  time.ms += LEASE_MS + 1;
  const taker = sendWith(registry, 'late');
  assert.equal(attempts.length, 2);
  attempts[0].succeed(); await first; await tick();
  assert.deepEqual({ ...rowState(store, 'late') }, { state: 'pending', outcome: null }, 'the late success did not settle the taker row');
  attempts[1].succeed();
  assert.deepEqual((await taker).result, { attempt: 2 });
  assert.deepEqual((await sendWith(registry, 'late')).result, { attempt: 2 });
});

test('lease: a late RegistryError from the abandoned first attempt cannot free the pending taker row', async () => {
  const { registry, attempts, time, store } = attemptFixture();
  const first = sendWith(registry, 'late-err').catch(e => e);
  time.ms += LEASE_MS + 1;
  const taker = sendWith(registry, 'late-err');
  attempts[0].fail(new RegistryError('invalid_arguments', 'refused late'));
  assert.equal((await first).code, 'invalid_arguments'); await tick();
  assert.equal(rowState(store, 'late-err')?.state, 'pending', 'the late refusal did not delete the taker row');
  assert.equal((await sendWith(registry, 'late-err').catch(e => e)).code, 'in_progress');
  attempts[1].succeed();
  assert.deepEqual((await taker).result, { attempt: 2 });
});

test('lease: two takers after expiry, both past the stale lookup, exactly one runs the handler', async () => {
  const dbPath = path.join(scratch, `bridge-${counter++}.db`);
  const time = { ms: Date.parse('2026-11-05T00:00:00Z') };
  let runs = 0; const gates = [];
  const handlers = { echo: { run: async () => { runs++; await new Promise(r => gates.push(r)); return { ok: 1 }; } } };
  const waiting = []; let arm = false;
  const hooks = { afterIdempotencyLookup: () => arm ? new Promise(resolve => waiting.push(resolve)) : undefined };
  const make = () => createToolRegistry({ store: new Store(dbPath), now: () => time.ms, handlers, hooks });
  const a = make(), b = make(), c = make();
  a.register(spec({ class: 'write' })); a.grant('echo_tool', 'dot');
  void sendWith(a, 'race').catch(() => {});
  assert.equal(runs, 1);
  time.ms += LEASE_MS + 1;
  arm = true;
  const results = Promise.allSettled([sendWith(b, 'race'), sendWith(c, 'race')]);
  await tick();
  assert.equal(waiting.length, 2, 'both takers read the expired row before either reserves');
  arm = false; waiting.forEach(release => release());
  await tick();
  assert.equal(runs, 2, 'one taker ran');
  gates.forEach(r => r());
  const settled = await results;
  assert.equal(settled.filter(r => r.status === 'rejected' && r.reason.code === 'in_progress').length, 1);
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1);
});

test('retryable result: two callers past the stale read, exactly one handler runs and the loser cannot erase the reservation', async () => {
  let runs = 0; let mode = 'not_delivered'; const gates = [];
  const handlers = { echo: { run: async () => {
    runs++;
    if (mode === 'not_delivered') { mode = 'ok'; throw Object.assign(new Error('x'), { userMessage: 'not sent', notDelivered: true }); }
    await new Promise(r => gates.push(r)); return { ok: runs };
  } } };
  const waiting = []; let arm = false;
  const hooks = { afterIdempotencyLookup: () => arm ? new Promise(resolve => waiting.push(resolve)) : undefined };
  const dbPath = path.join(scratch, `bridge-${counter++}.db`);
  const make = () => createToolRegistry({ store: new Store(dbPath), now: () => Date.parse('2026-11-05T00:00:00Z'), handlers, hooks });
  const a = make(), b = make();
  a.register(spec({ class: 'write' })); a.grant('echo_tool', 'dot');
  assert.equal((await sendWith(a, 'retry').catch(e => e)).code, 'handler_failed');
  assert.equal(runs, 1);
  arm = true;
  const ra = sendWith(a, 'retry').catch(e => e), rb = sendWith(b, 'retry').catch(e => e);
  await tick();
  assert.equal(waiting.length, 2, 'both callers hold the same retryable read');
  arm = false; waiting.forEach(release => release());
  await tick(); await tick();
  assert.equal(runs, 2, 'only one retry ran the handler');
  gates.forEach(r => r());
  const out = await Promise.all([ra, rb]);
  assert.equal(out.filter(r => r.ok).length, 1);
  assert.equal(out.filter(r => r.code === 'in_progress').length, 1);
});

test('lease: a completed result replays inside the lease, after it, and until the 7-day TTL', async () => {
  const { registry, state, time } = hangingFixture();
  state.hang = false;
  await sendWith(registry, 'done');
  for (const step of [1000, LEASE_MS + 1000, 86_400_000, 5 * 86_400_000]) {
    time.ms += step;
    assert.equal((await sendWith(registry, 'done')).replayed, true);
  }
  assert.equal(state.runs, 1);
  time.ms += 2 * 86_400_000;
  await sendWith(registry, 'done');
  assert.equal(state.runs, 2, 'forgotten after the TTL');
});

test('lease: a database with the old table shape gains the column and an old pending row counts as expired', async () => {
  const dbPath = path.join(scratch, `bridge-${counter++}.db`);
  const first = new Store(dbPath);
  first.db.exec('DROP TABLE tool_idempotency; CREATE TABLE tool_idempotency (worker TEXT NOT NULL, tool TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (\'pending\',\'done\')), outcome TEXT, created_at TEXT NOT NULL, PRIMARY KEY(worker,tool,key))');
  first.db.prepare("INSERT INTO tool_idempotency(worker,tool,key,state,outcome,created_at) VALUES('dot','echo_tool','old','pending',NULL,'2026-11-05T00:00:00.000Z')").run();
  first.db.close();
  const store = new Store(dbPath);
  assert(store.db.prepare("SELECT 1 FROM pragma_table_info('tool_idempotency') WHERE name='lease_expires_at'").get());
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 66);
  let runs = 0;
  const registry = createToolRegistry({ store, now: () => Date.parse('2026-11-05T00:00:01Z'), handlers: { echo: { run: async () => { runs++; return {}; } } } });
  registry.register(spec({ class: 'write' })); registry.grant('echo_tool', 'dot');
  assert.equal((await sendWith(registry, 'old')).ok, true);
  assert.equal(runs, 1);
  new Store(dbPath).db.close();
});

test('lease: completed results are kept 7 days from completion, not from reservation', async () => {
  const { registry, attempts, time, store } = attemptFixture();
  const call = sendWith(registry, 'age');
  time.ms += 40_000; // a slow handler: finishes 40 s after it reserved
  attempts[0].succeed(); await call;
  assert(store.db.prepare("SELECT 1 FROM pragma_table_info('tool_idempotency') WHERE name='completed_at'").get());
  time.ms += 7 * 86_400_000 - 20_000; // 7 days minus 20 s since completion, but over 7 days since reservation
  assert.equal((await sendWith(registry, 'age')).replayed, true);
  time.ms += 40_000;
  const again = sendWith(registry, 'age'); await tick();
  assert.equal(attempts.length, 2, 'forgotten once 7 days have passed since completion');
  attempts[1].succeed(); await again;
});

test('lease: a done row without completed_at falls back to created_at for the TTL', async () => {
  const { registry, store, time, calls } = fixture();
  registry.register(spec({ class: 'write' })); registry.grant('echo_tool', 'dot');
  store.db.prepare("INSERT INTO tool_idempotency(worker,tool,key,state,outcome,created_at) VALUES('dot','echo_tool','old','done',?,?)").run(JSON.stringify({ ok: true, result: { old: 1 } }), new Date(time.ms - 8 * 86_400_000).toISOString());
  assert.equal((await sendWith(registry, 'old')).replayed, undefined);
  assert.equal(calls.length, 1);
});

test('t3_post: a timeout of 0 or over the handler maximum is rejected; the lease follows the real timeout', async () => {
  const { HANDLER_TIMEOUT_MS } = await import('../src/tool-registry.mjs');
  for (const timeoutMs of [0, -1, HANDLER_TIMEOUT_MS + 1, NaN, '5']) {
    assert.throws(() => createT3PostHandler({ store: new Store(path.join(scratch, `bridge-${counter++}.db`)), timeoutMs }), /timeoutMs/, String(timeoutMs));
  }
  const store = new Store(path.join(scratch, `bridge-${counter++}.db`));
  const handler = createT3PostHandler({ store, timeoutMs: 5000, post: async () => {} });
  assert.equal(handler.timeoutMs, 5000);
  const time = { ms: Date.parse('2026-11-05T00:00:00Z') };
  const registry = createToolRegistry({ store, now: () => time.ms, handlers: { t3_post: handler } });
  registry.register({ name: 'owner_message', description: 'm', class: 'write', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, text: { type: 'string', maxLength: 2000 } }, required: ['kind', 'text'] }, handler: { kind: 't3_post', thread_id: 't1' } });
  registry.grant('owner_message', 'dot');
  await registry.callTool({ worker: 'dot', tool: 'owner_message', class: 'write', args: { kind: 'question', text: 'hi' }, schema_hash: hashOf(registry, 'dot', 'owner_message'), idempotency_key: 'k1' });
  // a pending reservation made now would hold timeout + margin, 35 s, not 45 s
  store.db.prepare("UPDATE tool_idempotency SET state='pending', outcome=NULL, lease_expires_at=?").run(new Date(time.ms + 5000 + 30_000).toISOString());
  time.ms += 5000 + 30_000 + 1;
  assert.equal((await registry.callTool({ worker: 'dot', tool: 'owner_message', class: 'write', args: { kind: 'question', text: 'hi' }, schema_hash: hashOf(registry, 'dot', 'owner_message'), idempotency_key: 'k1' }).catch(e => e)).code !== 'in_progress', true);
});

test('t3_post: a retry whose outbox row is already marked sent reuses the receipt and does not post again', async () => {
  const store = new Store(path.join(scratch, `bridge-${counter++}.db`));
  const posts = [];
  const time = { ms: Date.parse('2026-11-05T00:00:00Z') };
  const handler = createT3PostHandler({ store, now: () => time.ms, post: async p => { posts.push(p); } });
  const base = { tool: 'owner_message', worker: 'dot', args: { kind: 'question', text: 'hi' }, config: { thread_id: 't1' }, idempotencyKey: 'once' };
  const first = await handler.run(base);
  assert.equal(first.sent, 1);
  time.ms += 20 * 60_000;
  const again = await handler.run(base); // the registry lost the settlement (crash), so the handler runs again
  assert.equal(posts.length, 1, 'no second post');
  assert.equal(again.queued, false);
  assert.equal(again.sent, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox').get().n, 1, 'and no second outbox row');
});

test('t3_post: the same key with different content is refused; the same content returns the receipt', async () => {
  for (const state of ['sent', 'queued']) {
    const store = new Store(path.join(scratch, `bridge-${counter++}.db`));
    const posts = [];
    const time = { ms: Date.parse('2026-11-05T00:00:00Z') };
    let failPost = state === 'queued';
    const handler = createT3PostHandler({ store, now: () => time.ms, post: async p => { if (failPost) throw new Error('down'); posts.push(p); } });
    const run = (extra = {}) => handler.run({ tool: 'owner_message', worker: 'dot', config: { thread_id: 't1' }, idempotencyKey: 'k', args: { kind: 'question', text: 'one' }, ...extra });
    if (state === 'queued') await run().catch(() => {}); else await run();
    failPost = false; time.ms += 20 * 60_000;
    const other = await run({ args: { kind: 'question', text: 'two' } }).catch(e => e);
    assert.equal(other.code, 'invalid_arguments', state);
    assert.match(other.message, /different content/);
    const otherKind = await run({ args: { kind: 'blocker', text: 'one' } }).catch(e => e);
    assert.equal(otherKind.code, 'invalid_arguments', state);
    assert.equal(posts.some(p => p.text.includes('two')), false, 'the new text was not reported as sent');
    assert.equal(store.db.prepare("SELECT count(*) n FROM tool_outbox WHERE text='two'").get().n, 0);
    const same = await run();
    assert.equal(store.db.prepare('SELECT count(*) n FROM tool_outbox').get().n, 1, `${state}: one outbox row`);
    if (state === 'sent') { assert.equal(posts.length, 1); assert.equal(same.sent, 1); }
  }
});

test('t3_post: an outbox row from an older build (no digest) keeps the old reuse behaviour', async () => {
  const store = new Store(path.join(scratch, `bridge-${counter++}.db`));
  store.db.prepare("INSERT INTO tool_outbox(tool,worker,kind,text,created_at,sent_at,thread_id,idempotency_key) VALUES('owner_message','dot','question','old','2026-11-05T00:00:00.000Z','2026-11-05T00:00:01.000Z','t1','legacy')").run();
  assert(store.db.prepare("SELECT 1 FROM pragma_table_info('tool_outbox') WHERE name='args_digest'").get());
  const handler = createT3PostHandler({ store, now: () => Date.parse('2026-11-05T01:00:00Z'), post: async () => assert.fail('no post') });
  const out = await handler.run({ tool: 'owner_message', worker: 'dot', config: { thread_id: 't1' }, idempotencyKey: 'legacy', args: { kind: 'question', text: 'different' } });
  assert.equal(out.sent, 1);
});

test('lease: the retryable-row delete is bound to the row identity, not only its outcome bytes', async () => {
  // A replacement row with byte-identical outcome but a different reservation must survive a stale delete.
  const { registry, store, time } = fixture({ handlers: { echo: { run: async () => { throw Object.assign(new Error('x'), { userMessage: 'not sent', notDelivered: true }); } } } });
  registry.register(spec({ class: 'write' })); registry.grant('echo_tool', 'dot');
  let swapped = false, lookups = 0;
  const hooked = createToolRegistry({ store, now: () => time.ms, handlers: { echo: { run: async () => ({ ran: true }) } }, hooks: { afterIdempotencyLookup: stored => {
    if (stored) lookups++;
    if (swapped || !stored) return; swapped = true;
    store.db.prepare("UPDATE tool_idempotency SET created_at='2026-11-05T00:00:05.000Z', lease_expires_at='2026-11-05T00:00:50.000Z' WHERE key='ident'").run();
  } } });
  assert.equal((await sendWith(registry, 'ident').catch(e => e)).code, 'handler_failed');
  const out = await sendWith(hooked, 'ident').catch(e => e);
  assert.equal(out.ok, true);
  assert.equal(lookups, 2, 'the stale delete matched nothing, so the row was read again');
  assert.equal(store.db.prepare("SELECT count(*) n FROM tool_idempotency WHERE key='ident'").get().n, 1);
});

test('lease: losing the takeover race to a call that already finished replays its result', async () => {
  const { registry, store, time } = fixture();
  registry.register(spec({ class: 'write' })); registry.grant('echo_tool', 'dot');
  store.db.prepare("INSERT INTO tool_idempotency(worker,tool,key,state,outcome,created_at,lease_expires_at) VALUES('dot','echo_tool','fin','pending',NULL,'2026-11-04T00:00:00.000Z','2026-11-04T00:00:45.000Z')").run();
  const hooked = createToolRegistry({ store, now: () => time.ms, handlers: { echo: { run: async () => assert.fail('must not run') } }, hooks: { afterIdempotencyLookup: () => {
    store.db.prepare("UPDATE tool_idempotency SET state='done', outcome=?, lease_expires_at='2026-11-05T00:00:45.000Z', completed_at='2026-11-05T00:00:00.000Z' WHERE key='fin'").run(JSON.stringify({ ok: true, result: { won: 1 } }));
  } } });
  const out = await sendWith(hooked, 'fin');
  assert.deepEqual(out.result, { won: 1 });
  assert.equal(out.replayed, true);
});

// ---- queued messages follow the authority that queued them ------------------------------------------------------
function outboxFixture() {
  const posts = []; let failing = true;
  const time = { ms: Date.parse('2026-11-05T00:00:00Z') };
  const store = new Store(path.join(scratch, `ob-${counter++}.db`));
  const t3 = createT3PostHandler({ store, now: () => time.ms, post: async p => { if (failing) throw new Error('down'); posts.push(p); } });
  const registry = createToolRegistry({ store, now: () => time.ms, handlers: { t3_post: t3 } });
  const register = thread => registry.register({ name: 'owner_message', description: 'Message the owner', class: 'write', handler: { kind: 't3_post', thread_id: thread },
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['question', 'blocker'] }, text: { type: 'string', maxLength: 2000 } }, required: ['kind', 'text'] } });
  const send = text => dispatch(registry, { worker: 'dot', tool: 'owner_message', class: 'write', args: { kind: 'question', text } });
  const queued = () => store.db.prepare('SELECT count(*) n FROM tool_outbox WHERE sent_at IS NULL').get().n;
  return { posts, time, store, t3, registry, register, send, queued, deliver: () => { failing = false; } };
}

test('outbox: removing a tool and registering the same name for another thread never posts the old text there', async () => {
  const f = outboxFixture();
  f.register('thread-A'); f.registry.grant('owner_message', 'dot');
  await f.send('secret-for-A').catch(() => {});
  assert.equal(f.queued(), 1);
  f.registry.remove('owner_message');
  f.register('thread-B'); f.registry.grant('owner_message', 'dot');
  f.deliver(); f.time.ms += 11 * 60_000;
  assert.equal((await f.send('for-B')).ok, true);
  await f.t3.flushDue();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].threadId, 'thread-B');
  assert(!f.posts.some(p => /secret-for-A/.test(p.text)), 'old content is never posted to the new destination');
  assert.equal(f.queued(), 0);
});

for (const [name, change] of [
  ['revoke', r => r.revoke('owner_message', 'dot')],
  ['disable', r => r.setEnabled('owner_message', false)],
  ['remove', r => r.remove('owner_message')],
]) {
  test(`outbox: a queued message is not delivered after ${name}`, async () => {
    const f = outboxFixture();
    f.register('thread-A'); f.registry.grant('owner_message', 'dot');
    await f.send('held').catch(() => {});
    assert.equal(f.queued(), 1);
    change(f.registry);
    f.deliver(); f.time.ms += 11 * 60_000;
    assert.equal(await f.t3.flushDue(), 0);
    assert.equal(f.posts.length, 0, 'no post after authority was withdrawn');
    assert.equal(f.queued(), 0, 'the queued row is dropped');
  });
}

test('outbox: the timer re-checks authority even if a row survives (row inserted behind the registry)', async () => {
  const f = outboxFixture();
  f.register('thread-A'); f.registry.grant('owner_message', 'dot');
  f.store.db.prepare("INSERT INTO tool_outbox(tool,worker,kind,text,created_at,thread_id) VALUES('owner_message','dot','question','stray','2026-11-05T00:00:00.000Z','thread-A')").run();
  f.store.db.prepare("INSERT INTO tool_outbox(tool,worker,kind,text,created_at,thread_id) VALUES('owner_message','dot','question','wrong-dest','2026-11-05T00:00:00.000Z','thread-Z')").run();
  f.deliver();
  assert.equal(await f.t3.flushDue(), 1);
  assert.deepEqual(f.posts.map(p => [p.threadId, p.text.includes('stray')]), [['thread-A', true]]);
  f.registry.revoke('owner_message', 'dot');
  f.store.db.prepare("INSERT INTO tool_outbox(tool,worker,kind,text,created_at,thread_id) VALUES('owner_message','dot','question','late','2026-11-05T00:00:00.000Z','thread-A')").run();
  f.time.ms += 11 * 60_000;
  assert.equal(await f.t3.flushDue(), 0);
  assert.equal(f.posts.length, 1);
});
