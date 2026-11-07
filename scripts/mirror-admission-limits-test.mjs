#!/usr/bin/env node
// A successful refetch can still leave an incomplete mirror. Admission must stop
// after one repair attempt and tell the operator what to do, not keep fetching.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

mkdirSync(join(process.env.HOME, '.tmp'), { recursive: true });
const home = mkdtempSync(join(process.env.HOME, '.tmp', 'dalan-bridge-mirror-admission-limits-'));
const savedEnv = new Map(['PATH', 'DOT_BRIDGE_WORKSPACE_ROOT', 'DOT_BRIDGE_GITHUB_URL_OWNER_REPO']
  .map(key => [key, process.env[key]]));
try {
  // Resolve before installing the wrapper: fixture commands and the wrapper itself
  // must always invoke real Git, never recurse through PATH.
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const git = (...args) => execFileSync(realGit, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const src = join(home, 'src');
  git('init', '-q', '-b', 'main', src);
  git('-C', src, 'config', 'user.email', 't@example.com');
  git('-C', src, 'config', 'user.name', 't');
  writeFileSync(join(src, 'f.txt'), 'kept\n');
  writeFileSync(join(src, 'g.txt'), 'lost\n');
  git('-C', src, 'add', '.');
  git('-C', src, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const sha = git('-C', src, 'rev-parse', 'HEAD');
  const blob = git('-C', src, 'rev-parse', 'HEAD:g.txt');
  process.env.DOT_BRIDGE_WORKSPACE_ROOT = join(home, 'ws');
  process.env.DOT_BRIDGE_GITHUB_URL_OWNER_REPO = 'file://' + src;
  const { prepareGithubRepo, verifyFetchedCommit, mirrorPath } = await import('../src/projects.mjs');
  const mirror = mirrorPath('owner/repo');
  git('init', '-q', '--bare', mirror);
  // Both the initial fetch and its staged repair inherit this setting. The tiny
  // fixture must use loose objects; the wrapper asserts this for the repair too.
  git('-C', mirror, 'config', 'fetch.unpackLimit', '100000');
  assert.equal(prepareGithubRepo({ github_repo: 'owner/repo', base_sha: sha }), mirror);
  const loose = join(mirror, 'objects', blob.slice(0, 2), blob.slice(2));
  assert.ok(existsSync(loose), 'fixture blob must be loose before making the hole');
  unlinkSync(loose);
  assert.throws(() => verifyFetchedCommit(mirror, sha, 'base'), {
    code: 'DOT_BRIDGE_INFRASTRUCTURE', mirrorIncomplete: true,
  });

  const bin = join(home, 'bin');
  const log = join(home, 'fetch-argv.jsonl');
  const holes = join(home, 'fetch-holes.jsonl');
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(holes, '');
  // fetchMirror fetches into a private stage and then publishes its objects.
  // Remove the blob there AND in the mirror before publication. Probe through
  // the stage's alternates with real Git: a packed copy would fail, not be skipped.
  writeFileSync(join(bin, 'git'), [
    '#!/usr/bin/env node',
    "const { appendFileSync, existsSync, rmSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "const { spawnSync } = require('node:child_process');",
    'const realGit = ' + JSON.stringify(realGit) + ';',
    'const mirror = ' + JSON.stringify(mirror) + ';',
    'const blob = ' + JSON.stringify(blob) + ';',
    'const log = ' + JSON.stringify(log) + ';',
    'const holes = ' + JSON.stringify(holes) + ';',
    'const argv = process.argv.slice(2);',
    "const fetching = argv.includes('fetch');",
    "if (fetching) appendFileSync(log, JSON.stringify(argv) + '\\n');",
    "const result = spawnSync(realGit, argv, { stdio: 'inherit' });",
    'if (result.error) throw result.error;',
    'if (result.status !== 0) process.exit(result.status ?? 1);',
    'if (fetching) {',
    "  const at = argv.indexOf('-C');",
    "  if (at < 0 || !argv[at + 1]) throw new Error('fixture fetch needs a repository');",
    '  const stage = argv[at + 1];',
    "  const refetch = argv.includes('--refetch');",
    "  const object = repo => join(repo, 'objects', blob.slice(0, 2), blob.slice(2));",
    '  const restoredLoose = existsSync(object(stage));',
    "  if (refetch && !restoredLoose) throw new Error('fixture refetch did not restore a loose blob');",
    '  rmSync(object(stage), { force: true });',
    '  rmSync(object(mirror), { force: true });',
    "  const probe = spawnSync(realGit, ['-C', stage, 'cat-file', '--batch-check'], {",
    "    input: blob + '\\n', encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },",
    '  });',
    "  if (probe.error || probe.status !== 0 || probe.stdout !== blob + ' missing\\n')",
    "    throw new Error('fixture blob is still available after deletion (possibly packed)');",
    "  appendFileSync(holes, JSON.stringify({ refetch, restoredLoose }) + '\\n');",
    '}',
    '',
  ].join('\n'), { mode: 0o700 });
  process.env.PATH = bin + ':' + (savedEnv.get('PATH') || '');

  let refused;
  try { prepareGithubRepo({ github_repo: 'owner/repo', base_sha: sha }); }
  catch (error) { refused = error; }
  const lines = file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const fetches = lines(log);
  assert.equal(fetches.length, 2, 'one ordinary fetch plus exactly one repair fetch');
  assert.equal(fetches.filter(argv => argv.includes('--refetch')).length, 1, 'exactly one explicit refetch');
  assert.equal(fetches[0].includes('--refetch'), false, 'first fetch must be ordinary');
  assert.equal(fetches[1].includes('--refetch'), true, 'second fetch must be the repair');
  const removals = lines(holes);
  assert.deepEqual(removals.map(entry => entry.refetch), [false, true],
    'both successful fetches must leave a proven hole');
  assert.equal(removals[1].restoredLoose, true, 'the repair must really restore the blob before deletion');
  assert.ok(refused, 'admission must reject a mirror that remains incomplete');
  assert.equal(refused.code, 'DOT_BRIDGE_INFRASTRUCTURE');
  assert.equal(refused.mirrorIncomplete, true);
  const operator = " A refetch did not repair it. Operator: repair or recreate this repository's bridge mirror, then resubmit.";
  assert.equal(refused.message, 'base SHA ' + sha + ": the bridge's mirror is incomplete: missing blob " +
    blob + ' for g.txt under the pinned commit.' + operator);
  assert.throws(() => verifyFetchedCommit(mirror, sha, 'base'), {
    code: 'DOT_BRIDGE_INFRASTRUCTURE', mirrorIncomplete: true,
  });

  // Regression causality (not a claim that every assertion fails each mutation):
  // deleting the repair call leaves one ordinary fetch, so the count/refetch
  // assertions fail. Removing --refetch yields zero explicit refetches. Removing
  // the operator suffix fails the exact message assertion. Extra repairs violate
  // the fetch count. The code/flag checks are compatibility assertions and may
  // still pass without the repair call or suffix. These mutations are not run here.
  //
  // Shared 120-second fetch-budget coverage is deliberately omitted. The timeout
  // is hard-coded in prepareGithubRepo and no short-timeout injection is exposed.
  // A real expiration exceeds 10 seconds; a global-clock/subprocess mock would
  // need separate validation before claiming a reliable under-10-second check.
  console.log('PASS incomplete mirror gets exactly one refetch and an operator repair instruction');
} finally {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
