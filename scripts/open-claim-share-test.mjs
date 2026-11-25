// Red test for scripts/open-claim-share.mjs: per-minute open-claim share of a worker, from claims and reports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const script = path.resolve(new URL('./open-claim-share.mjs', import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-claim-share-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeDb() {
  const file = path.join(dir, 'bridge.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE claims (request_id TEXT PRIMARY KEY, worker TEXT NOT NULL, claim_id TEXT NOT NULL, claimed_at TEXT NOT NULL);'
    + 'CREATE TABLE reports (request_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, created_at TEXT NOT NULL);');
  // Window 10:00:00Z-10:10:00Z, ten whole minutes. Sample instant of minute m is hh:mm:30.
  const claim = (id, worker, at, reportAt) => {
    db.prepare('INSERT INTO claims(request_id,worker,claim_id,claimed_at) VALUES(?,?,?,?)').run(id, worker, `c-${id}`, at);
    if (reportAt) db.prepare('INSERT INTO reports(request_id,claim_id,created_at) VALUES(?,?,?)').run(id, `c-${id}`, reportAt);
  };
  claim('a', 'dot', '2026-11-25T10:00:10Z', '2026-11-25T10:04:00Z'); // open at samples of minutes 0-3 (10:00:30..10:03:30)
  claim('b', 'dot', '2026-11-25T10:01:00Z', '2026-11-25T10:03:00Z'); // open at samples of minutes 1-2
  claim('c', 'dot', '2026-11-25T10:02:00Z', '2026-11-25T10:02:20Z'); // closes before its minute's sample: never counted
  claim('d', 'dot', '2026-11-25T10:08:00Z', null);                   // no report, inside window: open until END (minutes 8-9)
  claim('x', 'muse', '2026-11-25T10:00:00Z', '2026-11-25T10:09:00Z'); // other worker: ignored
  claim('old', 'dot', '2026-11-25T07:00:00Z', null);                 // unreported 3 h before START: ignored
  db.close();
  return file;
}

test('open-claim share counts minute samples, ignores other workers and stale unreported claims', () => {
  const file = makeDb();
  const run = spawnSync(process.execPath, [script, file, '2026-11-25T10:00:00Z', '2026-11-25T10:10:00Z', '--worker', 'dot', '--lanes', '8', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  // open counts per minute 0..9: 1,2,2,1,0,0,0,0,1,1
  assert.equal(out.minutes, 10);
  assert.equal(out.claims_started, 4);
  assert.equal(out.claims_per_hour, 24);
  assert.equal(out.mean_open, 0.8);
  assert.deepEqual(out.share, { 0: 0.4, 1: 0.4, 2: 0.2, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 });
  assert.equal(out.share_at_least_6, 0);
});

test('plain output prints one name: value line per figure', () => {
  const file = makeDb();
  const run = spawnSync(process.execPath, [script, file, '2026-11-25T10:00:00Z', '2026-11-25T10:10:00Z'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^mean_open: 0\.8$/m);
  assert.match(run.stdout, /^claims_per_hour: 24$/m);
  assert.match(run.stdout, /^share_at_least_6: 0$/m);
});

test('a bad window fails with exit 2', () => {
  const file = makeDb();
  const run = spawnSync(process.execPath, [script, file, '2026-11-25T10:10:00Z', '2026-11-25T10:00:00Z'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});
