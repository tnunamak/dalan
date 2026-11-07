#!/usr/bin/env node
// A fresh profile whose only worker has an arbitrary name (not a vendor or product name) runs the whole job loop:
// submit, claim, progress, finish, wait, get, decide. Nothing on the way may fall back to the legacy worker name "dot".
// The worker reaches the bridge through the real built-in OAuth flow; the requester uses the real CLI.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beginPairing, DEMO_REDIRECT, openSession } from '../src/demo-worker.mjs';
import { reservedPort } from '../src/test-support/port.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const WORKER = 'acme';
// The legacy worker name as a word, or as part of a snake_case field name (worker_break, skipped_by_worker).
const LEAK = /(?<![a-z0-9])dot(?![a-z0-9])|dot_|_dot/i;
// Random secrets and IDs (base64, base64url) can spell "Dot" by chance. Mask mixed-case tokens with a digit before the search.
const maskOpaque = value => value.replace(/[A-Za-z0-9+/_=-]{16,}/g, token => /\d/.test(token) && /[A-Z]/.test(token) && /[a-z]/.test(token) ? '<token>' : token);
const tempRoot = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const home = fs.mkdtempSync(path.join(tempRoot, 'neutral-'));
const port = await reservedPort();
const env = { PATH: process.env.PATH, HOME: home, DALAN_LOOPBACK: '1', DALAN_AUTH_MODE: 'builtin', DALAN_PORT: String(port) };
const seen = [];
const dalan = args => new Promise((resolve, reject) => execFile(process.execPath, [path.join(repo, 'bin/dalan.mjs'), ...args], { env, cwd: repo, timeout: 30_000 },
  (error, stdout, stderr) => {
    seen.push([`cli: dalan ${args.slice(0, 2).join(' ')} (stdout)`, stdout], [`cli: dalan ${args.slice(0, 2).join(' ')} (stderr)`, stderr]);
    if (error) { reject(new Error(`dalan ${args.slice(0, 2).join(' ')}: ${(stderr || stdout || error.message).trim()}`)); } else { resolve(stdout); }
  }));
const log = path.join(home, 'server.log');
let server;
try {
  await dalan(['init', '--worker', WORKER, '--public-url', `http://127.0.0.1:${port}`]);
  const fd = fs.openSync(log, 'w', 0o600);
  server = spawn(process.execPath, [path.join(repo, 'src/server.mjs')], { env, cwd: repo, stdio: ['ignore', fd, fd] });
  for (let i = 0; !/MCP listening/.test(fs.readFileSync(log, 'utf8')); i++) {
    assert.ok(i < 200 && server.exitCode === null, `server did not start:\n${fs.readFileSync(log, 'utf8')}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const configDir = path.join(home, '.config/dalan');
  const secret = /^BRIDGE_PATH_SECRET=(.+)$/m.exec(fs.readFileSync(path.join(configDir, 'env'), 'utf8'))[1];
  const mcpUrl = `http://127.0.0.1:${port}/${secret}/mcp`;
  await dalan(['connect', 'allow-callback', 'http://127.0.0.1/callback']);
  await dalan(['connect', 'start', '--worker', WORKER]);

  // Submit without naming a worker: a one-worker profile must route to its only worker, not to a legacy default.
  const requestId = `req_${randomUUID()}`;
  const file = path.join(home, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, request_id: requestId, brief: 'Report the exact phrase: neutral worker report.', inputs: [], expected_output: 'Text report.', execution_scope: 'read-only' }));
  const submitted = JSON.parse(await dalan(['submit', '--execution', 'none', '--deliver', 'none', '--file', file, '--json']));
  assert.ok(JSON.stringify(submitted).includes(requestId), 'submit returned the new job');

  const pairing = await beginPairing(mcpUrl);
  await dalan(['connect', 'approve', pairing.code, '--worker', WORKER, '--confirm-redirect', DEMO_REDIRECT, '--replace']);
  const token = await pairing.complete();
  const rawCall = await openSession(mcpUrl, token);
  const call = async (name, args) => { const response = await rawCall(name, args); seen.push([`tool response: ${name}`, JSON.stringify(response)]); return response; };
  const pending = await call('list_pending', {});
  assert.ok(pending.assignments.some(a => a.request_id === requestId), 'the worker sees the job');
  const { claim_id } = await call('claim', { request_id: requestId, claimant: 'acme-agent' });
  await call('progress', { request_id: requestId, claim_id, note: 'writing the report' });
  await call('finish', { request_id: requestId, claim_id, outcome: 'completed', summary: 'neutral worker report', result: 'neutral worker report' });

  const waited = JSON.parse(await dalan(['wait', requestId, '--timeout', '10', '--json']));
  const got = JSON.parse(await dalan(['get', requestId, '--json']));
  assert.equal(got.status, 'finished');
  assert.equal(got.report?.result, 'neutral worker report');
  await dalan(['decide', requestId, 'accepted']);
  const status = await dalan(['status', '--json']);
  await dalan(['status']);
  await dalan(['paths']);
  await dalan(['worker', 'list', '--json']);

  // No stored row and no output names the legacy worker.
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  const db = new DatabaseSync(path.join(home, '.local/share/dalan/bridge.db'), { readOnly: true });
  const workerColumns = [['assignments', 'target_worker'], ['claims', 'worker'], ['lifecycle_events', 'worker'], ['worker_calls', 'worker'], ['worker_activity', 'worker'], ['subscriptions', 'worker']];
  for (const [table, column] of workerColumns) {
    const values = db.prepare(`SELECT DISTINCT ${column} v FROM ${table}`).all().map(r => r.v);
    assert.ok(!values.includes('dot'), `${table}.${column} holds the legacy worker name: ${JSON.stringify(values)}`);
  }
  assert.deepEqual(db.prepare('SELECT DISTINCT target_worker v FROM assignments').all().map(r => r.v), [WORKER]);
  db.close();
  // Every stored text value, every created file name and the server log must be free of the legacy worker name.
  const text = [];
  const dbRead = new DatabaseSync(path.join(home, '.local/share/dalan/bridge.db'), { readOnly: true });
  for (const { name } of dbRead.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    for (const row of dbRead.prepare(`SELECT * FROM "${name}"`).all()) {
      for (const [column, value] of Object.entries(row)) { if (typeof value === 'string') { text.push([`event row: ${name}.${column}`, value]); } }
    }
  }
  // The schema text itself (tables, indexes, triggers, columns' defaults) must not name the legacy worker either.
  for (const { type, name, sql } of dbRead.prepare('SELECT type, name, sql FROM sqlite_master').all()) {
    text.push([`schema name: ${type} ${name}`, name]);
    if (typeof sql === 'string') { text.push([`schema sql: ${type} ${name}`, sql]); }
  }
  dbRead.close();
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? [path.join(dir, e.name), ...walk(path.join(dir, e.name))] : [path.join(dir, e.name)]);
  for (const file of walk(home)) {
    text.push([`created file name: ${path.relative(home, file)}`, path.basename(file)]);
    if (/\.(json|jsonl|log|env|txt|md)$|\/env$/.test(file) && fs.statSync(file).size < 5_000_000) { text.push([`created file: ${path.relative(home, file)}`, fs.readFileSync(file, 'utf8')]); }
  }
  text.push(['server log', fs.readFileSync(log, 'utf8')], ['tool response: wait', JSON.stringify(waited)], ['tool response: get', JSON.stringify(got)], ['submit', JSON.stringify(submitted)], ...seen);
  const leaks = [...new Set(text.map(([label, value]) => [label, maskOpaque(value)]).filter(([, value]) => LEAK.test(value)).map(([label, value]) => `${label.replace(/\d+/g, 'N')}: ${/.{0,40}(?<![a-z0-9])dot(?![a-z0-9]).{0,40}|.{0,40}(dot_|_dot).{0,40}/i.exec(value)[0]}`))];
  assert.deepEqual(leaks, [], 'the legacy worker name "dot" appears in output a new user sees');
  for (const [label, text] of [['wait', JSON.stringify(waited)], ['get', JSON.stringify(got)], ['status', status], ['submit', JSON.stringify(submitted)]]) {
    assert.doesNotMatch(text, /:"dot"|"dot"[,\]]/, `${label} output names the legacy worker`);
  }
  console.log('PASS neutral worker: a profile whose only worker is "acme" submits, claims, finishes, waits and gets with no legacy worker name');
} finally {
  if (server && server.exitCode === null) { server.kill('SIGKILL'); }
  fs.rmSync(home, { recursive: true, force: true });
}
