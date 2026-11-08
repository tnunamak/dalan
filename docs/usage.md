# Dalan requester reference

This is the reference for requesters who already have a working bridge. A first job does not need it: start with the [README](../README.md). Delivery to T3 Code threads, builds through the T3 worker provider, objective labels and code-assigned consumers are in [T3 and orchestration integration](t3-integration.md); only installations that use them need that page.

Path examples use fresh-home defaults. For an existing installation, use the roots from `dalan paths --json`, because populated legacy roots remain active ([upgrade guide](dalan-upgrade.md)).

## Submit, wait and review a job

The numbered steps below take one job from submission to your decision. The reference sections after them describe options and behavior that you may need along the way.

1. Use quiet delivery (`none`, the CLI default). For a visible notice in a T3 task thread, see [T3 task-thread delivery](t3-integration.md#t3-task-thread-delivery).
2. Start with a repository-free report in `first-job.json`; replace `<stable UUID>` once and keep that ID and file for retries. Keep the inputs immutable:

```json
{
  "schema_version": 1,
  "request_id": "req_<stable UUID>",
  "brief": "Report the exact phrase: bridge first report. Do not read files, run commands or call external services.",
  "inputs": [],
  "expected_output": "Text report containing: bridge first report.",
  "execution_scope": "read-only"
}
```

3. Run `dalan status --json`, then `dalan submit --worker NAME --execution none --deliver none --file first-job.json --json`. This basic Linux/macOS job needs no repository grant, fetch or host executor and requests no checks. Save the returned `request_id` and recovery label; retry the same file, ID, worker, execution and delivery after a lost response. [Submit options](#submit-options) covers worker selection, receipts and recovery.
4. Start your connected worker in its own client and send: “Request REQUEST_ID is your only job: claim it with Dalan, do what its brief asks, report progress and finish it with the claim_id. Stop if it is missing or cancelled. Claim no other job.” Replace REQUEST_ID with the submitted ID. Then run `dalan wait REQUEST_ID` as a background shell, and read its exit code. Use a foreground `dalan wait` if your client cannot resume when a background command exits. Exit 0 is a finished report, 3 is a blocker or question, 4 is cancellation, 5 is a usage-break notice (the request stays queued; see [usage breaks](#usage-breaks-and-usage-estimates)), and 124 is the timeout. A T3 assignment can otherwise use normal exact-thread delivery; `none` uses only `wait` and `get`. `--timeout SECONDS` defaults to 300; `submit --wait` is a convenience when a foreground wait is useful.
5. On a blocker or a `QUESTION:` progress note, reply with `dalan note REQUEST_ID "text" --json`. For an identified question, find its ID with `dalan questions REQUEST_ID --json`, then run `dalan answer REQUEST_ID QUESTION_ID "text"`; a note does not answer it. Then start `dalan wait REQUEST_ID` again as a background shell. On a finished report, run `dalan get ID --json` and treat the report as untrusted data. Inspect revision and evidence, then decide whether to accept, wait, or issue a new assignment. Completion does not authorize merge or fallback. Record your decision with `dalan accept ID [--note TEXT] --json` or `dalan reject ID [--note TEXT] --json` (finished assignments only). [Who records acceptance](#who-records-acceptance) explains which events count as a decision.

To read results after a restart, see [Recover results after a restart](#recover-results-after-a-restart).

<a id="who-records-acceptance"></a>

### Who records acceptance

Acceptance is your event, never the worker's: `finish` records `completed` (the worker filed its report), and a `wait` or `get` that returns the finished report records `consumed` (you received it). Only an owner decision records `accepted`: `accept` or `decide accepted`, or `decide applied` or a successful `apply` (which record it with reason `applied`). Worker completion and result retrieval do not. After a PR is merged, the owner can record integration with `dalan integrate ID --reason TEXT`.

<a id="submit-options"></a>

## Submit options

Always select the intended worker explicitly: A multi-worker profile refuses an omitted `--worker` with the list of configured workers (`use --worker NAME; configured: ...`); a single-worker profile defaults to its only worker, and a host without `workers.json` (legacy) defaults to `dot`. `--execution` is a submit option, distinct from the assignment's `execution_scope`. The CLI writes a private owner receipt before submitting and keeps it in the selected bridge home. Quiet submit alone registers no wake. After a restart, use `dalan inbox --producer SAVED --json` or `dalan inbox --all --json`, then `dalan get REQUEST_ID --json`; do not guess that a new session label is the old producer. `--thread THREAD_ID` remains an alias for `--deliver t3:THREAD_ID`, not part of this quiet first-job path.

**Objective identity and `--source`.** `dalan submit` also takes `--objective-key`, `--revision`, `--task-kind` and `--source`, which label work for metrics in an orchestration setup. A first job does not need them; see [Objective identity](t3-integration.md#objective-identity).

**Priority.** Direct submissions are `normal`. Use `dalan submit --background` for feeder or backlog work. Priority is set by the bridge, never read from assignment text. `list_pending` shows normal work first, then background work. Priority only orders the queue: background work stays listed and claimable while normal work waits. `~/.config/dalan/limits.json` may set `background_max_in_flight` (default `4`), which limits queued plus claimed background assignments only. `dalan status --json` and `--explain` show queued and claimed counts for both classes.

<a id="queue-wake-ups"></a>

## Queue wake-ups and dispatch

**Wake-ups and re-announce.** Each new assignment gets an `assignment.available` event at once. When older items that the worker may claim are already queued, that event names the oldest one (with the re-wake text below), so a worker that follows wakes claims oldest first. While work stays queued, the bridge re-wakes the worker: at most one event per subscription per tick, usually spaced by `queue_rewake_ms` (limits.json, default 90 s); a freed lane waives that interval once. The interval is counted from the last wake that went out to that subscription (delivered or sending; a submit event and an owner-note event count, a suppressed one does not). It sends one only when the subscription's principal has a free lane (`free_lanes` as in `list_pending`), no submit event or re-wake for that subscription is still pending, sending or failed (owner-note and message events never hold it back), and at least one queued item is eligible: no uncertain or sending owner delivery, its latest submit event or re-wake not rejected by the callback with HTTP 410 or 413, and, once it has been queued `queue_rewake_window_ms` (default 2 h, counted from when the item last entered the queue), no wake for it delivered or sending in the last `queue_rewake_stale_ms` (default 20 min; backoff, so a stale item is re-woken at most once per that time). Just before the send the bridge checks the re-wake again (active subscription, free lane, item still queued and eligible); if that fails it is suppressed unsent and the next tick chooses again. The event names the first eligible item in `list_pending` order and reads `N assignments queued (F free lanes); claim oldest first via list_pending: <brief>` when several are eligible (the head is the oldest eligible item, normal work first; the event schema is unchanged); it does not mark any other item delivered. No re-wake while all lanes are claimed, during pause, or with no active subscription. An item queued longer than the window keeps being re-woken, but only every `queue_rewake_stale_ms`; it also shows in `dalan status --json` as `unclaimed_after_reannounce`, in `status --explain` as `unclaimed=N`, and raises one `unclaimed_queued` alert (with a recovery notice once it clears). The bridge does not cancel or park the item; cancel it or ask the worker why. `assignment_reannounce_interval_ms` and `assignment_reannounce_max_count` are still accepted but no longer control re-wake. `list_pending` results carry `free_lanes` and a `guidance` string telling the worker to claim every assignment it can start now, up to `free_lanes`; `claim` results carry `queued_after_claim` and `free_lanes`. A `finish` response that carries `next_queued` also carries `guidance` telling the lane to claim `next_queued[0]` before its run ends and to call `list_pending` after any claim error.

**Dispatch gap.** `finish` and `claim` results carry `next_queued` (up to one `{request_id, title}` per free lane, oldest first, never the item just claimed) and a one-line `next_action`, omitted when nothing is queued or no lane is free. When a claimed assignment leaves its lane (finish, abandon, owner cancel of a claimed item, lease takeover), the next drain tick (500 ms) sends one availability wake without waiting out `queue_rewake_ms`; a paused bridge, an owner-confirmed break, a capacity hold, no free lane or an outstanding wake still suppresses it. `status` carries Default-worker-scoped `dispatch: {state, free_lanes, queued_live, oldest_unclaimed_age_ms}` where `state` is `dispatch_gap` (free lanes and live queued work: the worker should claim), `supply_gap` (free lanes, nothing queued), `full`, `paused` or `unknown` (no active subscription proves capacity); `status --explain` shows `dispatch=<state>(free:F,queued:Q,oldest:Nm)` and the metrics line adds `idle_no_queue24h`/`7d` (time with nothing queued) next to `idle_while_queued`.
`status --json` also exposes `by_worker`: each worker has its own assignment counts, active claims, live queue, call timestamps, stale claims and queue liveness. Top-level assignment and priority counts remain global (`counts_scope` and `priority_counts_scope` are `global`). Each worker's `capacity` is bridge subscription-policy evidence, not vendor quota, availability or productive capacity. Without an active valid subscription, `free_lanes` is `null` and `state` is `unknown`; duplicate subscriptions do not add lanes, and conflicting historical principal scopes remain unknown. Top-level dispatch and liveness retain their scope (`dispatch.scope` and `liveness_scope`).

<a id="recover-results-after-a-restart"></a>

## Recover results after a restart

**Saved recovery binding.** A producer is an opaque local receipt-discovery label, not verified harness identity or proof that two environment IDs identify the same owner. Successful JSON submits add `recovery` with the saved `producer` (or null), `get`, optional `inbox`, `binding`, and `wake`; human submits keep their stdout format and print one `Next:` line on stderr. Reusing a request ID preserves its saved label and capability even when the current session differs: recover with `dalan get ID`, or `dalan inbox --producer SAVED` when that label exists. A missing label does not mean lost ownership. Quiet no-wait means this submit registered no wake, not that another waiter is absent; returned waits promise no future wake or durable observer. Host-wide `--all` recovery and its scanning cost are separate from binding.

**Producers: wake on drain.** An agent that feeds the worker a stream of tasks runs one `dalan wait --drained [--producer-thread ID] [--max-claimed N] [--max-queued N] [--timeout S]` as a background shell instead of one `wait` per task. It covers the producer's own tasks: receipts whose `producer` is ID (`submit` records `--producer-thread`, else `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`), or whose delivery is `t3:ID`. It prints one JSON line and exits 0 `drained` when the tasks are down to the low-water mark (default 0 claimed and at most 1 queued) and refilling can work, 3 `attention` on a new blocker or question (listed with its text), 5 `worker_break` or 6 `paused` when a break or pause begins during the wait, 7 `already_running` when another drained waiter holds this producer's pidfile (`~/.local/state/dalan/drained/`), 8 `bridge_unreachable` after 10 minutes of transport or 5xx failures (it waits through a shorter bridge restart), 9 `error` for any other bridge error (with its message), and 124 on timeout (default 1740 s, at most 86400). A break, pause or throttle already on holds the drained exit until refilling can work, so a restarted waiter never spins. A waiter started below the low-water mark with work still in flight (one queued task) waits for a task to finish first. It polls `POST /owner-states` every 15 s: status and blocker notes for the producer's requests plus `refill.held`, with no `consumed` event. Against a bridge without that route it falls back to `get` and `status` and adds `"legacy_reads":true`. A request it cannot read (unknown or not owned) is left out of the counts and listed under `unknown`; if nothing is readable and nothing finished, it holds to the timeout instead of reporting `drained`. A local PostToolUse hook can start the waiter after a submit. `scripts/drained-e2e.mjs` tests the waiter against a fixture bridge; a separate live integration script exercises CLI continuation and refill.

### On resume, drain the inbox first

**Symptom:** you resume a session after its waiters stopped. Waiters die with the session, so results can finish while no one waits.

**Check:** run `dalan inbox [--producer ID] [--json] [--all] [--since 72h|Nd|TIME|all]` first in a resumed session. It reads the same producer receipts as `wait --drained` (`--producer-thread`, `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`; `--producer ID` is the explicit form) through `POST /owner-states`, so it records no `consumed` event. A resumed session may have a different opaque producer label. Use `--producer SAVED` for the saved label, or `--all` for every receipt on this host. Without a producer flag or session label, read-only `inbox` selects all receipts on this host. The `--mark-read` operation still requires explicit request IDs or a producer/`--all` scope with `--before`.

It lists four groups, each with request ID, worker, status, title (first line of the brief, at most 100 characters), time and the next command: `finished_unread` (finished or blocked results with no `consumed` event; `get ID` removes the item), `question` (a running request whose latest `QUESTION:` or `BLOCKED:` note is newer than your last `note`; `note ID "..."` answers it), `undecided` (a finished result you have read, or that reached your T3 thread, with no decision yet; it follows `question` and `decide ID WORD` removes it; see "Decisions" below) and `cancelled_unread` (cancelled by the bridge, for example `expired`, and not yet read by `get` or `wait`; a cancel you ran yourself is not listed).

**Action:** run `get` on each item. `--json` prints the structured form; the exit code is 0 and an empty inbox prints `inbox empty`.

- Window and read rules: `--since 72h` is the default (`Nh`, `Nd`, an RFC3339 time, or `all`). `finished_unread`, `undecided` and `cancelled_unread` items older than the window are not listed (finished results age from their finish time, not from when you read them); the summary line ends with `N older items hidden (--since all to show)` and `--json` has `hidden_older`. Questions are always listed, and a finished result whose T3 delivery the bridge sent or the transcript check confirmed (a `t3` notification in state `delivered`) is not unread; `--json` counts these as `delivered_t3`. A delivery still `uncertain`, `failed` or `pending` does not count.
- Owner action `--mark-read`: `dalan inbox --mark-read REQUEST_ID...` or `dalan inbox [--producer ID|--all] --mark-read --before TIME` records the same read marker as `get` (a `consumed` event with reason `inbox-mark-read`, or `owner_read_at` for a cancelled row) without fetching or printing results, and prints `marked N read`. It needs ids or `--before` and never marks everything; `--before` ignores the `--since` window and skips questions and undecided items. One-time cleanup for a host with history: `dalan inbox --all --mark-read --before 72h`.
- Test: `scripts/inbox-e2e.mjs`.

## Cancel, leases and metrics

### Cancel a job

Withdraw a job with `dalan cancel ID --json`; an existing remote worker turn may continue and report late. With a still-valid claim and lease, a `finish` after cancel is refused with the structured error `assignment_cancelled` (TERMINAL: nothing more is needed for that request, and it is not a denial to work around). The message names the request and the cancel reason.

Claim validation runs first: an expired or otherwise invalid claim is refused without writing late evidence. In built-in mode the holding-connection check runs there too: a `finish` from a revoked, replaced or other connection fails with `connection_not_live` and writes no late evidence.

For a valid claim, the output is kept only as audit evidence in a separate `late_evidence` record (migration 42): at most one row per claim, the summary cut at 4 KiB and the result at 64 KiB, with a `full_sha256` of the original summary and result and a `truncated` flag. An identical retry stores nothing and gets the same error; a different payload is refused the same way and the first row stays. `get` shows `late_evidence` (summary, `truncated`, `full_sha256`, `created_at`) and `report: null`. The job stays cancelled, no report exists, nothing wakes the owner and no lane frees. Jobs cancelled before migration 42 keep any `late: true` report they already have, and `get` shows it as before; new late output goes to `late_evidence`. A normal `finish` says `result_authority: true` and `status: "finished"`.

### Pause and reconcile

Operators can run `dalan pause --reason maintenance`, `dalan resume`, and `dalan reconcile ID --json`.

### Claims and leases

`dalan claims --json` lists active claims with their epoch and lease (each grant stores its selected duration; the default is 60 min, with `claim_lease_ms` setting the maximum). After the lease expires, the drain tick abandons the claim (actor `system`, reason `lease_expired`) and requeues the item, so its lane is free. A usage break neither holds the sweep nor extends a deadline: only the claimant's own claim-bearing calls extend a lease, and listing never does. After a bridge start, a claim whose last activity came before the start is not swept before the start time plus that claim's own lease (`lease_ms`, one hour by default), so a deadline that ran out while the bridge was down does not requeue work the worker may still be running; a claim the worker touched since the start has no grace. The grace delays only the sweep and the requeue. The lease deadline itself still binds: from it, the claim cannot act.

Example with the default lease: a claim last had activity at 09:00 and its deadline is 10:00; the bridge is down from 09:50 and starts at 10:20. The lease ended at 10:00, so the worker's calls fail with `lease_expired` once the bridge answers again. The sweep leaves the claim alone until 11:20, and the first maintenance tick after that requeues it.

Re-waking queued work is a separate setting, `queue_rewake_ms` (default 90 s), and does not set this grace.

Native protocol leases instead expire at their fixed deadline and require explicit renewal. From the deadline (`now >= lease end`) the claim cannot act: `progress`, `finish`, the workspace tools and `artifact_chunk` fail with `lease_expired` (JSON message `{error, message, request_id, lease_expires_at}`), and a refused call does not refresh the lease or write anything. A claim after the deadline may start a new epoch only after verified host stop and delivery/admission gates; it does not renew the old claim. A different claimant may also take an expired claim over.

`dalan abandon ID --reason TEXT --json` returns a claimed assignment to the queue, and the old `claim_id` stops working; a successor still waits for the old deadline. Abandon and takeover are refused while a delivery for the assignment is uncertain or sending; reconcile it first.

### Metrics

`dalan metrics [--since RFC3339] [--json]` (default window: 30 days) derives queue latency, claim-to-first-activity, working/blocked/waiting/idle time against claimed time, lane utilization (see below), completed reports per day by kind, rework, duplicates and objective coverage, orphaned claims, check outcomes and owner acceptance from the lifecycle event table; `dalan status --explain` adds a one-line summary. A value the events cannot show is `{"value":null,"unknown_reason":"..."}`, never zero.

**Lane utilization** uses `worker_lane_capacity` in limits.json (integer 1..10, default 6; shown in `dalan status --json`; independent of `max_claimed_outer_assignments`) as an explicit denominator, over the last 24 hours and the last 7 days, always ending now (`--since` governs only the other metrics). `utilization` = working lane time / (`worker_lane_capacity` x covered wall time); the JSON states `numerator_ms`, `denominator_ms` and `lanes`. Working time is the definition above, clipped to the window. Three shares of covered time add up to 1: `idle_while_queued` (work queued and fewer active claims than lanes), `queue_empty`, and `all_lanes_busy`. `idle_while_queued` splits in two (`idle_while_queued` stays their sum): `idle_while_fresh_queued` (every queued item has waited at most `pickup_budget_ms`, 180 s) is the normal pickup window after a submit, and `idle_while_waiting_queued` (some queued item has waited longer) indicates a wake-up or claiming gap, not a supply gap. `idle_while_waiting_by_cause` splits it into `owner_break` (an owner-confirmed usage break was active), `worker_inactive` (no claim event by the worker in the last 20 min: the worker is silent or away) and `worker_active` (the worker was working claims but left a free lane unused); `status --explain` prints them as `iwq_waiting24h=X%(break:..,worker_inactive:..,worker_active:..)`.

Each window also reports `pickup_wait` (p50/p90 of queued-to-claimed time for assignments claimed in the window), `max_concurrent_claims`, and `throughput_by_concurrency`: for each number of claims held at once, `time_ms` at that level, `completions` that finished while it held, `completions_per_hour` and `per_claim_per_hour`. Levels with less than 10 minutes of time are omitted. A per-claim rate that stays flat up to N claims and then falls shows the real parallel capacity, which is how `worker_lane_capacity` is checked.

Lifecycle history starts at the first recorded event (including any verified backfill): time before that is unknown, so it leaves the denominator and the shares, and `window.covered_fraction` reports how much of the window the history covers. The `status --explain` line reads `util24h=PCT%(of N lanes) util7d=...(of N lanes,covered PCT%) idle_while_queued24h=... iwq_waiting24h=... idle_while_queued7d=... iwq_waiting7d=...` (`iwq_waiting` is `idle_while_waiting_queued`); `working/claimed` is the share of claimed time spent working, not of lane capacity.

### Older requests and local access

A request made before owner receipts existed has no owner receipt; an operator may explicitly adopt one with `dalan reconcile ID --adopt --json` before owner controls work. The mode 0600 socket and receipts prevent accidents, but processes under the same Unix UID can access them.

## Repository jobs, review mode and checks

Repository assignments are a separate branch after the first text report. Fresh workers have `repos: []`: the owner must run `dalan worker allow NAME OWNER/REPO`, then `dalan worker list NAME --json` and verify the exact intended list before submitting. The host's GitHub credential must also read that repository; its authority is not narrowed by the worker list. No local folder mapping is needed. Use a new request ID and `--execution none` for basic repository delegation without host checks; the [copyable repository example](../README.md#separate-repository-assignment) includes the pinned input and scope. Missing `repos` is legacy compatibility only, not a fresh-profile example. A full base commit SHA is required; an optional `head_sha` can pin a revision to review. The worker must not start metered model tasks for a read-only assignment. With the optional T3 Code adapter, if a fallback worker is needed, the owner chooses it after checking that worker's remaining usage quota, and records the reason. Treat stale or missing quota data as unknown.

**Review mode.** `dalan submit --deliver none --file assignment.json --review` marks the assignment as a review. The bridge stores the flag on the assignment row, outside the assignment payload and its hash; the worker never sees it in `assignment`, and the brief is not changed. `--review` sets `execution_scope` to `implementation` only when the file does not state a scope. Retrying the same `request_id` with a different `--review` setting is a `request_id conflict`. `get` shows `review: true`. In review mode `apply_patch` returns the structured error `{"error":"review_mode_read_only"}`; `list_files`, `read_file` and `workspace_result` work, and so does `run_check` when the assignment has implementation scope (a file that states `read-only` keeps it closed), and `finish` is never blocked by diff state. The worktree is checked out at `head_sha` when the assignment gives one, so checks and reads see the revision under review; `workspace_result` still diffs against `base_sha`. Without `--review`, implementation scope checks out `base_sha`, so the bridge now rejects a new implementation assignment whose `head_sha` differs from `base_sha` (`head_sha_unsupported`); pin `base_sha` to the revision to work on.

The bridge fetches the pinned commit into a private worktree. Fresh generic profiles use `execution=none`, and host checks are optional. Host checks work only on Linux: use a separate `--execution host` assignment after `dalan doctor` shows the host executor ready. Doctor checks `/usr/bin/bwrap`, not a check's runtime, binary or lockfile prerequisites; submit checks those. Add the check requirement to the assignment. `none` (including basic macOS delegation) must not request `run_check`; it returns `capability_not_available`. `claim` and `get` add `available_checks` only for implementation assignments when workspace tools are enabled. Repository-backed `workspace_result` includes check discovery; without repository input it returns only `checks` and sealed `artifacts`. Choose a discovered ID for `run_check`; an eligible execution with an unknown ID or no configured check returns a structured skip with the available list. The legacy `.dot-bridge.json` remains a fallback when `.dalan.json` is absent. The `default` ID is auto-detected from a test script or standard project manifest even without `.dalan.json`; repository and host check files can override it. Host execution requires `DALAN_HOST_CHECKS=1`, an exact owner allowlist entry for the repository/check pair, an owner-configured check definition and a valid six-field `host_budget` (`cpu_ms`, `wall_ms`, `memory_bytes`, `processes`, `disk_write_bytes`, `output_bytes`). A narrow read grant or any `scope_excluded` refuses host execution. See [execution setup](operations.md#execution-capability-and-check-evidence) for dependency preparation and backend prerequisites. After a worker finishes, inspect `workspace_evidence` in `dalan get ID --json`, fetch `patch_artifact.artifact_id` with `dalan artifact ARTIFACT_ID --output patch.diff` (a new file in an existing directory), verify its SHA-256, and apply it only after owner review. The bridge never pushes the patch.

**What a check can see and change.** Installation and checking use a private tmpfs execution copy; their writes are not exported to the host worktree. The previous writable-checkout result procedure is replaced by captured output and the original candidate diff.

- Guest edits, including edits inside the assignment's writable set, do not become a returned patch. Receipts identify `execution_storage: private_tmpfs_copy_not_exported`; host worktree hashes do not describe phase or post-check mutations in the execution copy.
- Sensitive-path masking is prepared before execution; masked paths and approved source overlays are supplied to the backend. Scope flags do not unmask dependencies.
- The owner setup procedure, including `dalan prepare-deps`, is in [operations](operations.md#execution-capability-and-check-evidence). Worker checks do not authorize changing host configuration.

Before an implementation request with `execution=host` is admitted, the bridge validates check metadata and probes the `default` check's `prerequisites` (binaries in the host `/usr/bin`, lockfile at `base_sha`, `node>=N` runtime) and, only when the default has current owner authorization, refuses the submit with `BLOCKED: check prerequisites unmet: ...` instead of queueing work the default worker cannot verify. Current authorization requires an exact repository/check allowlist entry, an owner-configured definition and a valid owner budget; unmet prerequisites of an unauthorized default or other checks are warnings. For `execution=none` or `worker`, host probes are skipped and unreadable metadata does not block admission. `readiness_argv` is recorded as skipped, not executed on the host. In every execution mode, an implementation assignment that asks for a regression test must list a test path (for example `tests`, `scripts/foo-test.mjs`, or a directory that already holds colocated tests such as `internal/foo` with `bar_test.go`) in `scope_paths`, or it is refused with `regression_test_scope`. `dalan get ID --json` shows `check_metadata` (prerequisites, readiness_argv, test_paths and their `*_reason` when unknown); see [operations](operations.md#github-workspaces) for the override fields.

`run_check` returns within about 20 seconds; a longer check returns `{check_run_id,status:"running"}`; poll `workspace_result` or `get` until it completes. Retrying the same check and diff while it runs returns the same ID. A restarted service marks an unfinished check `interrupted`, so start a new run after inspecting it. The worker can upload sealed evidence with `artifact_chunk` for any claimed assignment, including read-only work with no GitHub workspace. Both `workspace_result` and `get` list sealed uploads. The owner runs `dalan get ID --json` before `dalan artifact ARTIFACT_ID --output PATH` to establish the local artifact index.

## Worker questions and owner notes

Worker should record questions with `progress` for the owner. A `progress` note with optional `blocker:true` or a leading `BLOCKED:` / `QUESTION:` is retained quietly by default and forwarded only for unprotected explicit T3 delivery, once per distinct note, using `--if-busy steer` so an active owner sees blockers promptly. CLI-delivered notices use `--if-busy steer`; job results sent through the result transport instead use orchestration `message.dispatch`, selecting `steer_active` for the latest active run, `queue_after_active` when no active run exists but a queue does, and `start_immediately` otherwise. Lifecycle checks prevent waking settled or archived threads. Reply to a progress note with `dalan note REQUEST_ID "text"` (at most 4096 UTF-8 bytes, with a 16384-byte total per assignment, only `--json` is accepted as an option). Use `note` for anything about a specific assignment: append-only `owner_notes` appear in `get` and `claim`, in insertion order, and each note emits an `assignment.available` event with `request_id` and a `title` that carries the note id (the event schema has no `note_id` field) for the claimant. A note on an assignment that is already claimed is also listed in the `attention` key of the `list_pending` result (`[{request_id,note_count}]`) until the claimant calls `get` or `claim` for it, so a rebooted or event-missing worker can still find it. `claim` and `get` results carry a `guidance` string: on a permission-review denial, stop, report `BLOCKED:`, never retry around it. `dalan tell "text" [--worker NAME]` wakes the selected worker (default `dot`) with `assignment.available`; `dalan untell MESSAGE_ID [--worker NAME]` withdraws an unread pending message. After tool changes, Refresh the MCP connection using your client's documented procedure, then verify the tool catalog; restart the worker's conversation only if needed.
For a small outcome sample, keep a private TSV with header `request_id\taccepted\taccepted_at\tuseful\tfallback_reason\thuman_intervention\tquota_before\tquota_after`. Run `node scripts/outcomes.mjs --observations observations.tsv`. Missing acceptance and quota data remain unknown; coarse quota differences are not per-task billing.

## Removed commands

The deterministic producer, the manifest drainer, the legacy fix pipeline, and the `mute`, `watch` and `unwatch` commands are removed. The operator `integrate` command and legacy fix source metadata remain supported, and there is no synchronization executable. Stored legacy watch and mute facts remain readable. Finish, cancel and expiry can still suppress legacy watch state and pending notifications. To read finished results, use `dalan get`.

## Usage breaks and usage estimates

A hosted worker can stop making tool calls during a provider-imposed usage break.

**Rule: the bridge holds work only on evidence.** Evidence is an owner-confirmed break (`dalan break`, or an owner mark over an inferred one) or an operator pause. Estimated limits (claims, tool calls and response bytes, hourly and 24 h, configured or learned) are metrics: reaching one holds nothing. An inferred break is recorded and alerted but holds nothing either.

- Mark one: `dalan break --reason TEXT [--since RFC3339] [--json]`. `--since` must not be in the future or before the end of the previous break. Over an active break (for example an inferred one) the mark takes it over: source `owner`, the new reason, and `since` if given.
- End one: `dalan break --clear [--json]`. Usually not needed: the default worker's next authenticated tool call ends the break.
- List the ledger: `dalan breaks [--json]`. Each row has `since`, `until`, `reason`, `source`, `end_source`, `duration_ms` and `usage_before` (claims, finishes, tool calls, checks over 60 s, and `response_bytes` with `response_bytes_by_tool` for the 1h/6h/24h before `since`). `response_bytes` is `null` when byte accounting has no data before `since`, and `response_bytes_partial` marks a window that starts before it.
- Backfill a break from the request log: `dalan break-usage-backfill --id N [--log PATH] [--json]`. The CLI reads the `mcp_outcome` lines (`at`, `tool`, `response_bytes`) of `~/.local/state/dalan/requests.jsonl` (or `PATH`) and its numbered rotated generations, oldest first and complete lines only, and posts per-tool calls and bytes for the 1h/6h/24h before the break's `since` to the operator route `/break-usage-backfill`. Each window gets `request_log: {source:"request_log", response_bytes, calls, by_tool}` (`partial: true` when the log starts after the window start). The DB-sourced numbers are never changed. A repeat run with the same log returns `updated: false`. The output also has `log` (file, lines, outcomes, skipped, first_at). A later `dalan break --since` re-snapshots the break and drops `request_log`.
- The bridge infers a break by itself after `worker_break_silence_ms` (default 20 min) without a tool call from the legacy default worker, when an availability event got a 2xx after the last call and work is queued. A legacy default worker that never made a tool call is not inferred. An inferred break is silence, not proof: it is alerted ("may be on a usage break ... Not confirmed, so nothing is held"), ends on the next tool call and stops the queue-age clock, but re-wakes keep the normal cadence and refill is not held. Confirm it with `dalan break --reason TEXT` when the provider reports a break.
- Learned limits: an owner-marked break cuts the throttle limits to 70% of its ledger (only ever lower). An inferred break learns nothing, because it starts at the default worker's last call and the hour before it is quiet by construction; mark it with `dalan break --reason` once the provider confirms the break. An effective limit never falls below 25% of the configured one. List them, and which estimates are reached now (`over_estimate`), with `dalan learned [--json]`; remove all with `dalan learned --clear [--json]` (operator key). While any estimate is reached, the alert `usage_over_estimate` pages once per episode (`usage_over_estimate: NAME USED/LIMIT`; a learned one adds its configured value, learned value and break). It says the bridge holds no work for it.

During an owner-confirmed break the bridge sends one probe re-wake every `worker_break_probe_ms` (default 30 min) and no other re-wake, does not count the break toward the 2 h re-wake window (after which re-wakes back off to every 20 min), and keeps the queue as it is, and expired preparations follow the expiry policy below. Refill is held (`dalan wait --drained` exits 5 with `worker_break`; the ACP adapter refuses new work). Owners of queued normal work get one notice per break: "the worker is on a usage break; do this yourself with a cheap model if it is urgent, or leave it queued", with the request IDs. With T3 delivery it is one message per thread. With `delivery=none` there is no outbound channel, so the notice is an attention row in the existing wait queue: `dalan wait` returns it once as `{"status":"worker_break","notice":...}` with exit code 5, and `dalan get ID --json` shows it under `worker_break_notices`. The request stays queued; wait again for the result.

**Expiry.** When the expiry sweep runs, an expired requester deadline cancels queued work. A learned `queue_p90` deadline can instead be refreshed up to twice if history supplies a fresh window and at least 15 minutes remain before the 12-hour cap from creation. Otherwise the job is cancelled with `cancelled_reason: "expired"`. The maintenance sweep continues while delivery is paused. Inspect `get` for the actual status, `valid_until_source` and `expiry_requeues` before preparing replacement work under a new request ID.

**Usage estimates.** `limits.json` keys `max_claims_per_hour` (default 90, range 1 to 1000), `max_tool_calls_per_24h` (default 10000, range 10 to 10000000), `max_tool_calls_per_hour` (default 1000, range 1 to 100000), `max_response_bytes_per_24h` (default 100000000, range 1000000 to 10000000000) and `max_response_bytes_per_hour` (default 8000000, range 100000 to 1000000000) set reporting estimates. They are operator-configured estimates, not published service limits, and the bridge never enforces them. The bridge counts serialized response size per subject, tool and minute in `worker_calls` (kept 48 h). **Learned limits:** when an owner-confirmed break is recorded and its ledger has complete DB-sourced byte windows, each byte and tool-call estimate is cut to 70% of what the ledger shows for the 1 h and 24 h before `since`, and the claims estimate to 70% of the busiest rolling hour of claims in the 24 h before `since` (table `learned_limits`, migrations 28 to 30). A learned value only ever lowers an estimate, never below 25% of the configured one. Reaching an estimate changes no re-wake, no `list_pending` entry, no submit event and no claim, and the worker's own calls are never refused. `dalan status --json` shows `worker_break` and `throttle`: rolling counts (`claims_last_hour`, `tool_calls_last_hour`, `tool_calls_last_24h`, `response_bytes_last_hour`, `response_bytes_last_24h`), effective limits, `configured_tool_calls`, `configured_response_bytes`, `learned_tool_calls`, `learned_response_bytes`, and `over_estimate` (names of the estimates reached). `rewake_throttled`, `submit_throttled` and `normal_rewake_throttled` are always false and `holding` is always `{rewake: [], submit: []}`; they stay for older readers. `--explain` always shows `calls=1h:C/MAX,24h:C/MAX bytes=1h:B/MAX,24h:B/MAX`, adds `over_estimate=NAME+NAME` when any is reached, and adds `worker_break=since:...(source)` during a break. `worker_break_silence_ms` and `worker_break_probe_ms` each take 60000 to 86400000.
`dalan status --json` and admin `/status` include `budget: { window: "rolling_24h", calls_used, calls_cap, bytes_used, bytes_cap, remaining_fraction }`.
Usage and caps match the 24-hour `throttle` fields; caps include learned limits when they lower the configured values. The budget is a metric; it holds nothing.
`remaining_fraction` is `min(1 - calls_used/calls_cap, 1 - bytes_used/bytes_cap)`, clamped to [0, 1] and rounded to 3 decimals.

**Ordering.** No estimate holds background or agent-requested work. The re-wake and `list_pending` still name agent-requested (`normal`) work ahead of background work (such as PR reviews), and background work stays listed and claimable while agent work is queued. Already-claimed background work runs to its end; the bridge does not preempt it.

**Denied claims.** The default worker's permission reviewer can deny a claim; the bridge never sees that call. When a default worker progress note or report says a claim was denied and names a queued request ID, that note is the evidence: the bridge stops re-waking that request (the default worker does not retry a denied line) until something claims it. If the note also says "capacity", every re-wake holds until a claimed assignment completes, is abandoned or is cancelled (a slot frees), at most 30 min. `dalan get ID --json` shows `claim_denied`; `status --json` shows `claim_denied: {count, request_ids, capacity_hold_until}`; the alert `claim_denied` pages once while such a request is queued. Cancel or resubmit it.

**What counts as sensitive, and what a brief may name**:

- A source, test or doc file (`.ts`, `.py`, `.rs`, `.md`, ...) is not sensitive because a word in its name: `logout-cancels-credential-setup.test.ts` and `auth_session.rs` are code. Its name still refuses when it marks secret material: `.env*`, key and keystore extensions, `.ssh/`, `.aws/`, `.gnupg/`, `id_rsa*`, `kubeconfig`, `sign-*-release*`, password stores, a base name that is a secret word (`credentials.ts`, `secrets.py`, `private-key.ts`, `service-account.ts`, `owner-credential.ts`), and the policy's `sensitive_paths`. Shell scripts, SQL and images keep every name rule.
- Content gates what names no longer do: `read_file` returns a file with each secret value replaced by `[redacted secret]` and a `redacted` count (private keys; GitHub, AWS, OpenAI, Stripe, Slack, Google, GitLab and npm tokens; a URL with an inline password to a non-local host), check output previews mask such values, and a PR diff or patch that contains one is refused at submit.
- The soft rule (auth, secret, credential, sign in a name) reads the file name only, not its directories, and a name without an extension (usually a directory) only matches credential-token names (`auth-token`, `api_key`).
- Code in a PR diff, an `input_patch` or an inlined diff is a reference, not a read: `payload.key`, `credentials.appleId` and `'.env.local'` in code pass. A host secret path in code (`~/.ssh/id_rsa`, `/home/u/.aws/credentials`) still refuses.
- In prose, a mention resolves against the repository tree. In scope, or a directory holding scope entries: fine. A tree file outside scope: eligible free-form read-only and `--review` work without structured objectives or explicit read lists adds it to `scope_paths` (after the sensitivity check, with a submission warning); implementation work refuses, naming every such path at once. A PR's changed files join the scope the same way. Structured briefs and explicit read lists keep their declared scope. A bare filename (`index.ts`) or abbreviated path (`x/util.ts`) that matches several tree paths outside scope, and a bare filename the tree lacks, refuse (see Scope fixes below); a tree directory outside scope, a slash path the tree lacks (a new file) and the other cases in that table only warn. Identifiers and routes (`input.privateKey`, `/v1`) pass. Host paths (`/etc/hosts`, `~/x`), `..` traversal, a file-like absolute path (`/README.md`), invalid path syntax and a file-shaped secret name (`.env`, `secrets.yaml`) still refuse.

## Reviewing a local patch

To have the default worker review a patch that is not on GitHub, submit a read-only assignment whose input carries it:
`inputs: [{github_repo, base_sha, input_patch: "<unified diff>"}]`, `execution_scope: "read-only"`. The bridge lints the patch as a diff (its paths must be in `scope_paths`; sensitive names and secrets refuse), the workspace applies it to `base_sha`, `read_file` sees the patched tree and `workspace_result` shows the diff. The default worker cannot change the workspace. Say in the brief that the patch is already applied.

Inlining the diff in the brief also works. The lint reads an inlined unified diff (raw `git format-patch` output or a fenced block) as code: its content lines and hunk-header context are not instructions, so regex literals, URL routes, shebangs and relative imports (`/changed/`, `/me`, `/usr/bin/env`, `../../x.js`) pass. Its `diff --git`/`---`/`+++` paths keep their scope checks, and a path-shaped hard sensitive name in the code (`./scripts/sign-release.mjs`) still refuses.

With `--exclude-sensitive`, bridge workspace tools enforce each dropped path in `scope_excluded`; see [Directory scopes and sensitive files](#directory-scopes-and-sensitive-files) for narrowing and its size limit. Symlinks inside a directory scope are dropped the same way (the workspace never follows one); a symlink you name still refuses.

## Writing checks

A check is an `argv` plus limits, in the owner's `~/.config/dalan/checks.json` (`{"owner/repo": {"checks": {"<id>": {...}}}}`, mode 0600) or the repository's `.dalan.json` (`{"checks": {"<id>": {...}}}`). A check named `api-contract-check` that runs other test files is a silent failure: the run is green and the named tests never ran. `test_paths` closes that gap.

`test_paths` is an optional list of repo-relative test files (or directories) that the check promises to run.

- At load, every entry that is a test file (`*.test.mjs`, `*.spec.ts`, `test_*.py`, `*_test.go`, and similar) must be named in `argv`, either as a whole element or as a whole word inside a `bash -c` script. A check that lists a test file its command does not name is invalid and is not offered in `available_checks`. A directory entry is not checked against `argv`, because a command such as `npm run test:sandbox` reaches its tests through a script.
- At run time, before anything runs, the bridge confirms each entry, file or directory, exists in the checkout. A missing entry fails the check at once with `check_test_path_missing: <path>`; no job row is made and no other tests run in its place.
- `run_check` results and the stored evidence include `test_paths`: the declared list, or the test files `argv` names when none is declared.

Example of a focused check:

```json
{"example-org/example-repo": {"checks": {"api-contract-check": {
  "argv": ["/runtime/node", "--test", "--test-timeout=120000", "tests/api-contract.test.mjs", "tests/worker-contract.test.mjs"],
  "test_paths": ["tests/api-contract.test.mjs", "tests/worker-contract.test.mjs"]
}}}}
```

`dalan doctor --checks [--json]` lints the owner's `checks.json` against each repo's mirror on this host (files at HEAD and at the newest ref). For each repo it prints every check id with the test files its `argv` names, and warns when an id sounds like a test file that `argv` does not run (for example id `api-contract-check` and file `tests/api-contract.test.mjs` absent from `argv`). Invalid definitions print as `ERROR` and make the command exit 1; warnings never change the exit code. The name match is a heuristic on file stems and id words, so read each warning as a prompt to look, not a proof. A repo without a local mirror gets the file listing only. Run it after you edit `checks.json`.

## Work orders: dry run, verdicts, exit codes

`dalan submit` runs one work-order compiler (`src/work-order.mjs`) before it stores anything. It reuses the checks that always guarded submit (size limits, scope and sensitive-path rules against the pinned tree, `output_paths`, execution capability, check readiness, PR preflight) and answers with a verdict, typed reasons and byte accounting. There is no separate intake step: the real submit and the preview use the same call.

`dalan submit --stdin --dry-run [--json]` uses `POST /submit-preview` and stores nothing: no assignment, no lifecycle event, no local receipt. It answers HTTP 200 for every verdict. The ACP adapter previews the exact prepared assignment before it submits it. This route requires a server that supports `/submit-preview`; an older server returns 404, and the CLI and ACP adapter stop without sending a submit. They do not fall back to `/submit`. `/submit` always submits and rejects `dry_run` flags. A CLI dry run uses one request; ACP already uses one preview request followed by one submit request.

| Verdict | Meaning | `submit` exit code |
|---|---|---|
| `admissible` | The current checks allow this submission. | 0 |
| `reject` | Invalid or forbidden: bad schema, unsafe path, sensitive path in scope, secret content, an oversized rendered brief or instruction set, an expired caller deadline. Retrying unchanged cannot work. | 2 |
| `clarify` | Ambiguous but fixable by the requester: a probable typo (the reason lists `candidates`), an ambiguous bare filename (it lists the paths it matches), a path the brief names outside `scope_paths`, missing `inputs` or `scope_paths`. | 3 |
| `defer` | The job cannot run now. Pause, owner-confirmed usage break and queue-threshold defers queue by default on a real submit; `--refuse-defer` refuses them without storing a job unless `--queue-anyway` is also set. Missing execution capability or unmet check prerequisites always refuse. The answer carries `retry_after_seconds`. | 4 when refused; see the real-submit behavior below. |

Other failures keep exit code 1: local checks before anything is sent (JSON, assignment shape, options, repository policy), untyped bridge errors, transport failures, bridge down and `request_id conflict`. A fresh submission that is refused stores no job and removes the receipt created by that call, so a corrected retry under the same `request_id` goes through. A deferred job that is admitted to the queue retains its job and receipt. `defer` queues by default during a pause, usage break or queue threshold; use `--refuse-defer` to exit 4 without storing a job or fresh receipt. `--queue-anyway` remains accepted for compatibility and does not bypass scope, capability or freshness checks (the raw HTTP API also queues unless the body sets `refuse_defer`). A host that cannot run the job at all (no executor, a missing capability, an unmet check prerequisite) is a `defer` that always refuses with HTTP 400 and exit 4: queueing it would only fail later, so `--queue-anyway` does not apply.

Each reason is `{code, field, message, fix}`, plus `candidates` or `suggested_scope_paths` where they apply. Codes: `invalid_field`, `brief_too_large`, `instructions_too_large`, `expected_output_too_large`, `sensitive_path_hard`, `sensitive_path`, `secret_content`, `authority_claim`, `invalid_path`, `invalid_output_paths`, `output_path_taken`, `output_path_sensitive`, `unknown_scope_path`, `undeclared_path`, `ambiguous_path`, `unknown_path`, `missing_inputs`, `missing_scope`, `diff_outside_scope`, `contradictory_scope`, `missing_test_scope`, `symlink_in_scope`, `head_sha_unsupported`, `invalid_valid_until`, `validity_expired`, `invalid_schema`, `check_prerequisites_unmet`, `capability_unavailable`, `capability_unsupported`, `worker_paused`, `usage_break`, `queue_depth`, `queue_full`, `background_capacity_full`, and `refused` for a refusal with no specific rule. A real refusal returns the same `verdict` and `reasons` next to the old `error` text (the text is unchanged).

`bytes` counts what the worker will see: `brief` and `instructions` count the final adapter assignment (a structured assignment is measured after it is rendered), `after_expansion` is the size after the bridge appends its scope allow-list, output-path block or scope note (`null` when a check refused first), `limits` are the caps and `over_by` is how far each size is over its cap. Cut at least `over_by` bytes. Malformed fields produce a typed rejection with `invalid_fields` and unavailable (NULL) counts.

**Validity window.** A normal-priority submission with no `valid_until` gets a queue-sized default only while the bridge is unpaused and its target worker has no applicable usage break. Background work receives no automatic deadline, and explicit caller deadlines stay unchanged. The window uses the p90 of submit-to-first-claim for its target worker and task kind over the last 7 days, times 3, within 15 minutes and 12 hours, once 5 rows exist. Expired unclaimed rows count as lower bounds. Preview shows the sample count, p90, factor, floor, cap and source. This is informational; it does not automatically defer a submission against the queue estimate. The value is stored beside the request (`valid_until`, `valid_until_source`: `requester`, `queue_p90` or NULL) and never written into the assignment, so the request identity does not change. `get` shows both. Below 5 samples the bridge generates no default. ACP keeps its compatible 30-minute deadline by default, independent of queue history. Set `DOT_ACP_VALID_MINUTES` to choose another explicit deadline. ACP freezes that deadline and body across retries; its stored source is `requester`. History is scoped to the selected worker and task kind. Historical rows retain NULL provenance because their origin is unknown. A learned `queue_p90` deadline stops applying after the first claim, even after requeue, while requester deadlines continue to expire queued work.

**Expiry is not an owner cancel.** The bridge cancels with `cancelled_reason: expired` (or `skipped_by_worker`) and a system lifecycle event. An owner may use the same reason text, but the owner lifecycle actor keeps it classified as an owner cancellation. `get`, `wait` and the inbox expose bridge-observed expiry and owner-cancel transitions separately. Lease expiry is reported as an observed bridge lease transition; it does not prove a vendor silently dropped work.

**Failure labels.** Bridge lifecycle transitions carry `failure_type_source: bridge_observed_transition`. Worker-reported blocked or failed outcomes use `worker_text_inference`; keyword matches describe report text and do not prove the cause. A previous `check_failed` event is reported separately and does not establish the cause of a later report. A lease expiry is a persisted bridge lease transition, not proof of a vendor silent drop; a later owner cancellation remains classified as an owner cancellation, even when its reason text is `expired`. Unknown and other cases stay `unknown`. Submit refusals carry typed `verdict` and `reason_codes` in request logs; transport errors and defers are not counted as correct policy denials. `node scripts/admission-measure.mjs [--since RFC3339] [--until RFC3339] [--db PATH] [--log PATH]` is a read-only report with a fixed, half-open time window. Objective and revision labels are logged as digests, never raw values; legacy labels are read only to compute the same anonymous cohorts. It reports request-ID retry groups and declared objective cohorts as proxies; deduplicated intent remains unknown without a binding. It counts explicit typed policy denials separately from legacy keyword guesses, uses submit-event time for refusal cohorts and terminal-event time for terminal outcomes, and reports missing timestamps. Terminal shares are percentages (0–100). A missing request log leaves admission metrics unknown; generic worker-blocked text stays in the unknown-cause share. Size-overflow coverage reflects observed bridge request-log byte fields; absent provider overflows are unobserved. Submit latency is per attempt from server request arrival to response, not first actionable response, owner read, intent use or task completion. Report expiry and owner cancellation separately; do not infer deployment improvements without a measured cohort.

Tests: `scripts/work-order-test.mjs`, `scripts/work-order-e2e.mjs`, `scripts/admission-measure-test.mjs`; the adapter matrix is `scripts/adapter-conformance-test.mjs` (clean, untracked-only and tracked-dirty checkouts, oversize brief, slow submit, compiler refusal, defer, outage, expiry, cancel).

## Destination disclosure and claim admission

Workers may opt in with a `destination` object on their existing worker entry. Keep connection, repository and capability settings; the declaration grants none of them. Supported fields are `operator`, `provider`, `data_categories`, `retention`, `training` and `terms`. Example worker-entry fragment:

```json
{"destination":{"operator":"Declared operator","provider":"Declared provider","data_categories":["assignments","results"],"retention":"30 days","training":"Declared training terms","terms":"Terms version or reference"}}
```

Omitted properties are unknown (null), not verified promises. Strings are limited to 2048 characters; data categories are a sorted, deduplicated set of at most 32 nonempty strings of at most 256 characters. Unknown keys and types are refused, and provider is not inferred from a nickname. Disclosure labels worker/job execution as checked, supplied terms as declared, and missing terms as unknown; these labels do not verify vendor behavior.

`POST /submit-preview` on the private owner socket returns `destination_disclosure`, including a `sha256:…` revision. It binds the complete normalized declaration, worker and actual job execution. Current repository-policy results remain separate restrictions. Object-key ordering and category-set ordering do not change identity; changed material terms do. Connection identities (issuer, subject, client_id, and connection_id when configured) are sorted and digested into the revision, so changing an identity requires new approval while reordering does not.

After review, explicitly send that exact revision as the top-level `destination_revision` on `POST /submit`. Missing approval is refused; stale approval returns `destination_changed` and the current disclosure without storing a job/wake. This first port exposes the private HTTP API only: existing CLI/ACP clients do not automatically approve or forward the revision. Do not enable declarations for those clients until they explicitly support this step.

The immutable `destination_approval` records snapshot, revision, approval time and owner-capability digest identity (never the capability itself), bound to this job/owner/worker. This is application-level approval by the local authenticated requester, not proof that a human read a notice or gave legal consent. Automated requesters need existing delegated authority. Exact retries repeat the original revision and owner capability and replay the original approval; changed or omitted revision conflicts, including with a command key. Notice records, banners, transport ACKs and worker fields never become approval.

Every fresh grant—new claim, takeover, reclaim, resume after expiry—compares the approved revision with current configuration and enforces current repository restrictions. Exact live duplicates retain the existing grant/epoch when they come from the connection that holds the grant, and they are not re-checked against current destination or repository policy (see PROTOCOL.md). Drift is committed durably before the error is returned: `destination_changed` exposes approved/current revisions, snapshots and readable differences through owner get and the existing `/wait` blocker delivery. Generation guarding prevents stale refusal state overwriting a successor. Delivery/ACK cannot unblock admission. Cancel and submit a new request ID after reviewing the current revision; no in-place reapproval exists.

**Linearization:** after awaited preflight/quiescence, the authoritative configuration is read synchronously inside the SQLite admission transaction. That read is the snapshot linearization point, not a lock against arbitrary filesystem writers; a replacement after it applies to later admissions. Publish complete valid files atomically, and do not run old/new bridge implementations concurrently against the database during upgrade. Native Store callers enabling declarations must provide a synchronous `destinationProfile` resolver. Bound jobs with no resolver or invalid/missing configuration refuse rather than falling back.

**Compatibility:** migration does not fabricate approval. An unbound job needs approval when the current worker declares a destination; a fresh admission returns `destination_approval_required`. Cancel and resubmit a new request ID with the current approved revision. Existing active grants retain their lease semantics, and an exact claim retry from the holding connection is not re-judged against a later declaration.

**Not egress protection:** list titles, wake events and worker get can expose job data before claim. This gate does not verify declarations, stop ongoing remote computation, retract sent data or prevent onward sharing. It is destination disclosure and claim admission.

Worker get omits the approval actor; private owner get and submit replies retain it. Direct deletion of an approval is refused while its assignment exists; deleting the assignment may cascade to the approval. A configured resolver that fails or returns an asynchronous result refuses admission, including for an undeclared, unbound job; it does not fall back to legacy admission. Legacy admission without a resolver requires no declaration and no required approval binding. Store destination configuration errors use fixed diagnostic categories, not resolver exception text.

Acceptance scripts: `node --test scripts/destination-revision-admission-test.mjs` and `node scripts/destination-revision-admission-e2e.mjs`. The HTTP journey uses synthetic local OAuth and inert local git/gh fixtures. Runtime/mutation verification and security review are required before merge.

## Refused submits

The bridge logs every refused submit as `submit_rejected` (request ID, reason, status, task kind) in the request log. `dalan rejections [--since RFC3339] [--json]` (default: the last 24 h) counts them by reason class against the submits accepted in the same window. Refusals the CLI makes before sending are not logged. A refused submit keeps no local receipt, so a corrected retry under the same request ID goes through; a receipt left by an older CLI is replaced when the bridge has no such request. Once the bridge stored a request, a different body under its ID is still `request_id conflict with local receipt`.

**Submit refuses instead of changing your request.** Implementation scope stays as declared unless you opt into a scope fix. Eligible free-form read-only and review jobs may grow scope automatically as described below. A refused submit stores nothing, keeps no receipt, and exits 2 (reject), 3 (clarify) or 4 (defer; see **Work orders** above) when the bridge returns a verdict (local validation failures exit 1), so a corrected retry under the same `request_id` goes through. Resubmitting an already accepted request with the same payload is still a duplicate match; the lint does not run again.

- An implementation brief keeps `scope_paths` as its repository write allow-list, with explicit `output_paths` separately authorizing new files; a repository file the brief names outside those declared paths refuses as `undeclared instruction path`. A scope entry the tree lacks refuses as `unknown scope path`; a file the job should create belongs in `output_paths` (below). The refusal lists every such path and the fix, for example `fix: add these to scope_paths: web/app.js`, `fix: remove these from scope_paths: nope/a.md, nope/b.md` and `fix: corrected scope_paths: [...]` (`--json` carries the lines as `fix`; the 400 body carries `suggested_scope_paths`). A host path, `..` traversal or invalid name in the same brief withholds the suggestion: change the brief.
- `--allow-scope-prune` is the opt-in for callers that want the old behaviour: submit applies `suggested_scope_paths` (adds the named files, drops unknown entries), retries once with the same `request_id`, and prints `changed scope_paths (added ...; removed ...)` to stderr. `--fix-scope` is the old spelling of the same opt-in; `--no-fix-scope` is now a no-op. The PR head reviewer passes `--allow-scope-prune`.
- A mention that predicts a broken job refuses with the fix in one message listing every offender: `ambiguous bare filename "dup.txt": it matches 2 repository paths outside scope_paths (...). Write the full path of the one you mean, for example docs/dup.txt instead of dup.txt`; `ambiguous abbreviated path "x/util.txt"` (same fix); `unknown bare filename "other.txt": it is not in the repository tree. Write the full repository path of the file (a new file needs its full path too; ./name names a file at the repository root), or remove the mention`. For jobs whose scope cannot grow automatically, a bare filename that resolves to one tree file outside scope names the full path to write: `undeclared instruction path: src/a.ts (the brief names it as "a.ts"; write the full path)`. A match already in scope satisfies the mention. For a new root file, mention `./name` and declare canonical `name` in `output_paths`.
- Warnings that still queue are printed to stderr as `dalan: WARNING: ...` and returned as `submission_warnings`: a bare word that matches a path outside scope (prose, not a path); a directory outside scope; a route or host directory (`/tmp`) named in prose; a slash path the tree lacks (a new file or a branch name); an excluded file the brief does not name; no room for the allow-list; sensitive files dropped by `--exclude-sensitive`; and scope growth (below).
- Still automatic, and reported as a warning: free-form read-only and `--review` work without structured objectives or explicit `read_paths` or `read_list` grows `scope_paths` by the files the brief names and the PR changes, and a free-form brief gets the allow-list appended (see below).

## Creating new files (output_paths)

`scope_paths` names files or directories that already exist at `base_sha`. A new file cannot itself be a scope entry (`unknown scope path`). Explicit `output_paths` separately authorize new files as readable and writable outputs, including outputs outside `scope_paths`. A read-only job may write only these declared outputs; it may not change existing scoped inputs or arbitrary files. Without `output_paths`, it has no writable files.

- `output_paths` is an optional list of at most 10 repository-relative FILE paths, each at most 256 characters. No directory, glob, `..`, absolute path, leading `./`, trailing `/`, `.git` segment or duplicate. The pinned repository input and `scope_paths` stay required.
- Each path must NOT exist at the pinned revision (or be a directory, or sit under a file), and must pass the same sensitive-name rules as `scope_paths`. Submit refuses the whole request, stores nothing, and names the fix in the error. To change an existing file, list it in `scope_paths` of an implementation job.
- `--review` takes no `output_paths`: review stays read-only, and submit refuses the combination.
- Implementation scope: `apply_patch` may create the listed files in addition to the `scope_paths` files. Once created, a file is readable and editable in the same job.
- Read-only scope: `apply_patch` is allowed only for patches whose files are all in `output_paths`; once created, those outputs are readable and editable in the same job. A patch that touches any other file is refused as a whole with `read_only_assignment`, and nothing is applied. `run_check` stays closed to read-only jobs. `workspace_result` and the sealed patch artifact then carry only the `output_paths` files.
- The field is part of the assignment, so it is covered by the request hash: a retry must send the same list. The bridge appends `Output paths (output_paths; may create):` and the list to the brief (a structured brief has the same section), so the default worker's reviewer knows the writes are allowed.
- The `[dot-build]` line of a [T3 build](t3-integration.md#builds-through-the-t3-worker-provider) is unchanged: it lists existing files only, and a path missing at HEAD is refused by the bridge as `unknown scope path`.

Build that adds a file and a test:

```json
{"scope_paths": ["src/parse.mjs"], "output_paths": ["test/parse-edge.test.mjs"], "execution_scope": "implementation"}
```

Research note written back as a patch instead of a hand-applied upload:

```json
{"brief": "Read the auth module and write the findings to docs/research/auth-notes.md.",
 "scope_paths": ["src/auth"], "output_paths": ["docs/research/auth-notes.md"], "execution_scope": "read-only"}
```

The owner reads the note from `workspace_result` (`diff_preview`) or the patch artifact sealed at finish, and applies it with `git apply`.

## Decisions

Every result you request gets one recorded decision. `dalan decide ID WORD [--note TEXT]` takes one of:

| Word | Meaning | Events written |
|---|---|---|
| `accepted` | The result was right and you used it | `accepted` |
| `applied` | You applied its patch or followed it | `accepted` with reason `applied` |
| `useful_no_change` | It was worth reading and changed nothing (for example, a clean review) | none besides the decision and the owner read |
| `useful_negative` | It was worth reading because it ruled something out | same |
| `not_useful` | It was wrong or a waste | `consumed` with reason `rejected` (the old `reject` event) |
| `stale` | Written only by the bridge: no decision after `DALAN_DECISION_STALE_DAYS` (default 7) | none; actor `system`, not a read |

`accept ID` and `reject ID` still work and are the same as `accepted` and `not_useful`. Decisions go to the append-only `decisions` table (schema version 44). A different decision is added and the latest one wins, so the history stays; the same decision again is a no-op. A decision on an unread result also records the read. Only a finished result can be decided. The bridge sweeps hourly (and at start) for finished results from the last 90 days with no decision, 500 per pass.

`dalan get ID` ends with `decide: dalan decide ID ...` on stderr when the result is finished (not with `--json`). The ACP adapter ends every result it returns to T3 with the same line.

**`dalan apply ID [--dir PATH]`** (default the current directory) downloads the patch artifact and checks its sha256 against the build evidence, then checks that the job's base commit is an ancestor of the checkout's HEAD (or HEAD itself), then runs `git apply --check` and `git apply`. Any failed gate prints the reason and changes nothing. On success it records `applied`. If the decision call fails after the patch applied, the error says so and gives the `decide` command.

**ACP adapter.** After a build result with a patch, the adapter remembers it for the session (the last 5). On the next prompt it checks whether the patch reverses cleanly against the working directory. A match produces an advisory message once. It never records an owner decision: the same change could predate the build or be a rejected trial. Only an explicit decision or a successful `dalan apply` records `applied`; neither proves verified owner use.


## Directory scopes and sensitive files

A directory in `scope_paths` can hold a sensitive file the submitter never named (for example `.env` or a credential file). By default the whole submit fails with `sensitive scope path: <file>`. `dalan submit --exclude-sensitive` drops those files from the scope instead: the stored `scope_paths` becomes the smallest list of directories and files that covers everything else, and `scope_excluded` (path and reason, one entry per file) is stored with the assignment, logged as `scope_excluded`, and returned in the submit response. The brief gets a one-line note naming them. `scope_paths` is enforced by bridge workspace tools: `list_files` omits excluded paths and `read_file` refuses them. This does not sandbox an agent's unrelated external tools. `read_paths` and `read_list` follow the narrowed scope. This only narrows the scope, and only for read-only work: an implementation scope is not narrowed, because a file list would forbid new files. The narrowing also covers the files a PR's diff touches, and the instruction size limit applies to the narrowed result. A submitter cannot send `scope_excluded` itself. A retry's response repeats it from the stored assignment. A path the submitter named still fails: an explicit scope entry, a path in the brief or read list, or a file in the diff. If narrowing would need more than 200 entries, the original scope (including `.`) remains and `scope_excluded` still denies every dropped file. If every file is sensitive, submission still fails. The flag is not part of the request identity: a retry with or without it is a duplicate.


**Allow-list in the brief.** The bridge documents the authorized read allow-list in the brief: it appends `Read allow-list (scope_paths; ...)` with every scope path to a free-form brief (structured briefs already have one), subject to the size limits. A brief that mentions an excluded file without naming it gets a submission warning. A retry with the original assignment still matches.

## Uploading artifacts (worker side)

A worker with a claim can attach files (a report, a log, a patch it built elsewhere) to its `finish`. Upload them with `artifact_chunk`, then name them in `finish.artifact_ids`. This works for read-only and implementation claims. It needs the workspace capability; with the workspace off, `artifact_chunk` remains advertised but calls fail with `capability_not_enabled`; `finish` with nonempty `artifact_ids` fails with the same error.

**IDs.** The worker chooses the ID. It must match `^art_[a-zA-Z0-9_-]{8,128}$`: the literal `art_`, then 8 to 128 letters, digits, `_` or `-`. A fresh `art_` plus a UUID works. The ID is an alias that is unique only inside one request. The bridge stores the bytes under its own global ID (`art_` plus 48 hex digits derived from request, claim and your ID). The worker keeps using its own ID in later chunks and in `finish`. Each artifact in `get` also shows `origin_epoch` (the epoch that first created it) and `inherited: true` when an earlier epoch created it and a later claim now holds it. Only the owner `get` shows `origin_claim_id` (the claim that first created it), on artifacts and in the `finish` workspace evidence; worker replies, including the `claim` reply and worker `get`, omit it. A takeover carries only SEALED uploads (sealed and sha256 verified) to the new claim, which can cite them. An upload that was not sealed when the epoch ended stays bound to the old claim: the new epoch cannot append to it, seal it or cite it. If the new epoch uploads under the same alias, it starts a fresh upload at offset 0; the alias then means the new row. The old unsealed bytes stay as evidence until retention cleanup removes them. Worker tool replies use the worker-chosen alias. Owner `wait --json` and `get --json` expose the server's globally unique artifact ID; pass that ID, not the worker alias, to `dalan artifact ARTIFACT_ID --output FILE`.

**`artifact_chunk` fields.**

| Field | Required | Rule |
| --- | --- | --- |
| `request_id`, `claim_id` | yes | Must name an active claim of this worker. |
| `artifact_id` | yes | The ID format above. |
| `offset` | yes | Integer, 0 or more. Byte position of this chunk in the file. |
| `data_base64` | yes | Standard base64 with `=` padding (not URL-safe). An empty string is allowed. The decoded chunk may not exceed 65536 bytes (64 KiB). |
| `final` | no | `true` on the last chunk. It seals the artifact. |
| `sha256` | with `final` | 64 hex digits of the whole file. Upper-case hex is accepted; the bridge lower-cases it before the compare. |

The whole artifact may not exceed 8 MiB (8388608 bytes). A `finish` may list at most 8 `artifact_ids`.

**Order.** The first chunk of an ID must have `offset` 0. Each next chunk must have `offset` equal to the bytes stored so far; the reply field `offset` is that number. Send the last chunk with `final: true` and the SHA-256 of the full file. The bridge hashes the stored file and seals it only if the digests match. A sealed artifact cannot change. After the seal, call `finish` with the IDs in `artifact_ids`; each ID must be sealed and belong to this claim.

**Retries.** A chunk at an earlier offset is accepted if its bytes equal what is stored (a lost reply is safe to retry). If it differs, the call fails with `conflicting chunk retry`. Repeating the exact final chunk of a sealed artifact (same offset, same bytes, same `sha256`) returns success again.

**Reply.** `{artifact_id, offset, sealed, sha256}`. `offset` is the stored size. `sha256` is `null` until sealed.

**Errors from `artifact_chunk`.**

| Message | Cause |
| --- | --- |
| `assignment not found` | The request does not exist for this worker. |
| `invalid claim` | `claim_id` is not the active claim for this worker and subject. |
| `lease_expired` (JSON message `{error, message, request_id, lease_expires_at}`) | The lease of this claim ended at `lease_expires_at`. The claim cannot act and the call changed nothing. Claim the request again. |
| `assignment_finished`, `assignment_cancelled`, `claim_superseded`, `assignment_not_claimed` (JSON message `{error, message}`) | The workspace of this request is closed. The message names the request and says only that request is affected. `assignment_finished` is normal after `finish`. `assignment_cancelled` includes the `cancelled_reason`. Other assignments are not affected. |
| `invalid artifact_id: must match art_ followed by 8 to 128 letters, digits, _ or -` | `artifact_id` does not match the format above. |
| `invalid offset: must be a whole number, 0 or more, equal to the bytes stored so far` | `offset` is not a whole number, or is negative. |
| `invalid data_base64: must be a string (an empty string is allowed)` | `data_base64` is missing or not a string. |
| `invalid data_base64: must be standard padded base64 (A-Z a-z 0-9 + /) without line breaks or white space` | URL-safe characters, missing padding, white space or line breaks. |
| `chunk too large` | The decoded chunk is over 65536 bytes. |
| `artifact binding mismatch` | This ID already exists in this request under a different claim. |
| `wrong upload offset` | A new ID did not start at 0, or the offset is past the stored size (a gap). |
| `artifact id collision` | The derived global ID already exists. |
| `artifact too large` | The chunk would take the file over 8 MiB. |
| `conflicting chunk retry` | The offset is earlier than the stored size and the bytes differ, or the chunk runs past the stored size. |
| `artifact sealed` | A chunk arrived for a sealed artifact and it is not an exact repeat of the final chunk. |
| `final chunk needs sha256: the 64 hex digits of the whole file` | `final` is true and `sha256` is missing. The chunk is stored; send the final chunk again with `sha256`. |
| `artifact digest mismatch` | On `final`, the SHA-256 of the stored file is not the `sha256` you sent. The artifact stays open. |
| `upload file missing`, `upload file truncated`, `interrupted upload differs; operator repair required` | The stored file does not match the bridge record, for example after a crash. The owner must repair it; a retry does not help. |

**Error from `finish`.** `invalid sealed artifact` means an ID in `artifact_ids` does not exist in this request, is not yet sealed, or belongs to another claim.

**Example.** A 100-byte log sent as two chunks, then `finish`. The IDs and digest are for illustration.

```json
{"name":"artifact_chunk","arguments":{"request_id":"req_1","claim_id":"clm_1","artifact_id":"art_review-log-1","offset":0,"data_base64":"<base64 of bytes 0-59>"}}
```
Reply: `{"artifact_id":"art_review-log-1","offset":60,"sealed":false,"sha256":null}`

```json
{"name":"artifact_chunk","arguments":{"request_id":"req_1","claim_id":"clm_1","artifact_id":"art_review-log-1","offset":60,"data_base64":"<base64 of bytes 60-99>","final":true,"sha256":"<64 lower-case hex digits of all 100 bytes>"}}
```
Reply: `{"artifact_id":"art_review-log-1","offset":100,"sealed":true,"sha256":"<same digest>"}`

```json
{"name":"finish","arguments":{"request_id":"req_1","claim_id":"clm_1","outcome":"completed","summary":"Review done; full log attached.","result":"See artifact art_review-log-1.","artifact_ids":["art_review-log-1"]}}
```

The owner then runs `dalan wait REQUEST_ID` (or `get`) and `dalan artifact ART_ID --output FILE` (a new file in an existing directory; `artifact` does not overwrite or create directories). Either `wait` or `get` is enough before `artifact`; if the owner is unknown, `artifact` says `artifact owner unknown; run dalan get REQUEST_ID or wait REQUEST_ID first`.

<a id="writing-briefs-the-default-worker-will-accept"></a>

## Writing briefs the default worker will accept

A worker may refuse work outside its permissions or safety constraints. Write the goal and the protective intent, and describe the failure you want to prevent, not a way to cause it. Avoid attack phrasing such as "find ways to kill or stop the service", "escape the sandbox", "bypass the check", "exploit". Name the asset to protect (user data, uptime) and the property to verify.

| Ambiguous brief | Better |
| --- | --- |
| "Find ways to kill or stop the service." | "Verify the service shuts down cleanly: no in-flight write is lost, and the next start recovers its state." |
| "Find a sandbox escape in the worker." | "Check that the worker can read and write only inside its assigned directory, and list any path where that boundary is not enforced, so we can close it." |
| "Show how the installer could delete user data." | "Verify the installer cannot delete user data: list every code path that removes files, and say what guards each one." |

If a review is refused, record the reason and resolve the underlying scope or authorization issue before submitting materially changed work.


### Masked dependencies in checks

The sandbox reads sensitive paths as empty, read-only files. A failed check now prints `masked as empty: …` beside its output, prioritizing paths named by the error. The bounded preview points to the full masked-path list in the check evidence artifact. A masked source dependency can cause missing exports or an invalid query before any test runs.

An operator can approve reviewed source bytes for sandbox execution in the mode-0600 `~/.config/dalan/submission-policy.json` file:

```json
{
  "version": 1,
  "sensitive_paths": [],
  "exceptions": [],
  "sandbox_source_exemptions": [
    {
      "github_repo": "example/reader",
      "path": "src/credentials.ts",
      "blob_sha": "0123456789abcdef0123456789abcdef01234567",
      "reason": "Reviewed library source; contains no credential values"
    }
  ]
}
```

Use the Git blob hash of the reviewed file, for example `git rev-parse HEAD:src/credentials.ts`. Each pin matches the exact repository, path and file bytes; it continues to work in later revisions while those bytes are unchanged. Changed bytes, a symlink, or a mismatched pin leave the path masked. Source code and SQL query files are eligible; environment files, keys and credential data remain ineligible. The sandbox mounts a verified copy read-only in both phases, so install commands cannot replace the approved bytes. This changes no worker file permissions and grants no exemption through an assignment or repository configuration. Keep the existing policy entries when adding a pin.

`--allow-scope-prune` only applies the server's suggested scope correction and retries once. There is no import-closure flag. Checks already execute against the full checkout, subject to masking; explicit `scope_paths` control worker reads and writes. A caller that needs additional source files should name them explicitly or choose a suitable directory scope with `--exclude-sensitive`. Scope flags do not unmask dependencies.
