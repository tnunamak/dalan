#!/usr/bin/env node
// Structural evidence only. Read repository files; never import/execute the CLI,
// start a service, inspect HOME, or run the checks cited by the document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const inside = file => file.startsWith(root + path.sep);
function repoFile(relative) {
  assert.ok(relative && !path.isAbsolute(relative), 'expected repository-relative file: ' + relative);
  const candidate = path.resolve(root, relative);
  assert.ok(inside(candidate), 'file escapes repository: ' + relative);
  const real = fs.realpathSync(candidate); // Missing files fail, including broken symlinks.
  assert.ok(inside(real), 'symlink escapes repository: ' + relative);
  assert.ok(fs.statSync(real).isFile(), 'not a regular file: ' + relative);
  return real;
}
const read = relative => fs.readFileSync(repoFile(relative), 'utf8');
const doc = read('docs/operator-duties.md');
const cli = read('bin/dot-worker.mjs');
const suite = JSON.parse(read('scripts/test-segments.json'));
assert.ok(Array.isArray(suite) && suite.every(item => typeof item === 'string'), 'invalid suite manifest');
assert.equal(suite.filter(item => item === 'node scripts/operator-duties-test.mjs').length, 1,
  'register the structural check exactly once');
assert.ok(!doc.includes(String.fromCharCode(96).repeat(3)), 'procedures/code blocks belong in the linked operating manual');

const duties = [
  'Backup and restore', 'Key and token rotation', 'Upgrades and migrations',
  'Retention and deletion', 'Incident response', 'Capacity', 'Abuse handling',
  'Status and availability', 'Identity and access',
];
const sections = new Map();
let current = null;
for (const line of doc.split('\n')) {
  if (line.startsWith('## ')) {
    current = line.slice(3).trim();
    assert.ok(!sections.has(current), 'duplicate duty: ' + current);
    sections.set(current, []);
  } else if (current) sections.get(current).push(line);
}
assert.deepEqual([...sections.keys()], duties, 'unexpected or missing duty sections');

// Match the actual dispatcher blocks, not a command name mentioned anywhere in
// the file. Known forms also require their option/action evidence in that block.
const cases = [...cli.matchAll(/^\s{4}case (['"])([^'"]+)\1\s*:/gm)];
const blocks = new Map(cases.map((entry, index) => [
  entry[2], cli.slice(entry.index, cases[index + 1]?.index ?? cli.indexOf('    default:', entry.index)),
]));
const forms = new Map([
  ['dalan paths --json', ['paths', /'--json'/]],
  ['dalan status --json', ['status', /'--json'/]],
  ['dalan status --explain', ['status', /'--explain'/]],
  ['dalan doctor --json', ['doctor', /\bresult=json\?/]],
  ['dalan worker list NAME --json', ['worker', /action==='list'/]],
  ['dalan claims --json', ['claims', /'--json'/]],
  ['dalan as-rotate-keys', ['as-rotate-keys', /\brotateKeys\(/]],
]);
assert.match(cli, /\bjson\s*=\s*args\.includes\('--json'\)/, 'global --json parsing is missing');

const codeSpans = text => [...text.matchAll(/\x60([^\x60\n]+)\x60/g)].map(match => match[1]);
function checkCommand(command) {
  if (command.startsWith('dalan ')) {
    const spec = forms.get(command);
    assert.ok(spec, 'unrecognized CLI form; verify and register it: ' + command);
    const [name, evidence] = spec;
    assert.ok(blocks.has(name), 'CLI case is missing: ' + name);
    assert.match(blocks.get(name), evidence, 'CLI form lacks implementation evidence: ' + command);
    if (command === 'dalan worker list NAME --json') {
      assert.match(blocks.get(name), /'--json'/, 'worker list lacks --json handling');
    }
    return true;
  }
  if (command.startsWith('node ')) {
    const match = /^node (?:--test )?(scripts\/[A-Za-z0-9_./-]+\.mjs)$/.exec(command);
    assert.ok(match, 'unsupported test command: ' + command);
    repoFile(match[1]);
    assert.ok(suite.includes(command), 'test command is not registered: ' + command);
    return true;
  }
  return false;
}
for (const [duty, lines] of sections) {
  for (const label of ['Duty', 'Check', 'Gap', 'Source']) {
    const found = lines.filter(line => line.startsWith('- **' + label + ':**'));
    assert.equal(found.length, 1, duty + ': expected one ' + label + ' line');
    assert.ok(found[0].slice(found[0].indexOf(':**') + 3).trim(), duty + ': empty ' + label);
  }
  const check = lines.find(line => line.startsWith('- **Check:**'));
  const commands = codeSpans(check);
  assert.ok(commands.length > 0, duty + ': no real command or registered test');
  for (const command of commands) assert.ok(checkCommand(command), duty + ': unrecognized check: ' + command);
  const source = lines.find(line => line.startsWith('- **Source:**'));
  assert.match(source, /\]\([^)]+\)/, duty + ': missing source link');
}
for (const code of codeSpans(doc)) {
  checkCommand(code);
  // Also validate bare repository-file citations, not only runnable commands.
  if (/^(?:docs|src|bin|scripts)\//.test(code)) {
    repoFile(code);
    if (/^scripts\/.*\.mjs$/.test(code)) {
      assert.ok(suite.some(segment => segment.split(/\s+/).includes(code)),
        'cited script is not registered: ' + code);
    }
  }
}

const slug = heading => heading.trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const targets = [...doc.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]);
assert.ok(targets.includes('operations.md'), 'link to the operations manual');
assert.ok(targets.includes('dalan-upgrade.md'), 'link to the Dalan upgrade guide');
for (const target of targets) {
  assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//'),
    'source must be a repository file: ' + target);
  const [file, anchor, extra] = target.split('#');
  assert.equal(extra, undefined, 'invalid source link: ' + target);
  const relative = file ? path.posix.join('docs', file) : 'docs/operator-duties.md';
  const content = read(relative);
  if (anchor) {
    // Match GitHub's duplicate-heading suffixes for the local Markdown sources.
    const used = new Set();
    const headings = content.split('\n').filter(line => /^#{1,6} /.test(line)).map(line => {
      const base = slug(line.replace(/^#+\s*/, ''));
      let id = base, suffix = 0;
      while (used.has(id)) id = base + '-' + (++suffix);
      used.add(id);
      return id;
    });
    assert.ok(headings.includes(anchor), 'broken source anchor: ' + target);
  }
}
console.log('PASS operator duties: ' + duties.length + ' duties; files, links, CLI forms and suite checks resolve (structural only)');
