// The zero-provider gate: Dalan names no route provider anywhere (file contents or file names), so every route question goes to Gozar.
// Usage: node scripts/provider-neutral-test.mjs            fail on any residual outside the allowed locations
//        node scripts/provider-neutral-test.mjs --inventory   print every residual as JSON (never fails; for owners to clear)
//        node scripts/provider-neutral-test.mjs --only PREFIX...   check only tracked paths that start with a prefix
// The deny-list lives in this file only (the one allowed scanner location). Long names match as substrings; short names match as words,
// SNAKE_CASE parts or camelCase parts, so `observeOpen`, `parts.netloc` and base64 do not trip it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const LONG = ['tailscale', 'ngrok', 'cloudflare', 'localtunnel', 'pinggy', 'pagekite', 'tunnl', 'localhost[.-]run', 'bore[.]pub'];
const SHORT = ['funnel', 'frp', 'inlets', 'serveo', 'zrok', 'tsnet', 'ts[.]net'];
const CAMEL = ['Funnel', 'Frp', 'Inlets', 'Serveo', 'Zrok', 'Tsnet'];
export const DENY = new RegExp(`(?:${LONG.join('|')})|(?<![A-Za-z0-9])(?:${SHORT.join('|')})s?(?![a-z0-9])|(?<=[a-z0-9])(?:${CAMEL.join('|')})s?(?![a-z0-9])`, 'i');
// The camel-case branch must stay case sensitive, and the short branch is case-insensitive as a word: check each branch on its own.
const longRe = new RegExp(`(?:${LONG.join('|')})`, 'i');
const shortRe = new RegExp(`(?<![A-Za-z0-9])(?:${SHORT.join('|')})s?(?![a-z0-9])`, 'i');
const camelRe = new RegExp(`(?<=[a-z0-9])(?:${CAMEL.join('|')})s?(?![a-z0-9])`);
export const matches = text => longRe.test(text) || shortRe.test(text) || camelRe.test(text);
const firstMatch = line => (longRe.exec(line) ?? shortRe.exec(line) ?? camelRe.exec(line))?.[0] ?? null;

// Allowed locations (SHIP-PLAN, "Exact grep gate and exceptions"). Anything not matched here fails.
export const ALLOWED = [
  { test: file => file === 'scripts/provider-neutral-test.mjs', why: 'the scanner deny-list' },
  { test: file => file === 'package-lock.json', why: 'transitive package names and integrity metadata only' },
  { test: file => file === 'CHANGELOG.md', why: 'historical sections predating the neutral release only; current instructions cannot name provider flags' },
  { test: file => file === 'scripts/install-inbox-test.mjs', why: 'tests the legacy worker-bridge-setup.mjs, which still calls an external route command; the test fakes that command by name. Legacy, kept for compatibility, not documented' },
  { test: file => ['README.md', 'docs/service-setup.md', 'docs/codex-to-muse.md', 'docs/connect-chatgpt.md', 'docs/chatgpt-worker-onboarding.md', 'docs/worker-clients.md', 'docs/manual-setup.md'].includes(file), why: 'the quick-start guides give the concrete `--route tailscale` command and the Funnel prerequisite (release ruling 2026-11-12); code and tests stay neutral' },
  { test: file => file === 'src/test-support/gozar-contract.json', why: 'the frozen Gozar route-contract fixture, vendored verbatim and sha256-pinned in scripts/gozar-route-contract-test.mjs; not shipped' },
  { test: file => /^docs\/(history|design|research)\//.test(file), why: 'non-shipped historical or design references only' },
];
const allowedBy = file => ALLOWED.find(rule => rule.test(file))?.why ?? null;

export function scan({ only = [] } = {}) {
  let listed;
  try { listed = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }); } catch (error) { throw new Error(`cannot list tracked files: ${error.message}`); }
  const files = listed.toString('utf8').split('\0').filter(Boolean).filter(file => only.length === 0 || only.some(prefix => file.startsWith(prefix)));
  const found = [];
  for (const file of files) {
    if (matches(file)) found.push({ file, line: 0, kind: 'name', match: firstMatch(file) });
    const full = path.join(repo, file);
    let buffer;
    try { buffer = fs.readFileSync(full); } catch (error) { if (error.code === 'ENOENT') continue; throw new Error(`cannot read ${file}: ${error.code}`); } // a deleted-but-listed path is not a consumer
    if (buffer.includes(0)) continue; // binary
    buffer.toString('utf8').split('\n').forEach((text, index) => { if (matches(text)) found.push({ file, line: index + 1, kind: 'content', match: firstMatch(text) }); });
  }
  return { scanned: files.length, residuals: found.map(item => ({ ...item, allowedBy: allowedBy(item.file) })) };
}

const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}` && argv.includes('--inventory')) {
  const result = scan({ only: argv.filter(arg => !arg.startsWith('--')) });
  const open = result.residuals.filter(item => !item.allowedBy);
  process.stdout.write(`${JSON.stringify({ scanned: result.scanned, open: open.length, allowed: result.residuals.length - open.length, residuals: result.residuals }, null, 2)}\n`);
} else {
  const only = argv.includes('--only') ? argv.slice(argv.indexOf('--only') + 1).filter(arg => !arg.startsWith('--')) : [];
  test('the scanner flags a provider the way the gate defines it, and only that', () => {
    for (const bad of ['--expose tailscale', 'NGROK_AUTHTOKEN', 'exposeTailscale', 'cloudflared', 'tailscaled', 'localhost.run', 'a funnel rule', 'TS_FUNNEL_PORT', 'applyFunnel', 'x.ts.net']) assert.equal(matches(bad), true, bad);
    for (const ok of ['observeOpen', 'parts.netloc', 'ZnJwYnJwZnJw', 'a Gozar route', 'the frame', 'inlet', 'funnelled'.replace('funnelled', 'unfunneled')]) assert.equal(matches(ok), false, ok);
  });
  test('no tracked file or file name outside the allowed locations names a route provider', () => {
    const { scanned, residuals } = scan({ only });
    assert.ok(scanned > 0, 'the scan read the tracked files');
    const open = residuals.filter(item => !item.allowedBy);
    assert.deepEqual(open.map(item => `${item.file}:${item.line} (${item.kind}: ${item.match})`), [], `${open.length} residual provider names; run with --inventory for the full list`);
  });
}
