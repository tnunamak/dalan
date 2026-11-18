#!/usr/bin/env node
// The public scan keeps only generic rules in the repository and reads private names from an untracked deny list.
// It must read inside tracked .tgz archives, including members with names longer than 100 bytes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GENERIC_RULES, loadRules, parseDenylist, scanText, scanUnits } from './public-scan.mjs';

const script = fileURLToPath(new URL('./public-scan.mjs', import.meta.url));
// Synthetic private names: a test must not publish the real deny list.
const DENYLIST = '# synthetic\n\nowner-host /private-host\\.example/gi\nprivate-tool /secret_tool_name/gi\n';

function hitsIn(file, buffer, rules) {
  return scanUnits(file, buffer).flatMap(([name, body]) => scanText(name, body.toString('utf8'), rules));
}

function withDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'public-scan-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a hit inside a .tgz member is found and named archive!member', () => withDir(dir => {
  const longDir = 'a'.repeat(60) + '/' + 'b'.repeat(60);
  mkdirSync(path.join(dir, 'src', longDir), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'short.txt'), 'clean line\nhost private-host.example here\n');
  writeFileSync(path.join(dir, 'src', longDir, 'long.txt'), 'see secret_tool_name\n');
  const archive = path.join(dir, 'fixture.tgz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'src']);
  const hits = hitsIn('fixtures/fixture.tgz', readFileSync(archive), [...GENERIC_RULES, ...parseDenylist(DENYLIST)]);
  assert.deepEqual(
    hits.map(h => `${h.file}:${h.line}:${h.rule}`).sort(),
    [
      `fixtures/fixture.tgz!src/${longDir}/long.txt:1:private-tool`,
      'fixtures/fixture.tgz!src/short.txt:2:owner-host',
    ],
  );
}));

test('a plain file is scanned as itself', () => {
  assert.deepEqual(scanUnits('README.md', Buffer.from('x')).map(([name]) => name), ['README.md']);
});

test('the deny list format: one RULE-ID /REGEX/FLAGS per line; comments and blank lines ignored', () => {
  assert.deepEqual(parseDenylist(DENYLIST).map(r => [r.id, r.re.source, r.re.flags]), [
    ['owner-host', 'private-host\\.example', 'gi'],
    ['private-tool', 'secret_tool_name', 'gi'],
  ]);
  assert.throws(() => parseDenylist('owner-host private-host'), /line 1/);
  assert.throws(() => parseDenylist('owner-host /(/g'), /line 1/);
});

test('without DALAN_PUBLIC_SCAN_DENYLIST only the generic rules run', () => {
  assert.deepEqual(loadRules({}), { rules: GENERIC_RULES, denylist: null });
  assert.deepEqual(scanText('a.md', 'private-host.example', loadRules({}).rules), []);
});

test('a configured deny list that is missing, unreadable or empty fails closed', () => withDir(dir => {
  assert.throws(() => loadRules({ DALAN_PUBLIC_SCAN_DENYLIST: path.join(dir, 'missing.txt') }), /cannot read/);
  writeFileSync(path.join(dir, 'empty.txt'), '# only a comment\n');
  assert.throws(() => loadRules({ DALAN_PUBLIC_SCAN_DENYLIST: path.join(dir, 'empty.txt') }), /no rules/);
  writeFileSync(path.join(dir, 'list.txt'), DENYLIST);
  const { rules, denylist } = loadRules({ DALAN_PUBLIC_SCAN_DENYLIST: path.join(dir, 'list.txt') });
  assert.equal(denylist, path.join(dir, 'list.txt'));
  assert.deepEqual(rules.map(r => r.id), [...GENERIC_RULES.map(r => r.id), 'owner-host', 'private-tool']);
}));

test('the scan command: private hits fail only with the deny list; inactive allow-list entries are not stale', () => withDir(dir => {
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  writeFileSync(path.join(repo, 'notes.md'), 'deploy to private-host.example\n');
  writeFileSync(path.join(repo, 'scripts/public-scan-allowlist.json'), JSON.stringify([
    { rule: 'person', token: '^Example$', reason: 'Only active with a deny list that has a person rule.' },
  ]));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', 'notes.md', 'scripts/public-scan-allowlist.json']);
  writeFileSync(path.join(dir, 'list.txt'), DENYLIST);
  const run = env => spawnSync(process.execPath, [script, '--root', repo], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

  const generic = run({});
  assert.equal(generic.status, 0, generic.stdout + generic.stderr);
  assert.match(generic.stdout, /private deny list: not configured/);

  const listed = run({ DALAN_PUBLIC_SCAN_DENYLIST: path.join(dir, 'list.txt') });
  assert.equal(listed.status, 1, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /notes\.md:1: \[owner-host\] private-host\.example/);
  assert.doesNotMatch(listed.stdout, /stale allow-list entry/);

  const missing = run({ DALAN_PUBLIC_SCAN_DENYLIST: path.join(dir, 'missing.txt') });
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /cannot read/);
}));


test('two public upstream documentation exceptions are narrow and become stale', () => withDir(dir => {
  const archiveName = 'vendor/tnunamak-gozar-0.5.0.tgz';
  const design = 'package/docs/design/durable-routes.md';
  const coverage = 'package/docs/release-0.4-interface-coverage.md';
  const designLine = '- macOS host (plan R12) and ngrok operational recipes (slice S1). Durable routes are designed for them but ship first for Tailscale on Linux.';
  const coverageLine = "HTTP(S)-only executable admission is Lead's 0.4 decision to ship the embedding";
  const production = JSON.parse(readFileSync(new URL('./public-scan-allowlist.json', import.meta.url), 'utf8'));
  const paths = [
    '^vendor/tnunamak-gozar-0[.]5[.]0[.]tgz!package/docs/design/durable-routes[.]md$',
    '^vendor/tnunamak-gozar-0[.]5[.]0[.]tgz!package/docs/release-0[.]4-interface-coverage[.]md$',
  ];
  const entries = production.filter(entry => paths.includes(entry.path));
  assert.equal(entries.length, 2, 'use exactly the two production exceptions, not a test-only policy');
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  mkdirSync(path.join(repo, 'vendor'), { recursive: true });
  writeFileSync(path.join(repo, 'scripts/public-scan-allowlist.json'), JSON.stringify(entries));
  execFileSync('git', ['init', '-q', repo]);
  const source = path.join(dir, 'source');
  function pack(lines, target = archiveName) {
    rmSync(source, { recursive: true, force: true });
    for (const [member, text] of Object.entries(lines)) {
      mkdirSync(path.dirname(path.join(source, member)), { recursive: true });
      writeFileSync(path.join(source, member), text + '\n');
    }
    execFileSync('tar', ['-czf', path.join(repo, target), '-C', source, 'package']);
  }
  const baseline = { [design]: designLine, [coverage]: coverageLine };
  pack(baseline);
  execFileSync('git', ['-C', repo, 'add', '.']);
  const run = env => spawnSync(process.execPath, [script, '--root', repo], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
  });
  const good = run({});
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /0 unexplained, 2 allow-listed hits under 2 entries, 0 stale entries/);

  // Keep both exact originals present in each negative probe, so the failure
  // must be unexplained content rather than a missing exception's stale count.
  function rejected(label, expected, env = {}) {
    const result = run(env);
    assert.equal(result.status, 1, label + '\n' + result.stdout + result.stderr);
    assert.match(result.stdout, expected);
    assert.match(result.stdout, /0 stale entries/);
  }
  writeFileSync(path.join(repo, 'owned.md'), designLine + '\n' + coverageLine);
  execFileSync('git', ['-C', repo, 'add', 'owned.md']);
  rejected('owned file', /2 unexplained/);
  writeFileSync(path.join(repo, 'owned.md'), 'clean\n');

  pack(baseline, 'vendor/other.tgz');
  execFileSync('git', ['-C', repo, 'add', 'vendor/other.tgz']);
  rejected('other archive', /2 unexplained/);
  pack({ 'package/clean.md': 'clean' }, 'vendor/other.tgz');

  pack({ ...baseline, 'package/docs/another.md': designLine + '\n' + coverageLine });
  rejected('other member', /2 unexplained/);
  pack({ [design]: designLine + '\nA new S1 line.', [coverage]: coverageLine + "\nA new Lead's line." });
  rejected('new lines in permitted members', /2 unexplained/);
  pack({ [design]: designLine + '\n' + designLine.replace('S1', 'S2'), [coverage]: coverageLine });
  rejected('changed job code in otherwise identical sentence', /1 unexplained/);

  pack({ [design]: designLine + ' private-host.example', [coverage]: coverageLine + ' secret_tool_name' });
  writeFileSync(path.join(dir, 'private.txt'), DENYLIST);
  rejected('private denylist is never bypassed', /2 unexplained/, { DALAN_PUBLIC_SCAN_DENYLIST: path.join(dir, 'private.txt') });

  for (const missing of [design, coverage]) {
    pack({ ...baseline, [missing]: 'public text changed' });
    const stale = run({});
    assert.equal(stale.status, 1, stale.stdout + stale.stderr);
    assert.match(stale.stdout, /0 unexplained, 1 allow-listed hits under 2 entries, 1 stale entries/);
    assert.match(stale.stdout, /stale allow-list entry/);
  }
}));
