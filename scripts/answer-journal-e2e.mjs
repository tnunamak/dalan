#!/usr/bin/env node
// `dalan answer` through the requester journal, against the real Store and the real src/server.mjs
// (started by the conformance adapter). The real CLI runs as a child process. A thin socket relay sits between it
// and the server only to cut the connection at a chosen point and to record the exact bytes in each direction; the
// relay never answers for the server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DotBridgeAdapter } from './conformance/adapter-dot-bridge.mjs';
import * as answerJournal from '../src/answer-journal.mjs';
import { answerThroughJournal, prepare, send, reconcile, journalPath, AnswerJournalError, MAX_ANSWER_BYTES } from '../src/answer-journal.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapter = new DotBridgeAdapter();
const cliHome = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'aj-'));
const cliRoot = path.join(cliHome, '.local/share/dot-bridge'), receiptsDir = path.join(cliRoot, 'receipts'), relayPath = path.join(cliRoot, 'admin.sock');
fs.mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
const unitDir = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'aj-unit-'));

// ---- relay: forwards to the real admin socket; a rule can cut the connection around a request ----------------
let running = null; // the CLI child that a cut kills
const seen = [];
let rule = () => 'pass';
const relay = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const entry = { method: req.method, route: req.url, body, status: null, reply: null };
    seen.push(entry);
    const action = rule(entry);
    if (action === 'kill-before') { running?.kill('SIGKILL'); req.socket.destroy(); return; }
    const upstream = http.request({ socketPath: adapter.socket, method: req.method, path: req.url, headers: req.headers }, up => {
      const parts = []; up.on('data', c => parts.push(c));
      up.on('end', () => {
        entry.status = up.statusCode; entry.reply = Buffer.concat(parts).toString('utf8');
        if (action === 'kill-after') { running?.kill('SIGKILL'); req.socket.destroy(); return; } // commit happened, reply lost, CLI dead
        if (action === 'drop-reply') { req.socket.destroy(); return; } // commit happened, reply lost, CLI alive
        res.writeHead(up.statusCode, up.headers); res.end(entry.reply);
      });
    });
    upstream.on('error', () => req.socket.destroy());
    upstream.end(body);
  });
});

function runCli(args) {
  const before = seen.length;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['bin/dot-worker.mjs', 'answer', '--json', ...args], { cwd: repo, env: { PATH: process.env.PATH, HOME: cliHome, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    running = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('close', (code, signal) => { running = null; resolve({ code, signal, stdout, stderr, calls: seen.slice(before) }); });
  });
}
const parse = text => JSON.parse(text.trim());
const answerCalls = r => r.calls.filter(c => c.method === 'POST' && c.route === '/answer');

// ---- protocol jobs through the maintained adapter -------------------------------------------------------------
const command = (op, key, body, rest = {}) => ({ v: 0, op, job: 'J', key, body, ...rest });
async function invoke(principal, job, input) {
  const response = await adapter.invoke(principal, { ...input, job });
  assert.equal(response.status, 'OK'); assert.equal(response.reply.ok, true, JSON.stringify(response.reply));
  return response.reply.value;
}
// A protocol job with one open question "Q". Returns the pieces the tests need.
async function protocolJob(name, question = 'Q') {
  await invoke('owner', name, command('submit', 's', { source: 'git:BASE', scope: 'read:fixture', policy: 'P0', destination: 'owner-inbox', retainUntil: 1000 }));
  const claimed = await invoke('W1', name, command('claim', 'c', { leaseMs: 100 }, { revision: 1 }));
  const asked = await invoke('W1', name, command('ask', 'a', { question, text: 'Which option?' }, { revision: claimed.revision, epoch: claimed.epoch, claim: claimed.claim }));
  const id = adapter.requestId(name), cap = adapter.ownerToken(name);
  writeReceipt(id, cap);
  return { name, id, cap, claim: claimed, revision: asked.revision };
}
async function legacyJob(name) {
  const id = adapter.requestId(name), cap = adapter.ownerToken(name);
  const submitted = await adapter.admin('POST', '/submit', { assignment: { schema_version: 1, request_id: id, brief: 'legacy answer fixture', inputs: [], expected_output: 'one answer', execution_scope: 'read-only' }, delivery: 'none', owner_token: cap });
  assert(submitted.value, JSON.stringify(submitted));
  const claimed = await adapter.mcp('W1', 'claim', { request_id: id, claimant: 'W1', acquisition_id: 'first', lease_ms: 100 }); const grant = claimed.value; assert(grant, JSON.stringify(claimed));
  const asked = await adapter.mcp('W1', 'ask_question', { request_id: id, claim_id: grant.claim_id, question_id: 'Q', text: 'Which option?' }); assert(asked.value, JSON.stringify(asked));
  writeReceipt(id, cap);
  return { id, cap };
}
const receiptFile = id => path.join(receiptsDir, createHash('sha256').update(id).digest('hex') + '.json');
const writeReceipt = (id, token) => fs.writeFileSync(receiptFile(id), JSON.stringify({ request_id: id, token, body: {}, delivery: 'none' }) + '\n', { mode: 0o600 });
const journalFile = (id, q = 'Q') => journalPath(receiptsDir, id, q);
const journal = (id, q = 'Q') => JSON.parse(fs.readFileSync(journalFile(id, q), 'utf8'));
const receipts = id => adapter.q("SELECT count(*) n FROM claim_command_receipts WHERE job=? AND command_key='answer:Q'", id)[0].n;
const answerOf = (id, q = 'Q') => adapter.q('SELECT answer FROM job_questions WHERE request_id=? AND question_id=?', id, q)[0].answer;
const revisionOf = id => adapter.q('SELECT revision FROM claim_command_revisions WHERE job=?', id)[0].revision;
// The first reply is built in field order; a replay serves the stored receipt as canonical JSON (sorted keys). The
// content must be identical; the key order is the server's own and is the only byte difference.
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])])) : value;
const canonicalJson = value => JSON.stringify(sortKeys(value));
const sameReply = (replay, original) => { assert.equal(canonicalJson(JSON.parse(replay)), canonicalJson(JSON.parse(original)), 'the replay returns the original receipt'); assert.equal(replay, canonicalJson(JSON.parse(replay)), 'a replay is served as canonical JSON'); };
const sameBytes = (a, b, why) => assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0, why);

try {
  await adapter.init(); await adapter.reset();
  await new Promise(resolve => relay.listen(relayPath, resolve));

  // 1. Happy path, then the two local rules: same text resumes, different text refuses with no network.
  {
    const job = await protocolJob('happy');
    const text = 'Option α — keep it';
    const first = await runCli([job.id, 'Q', text]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(parse(first.stdout).answered, true);
    assert.deepEqual(journal(job.id), { v: 1, job: job.id, question_id: 'Q', key: 'answer:Q', text, expected_revision: job.revision, state: 'committed' });
    assert.equal(fs.statSync(journalFile(job.id)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(journalFile(job.id))).mode & 0o777, 0o700);
    // The owner-authenticated /get carries the revision the CLI needs; it is the same number the server checks.
    const owned = await adapter.admin('GET', `/get?id=${job.id}&peek=1`, undefined, job.cap);
    assert.equal(owned.value.protocol_revision, revisionOf(job.id));
    assert.equal(JSON.parse(first.calls.find(c => c.route.startsWith('/get?')).reply).protocol_revision, job.revision, 'the revision /get showed the CLI is the one the server then checked');
    const [getCall, postCall] = [first.calls.find(c => c.route.startsWith('/get?')), answerCalls(first)[0]];
    assert(getCall.route.endsWith('&peek=1'), 'the revision read must not record a consumption');
    assert.deepEqual(JSON.parse(postCall.body), { id: job.id, question_id: 'Q', text, command_key: 'answer:Q', expected_revision: job.revision });
    assert.equal(receipts(job.id), 1); assert.equal(answerOf(job.id), text);

    const again = await runCli([job.id, 'Q', text]);
    assert.equal(again.code, 0, again.stderr); assert.equal(again.calls.length, 0, 'a committed journal answers locally');
    const changed = await runCli([job.id, 'Q', 'a different answer']);
    assert.notEqual(changed.code, 0); assert.equal(changed.calls.length, 0, 'different text under a journal makes no network call');
    assert.equal(parse(changed.stderr).error.includes('different text'), true);
    assert.equal(answerOf(job.id), text); assert.equal(journal(job.id).text, text);
    console.log('PASS happy path: journal written 0600 with the frozen envelope; same text resumes locally; different text refuses with no network');

    // The server treats a changed text or a changed expected revision under the same key as a conflict.
    for (const change of [{ text: 'tampered' }, { expected_revision: job.revision + 1 }]) {
      const reply = await adapter.admin('POST', '/answer', { id: job.id, question_id: 'Q', text, command_key: 'answer:Q', expected_revision: job.revision, ...change }, job.cap);
      assert.equal(reply.error, 'command_conflict');
    }
    const other = await adapter.admin('POST', '/answer', { id: job.id, question_id: 'Q', text, command_key: 'answer:other', expected_revision: revisionOf(job.id) }, job.cap);
    assert.match(other.error, /ALREADY_ANSWERED/);
    assert.equal(receipts(job.id), 1); assert.equal(answerOf(job.id), text);
    console.log('PASS server: changed text or revision under the key is command_conflict; another key is ALREADY_ANSWERED; still one receipt');
  }

  // 2. Death before the journal write: the revision was read, the process died, nothing was saved or sent.
  {
    const job = await protocolJob('die_before');
    rule = entry => entry.route.startsWith('/get?') ? 'kill-before' : 'pass';
    const died = await runCli([job.id, 'Q', 'first answer']);
    rule = () => 'pass';
    assert.equal(died.signal, 'SIGKILL'); assert(!fs.existsSync(journalFile(job.id)), 'no journal before the write');
    assert.equal(answerCalls(died).length, 0); assert.equal(receipts(job.id), 0); assert.equal(answerOf(job.id), null);
    const rerun = await runCli([job.id, 'Q', 'a better answer']); // nothing was saved, so the text is still free
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.equal(receipts(job.id), 1); assert.equal(answerOf(job.id), 'a better answer'); assert.equal(journal(job.id).state, 'committed');
    console.log('PASS death before journal write: nothing saved, nothing sent; the rerun is a clean first attempt, one receipt, one answer');
  }

  // 3. Death after the journal write, before any send: the rerun sends the saved envelope.
  {
    const job = await protocolJob('die_after_journal');
    rule = entry => entry.method === 'POST' && entry.route === '/answer' ? 'kill-before' : 'pass';
    const died = await runCli([job.id, 'Q', 'saved answer']);
    rule = () => 'pass';
    assert.equal(died.signal, 'SIGKILL');
    assert.equal(journal(job.id).state, 'prepared'); assert.equal(journal(job.id).expected_revision, job.revision);
    assert.equal(receipts(job.id), 0); assert.equal(answerOf(job.id), null);
    const changed = await runCli([job.id, 'Q', 'other text']);
    assert.notEqual(changed.code, 0); assert.equal(changed.calls.length, 0);
    const rerun = await runCli([job.id, 'Q', 'saved answer']);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert(!rerun.calls.some(c => c.route.startsWith('/get?')), 'a resumed attempt never re-reads the revision');
    assert.equal(JSON.parse(answerCalls(rerun)[0].body).expected_revision, job.revision);
    assert.equal(receipts(job.id), 1); assert.equal(answerOf(job.id), 'saved answer');
    console.log('PASS death after journal write: changed text refused; the rerun re-sends the saved envelope; one receipt, one answer');

    // The worker moved the job on before the saved attempt was ever sent: the revision it holds is stale.
    // The CLI must not refresh it (that would be a new, unkeyed-in-effect attempt). It reads the server back and says so.
    const stale = await protocolJob('stale_before_send');
    rule = entry => entry.method === 'POST' && entry.route === '/answer' ? 'kill-before' : 'pass';
    await runCli([stale.id, 'Q', 'saved answer']); rule = () => 'pass';
    await invoke('W1', 'stale_before_send', command('renew', 'r', { leaseMs: 100 }, { revision: stale.revision, epoch: 1, claim: stale.claim.claim }));
    assert.equal(revisionOf(stale.id), stale.revision + 1);
    const refused = await runCli([stale.id, 'Q', 'saved answer']);
    assert.notEqual(refused.code, 0); assert.match(parse(refused.stderr).error, /revision_conflict/);
    assert.equal(JSON.parse(answerCalls(refused)[0].body).expected_revision, stale.revision, 'the original revision was sent, not a refreshed one');
    assert(!refused.calls.some(c => c.route.startsWith('/get?')), 'no re-prepare');
    assert(refused.calls.some(c => c.route.startsWith('/questions?')), 'the server was read back');
    assert.equal(receipts(stale.id), 0); assert.equal(answerOf(stale.id), null); assert.equal(journal(stale.id).expected_revision, stale.revision);
    console.log('PASS stale revision before any send: original revision sent, server read back, conflict surfaced, journal untouched, no answer applied');
  }

  // 4. Death after the server commit, before the reply: the rerun replays the original envelope even though the revision moved.
  {
    const job = await protocolJob('die_after_commit');
    rule = entry => entry.method === 'POST' && entry.route === '/answer' ? 'kill-after' : 'pass';
    const died = await runCli([job.id, 'Q', 'committed answer']);
    rule = () => 'pass';
    assert.equal(died.signal, 'SIGKILL');
    const original = answerCalls(died)[0];
    assert.equal(original.status, 200);
    assert.equal(receipts(job.id), 1); assert.equal(answerOf(job.id), 'committed answer'); assert.equal(journal(job.id).state, 'prepared');
    await invoke('W1', 'die_after_commit', command('renew', 'r', { leaseMs: 100 }, { revision: job.revision + 1, epoch: 1, claim: job.claim.claim }));
    assert(revisionOf(job.id) > job.revision + 1, 'the revision advanced past the answer');
    const rerun = await runCli([job.id, 'Q', 'committed answer']);
    assert.equal(rerun.code, 0, rerun.stderr);
    const replay = answerCalls(rerun)[0];
    sameBytes(replay.body, original.body, 'the retry sends the identical request bytes');
    sameReply(replay.reply, original.reply);
    assert.equal(replay.status, 200);
    assert(!rerun.calls.some(c => c.route.startsWith('/get?')));
    assert.equal(receipts(job.id), 1); assert.equal(answerOf(job.id), 'committed answer'); assert.equal(journal(job.id).state, 'committed');
    assert.equal(adapter.q('SELECT count(*) n FROM protocol_events WHERE request_id=? AND event_type=?', job.id, 'answered')[0].n, 1, 'one answered event');
    console.log('PASS death after server commit before reply: advanced revision still replays; identical request bytes and the original receipt on replay; one receipt, one answer, one event');
  }

  // 5. Lost reply with the CLI alive: it re-sends the identical envelope by itself.
  {
    const job = await protocolJob('lost_reply');
    let dropped = false;
    rule = entry => { if (entry.method === 'POST' && entry.route === '/answer' && !dropped) { dropped = true; return 'drop-reply'; } return 'pass'; };
    const run = await runCli([job.id, 'Q', 'answer after a lost reply']);
    rule = () => 'pass';
    assert.equal(run.code, 0, run.stderr);
    const posts = answerCalls(run); assert.equal(posts.length, 2);
    sameBytes(posts[1].body, posts[0].body, 'identical envelope on the retry');
    sameReply(posts[1].reply, posts[0].reply);
    assert.equal(receipts(job.id), 1); assert.equal(journal(job.id).state, 'committed');
    console.log('PASS lost reply, CLI alive: identical envelope re-sent, replay reply identical, one receipt');
  }

  // 6. The answer landed under another key (or another request path): read back, equal text confirms, other text surfaces.
  {
    const same = await protocolJob('landed_same');
    const landed = await adapter.admin('POST', '/answer', { id: same.id, question_id: 'Q', text: 'landed text', command_key: 'answer:manual', expected_revision: same.revision }, same.cap);
    assert(landed.value, JSON.stringify(landed));
    const confirmed = await runCli([same.id, 'Q', 'landed text']);
    assert.equal(confirmed.code, 0, confirmed.stderr); assert.equal(parse(confirmed.stdout).confirmed, true);
    assert.equal(journal(same.id).state, 'committed'); assert.equal(receipts(same.id), 0, 'no second receipt was made');

    const differ = await protocolJob('landed_differs');
    await adapter.admin('POST', '/answer', { id: differ.id, question_id: 'Q', text: 'landed text', command_key: 'answer:manual', expected_revision: differ.revision }, differ.cap);
    const conflict = await runCli([differ.id, 'Q', 'my text']);
    assert.notEqual(conflict.code, 0); assert.match(parse(conflict.stderr).error, /different answer is already recorded/);
    assert.equal(answerOf(differ.id), 'landed text'); assert.equal(journal(differ.id).state, 'prepared'); assert.equal(journal(differ.id).text, 'my text');

    // command_conflict: a receipt exists under this key for another envelope; the stored answer equals ours.
    const keyed = await protocolJob('key_conflict');
    await adapter.admin('POST', '/answer', { id: keyed.id, question_id: 'Q', text: 'same text', command_key: 'answer:Q', expected_revision: keyed.revision }, keyed.cap);
    fs.mkdirSync(path.dirname(journalFile(keyed.id)), { recursive: true });
    fs.writeFileSync(journalFile(keyed.id), JSON.stringify({ v: 1, job: keyed.id, question_id: 'Q', key: 'answer:Q', text: 'same text', expected_revision: keyed.revision + 5, state: 'prepared' }) + '\n', { mode: 0o600 });
    const viaKey = await runCli([keyed.id, 'Q', 'same text']);
    assert.equal(viaKey.code, 0, viaKey.stderr); assert.equal(parse(viaKey.stdout).confirmed, true);
    assert.match(answerCalls(viaKey)[0].reply, /command_conflict/);
    console.log('PASS read-back: ALREADY_ANSWERED and command_conflict with equal text confirm; different text surfaces and is never overwritten');
  }

  // 7. Authority or retention loss: state unknown, never re-prepared; resumes when access returns.
  {
    const job = await protocolJob('auth_loss');
    rule = entry => entry.method === 'POST' && entry.route === '/answer' ? 'kill-before' : 'pass';
    await runCli([job.id, 'Q', 'pending answer']); rule = () => 'pass';
    const before = fs.readFileSync(journalFile(job.id), 'utf8');
    fs.rmSync(receiptFile(job.id));
    const lost = await runCli([job.id, 'Q', 'pending answer']);
    assert.notEqual(lost.code, 0); assert.equal(lost.calls.length, 0);
    assert.match(parse(lost.stderr).error, /cannot tell whether the answer/);
    assert.equal(journal(job.id).state, 'unknown'); assert.deepEqual({ ...journal(job.id), state: 'prepared' }, JSON.parse(before));
    writeReceipt(job.id, 'wrong-capability');
    const wrong = await runCli([job.id, 'Q', 'pending answer']);
    assert.notEqual(wrong.code, 0); assert.equal(journal(job.id).state, 'unknown'); assert.equal(receipts(job.id), 0);
    assert(!wrong.calls.some(c => c.route.startsWith('/get?')), 'unknown never re-prepares');
    writeReceipt(job.id, job.cap);
    const resumed = await runCli([job.id, 'Q', 'pending answer']);
    assert.equal(resumed.code, 0, resumed.stderr); assert.equal(journal(job.id).state, 'committed');
    assert.equal(receipts(job.id), 1); assert.equal(answerOf(job.id), 'pending answer');
    assert.equal(JSON.parse(answerCalls(resumed)[0].body).expected_revision, job.revision);
    console.log('PASS auth loss: state unknown with nothing re-prepared and no new send; the saved envelope resumes when the capability returns');
  }

  // 8. A job with no protocol revisions: the key is journaled, no revision is sent, and a landed answer is confirmed by read-back.
  await adapter.reset(); // a fresh server: the earlier jobs hold every claim slot
  {
    const job = await legacyJob('legacy');
    const run = await runCli([job.id, 'Q', 'legacy answer']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(journal(job.id).expected_revision, null);
    assert.equal((await adapter.admin('GET', `/get?id=${job.id}&peek=1`, undefined, job.cap)).value.protocol_revision, null, 'no revision on a job without protocol revisions');
    assert(!('expected_revision' in JSON.parse(answerCalls(run)[0].body)));
    assert.equal(answerOf(job.id), 'legacy answer');
    const second = await legacyJob('legacy_lost');
    rule = entry => entry.method === 'POST' && entry.route === '/answer' ? 'kill-after' : 'pass';
    await runCli([second.id, 'Q', 'legacy lost']); rule = () => 'pass';
    const rerun = await runCli([second.id, 'Q', 'legacy lost']);
    assert.equal(rerun.code, 0, rerun.stderr); assert.equal(journal(second.id).state, 'committed'); assert.equal(answerOf(second.id), 'legacy lost');
    console.log('PASS legacy job: answered without a revision; a lost reply is confirmed by read-back');
  }

  // 9. Module rules that need no server: bounded retry of one frozen envelope, retention loss, local validation, corrupt journal.
  {
    const base = { receiptsDir: unitDir, job: 'req_unit_job_1', questionId: 'Q:1.a', text: 'unit text', sleep: async () => {} };
    const sent = []; let reads = 0;
    const down = Object.assign(new Error('socket hang up'), { kind: 'transport' });
    await assert.rejects(answerThroughJournal({ ...base, attempts: 3, readRevision: async () => (reads++, 7), post: async e => { sent.push(JSON.stringify(e)); throw down; }, readQuestion: async () => assert.fail('no read-back for a transport failure') }), /socket hang up/);
    assert.equal(sent.length, 3); assert.equal(new Set(sent).size, 1, 'every attempt carries the identical envelope'); assert.equal(reads, 1);
    assert.equal(JSON.parse(sent[0]).expected_revision, 7); assert.equal(JSON.parse(fs.readFileSync(journalPath(unitDir, base.job, base.questionId), 'utf8')).state, 'prepared');
    assert(journalPath(unitDir, base.job, base.questionId).endsWith('req_unit_job_1.answers/Q%3A1%2Ea.json'));
    const timeout = Object.assign(new Error('admin request timed out after 30000 ms'), { kind: 'transport', code: 'ETIMEDOUT' });
    let calls = 0;
    const done = await answerThroughJournal({ ...base, readRevision: async () => assert.fail('resume must not read the revision'), post: async e => { if (calls++ === 0) throw timeout; assert.equal(e.expected_revision, 7); return { request_id: base.job, answered: true }; }, readQuestion: async () => undefined });
    assert.equal(done.answered, true); assert.equal(calls, 2);

    const tombstone = Object.assign(new Error('TOMBSTONE'), { kind: 'http', http_status: 400 });
    const retained = { ...base, questionId: 'Q2' };
    await assert.rejects(answerThroughJournal({ ...retained, readRevision: async () => 3, post: async () => { throw tombstone; }, readQuestion: async () => assert.fail('retention loss is not read back') }), e => e.code === 'answer_state_unknown');
    assert.equal(JSON.parse(fs.readFileSync(journalPath(unitDir, base.job, 'Q2'), 'utf8')).state, 'unknown');
    await assert.rejects(answerThroughJournal({ ...retained, readRevision: async () => assert.fail('never re-prepare'), post: async () => { throw tombstone; }, readQuestion: async () => undefined }), e => e.code === 'answer_state_unknown');

    for (const [questionId, text] of [['Q3', '   '], ['Q3', 'x'.repeat(4097)], ['bad id', 'text'], ['', 'text']]) {
      await assert.rejects(answerThroughJournal({ ...base, questionId, text, readRevision: async () => assert.fail('invalid input makes no call'), post: async () => assert.fail('no send'), readQuestion: async () => undefined }), e => e instanceof AnswerJournalError && e.code === 'invalid_answer');
    }
    assert(!fs.existsSync(journalPath(unitDir, base.job, 'Q3')), 'invalid input leaves no journal');
    const multibyte = 'é'.repeat(2048); // 4096 bytes exactly
    assert.equal((await answerThroughJournal({ ...base, questionId: 'Q4', text: multibyte, readRevision: async () => 1, post: async () => ({ answered: true }), readQuestion: async () => undefined })).answered, true);
    await assert.rejects(answerThroughJournal({ ...base, questionId: 'Q5', text: multibyte + 'x', readRevision: async () => 1, post: async () => assert.fail('over 4096 bytes'), readQuestion: async () => undefined }), e => e.code === 'invalid_answer');
    fs.writeFileSync(journalPath(unitDir, base.job, 'Q4'), '{"v":1,');
    await assert.rejects(answerThroughJournal({ ...base, questionId: 'Q4', text: multibyte, readRevision: async () => assert.fail('corrupt journal is not replaced'), post: async () => assert.fail('no send'), readQuestion: async () => undefined }), e => e.code === 'answer_journal_corrupt');
    assert.equal(fs.readFileSync(journalPath(unitDir, base.job, 'Q4'), 'utf8'), '{"v":1,');
    console.log('PASS module: bounded retry of one frozen envelope; timeout then replay; retention loss is unknown and never re-prepared; blank, 4097-byte and bad-ID input refused before any file or call; 4096 UTF-8 bytes accepted; corrupt journal kept');
  }
  // 10. The 4096 limit counts UTF-8 bytes (src/server.mjs `str(body.text,'text',4096)` uses Buffer.byteLength), not characters.
  //     At the limit the answer is stored whole; past it the CLI refuses with a byte count and sends nothing; the server refuses too.
  {
    assert.equal(MAX_ANSWER_BYTES, 4096);
    const cases = [
      { name: 'two_byte_at', text: '\u00e9'.repeat(2048), bytes: 4096, ok: true }, //  2048 chars, 4096 bytes
      { name: 'cjk_at', text: '\u6f22'.repeat(1365) + 'a', bytes: 4096, ok: true }, // 1366 chars, 4096 bytes
      { name: 'two_byte_over', text: '\u00e9'.repeat(2048) + 'a', bytes: 4097, ok: false }, // 2049 chars: under 4096 chars, over 4096 bytes
      { name: 'cjk_over', text: '\u6f22'.repeat(1365) + 'ab', bytes: 4097, ok: false },
      { name: 'emoji_over', text: '\u{1F600}'.repeat(1025), bytes: 4100, ok: false }, // 1025 chars, 4100 bytes
    ];
    for (const c of cases) {
      assert.equal(Buffer.byteLength(c.text), c.bytes); assert(c.text.length < 4096, 'every case is under 4096 characters');
      const job = await protocolJob(c.name);
      const run = await runCli([job.id, 'Q', c.text]);
      if (c.ok) {
        assert.equal(run.code, 0, run.stderr);
        assert.equal(answerOf(job.id), c.text, 'stored whole, not truncated');
        assert.equal(Buffer.byteLength(answerOf(job.id)), 4096);
      } else {
        assert.notEqual(run.code, 0); assert.equal(run.calls.length, 0, 'refused locally: no network');
        assert.match(parse(run.stderr).error, new RegExp(`${c.bytes} UTF-8 bytes; the limit is 4096 bytes \\(not characters\\)`));
        assert(!fs.existsSync(journalFile(job.id)), 'nothing saved');
        assert.equal(answerOf(job.id), null);
        const direct = await adapter.admin('POST', '/answer', { id: job.id, question_id: 'Q', text: c.text, command_key: 'answer:Q', expected_revision: job.revision }, job.cap);
        assert.match(direct.error, /invalid text/, 'the server refuses the same text');
        assert.equal(answerOf(job.id), null); assert.equal(receipts(job.id), 0);
      }
    }
    console.log('PASS size limit counts bytes: 4096 bytes accepted whole (2-byte and 3-byte text), 4097 and 4100 bytes refused with a byte count, never truncated, server agrees');
  }

  // 11. The frozen interface: prepare, send, reconcile.
  {
    for (const name of ['prepare', 'send', 'reconcile']) assert.equal(typeof answerJournal[name], 'function', `${name} is exported`);
    assert.deepEqual([prepare.length, send.length, reconcile.length], [4, 2, 3]);
    const job = 'req_iface_job_1', dir = unitDir;
    const noPost = { post: async () => assert.fail('reconcile never sends') };
    const answers = new Map();
    const deps = { receiptsDir: dir, readRevision: async () => 5, readQuestion: async () => answers.get('Q') };
    assert.deepEqual(await reconcile(job, 'Q', { ...deps, ...noPost }), { state: 'none' });
    const prepared = await prepare(job, 'Q', 'iface text', deps);
    assert.equal(prepared.entry.state, 'prepared'); assert.equal(prepared.entry.expected_revision, 5);
    assert.deepEqual((await reconcile(job, 'Q', { ...deps, ...noPost })).state, 'pending');
    answers.set('Q', { answer: 'someone else' });
    assert.equal((await reconcile(job, 'Q', deps)).state, 'conflict'); assert.equal(JSON.parse(fs.readFileSync(prepared.file, 'utf8')).state, 'prepared');
    answers.set('Q', { answer: 'iface text' });
    assert.equal((await reconcile(job, 'Q', deps)).state, 'confirmed'); assert.equal(JSON.parse(fs.readFileSync(prepared.file, 'utf8')).state, 'committed');
    assert.equal((await reconcile(job, 'Q', deps)).state, 'committed');
    const sendSaved = await send(await prepare(job, 'Q', 'iface text', deps), { post: async () => assert.fail('a committed attempt sends nothing') });
    assert.equal(sendSaved.answered, true);
    await assert.rejects(prepare(job, 'Q', 'other', deps), e => e.code === 'answer_text_mismatch');
    const lost = Object.assign(new Error('TOMBSTONE'), { kind: 'http', http_status: 400 });
    await prepare(job, 'U', 'unknown text', deps);
    assert.equal((await reconcile(job, 'U', { ...deps, readQuestion: async () => { throw lost; } }).catch(e => e.code)), 'answer_state_unknown');
    console.log('PASS interface: prepare, send and reconcile are exported with the frozen signatures; reconcile reads only and settles none/pending/conflict/confirmed/committed/unknown');
  }
  // 12. First creation is durable at every level: each new directory is fsynced, and so is its parent, before prepare
  //     returns. Otherwise a crash could lose a directory name while the server already holds the answer, and the next
  //     prepare would make a fresh envelope. A spy over fs records the order of mkdir, fsync and link.
  {
    const events = [], fdPath = new Map();
    const spy = {
      existsSync: p => fs.existsSync(p),
      mkdirSync: (p, o) => { events.push(['mkdir', p]); return fs.mkdirSync(p, o); },
      openSync: (p, ...rest) => { const fd = fs.openSync(p, ...rest); fdPath.set(fd, p); return fd; },
      writeSync: (fd, ...rest) => fs.writeSync(fd, ...rest),
      fsyncSync: fd => { events.push(['fsync', fdPath.get(fd)]); return fs.fsyncSync(fd); },
      closeSync: fd => { fdPath.delete(fd); return fs.closeSync(fd); },
      linkSync: (a, b) => { events.push(['link', b]); return fs.linkSync(a, b); },
      rmSync: (...a) => fs.rmSync(...a),
    };
    const newReceipts = path.join(unitDir, 'durable-receipts'), job = 'req_durable_job_1';
    const file = journalPath(newReceipts, job, 'Q');
    const answersDir = path.dirname(file);
    const at = (kind, target) => events.findIndex(e => e[0] === kind && e[1] === target);
    const lastAt = (kind, target) => events.findLastIndex(e => e[0] === kind && e[1] === target);
    const prepared = await prepare(job, 'Q', 'durable text', { receiptsDir: newReceipts, readRevision: async () => 1, io: spy });
    assert.equal(prepared.entry.state, 'prepared');
    // Both levels are new: <receipts> (parent: unitDir) and <receipts>/<job>.answers (parent: <receipts>).
    assert(at('mkdir', newReceipts) >= 0 && at('mkdir', answersDir) >= 0, 'both new levels were created');
    assert(lastAt('fsync', unitDir) > at('mkdir', newReceipts), 'the parent of the new receipts dir is fsynced after the mkdir');
    assert(events.slice(at('mkdir', answersDir)).some(e => e[0] === 'fsync' && e[1] === newReceipts), 'the receipts dir (parent of the new answers dir) is fsynced after the mkdir');
    assert(lastAt('fsync', answersDir) > at('mkdir', answersDir), 'the new answers dir itself is fsynced');
    const link = at('link', file);
    assert(events.slice(0, link).some(e => e[0] === 'fsync' && e[1].endsWith('.tmp')), 'the file is fsynced before it is published');
    assert(link > lastAt('fsync', newReceipts), 'every directory is durable before the journal is published');
    assert(events.slice(link).some(e => e[0] === 'fsync' && e[1] === answersDir), 'the directory is fsynced again after the file is linked in');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'prepared');

    // A second question under the same job creates no directory, and still fsyncs the directory after the link.
    events.length = 0;
    await prepare(job, 'Q2', 'second text', { receiptsDir: newReceipts, readRevision: async () => 1, io: spy });
    assert.equal(events.filter(e => e[0] === 'mkdir').length, 0);
    assert(events.some(e => e[0] === 'fsync' && e[1] === answersDir));
    console.log('PASS durable creation: each new directory level and its parent are fsynced before prepare returns, the file is fsynced before it is linked in, and the directory after');
  }
  console.log('answer-journal-e2e ok');
} finally {
  relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve));
  await adapter.close();
  fs.rmSync(cliHome, { recursive: true, force: true }); fs.rmSync(unitDir, { recursive: true, force: true });
}
