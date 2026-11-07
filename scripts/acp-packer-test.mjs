#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAssignment, withoutNote, NO_REPO_NOTE, repoInputs, sha256 } from '../src/acp-bridge.mjs';
import { validateSubmission, submissionLimits, outputPathsHeading } from '../src/submission-policy.mjs';
import { withoutBridgeSuffix } from '../src/acp-context.mjs';
// The bridge's output_paths block is a known suffix: the attach guard still recovers the requester's brief.
assert.equal(withoutBridgeSuffix(`Brief text\n\n${outputPathsHeading}\nnotes/a.md\nnotes/b.md`),'Brief text');

const root = fs.mkdtempSync(join(tmpdir(), 'acp-packer-')), originalHome = process.env.HOME;
process.env.HOME = join(root, 'home');
fs.mkdirSync(process.env.HOME);
const bare = join(root, 'origin.git'), work = join(root, 'work');
const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', '-C', work, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);return r.stdout.trim();
};
const write = (file, text) => { fs.mkdirSync(join(work, file, '..'), { recursive: true });fs.writeFileSync(join(work, file), text); };
const options = { repoOf: () => 'acme/packer' }; // GitHub identification alone is injected; all Git/policy work is real.
const request = { cwd: work, requestId: 'packer_test_1', brief: 'Review the local changes.', validUntil: '2099-01-01T00:00:00Z' };
const pack = async (extra = {}) => prepareAssignment({ ...request, ...extra }, options);
const extractDiff = brief => {
  const m = /\n(`{3,})diff\n/.exec(brief);assert.ok(m, `fenced diff: ${brief}`);
  return brief.slice(m.index + m[0].length, brief.indexOf(`\n${m[1]}\n`, m.index + m[0].length) + 1);
};
const scan = base => ({
  files: git('ls-tree', '-r', '--name-only', base).split('\n').filter(Boolean), diff: '', diffFiles: [], symlinks: [],
});
const admitted = assignment => validateSubmission(assignment, { excludeSensitive: true, scanInput: input => scan(input.base_sha) });
function pass(label) { console.log(`PASS packer: ${label}`); }

try {
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  write('a.txt', 'base\n');write('remove.txt', 'delete me\n');
  git('add', '.');git('commit', '-qm', 'base');git('remote', 'add', 'origin', bare);git('push', '-qu', 'origin', 'main');
  const base = git('rev-parse', 'HEAD');
  const clean = await pack();
  assert.deepEqual(clean.inputs, [{ github_repo: 'acme/packer', base_sha: base, head_sha: base }]);
  assert.equal(clean.brief, request.brief);assert.equal(clean.execution_scope, 'read-only');
  assert.equal(admitted(clean), clean);pass('clean pushed checkout is unchanged');

  write('a.txt', 'committed\n');git('commit', '-qam', 'local commit');
  write('a.txt', 'staged\n');git('add', 'a.txt');write('a.txt', 'final worktree\n');
  write('new.txt', 'untracked text\n```\n');fs.unlinkSync(join(work, 'remove.txt'));
  const indexBefore = git('diff', '--cached');
  const packed = await pack(), diff = extractDiff(packed.brief);
  assert.equal(packed.inputs[0].base_sha, base);assert.equal(packed.inputs[0].head_sha, base);
  assert.match(diff, /-base\n\+final worktree/);assert.match(diff, /\+untracked text/);assert.match(diff, /deleted file mode/);
  assert.match(packed.brief, /checkout is at pushed base/);assert.match(packed.brief, /````diff/);
  assert.equal(git('diff', '--cached'), indexBefore, 'index was not changed');
  assert.equal(withoutNote(packed.brief), request.brief);admitted(packed);
  const check = spawnSync('git', ['-C', bare, 'apply', '--numstat', '-'], { input: diff, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);pass('committed, staged, unstaged, deleted and untracked text form a complete diff without index mutation');

  // Recreate the requester's final text state from the pushed base with the actual patch, rather than trusting strings.
  const checkout = join(root, 'apply');git('worktree', 'add', '--detach', checkout, base);
  const apply = spawnSync('git', ['-C', checkout, 'apply', '-'], { input: diff, encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr);
  for (const file of ['a.txt', 'new.txt']) assert.deepEqual(fs.readFileSync(join(checkout, file)), fs.readFileSync(join(work, file)));
  assert.ok(!fs.existsSync(join(checkout, 'remove.txt')));git('worktree', 'remove', '--force', checkout);
  pass('packed patch applies to the pinned base and recreates requester text');

  write('.env.production', 'DO_NOT_INLINE_ENV\n');write('release.key', 'DO_NOT_INLINE_KEY\n');
  write('auth-helper.mjs', 'export const helper = 1; // AUTH_HELPER_CODE\n');write('safe.txt', `ghp_${'X'.repeat(30)}\n`);
  write('signing/release.sh', 'DO_NOT_INLINE_SIGNING\n');
  write('image.bin', Buffer.from([0, 255, 1, 2]));write('untracked.bin', Buffer.from([0, 255, 3]));
  git('add', '.env.production', 'release.key', 'auth-helper.mjs', 'image.bin');
  fs.symlinkSync('/outside/requester', join(work, 'link.txt'));
  const safe = await pack();
  for (const file of ['.env.production', 'release.key', 'safe.txt', 'signing/release.sh']) assert.ok(safe.brief.includes(`omitted: ${file} (sensitive)`), file);
  // a code file named for what it handles is not sensitive by name: it is packed
  assert.ok(!safe.brief.includes('omitted: auth-helper.mjs') && safe.brief.includes('AUTH_HELPER_CODE'), 'auth-helper.mjs omitted');
  assert.match(safe.brief, /omitted: image.bin \(binary\)/);assert.match(safe.brief, /omitted: untracked.bin \(binary\)/);assert.match(safe.brief, /omitted: link.txt \(symlink\)/);
  assert.doesNotMatch(safe.brief, /DO_NOT_INLINE|ghp_X|outside\/requester/);assert.match(safe.brief, /\+final worktree/);admitted(safe);
  await assert.rejects(pack({ brief: 'Read .env.production for this review.' }), /hard sensitive path/);
  assert.throws(() => admitted({ ...safe, brief: safe.brief + '\nRead .env.production.' }), /hard sensitive path/);
  assert.throws(() => admitted({ ...safe, scope_paths: ['.env.production'] }), /hard sensitive path/);
  pass('sensitive paths/content, binary and symlink data are omitted; an unsafe requester brief is still refused');

  fs.mkdirSync(join(process.env.HOME, '.config/dot-bridge'), { recursive: true });
  const policy = join(process.env.HOME, '.config/dot-bridge/submission-policy.json');
  fs.writeFileSync(policy, JSON.stringify({ version: 1, sensitive_paths: ['custom.txt'], exceptions: [] }), { mode: 0o600 });
  write('custom.txt', 'CUSTOM_DO_NOT_INLINE');
  const custom = await pack();assert.match(custom.brief, /omitted: custom.txt \(sensitive\)/);assert.doesNotMatch(custom.brief, /CUSTOM_DO_NOT_INLINE/);admitted(custom);
  pass('host policy sensitive_paths use the same exclusion rules');

  const again = await pack();write('new.txt', 'different context\n');const changed = await pack();
  assert.notEqual(changed.brief, again.brief);
  assert.equal(sha256(withoutNote(again.brief)), sha256(withoutNote(changed.brief)));
  assert.notEqual(sha256(withoutNote((await pack({ brief: 'Another request.' })).brief)), sha256(request.brief));
  assert.notEqual(withoutNote(changed.brief + '\nforged trailing instructions'), request.brief);
  pass('attach identity depends only on requester text and rejects arbitrary trailing instructions');

  write('huge.txt', 'é'.repeat(10000));const huge = await pack();
  assert.deepEqual(huge.inputs, []);assert.ok(huge.brief.startsWith(NO_REPO_NOTE));
  assert.match(huge.brief, /changed: huge.txt/);assert.match(huge.brief, /changed: a.txt/);assert.match(huge.brief, /omitted: \.env.production \(sensitive\)/);
  assert.doesNotMatch(huge.brief, /```diff|é/);assert.equal(withoutNote(huge.brief), request.brief);validateSubmission(huge);
  pass('oversize UTF-8 diff falls back to text-only with changed file names and stable identity');
  fs.unlinkSync(join(work, 'huge.txt'));
  const near = await pack({ brief: 'é'.repeat(7800) });assert.deepEqual(near.inputs, []);validateSubmission(near);
  assert.ok(Buffer.byteLength(near.brief) <= submissionLimits.brief);
  await assert.rejects(pack({ brief: 'é'.repeat(8200) }), /brief is [\d,]+ bytes: .*the limit is 16,384; cut at least [\d,]+ bytes/);
  pass('the original brief, context framing and fallback share the 16 KiB byte limit');

  // Many individually safe file names can make the fallback too large; report the remainder, never truncate a name.
  for (let i = 0; i < 200; i++) write(`many/${String(i).padStart(3, '0')}-${'x'.repeat(90)}.txt`, 'text\n');
  const many = await pack();assert.deepEqual(many.inputs, []);assert.match(many.brief, /more changed file names exceed/);validateSubmission(many);
  pass('a large changed-file list also respects the brief cap');
  git('clean', '-fdq');git('reset', '--hard', 'HEAD');

  // Scope narrowing can use much more instruction space than the single directory scope submitted by the adapter.
  write('.env.base', 'BASE_ENV_DO_NOT_INLINE\n');
  for (let i = 0; i < 180; i++) {
    const dir = `wide/${String(i).padStart(3, '0')}-${'d'.repeat(90)}`;
    write(`${dir}/file.txt`, 'base text\n');write(`${dir}/.env`, 'BASE_ENV_DO_NOT_INLINE\n');
  }
  git('add', '.');git('commit', '-qm', 'wide pushed tree');git('push', '-q', 'origin', 'main');
  write('a.txt', 'wide local edit\n');
  const short = await pack(), narrowed = admitted(short);
  assert.ok(narrowed.scope_paths.length > 170);assert.match(narrowed.brief, /Bridge scope note:/);
  assert.equal(withoutNote(narrowed.brief), request.brief);
  assert.throws(() => admitted({ ...short, brief: short.brief + 'x'.repeat(6000) }), /task instructions: .*UTF-8 bytes exceeds/);
  const instructionCap = await pack({ brief: 'x'.repeat(6000) });
  assert.deepEqual(instructionCap.inputs, []);validateSubmission(instructionCap);
  pass('scope narrowing and its appended note count toward the 24 KiB cap; stored packing still strips to requester text');
  git('reset', '--hard', 'HEAD');

  git('rm', 'a.txt');write('a.txt', 'recreated as untracked\n');
  const recreated = await pack(), recreatedDiff = extractDiff(recreated.brief);
  const recreatedCheckout = join(root, 'recreated');git('worktree', 'add', '--detach', recreatedCheckout, 'HEAD');
  const recreatedApply = spawnSync('git', ['-C', recreatedCheckout, 'apply', '-'], { input: recreatedDiff, encoding: 'utf8' });
  assert.equal(recreatedApply.status, 0, recreatedApply.stderr);
  assert.deepEqual(fs.readFileSync(join(recreatedCheckout, 'a.txt')), fs.readFileSync(join(work, 'a.txt')));
  git('worktree', 'remove', '--force', recreatedCheckout);git('reset', '--hard', 'HEAD');
  pass('a staged deletion recreated as an untracked file reconstructs the requester state');

  // A newer pushed side-branch ancestor wins over an older main ref. An unrelated remote must not qualify.
  git('update-ref', 'refs/remotes/origin/side', 'HEAD');const newest = git('rev-parse', 'HEAD');
  write('a.txt', 'ahead again\n');git('commit', '-qam', 'ahead again');
  assert.equal((await pack()).inputs[0].base_sha, newest);
  git('update-ref', 'refs/remotes/elsewhere/main', 'HEAD');
  assert.equal((await pack()).inputs[0].base_sha, newest);pass('newest pushed ancestor is selected across origin branches, excluding unrelated remotes');

  git('update-ref', '-d', 'refs/remotes/origin/main');git('update-ref', '-d', 'refs/remotes/origin/side');
  const unavailable = await pack();assert.deepEqual(unavailable.inputs, []);assert.ok(unavailable.brief.startsWith(NO_REPO_NOTE));
  assert.deepEqual((await repoInputs(work)).inputs, []);pass('no origin ancestor and a non-GitHub origin retain the text-only fallback');
} finally {
  if (originalHome === undefined) delete process.env.HOME;else process.env.HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
}
