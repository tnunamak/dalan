import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateWorkers } from '../src/service-migrate-workers.mjs';
import { loadWorkers, loadOwnerWorkers, inspectGrantAudit } from '../src/workers.mjs';

fs.mkdirSync(path.join(os.homedir(), '.tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp/b8-migrate-'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
try {
  const a = path.join(root, 'a.json'), b = path.join(root, 'b.json');
  save(a, { workers: { dot: { connections: [{ issuer: 'https://old.test', subject: 'old-subject', client_id: 'old-client' }], capabilities: ['t3'], repos: ['acme/dot'] } }, default_execution: 'host' });
  save(b, { workers: { muse: { repos: ['acme/muse'], guidance: 'resume' }, 'duet-default': { repos: [] }, 'duet-dondo': { repos: [] } } });
  const originals = [fs.readFileSync(a), fs.readFileSync(b)];
  const result = migrateWorkers({ home: path.join(root, 'new'), sources: [a, b] });
  const raw = fs.readFileSync(result.workers_file, 'utf8');
  assert.doesNotMatch(raw, /old-subject|old-client|old.test|connections|host/);
  const profile = loadWorkers(result.workers_file, { builtin: true, auditGrants: true });
  assert.deepEqual([...profile.workers.keys()], ['dot', 'muse', 'duet-default', 'duet-dondo']);
  assert.deepEqual(profile.repoPolicy('dot').repos, ['acme/dot']);
  assert.deepEqual(profile.repoPolicy('muse').repos, ['acme/muse']);
  assert.equal(profile.allowsRepo('duet-default', 'acme/dot'), false);
  assert.equal(profile.defaultExecution, 'none');
  assert.equal(profile.workers.get('dot').capabilities.has('t3'), true);
  assert.equal(inspectGrantAudit(result.workers_file).integrity_error, null);
  assert.deepEqual(fs.readFileSync(a), originals[0]);
  assert.deepEqual(fs.readFileSync(b), originals[1]);
  assert.equal(fs.statSync(result.workers_file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(result.home, '.config/dalan')).sort(), ['workers-audit-checkpoint.sqlite', 'workers-audit.jsonl', 'workers.json']);
  assert.throws(() => migrateWorkers({ home: result.home, sources: [a] }), /EEXIST/);
  const duplicate = path.join(root, 'duplicate');
  assert.throws(() => migrateWorkers({ home: duplicate, sources: [a, a] }), /duplicate worker dot/);
  assert.equal(fs.existsSync(duplicate), false);
  assert.throws(() => migrateWorkers({ home: duplicate, sources: [path.join(root, 'missing.json')] }), /no worker policy/);
  const bad = path.join(root, 'bad.json');
  save(bad, { workers: { muse: { repos: ['acme/*'] } } });
  assert.throws(() => migrateWorkers({ home: duplicate, sources: [bad] }), /invalid repository/);
  assert.equal(fs.existsSync(duplicate), false);
  // Exercise the actual old dot repos-only format, through the existing read-only loader.
  const legacy = path.join(root, 'workers.json');
  save(path.join(root, 'workers-repos.json'), { version: 1, entries: [{ worker: 'dot', kind: 'legacy', repos: ['acme/legacy'], complete: true, event: { event_id: '11111111-1111-1111-1111-111111111111', at: new Date().toISOString(), actor: { host_uid: process.getuid() }, worker: 'dot', before: { mode: 'legacy-any', repos: null }, after: { mode: 'exact', repos: ['acme/legacy'] } } }] });
  const legacyBefore = fs.readFileSync(path.join(root, 'workers-repos.json'));
  const imported = migrateWorkers({ home: path.join(root, 'legacy-new'), sources: [legacy] });
  assert.deepEqual(loadOwnerWorkers(imported.workers_file).repoPolicy('dot').repos, ['acme/legacy']);
  assert.deepEqual(fs.readFileSync(path.join(root, 'workers-repos.json')), legacyBefore);
  assert.equal(fs.existsSync(legacy), false);
  console.log('PASS four-worker migration preserves exact allowlists, writes fresh audit, copies no identities/jobs, and refuses existing homes');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
