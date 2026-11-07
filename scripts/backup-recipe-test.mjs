// Runs the worked backup recipe and the restore check from docs/operations.md against real databases. The blocks are read from
// the document and run unchanged, so a change to the document that breaks them fails here.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { withAuditLock } from '../src/workers.mjs';
import { AsStore } from '../src/as-store.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const operations = fs.readFileSync(path.join(repo, 'docs/operations.md'), 'utf8');
const block = marker => {
  const start = operations.indexOf(marker);
  assert.notEqual(start, -1, `docs/operations.md has no ${marker}`);
  const open = operations.indexOf('```sh\n', start) + '```sh\n'.length;
  return operations.slice(open, operations.indexOf('```', open));
};
const recipe = block('**Worked backup recipe.**');
const restoreCheck = block('**Check a restore.**').replace('"$(npm root -g)/@tnunamak/dalan/src/restore-check.mjs"', JSON.stringify(path.join(repo, 'src/restore-check.mjs')));
const haveSqlite3 = spawnSync('sqlite3', ['-version']).status === 0;
const skip = !haveSqlite3 && 'sqlite3 is not installed';
const root0 = process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp');
const secret = 'whsec_' + 'synthetic-backup-recipe-123456';
const isRoot = process.getuid?.() === 0;

// kind: modern (current schema, key), modern-no-key, legacy (schema 49, no key, no marker), marker-no-key (schema 49 with the marker table).
function install(root, { kind = 'modern', artifacts = true, checkpoint = false, webhook = null, as = false } = {}) {
  const home = path.join(root, 'service');
  const data = path.join(home, '.local/share/dalan'), config = path.join(home, '.config/dalan');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 }); fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  for (const dir of ['receipts', 'artifact-index']) fs.mkdirSync(path.join(data, dir), { mode: 0o700 });
  fs.writeFileSync(path.join(data, 'receipts/r1.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'as-storage.key'), 'a'.repeat(32), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'operator.key'), 'operator-secret\n', { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'workers-audit.jsonl'), '{"event_id":"e1"}\n', { mode: 0o600 });
  if (artifacts) { fs.mkdirSync(path.join(home, '.tmp/dalan/artifacts'), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(home, '.tmp/dalan/artifacts/a1'), 'sealed bytes', { mode: 0o600 }); }
  if (as) new AsStore(path.join(config, 'as.sqlite')).close();
  const file = path.join(data, 'bridge.db');
  if (kind === 'legacy' || kind === 'marker-no-key') {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE assignments (request_id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO assignments VALUES ('req_1','finished'); PRAGMA user_version=49");
    if (kind === 'marker-no-key') db.exec('CREATE TABLE subscription_storage_meta (id INTEGER)');
    db.close();
  } else {
    const store = new Store(file, { connectionIsLive: () => true });
    store.subscribe('sub-1', webhook ?? 'https://example.test/hook', secret, '2099-01-01T00:00:00.000Z', 'owner', 'dot', null);
    if (webhook) store.db.prepare("INSERT INTO notifications(id,kind,subscription_id,body,created_at,state) VALUES('pending','event','sub-1','{}',?,'pending')").run(new Date().toISOString());
    store.db.close();
    if (kind === 'modern-no-key') fs.rmSync(path.join(data, 'bridge.db.secrets/storage.key'));
  }
  if (checkpoint) withAuditLock(path.join(config, 'workers.json'), db => db.prepare('INSERT OR REPLACE INTO checkpoint(id,size,sha256,last_event_id) VALUES (1,18,?,?)').run('0'.repeat(64), 'e1'));
  return home;
}
function run(script, root, env) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'dalan'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(repo, 'bin/dalan.mjs'))} "$@"\n`, { mode: 0o755 });
  return spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
}
const backupIn = dir => path.join(dir, fs.readdirSync(dir).find(entry => entry.startsWith('dalan-backup-')));
function scenario(options, body) {
  const root = fs.mkdtempSync(path.join(root0, 'backup-recipe-'));
  try {
    const service = install(root, options);
    const operator = path.join(root, 'operator'); fs.mkdirSync(operator);
    return body({ root, service, operator, backup: () => run(recipe, root, { HOME: operator, DALAN_HOME: service }), restore: backupDir => run(restoreCheck, root, { HOME: operator, backup: backupDir, request_id: '' }) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('the backup recipe keeps the key, and the restore check opens and decrypts', { skip }, () => scenario({}, ({ service, operator, backup, restore }) => {
  const backed = backup();
  assert.equal(backed.status, 0, backed.stderr);
  const dir = backupIn(operator);
  const keyFile = path.join(dir, 'data/bridge.db.secrets/storage.key');
  assert.deepEqual(fs.readFileSync(keyFile), fs.readFileSync(path.join(service, '.local/share/dalan/bridge.db.secrets/storage.key')));
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(keyFile)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(dir, 'data/bridge.db.secrets/owner.sqlite')), false, 'the lock database is not backed up');
  assert.equal(fs.existsSync(path.join(dir, 'config/as-storage.key')), true, 'the authorization key is backed up');
  assert.equal(fs.readFileSync(path.join(dir, 'artifacts/a1'), 'utf8'), 'sealed bytes');
  const restored = restore(dir);
  assert.equal(restored.status, 0, restored.stderr);
  const report = JSON.parse(restored.stdout.trim().split('\n').at(-1));
  assert.equal(report.bridge_db, 'ok');
  assert.equal(report.subscription_secrets_decrypted, 1);
}));

test('a backup without the key fails the restore check', { skip }, () => scenario({}, ({ operator, backup, restore }) => {
  assert.equal(backup().status, 0);
  const dir = backupIn(operator);
  fs.rmSync(path.join(dir, 'data/bridge.db.secrets'), { recursive: true });
  const restored = restore(dir);
  assert.notEqual(restored.status, 0);
  assert.match(restored.stderr, /subscription storage key is missing/);
}));

test('a wrong key fails the restore check', { skip }, () => scenario({}, ({ operator, backup, restore }) => {
  assert.equal(backup().status, 0);
  const dir = backupIn(operator);
  fs.writeFileSync(path.join(dir, 'data/bridge.db.secrets/storage.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  const restored = restore(dir);
  assert.notEqual(restored.status, 0);
  assert.match(restored.stderr, /cannot be decrypted/);
}));

test('the backup recipe finishes on an install that has stored no artifacts', { skip }, () => scenario({ artifacts: false }, ({ operator, backup }) => {
  const backed = backup();
  assert.equal(backed.status, 0, backed.stderr);
  assert.match(backed.stderr, /stored no artifact bytes/);
  assert.equal(fs.existsSync(path.join(backupIn(operator), 'config/as-storage.key')), true, 'the config files are still copied');
}));

// Fix 1: a 0.2.0 (schema 49) database has no key by design; a current database without its key is an error.
test('a pre-encryption database is backed up and restored without inventing a key', { skip }, () => scenario({ kind: 'legacy' }, ({ operator, backup, restore }) => {
  const backed = backup();
  assert.equal(backed.status, 0, backed.stderr);
  const dir = backupIn(operator);
  assert.equal(fs.existsSync(path.join(dir, 'data/bridge.db.secrets')), false, 'no key is made up');
  const restored = restore(dir);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /"schema":49/);
  assert.match(restored.stdout, /no key needed/);
}));
test('the recipe fails closed when an encrypted database has no key', { skip }, () => {
  for (const kind of ['modern-no-key', 'marker-no-key']) scenario({ kind }, ({ operator, backup }) => {
    const backed = backup();
    assert.notEqual(backed.status, 0, `${kind} must not produce a backup`);
    assert.match(backed.stderr, /storage\.key/);
    void operator;
  });
});

// Fix 2: a copy that fails must fail the recipe and the restore.
test('an unreadable config file fails the backup recipe and the restore copy', { skip: skip || (isRoot && 'root reads every file') }, () => {
  scenario({}, ({ service, backup }) => {
    const file = path.join(service, '.config/dalan/operator.key');
    fs.chmodSync(file, 0);
    const backed = backup();
    fs.chmodSync(file, 0o600);
    assert.notEqual(backed.status, 0, 'a failed cp must fail the recipe');
  });
  scenario({}, ({ operator, backup, restore }) => {
    assert.equal(backup().status, 0);
    const dir = backupIn(operator);
    fs.chmodSync(path.join(dir, 'config/operator.key'), 0);
    const restored = restore(dir);
    fs.chmodSync(path.join(dir, 'config/operator.key'), 0o600);
    assert.notEqual(restored.status, 0, 'a failed cp must fail the restore copy');
  });
});

// Fix 3: the audit checkpoint is persistent state, saved with .backup and restored with the log.
test('the audit checkpoint is backed up, restored and checked', { skip }, () => scenario({ checkpoint: true }, ({ operator, backup, restore }) => {
  const backed = backup();
  assert.equal(backed.status, 0, backed.stderr);
  const dir = backupIn(operator);
  const saved = path.join(dir, 'config/workers-audit-checkpoint.sqlite');
  assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
  const db = new DatabaseSync(saved, { readOnly: true });
  assert.equal(db.prepare('SELECT last_event_id FROM checkpoint WHERE id=1').get().last_event_id, 'e1');
  db.close();
  assert.equal(fs.existsSync(path.join(dir, 'config/workers-audit.jsonl')), true, 'the log it describes is saved too');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'config')).filter(name => /-(journal|wal|shm)$/.test(name)), []);
  const restored = restore(dir);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /"audit_checkpoint":"ok, recorded"/);
  assert.equal(fs.existsSync(path.join(operator, 'dalan-restore-check/.config/dalan/workers-audit-checkpoint.sqlite')), true);
}));

// Fix 4: the check reads the copy; it never starts the bridge, so a restored webhook or pending notice sends nothing.
test('the restore check makes no outbound call for a restored webhook and pending notice', { skip }, async () => {
  let hits = 0;
  const listener = http.createServer((req, res) => { hits++; res.end('ok'); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${listener.address().port}/hook`;
  try {
    // Control: the listener does count a request, so a zero below means no request was made.
    await (await fetch(url)).text();
    assert.equal(hits, 1);
    hits = 0;
    const root = fs.mkdtempSync(path.join(root0, 'backup-recipe-'));
    try {
      const service = install(root, { webhook: url });
      const row = new DatabaseSync(path.join(service, '.local/share/dalan/bridge.db'), { readOnly: true });
      assert.equal(row.prepare("SELECT state FROM notifications WHERE id='pending'").get().state, 'pending');
      row.close();
      const operator = path.join(root, 'operator'); fs.mkdirSync(operator);
      assert.equal(run(recipe, root, { HOME: operator, DALAN_HOME: service }).status, 0);
      const restored = run(restoreCheck, root, { HOME: operator, backup: backupIn(operator), request_id: '' });
      assert.equal(restored.status, 0, restored.stderr);
      const copy = new DatabaseSync(path.join(operator, 'dalan-restore-check/.local/share/dalan/bridge.db'), { readOnly: true });
      assert.equal(copy.prepare("SELECT state FROM notifications WHERE id='pending'").get().state, 'pending', 'the notice is still waiting; nothing delivered it');
      copy.close();
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(hits, 0, 'the documented check made an outbound call');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  } finally { listener.close(); }
});

test('the backup recipe refuses while a process still has the database open', { skip: skip || (spawnSync('lsof', ['-v']).error && 'lsof is not installed') }, () => scenario({}, ({ service, backup }) => {
  const db = path.join(service, '.local/share/dalan/bridge.db');
  const holder = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(db)});d.prepare('SELECT 1').get();process.stdout.write('open\\n');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const opened = spawnSync('/bin/sh', ['-c', 'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do lsof -t "$0" >/dev/null 2>&1 && exit 0; sleep 0.2; done; exit 1', db]);
    assert.equal(opened.status, 0, 'the holder process never opened the database');
    const backed = backup();
    assert.notEqual(backed.status, 0, 'the recipe ran while the database was open');
    assert.match(backed.stderr, /still has .*bridge\.db open: stop the service first/);
  } finally { holder.kill('SIGTERM'); }
}));

// A stand-in lsof on PATH ahead of the real one: the recipe must tell a failed check from a check that found nothing.
function fakeLsof(root, body) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
test('the backup recipe stops when lsof fails instead of reporting', { skip }, () => scenario({}, ({ root, backup }) => {
  fakeLsof(root, 'echo "lsof: status error on the file: Permission denied" >&2; exit 1');
  const backed = backup();
  assert.notEqual(backed.status, 0, 'the recipe went on although lsof could not check the database');
  assert.match(backed.stderr, /could not check whether a process has .*open/);
}));
test('the backup recipe goes on when lsof checks and finds no process', { skip }, () => scenario({}, ({ root, backup }) => {
  fakeLsof(root, 'exit 1');
  const backed = backup();
  assert.equal(backed.status, 0, backed.stderr);
}));

test('the restore check authenticates the authorization store with its key', { skip }, () => scenario({ as: true }, ({ operator, backup, restore }) => {
  assert.equal(backup().status, 0);
  const dir = backupIn(operator);
  const good = restore(dir);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /"as_sqlite":"ok, key verified"/);
  fs.rmSync(path.join(operator, 'dalan-restore-check'), { recursive: true, force: true });
  // A key of the right size, mode and owner that is not the key the database was sealed with.
  fs.writeFileSync(path.join(dir, 'config/as-storage.key'), 'b'.repeat(32), { mode: 0o600 });
  const wrong = restore(dir);
  assert.notEqual(wrong.status, 0, 'a wrong 32-byte key must fail the restore check');
  assert.match(wrong.stderr, /authorization storage cannot be decrypted with the restored key/);
}));
