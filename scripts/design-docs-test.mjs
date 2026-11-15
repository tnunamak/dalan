import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const design = resolve(root, 'docs/design');
const required = ['identities.md', 'authority-matrix.md', 'failure-table.md', 'reuse-ledger.md'];
const errors = [];
const documents = new Map();
const fail = message => errors.push(message);
const insideRoot = path => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};
let names = [];
try { names = readdirSync(design).filter(name => name.endsWith('.md')).sort(); }
catch (error) { fail('Cannot read docs/design: ' + error.message); }
for (const name of names) {
  try {
    const path = realpathSync(resolve(design, name));
    if (!insideRoot(path)) throw new Error('document escapes repository root');
    documents.set(name, readFileSync(path, 'utf8'));
  } catch (error) { fail(name + ': ' + error.message); }
}
for (const name of required) {
  if (!documents.has(name)) fail('Missing required document: ' + name);
}
let citations = 0;
for (const [name, text] of documents) {
  // Every inline backtick span containing # is a path#symbol citation.
  for (const match of text.matchAll(/\x60([^\x60\r\n]*#[^\x60\r\n]*)\x60/g)) {
    citations++;
    const citation = match[1];
    const at = citation.indexOf('#');
    const path = citation.slice(0, at);
    const symbol = citation.slice(at + 1);
    const label = name + ': bad citation ' + JSON.stringify(citation);
    if (!path || !symbol || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      fail(label + ': require repository-relative path and nonempty symbol');
      continue;
    }
    try {
      const target = realpathSync(resolve(root, path));
      if (!insideRoot(target)) throw new Error('target escapes repository root');
      if (!statSync(target).isFile()) throw new Error('target is not a file');
      if (!readFileSync(target, 'utf8').includes(symbol)) {
        fail(label + ': symbol text absent');
      }
    } catch (error) { fail(label + ': ' + error.message); }
  }
  for (const match of text.matchAll(/\x60([^\x60\r\n]+\.[a-zA-Z0-9]+:\d+(?:-\d+)?)\x60/g)) {
    fail(name + ': line-number citation ' + JSON.stringify(match[1]) + '; use path#symbol');
  }
}
const failureText = documents.get('failure-table.md') ?? '';
const failureCounts = new Map();
for (const line of failureText.split(/\r?\n/)) {
  const match = /^\s*\|\s*(F\d+)\s*\|/.exec(line);
  if (match) failureCounts.set(match[1], (failureCounts.get(match[1]) ?? 0) + 1);
}
const expectedFailures = Array.from({ length: 36 }, (_, i) => 'F' + String(i + 1).padStart(2, '0'));
for (const id of expectedFailures) {
  const count = failureCounts.get(id) ?? 0;
  if (count !== 1) fail('failure-table.md: expected exactly one row for ' + id + ', found ' + count);
}
for (const id of failureCounts.keys()) {
  if (!expectedFailures.includes(id)) fail('failure-table.md: unexpected failure row ' + id);
}
const requiredText = required.map(name => documents.get(name) ?? '').join('\n');
for (let i = 1; i <= 38; i++) {
  const id = 'R' + String(i).padStart(2, '0');
  if (!new RegExp('\\b' + id + '\\b').test(requiredText)) {
    fail('Missing requirement ' + id + ' in the four closure documents');
  }
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log('design docs: ' + citations + ' citations valid; F01-F36 each once; R01-R38 present');
}
