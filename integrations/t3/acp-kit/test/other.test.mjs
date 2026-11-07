import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOrCreateSecret, ownerToken } from '../src/capability.mjs';
import { assertSessionId, sessionPath, writeJsonPrivate, readJsonPrivate } from '../src/session-store.mjs';
import { promptText, unwrapUserRequest, isT3RuntimeBlock, parseIdentity, stripRolePreamble, CONTINUE_PROMPT } from '../src/t3-envelope.mjs';
import { createRefuse, REFUSE_CODE, CANCEL_BUDGET_MS, cancelBudgetMs, T3_CANCEL_WINDOW_MS, CANCEL_CLEANUP_MS } from '../src/errors.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.homedir(), '.tmp-acpkit-'));
const runtime = "<runtime_info>In case you're asked: you are running in T3 Code through the acpRegistry harness, as x. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create.\nWhen you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.\n</pull_request_linking>";
const envelope = u => `<t3_code_instructions>\n## T3 Code interaction mode: Default\nrules\n</t3_code_instructions>\n\n<user_request>\n${u}\n</user_request>`;

test('capability: secret is 0600, 64 hex, stable; looser mode is refused; token is HMAC per id', () => {
  const dir = tmp(), file = path.join(dir, 'sub/secret');
  const s = readOrCreateSecret(file);
  assert.match(s, /^[0-9a-f]{64}$/); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readOrCreateSecret(file), s);
  assert.equal(ownerToken(s, 'a'), ownerToken(s, 'a')); assert.notEqual(ownerToken(s, 'a'), ownerToken(s, 'b'));
  fs.chmodSync(file, 0o644);
  assert.throws(() => readOrCreateSecret(file), { code: 'state_permissions' });
  fs.rmSync(dir, { recursive: true });
});

test('session store: id validation, atomic private write, refuses a file that is not exactly 0600', () => {
  const dir = tmp(), id = crypto.randomUUID();
  assert.throws(() => sessionPath(dir, '../x'), { code: 'invalid_session_id' });
  assert.throws(() => assertSessionId('abc'), { code: 'invalid_session_id' });
  const file = sessionPath(dir, id), nested = path.join(dir, 'new/state', `${id}.json`);
  assert.equal(readJsonPrivate(file), null);
  writeJsonPrivate(nested, { a: 1 });
  assert.deepEqual(readJsonPrivate(nested), { a: 1 });
  assert.equal(fs.statSync(nested).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(nested)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(nested)), [`${id}.json`], 'no temp file left');
  fs.chmodSync(nested, 0o640);
  assert.throws(() => readJsonPrivate(nested), { code: 'state_permissions' });
  fs.rmSync(dir, { recursive: true });
});

test('t3 envelope: unwrap, runtime block, role preamble, configurable identity prefix', () => {
  const b = text => ({ type: 'text', text });
  assert.equal(promptText([b(envelope('hi')), b(runtime)]), 'hi');
  assert.equal(promptText([b('hi'), b('<runtime_info>x</runtime_info>')]), 'hi\n<runtime_info>x</runtime_info>');
  assert.equal(promptText([b(runtime)]), runtime);
  assert.equal(unwrapUserRequest(`x ${envelope('hi')}`), `x ${envelope('hi')}`, 'envelope must be anchored');
  assert.ok(isT3RuntimeBlock(runtime)); assert.ok(!isT3RuntimeBlock('<runtime_info>x</runtime_info>'));
  assert.equal(stripRolePreamble('Act as the review sub-agent for this task.\n\nbody'), 'body');
  assert.equal(CONTINUE_PROMPT, 'Continue where you left off.');
  const decision = parseIdentity('Act as the research sub-agent for this task.\n\n[dot-decision:dec_1234abcd]\nthe task\n', { prefix: 'dot-decision' });
  assert.deepEqual([decision.id, decision.brief], ['dec_1234abcd', 'the task']);
  const example = parseIdentity('[example-request:abcd-1234]\nwork', { prefix: 'example-request', idPattern: /^[A-Za-z0-9-]{8,64}$/ });
  assert.deepEqual([example.id, example.brief], ['abcd-1234', 'work']);
  assert.equal(parseIdentity('[dot-decision:abcd1234]\nwork', { prefix: 'example-request' }).id, null, 'another adapter prefix is not our token');
  const bad = parseIdentity('[dot-decision:a b]\nwork', { prefix: 'dot-decision' });
  assert.deepEqual([bad.id, bad.brief], [null, '[dot-decision:a b]\nwork']);
  assert.equal(parseIdentity('no token\n', { prefix: 'dot-decision' }).id, null);
  assert.throws(() => parseIdentity('x', { prefix: 'a]|(' }));
});

test('errors: refuse is -32000 with injected RequestError; cancel budget rule', () => {
  class RequestError extends Error { constructor(code, message, data) { super(message); this.code = code; this.data = data; } }
  const refuse = createRefuse(RequestError);
  const e = refuse('nope');
  assert.ok(e instanceof RequestError); assert.equal(e.code, REFUSE_CODE); assert.equal(e.code, -32000); assert.equal(e.data, undefined);
  assert.deepEqual(refuse('x', { code: 'c' }).data, { code: 'c' });
  assert.equal(cancelBudgetMs(undefined), 5000); assert.equal(cancelBudgetMs('2500'), 2500); assert.equal(cancelBudgetMs('-1'), 5000);
  assert.ok(CANCEL_BUDGET_MS + CANCEL_CLEANUP_MS < T3_CANCEL_WINDOW_MS);
});

const b = text => ({ type: 'text', text });
test('t3 envelope: the real delegate_task shape, with trailing blocks in the same text or a changed copy, reduces to the request', () => {
  const trailing = "<runtime_info>In case you're asked: you are running in T3 Code through the acpRegistry harness, as example-worker. No need to mention this otherwise.</runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, use it.\nWhen monitoring is done and you hand the work back to the user, call unwatch_pull_request first.\n</pull_request_linking>";
  const full = `<t3_code_instructions>\n## T3 Code interaction mode: Default\nrules\n## T3 Code orchestration\nmore\n</t3_code_instructions>\n\n<user_request>\nthe task\n</user_request>\n${trailing}`;
  assert.equal(unwrapUserRequest(full), 'the task');
  assert.equal(promptText([b(full)]), 'the task', 'one block');
  assert.equal(promptText([b(envelope('the task')), b(trailing)]), 'the task', 'two blocks, runtime copy not recognised');
  assert.equal(unwrapUserRequest(envelope('the task') + '\n' + trailing.split('\n\n')[0]), 'the task', 'runtime_info alone');
  assert.equal(unwrapUserRequest(envelope('the task') + '\n' + trailing.split('\n\n')[1]), 'the task', 'pull_request_linking alone');
});

test('t3 envelope: user-written tags and unknown trailing text are kept', () => {
  const quoted = 'Explain this:\n<user_request>\nq\n</user_request>\nand <runtime_info>x</runtime_info> too';
  assert.equal(unwrapUserRequest(envelope(quoted)), quoted);
  assert.equal(unwrapUserRequest(envelope(quoted) + '\n' + runtime), quoted);
  const unknown = envelope('x') + '\n<other_block>keep</other_block>';
  assert.equal(unwrapUserRequest(unknown), 'x\n</user_request>\n<other_block>keep</other_block>', 'an unknown block after the request is not dropped');
  assert.equal(unwrapUserRequest('plain text'), 'plain text');
  assert.equal(unwrapUserRequest('x <t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\ny\n</user_request>'), 'x <t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\ny\n</user_request>', 'only an envelope at the start counts');
});

test('t3 envelope: absent tags degrade without losing the task', () => {
  const instructions = '<t3_code_instructions>\n## T3 Code interaction mode: Plan\nrules\n</t3_code_instructions>\n\n';
  assert.equal(unwrapUserRequest(`${instructions}bare task`), 'bare task', 'no user_request tag');
  assert.equal(unwrapUserRequest(`${instructions}bare task\n${runtime}`), 'bare task', 'no user_request tag, trailing blocks');
  assert.equal(unwrapUserRequest(`${instructions}<user_request>\ntask with no close`), 'task with no close');
  assert.equal(unwrapUserRequest(`${instructions}<user_request>\ntask\n${runtime}`), 'task', 'missing close tag, trailing blocks');
});
