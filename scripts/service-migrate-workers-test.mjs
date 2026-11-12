import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrateWorkers } from '../src/service-migrate-workers.mjs';
import { loadWorkers, loadOwnerWorkers, inspectGrantAudit, updateWorkerRepoPolicy, workerRepoMigrationFile } from '../src/workers.mjs';

fs.mkdirSync(path.join(os.homedir(), '.tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp/dalan-service-migrate-'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
try {
  // Migration may copy only grants backed by source audit evidence, without writing there.
  const snapshot = directory => fs.readdirSync(directory, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name), stat = fs.statSync(file);
    return [{file, mtimeMs: stat.mtimeMs, mode: stat.mode, ...(entry.isFile() ? {bytes: fs.readFileSync(file).toString('base64')} : {})},
      ...(entry.isDirectory() ? snapshot(file) : [])];
  });
  for (const mode of ['valid', 'unaudited', 'corrupt-tail', 'truncated', 'corrupt-checkpoint']) {
    const sourceDir = path.join(root, 'evidence-' + mode);
    fs.mkdirSync(sourceDir, {mode: 0o700});
    const source = path.join(sourceDir, 'workers.json');
    save(source, {workers: {evidence: {repos: []}}});
    if (mode !== 'unaudited') updateWorkerRepoPolicy(source, 'evidence', 'allow', 'acme/a');
    save(source, {workers: {evidence: {repos: ['acme/a', 'acme/b']}}});
    const audit = path.join(sourceDir, 'workers-audit.jsonl');
    if (mode === 'corrupt-tail') fs.appendFileSync(audit, '{"torn":');
    if (mode === 'truncated') fs.writeFileSync(audit, '');
    if (mode === 'corrupt-checkpoint') fs.writeFileSync(path.join(sourceDir, 'workers-audit-checkpoint.sqlite'), 'not sqlite');
    const before = snapshot(sourceDir), originalExec = DatabaseSync.prototype.exec;
    let sourceExclusive = 0;
    DatabaseSync.prototype.exec = function(sql) {
      if (/BEGIN\s+EXCLUSIVE/i.test(sql)) {
        const databases = this.prepare('PRAGMA database_list').all();
        if (databases.some(row => row.file && path.dirname(path.resolve(row.file)) === sourceDir)) sourceExclusive++;
      }
      return originalExec.call(this, sql);
    };
    let migrated;
    try { migrated = migrateWorkers({home: path.join(root, 'evidence-new-' + mode), sources: [source]}); }
    finally { DatabaseSync.prototype.exec = originalExec; }
    assert.ok(migrated.denied_repositories.some(item => item.worker === 'evidence' && item.repos.includes('acme/b')), mode + ': denied additions are reported');
    assert.equal(sourceExclusive, 0, mode + ': source never takes an exclusive writer lock');
    assert.deepEqual(snapshot(sourceDir), before, mode + ': source bytes, mtimes and sidecars unchanged');
    const effective = loadWorkers(migrated.workers_file, {builtin: true, auditGrants: true});
    assert.equal(effective.allowsRepo('evidence', 'acme/b'), false, mode + ': raw B must not become an audited destination grant');
    assert.equal(effective.allowsRepo('evidence', 'acme/a'), mode !== 'unaudited' && mode !== 'truncated' && mode !== 'corrupt-checkpoint', mode + ': retain only trusted A');
  }
  // A pending profile journal carries the original seed, but the current file can still contain a hand-edited addition.
  // Read-only migration keeps the seed, denies the addition, and never completes or rewrites the source journal.
  for (const { name, repos, expected } of [
    { name: 'pending-profile-extra', repos: ['acme/seeded', 'acme/hand-edited'], expected: ['acme/seeded'] },
    { name: 'pending-profile-removed', repos: [], expected: [] },
  ]) {
    const sourceDir = path.join(root, name);
    fs.mkdirSync(sourceDir, { mode: 0o700 });
    const source = path.join(sourceDir, 'workers.json');
    save(source, { workers: { evidence: { repos } }, default_execution: 'none' });
    const event = { event_id: randomUUID(), at: new Date().toISOString(), actor: { host_uid: process.getuid() }, worker: 'evidence',
      before: { mode: 'legacy-any', repos: null }, after: { mode: 'exact', repos: ['acme/seeded'] } };
    save(workerRepoMigrationFile(source), { version: 1, entries: [{ worker: 'evidence', kind: 'profile', repos: ['acme/seeded'], complete: false, event }] });
    save(path.join(sourceDir, 'workers-audit-checkpoint.sqlite'), 'not sqlite');
    const before = snapshot(sourceDir), originalExec = DatabaseSync.prototype.exec;
    let sourceExclusive = 0, migrated;
    DatabaseSync.prototype.exec = function(sql) {
      if (/BEGIN\s+EXCLUSIVE/i.test(sql)) {
        const databases = this.prepare('PRAGMA database_list').all();
        if (databases.some(row => row.file && path.dirname(path.resolve(row.file)) === sourceDir)) sourceExclusive++;
      }
      return originalExec.call(this, sql);
    };
    try { migrated = migrateWorkers({ home: path.join(root, name + '-new'), sources: [source] }); }
    finally { DatabaseSync.prototype.exec = originalExec; }
    assert.deepEqual(migrated.workers[0].repos, expected, name + ': only current grants backed by the seed event survive');
    assert.equal(migrated.denied_repositories.some(item => item.worker === 'evidence' && item.repos.includes('acme/hand-edited')), name === 'pending-profile-extra', name + ': report the raw addition');
    assert.equal(sourceExclusive, 0, name + ': source never takes an exclusive writer lock');
    assert.deepEqual(snapshot(sourceDir), before, name + ': source bytes, modes, mtimes and pending journal stay unchanged');
    const effective = loadWorkers(migrated.workers_file, { builtin: true, auditGrants: true });
    assert.equal(effective.allowsRepo('evidence', 'acme/seeded'), expected.includes('acme/seeded'), name + ': a removed seed is not restored');
    assert.equal(effective.allowsRepo('evidence', 'acme/hand-edited'), false, name + ': raw addition stays denied');
  }
  // A valid JSON audit event is still untrusted when its checkpointed prefix changes. Exact equality with that event
  // must not bypass the integrity failure and launder its new repository into the destination.
  {
    const sourceDir = path.join(root, 'changed-checkpoint-prefix');
    fs.mkdirSync(sourceDir, { mode: 0o700 });
    const source = path.join(sourceDir, 'workers.json');
    save(source, { workers: { evidence: { repos: [] } }, default_execution: 'none' });
    updateWorkerRepoPolicy(source, 'evidence', 'allow', 'acme/original');
    save(source, { workers: { evidence: { repos: ['acme/edited'] } }, default_execution: 'none' });
    const audit = path.join(sourceDir, 'workers-audit.jsonl');
    const event = JSON.parse(fs.readFileSync(audit, 'utf8').trim());
    event.after.repos = ['acme/edited'];
    fs.writeFileSync(audit, JSON.stringify(event) + '\n', { mode: 0o600 });
    const before = snapshot(sourceDir), originalExec = DatabaseSync.prototype.exec;
    let sourceExclusive = 0, migrated;
    DatabaseSync.prototype.exec = function(sql) {
      if (/BEGIN\s+EXCLUSIVE/i.test(sql)) {
        const databases = this.prepare('PRAGMA database_list').all();
        if (databases.some(row => row.file && path.dirname(path.resolve(row.file)) === sourceDir)) sourceExclusive++;
      }
      return originalExec.call(this, sql);
    };
    try { migrated = migrateWorkers({ home: path.join(root, 'changed-checkpoint-prefix-new'), sources: [source] }); }
    finally { DatabaseSync.prototype.exec = originalExec; }
    assert.ok(migrated.denied_repositories.some(item => item.worker === 'evidence' && item.repos.includes('acme/edited')), 'changed-prefix: report the unaudited repo');
    assert.deepEqual(migrated.workers[0].repos, [], 'changed-prefix: matching raw policy does not validate a changed audit prefix');
    assert.equal(sourceExclusive, 0, 'changed-prefix: source never takes an exclusive writer lock');
    assert.deepEqual(snapshot(sourceDir), before, 'changed-prefix: source bytes, modes, mtimes and sidecars stay unchanged');
    assert.equal(loadWorkers(migrated.workers_file, { builtin: true, auditGrants: true }).allowsRepo('evidence', 'acme/edited'), false);
  }
  const a = path.join(root, 'a.json'), b = path.join(root, 'b.json');
  save(a, { workers: { alpha: { connections: [{ issuer: 'https://old.test', subject: 'old-subject', client_id: 'old-client' }], capabilities: ['t3'], repos: ['acme/alpha'], destination: { provider: 'Example', operator: 'Example operator' } } }, default_execution: 'host' });
  save(b, { workers: { beta: { repos: ['acme/beta'], guidance: 'resume' }, 'gamma': { repos: [] }, 'delta': { repos: [] } } });
  updateWorkerRepoPolicy(a, 'alpha', 'allow', 'acme/alpha');
  updateWorkerRepoPolicy(b, 'beta', 'allow', 'acme/beta');
  const originals = [fs.readFileSync(a), fs.readFileSync(b)];
  const hidden = Object.fromEntries(['password','callbackPath','query','fragment','secret','connection'].map(name => [name, randomBytes(20).toString('hex')]));
  const sourceDb = path.join(root, 'source.sqlite');
  const db = new DatabaseSync(sourceDb);
  db.exec("CREATE TABLE subscriptions(worker TEXT,url TEXT,state TEXT,secret TEXT,connection TEXT,expires_at TEXT DEFAULT '2099-01-01T00:00:00.000Z'); CREATE TABLE destination_approvals(snapshot TEXT);");
  db.prepare('INSERT INTO subscriptions(worker,url,state,secret,connection) VALUES(?,?,?,?,?)').run('alpha', `https://user:${hidden.password}@callback.test/${hidden.callbackPath}?key=${hidden.query}#${hidden.fragment}`, 'active', hidden.secret, hidden.connection);
  db.prepare('INSERT INTO subscriptions(worker,url,state,secret,connection) VALUES(?,?,?,?,?)').run('beta', `https://callback.test/${hidden.callbackPath}`, 'active', hidden.secret, hidden.connection);
  db.prepare('INSERT INTO subscriptions(worker,url,state,secret,connection) VALUES(?,?,?,?,?)').run('alpha', 'https://expired.test/private', 'revoked', 'ENCRYPTED_SECRET', 'ENCRYPTED_CONNECTION');
  db.prepare('INSERT INTO subscriptions(worker,url,state,expires_at) VALUES(?,?,?,?)').run('alpha', 'https://expired-active.test/private', 'active', '2000-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO destination_approvals VALUES(?)').run(JSON.stringify({ worker: 'alpha', connections_digest: 'OLD_CONNECTION_DIGEST', declaration: { provider: 'Example' } }));
  db.close();
  const dbBefore = fs.readFileSync(sourceDb);
  const result = migrateWorkers({ home: path.join(root, 'new'), sources: [a, b], sourceDbs: [sourceDb], workspaceWorkers: ['alpha', 'beta'] });
  const raw = fs.readFileSync(result.workers_file, 'utf8');
  assert.doesNotMatch(raw, /old-subject|old-client|old.test|connections|host/);
  const profile = loadWorkers(result.workers_file, { builtin: true, auditGrants: true });
  assert.deepEqual([...profile.workers.keys()], ['alpha', 'beta', 'gamma', 'delta']);
  assert.deepEqual(profile.repoPolicy('alpha').repos, ['acme/alpha']);
  assert.deepEqual(profile.repoPolicy('beta').repos, ['acme/beta']);
  assert.equal(profile.allowsRepo('gamma', 'acme/alpha'), false);
  assert.equal(profile.defaultExecution, 'none');
  assert.equal(profile.workers.get('alpha').capabilities.has('t3'), true);
  assert.equal(profile.workers.get('beta').capabilities.has('t3'), false);
  assert.equal(profile.workers.get('alpha').workspaceAllowed, true);
  assert.equal(profile.workers.get('beta').workspaceAllowed, true);
  assert.equal(profile.workers.get('gamma').workspaceAllowed, false);
  assert.doesNotMatch(raw, /catalogProfile/);
  assert.equal(profile.workers.get('alpha').destination.provider, 'Example');
  assert.deepEqual(fs.readFileSync(sourceDb), dbBefore);
  const manifestText = fs.readFileSync(result.migration_manifest, 'utf8');
  for (const value of Object.values(hidden)) assert.ok(!manifestText.includes(value), 'private subscription fields omitted');
  assert.doesNotMatch(manifestText, /OLD_CONNECTION_DIGEST|expired.test|expired-active.test/);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.authoritative, false);
  assert.deepEqual(manifest.subscriptions.map(s => [s.worker, s.callback_origin, s.count]), [['alpha', 'https://callback.test', 1], ['beta', 'https://callback.test', 1]]);
  assert.equal(manifest.destination_approvals[0].count, 1);
  assert.equal(result.reenrollment_required, true);
  assert.equal(fs.statSync(result.migration_manifest).mode & 0o777, 0o600);
  assert.equal(inspectGrantAudit(result.workers_file).integrity_error, null);
  assert.deepEqual(fs.readFileSync(a), originals[0]);
  assert.deepEqual(fs.readFileSync(b), originals[1]);
  assert.equal(fs.statSync(result.workers_file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(result.home, '.config/dalan')).sort(), ['service-migration.json', 'workers-audit-checkpoint.sqlite', 'workers-audit.jsonl', 'workers.json']);
  assert.throws(() => migrateWorkers({ home: result.home, sources: [a] }), /EEXIST/);
  const duplicate = path.join(root, 'duplicate');
  assert.throws(() => migrateWorkers({ home: duplicate, sources: [a, a] }), /duplicate worker alpha/);
  assert.equal(fs.existsSync(duplicate), false);
  assert.throws(() => migrateWorkers({ home: duplicate, sources: [path.join(root, 'missing.json')] }), /no worker policy/);
  assert.throws(() => migrateWorkers({ home: duplicate, sources: [a], workspaceWorkers: ['unknown'] }), /unknown workspace worker/);
  assert.equal(fs.existsSync(duplicate), false);
  const badDb = path.join(root, 'bad.sqlite');
  const foreignDb = new DatabaseSync(badDb);
  foreignDb.exec("CREATE TABLE subscriptions(worker TEXT,url TEXT,state TEXT); INSERT INTO subscriptions VALUES('foreign','https://callback.test','active')");
  foreignDb.close();
  assert.throws(() => migrateWorkers({ home: duplicate, sources: [a], sourceDbs: [badDb] }), /unknown worker foreign/);
  assert.equal(fs.existsSync(duplicate), false);
  const bad = path.join(root, 'bad.json');
  save(bad, { workers: { beta: { repos: ['acme/*'] } } });
  assert.throws(() => migrateWorkers({ home: duplicate, sources: [bad] }), /invalid repository/);
  assert.equal(fs.existsSync(duplicate), false);
  // Exercise the legacy repos-only format through the read-only loader.
  const legacy = path.join(root, 'workers.json');
  save(path.join(root, 'workers-repos.json'), { version: 1, entries: [{ worker: 'dot', kind: 'legacy', repos: ['acme/legacy'], complete: true, event: { event_id: '11111111-1111-1111-1111-111111111111', at: new Date().toISOString(), actor: { host_uid: process.getuid() }, worker: 'dot', before: { mode: 'legacy-any', repos: null }, after: { mode: 'exact', repos: ['acme/legacy'] } } }] });
  const legacyBefore = fs.readFileSync(path.join(root, 'workers-repos.json'));
  const imported = migrateWorkers({ home: path.join(root, 'legacy-new'), sources: [legacy] });
  assert.deepEqual(loadOwnerWorkers(imported.workers_file).repoPolicy('dot').repos, ['acme/legacy']);
  assert.deepEqual(fs.readFileSync(path.join(root, 'workers-repos.json')), legacyBefore);
  assert.equal(fs.existsSync(legacy), false);
  console.log('PASS migration preserves worker policy and audited workspace flags; re-enrolment manifest omits credentials, encrypted records and old approval authority; sources unchanged');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
