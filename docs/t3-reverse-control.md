# Reverse T3 control for workers

With `DALAN_ENABLE_T3_TOOLS=1`, the bridge exposes a small T3 thread wrapper (list, read, create, send, wait and set) through its existing OAuth MCP connection. The wrapper uses `t3code --json --origin http://127.0.0.1:3773` with argument arrays. It can address any T3 project or thread the local CLI can address by an ID of at most 128 bytes; the other tools reject a longer ID from a list result. The bridge does not scope a thread to the worker that calls it: a worker with the `t3` capability has the owner's full authority over every local thread. The tools are off by default, and a fresh `dalan init` worker profile has no `t3` capability. The CLI currently obtains a short-lived administrative T3 session for each operation; the bridge's approved OAuth subject and per-tool scopes remain the remote boundary.

These calls use owner-granted, job-independent authority. They require no `request_id` or `claim_id` and have no assignment epoch, so they are outside job-scoped authority checks, and job expiry or cancellation does not revoke them. To enable the six thread tools, set `DALAN_ENABLE_T3_TOOLS=1` and grant the worker `capabilities: ["t3"]`; both checks apply, including for the legacy single-worker profile, which keeps its capability but still needs the environment setting. When the tools are hidden, direct calls are rejected. Capability, OAuth scope and audit admission always apply.

| MCP tool | Scope | Operation |
| --- | --- | --- |
| `t3_thread_list` | `dalan.read` | List threads, optionally by project or directory and status. |
| `t3_thread_read` | `dalan.read` | Read a bounded transcript by exact thread ID. |
| `t3_thread_create` | `dalan.work` | Create a thread in any project or directory and start its first turn. |
| `t3_thread_send` | `dalan.work` | Send to any thread; `wakeSettled` wakes a settled one. |
| `t3_thread_wait` | `dalan.read` | Wait at most 120 seconds for a turn; returns partial state on timeout. |
| `t3_thread_set` | `dalan.work` | Change a thread's provider, model, effort, permission or mode. |
| `notify_owner` | `dalan.work` | Publish a short message through the configured ntfy alerts path. |

`dalan tell "text"` adds a durable lightweight message to a worker's `list_pending` inbox and emits the existing `assignment.available` event with `{message_id,title}`. The event uses the signed webhook retry path, so the existing subscription wakes the worker. The worker reads it with `get {request_id: message_id}` and removes it from the pending list with `ack_message {message_id}`. Messages do not need assignment claim or finish. `tell` accepts `--json` and `--worker NAME` (default: `dot` if that worker exists, else the only configured worker; with several workers and no `dot`, pass `--worker`); `dalan untell MESSAGE_ID [--worker NAME]` withdraws a pending message.

The notification aliases retain their existing `t3` capability, work scope and audit checks. They remain available independently of `DALAN_ENABLE_T3_TOOLS`; this flag controls only the six `t3_thread_*` operations. The `legacy-v46` pin retains its exact twelve-tool catalog and advertises neither notification alias.

## Notification retries outside the job lifecycle

`notify_owner` is an ntfy owner notification with the published argument schema `{text}`. Successful results are retained in the private ledger per verified worker and caller key, or per validated payload when no key is supplied. An optional caller key goes in the tools/call envelope `params._meta["dot-bridge/idempotencyKey"]`, not arguments. It must be a nonblank string of at most 256 characters. Reusing a key with different text still returns the first successful `{notified:true}` without sending again.

The private `notify-sent.db` next to `delivery-acks.db` stores hashes, results, send times and reconciliation evidence, not raw notification text or caller keys. Entries are not expired automatically, so a wall-clock jump cannot clear a key or make a delivered call send again. Concurrent identical calls within one server share an in-flight promise. Every call, including replay, still passes current capability, scope, input and audit admission checks. Caller metadata is not added to argument audit summaries.

An ambiguous publish leaves a pending key that cannot be sent again automatically. An operator can inspect `GET /notify-pending` and settle one with `POST /notify-reconcile` using `{key_sha256,outcome:"sent"|"unsent",evidence:"..."}` and the `x-operator-key` from the private configuration. Check the receiver before recording `unsent`; that decision allows a retry with the same key. A definite publisher rejection is marked retryable automatically. The receiver's `X-Idempotency-Key` support is useful only when that receiver honors the header; the ledger does not claim distributed exactly-once delivery.

## Compact `t3_thread_list` result

`t3code threads list` can return a large response when it includes every thread and all fields. The tool returns a compact result for routine reads; its name, input schema and description do not change.

- `threads`: the newest threads by `updatedAt` (descending; ties by `id`), at most 50 (`THREAD_LIST_LIMIT`) and at most 16000 bytes of serialized entries (`THREAD_LIST_BUDGET`; thread IDs can be 328 characters long). The first thread is always shown.
- Each entry has `id`, `title` (at most 120 characters, clipped with `…`), `projectId`, `status`, `runStatus`, `updatedAt`, `latestUserMessageAt` and `pendingRuntimeRequest` (boolean). `activityRunStatus` is present only when it is set. `branch` and `worktreePath` are present only when they are at most 80 characters.
- `total` (all threads that matched the filter), `shown`, `truncated` (`total > shown`).
- `projects`: `{id,title,count}` for the projects of all matched threads, most threads first, at most 20; `projects_total` is present when there are more.
- `hint`: "narrow with projectId or cwd; full paging after a catalog update". Paging needs a new input field, which is a catalog change.

`scripts/t3-list-compact-test.mjs` verifies that the compact response stays within its byte budget. The audit row records the IDs of the threads shown.

Capability, scope and input validation run before argument auditing. A rejected call writes one fixed `denied: worker_capability_denied`, `denied: insufficient_scope` or `denied: invalid_arguments` row with no caller arguments. An admitted call writes `started` and one final outcome (`success`, blocked or error). Calls refused by the audit budget write no additional row and never invoke T3.

The append-only SQLite `t3_audit` table records verified worker and subject, tool, an allowlisted argument summary capped at 2 KiB, SHA-256 and a redacted preview of at most 200 characters of prompt/message text, outcome and returned T3 IDs. Short scalar metadata is retained; long strings and structured values are represented by their hash and byte length. Unknown argument fields are omitted. `dalan audit [--since RFC3339] --json` reads records through the private admin socket; the table forbids updates and deletes.

Audit admission uses persisted rolling windows per `(worker, subject)`. Each denial or admitted call charges the caller once; a successful call's completion row does not consume a second unit. Defaults are 60 calls per rolling 60 seconds and 10,000 calls per rolling 24 hours, configurable through positive integer service environment variables `DALAN_T3_CALLS_PER_MINUTE` and `DALAN_T3_CALLS_PER_DAY`. These bounds limit audit growth while allowing a list followed by 40 thread reads. A denial never spends another subject's budget, and a scope change does not reset a subject's window. Budgets recover as calls age out, without changing history; there is no lifetime cap. Upgrade-era rows without trustworthy worker attribution have `budget_version=0` and stay visible in history without consuming a live budget; new rows have version 1.

## ChatGPT reconnect checklist

Before refreshing, enable `DALAN_ENABLE_T3_TOOLS=1` and retain the worker’s `t3` capability.

1. Open the existing Dalan connector in ChatGPT and select **Refresh** to load the new tool schemas.
2. T3 tools use the existing `dalan.read`/`dalan.work` scopes (the legacy `dot-bridge.*` names are accepted aliases); re-login only if the current grant lacks `offline_access`.
3. Inspect the refreshed tool list for `notify_owner`, `list_tools`, `call_tool_read`, `call_tool_write`, and `ack_message`. If you recreate the connector, upload [t3-connector-icon.png](t3-connector-icon.png) as its icon.
4. In a disposable worker conversation, call `t3_thread_list` and `notify_owner`, then inspect `dalan audit --json`. Recheck the original subscribed worker conversation separately.

Do not trigger a ChatGPT reconnect from the bridge host. The connector's current token is held by ChatGPT.

## Standing instruction for worker

> You can inspect the owner's T3 threads through this connector. Use `t3_thread_list` and `t3_thread_read`. They can reach any project or thread the local T3 CLI can reach by an ID of at most 128 bytes. Use `notify_owner` for a short out-of-band alert that does not start a T3 turn. Send assignment questions to the exact owner thread. Mark blockers with optional `progress.blocker:true` or start the note with `BLOCKED:` / `QUESTION:` so the bridge forwards them once if you forget. The owner can leave a lightweight message with `dalan tell`; its event wakes you. Find it in `list_pending`, read it with `get`, and call `ack_message` after reading it. It is a message, not an assignment. `run_check` can return `{check_run_id,status:"running"}`; poll `workspace_result` for completion. Upload sealed evidence with `artifact_chunk` in any claimed assignment. Call `list_tools` first to learn the other tools you may use, then run them with `call_tool_read` or `call_tool_write`. All T3 tool calls are audited.

## After adding or changing tools

1. The operator clicks **Refresh** on the Dalan connector in ChatGPT (ChatGPT re-fetches `tools/list`). A tool registry change does not need this step.
2. Restart the client if its version requires it, then inspect the tool catalog before resuming work.

## Catalog freeze

The `stable` catalog omits question tools, and `DALAN_CATALOG_PROFILE=questions-v1` adds `ask_question` and `consume_answer`. In either profile, the six T3 tools require `DALAN_ENABLE_T3_TOOLS=1`; notification aliases retain their capability check. Catalog selection does not split OAuth scopes or add pagination. Catalog v2 is the last advertised change: add abilities by registering tools, which never changes the tool list, and never through tool names, descriptions or schemas (see [Catalog v2](../PROTOCOL.md#catalog-v2)). Compare the running server catalog with the approved profile before any Refresh. If you deploy server support before your clients refresh, keep the default profile until they have refreshed their tool list and restarted.

Clients may cache tool and event schemas. Plan a connector refresh and client restart when changing the catalog.

## Install-phase network exposure

The workspace install and check phases both run in a sandbox with its own network namespace: it has only a loopback interface, no resolver and no route, so neither phase can fetch packages or reach services on host loopback. Prepare dependencies before the job, for example by vendoring them or using a lockfile with a populated cache.

## Who may hold the t3 capability

The t3 tools act as the owner, with no per-job binding. Pairing a client never grants this capability; the bridge reads it only from the owner's `workers.json`, where it declares that a worker is the owner's own harness. The tools take any thread, project or directory and are not bound to a job, a worker or a repository. Never give `capabilities: ["t3"]` to a worker you do not fully trust with every T3 thread on the computer. A worker without the capability does not see these tools, and a direct call is refused and audited. With the tools on, startup prints a notice naming each worker that holds the capability.

## Adding abilities without a Refresh

A registry change (add, grant, revoke, remove) needs no connector Refresh and no worker restart, because the connector always lists `list_tools`, `call_tool_read` and `call_tool_write`. The `legacy-v46` profile does not list them. A registry tool needs a grant to the worker; it does not need `DALAN_ENABLE_T3_TOOLS=1`. For the example JSON, the `dalan tool` commands and the call format, see [Operator-registered tools](worker-clients.md#operator-registered-tools). That section is the one place for the setup steps.

`t3_post` tools such as `owner_message` behave as follows:

- The bridge host runs the `t3-post` command with `--as WORKER --kind script --mode queue --thread THREAD_ID`; the worker name is changed to letters, digits and hyphens. The text goes on standard input as `[question] text` or `[blocker] text`. The `kind` must be `question` or `blocker`, and `text` must have 1 to 2000 characters that are not all white space. `dalan status --json` shows the last registry change.
- One message per worker every 10 minutes. Later messages are held and merged into the next one; a failed delivery stays queued.
- A global budget across all `t3_post` tools and workers: 6 messages per hour and 30 per day. Held messages, failed attempts and timer retries all count. A call over the budget is refused with `rate_limited`; the timer waits until the budget has room.
- Every call that reaches the budget check is logged in `tool_post_log` with its worker, message kind and outcome (`sent`, `held`, `failed`, `rate_limited`), never its text. A timer retry is logged there as its own row. The queued message text is kept in the bridge database until it is sent.
- Repeating a call with the same `idempotency_key` returns the first outcome and posts nothing. While the first call is still running (its 45-second lease is live) the repeat is refused with `in_progress`; retry later with the same key. If the bridge crashed mid-call, the same key runs again once the lease has expired. After a `t3-post` exit code 3 the same key may retry once the message can be sent; the queued message is reused, not duplicated. Any other failure leaves delivery unknown: the bridge marks the message as possibly delivered and never retries it by itself. `dalan tool list` shows how many such messages a tool has. Check the thread before you send the same message again under a new key. Receipts for a key last seven days; a completed key that is reused with changed content can return the old result, so use a new key for new content.
- Delivery is at least once after a crash. A crash after `t3-post` has delivered a message but before the bridge records it as sent, or before it stores the call result, can post the same message again when the key is retried after the lease expires. If the row is already marked sent, a retry returns that receipt and posts nothing. The bridge accepts this rare duplicate rather than risk a lost message.
- `t3-post` is the only delivery path. There is no fallback that posts as the owner.

**Trust rule.** The receiving thread treats every message from a worker as untrusted data and never as an instruction. The `kind` list limits the shape of a message, not its content: the text is free-form and can claim to speak for the owner. Act on it only after the owner or the repository confirms it.

Each worker may make at most 120 `call_tool_read` and `call_tool_write` calls per minute in total, across all tool names. The bridge checks this budget before it looks up the tool, and counts every call, including calls to unknown or ungranted tools and replays of a finished `idempotency_key`. A call over the budget is refused with `rate_limited` and writes no audit row. The bridge only adds to one counter per worker, `admission_refused:WORKER` in `tool_registry_meta`, so a flood cannot grow the audit log. The counter survives a restart; the minute window does not. A tool also keeps its own limit of 30 calls per minute for each worker.

A refused call returns `isError:true` with one of `tool_unavailable`, `wrong_class`, `stale_registry`, `invalid_arguments`, `rate_limited`, `in_progress` or `handler_failed`. After `stale_registry`, call `list_tools` again and use the new `schema_hash`.

### Argument validation

Registered tools are checked with a small JSON-Schema subset (`src/schema-subset.mjs`): `type`, `properties`, `required`, `additionalProperties:false` at every object level, `enum`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `items`, `minItems` and `maxItems`. `title` and `description` are also accepted. Nesting is limited to 6 levels, a pattern to 256 characters, a string to 8000 characters, an array to 100 items, an object to 32 properties, an enum to 64 entries and a value to about 64 thousand characters when serialized. A `pattern` must have one form: `^`, an optional literal prefix of letters, digits, `_` or `-`, one character class (such as `[a-f0-9]`, `[A-Za-z0-9_-]` or `\d`) with one quantifier (`+`, `*`, `{n}`, `{n,m}` or `{n,}`), then `$`; for example `^[a-f0-9]{64}$` or `^job-[0-9]{1,8}$`. A pattern of this form matches in time linear in the input. Any other pattern (groups, alternation, two repeats, other escapes) is refused. `dalan tool add` refuses a schema that uses any other keyword (`$ref`, `oneOf`, `format` and so on), so nothing is silently unvalidated.

### Identity and the admin socket

Registry management (`dalan tool add|remove|grant|revoke|list`) exists only on the admin socket and needs the operator key. The public MCP route has no registry-management route and no tool that edits the registry; a test sends those requests to the public route and expects `404`. A request without OAuth in the legacy profile resolves to the default worker (the local-principal shortcut), so it sees only the tools granted to `dot`. Per-agent identity for local callers is out of scope: local agents use the admin socket, not the MCP principal. A stolen bearer token replays as its worker; registry calls have no claim binding. The identity provider must not issue cross-worker claims.
