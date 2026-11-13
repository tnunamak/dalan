// The zero-provider gate: Dalan's source and docs name no route provider, so every route question goes to Gozar.
// The vendor words come from the installed Gozar manifest, never from a list kept here: each provider id, plus the first
// hyphen-separated part of an id when that part has 4 or more letters. Adding a provider to Gozar changes what this gate rejects.
// Scanned: src/, bin/, README.md and docs/ (file contents and file names). Exempt: docs/routes.md (generated from Gozar's catalog) and CHANGELOG.md.
// The reach words of the route contract and `localhost` (a loopback host name Dalan's security code must write) are not vendor words.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
export const SCANNED = ['src', 'bin', 'README.md', 'docs'];
export const EXEMPT = ['docs/routes.md', 'CHANGELOG.md'];
export const GENERIC_WORDS = new Set(['internet', 'tailnet', 'lan', 'this-device', 'localhost']);

export function manifestPath() { return path.join(path.dirname(require.resolve('@tnunamak/gozar/package.json')), 'adapters', 'manifest.json'); }

export function vendorWords(file = manifestPath()) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = (manifest.definitions ?? []).map(entry => typeof entry === 'string' ? entry.replace(/\.definition\.json$/, '') : entry?.id).filter(id => typeof id === 'string' && id);
  const words = new Set();
  for (const id of ids) {
    words.add(id.toLowerCase());
    const first = id.split('-')[0];
    if (/^[A-Za-z]{4,}$/.test(first)) words.add(first.toLowerCase());
  }
  for (const generic of GENERIC_WORDS) words.delete(generic);
  return { ids, words: [...words].sort() };
}

export const matcher = words => new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

function* walk(root, relative) {
  const full = path.join(root, relative);
  let stat; try { stat = fs.lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) { for (const name of fs.readdirSync(full).sort()) yield* walk(root, path.join(relative, name)); return; }
  if (stat.isFile()) yield relative.split(path.sep).join('/');
}

export function scan({ root = repo, words = vendorWords().words } = {}) {
  assert.ok(words.length > 0, 'the installed Gozar manifest gave no provider ids');
  const re = matcher(words);
  const found = [];
  let scanned = 0;
  for (const top of SCANNED) for (const file of walk(root, top)) {
    if (EXEMPT.includes(file)) continue;
    scanned++;
    const nameMatch = re.exec(file);
    if (nameMatch) found.push({ file, line: 0, kind: 'name', match: nameMatch[0] });
    const buffer = fs.readFileSync(path.join(root, file));
    if (buffer.includes(0)) continue; // binary
    buffer.toString('utf8').split('\n').forEach((text, index) => { const m = re.exec(text); if (m) found.push({ file, line: index + 1, kind: 'content', match: m[0] }); });
  }
  return { scanned, found };
}

const label = item => `${item.file}:${item.line} (${item.kind}: ${item.match})`;

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--inventory')) {
  const { words } = vendorWords();
  process.stdout.write(`${JSON.stringify({ words, ...scan({ words }) }, null, 2)}\n`);
} else {
  test('the vendor words come from the installed Gozar manifest: every id, and each id\'s first part of 4 or more letters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-manifest-'));
    try {
      const file = path.join(dir, 'manifest.json');
      fs.writeFileSync(file, JSON.stringify({ definitions: ['acme-edge.definition.json', 'zed-two-way.definition.json', 'lan.definition.json'] }));
      assert.deepEqual(vendorWords(file), { ids: ['acme-edge', 'zed-two-way', 'lan'], words: ['acme', 'acme-edge', 'zed-two-way'] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const real = vendorWords();
    assert.ok(real.ids.length >= 1 && real.words.length >= real.ids.length - GENERIC_WORDS.size, 'the real manifest yields words');
    for (const id of real.ids.filter(id => !GENERIC_WORDS.has(id))) assert.ok(real.words.includes(id), id);
  });

  test('a vendor word in README.md fails the gate, and a word the manifest does not name does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-scan-'));
    try {
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'README.md'), 'Dalan needs one Gozar route.\n');
      fs.writeFileSync(path.join(dir, 'docs', 'routes.md'), 'Generated: acme-edge\n');
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'history: acme-edge\n');
      const words = ['acme', 'acme-edge'];
      assert.deepEqual(scan({ root: dir, words }).found, []);
      fs.appendFileSync(path.join(dir, 'README.md'), 'Install AcmeCLI first.\n');
      assert.deepEqual(scan({ root: dir, words }).found.map(label), ['README.md:2 (content: Acme)']);
      fs.writeFileSync(path.join(dir, 'docs', 'acme-guide.md'), 'x\n');
      assert.ok(scan({ root: dir, words }).found.some(item => item.kind === 'name'), 'a file name counts');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('src/, bin/, README.md and docs/ name no provider the installed Gozar manifest lists', () => {
    const { words } = vendorWords();
    const { scanned, found } = scan({ words });
    assert.ok(scanned > 0, 'the scan read files');
    assert.deepEqual(found.map(label), [], `${found.length} residual provider names (words from the manifest: ${words.join(', ')})`);
  });
}
