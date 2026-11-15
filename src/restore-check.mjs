#!/usr/bin/env node
// Read-only check of a restored home: `node restore-check.mjs DATA_ROOT CONFIG_ROOT [REQUEST_ID]`. It opens the databases
// read-only and decrypts what the bridge's own start would decrypt. It starts no server and no delivery loop and opens no network socket,
// so a restored webhook subscription or pending notice cannot be sent from here. It also never creates a key.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SubscriptionCodec } from './subscription-storage.mjs';
import { journalPath, readJournal } from './answer-journal.mjs';
import { openAsValue } from './as-store.mjs';

const fail = message => { process.stderr.write(`restore-check: ${message}\n`); process.exit(1); };
const args = process.argv.slice(2);
const allowJournalAhead = args.includes('--allow-journal-ahead');
const positional = args.filter(arg => arg !== '--allow-journal-ahead');
const [dataRoot, configRoot, requestId, extra] = positional;
if (!dataRoot || !configRoot || extra !== undefined || positional.some(arg => arg.startsWith('-')) ||
    args.filter(arg => arg === '--allow-journal-ahead').length > 1)
  fail('usage: restore-check.mjs DATA_ROOT CONFIG_ROOT [REQUEST_ID] [--allow-journal-ahead]');

function readKey(file, what) {
  if (!fs.existsSync(file)) fail(`${what} is missing: ${file}`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) fail(`${what} must be a regular file with mode 0600: ${file}`);
  const key = fs.readFileSync(file);
  if (key.length !== 32) fail(`${what} is not 32 bytes: ${file}`);
  return key;
}
const hasTable = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

// Inspect only the journal's documented layout. Never emit saved answer text.
// src/answer-journal.mjs#journalPath and #readJournal define the file contract.
function inspectAnswerJournal(db, receiptsDir) {
  const result = { entries: 0, ahead_of_db: [], divergent: [] };
  if (!fs.existsSync(receiptsDir)) return result;
  if (!fs.lstatSync(receiptsDir).isDirectory() || fs.lstatSync(receiptsDir).isSymbolicLink())
    fail('receipts must be a real directory');
  const question = hasTable(db, 'job_questions')
    ? db.prepare('SELECT answer,answered_at FROM job_questions WHERE request_id=? AND question_id=?') : null;
  for (const name of fs.readdirSync(receiptsDir).sort()) {
    if (!name.endsWith('.answers')) continue;
    const job = name.slice(0, -8), dir = path.join(receiptsDir, name);
    if (!/^[-A-Za-z0-9_]{8,128}$/.test(job) || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
      fail('invalid answer journal directory');
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue; // journal staging files are not published entries
      const file = path.join(dir, name);
      try {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error();
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof raw.question_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.question_id) ||
            path.resolve(journalPath(receiptsDir, job, raw.question_id)) !== path.resolve(file)) throw new Error();
        const entry = readJournal(file, job, raw.question_id);
        if (!entry) throw new Error();
        result.entries++;
        const row = question?.get(job, entry.question_id);
        if (['committed', 'unknown'].includes(entry.state) && (!row || row.answer === null || row.answered_at === null))
          result.ahead_of_db.push({ job, question_id: entry.question_id, state: entry.state });
        else if (['committed', 'unknown'].includes(entry.state) && row.answer !== entry.text)
          result.divergent.push({ job, question_id: entry.question_id, state: entry.state });
      } catch { fail('invalid or unreadable answer journal entry; inspect the receipts directory'); }
    }
  }
  return result;
}

const file = path.join(dataRoot, 'bridge.db');
if (!fs.existsSync(file)) fail(`no bridge.db in ${dataRoot}`);
const db = new DatabaseSync(file, { readOnly: true });
try {
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') fail(`bridge.db integrity_check: ${integrity}`);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const report = { bridge_db: 'ok', schema: version };
  // The same test the bridge applies when it opens the store: schema 52 or newer, or the storage marker table, means encrypted.
  if (version >= 52 || hasTable(db, 'subscription_storage_meta')) {
    const codec = new SubscriptionCodec(readKey(path.join(`${fs.realpathSync(file)}.secrets`, 'storage.key'), 'subscription storage key'));
    try {
      const marker = db.prepare('SELECT verifier FROM subscription_storage_meta WHERE id=1').get();
      if (!marker || codec.open(marker.verifier, 'verifier') !== 'dot-bridge subscriptions v1') throw new Error();
      const subscriptions = db.prepare('SELECT id,secret,connection FROM subscriptions').all();
      for (const sub of subscriptions) {
        codec.open(sub.secret, `subscriptions:${sub.id}:secret`);
        if (sub.connection !== null) codec.open(sub.connection, `subscriptions:${sub.id}:connection`);
      }
      report.subscription_secrets_decrypted = subscriptions.length;
    } catch { fail('subscription storage cannot be decrypted with the restored key'); }
  } else {
    report.subscription_encryption = 'none (database from before the key existed; no key needed)';
  }
  if (requestId) {
    const row = db.prepare('SELECT status FROM assignments WHERE request_id=?').get(requestId);
    if (!row) fail(`request ${requestId} is not in the restored bridge.db`);
    report.request = { request_id: requestId, status: row.status };
  } else {
    report.assignments = db.prepare('SELECT count(*) n FROM assignments').get().n;
  }
  // The authorization store keeps its own key beside as.sqlite; its marker table says whether the key is required.
  const authFile = path.join(configRoot, 'as.sqlite');
  if (fs.existsSync(authFile)) {
    const auth = new DatabaseSync(authFile, { readOnly: true });
    try {
      const integrityAuth = auth.prepare('PRAGMA integrity_check').get().integrity_check;
      if (integrityAuth !== 'ok') fail(`as.sqlite integrity_check: ${integrityAuth}`);
      if (hasTable(auth, 'as_storage_meta')) {
        const key = readKey(path.join(configRoot, 'as-storage.key'), 'authorization storage key');
        // The store's own start authenticates the verifier and every sealed row; do the same, read-only.
        try {
          const marker = auth.prepare('SELECT verifier FROM as_storage_meta WHERE id=1').get();
          if (!marker || openAsValue(key, marker.verifier, 'verifier') !== 'dot-bridge storage v1') throw new Error();
          for (const row of auth.prepare('SELECT model,id,payload FROM oidc').all()) openAsValue(key, row.payload, `oidc:${row.model}:${row.id}`);
          for (const [table, column] of [['connections', 'connection_id'], ['pairings', 'code']]) {
            for (const row of auth.prepare(`SELECT ${column} AS id,resource FROM ${table}`).all()) openAsValue(key, row.resource, `${table}:${row.id}`);
          }
        } catch { fail('authorization storage cannot be decrypted with the restored key'); }
        report.as_sqlite = 'ok, key verified';
      }
      else report.as_sqlite = 'ok';
    } finally { auth.close(); }
  }
  // Persistent audit state: the checkpoint must open, or the worker audit fails closed at the next start.
  const checkpointFile = path.join(configRoot, 'workers-audit-checkpoint.sqlite');
  if (fs.existsSync(checkpointFile)) {
    const checkpoint = new DatabaseSync(checkpointFile, { readOnly: true });
    try {
      const integrityAudit = checkpoint.prepare('PRAGMA integrity_check').get().integrity_check;
      if (integrityAudit !== 'ok') fail(`workers-audit-checkpoint.sqlite integrity_check: ${integrityAudit}`);
      report.audit_checkpoint = hasTable(checkpoint, 'checkpoint') && checkpoint.prepare('SELECT 1 FROM checkpoint WHERE id=1').get() ? 'ok, recorded' : 'ok, empty';
    } finally { checkpoint.close(); }
  }
  report.answer_journal = inspectAnswerJournal(db, path.join(dataRoot, 'receipts'));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if ((report.answer_journal.ahead_of_db.length || report.answer_journal.divergent.length) && !allowJournalAhead)
    fail('answer journal is ahead of or divergent from restored bridge.db; inspect answer_journal before resuming, or use --allow-journal-ahead to report only');
} finally { db.close(); }
