// Requester-side journal for `dalan answer`.
//
// The server applies one answer per question and replays a stored receipt for an exact retry of
// {command_key, expected_revision, text}. A retry that changes the expected revision does not replay: it gets
// revision_conflict. So the requester must remember the exact envelope it first tried to send, and re-send those
// bytes, never a refreshed copy. This module saves that envelope before the first send.
//
// FROZEN INTERFACE (later PRs, such as the dalan mcp answer tools and the restore check, build on exactly this):
//   prepare(job, questionId, text, deps)  -> prepared
//       Validate the input, then resume the saved attempt or save a new one. Same text resumes. Different text
//       throws answer_text_mismatch with no network call. A new attempt reads the revision once (deps.readRevision)
//       and saves {key, expected_revision, text} before anything is sent. Throws invalid_answer for a blank answer,
//       an invalid question ID, or text over 4096 UTF-8 BYTES (the server counts bytes, not characters). It never truncates.
//   send(prepared, deps)                  -> reply
//       Send the saved envelope (deps.post). A lost reply or timeout re-sends the identical envelope, original key and
//       original expected revision, never a refreshed one. command_conflict, revision_conflict and ALREADY_ANSWERED
//       are settled by reading the question back (deps.readQuestion): equal text is confirmed; anything else throws
//       answer_conflict and the journal is left as it is. Retention or authority loss marks the journal "unknown" and
//       throws answer_state_unknown; nothing is ever prepared again.
//   reconcile(job, questionId, deps)      -> {state, ...}   (never sends an answer)
//       Settle a saved attempt by reading the server back (deps.readQuestion). state is one of:
//       "none" (no journal) | "committed" | "confirmed" (the server holds our text; the journal is now committed) |
//       "pending" (the server has no answer; the saved envelope can still be sent) |
//       "conflict" (the server holds a different answer) | "unknown" (the server cannot be asked).
//   deps: {receiptsDir, io (fs, injectable for tests), readRevision() -> integer|null, post(envelope) -> reply, readQuestion() -> {answer}|undefined,
//          attempts=3, retryDelayMs=200, sleep}. Only the members a function uses are needed.
//   answerThroughJournal(...) is prepare() then send(), for the CLI.
//
// File: <receipts>/<job>.answers/<question>.json, mode 0600, fsync on file and directory.
//   {v:1, job, question_id, key:"answer:<question_id>", text, expected_revision, state}
// state: "prepared" (envelope saved, outcome not known) | "committed" (the server applied it or holds the same
// answer) | "unknown" (the server cannot be asked: retention or authority loss).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const JOB_ID = /^[-\w]{8,128}$/;
const QUESTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MAX_ANSWER_BYTES = 4096;
const STATES = new Set(['prepared', 'committed', 'unknown']);
const READBACK = /command_conflict|revision_conflict|ALREADY_ANSWERED/;
const STATE_LOST = /TOMBSTONE|invalid owner capability|unauthorized|no job ".*" in this bridge home|owner capability/i;

export class AnswerJournalError extends Error {
  constructor(code, message, fix = []) { super(message); this.code = code; this.kind = 'local'; this.fix = fix; }
}

// One file name per question ID, injective, with no path separators and no name made only of periods.
const fileStem = questionId => questionId.replace(/[^A-Za-z0-9_-]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
export function journalPath(receiptsDir, job, questionId) {
  return path.join(receiptsDir, `${job}.answers`, `${fileStem(questionId)}.json`);
}

function fsyncDir(dir, io = fs) {
  const fd = io.openSync(dir, 'r');
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
// Write the bytes to a private temp file in the target directory and fsync it. The caller publishes it.
function stage(file, entry, io = fs) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = io.openSync(tmp, 'wx', 0o600);
  try { io.writeSync(fd, JSON.stringify(entry) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
  return tmp;
}

export function readJournal(file, job, questionId) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let entry;
  try { entry = JSON.parse(text); } catch { entry = null; }
  const ok = entry && entry.v === 1 && entry.job === job && entry.question_id === questionId && entry.key === `answer:${questionId}`
    && typeof entry.text === 'string' && STATES.has(entry.state)
    && (entry.expected_revision === null || Number.isSafeInteger(entry.expected_revision) && entry.expected_revision >= 0);
  if (!ok) throw new AnswerJournalError('answer_journal_corrupt', `the answer journal ${file} is unreadable. It is the only record of an answer that may already be sent, so it was left as it is`,
    ['read GET /questions with `dalan questions REQUEST_ID` to see whether the question has an answer', 'remove the journal file only after you have checked']);
  return entry;
}

// Create every missing directory level and fsync each new directory and its parent, so that after a crash no
// level of the path can be missing while the server already holds the answer.
function mkdirDurable(dir, io) {
  const missing = [];
  for (let d = dir; !io.existsSync(d); d = path.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    try { io.mkdirSync(d, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    fsyncDir(d, io);
    fsyncDir(path.dirname(d), io);
  }
}

// Publish a new journal with no partial file visible. Returns false if another process published first.
// On return true, the file, its directory, and every directory level this call created are durable.
function createJournal(file, entry, io) {
  const dir = path.dirname(file);
  mkdirDurable(dir, io);
  const tmp = stage(file, entry, io);
  try {
    try { io.linkSync(tmp, file); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    fsyncDir(dir, io);
    return true;
  } finally { io.rmSync(tmp, { force: true }); }
}
function setState(file, entry, state) {
  if (entry.state === state) return;
  entry.state = state;
  const tmp = stage(file, entry);
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function classify(error) {
  const message = String(error?.message ?? '');
  if (error?.local_code === 'unknown_request' || STATE_LOST.test(message)) return 'unknown';
  if (error?.kind === 'transport' || error?.kind === 'http' && error.http_status >= 500) return 'transport';
  if (error?.kind === 'http' && READBACK.test(message)) return 'readback';
  return 'refused';
}

function checkIds(job, questionId) {
  if (!JOB_ID.test(String(job))) throw new AnswerJournalError('invalid_answer', `invalid request ID ${JSON.stringify(String(job).slice(0, 140))}`);
  if (typeof questionId !== 'string' || !QUESTION_ID.test(questionId)) throw new AnswerJournalError('invalid_answer', 'invalid question_id: use 1 to 128 letters, digits, . _ : or -');
}
function checkInput(job, questionId, text) {
  checkIds(job, questionId);
  if (typeof text !== 'string' || !text.trim()) throw new AnswerJournalError('invalid_answer', 'answer text must not be blank');
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_ANSWER_BYTES) throw new AnswerJournalError('invalid_answer', `answer text is ${bytes} UTF-8 bytes; the limit is ${MAX_ANSWER_BYTES} bytes (not characters). Nothing was sent or saved; shorten the answer, it is never truncated`);
}

const answered = (job, questionId, extra) => ({ request_id: job, question_id: questionId, answered: true, ...extra });
const unknownError = (job, questionId, file, cause) => new AnswerJournalError('answer_state_unknown',
  `cannot tell whether the answer to ${questionId} on ${job} was applied: ${cause.message}. The saved attempt was kept and nothing new was prepared`,
  ['restore access or retention, then run the same answer command again to resume the saved attempt', `the saved attempt is in ${file}`]);

export async function prepare(job, questionId, text, { receiptsDir, readRevision, io = fs }) {
  checkInput(job, questionId, text);
  const file = journalPath(receiptsDir, job, questionId);
  let entry = readJournal(file, job, questionId);
  if (!entry) {
    const expected_revision = await readRevision();
    const fresh = { v: 1, job, question_id: questionId, key: `answer:${questionId}`, text, expected_revision, state: 'prepared' };
    if (createJournal(file, fresh, io)) entry = fresh;
    else { entry = readJournal(file, job, questionId); if (!entry) throw new AnswerJournalError('answer_journal_corrupt', 'answer journal vanished while it was created'); }
  }
  if (entry.text !== text) throw new AnswerJournalError('answer_text_mismatch',
    `question ${questionId} on ${job} already has a saved answer attempt with different text. Nothing was sent. Run the same command with the saved text to finish that attempt`,
    [`the saved attempt is in ${file}`]);
  return { job, questionId, file, entry };
}

// Read the question back and settle the saved attempt. Used by send() after a conflict and by reconcile().
async function settle(prepared, readQuestion, cause) {
  const { job, questionId, file, entry } = prepared;
  let question;
  try { question = await readQuestion(); } catch (error) {
    if (classify(error) === 'unknown') { setState(file, entry, 'unknown'); throw unknownError(job, questionId, file, error); }
    throw error;
  }
  if (question && question.answer === entry.text) { setState(file, entry, 'committed'); return { state: 'confirmed' }; }
  if (question && typeof question.answer === 'string') return { state: 'conflict', cause };
  return { state: 'pending', cause };
}

export async function send(prepared, { post, readQuestion, attempts = 3, retryDelayMs = 200, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const { job, questionId, file, entry } = prepared;
  if (entry.state === 'committed') return answered(job, questionId, { journal: 'committed' });
  // The envelope is frozen here. A retry sends these exact fields: same key, same expected revision, same text.
  const envelope = { id: job, question_id: questionId, text: entry.text, command_key: entry.key, ...(entry.expected_revision === null ? {} : { expected_revision: entry.expected_revision }) };
  for (let attempt = 1; ; attempt++) {
    try {
      const reply = await post(envelope);
      setState(file, entry, 'committed');
      return reply;
    } catch (error) {
      const kind = classify(error);
      if (kind === 'transport' && attempt < attempts) { await sleep(retryDelayMs * attempt); continue; }
      if (kind === 'transport') throw Object.assign(error, { fix: [`the answer may or may not have been applied; run the same answer command again to re-send the saved attempt (${file})`] });
      if (kind === 'unknown') { setState(file, entry, 'unknown'); throw unknownError(job, questionId, file, error); }
      if (kind !== 'readback') throw error;
      const settled = await settle(prepared, readQuestion, error);
      if (settled.state === 'confirmed') return answered(job, questionId, { confirmed: true });
      const holder = settled.state === 'conflict' ? 'a different answer is already recorded for this question' : 'the server did not apply this answer and its state has moved on';
      throw new AnswerJournalError('answer_conflict', `answer to ${questionId} on ${job} was refused (${error.message}): ${holder}. The saved attempt was left unchanged`, [`the saved attempt is in ${file}`]);
    }
  }
}

export async function reconcile(job, questionId, { receiptsDir, readQuestion }) {
  checkIds(job, questionId);
  const file = journalPath(receiptsDir, job, questionId);
  const entry = readJournal(file, job, questionId);
  if (!entry) return { state: 'none' };
  if (entry.state === 'committed') return { state: 'committed' };
  const settled = await settle({ job, questionId, file, entry }, readQuestion);
  return { state: settled.state };
}

export async function answerThroughJournal({ job, questionId, text, ...deps }) {
  return send(await prepare(job, questionId, text, deps), deps);
}
