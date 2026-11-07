#!/usr/bin/env node
// Public-readiness scan: a tracked file must not name an internal role, a job code, the legacy worker nickname or,
// with a private deny list, an owner host, a person, a home path or a private tool.
// Every hit is either fixed or listed, with a reason, in scripts/public-scan-allowlist.json. Members of tracked .tgz archives are scanned too.
// The private names are not in the repository: DALAN_PUBLIC_SCAN_DENYLIST names an untracked file with one rule per line,
// `RULE-ID /REGEX/FLAGS` (blank lines and # comments ignored). When the variable is set, a missing, unreadable or empty
// file fails the scan. Without it only the generic rules below run.
// Usage: [DALAN_PUBLIC_SCAN_DENYLIST=FILE] node scripts/public-scan.mjs [--list-allowed] [--root DIR]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listAllowed = args.includes('--list-allowed');

// Each rule finds a word that a reader outside the project should not meet. `token` widens a hit to the
// identifier around it, so an allow-list entry can name `dot-bridge.read` instead of a line number.
export const GENERIC_RULES = [
  { id: 'internal-role', re: /\bthe lead\b|\blead's\b|\blead_thread_id\b/gi },
  { id: 'job-code', re: /\bg\d+[a-z]\b|\bS[0-8]\b|\bs1v2\b/g },
  { id: 'worker-nickname', re: /\bdot\b/gi },
];

// Rules from deny-list text. Throws on a malformed line, so a typo cannot silently drop a private name.
export function parseDenylist(text) {
  const rules = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^([a-z][a-z0-9-]*)\s+\/(.+)\/([a-z]*)$/.exec(line);
    if (!m) throw new Error(`deny list line ${index + 1}: expected RULE-ID /REGEX/FLAGS`);
    try { rules.push({ id: m[1], re: new RegExp(m[2], m[3]) }); }
    catch (error) { throw new Error(`deny list line ${index + 1}: ${error.message}`); }
  });
  return rules;
}

// The generic rules, plus the private ones when DALAN_PUBLIC_SCAN_DENYLIST names a file. A configured list that
// cannot be read or holds no rules throws: the owner asked for the private check, so it must not pass without it.
export function loadRules(env = process.env) {
  const file = env.DALAN_PUBLIC_SCAN_DENYLIST;
  if (!file) return { rules: GENERIC_RULES, denylist: null };
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { throw new Error(`cannot read DALAN_PUBLIC_SCAN_DENYLIST file ${file}: ${error.code ?? error.message}`); }
  const rules = parseDenylist(text);
  if (!rules.length) throw new Error(`DALAN_PUBLIC_SCAN_DENYLIST file ${file} has no rules`);
  return { rules: [...GENERIC_RULES, ...rules], denylist: file };
}

const TOKEN_CHARS = /[\w.\-/:@]/;
const SELF = new Set(['scripts/public-scan.mjs', 'scripts/public-scan-allowlist.json', 'scripts/public-scan-test.mjs', 'package-lock.json']);

function token(line, start, end) {
  let a = start, b = end;
  while (a > 0 && TOKEN_CHARS.test(line[a - 1])) a -= 1;
  while (b < line.length && TOKEN_CHARS.test(line[b])) b += 1;
  return line.slice(a, b);
}

export function scanText(file, text, rules = GENERIC_RULES) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const rule of rules) {
      for (const match of line.matchAll(new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`))) {
        hits.push({ rule: rule.id, file, line: index + 1, token: token(line, match.index, match.index + match[0].length), text: line });
      }
    }
  });
  return hits;
}

export function loadAllowlist(file) {
  return JSON.parse(readFileSync(file, 'utf8')).map(entry => {
    if (!entry.rule || !entry.reason || !(entry.token || entry.line)) throw new Error(`allow-list entry needs rule, reason and token or line: ${JSON.stringify(entry)}`);
    return { ...entry, pathRe: entry.path ? new RegExp(entry.path) : null, tokenRe: entry.token ? new RegExp(entry.token) : null, lineRe: entry.line ? new RegExp(entry.line) : null, count: 0 };
  });
}

export function classify(hits, allowlist) {
  const unexplained = [];
  for (const hit of hits) {
    const entry = allowlist.find(e => e.rule === hit.rule && (!e.pathRe || e.pathRe.test(hit.file)) && (!e.tokenRe || e.tokenRe.test(hit.token)) && (!e.lineRe || e.lineRe.test(hit.text)));
    if (entry) entry.count += 1; else unexplained.push(hit);
  }
  return unexplained;
}

// Members of a gzipped tar archive, as [name, Buffer]. Reads ustar and GNU/pax long names; no dependency.
export function tarMembers(gz) {
  const tar = gunzipSync(gz);
  const members = [];
  let longName = null;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8')); if (m) longName = m[1]; continue; }
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type === '0' || type === '7') members.push([name, body]);
  }
  return members;
}

// A tracked file, or each member of a tracked .tgz, as [displayName, Buffer]. Member names read `archive!member`.
export function scanUnits(file, buffer) {
  if (!/\.(tgz|tar\.gz)$/.test(file)) return [[file, buffer]];
  return [[file, Buffer.alloc(0)], ...tarMembers(buffer).map(([name, body]) => [`${file}!${name}`, body])];
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
}

function main() {
  let rules, denylist;
  try { ({ rules, denylist } = loadRules()); }
  catch (error) { console.error(`public-scan: ${error.message}`); process.exit(2); }
  const active = new Set(rules.map(rule => rule.id));
  // Entries for a private rule apply only when the deny list defines that rule.
  const allowlist = loadAllowlist(path.join(root, 'scripts/public-scan-allowlist.json')).filter(entry => active.has(entry.rule));
  const hits = [];
  for (const file of trackedFiles()) {
    if (SELF.has(file)) continue;
    let buffer;
    try { buffer = readFileSync(path.join(root, file)); } catch { continue; }
    for (const [name, body] of scanUnits(file, buffer)) {
      hits.push(...scanText(`${name} (name)`, name, rules).map(h => ({ ...h, line: 0 })));
      if (!body.includes(0)) hits.push(...scanText(name, body.toString('utf8'), rules));
    }
  }
  const unexplained = classify(hits, allowlist);
  const stale = allowlist.filter(entry => entry.count === 0);
  const allowed = hits.length - unexplained.length;
  if (listAllowed) for (const e of allowlist) console.log(`${String(e.count).padStart(5)}  ${e.rule}  ${e.path ?? '*'}  ${e.token ?? e.line}  -- ${e.reason}`);
  for (const hit of unexplained) console.log(`${hit.file}:${hit.line}: [${hit.rule}] ${hit.token}  | ${hit.text.trim().slice(0, 160)}`);
  for (const entry of stale) console.log(`stale allow-list entry (matches nothing): ${entry.rule} ${entry.path ?? '*'} ${entry.token ?? entry.line}`);
  console.log(denylist ? `private deny list: ${rules.length - GENERIC_RULES.length} rules from DALAN_PUBLIC_SCAN_DENYLIST` : 'private deny list: not configured (set DALAN_PUBLIC_SCAN_DENYLIST to check private names)');
  console.log(`public-scan: ${unexplained.length} unexplained, ${allowed} allow-listed hits under ${allowlist.length} entries, ${stale.length} stale entries`);
  process.exit(unexplained.length || stale.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
