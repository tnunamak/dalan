import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { failure, checkParents, checkDirectory, thawTree, preparedNodeStore } from './prepared-node-modules.mjs';

// Keep-newest-N pruning for the prepared node_modules store (npm and pnpm entries share it). A running check bind-mounts an entry
// read-only, so an entry is never deleted in place: it is renamed to `.pruned-<uuid>` (open files and mounts keep their inodes), and only a
// later pass, at least an hour after, deletes it. Entries younger than a day are never touched, which also spares an entry a check
// resolved moments ago. Entries rank by last use (markUsed touches metadata.json when a check resolves one), not publication time, so a
// busy repository's entry is not evicted by newer entries of idle ones. Stale `.replaced-*` and abandoned `.stage-*` directories follow the same age rule.
const HOUR = 3600e3, DAY = 24 * HOUR;
const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const remove = target => { try { thawTree(target); fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); return true; } catch { return false; } };

export function pruneNodeStore(options = {}) {
  const keep = options.keep ?? 4, now = options.now ?? Date.now();
  if (!Number.isInteger(keep) || keep < 1) throw failure('dependencies_invalid', 'keep must be a positive integer');
  const base = preparedNodeStore(options);
  const result = { kept: [], renamed: [], deleted: [], skipped_young: [] };
  if (!fs.existsSync(base)) return result;
  checkParents(base); checkDirectory(base, true);
  // Published entries: <lock hash>/<key>/metadata.json; its mtime is the last use (publication time until a check resolves the entry).
  const entries = [];
  for (const lockName of list(base).filter(name => !name.startsWith('.'))) {
    for (const key of list(path.join(base, lockName))) {
      const entry = path.join(base, lockName, key);
      try { entries.push({ entry, published: fs.lstatSync(path.join(entry, 'metadata.json')).mtimeMs }); } catch { /* not an entry */ }
    }
  }
  entries.sort((a, b) => b.published - a.published);
  entries.forEach((item, index) => {
    if (index < keep) return result.kept.push(item.entry);
    if (now - item.published < DAY) return result.skipped_young.push(item.entry);
    try { fs.renameSync(item.entry, path.join(base, `.pruned-${randomUUID()}`)); result.renamed.push(item.entry); } catch { result.kept.push(item.entry); }
  });
  // An empty lock directory may belong to a preparation that is still fetching (it creates the directory first and publishes last), so
  // only one that has stayed empty for a day is removed.
  for (const lockName of list(base).filter(name => !name.startsWith('.'))) {
    const dir = path.join(base, lockName);
    try { if (now - fs.lstatSync(dir).mtimeMs >= DAY) fs.rmdirSync(dir); } catch { /* not empty or gone */ }
  }
  // Delete only what an earlier pass renamed (ctime moves on rename) or what has been stale for a day.
  for (const name of list(base)) {
    const target = path.join(base, name);
    let age;
    try { const st = fs.lstatSync(target); age = now - (name.startsWith('.stage-') ? st.mtimeMs : st.ctimeMs); } catch { continue; }
    const limit = name.startsWith('.pruned-') ? HOUR : /^\.(replaced|stage)-/.test(name) ? DAY : Infinity;
    if (age >= limit && remove(target)) result.deleted.push(target);
  }
  return result;
}
