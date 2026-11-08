# T3 and orchestration integration

This page is for installations where an orchestrator, such as the T3 Code desktop app or an automated producer, submits jobs and receives results. Ordinary jobs from a shell or a coding agent do not need it; see the [requester reference](usage.md).

The T3 tools themselves (thread create, send, wait and set) are described in [T3 tools](t3-reverse-control.md).

<a id="use-dalan-from-t3-code"></a>

## Use Dalan from T3 Code

T3 Code can delegate a task to your worker as if the worker were a model. The package installs `dalan-acp-agent`, an ACP (Agent Client Protocol) agent. In T3 Code, add a custom ACP agent that runs this command with the environment below; T3 starts one process per thread, and the adapter sends each new prompt in the thread to Dalan as a job (a prompt that repeats an earlier one reuses that job); the worker's report comes back as the reply and ends with the `dalan decide` line.

```text
command: dalan-acp-agent
DOT_ACP_WORKER=chatgpt              # the worker name; unset uses the bridge's default worker
DOT_ACP_MODEL=chatgpt               # the model id T3 shows
DOT_ACP_LABEL="ChatGPT worker"      # the label T3 shows
DOT_ACP_SOCKET=/path/to/admin.sock  # the bridge's admin socket; the default is the default Dalan home, not DALAN_HOME
```

Add one entry for each worker, so a ChatGPT worker and a Muse Spark worker each appear as a model. These adapter settings keep the `DOT_ACP_*` names. Builds also need `DALAN_ACP_BUILD_OWNERS`: see [Builds through the T3 worker provider](#builds-through-the-t3-worker-provider).

A separate, opt-in feature lets a worker list, read and write T3 threads. It gives the worker write and control access to your T3 threads, so read [T3 tools](t3-reverse-control.md) before you enable it.

<a id="t3-task-thread-delivery"></a>

## T3 task-thread delivery

Quiet delivery (`none`) is the default. Only for an explicit visible task-thread notice, obtain the exact owner thread ID from `t3_thread_configuration` (current thread). A delegated child returning to its parent may use `orchestrator_capabilities.parentThreadId`. Verify the chosen ID and its environment with `t3code --json threads inspect --thread ID`. T3 delivery requires a CLI that supports `threads inspect`; metadata lookup fails closed if that command fails, without falling back to a transcript read, and quiet delivery needs no T3 CLI. Do not guess the ID from cwd or a recent thread. Protected top-level threads retain notices quietly.

After verifying the destination, submit with `dalan submit --worker NAME --execution none --deliver t3:THREAD_ID --file job.json --json`. Replace `NAME`, `THREAD_ID` and `job.json` with your worker, verified destination and assignment file. For an ordinary quiet job, keep `--deliver none`.

<a id="main-thread-guard"></a>

## Main-thread guard

`~/.config/dalan/limits.json` accepts `main_thread_ids`, an array of non-empty strings (default `[]`), next to `max_claimed_outer_assignments`. Example: `{"max_claimed_outer_assignments": 6, "main_thread_ids": ["00000000-0000-4000-8000-000000000001"]}`. Every key in the file is optional and has a default. It accepts the bounded ASCII forms T3 emits, including UUID, `mcp:UUID`, delegated-task, and provider-native IDs (8–1024 characters; letters, digits, `.`, `_`, `:`, `%`, and `-`). The service validates the file at start and rereads `main_thread_ids` on every T3 submit, so edits apply without a restart. The admin `/submit` endpoint rejects a thread in that list unless `allow_main:true` is authenticated with the operator key; the CLI reads that key for `--allow-main`. This applies to retries too. Delivery checks the protected list again and suppresses results and blockers even for previously submitted assignments or operator-admitted bindings. Stored legacy mute facts also quiet an individual binding; no current command or admin mutation route creates watch or mute facts. Results and questions remain available through `wait`/`get`; retained legacy watch rows remain visible through `get` and do not wake `wait` when suppressed.

<a id="objective-identity"></a>

## Objective identity

`dalan submit` takes optional `--objective-key KEY --revision REV --task-kind KIND` (each at most 512 bytes) and `--source drainer|fix-loop|agent|unknown` (default `agent`; `drainer` and `fix-loop` must be proven by the request id, see [Consumers are assigned by code](#consumers-are-assigned-by-code)). They are stored beside the assignment, not in it, and recorded in the local receipt; a retry that omits a flag reuses the receipt's value, and a retry that changes one is a conflict. Metrics use them to count rework (same objective, new revision) and duplicates (same objective and revision, new request). `dalan backfill-objectives --dry-run --json` (operator key) shows how many older rows the receipts, manifests and legacy fix ledger can prove; without `--dry-run` it fills them. See [operations](operations.md#objective-identity).

## Builds through the T3 worker provider

A `delegate_task` to the worker provider whose task starts with `[dot-build] <path> ...` (after an optional `[dot-decision:ID]` line; T3's role preamble is removed first) is a build. The adapter submits it with `execution_scope: "implementation"`, `scope_paths` set to the listed paths, and meta `task_kind: "build"`, using the requester's HEAD. A build is refused unless `DALAN_ACP_BUILD_OWNERS` (or the legacy `DOT_ACP_BUILD_OWNERS`) is set to a comma-separated list of authorized repository owners. An empty, missing or malformed list fails closed. `DALAN_ACP_REPO_CONFIG` (or the legacy `DOT_ACP_REPO_CONFIG`) can select the local repository policy file; otherwise the adapter reads the Dalan producer configuration, with legacy path fallback. That file must provide valid `repo_selection.exclude` and `deny_path_terms` arrays; missing or malformed policy also fails closed. A brief must name no path outside its list, and at most five files may be named. Optional: `DALAN_ACP_PROSE_CHECK_OWNERS` lists the owners whose added prose is checked by an external prose linter. `DALAN_ACP_PROSE_CHECK` names its executable, which the adapter runs as `COMMAND check --stdin --kind doc --json` with the added lines on stdin; when the owner list is unset or empty, no prose check runs; an enabled check without an executable reports an error; a malformed non-empty list returns an error. The result includes the base, check results, patch preview, fetch command and verdict commands. `dalan get`, `artifact`, `accept` and `reject` work on adapter rows: with no CLI receipt, the CLI derives the owner token from `~/.config/dalan/acp-secret`.

## Consumers are assigned by code

Who a result is for comes from the code path that produced the request, never from what the submitter writes. A submit request, its `meta` or its assignment that sets `value_tier` or `tier`, or names a system consumer (`consumer` as `fix_pipeline`, `ledger` or `reserve`, or one that is not a string or `{type}`), is refused (`assignment declares tier; the bridge assigns the consumer and tier from the code path...`). A drainer manifest, or a submit whose source is `drainer` or `fix-loop`, may not declare `severity` either; an agent's `severity` hint passes, since agent work is already the first tier. Naming a requester (`consumer: {type: 'thread', id}`) is not refused, and nothing reads it yet. `--source drainer` and `--source fix-loop` must be proven by the request id of their own code (`drainerRequestId`, `fixLoopRequestId`); a forged claim is refused. Drainer work is always background priority, so no manifest can place itself ahead of agent-requested work. The consumer types are `agent` (tier 0), `fix_pipeline` (tier 1) and `reserve` (tier 5, work nobody asked for). `ledger` has no code path yet, so nothing can hold it. The rules live in `src/consumers.mjs`. Nothing orders the queue by tier yet; only the `normal` and `background` priority does.
