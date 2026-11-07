import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { hostReadiness } from '../src/execution.mjs';
import { loadSealedResult, runEvidencePlan, verifySealedResult } from '../src/integrator.mjs';
await import('./require-integrator-host-budget.mjs');

const root = path.join(os.homedir(), '.tmp/dalan-integrator/m4-pr-a-test');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const fixture = fs.mkdtempSync(path.join(root, 'case-'));
const repo = path.join(fixture, 'repo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=integrator test', '-c', 'user.email=integrator@example.invalid', ...args], { encoding: 'utf8' }).trim();
const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);
const commit = message => {
  git('add', '-A');
  git('commit', '-m', message, '--quiet');
  return git('rev-parse', 'HEAD');
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

git('init', '--quiet', '-b', 'main');
write('.dot-bridge.json', JSON.stringify({ checks: { assignment_test: { argv: ['/runtime/node', '-e', 'process.stdout.write("assignment-check")'] } } }));
write('note.txt', 'before\n');
const patchBaseSha = commit('base');
write('note.txt', 'after\n');
git('add', 'note.txt');
const patch = Buffer.from(git('diff', '--cached', '--binary') + '\n');
git('reset', '--hard', '--quiet');
git('checkout', '-b', 'moved', '--quiet');
write('unrelated.txt', 'kept\n');
const targetSha = commit('move target without conflict');
git('checkout', 'main', '--quiet');

const store = new Store(path.join(fixture, 'bridge.db'));
const sealedResult = {
  request_id: 'req_integrator_a001',
  review: false,
  assignment: {
    execution_scope: 'implementation',
    inputs: [{ github_repo: 'example/repo', base_sha: patchBaseSha }],
    evidence_plan: {
      schema_version: 1,
      checks: [
        { id: 'unit', argv: ['/runtime/node', '-e', 'require("node:fs").writeFileSync("note.txt", "check mutation\\n")'], issuer: 'assignment', trust_profile: 'bridge_verified' },
        { id: 'lint', argv: ['/runtime/node', '-e', 'process.stdout.write(require("node:fs").readFileSync("note.txt", "utf8"))'], issuer: 'owner', trust_profile: 'owner_declared' },
      ],
    },
  },
  patch,
  patch_sha256: digest(patch),
  patch_base_sha: patchBaseSha,
};

const verified = await verifySealedResult({ store, sealedResult, repoDir: repo, targetBaseRef: 'moved', scratchRoot: fixture });
assert.equal(verified.status, 'verified');
assert.equal(verified.verification.checks[0].host_budget.limits.output_bytes,262144);
assert.equal(verified.verification.checks[0].stop_verified,true);
const budgetPlan=argv=>({schema_version:1,checks:[{id:'budget',argv,issuer:'owner',trust_profile:'bridge_verified'}]});
delete process.env.DALAN_HOST_CHECKS;
try {
  const disabled=await runEvidencePlan(budgetPlan(['/usr/bin/true']),verified.scratch_dir);
  assert.equal(disabled[0].status,'failed');
  assert.match(disabled[0].error,/resource_limits_unavailable/);
} finally { process.env.DALAN_HOST_CHECKS='1'; }
const flood=await runEvidencePlan(budgetPlan(['/runtime/node','-e','require("fs").writeSync(1,"x".repeat(400000))']),verified.scratch_dir);
assert.equal(flood[0].status,'failed');
assert.equal(flood[0].error,'budget exceeded: output');
assert.equal(flood[0].stop_verified,true);
assert(flood[0].output_bytes<=flood[0].host_budget.limits.output_bytes);
assert.notEqual(verified.candidate.candidate_id, verified.candidate.linked_from);
assert.match(verified.candidate.candidate_id, /^cand_[a-f0-9]{32}$/);
assert.equal(verified.candidate.linked_from, verified.original_candidate_id);
assert.equal(verified.verification.patch_digest, sealedResult.patch_sha256);
assert.equal(verified.verification.patch_base_sha, patchBaseSha);
assert.equal(verified.verification.target_sha, targetSha);
assert.deepEqual(verified.verification.checks.map(({ id, issuer, status }) => [id, issuer, status]), [
  ['assignment_test', 'repository-config', 'passed'],
]);
assert.match(verified.verification.checks[0].output_preview, /assignment-check/);
assert.equal(fs.readFileSync(path.join(verified.scratch_dir, 'note.txt'), 'utf8'), 'after\n');
const original = store.getIntegrationCandidate(verified.original_candidate_id);
assert.equal(original.target_sha, patchBaseSha, 'the original candidate keeps its recorded base');
assert.equal(original.linked_from, null);
assert.throws(() => store.db.prepare('UPDATE integration_candidates SET target_sha=? WHERE candidate_id=?').run(patchBaseSha, verified.candidate.candidate_id), /immutable/);
assert.throws(() => store.db.prepare('UPDATE integration_verifications SET status=? WHERE candidate_id=?').run('failed', verified.candidate.candidate_id), /append-only/);

const loadedArtifactPath = path.join(fixture, 'stored-patch.diff');
fs.writeFileSync(loadedArtifactPath, patch);
const storedReport = { assignment: sealedResult.assignment, review: false, report: { workspace_evidence: { base_sha: patchBaseSha, patch_artifact: { artifact_id: 'art_test', sha256: digest(patch) } } } };
const artifactRow = { id: 'art_test', request_id: sealedResult.request_id, kind: 'patch', path: loadedArtifactPath, size: patch.length, sha256: digest(patch), sealed: 1 };
const availabilityCalls = [];
let retentionRefusal = null;
const artifactStore = {
  assertProtocolAvailable(requestId) {
    availabilityCalls.push(requestId);
    if (retentionRefusal) throw retentionRefusal;
  },
  get: requestId => requestId === sealedResult.request_id ? storedReport : undefined,
  db: { prepare: () => ({ get: (artifactId, requestId) => artifactId === artifactRow.id && requestId === artifactRow.request_id ? artifactRow : undefined }) },
};
const { Workspace } = await import('../src/workspace.mjs');
const artifactReader = Object.create(Workspace.prototype);
artifactReader.store = artifactStore;
const wrongArtifactIdRejected = (() => { try { artifactReader.artifact('art_other', sealedResult.request_id); return false; } catch { return true; } })();
const wrongRequestIdRejected = (() => { try { artifactReader.artifact('art_test', 'req_other'); return false; } catch { return true; } })();
assert.deepEqual({ wrongArtifactIdRejected, wrongRequestIdRejected }, { wrongArtifactIdRejected: true, wrongRequestIdRejected: true },
  'the artifact fixture must enforce both artifact ID and request ID binding');
assert.deepEqual(availabilityCalls,[sealedResult.request_id,'req_other'], 'artifact reads check retention for the exact request before binding lookup');
availabilityCalls.length=0;
const loadedResult = await loadSealedResult(artifactStore, sealedResult.request_id);
assert.equal(loadedResult.patch_sha256, sealedResult.patch_sha256);
assert.deepEqual(loadedResult.patch, patch);
assert(availabilityCalls.length>0,'sealed loading must check protocol availability');
assert(availabilityCalls.every(id=>id===sealedResult.request_id));
retentionRefusal=new Error('TOMBSTONE');
try {
  assert.throws(()=>artifactReader.artifact('art_test',sealedResult.request_id),error=>error===retentionRefusal);
  await assert.rejects(()=>loadSealedResult(artifactStore,sealedResult.request_id),error=>error===retentionRefusal);
} finally { retentionRefusal=null; }
const alteredArtifactBytes=Buffer.from(patch);
alteredArtifactBytes[0]^=1;
fs.writeFileSync(loadedArtifactPath,alteredArtifactBytes);
try {
  await assert.rejects(()=>loadSealedResult(artifactStore,sealedResult.request_id),/artifact integrity failure/i,
    'loadSealedResult must validate bytes even when the stored row and report digest agree');
} finally {
  fs.writeFileSync(loadedArtifactPath,patch);
}

const defaultVerified = await verifySealedResult({
  store,
  sealedResult: { ...sealedResult, assignment: { ...sealedResult.assignment, evidence_plan: undefined }, evidence_plan: undefined },
  repoDir: repo,
  targetBaseRef: 'moved',
  scratchRoot: fixture,
});
assert.equal(defaultVerified.status, 'verified');
assert.deepEqual(defaultVerified.verification.checks.map(({ id, issuer, trust_profile }) => [id, issuer, trust_profile]), [['assignment_test', 'repository-config', 'bridge_verified']]);

const failed = await verifySealedResult({
  store,
  sealedResult: { ...sealedResult, assignment: { ...sealedResult.assignment, evidence_plan: { schema_version: 1, checks: [{ id: 'expected-failure', argv: ['/runtime/node', '-e', 'process.exitCode=1'], issuer: 'assignment', trust_profile: 'bridge_verified' }] } } },
  repoDir: repo,
  targetBaseRef: 'moved',
  scratchRoot: fixture,
});
assert.equal(failed.candidate.candidate_id, verified.candidate.candidate_id, 'a retry keeps candidate identity');
assert.equal(failed.status, 'verified', 'worker-supplied failing checks are ignored');
assert.deepEqual(store.db.prepare('SELECT status FROM integration_verifications WHERE candidate_id=? ORDER BY rowid').all(verified.candidate.candidate_id).map(row => row.status),
  ['failed', 'verified', 'failed', 'verified', 'failed', 'verified'],
  'each retry appends an interrupted-attempt marker and its final result without relabelling history');

git('checkout', '-b', 'conflict', patchBaseSha, '--quiet');
write('note.txt', 'owner edit\n');
const conflictSha = commit('conflicting target edit');
const conflict = await verifySealedResult({ store, sealedResult, repoDir: repo, targetBaseRef: conflictSha, scratchRoot: fixture });
assert.equal(conflict.status, 'conflict');
assert.equal(conflict.candidate.linked_from, conflict.original_candidate_id);
assert.equal(conflict.verification.checks.length, 0, 'checks do not run after patch conflict');
assert.equal(fs.readFileSync(path.join(conflict.scratch_dir, 'note.txt'), 'utf8'), 'owner edit\n', 'failed apply leaves the target tree untouched');

const storedBeforeBadDigest = store.db.prepare('SELECT count(*) n FROM integration_candidates').get().n;
await assert.rejects(() => verifySealedResult({
  store,
  sealedResult: { ...sealedResult, patch_sha256: digest(Buffer.from('different')) },
  repoDir: repo,
  targetBaseRef: 'moved',
  scratchRoot: fixture,
}), /digest/i);
assert.equal(store.db.prepare('SELECT count(*) n FROM integration_candidates').get().n, storedBeforeBadDigest, 'bad sealed input creates no candidate');

const plan = {
  schema_version: 1,
  checks: [{ id: 'isolated', argv: ['/runtime/node', '-e', 'process.stdout.write(process.env.GH_TOKEN ? "leaked" : "clean")'], issuer: 'owner', trust_profile: 'bridge_verified' }],
};
const priorToken = process.env.GH_TOKEN;
process.env.GH_TOKEN = 'test-only-secret-marker';
let isolated;
try {
  isolated = await runEvidencePlan(plan, verified.scratch_dir);
} finally {
  if (priorToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = priorToken;
}
if (hostReadiness().ready) {
  assert.equal(isolated[0].status, 'passed', JSON.stringify(isolated[0]));
  assert.match(isolated[0].output_preview, /clean/);
} else {
  assert.equal(isolated[0].status, 'failed', 'the established runner reports unavailable hosts as failed evidence');
}
assert.equal(isolated[0].issuer, 'owner');
assert.equal(isolated[0].trust_profile, 'bridge_verified');

store.db.close();
console.log('integrator-verifier-test: sealed artifact loading, candidate lineage, default checks, immutable verification records, conflict handling, digest checks, and sandboxed evidence passed');
