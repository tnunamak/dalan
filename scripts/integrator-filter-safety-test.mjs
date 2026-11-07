#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { verifySealedResult } from '../src/integrator.mjs';
await import('./require-integrator-host-budget.mjs');

const scratch = path.join(os.homedir(), '.tmp', 'dalan-integrator');
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
const fixture = fs.mkdtempSync(path.join(scratch, 'integrator-filter-safety-'));
const repo = path.join(fixture, 'repo');
fs.mkdirSync(repo);
const outsideMarker = path.join(fixture, 'outside-checkout.marker');
const filterScript = path.join(fixture, 'write-marker-filter.sh');
fs.writeFileSync(filterScript, `#!/bin/sh\nprintf marker > '${outsideMarker}'\ncat\n`, { mode: 0o700 });
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=filter test', '-c', 'user.email=filter@example.invalid', ...args], { encoding: 'utf8' }).trim();
const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

git('init', '--quiet', '-b', 'main');
git('config', 'filter.outside.smudge', filterScript);
write('.gitattributes', '*.txt filter=outside\n');
write('payload.txt', 'before\n');
write('.dot-bridge.json', JSON.stringify({checks:{'patched-content':{argv:['/runtime/node','-e','process.exitCode=0']}}}));
git('add', '-A');
git('commit', '-m', 'filtered base', '--quiet');
const baseSha = git('rev-parse', 'HEAD');
write('payload.txt', 'after\n');
const patch = Buffer.from(git('diff', '--binary') + '\n');
write('payload.txt', 'before\n');

const store = new Store(':memory:');
try {
  const verification = await verifySealedResult({
    store,
    sealedResult: {
      request_id: 'req_filter_safety_0001',
      review: false,
      github_repo: 'example/repo',
      assignment: {
        execution_scope: 'implementation',
        inputs: [{ github_repo: 'example/repo', base_sha: baseSha }],
        evidence_plan: { schema_version: 1, checks: [
          { id: 'patched-content', argv: ['/runtime/node', '-e', 'process.exitCode=0'], issuer: 'assignment', trust_profile: 'bridge_verified' },
        ] },
      },
      patch,
      patch_sha256: digest(patch),
      patch_base_sha: baseSha,
    },
    repoDir: repo,
    targetBaseRef: 'main',
    scratchRoot: path.join(fixture, 'scratch'),
  });
  assert.equal(fs.readFileSync(path.join(verification.scratch_dir,'payload.txt'),'utf8'),'after\n');
  assert.equal(verification.status, 'verified', 'filter-safe worktree checkout must complete and pass its check');
  assert.equal(verification.verification.checks.length, 1, 'the safety test must run a real evidence check');
  assert.equal(verification.verification.checks[0].status, 'passed', 'the patched file must be present in the checked-out worktree');
  assert.equal(fs.existsSync(outsideMarker), false, 'host checkout ran a repository-local filter driver');
  console.log('integrator-filter-safety-test: host checkout did not run the local smudge filter');
} finally {
  store.db.close();
}
