#!/usr/bin/env node
// Standalone B4 acceptance trace. Deliberately outside test-segments.json until R5 + R6 merge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DotBridgeAdapter } from './conformance/adapter-dot-bridge.mjs';
import { startT3ResultFixture } from '../src/test-support/t3-result-fixture.mjs';
import { createT3Destination } from '../src/destinations/t3.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const threadId = '00000000-0000-4000-8000-000000000041';
const failures = [];
function cut(mode, name, check, waits = '') {
  try { check(); console.log(`PASS ${mode}: ${name}`); }
  catch (error) {
    failures.push({ mode, name, waits, error: error.message });
    console.error(`FAIL ${mode}: ${name}${waits ? ` [waits on ${waits}]` : ''}: ${error.message}`);
  }
}
function cli(adapter, args, input) {
  return new Promise((resolve, reject) => {
    // Isolated HOME and environment: no inherited destination or live bridge configuration.
    const child = spawn(process.execPath, ['bin/dalan.mjs', ...args], {
      cwd: repo, env: { HOME: adapter.home, PATH: process.env.PATH, DALAN_LEGACY_PROFILE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}
const json = result => { assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); };
const value = result => { assert.ok(result.value, JSON.stringify(result)); return result.value; };

async function trace(mode) {
  const adapter = new DotBridgeAdapter();
  let receiver;
  try {
    await adapter.init(); await adapter.reset(); await adapter.killServer();
    const stub = path.join(adapter.home, 't3code');
    const stateFile = path.join(adapter.home, 'parent.json');
    const messagesFile = path.join(adapter.home, 'sent.jsonl');
    const parent = (status, ordinal) => fs.writeFileSync(stateFile, JSON.stringify({
      id: threadId, status: 'active', latestRun: { runId: `run-${ordinal}`, status, ordinal },
    }));
    // Parent reasoning has ended before the worker asks anything. No running parent is assumed.
    parent('completed', 1);
    fs.writeFileSync(stub, `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2),home=process.env.HOME;
if(args.includes('inspect')||args.includes('read')) {
 const thread=JSON.parse(fs.readFileSync(path.join(home,'parent.json')));
 thread.messages=fs.existsSync(path.join(home,'sent.jsonl'))?fs.readFileSync(path.join(home,'sent.jsonl'),'utf8').trim().split('\\n').filter(Boolean).map(line=>({role:'user',text:JSON.parse(line).text})):[];
 console.log(JSON.stringify({ok:true,data:{runtime:{environmentId:'fake-environment'},thread}}));
} else if(args.includes('send')) {
 let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{
 fs.appendFileSync(path.join(home,'sent.jsonl'),JSON.stringify({thread:args[args.indexOf('--thread')+1],text})+'\\n');
 console.log(JSON.stringify({ok:true,data:{}}));});
} else process.exit(2);
`, { mode: 0o700 });
    receiver = await startT3ResultFixture({ home: adapter.home, threadId, fakeCommand: stub, messageFile: 'sent.jsonl' });
    Object.assign(adapter.serverEnv, receiver.env, {
      NODE_ENV: 'test', DOT_BRIDGE_T3_DRY_RUN: '0', DOT_BRIDGE_T3CODE_BIN: stub,
      DALAN_T3_HELD_RECHECK_MS: '10',
    });
    await adapter.startServer();
    const messages = id => (fs.existsSync(messagesFile) ? fs.readFileSync(messagesFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
      .filter(row => row.text.includes(id));
    const receiptsDir = path.join(adapter.home, '.local/share/dot-bridge/receipts');
    const owner = id => JSON.parse(fs.readFileSync(path.join(receiptsDir, createHash('sha256').update(id).digest('hex') + '.json'))).token;
    async function resume(ordinal, notices) {
      const before = notices();
      parent('running', ordinal);
      // R6 checks held wakes on its own timer, separately from the drain scheduler.
      const deadline = Date.now() + (mode === 't3' ? 3000 : 0);
      do {
        await adapter.tick();
        if (notices() > before || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (true);
      await adapter.tick();
    }
    const revision = id => adapter.q1('SELECT revision FROM claim_command_revisions WHERE job=?', id).revision;
    const question = id => adapter.q1('SELECT * FROM job_questions WHERE request_id=? AND question_id=?', id, 'Q');
    let serial = 0;
    async function worker(name, job, extra = {}) {
      return value(await adapter.mcp('W1', name, {
        request_id: job.id, ...(job.grant ? { claim_id: job.grant.claim_id, epoch: job.grant.epoch } : {}),
        command_key: `demo-${++serial}`, expected_revision: revision(job.id), ...extra,
      }));
    }
    async function submit(suffix) {
      const id = `req_relationship_${mode}_${suffix}`;
      const assignment = { schema_version: 1, request_id: id, brief: 'Choose a format, then return it', inputs: [],
        expected_output: 'The selected format', execution_scope: 'read-only',
        protocol: { profile: 'job-v0', source: 'git:BASE', scope: 'read:fixture', policy: 'P0', destination: 'owner-inbox', retain_until_ms: adapter.baseMs + 3600000 } };
      json(await cli(adapter, ['submit', '--stdin', '--deliver', mode === 'cli' ? 'none' : `t3:${threadId}`, '--json'], JSON.stringify(assignment)));
      const job = { id };
      job.grant = await worker('claim', job, { claimant: 'demo', lease_ms: 60000 });
      return job;
    }
    async function ask(job) {
      await worker('ask_question', job, { question_id: 'Q', text: 'Return JSON or plain text?' });
    }
    async function finish(job) {
      return worker('finish', job, { outcome: 'completed', summary: `Selected JSON for ${job.id}`,
        result: JSON.stringify({ source: 'git:BASE', policy: 'P0', format: 'JSON' }) });
    }
    const job = await submit('first');
    await ask(job);
    cut(mode, 'question after parent run ended', () => {
      assert.equal(JSON.parse(fs.readFileSync(stateFile)).latestRun.status, 'completed');
      assert.equal(question(job.id).answer, null);
      assert.equal(jsonQuestionCount(), 1);
    });
    function jsonQuestionCount() { return adapter.q1('SELECT count(*) n FROM job_questions WHERE request_id=?', job.id).n; }
    if (mode === 'cli') {
      const wake = await cli(adapter, ['wait', job.id, '--timeout', '1', '--json']);
      cut(mode, 'one question wake', () => { assert.equal(wake.code, 3, wake.stderr); assert.equal(JSON.parse(wake.stdout).status, 'question'); assert.equal(messages(job.id).length, 0); });
    } else {
      await adapter.tick(); await adapter.tick();
      cut(mode, 'one question wake', () => { assert.equal(messages(job.id).length, 1); assert.equal(messages(job.id)[0].thread, threadId); });
    }
    const questions = json(await cli(adapter, ['questions', job.id, '--json']));
    assert.equal(questions.questions[0].question_id, 'Q');
    // PR R5: the original envelope survives a committed answer whose reply was lost.
    let journal;
    try { journal = await import('../src/answer-journal.mjs'); }
    catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
    const savedRevision = revision(job.id);
    const envelope = { id: job.id, question_id: 'Q', text: 'JSON', command_key: 'answer:Q', expected_revision: savedRevision };
    let original;
    if (journal) {
      const prepared = await journal.prepare(job.id, 'Q', 'JSON', { receiptsDir, readRevision: async () => savedRevision });
      await assert.rejects(journal.send(prepared, {
        attempts: 1, post: async body => { original = value(await adapter.admin('POST', '/answer', body, owner(job.id))); throw Object.assign(new Error('reply lost after commit'), { kind: 'transport' }); },
        readQuestion: async () => question(job.id),
      }), /reply lost/);
    } else original = value(await adapter.admin('POST', '/answer', envelope, owner(job.id)));
    await worker('renew_claim', job, { lease_ms: 60000 });
    const advanced = revision(job.id);
    assert.ok(advanced > savedRevision + 1, 'worker advanced revision after answer commit');
    fs.writeFileSync(adapter.ackFile, '0'); // The new preload starts its scheduler acknowledgment counter at zero.
    await adapter.control({ op: 'restart' }); // SIGKILL + respawn on the same SQLite file.
    const replay = await cli(adapter, ['answer', job.id, 'Q', 'JSON', '--json']);
    cut(mode, 'answer journal and CLI replay after kill at advanced revision', () => {
      assert.ok(journal, 'R5 answer journal module missing');
      const reply = json(replay);
      assert.equal(reply.revision, original.revision, 'replay returns the original receipt');
      const saved = JSON.parse(fs.readFileSync(path.join(receiptsDir, `${job.id}.answers/Q.json`)));
      assert.equal(saved.expected_revision, savedRevision); assert.equal(saved.key, envelope.command_key); assert.equal(saved.text, 'JSON');
      assert.equal(saved.state, 'committed');
      assert.equal(revision(job.id), advanced, 'replay does not mutate the job');
    }, 'R5');
    if (journal) {
      const reconciled = await journal.reconcile(job.id, 'Q', { receiptsDir, readQuestion: async () => question(job.id) });
      assert.ok(['committed', 'confirmed'].includes(reconciled.state));
    }
    cut(mode, 'one committed answer', () => {
      assert.equal(question(job.id).answer, 'JSON');
      assert.equal(adapter.q1("SELECT count(*) n FROM claim_command_receipts WHERE job=? AND command_key='answer:Q'", job.id).n, 1);
      assert.equal(adapter.q1("SELECT count(*) n FROM protocol_events WHERE request_id=? AND event_type='answered'", job.id).n, 1);
    });
    const consumed = await worker('consume_answer', job, { question_id: 'Q' });
    cut(mode, 'consume_answer', () => { assert.equal(consumed.answer, 'JSON'); assert.ok(question(job.id).consumed_at); });
    await finish(job); await adapter.tick(); await adapter.tick();
    if (mode === 'cli') {
      const result = await cli(adapter, ['wait', job.id, '--timeout', '1', '--json']);
      cut(mode, 'finish returns only to eligible parent', () => { assert.equal(json(result).status, 'finished'); assert.equal(messages(job.id).length, 0); });
    } else cut(mode, 'finish returns only to eligible parent', () => {
      const results = messages(job.id).filter(row => row.text.includes('Fetch full report'));
      assert.equal(results.length, 1); assert.ok(messages(job.id).every(row => row.thread === threadId));
    });
    // Same stopped-parent trace in both modes. CLI leaves it unread; T3 must hold it durably.
    const held = await submit('held'); parent('interrupted', 2); await ask(held);
    await adapter.tick(); await adapter.tick();
    // PR R6: interrupted is held, not active or permanently suppressed.
    cut(mode, 'stopped parent holds question wake', () => {
      assert.equal(messages(held.id).length, 0);
      assert.equal(question(held.id).answer, null);
      if (mode === 't3') assert.ok(adapter.q("SELECT * FROM notifications WHERE request_id=? AND kind='wait' AND state='pending'", held.id).length);
    }, mode === 't3' ? 'R6' : '');
    const beforeQuestionResume = messages(held.id).length;
    await resume(3, () => messages(held.id).length);
    // PR R6: resume releases the held question once, under its original identity.
    cut(mode, 'held question delivered once on resume', () => {
      assert.equal(messages(held.id).length - beforeQuestionResume, mode === 't3' ? 1 : 0);
    }, mode === 't3' ? 'R6' : '');
    value(await adapter.admin('POST', '/answer', { id: held.id, question_id: 'Q', text: 'JSON', command_key: 'answer:Q', expected_revision: revision(held.id) },
      owner(held.id)));
    await worker('consume_answer', held, { question_id: 'Q' });
    parent('interrupted', 4); await finish(held); await adapter.tick(); await adapter.tick();
    cut(mode, 'result retained while parent stopped', () => {
      assert.equal(adapter.q1('SELECT outcome FROM reports WHERE request_id=?', held.id).outcome, 'completed');
    });
    cut(mode, 'stopped parent holds result wake', () => {
      assert.equal(messages(held.id).filter(row => row.text.includes('Fetch full report')).length, 0);
    }, mode === 't3' ? 'R6' : '');
    const beforeResultResume = messages(held.id).filter(row => row.text.includes('Fetch full report')).length;
    await resume(5, () => messages(held.id).filter(row => row.text.includes('Fetch full report')).length);
    // PR R6: retained result becomes eligible on resume, exactly once.
    cut(mode, 'held result delivered once on resume', () => {
      assert.equal(messages(held.id).filter(row => row.text.includes('Fetch full report')).length - beforeResultResume, mode === 't3' ? 1 : 0);
    }, mode === 't3' ? 'R6' : '');
    if (mode === 'cli') assert.equal(json(await cli(adapter, ['wait', held.id, '--timeout', '1', '--json'])).status, 'finished');
    const before = adapter.q1('SELECT * FROM reports WHERE request_id=?', job.id);
    const followup = await submit('followup');
    cut(mode, 'follow-up is a new job', () => {
      assert.notEqual(followup.id, job.id); assert.notEqual(followup.grant.claim_id, job.grant.claim_id);
      assert.deepEqual(adapter.q1('SELECT * FROM reports WHERE request_id=?', job.id), before);
      assert.equal(adapter.q1('SELECT count(*) n FROM job_questions WHERE request_id=?', followup.id).n, 0);
    });
    if (mode === 't3') {
      // PR R6: hosts supply opaque generation and continuation admission through the destination seam.
      const destination = createT3Destination({ store: {} });
      cut(mode, 'destination generation interface', () => {
        assert.equal(typeof destination.readGeneration, 'function');
        assert.equal(typeof destination.canAdmitContinuation, 'function');
      }, 'R6');
    }
  } finally {
    await adapter.killServer();
    if (receiver) { receiver.beginPassedTeardown(); await receiver.close(); }
    await adapter.close();
  }
}
for (const mode of ['cli', 't3']) {
  try { await trace(mode); }
  catch (error) { failures.push({ mode, name: 'trace infrastructure', error: error.stack }); console.error(error); }
}
console.log(`B4 relationship e2e: ${failures.length} failed cuts`);
if (failures.length) process.exitCode = 1;
