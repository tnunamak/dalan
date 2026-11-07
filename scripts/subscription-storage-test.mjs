import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { dropEmptyPost54FixtureState } from '../src/test-support/pre-worker-fixture.mjs';

if (process.argv[2] === '--crash-cleanup') {
  const exec = DatabaseSync.prototype.exec, phase = process.argv[3];
  DatabaseSync.prototype.exec = function(sql) {
    if (phase === 'before-vacuum' && sql === 'VACUUM') process.kill(process.pid, 'SIGKILL');
    const result = exec.call(this, sql);
    if ((phase === 'after-commit' && sql === 'COMMIT') || (phase === 'after-vacuum' && sql === 'VACUUM')) process.kill(process.pid, 'SIGKILL');
    return result;
  };
  new Store(process.argv[4]); process.exit(2);
}
if (process.argv[2] === '--fail-dir') {
  const fsync = fs.fsyncSync; let directorySyncs = 0;
  fs.fsyncSync = function(fd) {
    if (fs.fstatSync(fd).isDirectory() && ++directorySyncs === 2) throw new Error('synthetic directory sync failure');
    return fsync.call(this, fd);
  };
  try { new Store(process.argv[3]); process.exit(2); } catch { process.exit(0); }
}
if (process.argv[2] === '--open') {
  const store = new Store(process.argv[3]); store.db.close(); process.exit(0);
}
const root = fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp'), 'sub-crypt-'));
const secret = 'whsec_' + 'synthetic-credential-123456';
const pathSecret = 'synthetic-issuer-path-123456';
const connection = { issuer: `https://example.test/${pathSecret}/oauth`, builtin: true, connection_id: 'cid', connection: { worker: 'dot' } };
const expires = '2099-01-01T00:00:00.000Z';
let store;
const scan = file => {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = JSON.stringify(db.prepare('SELECT * FROM subscriptions').all()); db.close();
  for (const value of [secret, pathSecret]) assert.equal(rows.includes(value), false, 'credential in table dump');
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) for (const value of [secret, pathSecret]) assert.equal(fs.readFileSync(file + suffix).includes(value), false, 'credential in database file');
};
try {
  const file = path.join(root, 'legacy.db');
  store = new Store(file); store.db.close(); store = null;
  const legacy = new DatabaseSync(file);
  dropEmptyPost54FixtureState(legacy);
  legacy.exec('DROP TABLE subscription_storage_meta; DROP TRIGGER subscriptions_encrypted_insert; DROP TRIGGER subscriptions_encrypted_update; PRAGMA user_version=51');
  legacy.prepare("INSERT INTO subscriptions(id,principal,url,args,secret,expires_at,verified_at,state,worker,connection) VALUES('id','owner','https://example.test/hook','{}',?,?,'2020-01-01','active','dot',?)").run(secret, expires, JSON.stringify(connection));
  legacy.close();
  const reader = new DatabaseSync(file); reader.exec('BEGIN'); reader.prepare('SELECT * FROM subscriptions').all();
  assert.throws(() => new Store(file), /subscription encrypted storage could not be opened/, 'busy checkpoint must fail closed');
  reader.exec('ROLLBACK'); reader.close();
  store = new Store(file, { connectionIsLive: () => true });
  let row = store.db.prepare('SELECT * FROM subscriptions WHERE id=?').get('id');
  assert.equal(store.subscriptionSecret(row), secret);
  assert.equal(store.subscriptionConnection(row).issuer, connection.issuer);
  assert.equal(store.subscriptionActive(row), true);
  scan(file);
  store.subscribe('id', 'https://example.test/hook', secret, expires, 'owner', 'dot', connection);
  store.db.prepare("INSERT INTO notifications(id,kind,subscription_id,body,created_at,state) VALUES('pending','event','id','{}',?,'pending')").run(new Date().toISOString());
  const rotated = 'whsec_' + 'second-credential-123456';
  assert.throws(() => store.subscribe('id', 'https://example.test/hook', rotated, expires, 'owner', 'dot', connection), /signing_key_rotation_blocked/);
  assert.equal(store.db.prepare("SELECT rotation_blocked FROM subscriptions WHERE id='id'").get().rotation_blocked, 1);
  store.db.prepare("UPDATE notifications SET state='delivered' WHERE id='pending'").run();
  store.subscribe('id', 'https://example.test/hook', rotated, expires, 'owner', 'dot', connection);
  assert.equal(store.subscriptionSecret(store.db.prepare("SELECT * FROM subscriptions WHERE id='id'").get()), rotated);
  store.subscribe('id', 'https://example.test/hook', secret, expires, 'owner', 'dot', connection);
  store.db.close(); store = null;
  store = new Store(file, { connectionIsLive: () => true });
  row = store.db.prepare('SELECT * FROM subscriptions WHERE id=?').get('id');
  assert.equal(store.subscriptionSecret(row), secret); assert.equal(store.subscriptionActive(row), true);
  store.unsubscribe('id'); assert.equal(store.subscriptionActive(store.db.prepare('SELECT * FROM subscriptions WHERE id=?').get('id')), false);
  store.db.close(); store = null; scan(file);
  const key = path.join(`${file}.secrets`, 'storage.key'), saved = fs.readFileSync(key);
  fs.unlinkSync(key); assert.throws(() => new Store(file), /key is missing/);
  fs.writeFileSync(key, Buffer.alloc(32), { mode: 0o600 }); assert.throws(() => new Store(file), /encrypted storage could not be opened/);
  fs.writeFileSync(key, saved, { mode: 0o600 });
  const tamper = new DatabaseSync(file);
  tamper.exec("INSERT INTO subscriptions(id,principal,url,args,secret,expires_at,verified_at,state,auth_failures,last_event_2xx_at,rotation_blocked,worker,connection) SELECT 'other',principal,url,args,secret,expires_at,verified_at,state,auth_failures,last_event_2xx_at,rotation_blocked,worker,connection FROM subscriptions WHERE id='id'");
  tamper.close(); assert.throws(() => new Store(file), /encrypted storage could not be opened/);
  const repair = new DatabaseSync(file); repair.prepare("DELETE FROM subscriptions WHERE id='other'").run(); repair.close();
  store = new Store(file);
  assert.throws(() => store.db.prepare("UPDATE subscriptions SET secret=? WHERE id='id'").run(secret), /requires encryption/);
  assert.throws(() => store.db.prepare("INSERT INTO subscriptions(id,principal,url,args,secret,expires_at,verified_at,worker) VALUES('plain','p','https://example.test','{}',?,?,'2020-01-01','dot')").run(secret, expires), /requires encryption/);
  store.db.close(); store = null;
  const badFile = path.join(root, 'bad-legacy.db');
  store = new Store(badFile); store.db.close(); store = null;
  const malformed = new DatabaseSync(badFile);
  dropEmptyPost54FixtureState(malformed);
  malformed.exec('DROP TABLE subscription_storage_meta; DROP TRIGGER subscriptions_encrypted_insert; DROP TRIGGER subscriptions_encrypted_update; PRAGMA user_version=51');
  malformed.prepare("INSERT INTO subscriptions(id,principal,url,args,secret,expires_at,verified_at,state,worker,connection) VALUES('bad','owner','https://example.test/hook','{}',?,?,'2020-01-01','active','dot',?)").run(secret, expires, pathSecret); malformed.close();
  assert.throws(() => new Store(badFile), error => error.message === 'legacy subscription connection is invalid');
  const intact = new DatabaseSync(badFile, { readOnly: true });
  assert.equal(intact.prepare('PRAGMA user_version').get().user_version, 51);
  assert.equal(intact.prepare("SELECT connection FROM subscriptions WHERE id='bad'").get().connection, pathSecret); intact.close();
  for (const phase of ['after-commit', 'before-vacuum', 'after-vacuum']) {
    const crashFile = path.join(root, `${phase}.db`);
    store = new Store(crashFile); store.db.close(); store = null;
    const seed = new DatabaseSync(crashFile);
    dropEmptyPost54FixtureState(seed);
    seed.exec('DROP TABLE subscription_storage_meta; DROP TRIGGER subscriptions_encrypted_insert; DROP TRIGGER subscriptions_encrypted_update; PRAGMA user_version=51');
    seed.prepare("INSERT INTO subscriptions(id,principal,url,args,secret,expires_at,verified_at,state,worker,connection) VALUES('id','owner','https://example.test/hook','{}',?,?,'2020-01-01','active','dot',?)").run(secret, expires, JSON.stringify(connection)); seed.close();
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--crash-cleanup', phase, crashFile], { stdio: 'ignore' });
    const exit = await new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(exit.signal, 'SIGKILL');
    const marker = new DatabaseSync(crashFile, { readOnly: true });
    assert.equal(marker.prepare('SELECT state FROM subscription_storage_meta').get().state, 'cleanup'); marker.close();
    store = new Store(crashFile, { connectionIsLive: () => true });
    assert.equal(store.subscriptionSecret(store.db.prepare("SELECT * FROM subscriptions WHERE id='id'").get()), secret);
    store.db.close(); store = null; scan(crashFile);
  }
  const barrierFile = path.join(root, 'barrier.db');
  const failed = spawn(process.execPath, [new URL(import.meta.url).pathname, '--fail-dir', barrierFile], { stdio: 'ignore' });
  const failedStatus = await new Promise(resolve => failed.on('exit', resolve)); assert.equal(failedStatus, 0);
  assert.equal(fs.statSync(`${barrierFile}.secrets/storage.key`).size, 32, 'key was not published before failed directory sync');
  const beforeRetry = new DatabaseSync(barrierFile, { readOnly: true });
  assert.ok(beforeRetry.prepare('PRAGMA user_version').get().user_version < 52); beforeRetry.close();
  store = new Store(barrierFile); store.db.close(); store = null;
  const race = path.join(root, 'race.db');
  const children = Array.from({ length: 20 }, () => spawn(process.execPath, [new URL(import.meta.url).pathname, '--open', race], { stdio: ['ignore', 'ignore', 'pipe'] }));
  const results = await Promise.all(children.map(child => new Promise(resolve => { let err = ''; child.stderr.on('data', b => { err += b; }); child.on('exit', (code, signal) => resolve({ code, signal, err })); })));
  assert.ok(results.every(r => r.code === 0), `concurrent first Store opens failed: ${results.filter(r => r.code !== 0).map(r => r.err).join('\n')}`);
  store = new Store(race); store.db.close(); store = null;
  console.log('PASS subscription legacy migration, checkpoint retry, ciphertext binding, key loss, restart and 20 concurrent first opens');
} finally { store?.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
