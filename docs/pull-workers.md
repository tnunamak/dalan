# Pull workers: how a worker without push finds work

Most cloud agents cannot receive a push from your bridge. They act only when something starts a run: a schedule, a hook, or a person. This page shows how to wake such a worker, the "pull worker", and what each run must do. The patterns do not depend on the vendor.

Worker support depends on the client and its scheduling features. See the support matrix in the [README](../README.md#support-matrix).

Start a new [ChatGPT worker](chatgpt-worker-onboarding.md) or [Claude worker](claude-worker-onboarding.md) with a manual, repository-free, execution-none smoke. These recipes do not establish background-worker availability. Leave schedules and hooks off until a separately authorized, vendor-specific acceptance run; the optional patterns below are not onboarding defaults.

## What one run does

Each run checks the worker's MCP connector. The bridge stores the job, progress and owner notes. An independent run needs no earlier grant, but a run that continues after a QUESTION/answer pause or reconnect must retain its acquisition ID, claimant and claim ID. A new run cannot use an active grant merely because `get` shows it.

1. Call `list_pending`. For a saved continuation, read any `attention` notes with `get` and continue under the saved grant; skip the new acquisition step below. Otherwise choose a claimable assignment from `assignments`. If neither needs work, stop. An empty run costs one tool call.
2. Generate a random `acquisition_id` for this independent run and call `claim` on one job with that ID and a stable `claimant`. Save them with the returned `claim_id` and epoch. Reuse the acquisition ID for retries and continuation of this run. The default lease is 60 minutes. You can request `lease_ms` from 1 ms up to the owner-configured maximum; the bridge stores that duration on the grant and returns `lease_expires_at`. Matching live retries keep the stored duration. A competing live acquisition returns `claim_busy`; pick another job, or stop. Expired idle own claims can rotate as described below.
3. Read the job with `get`. Do the work. For repository jobs, use `list_files`, `read_file`, `apply_patch` and `workspace_result`.
4. Call `progress` while you work. Accepted claim-bearing activity slides a legacy non-protocol lease; `get` does not. Native protocol leases have a fixed deadline: activity and repeated `claim` do not slide it. Use explicit `renew_claim` with the current grant, command key and revision before expiry.
5. To ask the requester a question, send `progress` with a note that starts `QUESTION:`. The requester answers with `dalan note REQUEST_ID TEXT`. `list_pending` lists claimed jobs with unread owner notes under `attention`, and `get` shows the answer. QUESTION records waiting history but does not pause the lease, stop compute or renew authority when the answer arrives. Continue with the saved grant while it remains valid. If an independent later run takes over, it must use its own acquisition and wait for lease expiry and verified effect-channel cessation; it must not copy the earlier grant from `get`.
6. Call `finish` with the report. If the response carries `next_queued`, claim `next_queued[0]` yourself before the run ends. On any wake, call `list_pending` and claim up to `free_lanes` assignments, oldest first, instead of claiming only the event's `request_id`. After any claim error such as `assignment_expired`, call `list_pending` again before you claim another. For builds, inspect `workspace_result` first; the bridge computes the patch from the workspace changes.

Messages that the owner sends with `dalan tell` show up in `list_pending`; read them, then call `ack_message`.

Put this loop in the worker's standing instructions, for example in its scheduled task prompt. The bridge also returns short guidance in each `get` response.

## Ways to start a run

| Pattern | How it works | Latency | Cost when idle | Use when |
|---|---|---|---|---|
| Native schedule | The vendor runs the worker on a timer, and every run does the loop above. | Up to one interval | One empty run per interval, from your plan allowance | The vendor has schedules and you can accept the delay |
| Signal hook | A small script on a timer polls the bridge's wake signal. It starts a worker run only when work is waiting. | One hook interval plus the vendor's start time | One HTTP request per interval, with no model run | The vendor runs hooks or scripts without connector credentials |
| Manual | A person tells the worker "check the bridge". | Whenever someone does it | None | Trials and recovery |

**After a reboot or login, nothing here restarts by itself.** Dalan starts the bridge service but starts no worker, and it supplies no scheduler, hook installer or `wake` command. Native schedules and hooks live in the vendor's tool, and Dalan does not support them across a reboot. The supported journey is manual: check the bridge, prompt the worker, check the result (see [After a reboot](service-setup.md#after-a-reboot)).

Use more than one. A signal hook gives speed, and a slow native schedule (for example every 15 minutes) catches anything the hook misses. Two runs that wake at once do no harm: `claim` is atomic, so only one of them gets the job.

## The wake signal

The wake signal is a public URL that answers one bit: is a job waiting for this worker? It needs built-in auth mode. In oauth and legacy modes the route does not exist.

Create the URL on the bridge host:

```sh
dalan connect signal-token --worker NAME          # save this worker's URL privately; print the file path
dalan connect signal-token --worker NAME --rotate  # replace it; the old URL answers 404 at once
```

Each worker has its own URL. A hook with one worker's URL cannot see other workers' queues.

The answer is exactly `{"work":true}` or `{"work":false}`. It has no job ids, titles or counts. A wrong token gets `404`, the same as any unknown path. The bridge recomputes the answer at most once every 10 seconds.

On the bridge computer, run `dalan connect signal-token --worker NAME` once. Transfer the private file it names to the worker host over a trusted channel and keep it mode 0600. The hook needs only that file, not Dalan's owner socket or connector credentials.

On the worker host, set `SIGNAL_FILE` to that file's absolute path and replace `wake` with your worker client's supported start command. Run this hook at the [poll interval below](#poll-interval-and-url-secrecy). Do not echo the URL or enable shell tracing.

```sh
SIGNAL_FILE=/absolute/path/to/private-signal-url
SIGNAL_URL=$(cat "$SIGNAL_FILE") || exit 1
curl -fsS "$SIGNAL_URL" | grep -q '"work":true' && wake
```

`wake` is not a Dalan command. It stands for the vendor's way to start a worker run. Use a vendor schedule or your own script only if you accept that it is outside Dalan's supported path, and give it only the signal URL, not the connector credentials. The bridge service (see [service setup](service-setup.md)) keeps the queue available; it does not wake workers. The run that the hook starts authenticates through the connector as usual.

### Resume wake (idle own claims)

A vendor run can stop in the middle of a job. Resume wake exposes an expired own claim for recovery; it does not allow another run to take over during the prior lease.

- **Signal.** `work` is also `true` when the worker holds an active claim, whose lease has expired, with no claim activity for `DALAN_RESUME_IDLE_MS` (default `120000`, 2 minutes). Claim activity is `progress`, any workspace tool, `finish`, or a repeated `claim`. A read-only `get` does not count. The answer is still one bit, cached 10 seconds, per worker.
- **`list_pending`.** For the calling worker only, the list starts with one entry per expired idle own claim: `{kind:'assignment', request_id, resume:true, idle_seconds, previous_epoch, note}`. The note tells the run to read progress and owner notes with `get`, then call `claim(request_id, claimant, acquisition_id)`. Generate one random `acquisition_id` per independent run and reuse it for retries. Keep it in private saved run state, with the claimant and claim ID, across QUESTION/answer pauses and reconnects of that run, and never print it in diagnostics or examples.
- **`claim` rotates the epoch after expiry.** A new epoch requires the prior lease deadline to pass and all old host checks to have verified stop receipts. Sending, uncertain and terminal-unknown job deliveries hold regrant until positive reconciliation. A same-worker, same-subject, same-claimant retry with the matching acquisition ID retains the live grant (`duplicate:true`); omitted IDs match an unkeyed claim. Exact retries are recognized before rotation, but in built-in mode a retry must come from the live connection that holds the grant; it does not re-run destination or repository policy. A different run uses a new acquisition ID and waits for expiry; it cannot reuse a grant obtained from `get`. A new epoch moves the worktree and sealed uploads, retires queued old-generation questions and fences the old `claim_id`. Unsealed uploads remain bound to the old epoch. See the [protocol truth table](../PROTOCOL.md#claims-and-worker-tools).
- **Record.** Lifecycle gets a `claimed` event with reason `resume` (it does not count toward claims per hour), and the progress history gets a `[bridge] run resumed: epoch N stopped after Ss ...` line.
- **Switch.** `DALAN_RESUME_IDLE_MS=0` turns all of it off: the signal, the `list_pending` entries and the rotation. Exact acquisition identity checks still apply: omission matches only a stored NULL, and a different live acquisition is refused. The switch never permits early regrant. Set it in the bridge service environment and restart.
- **Progress nudge (opt in per worker).** In `workers.json` set `"guidance": "resume"` for the worker. `claim` and `get` then add acquisition and progress guidance. The progress interval is half the idle threshold, rounded down to a multiple of 30 seconds, with a minimum of 30 seconds. Thresholds of `120000`, `240000`, and `45000` ms produce intervals of 1 minute, 2 minutes, and 30 seconds. For the default threshold the text is: "Generate one random acquisition_id per run and pass it on every claim call, including retries. Post progress at least every 1 minute with what is done and what remains, so a resumed run can continue; if your run may end, post progress first." With the switch at 0, guidance uses the default threshold. The only valid guidance value is `"resume"`.
- **Measure.** `dalan metrics --json` has `resume_wake.by_worker.<worker>`: `resumed`, `lease_expiry_retries`, and `time_to_finish_resumed` against `time_to_finish_lease_expiry` (first queued event to completed, p50/p90). `resume_wake.duplicate_epoch_claims` must be 0. The text form prints `resumed=` and `duplicate_epochs=`. Falsifier: resumed jobs do not finish sooner than lease-expiry jobs.

Maintainer check: from a source checkout installed with `npm ci`, run `node scripts/resume-wake-test.mjs`. The npm package does not include this script.

### Poll interval and URL secrecy

- Tailscale Funnel, Cloudflare tunnel or your own proxy: every 60 seconds.
- ngrok: every 300 seconds. The free plan has a monthly request quota, and a 60-second hook uses up much of it. `signal-token` prints the advised interval on stderr.
- Anyone with the URL can learn whether work is waiting, and nothing more. Store it like a password; if it leaks, run `--rotate` and update the hook.
- The bridge limits each source address to about one request every 5 seconds (burst 3), and the whole bridge to 30 per minute. Excess requests get `429` with `Retry-After`. Behind a tunnel, every caller shares one bucket, so keep to the intervals above.

## Jobs the worker never takes

An unclaimed job stays queued unless a cancellation rule applies. **Preparation expiry applies to every worker:** when the sweep runs, an expired requester deadline cancels queued work with reason `expired`. A learned `queue_p90` deadline can be refreshed up to twice if history supplies a fresh window and at least 15 minutes remain before the 12-hour cap from creation. Otherwise the queued job is cancelled. Claimed jobs and jobs without a deadline are exempt. Learned defaults are suppressed for background submissions and while paused; for `dot`, an owner-confirmed usage break also suppresses them. Explicit deadlines still apply, and pause or break time does not extend them. The maintenance sweep runs while delivery is paused. See [preparation expiry](operations.md#usage-breaks-and-usage-estimates).

**Skip expiry is separate and default-worker only:** a queued default-worker job is cancelled with reason `skipped_by_worker` once its skip marker is at least 6 hours old and it has been passed over at least 3 times (set the hours with `DALAN_SKIP_EXPIRE_HOURS`). Other workers are exempt from skip expiry, not from preparation expiry. The 2-hour re-wake window only moves older jobs to stale backoff; it does not cancel them. The requester can inspect the state with `dalan get` or cancel with `dalan cancel REQUEST_ID`.

## Vendor notes

Scheduling and hook support vary by product, account and workspace policy. Check the vendor's current documentation and the controls available in the intended account before choosing a pattern. Dalan supplies neither a scheduler nor a worker-start command. Until that account's scheduled or hook-driven path has completed a real job, use the manual pattern above.

More detail: the "Wake signal for hook-driven workers" section of [portable-auth-profile.md](portable-auth-profile.md) and the hook-driven worker example in [scripts/live-trial/README.md](https://github.com/tnunamak/dalan/blob/main/scripts/live-trial/README.md).
