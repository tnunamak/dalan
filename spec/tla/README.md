# Job connection authority state paths

## Current status

This directory records which authority rules hold in the code and which are known limits. Run the Node suites and the TLC configs below to check it. Nothing here depends on an earlier baseline.

| Rule | Node replay | TLC config | Status |
| --- | --- | --- | --- |
| GrantAdmitted | `GrantAdmitted` (Store, HTTP) | `Claims.cfg` | holds |
| RevokedCannotCommit | two Store tests, one HTTP test | `Claims.cfg` | holds: finish checks connection liveness inside the committing transaction (`RefuseFinish` in the model) |
| CancelWins, ResultDurable, AtMostOnce, RequesterAtMostOnce | controls | `Claims.cfg` | hold |
| NoStuck | `NoStuck` (Store) | `Lease.cfg` | holds: `sweepStaleLeases` releases an expired dead holder whether or not a usage break is open |
| ReadAdmitted | `ReadAdmitted/get`, `ReadAdmitted/list_pending` (HTTP) | `ClaimsReads.cfg` | **known limit**: a replacement connection can read jobs approved for the connection it replaced; it cannot claim or write. See SECURITY.md, "Known limits" |
| QueueProgress | `QueueProgress known limit` (Store) | `Queue.cfg` | **known limit**: a drifted undated queued job stays queued until the owner cancels it or restores the destination. See SECURITY.md, "Known limits" |

The two known limits have Node tests that pin today's behavior and TLC configs that report the matching violation (exit 1). A change that closes a limit must update the test, the config expectation and SECURITY.md together.

TLC run on 2026-11-06 with tla2tools 1.7.4, one worker: `Claims.cfg` no error (28,998 states generated, 4,296 distinct); `Lease.cfg` no error (53 generated, 20 distinct); `ClaimsReads.cfg` ReadAdmitted violated (3 actions); `Queue.cfg` QueueProgress violated (11 generated, 5 distinct). Command: `java -cp tla2tools.jar tlc2.TLC -workers 1 -deadlock -config Claims.cfg Claims.tla`.

The sections below keep the original requirement text and the archived results in `results/`. Where they say a rule was open or TODO, the status table above takes precedence. No production source changes are part of this directory.

## Reproduce

Use Node 24 or newer and `npm ci --ignore-scripts`. Run from the repository root:

```sh
node --test --test-reporter=tap --test-timeout=45000 scripts/claim-statechart-test.mjs scripts/claim-statechart-http-test.mjs
```

Both suites are registered in `scripts/test-segments.json` with a hard `timeout --kill-after=5s 90s` and a 60 s per-test limit.

Set `DALAN_STATECHART_TMP` to `$SCRATCH_DIR/dalan-statechart/` to use a scratch directory. Fixtures close SQLite, stop child servers and delete their directories. Every wait in the HTTP suite has a bound: `as-init` (30 s), server start (20 s), each admin and MCP call (5 s), the IPC barrier (5 s in the test, 30 s in the server-side gate), and child exit (2 s after SIGTERM, then 2 s after SIGKILL). The HTTP suite uses real built-in bearer verification, connection replacement, owner submission and MCP dispatch. It seeds synthetic grant/token records in the real AsStore, rather than exercising browser pairing. A test-only `--import` module pauses the actual `Workspace.makeRoom` await in finish; the parent revokes the connection and releases that await. The production server and Store are otherwise unchanged. No external services or executor are required.

## What each assertion requires

Nested `t.test('desired contract', ...)` assertions state the required behavior. Their normal parent owns setup, operations, response-shape controls, barrier handling and cleanup; unexpected errors there fail the run. Every replay first proves its setup: the job is submitted and queued, the claim returns a `claim_id` and epoch 1, and the connection set is what the test says (`liveConnectionIds`). Over HTTP each replay also makes authorized control calls, with HTTP 200 and a decoded result, for the connection that is later refused: A claims, B lists its own job. Then it requires an exact outcome:

| Test | Exact refusal or transition | Unchanged afterwards |
| --- | --- | --- |
| GrantAdmitted (Store, HTTP) | B's repeat of A's claim fails with code `destination_changed` (HTTP: status 200, tool error with that JSON code) | the claim row (claim ID, epoch, state, activity, lease and deadline columns), reports and lifecycle log |
| ReadAdmitted get, list_pending (HTTP) | B's `get` of A's job fails with `destination_changed`; B's `list_pending` succeeds, lists B's own job and omits A's | the assignment, claim, report and lifecycle rows |
| RevokedCannotCommit (Store x2, HTTP) | finish after revoke or replace fails with `connection_not_live` | the claim row, assignment status and the absence of any report; HTTP compares the state taken at the barrier |
| NoStuck | with a break open, the claim expired and no live holder, `sweepStaleLeases()` returns the job ID, the job is `queued`, the claim is `abandoned` with reason `lease_expired`, and the log has one `abandoned` event by actor `system` with that reason. The control test requires the same transition with no break. | no report |
| QueueProgress | B is live and its claim fails with `destination_changed`; after a year of sweeps the job is `cancelled` with `cancelled_reason` `destination_changed` and one `cancelled` event by actor `system` with that reason | no claim and no report |

The codes `destination_changed`, `connection_not_live` and `lease_expired` already exist in the Store. For ReadAdmitted, RevokedCannotCommit and QueueProgress the code is this suite's choice of contract, because the historical baseline did not refuse. A fix that picks another name must change the test with it. HTTP tool counters (`tool_calls`, `last_tool*`) are not compared, because an authenticated refused call may count as a call; `last_claim_activity_at` is.

HTTP 500, an invalid token (401), a JSON-RPC error, a wrong claim or request ID (an error with a different code) and a success reply never count as a refusal. `assertion guards` in the Store suite checks those shapes against the helpers. For the HTTP suite, `DALAN_STATECHART_MUTATE` corrupts the one call under test, and the passing GrantAdmitted/http test must then fail:

```sh
for m in http500 bad-token wrong-claim; do DALAN_STATECHART_MUTATE=$m node --test --test-name-pattern=GrantAdmitted scripts/claim-statechart-http-test.mjs; done
```

`http500` sends the call to a stub that returns 500, `bad-token` sends an invalid bearer, and `wrong-claim` replaces the claim or request ID with an unknown one. Each run exits 1.

To check that a setup failure is reported as a normal failure, inject it into the HTTP fixture before server startup:

```sh
DALAN_STATECHART_MUTATE=setup node --test --test-name-pattern=ReadAdmitted scripts/claim-statechart-http-test.mjs
```

Expected: nonzero exit, normal parent failures with `injected setup failure`.

The Node replays above do not require the chart-generation tool. The checked-in charts are archived outputs and cannot be regenerated from this repository yet. The recorded raw TLC output, Mermaid and reports are in `results/`, with lease and queue checks in their own subdirectories. `tlc.out` is the original check; the tool rechecked after removing each broken invariant so subsequent failures and holding rules were checked too.

## Expected outcomes

| Model/config | Rule | Expected |
| --- | --- | --- |
| Claims.tla / Claims.cfg | GrantAdmitted: only an admitted connection gets or renews a grant | HOLD |
| Claims.tla / ClaimsReads.cfg | ReadAdmitted: only an admitted connection reads the assignment | BREAK, shortest safety path 3 actions (known limit) |
| Claims.tla / Claims.cfg | RevokedCannotCommit: a connection revoked before commit cannot commit | HOLD |
| Claims.tla / Claims.cfg | CancelWins: cancellation never publishes a result | HOLD in the bounded model |
| Claims.tla / Claims.cfg | ResultDurable: finished jobs retain their result | HOLD in the bounded model |
| Claims.tla / Claims.cfg | AtMostOnce: at most one committed result | HOLD in the bounded model |
| Claims.tla / Claims.cfg | RequesterAtMostOnce: submit retry cannot create a second job | HOLD in the bounded model |
| Lease.tla / Lease.cfg | NoStuck: a dead holder eventually releases the claim | HOLD |
| Queue.tla / Queue.cfg | QueueProgress: every queued state eventually admits a claim or cancels with a reason | BREAK after immutable approval drifts (known limit) |

`ClaimsReads.cfg` and `Queue.cfg` are expected to exit **1** (known limits); `Claims.cfg` and `Lease.cfg` are expected to exit 0. NoDeadlock holds because terminal states and idle time have explicit stuttering actions. No invariant was removed or weakened in the committed configurations. Lease progress uses weak fairness for clock advancement and sweeping. No fairness assumption forces an owner to undo a break or cancel a job. The queue trace is a valid behavior even with fair clock/sweep ticks: they leave this undated, unlisted, unclaimed job unchanged. TLC's invariant traces are shortest; its temporal lasso traces are counterexamples, not a claim of globally shortest lassos.

## Paths and real-code evidence

### GrantAdmitted

1. Owner approves A; requester submits the job with A's destination revision.
2. A claims with claimant `run` and acquisition `acq`.
3. Owner replaces A with live B for the same worker.
4. B repeats `run` / `acq`. Before destination admission was checked on duplicate claims, B received A's claim ID and epoch, and the legacy duplicate path also touched activity.

Replays: `claim-statechart-test.mjs` and `claim-statechart-http-test.mjs`, tests named GrantAdmitted. The destination-admission fix checks the destination before the duplicate branch. In the recorded post-fix baseline, B received `destination_changed`, A's claim was unchanged, and both replays passed. Claims bind worker and OAuth subject (`owner` for both), not the connection that acquired them. Fresh, idle-rotation and takeover admissions refuse drift; the positive control exercises those actual Store branches.

### ReadAdmitted

1. Owner approves A; requester submits a queued job approved for A.
2. Owner replaces A with B.
3. B calls `get`, or calls `list_pending`. Get returns the brief; list returns its first 160 characters as the title.

Replays: both named ReadAdmitted HTTP tests. `server.mjs` filters by `store.mayAct(worker,id)`; get and list do not compare the caller connection with the immutable approval. PROTOCOL.md v6 explicitly says pre-claim list/get/wake disclosure remains possible. This check keeps the stronger requested rule and reports that disagreement.

### RevokedCannotCommit

1. Owner approves A; requester submits.
2. A claims.
3. A begins finish and passes grant validation before the awaited workspace work.
4. Owner replaces A with B (TLC's shortest trace), or revokes A (the supplied review case).
5. Finish resumes and commits a report, although A is no longer live.

Replays: the two Store tests named RevokedCannotCommit cover replace and revoke separately. The HTTP replays share the same claim/finish/`makeRoom` barrier flow. The normal live control leaves A live and requires HTTP 200, decoded success, one report and a finished assignment with its claim still unabandoned. The revoke replay revokes A, resumes finish and checks both the response and the number of persisted report rows. In the historical baseline, finish returned a stored receipt and one report row existed, against the required refusal `connection_not_live` with no report. In that baseline `assertFinishClaim` / `assertClaim` revalidated subject, worker, claim and lease, but not built-in connection liveness. A fresh HTTP call using revoked A's bearer is refused with HTTP 401 in the positive control, so the finding concerns a request already authenticated before revocation.

### NoStuck

1. Submit the approved job.
2. A claims with a 10 ms lease.
3. Owner starts a usage break after A's last authenticated call.
4. Advance the clock 5 ms.
5. Revoke A; no connection is live.
6. Advance the clock another 6 ms. Repeated sweeps leave the expired claim held while the break remains open.

Replay: NoStuck Store test. `sweepStaleLeases` explicitly excludes legacy worker claims during an active break. Finite tests cannot establish infinity: the model supplies the fair infinite lasso; the test reaches its state and exercises the unchanged sweep; the code predicate explains why further time cannot release it. The current protocol documents break-aware sweeping. Closing the break or owner cancellation recovers the job, but neither is guaranteed by the requested unconditional rule.

### QueueProgress

1. Submit an A-approved queued job without a preparation deadline and without listing/skip history.
2. Replace A with B. Keep B live and leave the immutable approval unchanged.
3. Clock/sweep stuttering continues forever; every fresh claim refuses destination drift and no automatic cancellation predicate matches.

Replay: QueueProgress Store test. It tries the new B claim, checks `destination_changed`, advances one year and runs expiry, lease and skip sweeps. The job is still queued without a cancellation reason. The model's lasso starts after step 2; the test's refusal and sweeps replay its stuttering suffix. `sweepExpired` requires `valid_until`, `sweepSkipped` requires listing/skip evidence, and lease sweeping requires a claim. The protocol calls cancel/resubmit with a new ID the recovery path. It does not promise automatic recovery.

## Passing real-code controls

The new suites also check cancellation keeps bounded late output as audit evidence without a report; one lost submit reply or one lost finish reply survives one restart without another job/report; finish replay still returns its original receipt after lease expiry; revoked bearer calls and another worker's get are refused; fresh, idle and takeover drift admissions refuse; and native v5 fixed-lease claim retry plus keyed renewal replay do not slide deadlines. Expired native grants cannot renew. These extend the requested rules with PROTOCOL.md's fixed lease, receipt replay, epoch admission and audit-only cancellation requirements.

The two known limits are pinned by tests that assert today's behavior and name it as a known limit; no test is marked TODO. Raw TAP includes each assertion and observed value.

## Model scope and limits

A and B are real connections for one named worker. An arbitrary other worker is an explicit denied/no-change action and an HTTP negative control. Owner and requester share the same cancellation transition because both ultimately authenticate the saved owner capability. Approval and first submit are combined into one atomic action; they bind A immutably. The clock has two remaining-lease ticks. Epoch numbers saturate/toggle to keep the graph finite; they represent fresh authority rather than unbounded numeric IDs. Regrant represents the admission common to idle rotation and takeover, while Store replays exercise each route. The lease model isolates legacy worker claims; the queue model isolates an undated job. The safety model includes fixed and sliding lease modes. Explicit native renewal details are tested in code, not modeled as their own keyed command ledger.

The fresh-epoch destination-admission check is represented by requiring live A and matching approval. B cannot start a fresh epoch. The `Duplicate` action still lets live B renew, modeling behavior from before duplicate-claim destination admission was added; the model's read branches also remain open. Regenerate the models after changing `Duplicate` to require live A. This is not a claim about empty approvals, undeclared destinations or external OAuth.

Restart preserves durable job/result identity. The model does not simulate WAL crash windows, filesystem failures, the restart grace period for sweeping, cryptographic OAuth, refresh races, multiple requests, capacity pressure, repository preflight internals, stop receipts, uncertain deliveries, artifacts, questions, retention tombstones or actual remote compute. A model HOLD is bounded evidence, not a proof of all production behavior. Result and retry rules are deliberately checked in the real SQLite implementation as well, because the abstraction encodes atomic persistence and same-ID retry. No host executor or live provider was exercised. Confidence is high for the reproduced paths, limited to the stated scope for global guarantees.

Charts show only bug paths for the safety model because it exceeds 500 states. The smaller liveness charts retain the full graph. Self-loops merged by the skill are recorded in each generated report; no custom step hiding is used. The state label distinguishes fixed leases so the break-blocked sweep cannot be confused with a fixed-deadline sweep.

## Recorded results

`results/main.tap` is the unedited TAP output of both Node suites on this tree (checkout paths replaced by `<repo>`). It reports 23 tests, 23 pass, 0 fail, 0 TODO:

```text
# tests 23
# suites 0
# pass 23
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

TLC outputs (tla2tools 1.7.4, one worker, `-deadlock`): `results/tlc.out` (`Claims.cfg`, no error, 28,998 states generated, 4,296 distinct), `results/lease/tlc.out` (`Lease.cfg`, no error), `results/tlc-reads.out` (`ClaimsReads.cfg`, ReadAdmitted violated: known limit) and `results/queue/tlc.out` (`Queue.cfg`, QueueProgress violated: known limit). Of the earlier rendered charts only [queue progress](results/queue/chart.svg) is kept, with its Mermaid source and shortest-path report; the charts for the safety and lease models showed paths that the code no longer allows.
