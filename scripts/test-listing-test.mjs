// Every test file must run in the suite: it is listed in scripts/test-segments.json (directly or by a *.ext glob),
// or it is named below with the reason it is left out.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const NOT_IN_SUITE = {
  // 'scripts/example-test.mjs': 'reason it does not run in the suite',
};
const isTest = file => /(-test|\.test|-e2e)\.mjs$/.test(file);
const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? (['node_modules', '__pycache__'].includes(entry.name) ? [] : walk(path.join(dir, entry.name))) : [path.join(dir, entry.name)]);

const listed = new Set();
for (const segment of JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-segments.json'), 'utf8'))) {
  for (const word of segment.split(/\s+/)) {
    if (!/\.mjs$/.test(word)) continue;
    if (!word.includes('*')) { listed.add(path.normalize(word)); continue; }
    const dir = path.dirname(word), pattern = new RegExp(`^${path.basename(word).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`);
    for (const name of fs.readdirSync(path.join(root, dir))) if (pattern.test(name)) listed.add(path.join(dir, name));
  }
}

const tests = ['scripts', 'packages', 'integrations', 'src'].filter(dir => fs.existsSync(path.join(root, dir))).flatMap(walk).filter(isTest);
const missing = tests.filter(file => !listed.has(file) && !(file in NOT_IN_SUITE));
assert.deepEqual(missing, [], 'test files that never run: add each to scripts/test-segments.json, or to NOT_IN_SUITE with a reason');
for (const [file, reason] of Object.entries(NOT_IN_SUITE)) {
  assert.ok(tests.includes(file), `NOT_IN_SUITE names a file that does not exist: ${file}`);
  assert.ok(reason.trim(), `NOT_IN_SUITE needs a reason for ${file}`);
}
console.log(`PASS every one of ${tests.length} test files runs in the suite`);
