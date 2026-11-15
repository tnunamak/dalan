// Local retention companion. Call only while journal writers and filesystem renames
// are quiesced by the host; Node's path APIs do not provide portable unlinkat.
import fs from 'node:fs';
import path from 'node:path';
import {journalPath} from './answer-journal.mjs';

const JOB = /^[-\w]{8,128}$/;
const QUESTION = /^[A-Za-z0-9_.:-]{1,128}$/;
const fail = code => { throw Object.assign(new Error(code), {code}); };
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;
function directoryChain(value) {
  const absolute = path.resolve(value), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_directory');
  }
  return absolute;
}
function journalName(name, receiptsDir, job) {
  if (!name.endsWith('.json')) return false;
  let question;
  try { question = decodeURIComponent(name.slice(0,-5)); } catch { return false; }
  return QUESTION.test(question) && path.basename(journalPath(receiptsDir,job,question)) === name;
}
export function assertJournalAllowed(store, job) {
  // Requesters use an authenticated availability callback, not a second Store.
  // Await its result before preparing; local Store callers remain synchronous.
  if (typeof store === 'function') return store(job);
  // Retained tombstones remain authoritative even if other native rows are gone.
  if (store.db.prepare('SELECT 1 FROM job_retention_tombstones WHERE job=?').get(job)) fail('TOMBSTONE');
  return store.assertProtocolAvailable(job);
}
export function pruneExpiredAnswerJournals({store, receiptsDir}) {
  if (typeof receiptsDir !== 'string' || !receiptsDir) fail('invalid_receipts_directory');
  const jobs = store.db.prepare('SELECT job FROM job_retention_tombstones ORDER BY job').all();
  const result = {pruned:[], skipped:[]};
  let root, rootStat;
  try { root=directoryChain(receiptsDir); rootStat=fs.lstatSync(root); }
  catch(error) {
    for (const {job} of jobs) result.skipped.push({job,reason:error.code==='ENOENT'?'receipts_missing':'unsafe_receipts_directory'});
    return result;
  }
  for (const {job} of jobs) {
    if (typeof job !== 'string' || !JOB.test(job)) { result.skipped.push({job,reason:'invalid_job_id'}); continue; }
    const dir=path.join(root,job+'.answers');
    try {
      const assertRoot=()=>{
        if (directoryChain(root)!==root || !same(rootStat,fs.lstatSync(root))) fail('receipts_changed');
      };
      assertRoot();
      const directoryStat=fs.lstatSync(dir);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) fail('unsafe_answers_directory');
      const assertDirectory=()=>{
        assertRoot();
        const current=fs.lstatSync(dir);
        if (!current.isDirectory() || current.isSymbolicLink() || !same(directoryStat,current)) fail('answers_changed');
      };
      // Inspect the entire directory BEFORE deleting anything. Unexpected files,
      // staged writes, nested directories and symlinks preserve the whole entry.
      const names=fs.readdirSync(dir).sort();
      const entries=names.map(name=>{
        if (!journalName(name,root,job)) fail('unexpected_journal_name');
        const stat=fs.lstatSync(path.join(dir,name));
        if (!stat.isFile() || stat.isSymbolicLink()) fail('unsafe_journal_entry');
        return {name,stat};
      });
      for (const {name,stat} of entries) {
        assertDirectory();
        const file=path.join(dir,name),current=fs.lstatSync(file);
        if (!current.isFile() || current.isSymbolicLink() || !same(stat,current)) fail('journal_changed');
        fs.unlinkSync(file);
      }
      assertDirectory();
      fs.rmdirSync(dir); // Never recursive: new/unrecognized children are retained.
      const fd=fs.openSync(root,'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      result.pruned.push(job);
    } catch(error) {
      result.skipped.push({job,reason:error.code==='ENOENT'?'journal_missing':error.code??'prune_failed'});
    }
  }
  return result;
}
