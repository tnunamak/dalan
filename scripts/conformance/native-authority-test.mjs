#!/usr/bin/env node
// Supplemental native MUST cases. These complement the versioned shared-profile traces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXPECTED_NATIVE_MUST_CASE_IDS } from './profile-version.mjs';
import { Store } from '../../src/store.mjs';
import * as workerConfig from '../../src/workers.mjs';

const destination = { operator: 'Fixture operator', provider: 'Provider A', data_categories: ['assignment'], retention: '30 days', training: 'not used', terms: 'Terms v1' };
const assignment = id => ({ schema_version: 1, request_id: id, brief: 'fixture', inputs: [], expected_output: 'fixture', execution_scope: 'read-only' });
const nativeJob = { protocol: { profile: 'job-v0', source: 'fixture', scope: 'fixture', policy: 'fixture', destination: 'fixture', retain_until_ms: Date.now() + 3600000 } };
const profile = (declared, connectionIds = ['connection-a']) => workerConfig.parseWorkers({ default_execution: 'worker', workers: { alpha: {
  connections: [], repos: ['acme/project'], guidance: 'resume',
  ...(declared ? { destination } : {}),
} } }, { builtin: true, builtinConnectionIds: () => connectionIds });
assert.deepEqual(EXPECTED_NATIVE_MUST_CASE_IDS, ['A1-revoked-holder-no-effect', 'A2-destination-approval-required', 'A3-replacement-cannot-replay-grant']);

function fixture(t, declared) {
  const scratch = path.join(os.homedir(), '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'native-authority-'));
  let current = profile(declared), now = Date.now();
  const store = new Store(path.join(dir, 'bridge.db'), { workers: current, destinationProfile: () => current, now: () => now });
  t.after(() => { if (store.db.isOpen) store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, set: next => { current = next; }, get current() { return current; } };
}

function submit(f, id) {
  const a = { ...assignment(id), ...nativeJob };
  const disclosure = workerConfig.destinationDisclosure(f.current, 'alpha', 'worker', a);
  return f.store.submit(a, { mode: 'none' }, '', 'owner', false, null, 'normal', { source: 'agent' },
    a, null, 'alpha', 'worker', 'worker', null, null, null, null, disclosure?.revision ?? null);
}

function seedArtifactFiles(store, id, claimId, dir) {
  const artifacts = path.join(dir, 'job-files', 'artifacts', id);
  fs.mkdirSync(artifacts, { recursive: true });
  const artifact = path.join(artifacts, 'seed.bin');
  fs.writeFileSync(artifact, 'artifact seed');
  store.db.prepare('INSERT INTO artifacts(id,request_id,claim_id,kind,path,size,sha256,sealed,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(`seed-${id}`, id, claimId, 'upload', artifact, Buffer.byteLength('artifact seed'), null, 0, 'now');
  return { artifacts, artifact };
}

function seedJobFiles(store, id, claimId, dir) {
  const workspace = path.join(dir, 'job-files', 'workspaces', id);
  fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'nested', 'seed.txt'), 'workspace seed');
  store.db.prepare('INSERT INTO workspaces(request_id,claim_id,base_sha,path,created_at) VALUES(?,?,?,?,?)')
    .run(id, claimId, 'base', workspace, 'now');
  return { workspace, ...seedArtifactFiles(store, id, claimId, dir) };
}

function assertNoEffect(before, after, message = 'refusal must leave every job table and file unchanged') {
  assert.deepEqual(after, before, message);
}

function assertSnapshotChangeRejected(before, after, reason) {
  assert.throws(() => assertNoEffect(before, after, reason), new RegExp(reason));
}

function jobSnapshot(store, id) {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const rows = {};
  for (const table of tables) {
    const columns = store.db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name);
    const key = columns.includes('request_id') ? 'request_id' : columns.includes('job') ? 'job' : null;
    if (key) rows[table] = store.db.prepare(`SELECT * FROM "${table}" WHERE "${key}"=?`).all(id);
  }
  const roots = new Map();
  for (const row of rows.workspaces ?? []) if (row.path) roots.set(`workspace:${row.path}`, row.path);
  for (const row of rows.artifacts ?? []) if (row.path) roots.set(`artifact:${path.dirname(row.path)}`, path.dirname(row.path));
  const inventory = (root, current, entries) => {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') { entries[path.relative(root, current) || '.'] = { type: 'missing' }; return; } throw error; }
    const relativePath = path.relative(root, current) || '.';
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) { entries[relativePath] = { type: 'symlink', mode, target: fs.readlinkSync(current) }; return; }
    if (stat.isDirectory()) {
      entries[relativePath] = { type: 'directory', mode };
      for (const name of fs.readdirSync(current).sort()) inventory(root, path.join(current, name), entries);
      return;
    }
    if (stat.isFile()) { entries[relativePath] = { type: 'file', mode, bytes: fs.readFileSync(current).toString('base64') }; return; }
    entries[relativePath] = { type: 'other', mode };
  };
  const files = {};
  for (const [label, root] of roots) {
    const entries = {};
    inventory(root, root, entries);
    files[label] = entries;
  }
  return { rows, files };
}

test('native MUST A1: revoked holder cannot mutate a claim and leaves no claim-scoped rows', t => {
  const f = fixture(t, false), id = 'req_native_revoked';
  const live = new Set(['connection-a']);
  f.store.connectionIsLive = connectionId => live.has(connectionId);
  submit(f, id);
  const claim = f.store.claim(id, 'run', 'subject', 100, null, 'alpha', 'acquire', 10, { key: 'claim', revision: 1 }, 'connection-a');
  const roots = seedJobFiles(f.store, id, claim.claim_id, f.dir);
  const before = jobSnapshot(f.store, id);
  live.clear();
  let error;
  try { f.store.progress(id, claim.claim_id, 'must be refused', 'subject', false, 'alpha', null, { key: 'progress', revision: claim.revision }, 'connection-a'); } catch (e) { error = e; }
  const after = jobSnapshot(f.store, id);
  const assertRefusal = result => {
    assert.equal(result.error?.destination?.error, 'connection_not_live', 'refusal code must be connection_not_live');
    assert.deepEqual(result.after, before, 'refusal must leave every job table and file unchanged');
  };
  const actual = { error, after };
  assertNoEffect(before, after);
  assert.throws(() => assertRefusal({ error, after: { ...before, rows: { ...before.rows, progress: [{ note: 'mutated' }] } } }), /every job table and file unchanged/);
  assert.throws(() => assertRefusal({ error: new Error('wrong refusal'), after: before }), /refusal code must be connection_not_live/);
  assertRefusal(actual);
});

function artifactSnapshotFixture(t, id) {
  const f = fixture(t, false);
  f.store.connectionIsLive = () => true;
  submit(f, id);
  const claim = f.store.claim(id, 'run', 'subject', 100, null, 'alpha', 'acquire', 10, { key: 'claim', revision: 1 }, 'connection-a');
  const roots = seedArtifactFiles(f.store, id, claim.claim_id, f.dir);
  return { f, id, roots };
}

test('file inventory rejects an unregistered artifact create', t => {
  const { f, id, roots } = artifactSnapshotFixture(t, 'req_file_create');
  const before = jobSnapshot(f.store, id);
  fs.writeFileSync(path.join(roots.artifacts, 'unregistered-create.txt'), 'new');
  assertSnapshotChangeRejected(before, jobSnapshot(f.store, id), 'unregistered artifact create');
});

test('file inventory rejects an unregistered artifact modify', t => {
  const { f, id, roots } = artifactSnapshotFixture(t, 'req_file_modify');
  const target = path.join(roots.artifacts, 'unregistered-modify.txt');
  fs.writeFileSync(target, 'before');
  const before = jobSnapshot(f.store, id);
  fs.writeFileSync(target, 'after');
  assertSnapshotChangeRejected(before, jobSnapshot(f.store, id), 'unregistered artifact modify');
});

test('file inventory rejects an unregistered artifact delete', t => {
  const { f, id, roots } = artifactSnapshotFixture(t, 'req_file_delete');
  const target = path.join(roots.artifacts, 'unregistered-delete.txt');
  fs.writeFileSync(target, 'before');
  const before = jobSnapshot(f.store, id);
  fs.unlinkSync(target);
  assertSnapshotChangeRejected(before, jobSnapshot(f.store, id), 'unregistered artifact delete');
});

test('file inventory rejects a file mode change', t => {
  const { f, id, roots } = artifactSnapshotFixture(t, 'req_file_chmod');
  const before = jobSnapshot(f.store, id);
  const mode = fs.statSync(roots.artifact).mode & 0o7777;
  try {
    fs.chmodSync(roots.artifact, mode ^ 0o200);
    assertSnapshotChangeRejected(before, jobSnapshot(f.store, id), 'artifact file mode change');
  } finally { fs.chmodSync(roots.artifact, mode); }
});

test('file inventory rejects a directory mode change', t => {
  const { f, id, roots } = artifactSnapshotFixture(t, 'req_directory_chmod');
  const before = jobSnapshot(f.store, id);
  const mode = fs.statSync(roots.artifacts).mode & 0o7777;
  try {
    fs.chmodSync(roots.artifacts, mode ^ 0o200);
    assertSnapshotChangeRejected(before, jobSnapshot(f.store, id), 'artifact directory mode change');
  } finally { fs.chmodSync(roots.artifacts, mode); }
});

test('file inventory handles populated workspace directories', t => {
  const f = fixture(t, false), id = 'req_workspace_directory';
  f.store.connectionIsLive = () => true;
  submit(f, id);
  const claim = f.store.claim(id, 'run', 'subject', 100, null, 'alpha', 'acquire', 10, { key: 'claim', revision: 1 }, 'connection-a');
  const roots = seedJobFiles(f.store, id, claim.claim_id, f.dir);
  const snapshot = jobSnapshot(f.store, id);
  assert.equal(snapshot.files[`workspace:${roots.workspace}`]['nested'].type, 'directory');
  assert.equal(snapshot.files[`workspace:${roots.workspace}`]['nested/seed.txt'].type, 'file');
});

test('native MUST A2: a new destination declaration blocks an unapproved queued job', t => {
  const f = fixture(t, false), id = 'req_native_approval_required';
  submit(f, id);
  f.set(profile(true));
  const before = {
    claim: f.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),
    receipts: f.store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id),
    events: f.store.db.prepare('SELECT * FROM protocol_events WHERE request_id=?').all(id),
  };
  let error;
  try { f.store.claim(id, 'run', 'subject', 100, null, 'alpha', 'acquire', 10, { key: 'claim', revision: 1 }, 'connection-a'); } catch (e) { error = e; }
  const after = {
    claim: f.store.db.prepare('SELECT * FROM claims WHERE request_id=?').get(id),
    receipts: f.store.db.prepare('SELECT * FROM claim_command_receipts WHERE job=?').all(id),
    events: f.store.db.prepare('SELECT * FROM protocol_events WHERE request_id=?').all(id),
  };
  const assertRefusal = result => {
    assert.equal(result.error?.destination?.error, 'destination_approval_required', 'refusal code must be destination_approval_required');
    assert.deepEqual(result.after, before, 'refusal must not grant a claim or receipt');
  };
  assert.throws(() => assertRefusal({ error, after: { ...before, claim: { claim_id: 'unauthorized' } } }), /refusal must not grant a claim or receipt/);
  assert.throws(() => assertRefusal({ error: new Error('wrong refusal'), after: before }), /refusal code must be destination_approval_required/);
  assertRefusal({ error, after });
});

test('native MUST A3: a replacement connection cannot replay the old holder grant', t => {
  const f = fixture(t, false), id = 'req_native_replacement';
  let live = new Set(['connection-a']);
  f.store.connectionIsLive = connectionId => live.has(connectionId);
  submit(f, id);
  const ctx = { key: 'claim', revision: 1 };
  const claim = f.store.claim(id, 'run', 'subject', 100, null, 'alpha', 'acquire', 10, ctx, 'connection-a');
  seedJobFiles(f.store, id, claim.claim_id, f.dir);
  const before = jobSnapshot(f.store, id);
  live = new Set(['connection-b']);
  let error;
  try { f.store.claim(id, 'run', 'subject', 100, null, 'alpha', 'acquire', 10, ctx, 'connection-b'); } catch (e) { error = e; }
  const after = jobSnapshot(f.store, id);
  const assertRefusal = result => {
    assert.equal(result.error?.destination?.error, 'connection_not_live', 'refusal code must be connection_not_live');
    assert.deepEqual(result.after, before, 'refusal must leave every job table and file unchanged');
  };
  assert.throws(() => assertRefusal({ error, after: { ...before, rows: { ...before.rows, claims: [{ connection_id: 'connection-b' }] } } }), /every job table and file unchanged/);
  assert.throws(() => assertRefusal({ error: new Error('wrong refusal'), after: before }), /refusal code must be connection_not_live/);
  assertRefusal({ error, after });
  assert.equal(f.store.db.prepare('SELECT connection_id FROM claims WHERE request_id=?').get(id).connection_id, 'connection-a');
});
