import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const forbidden = new RegExp(['T' + '3', 'Chat' + 'GPT', 'Doc' + 'ker', 'Git' + 'Hub',
  'Open' + 'AI', 'Anth' + 'ropic', 'Gem' + 'ini', 'Co' + 'here', 'Mist' + 'ral',
  'Meta' + ' AI', 'M' + 'CP', '/ho' + 'me/', '/Us' + 'ers/',
  '\\b(?:192\\.168|10\\.\\d+|172\\.(?:1[6-9]|2\\d|3[01]))\\.'].join('|'), 'i');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink forbidden: ${file}`);
    return entry.isDirectory() ? walk(file) : [file];
  }))).flat();
}

test('package has no product dependencies or private identifiers', async () => {
  for (const file of await walk(root)) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, forbidden, file);
    if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue;
    assert.doesNotMatch(source, new RegExp('\\b' + 'import\\s*\\('), `${file}: dynamic imports are forbidden`);
    assert.doesNotMatch(source, new RegExp('\\b' + 'require\\s*\\('), `${file}: require is forbidden`);
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\bimport\s*|\brequire\s*\()\s*['"]([^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `${file}: ${specifier}`);
      const resolved = await realpath(path.resolve(path.dirname(file), specifier));
      assert.ok(resolved.startsWith(root + path.sep), `${file}: ${specifier}`);
      assert.ok(!resolved.split(path.sep).includes('node_modules'), `${file}: ${specifier}`);
    }
  }
});
