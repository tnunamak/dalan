// The one-waiter-per-producer slot of `wait --drained`.
//
// The slot is a directory. Each waiter builds a private directory that already holds its own entry file, then renames it
// to the slot name. rename() onto an existing directory succeeds only if that directory is empty, so a taker either gets
// the whole slot or learns that someone holds it. A stale entry is removed by its own unique name (pid and random token),
// so no waiter can ever remove an entry that another waiter wrote. There is no lock file to leave behind: a waiter that
// dies at any step leaves a directory that the next waiter either replaces (empty), clears (dead entries) or respects
// (a live entry). A holder is reported only after `isLive` confirmed it.
import fs from 'node:fs';
import path from 'node:path';

const entryName = owner => `${owner.pid}-${owner.token}.json`;
const readEntry = file => {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  let entry;
  try { entry = JSON.parse(raw); } catch { throw new Error(`invalid waiter entry: ${file}`); }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || (entry.token !== undefined && typeof entry.token !== 'string')) {
    throw new Error(`invalid waiter entry: ${file}`);
  }
  return entry;
};

const waiterIsLive = (entry, isLive, file) => {
  const state = isLive(entry);
  if (state === true) return true;
  if (state === false) return false;
  throw new Error(`could not inspect waiter: ${file}`);
};

// Returns null when `owner` now holds the slot, or the live holder's entry. Throws when the slot cannot be settled.
export function takeSlot(slot, owner, { isLive, beforeRemoval } = {}) {
  const tmp = `${slot}.${owner.pid}.${owner.token}.tmp`;
  fs.mkdirSync(tmp, { mode: 0o700 });
  fs.writeFileSync(path.join(tmp, entryName(owner)), JSON.stringify(owner), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { fs.renameSync(tmp, slot); return null; }
      catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error; }
      let stat;
      try { stat = fs.lstatSync(slot); } catch { continue; }
      if (stat.isFile()) { // a pidfile written by an earlier release
        const held = readEntry(slot);
        if (held && waiterIsLive(held, isLive, slot)) return held;
        beforeRemoval?.();
        fs.rmSync(slot, { force: true });
        continue;
      }
      let names;
      try { names = fs.readdirSync(slot); } catch { continue; }
      const stale = [];
      for (const name of names) {
        const entry = readEntry(path.join(slot, name));
        if (entry === undefined) continue;
        if (waiterIsLive(entry, isLive, path.join(slot, name))) return entry;
        stale.push(name);
      }
      if (!stale.length) continue; // empty: the next rename replaces it
      beforeRemoval?.();
      for (const name of stale) fs.rmSync(path.join(slot, name), { force: true });
    }
    throw new Error(`could not settle the waiter slot ${slot}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function releaseSlot(slot, owner) {
  fs.rmSync(path.join(slot, entryName(owner)), { force: true });
  try { fs.rmdirSync(slot); } catch { /* another waiter's entry is in it */ }
}
