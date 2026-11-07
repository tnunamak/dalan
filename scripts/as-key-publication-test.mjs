import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AsStore } from '../src/as-store.mjs';

if (process.argv[2] === 'child') {
  const fault = process.argv[3], file = process.argv[4];
  const open = fs.openSync, link = fs.linkSync;
  fs.openSync = function (name, flags, ...args) {
    const fd = open.call(this, name, flags, ...args);
    if (fault === 'after-create' && path.basename(String(name)).startsWith('.as-storage-key-')) process.kill(process.pid, 'SIGKILL');
    return fd;
  };
  fs.linkSync = function (...args) {
    if (fault === 'before-link') process.kill(process.pid, 'SIGKILL');
    const result = link.apply(this, args);
    if (fault === 'after-link') process.kill(process.pid, 'SIGKILL');
    return result;
  };
  new AsStore(file);
  throw new Error('publication fault did not fire');
}
const root = fs.mkdtempSync(path.join(process.env.DOT_BRIDGE_TEST_TMP ?? path.join(os.homedir(), '.tmp'), 'as-key-crash-'));
const token = 'credential-' + 'fixture';
try {
  for (const fault of ['after-create', 'before-link', 'after-link']) {
    const dir = path.join(root, fault); fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, 'as.sqlite'), key = path.join(dir, 'as-storage.key');
    const unrelated = path.join(dir, 'unrelated.tmp'); fs.writeFileSync(unrelated, 'keep');
    let store = new AsStore(file); store.close();
    fs.unlinkSync(key);
    const db = new DatabaseSync(file);
    db.exec('DELETE FROM as_storage_meta');
    db.prepare('INSERT INTO oidc VALUES(?,?,?,?,?,?,?,?,?)').run('RefreshToken', token, JSON.stringify({ grantId: 'grant', aud: 'fixture' }), 'grant', null, null, null, Date.now(), null);
    db.close();
    const killed = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'child', fault, file], { encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(fs.existsSync(key), fault === 'after-link');
    if (fs.existsSync(key)) assert.equal(fs.statSync(key).size, 32);
    const before = new DatabaseSync(file, { readOnly: true });
    assert.equal(before.prepare('SELECT count(*) AS n FROM as_storage_meta').get().n, 0);
    assert.equal(before.prepare("SELECT count(*) AS n FROM oidc WHERE model='RefreshToken' AND id=?").get(token).n, 1);
    before.close();
    // A recovered hard link may be visible without a durable directory entry.
    // The key barrier must precede the first encrypted migration transaction.
    const sync = fs.fsyncSync, exec = DatabaseSync.prototype.exec;
    let keyDirectorySynced = false, migrationBarrierChecked = false;
    fs.fsyncSync = function (fd) {
      const result = sync.call(this, fd);
      if (fs.fstatSync(fd).isDirectory()) keyDirectorySynced = true;
      return result;
    };
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === 'BEGIN IMMEDIATE') {
        migrationBarrierChecked = true;
        assert(keyDirectorySynced, 'key directory must be durable before encrypted migration starts');
      }
      return exec.call(this, sql);
    };
    try { store = new AsStore(file); }
    finally { fs.fsyncSync = sync; DatabaseSync.prototype.exec = exec; }
    assert(migrationBarrierChecked, 'recovery must exercise the migration barrier');
    assert.equal(store.find('RefreshToken', token).grantId, 'grant');
    store.close();
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    assert.equal(fs.readdirSync(dir).some(name => /^\.as-storage-key-[a-f0-9]{32}\.tmp$/.test(name)), false);
    store = new AsStore(file); assert.equal(store.find('RefreshToken', token).grantId, 'grant'); store.close();
  }
  console.log('PASS key publication recovers after SIGKILL before write, before link, and after link');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
