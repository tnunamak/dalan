# Declared PR preflight

A PR-derived assignment declares one GitHub input with `github_repo`, full `base_sha`, full `head_sha`, and a positive integer `pr_number`. The assignment also supplies `prepared_at` and `valid_until`, at most two hours apart. Standalone pinned commits and opaque research inputs do not imply a PR number; producers must declare PR work explicitly.

Fresh submit and first claim each call `gh api --hostname github.com repos/OWNER/REPO/pulls/NUMBER` directly, using the host's existing gh authentication. `GH_HOST` cannot silently redirect the observation to another GitHub instance. No cached preparation result authorizes a claim. An unknown observation, closed/merged PR, moved head, expired preparation or `objective_resolved:true` refuses the mutation. Draft state is recorded as a fact and is not an eligibility veto. The remote call is bounded at ten seconds and happens outside the SQLite transaction; the transaction checks immutable input, observation freshness and preparation validity again.

For example, add these fields to the normal assignment:

```json
{
  "prepared_at": "<current RFC3339 timestamp>",
  "valid_until": "<RFC3339 timestamp within two hours>",
  "inputs": [{
    "github_repo": "owner/repo",
    "base_sha": "<full base commit SHA>",
    "head_sha": "<full current PR head SHA>",
    "pr_number": 123
  }]
}
```

`get.pr_preflights` returns persisted `submit` and `claim` observations with repository, PR number, head SHA, draft flag and `checked_at`. An exact live retry returns the original claim without another remote PR observation and is not re-judged against current repository or destination policy (built-in mode still requires the connection that holds the grant); it does not start new work. Existing claimed work is not reclaimed or stopped when a PR later changes. Immutable existing submit retries stay readable and retryable after their preparation expires.

A direct observation proves the head at its recorded instant. GitHub can change immediately afterward; the result remains tied to its declared SHA and must be verified against the current head before use. This preflight does not prove the broader objective is still useful. When the objective, revision or validity changes, the producer must prepare a new immutable identity; changing the old assignment conflicts.

The following checks require a source checkout installed with `npm ci`; their scripts are not included in the npm package.

Run `node scripts/pr-preflight-test.mjs` and `node scripts/pr-preflight-commit-test.mjs` and `node scripts/pr-preflight-e2e.mjs`. The HTTP journey uses a local Git fixture and an inert gh executable, verifies zero assignments/claims on refusal, and proves claim retries keep their ID through a simulated observation outage. It does not contact GitHub or a live worker.
