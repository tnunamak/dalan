// What `npm publish` would ship. The package must carry everything its commands load and nothing that is only for
// tests, local state or build leftovers. This reads `npm pack --dry-run`; it publishes nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

const repo = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
const files = new Set(entry.files.map(file => file.path));

function markdownDestinations(source) {
  const destinations = [];
  const visit = tokens => {
    for (const token of tokens ?? []) {
      if (token.type === 'link' || token.type === 'image') destinations.push(token.href);
      if (token.type === 'html') {
        for (const match of token.text.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) destinations.push(match.slice(1).find(Boolean));
      }
      visit(token.tokens);
    }
  };
  visit(marked.lexer(source));
  return destinations;
}

// GitHub heading anchors: plain text lowercased, punctuation dropped, spaces to hyphens, repeats suffixed -1, -2, ...
const plainText = tokens => (tokens ?? []).map(token => token.tokens ? plainText(token.tokens) : (token.type === 'html' ? '' : token.text ?? token.raw ?? '')).join('');
function headingAnchors(source) {
  const seen = new Map();
  const anchors = new Set();
  const visit = tokens => {
    for (const token of tokens ?? []) {
      if (token.type === 'heading') {
        const base = plainText(token.tokens).toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        anchors.add(count ? `${base}-${count}` : base);
      }
      if (token.type === 'html') for (const match of token.text.matchAll(/\b(?:id|name)\s*=\s*"([^"]+)"/gi)) anchors.add(match[1]);
      if (token.items) visit(token.items);
      visit(token.tokens);
    }
  };
  visit(marked.lexer(source));
  return anchors;
}

function packedMarkdownLinks() {
  const missing = [];
  const markdownFiles = [...files].filter(file => /\.md$/i.test(file));
  assert.ok(markdownFiles.length > 0, 'the packed file list contains Markdown files to scan');
  const anchorCache = new Map();
  const anchorsOf = file => {
    if (!anchorCache.has(file)) anchorCache.set(file, headingAnchors(fs.readFileSync(path.join(repo, file), 'utf8')));
    return anchorCache.get(file);
  };
  for (const file of markdownFiles) {
    const source = fs.readFileSync(path.join(repo, file), 'utf8');
    for (const destination of markdownDestinations(source)) {
      if (destination?.startsWith('#')) {
        let fragment;
        try { fragment = decodeURIComponent(destination.slice(1)).toLowerCase(); } catch { fragment = destination.slice(1); }
        if (fragment && fragment !== 'top' && !anchorsOf(file).has(fragment)) missing.push(`${file} links to missing heading ${destination}`);
        continue;
      }
      if (!destination || destination.startsWith('/') || destination.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(destination)) continue;
      const pathname = destination.split(/[?#]/, 1)[0];
      let decoded;
      try { decoded = decodeURIComponent(pathname); }
      catch { missing.push(`${file} links malformed URL ${destination}`); continue; }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded));
      if (target === '..' || target.startsWith('../')) missing.push(`${file} links outside the package with ${destination}`);
      else if (!files.has(target)) missing.push(`${file} links to unpacked ${target} (${destination})`);
      else if (/\.md$/i.test(target) && destination.includes('#')) {
        let fragment = destination.slice(destination.indexOf('#') + 1);
        try { fragment = decodeURIComponent(fragment); } catch { /* compare the raw text */ }
        if (fragment && !anchorsOf(target).has(fragment.toLowerCase())) missing.push(`${file} links to missing heading ${destination} in ${target}`);
      }
    }
  }
  return missing;
}

test('the package names the commands it installs', () => {
  assert.notEqual(pkg.private, true, 'the package can be published');
  assert.equal(pkg.name, '@tnunamak/dalan');
  assert.ok(Array.isArray(pkg.files) && pkg.files.length, 'an allow-list, not "everything not ignored"');
  assert.equal(pkg.bin.dalan, 'bin/dalan.mjs');
  for (const target of Object.values(pkg.bin)) assert.ok(files.has(target), `${target} ships`);
  for (const required of ['README.md', 'LICENSE', 'package.json', 'src/try.mjs', 'src/demo-worker.mjs', 'src/server.mjs', 'CONTRIBUTING.md']) assert.ok(files.has(required), `${required} ships`);
});

test('the scripts that the installed-package setup, upgrade and removal documentation runs ship', () => {
  for (const script of ['scripts/worker-bridge-setup.mjs', 'scripts/upgrade-drain.mjs']) assert.ok(files.has(script), `${script} ships`);
  for (const doc of ['docs/service-setup.md', 'docs/dalan-upgrade.md', 'docs/operations.md']) {
    const source = fs.readFileSync(path.join(repo, doc), 'utf8');
    for (const [, script] of source.matchAll(/(?:\$\(npm root -g\)\/@tnunamak\/dalan\/|\bnode )(scripts\/(?:worker-bridge-setup|upgrade-drain)\.mjs)/g)) assert.ok(files.has(script), `${doc} runs ${script}`);
  }
});

test('no tests, fixtures, local state or build leftovers ship', () => {
  const leaks = [...files].filter(file => /(^|\/)(test|tests|test-fixtures|test-support|fixtures|__pycache__|node_modules|\.git[^/]*|\.env[^/]*|\.config|\.local)(\/|$)|-test\.mjs$|-e2e\.mjs$|\.pyc$|\.log$|\.sock$|\.tgz$/.test(file));
  assert.deepEqual(leaks, []);
});

test('every relative import of a shipped module resolves to a shipped file', () => {
  const missing = [];
  for (const file of files) {
    if (!file.endsWith('.mjs')) continue;
    const source = fs.readFileSync(path.join(repo, file), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!files.has(target)) missing.push(`${file} imports ${specifier}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every relative link in shipped Markdown targets a packed file', () => {
  assert.deepEqual(packedMarkdownLinks(), []);
});
