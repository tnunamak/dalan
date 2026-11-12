import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// An update window is open from the moment the updater records phase 'switched' (service stopped, snapshot complete) until it
// records 'committed' or finishes a rollback and removes the journal. Rollback restores the snapshot, so any mutation the
// candidate acknowledged inside the window would be lost. The server therefore refuses every mutating entry while it is open.
// Unreadable journal: fail closed. The updater writes it atomically, so only damage reaches this branch.
export function updateWindowOpen(home = os.homedir()) {
  let text;
  try { text = fs.readFileSync(path.join(home, 'update-transaction.json'), 'utf8'); }
  catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? false : true; }
  try { return JSON.parse(text)?.phase === 'switched'; } catch { return true; }
}

export const UPDATE_RETRY_SECONDS = 15;
export function refuseDuringUpdate(res) {
  res.writeHead(503, { 'content-type': 'application/json', 'retry-after': String(UPDATE_RETRY_SECONDS) });
  res.end(JSON.stringify({ error: 'service_updating', retryable: true }));
}
