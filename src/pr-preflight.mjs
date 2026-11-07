import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fullSha = /^[a-f0-9]{40}$/;
const maxValidityMs = 2 * 60 * 60 * 1000;

export function prInput(assignment, now = Date.now()) {
  const candidates = (assignment.inputs ?? []).filter(input => input.pr_number !== undefined);
  if (!candidates.length) return null;
  if (candidates.length !== 1 || assignment.inputs.length !== 1) throw new Error('one pinned PR input required');
  const input = candidates[0];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.github_repo ?? '') || input.github_repo.split('/').some(part => part === '.' || part.includes('..')) || !Number.isSafeInteger(input.pr_number) || input.pr_number < 1 || !fullSha.test(input.base_sha ?? '') || !fullSha.test(input.head_sha ?? '')) throw new Error('invalid pinned PR input');
  const prepared = Date.parse(assignment.prepared_at), validUntil = Date.parse(assignment.valid_until);
  if (!Number.isFinite(prepared) || !Number.isFinite(validUntil) || prepared > now || validUntil <= now || validUntil <= prepared || validUntil - prepared > maxValidityMs || now - prepared > maxValidityMs) throw new Error('PR preparation expired or invalid; validity must be at most two hours');
  if (assignment.objective_resolved !== undefined && typeof assignment.objective_resolved !== 'boolean') throw new Error('invalid objective_resolved; boolean required');
  if (assignment.objective_resolved === true) throw new Error('PR objective already resolved');
  return input;
}

async function readPullRequest(input) {
  try {
    const { stdout } = await run('gh', ['api', '--hostname', 'github.com', `repos/${input.github_repo}/pulls/${input.pr_number}`], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error('pr_head_unknown: direct GitHub observation failed'),{code:'DOT_BRIDGE_INFRASTRUCTURE'});
  }
}

export async function preflightPR(assignment, { now = Date.now, read = readPullRequest } = {}) {
  const input = prInput(assignment, now());
  if (!input) return null;
  let remote;
  try { remote=await read(input); }
  catch(error) { error.code='DOT_BRIDGE_INFRASTRUCTURE'; throw error; }
  // Check time again after I/O: a response cannot refresh an expired preparation.
  prInput(assignment, now());
  if (!remote || !['open', 'closed'].includes(remote.state) || typeof remote.draft !== 'boolean' || !fullSha.test(remote.head?.sha ?? '')) throw Object.assign(new Error('pr_head_unknown: incomplete GitHub observation'),{code:'DOT_BRIDGE_INFRASTRUCTURE'});
  if (remote.state !== 'open' || remote.merged === true) throw new Error('PR is no longer open');
  if (remote.head.sha !== input.head_sha) throw new Error('pr_head_mismatch: pinned revision moved');
  return { github_repo: input.github_repo, pr_number: input.pr_number, head_sha: remote.head.sha, draft: remote.draft, checked_at: new Date(now()).toISOString() };
}

// Called again inside the mutation transaction. Network I/O stays outside it;
// immutable payload, validity and observed revision are rechecked at commit.
export function assertPreflight(assignment, evidence, now) {
  const input = prInput(assignment, now);
  if (!input) return;
  const checked = Date.parse(evidence?.checked_at);
  if (!evidence || evidence.github_repo !== input.github_repo || evidence.pr_number !== input.pr_number || evidence.head_sha !== input.head_sha || typeof evidence.draft !== 'boolean' || !Number.isFinite(checked) || checked > now || now - checked > 15000) throw Object.assign(new Error('pr_head_unknown: fresh direct preflight required'),{code:'DOT_BRIDGE_INFRASTRUCTURE'});
}
