# PR-head reviewer

`dalan-pr-reviewer` submits one scoped, read-only review to the default worker for every open pull request that passes the gates below and whose current head SHA has no worker review. It makes no model calls. A systemd user timer runs it every 10 minutes.

## What one run does

0. Before the capacity gate (skipped with `--only`): for each PR that a queued or claimed assignment targets (objective key `pr:<owner>/<repo>#<n>`, or `inputs[0].github_repo` plus `pr_number`), at most `max_closed_checks` (40) per run, one REST `pulls/<n>` call (ETag-conditional, so an unchanged PR is a 304). A PR with `state` `closed` (merged or not) gets every such request cancelled with `dalan cancel ID --reason pr_closed`; the bridge stores it as `cancelled_reason`. Open PRs are untouched. A failure is logged as `error` with stage `pr-closed-check` and does not stop the run; a rate limit sets the usual backoff.
1. `dalan status --json`. Stop when the pool is paused, when an owner-confirmed `worker_break` is active (`active` and `source === "owner"`), or when `claim_denied.capacity_hold_until` is in the future.
2. Free slots = `max_claimed_outer_assignments + headroom - (claimed + live queued)`, at most 0 or more. Submit at most `min(slots, max_submits_per_run)`. Defaults: headroom 6, 10 per run. With no free slot the run lists nothing.
3. Discover open PRs with one REST-backed `gh search prs` per distinct configured owner and one per extra repo not covered by those owners. Apply case-insensitive exact `exclude_owners` and `exclude_repos`, and skip archived/fork repositories when the search or PR detail response identifies them. Bot PRs are skipped. A draft counts only if updated in the last 7 days; any other PR only if updated in the last 30 days. Ready PRs go first, newest first.
4. Dedupe against `bridge.db` (read-only): any non-cancelled assignment for the same repository whose `inputs[0].head_sha` (or lone `base_sha`) is this head, or whose `objective_key` + `revision` is this PR at this head. This includes reviews that other owners submitted themselves. Cancelled assignments do not cover.
5. Build the assignment so that `validateSubmission` accepts it: `scope_paths` are the PR's changed files still present at the head (deleted files are omitted), collapsed to directories only when over `max_scope_paths` (150) paths or `max_scope_bytes` (8000) bytes; `inputs` pin `{github_repo, base_sha: head}` in head-only mode (REST pull details provide a base tip, not a merge base); `execution_scope` is `read-only`; the brief names no path. A changed file the lint calls sensitive leaves the scope and the PR is then reviewed at its head without the diff (`inputs: [{github_repo, base_sha: head}]`). A PR whose files are all sensitive, a deletion-only PR, and a PR with more than `max_changed_files` (200) changed files, counting deletions, are skipped.
6. Submit with `dalan submit --stdin --json --background --exclude-sensitive --allow-scope-prune --deliver <dest> --objective-key pr:<owner>/<repo>#<n> --revision <head> --task-kind review --source agent`. (`--source` accepts only `drainer`, `fix-loop`, `agent`, `unknown`.) Request id: `prh-<owner>-<repo>-<n>-<head12>`.
7. A refusal that survives the CLI's `--allow-scope-prune` fix is logged and remembered for 6 hours. It is not retried in the same run. A bridge or transport failure (HTTP 5xx, timeout) is also remembered for the cooldown and ends the run.

## Delivery

The T3 thread linked to the PR (read-only from `~/.t3/userdata/statev2.sqlite`, `orchestration_v2_projection_threads.payload_json.pullRequests`; a live thread beats an archived one, then the newest link wins) receives the result. If that link points to a delegated child, the reviewer follows its `lineage.parentThreadId`, then `lineage.rootThreadId`, and delivers to the nearest owner that is not archived, deleted, or settled. It never delivers to the delegated child. If no owner can receive it, `report_thread_id` from the config is used; with neither, delivery is `none`. A refused protected T3 destination logs `delivery-fallback` and retries with the report thread if different, then `none`. Other refusals do not trigger a delivery retry. The dry run prints the resolved destination without submitting or writing state.

## GitHub API budget

No `gh pr list`, `gh pr view`, repository enumeration or GraphQL is used. Per run the nominal budget is owners + extra repositories + changed PRs × 3 REST calls + one `pulls` call per PR with queued or claimed work (step 0, mostly 304s): one search per owner/extra repository (limit 200), then pull details (head/base SHA), changed files and pull details again (to confirm the head did not move) for each eligible result. Covered/refused heads need only the first detail call. Files use `gh api --paginate`; each additional page costs an additional REST request even though it is one gh invocation. Because calls are sequential, a rate-limit failure stops further requests immediately.

After a complete successful scan, state records the run's start time in `last_successful_run`. Later searches include `updated:>=<last_successful_run minus 10 minutes>`; first runs have no date filter. The overlap catches updates made during a run. `--only` ignores and does not advance this scan watermark. Capacity truncation, a 200-result search, errors and retryable refusals retain the previous watermark rather than lose unseen work. A search capped at 200 still requires operator attention or narrower configured coverage to guarantee full discovery.

REST responses are read with `gh api -i`; body and ETag are cached per endpoint in `state.json` under the state directory. A later fetch sends `If-None-Match` and a 304 returns the cached body (authenticated conditional 304s do not consume the primary REST rate-limit budget). Multi-page file collections are cached without a validator: one page's ETag cannot validate the entire collection, and gh would otherwise send that same conditional header to every page. Search responses are not conditionally cached.

Every run logs `gh-calls` with invocation counts by `search`, `pull`, and `files`, plus a separate `not_modified` count. The counts describe gh invocations, not hidden pagination requests. HTTP 429, HTTP 403 with `x-ratelimit-remaining: 0`, or gh stderr reporting `rate limit exceeded` or `secondary rate limit` immediately ends the run, logs `rate-limit`, and persists `backoff_until` using the reset/Retry-After headers. Other 403 responses are ordinary errors. If no reset is available (for example search stderr omits headers), back off for an hour; never retry sooner than one minute. Subsequent runs make no gh calls while backoff is active. Dry runs report these decisions without persisting caches, watermarks, backoff or logs.

## Configuration

`~/.config/dot-pr-reviewer/config.json` (optional; see [dot-pr-reviewer.config.example.json](dot-pr-reviewer.config.example.json)). Keys: `owners`, `repos`, `exclude_owners`, `exclude_repos`, `include_forks`, `skip_bots`, `max_submits_per_run`, `headroom`, `draft_days`, `max_age_days`, `max_changed_files`, `max_scope_paths`, `max_scope_bytes`, `ttl_hours`, `refusal_cooldown_hours`, `report_thread_id`, `dot_worker`, `gh_concurrency`, `bridge_db`, `t3_db`. `gh_concurrency` is accepted for config compatibility, but GitHub calls are sequential. Unknown keys are an error. No thread id is built in.

## Use

```
dalan-pr-reviewer --dry-run                     # inspect candidates without submitting
dalan-pr-reviewer --dry-run --ignore-capacity   # also inspect candidates when capacity is full
dalan-pr-reviewer --only OWNER/REPO#N             # one PR, if in the repo's first 200 open search results (still gated and deduped)
dalan-pr-reviewer --max N
```

State and log: `~/.local/state/dot-pr-reviewer/{state.json,log.jsonl}` (one JSON line per decision).

## Install on Linux

Run the commands below from the Dalan checkout or installed package directory, where `docs/` and `systemd/` exist. First install Node.js 24+, authenticate `gh`, make `dalan` available on the unit's `PATH`, and configure the `bridge_db` and `t3_db` paths. Both databases must exist; `t3_db` must contain `orchestration_v2_projection_threads`, even for delivery `none`. Disable any previous PR feeder before enabling this timer.

```
mkdir -p ~/.config/dot-pr-reviewer ~/.config/systemd/user
cp docs/dot-pr-reviewer.config.example.json ~/.config/dot-pr-reviewer/config.json   # then edit report_thread_id
ln -sf "$PWD"/systemd/dot-pr-reviewer.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dot-pr-reviewer.timer
```

It needs `gh` (authenticated), `node` 24 and `dalan` on the unit's `PATH`. It also opens the bridge database and the T3 database read-only (`bridge_db`, `t3_db`). Both must exist, and the T3 database needs the `orchestration_v2_projection_threads` table, even when delivery uses `report_thread_id` or `none`; otherwise the run aborts. Disable any previous PR feeder before enabling this timer.
