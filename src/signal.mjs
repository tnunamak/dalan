import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeAtomic } from './as-files.mjs';

// Public wake signal for hook-driven workers (built-in mode only). GET /signal/<token> answers {"work":true|false}: is a
// queued, live assignment waiting for the one worker the token belongs to. The token is its own 256-bit secret, never the MCP path secret.
// The response reveals one bit: no ids, titles or counts. Work is a queued job for the worker, or (resume wake, DALAN_RESUME_IDLE_MS)
// one of the worker's own claims that has gone idle.
const PREFIX = '/signal/';
const TOKEN = /^[a-f0-9]{64}$/;
const CACHE_MS = 10000;
const IP_BURST = 3, IP_REFILL_MS = 5000; // about one request per 5 s with a small burst
const GLOBAL_PER_MINUTE = 30;
const MAX_TRACKED_IPS = 4096;
const digest = value => createHash('sha256').update(value).digest();

export function createSignal({ dir, store, workerNames, publicUrl, log, now = Date.now }) {
  // One secret per worker in signal-token.<worker>. A host from before per-worker tokens has a single signal-token file; it keeps
  // answering for the one configured worker (so a hook already polling that URL survives) and is retired by that worker's rotation.
  const legacyFile = path.join(dir, 'signal-token');
  const fileFor = worker => path.join(dir, `signal-token.${worker}`);
  const readToken = file => {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      return TOKEN.test(text) ? text : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const tokens = new Map(); // worker -> own token
  const tokenOf = worker => {
    if (!tokens.has(worker)) tokens.set(worker, readToken(fileFor(worker)));
    const names = workerNames();
    return tokens.get(worker) ?? (names.length === 1 && names[0] === worker ? readToken(legacyFile) : null);
  };
  const targetWorker = worker => {
    const names = workerNames();
    if (worker === undefined || worker === null) {
      if (names.length === 1) return names[0];
      throw new Error(`signal-token needs --worker NAME; configured: ${names.join(', ')}`);
    }
    if (!names.includes(worker)) throw new Error(`unknown worker "${worker}"; configured workers: ${names.join(', ')}`);
    return worker;
  };

  // Owner socket only. A new token replaces the worker's old one at once; the old URL answers 404 from this call on.
  function tokenUrl({ worker, rotate = false } = {}) {
    const name = targetWorker(worker);
    let token = tokenOf(name);
    if (rotate || !token) {
      token = randomBytes(32).toString('hex');
      writeAtomic(fileFor(name), `${token}\n`);
      fs.chmodSync(fileFor(name), 0o600);
      tokens.set(name, token);
      if (workerNames().length === 1) fs.rmSync(legacyFile, { force: true }); // the pre-migration token must not outlive rotation
    }
    return { url: new URL(`${PREFIX}${token}`, publicUrl).href, worker: name, rotated: !!rotate };
  }

  const cached = new Map(); // worker -> { at, work }
  const work = worker => {
    const at = now(), hit = cached.get(worker);
    if (hit && at >= hit.at && at - hit.at < CACHE_MS) return hit.work;
    const fresh = { at, work: store.hasWakeFor(worker) };
    cached.set(worker, fresh);
    return fresh.work;
  };
  // Hash both sides so the compare takes the same time for any input length; a worker without a token matches nothing.
  // Every configured worker is compared, so timing does not reveal which worker matched.
  const workerFor = given => {
    const wanted = digest(given);
    let found = null;
    for (const name of workerNames()) {
      const token = tokenOf(name);
      if (token !== null && timingSafeEqual(wanted, digest(token))) found = name;
    }
    return found;
  };

  const buckets = new Map(); // ip -> { tokens, at }
  const recent = []; // times of admitted requests in the last minute
  function admit(ip) {
    const at = now();
    while (recent.length && at - recent[0] >= 60000) recent.shift();
    if (recent.length >= GLOBAL_PER_MINUTE) return Math.max(1, Math.ceil((60000 - (at - recent[0])) / 1000));
    let bucket = buckets.get(ip);
    if (!bucket) {
      if (buckets.size >= MAX_TRACKED_IPS) for (const [key, b] of buckets) if (at - b.at >= IP_BURST * IP_REFILL_MS) buckets.delete(key);
      if (buckets.size >= MAX_TRACKED_IPS) return 60; // table full of live buckets: refuse rather than grow
      bucket = { tokens: IP_BURST, at };
      buckets.set(ip, bucket);
    }
    bucket.tokens = Math.min(IP_BURST, bucket.tokens + (at - bucket.at) / IP_REFILL_MS);
    bucket.at = at;
    if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) * IP_REFILL_MS / 1000));
    bucket.tokens -= 1;
    recent.push(at);
    return 0;
  }

  // Returns true when the request was a signal request and has been answered.
  function handle(req, res) {
    const pathname = String(req.url).split('?')[0];
    if (!pathname.startsWith(PREFIX)) return false;
    const given = pathname.slice(PREFIX.length);
    const worker = workerFor(given);
    if (worker === null) { log({ kind: 'signal', status: 404 }); res.writeHead(404); res.end(); return true; }
    if (req.method !== 'GET') { log({ kind: 'signal', status: 405 }); res.writeHead(405, { allow: 'GET' }); res.end(); return true; }
    const wait = admit(req.socket.remoteAddress ?? 'unknown');
    if (wait) { log({ kind: 'signal', status: 429 }); res.writeHead(429, { 'retry-after': String(wait), 'cache-control': 'no-store' }); res.end(); return true; }
    const answer = work(worker);
    const body = JSON.stringify({ work: answer });
    log({ kind: 'signal', status: 200, work: answer });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }

  return { handle, tokenUrl };
}
