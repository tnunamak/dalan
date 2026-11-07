import assert from 'node:assert/strict';
import { preflightPR } from '../src/pr-preflight.mjs';

let now = Date.parse('2026-10-07T20:00:00Z');
const sha = 'a'.repeat(40);
const assignment = {
  inputs: [{ github_repo: 'fixture/repo', base_sha: 'b'.repeat(40), head_sha: sha, pr_number: 1 }],
  prepared_at: new Date(now).toISOString(), valid_until: new Date(now + 7200000).toISOString(),
};
const options = read => ({ now: () => now, read });
const remote = { state: 'open', draft: false, merged: false, head: { sha } };
assert.equal(await preflightPR({ inputs: [] }), null);
assert.equal((await preflightPR(assignment, options(async () => remote))).head_sha, sha);
assert.equal((await preflightPR(assignment, options(async () => ({ ...remote, draft: true })))).draft, true);
for (const observation of [{}, { ...remote, state: 'closed' }, { ...remote, head: { sha: 'c'.repeat(40) } }]) {
  await assert.rejects(preflightPR(assignment, options(async () => observation)), /unknown|open|mismatch/);
}
await assert.rejects(preflightPR(assignment, options(async () => { throw new Error('fixture auth failure'); })), /auth failure/);
await assert.rejects(preflightPR({ ...assignment, valid_until: new Date(now + 7200001).toISOString() }, options(async () => remote)), /validity/);
await assert.rejects(preflightPR({ ...assignment, objective_resolved: true }, options(async () => remote)), /resolved/);
for (const value of ['true', 1, 'yes', null]) await assert.rejects(preflightPR({ ...assignment, objective_resolved: value }, options(async () => remote)), /boolean/);
for (const input of [{ ...assignment.inputs[0], github_repo: './x' }, { ...assignment.inputs[0], base_sha: 'bad' }]) await assert.rejects(preflightPR({ ...assignment, inputs: [input] }, options(async () => remote)), /pinned/);
await assert.rejects(preflightPR(assignment, options(async () => { now += 7200001; return remote; })), /expired/);
console.log('PASS PR preflight: exact directly observed head, open/draft facts, unknown/moved/closed heads, validity and expiry during I/O');
