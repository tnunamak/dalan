#!/usr/bin/env node
// Catalog preflight only. Stop writers before using this snapshot to switch catalogs.
// It neither changes catalogs nor settles answers.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { journalPath, readJournal } from './answer-journal.mjs';

function unknownSends(receiptsDir) {
  let directories;
  try { directories = fs.readdirSync(receiptsDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const sends = [];
  // src/answer-journal.mjs#journalPath: <job>.answers/<encoded question>.json.
  for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.name.endsWith('.answers')) continue;
    if (!directory.isDirectory()) throw new Error('answer journal directory is not a regular directory');
    const job = directory.name.slice(0, -'.answers'.length);
    const dir = path.join(receiptsDir, directory.name);
    for (const file of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.name.endsWith('.json')) continue; // Unpublished stage files are not journal entries.
      if (!file.isFile()) throw new Error('answer journal is not a regular file');
      const questionId = decodeURIComponent(file.name.slice(0, -'.json'.length));
      const filename = path.join(dir, file.name);
      if (journalPath(receiptsDir, job, questionId) !== filename) throw new Error('noncanonical answer journal filename');
      // Validate the complete envelope, but never expose answer text or command envelopes.
      const entry = readJournal(filename, job, questionId);
      if (!entry) throw new Error('answer journal disappeared during inventory; retry with writers stopped');
      if (entry.state !== 'committed') {
        sends.push({ job: entry.job, question_id: entry.question_id, state: entry.state });
      }
    }
  }
  return sends;
}

export function inventory({ dataRoot, receiptsDir = path.join(dataRoot, 'receipts') }) {
  // src/restore-check.mjs#db: readOnly prevents creation and Store migrations.
  const db = new DatabaseSync(path.join(dataRoot, 'bridge.db'), { readOnly: true });
  try {
    db.exec('BEGIN');
    // src/store.mjs#Store.constructor creates assignments.
    // src/store.mjs#Store.answerQuestionInTransaction treats finished/cancelled as terminal.
    const open_jobs = db.prepare("SELECT request_id,status FROM assignments WHERE status NOT IN ('finished','cancelled') ORDER BY request_id").all().map(row => ({ ...row }));
    // src/store.mjs#Store.migrate creates job_questions.
    // src/store.mjs#Store.answerQuestionInTransaction saves answer/answered_at together.
    // Include unanswered audit questions on finished jobs; do not silently discard them.
    const open_questions = db.prepare('SELECT request_id AS job,question_id FROM job_questions WHERE answer IS NULL ORDER BY request_id,question_id').all().map(row => ({ ...row }));
    // src/store.mjs#Store.assertRegrantReady: terminal jobs can still own host effects.
    const open_checks = db.prepare("SELECT id,request_id AS job,check_id,status,stop_verified FROM check_jobs WHERE status='running' OR stop_verified IS NOT 1 ORDER BY request_id,id").all().map(row => ({ ...row }));
    // src/store.mjs#Store.finishOnce enqueues result delivery after marking a job finished.
    const pending_deliveries = db.prepare("SELECT id,request_id AS job,kind,state FROM notifications WHERE state IN ('pending','sending','failed','uncertain','uncertain_terminal') AND kind IN ('t3','blocker','watch') ORDER BY request_id,id").all().map(row => ({ ...row }));
    const unknown_sends = unknownSends(receiptsDir);
    db.exec('COMMIT');
    return { open_jobs, open_questions, open_checks, pending_deliveries, unknown_sends, safe_to_switch: !open_jobs.length && !open_questions.length && !open_checks.length && !pending_deliveries.length && !unknown_sends.length };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dataRoot, extra] = process.argv.slice(2);
  try {
    if (!dataRoot || extra !== undefined) throw new Error('usage: node src/catalog-switch-inventory.mjs DATA_ROOT');
    process.stdout.write(JSON.stringify(inventory({ dataRoot })) + '\n');
  } catch {
    // Fail closed. No success-shaped JSON and no answer content on an unreadable input.
    process.stderr.write('catalog-switch-inventory: inventory unavailable; check arguments, database and answer journals. Nothing was changed.\n');
    process.exitCode = 1;
  }
}
