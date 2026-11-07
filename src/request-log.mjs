import { readEnv } from './env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { redactLogEntry } from './redaction.mjs';

function positiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

// One writer per bridge. Rotation and the complete append run synchronously, so no other
// log call can interleave them. No open descriptor survives a rename.
export function createRequestLog(file, {
  maxBytes = readEnv('DALAN_LOG_MAX_BYTES') ?? 32 * 1024 * 1024,
  keep = readEnv('DALAN_LOG_KEEP') ?? 4,
} = {}) {
  file = path.resolve(file);
  maxBytes = positiveInteger(maxBytes, 'DALAN_LOG_MAX_BYTES');
  keep = positiveInteger(keep, 'DALAN_LOG_KEEP');
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return entry => {
    const line = JSON.stringify(redactLogEntry({ at: new Date().toISOString(), ...entry })) + '\n';
    // The crossing line stays whole; the next append starts a fresh file. This also
    // rotates an oversized existing log on the first write after a restart.
    if (bytes > maxBytes) {
      for (const generation of listGenerations(file)) {
        if (generation === file) continue;
        const n = Number(generation.slice(file.length + 1));
        if (n >= keep) fs.unlinkSync(generation);
        else fs.renameSync(generation, `${file}.${n + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
      bytes = 0;
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
    bytes += Buffer.byteLength(line);
  };
}

// Discover retained history independently of the writer's current KEEP setting.
export function listGenerations(file) {
  let names;
  try { names = fs.readdirSync(path.dirname(file)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const base = path.basename(file);
  return names.filter(name => name === base || (name.startsWith(`${base}.`) && /^[1-9]\d*$/.test(name.slice(base.length + 1))))
    .sort((a, b) => Number(b.slice(base.length + 1) || 0) - Number(a.slice(base.length + 1) || 0))
    .map(name => path.join(path.dirname(file), name));
}

// Pin inodes before reading: a live bridge may rename or retire generations while
// a backfill scans them. Verify the filenames still identify the opened snapshot.
function openSnapshot(file, missingOk) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const opened = [];
    try {
      const files = listGenerations(file);
      if (!files.length && !missingOk) files.push(file); // preserve ENOENT for CLI typos
      for (const name of files) {
        const fd = fs.openSync(name, 'r');
        opened.push({ fd, name });
        opened.at(-1).stat = fs.fstatSync(fd);
      }
      const current = listGenerations(file);
      const stable = current.length === files.length && current.every((name, i) => name === files[i]) && opened.every(({ name, stat }) => {
        const now = fs.statSync(name);
        return now.dev === stat.dev && now.ino === stat.ino;
      });
      if (stable) return opened;
    } catch (error) {
      for (const { fd } of opened) fs.closeSync(fd);
      if (error.code !== 'ENOENT' || attempt === 2) throw error;
      continue;
    }
    for (const { fd } of opened) fs.closeSync(fd);
  }
  throw new Error('request log rotated repeatedly while opening history; retry the read');
}

// Oldest first, complete lines only. Bound memory to a chunk plus one line and never
// join an incomplete tail in one generation to the first line of the next.
export function* readLines(file, { missingOk = false } = {}) {
  const opened = openSnapshot(file, missingOk);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (const { fd, stat } of opened) {
      const decoder = new StringDecoder('utf8');
      let rest = '', position = 0;
      while (position < stat.size) {
        const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!n) break;
        position += n;
        const lines = (rest + decoder.write(buffer.subarray(0, n))).split('\n');
        rest = lines.pop();
        yield* lines;
      }
    }
  } finally { for (const { fd } of opened) fs.closeSync(fd); }
}
