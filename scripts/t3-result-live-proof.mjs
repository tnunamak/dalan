#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dispatchT3Result, resultDeliveryIds } from '../src/t3-transport.mjs';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const value = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const projectId = value('--project-id');
const environmentId = value('--environment-id');
const databasePath = value('--database');
const repoRoot = value('--repo-root');
const t3Command = value('--t3-command');
const cliRoot = value('--cli-root');
const required = { '--project-id': projectId, '--environment-id': environmentId, '--database': databasePath, '--repo-root': repoRoot, '--cli-root': cliRoot };
if (Object.entries(required).some(([, item]) => !item) || (execute && !t3Command)) {
  console.error('Usage: node scripts/t3-result-live-proof.mjs --project-id ID --environment-id ID --database PATH --repo-root PATH [--t3-command ABSOLUTE_PATH] --cli-root PATH [--execute]');
  process.exit(2);
}
if (databasePath !== path.resolve(databasePath) || repoRoot !== path.resolve(repoRoot) || (execute && (!path.isAbsolute(t3Command) || !realpathSync(t3Command)))) {
  console.error('Database, repo root, and execute-mode t3 command must be explicit absolute paths.');
  process.exit(2);
}

const dbPath = realpathSync(databasePath);
const expectedRepo = realpathSync(repoRoot);
const cliPackagePath = path.join(cliRoot, 'package.json');
const packageInfo = JSON.parse(await (await import('node:fs/promises')).readFile(cliPackagePath, 'utf8'));
assert.equal(packageInfo.name, '@bvdm/t3code-cli');
assert.equal(packageInfo.version, '0.3.0', 'pinned internal CLI API version changed; review before running');
const apiUrl = pathToFileURL(path.join(cliRoot, 'dist/api.js')).href;
const runtimeUrl = pathToFileURL(path.join(cliRoot, 'dist/runtime.js')).href;
const configUrl = pathToFileURL(path.join(cliRoot, 'dist/config.js')).href;
const { withT3Api } = await import(apiUrl);
const { discoverRuntime } = await import(runtimeUrl);
const { DEFAULT_CONFIG } = await import(configUrl);
assert.equal(typeof withT3Api, 'function');
assert.equal(typeof discoverRuntime, 'function');

const project = (() => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const row = db.prepare('SELECT project_id, workspace_root, deleted_at FROM projection_projects WHERE project_id = ?').get(projectId);
    assert(row, 'specified project does not exist in supplied receiver database');
    assert.equal(row.deleted_at, null, 'specified project is deleted');
    assert.equal(realpathSync(row.workspace_root), expectedRepo, 'project workspace root does not exactly match supplied repo root');
    return row;
  } finally { db.close(); }
})();

function readState(threadId, ids) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const schema = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const table of ['orchestration_command_receipts', 'orchestration_v2_projection_threads', 'orchestration_v2_projection_runs', 'orchestration_v2_projection_messages', 'orchestration_v2_effect_outbox']) {
      assert(schema.has(table), `receiver database lacks expected table ${table}`);
    }
    const thread = db.prepare('SELECT project_id, archived_at, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?').get(threadId) ?? null;
    const receipt = db.prepare('SELECT command_id, aggregate_id AS thread_id, command_type, result_sequence, status FROM orchestration_command_receipts WHERE command_id = ?').all(ids.commandId);
    const messageCount = db.prepare('SELECT count(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ? AND message_id = ?').get(threadId, ids.messageId).count;
    const runCount = db.prepare('SELECT count(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ?').get(threadId).count;
    const activeRunCount = db.prepare("SELECT count(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ? AND lower(status) IN ('starting', 'running')").get(threadId).count;
    const effectCount = db.prepare('SELECT count(*) AS count FROM orchestration_v2_effect_outbox WHERE thread_id = ?').get(threadId).count;
    const providerStartCount = db.prepare("SELECT count(*) AS count FROM orchestration_v2_effect_outbox WHERE thread_id = ? AND effect_type = 'provider-turn.start'").get(threadId).count;
    return { thread, receipt, receiptCount: receipt.length, messageCount, runCount, activeRunCount, effectCount, providerStartCount };
  } finally { db.close(); }
}

let phase = 'preflight';
let scratchThreadId = null;
try {
  if (!execute) {
    console.log(JSON.stringify({ mode: 'dry-run', projectId, environmentId, database: dbPath, repoRoot: expectedRepo, cliVersion: packageInfo.version, wouldCreateEmptyThread: true, wouldDispatchTwiceWithDeferStart: true, authIssued: false, note: 'Pass --execute and --t3-command ABSOLUTE_PATH to run the owner-authorized local proof.' }, null, 2));
    process.exit(0);
  }

  const previousCommand = process.env.DOT_BRIDGE_T3_COMMAND;
  process.env.DOT_BRIDGE_T3_COMMAND = t3Command;
  try {
    const config = { ...DEFAULT_CONFIG, t3Home: process.env.T3CODE_HOME, t3Command: [t3Command] };
    phase = 'runtime-check';
    const runtime = await discoverRuntime(config, { startDesktopIfNeeded: false });
    assert.equal(runtime.environmentId, environmentId, 'runtime environment ID differs from explicit target');
    assert.equal(runtime.orchestrationProtocolVersion, 2, 'T3 does not expose orchestration protocol 2');

    const existingScratch = value('--thread-id');
    scratchThreadId = existingScratch ?? randomUUID();
    const createCommand = {
      type: 'thread.create', commandId: randomUUID(), threadId: scratchThreadId, projectId,
      title: `dot-bridge retry proof ${new Date().toISOString()}`,
      modelSelection: { instanceId: 'codex', model: 'gpt-6-luna' },
      runtimeMode: 'approval-required', interactionMode: 'plan', branch: null, worktreePath: null,
      createdBy: 'user', creationSource: 'web',
    };
    phase = 'scratch-create';
    if (!existingScratch) await withT3Api(runtime, config, async api => {
      assert.equal(typeof api.dispatchCommand, 'function', 'pinned CLI API dispatchCommand shape changed');
      await api.dispatchCommand(createCommand);
    });

    const jobId = `dot-bridge-owner-proof:${scratchThreadId}`;
    const effectId = 'receiver-dedupe-proof-result';
    const ids = resultDeliveryIds(jobId, effectId);
    const message = 'Inert retry proof. Keep this run held; do not release or start provider work.';
    let prior = null;
    const attempts = [];
    const sessionIds = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      phase = `before-send-${attempt}`;
      const before = readState(scratchThreadId, ids);
      assert.equal(before.providerStartCount, 0, 'provider-turn.start outbox effect exists before send');
      assert.equal(before.activeRunCount, 0, 'running/starting run exists before send');
      if (attempt === 1) {
        assert(before.thread, 'thread.create did not persist the scratch thread');
        assert.equal(before.thread.project_id, projectId, 'scratch thread is bound to a different project');
        assert.equal(before.thread.archived_at, null);
        assert.equal(before.thread.deleted_at, null);
        const existing = args.includes('--resume') ? 1 : 0;
        assert.equal(before.receiptCount, existing);
        assert.equal(before.messageCount, existing);
        assert.equal(before.runCount, existing);
        if (existing) assert.equal(before.receipt[0].thread_id, scratchThreadId);
      } else {
        assert.deepEqual(before, prior, 'receiver state changed between first response and retry');
      }

      phase = `dispatch-${attempt}`;
      const result = await dispatchT3Result(scratchThreadId, environmentId, jobId, effectId, message, { dispatchMode: { type: 'defer_start' }, onSession: id => sessionIds.push(id) });
      phase = `after-send-${attempt}`;
      const after = readState(scratchThreadId, ids);
      assert.equal(after.providerStartCount, 0, 'provider-turn.start outbox effect exists after send');
      assert.equal(after.activeRunCount, 0, 'running/starting run exists after send');
      assert.equal(after.receiptCount, 1, 'expected one durable command receipt');
      assert.equal(after.receipt[0].command_type, 'message.dispatch');
      assert.equal(after.receipt[0].thread_id, scratchThreadId);
      assert.equal(after.messageCount, 1, 'expected one persisted message for stable message ID');
      assert.equal(after.runCount, 1, 'expected one held run for scratch thread');
      if (attempt === 2) {
        assert.deepEqual(result, attempts[0].result, 'retry returned a different command receipt');
        assert.deepEqual(after, prior, 'retry changed receipt/message/run/effect counts');
      }
      else prior = after;
      attempts.push({ result, state: after });
    }

    assert.equal(new Set(sessionIds).size, 2, 'proof requires two distinct authentication sessions');
    console.log(JSON.stringify({ status: 'passed', resumedAcceptedEffect: args.includes('--resume'), sessionIds, scratchThreadId, projectId: project.project_id, environmentId, ids, attempts: attempts.length, dispatchResults: attempts.map(item => item.result), receipt: attempts[1].state.receipt[0], counts: { messages: attempts[1].state.messageCount, runs: attempts[1].state.runCount, effects: attempts[1].state.effectCount }, providerTurnStartEffects: 0, activeRuns: 0, threadDisposition: 'left held for owner review; no archive command sent' }, null, 2));
  } finally {
    if (previousCommand === undefined) delete process.env.DOT_BRIDGE_T3_COMMAND;
    else process.env.DOT_BRIDGE_T3_COMMAND = previousCommand;
  }
} catch {
  console.error(JSON.stringify({ status: 'failed', phase, scratchThreadId, instruction: scratchThreadId ? 'Leave this scratch thread held; inspect the read-only receiver state before any cleanup or release.' : 'No scratch thread ID was returned; inspect the local receiver before retrying.' }));
  process.exitCode = 1;
}
