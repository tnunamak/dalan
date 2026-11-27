# Dalan target architecture v2: remote workers as native subagents

Status: proposed, 2026-11-27. It supersedes the slice plans (the R4-R9 route decision and the A-D PR graph) where they conflict. It keeps the core ideas of the 2026-11-14 target architecture: separate relationship, work and authority, durable delivery, and host-neutral core.

## 1. The bar

An orchestrating agent (Claude Code, Codex, or a T3 Code thread running either) already knows how to use a subagent. It makes one call with a task, it may end its turn, and a native completion notice wakes it later with the result. Dalan's bar is **parity with that, from the caller's view**. Each difference that a caller can see is a gap that Dalan closes or names.

Dalan is the bridge only: relationships, work, authority, delivery and wake, worker capability, and the surface that requester agents call. Job generators, filler queues and fleet nudges are tooling on top of Dalan. They adopt Dalan; they are not part of it.

### 1.1 Parity table (caller's view)

Reference: a Claude Code `Agent` subagent or a Codex `spawn_agent` child. Gap kinds:
- **V2**: v2 closes it.
- **NATIVE**: it closes through a native protocol route once the host supports it. Until then a versioned adapter supplies it and is listed in section 9.
- **SHARED**: a provider limit that native subagents also have in some form. Dalan does not work around it. It reports the limit as an honest status the caller can see, the way a subagent's rate-limit error is visible.

| # | Property | Native subagent | Dalan worker on main (d0dd670) | Gap kind | v2 |
|---|---|---|---|---|---|
| 1 | How you call it | One tool call: prompt, model or target, isolation, background | T3: `delegate_task target:{providerInstanceId:"dot"}` already reaches Dalan through `bin/dot-acp-agent.mjs`; 3 of about 30,000 jobs in 7 days used it. CLI: `dalan submit` with about 20 flags. MCP `dalan_submit`: 6 fields, no delivery, no kind. | V2 | Each host's own subagent call (section 4). The same work fields on every route: task, priority class, requirements, repo, base. |
| 2 | Answer at submit | Starts at once, or fails at once (rate limit) | `queued`. Queue-wait data exists (`store.mjs:1175`) but is used only for `valid_until`. | V2 | Forecast: `starts now`, or `waits ~N (p50/p90, n)`, or for `critical`, `refused: no free lane`. Also the per-kind track record (section 6). |
| 3 | Wake on result | Native completion notice in a later turn; caller may end its turn | T3 only, as a user-role chat message into the parent; protected threads suppress it. A background `dalan wait` dies with the turn or with T3. | V2 (T3, Claude Code); NATIVE (Codex CLI) | The host's own child-completion path; never chat in a main thread (section 5). |
| 4 | Wake on question | Claude Code: no questions from subagents (`AskUserQuestion` removed); permission prompts surface in the main session. T3: a child stops and the parent is woken. | `ask_question` exists with keyed answers (#38) and purpose (#32). The question reaches T3 as chat carrying a `dalan answer` command. | V2; NATIVE for structured questions (ACP v2, MCP Tasks `input_required`) | The question ends the child's turn; the caller answers by messaging the child; Dalan maps that to the keyed answer. |
| 5 | Correct running work | `SendMessage` to the agent; T3 `t3_thread_send` steer | `note` only | V2 | An explicit `correct` operation: applied in place where the worker can take it, otherwise successor work linked by `supersedes`. The caller makes the same call either way. |
| 6 | Cancel | `TaskStop`, `interrupt_agent`, `task_cancel` | `cancel`; the ACP facade maps T3 cancel to it | V2 (small) | The same, plus an honest result: `withdrawn`, or `worker still running, result will be discarded`. A hosted worker cannot always be stopped mid-step (C4 #40 already records this). |
| 7 | Streaming progress | Claude Code shows the subagent's transcript; T3 shows the child thread live | `progress` events stored; the ACP facade sends heartbeats; little reaches the caller | V2 | Facade relays the worker's `progress` and `ack_message` events as child-thread agent messages (visible, never a wake). |
| 8 | Tool and repo access | The caller's own tools, files and credentials (scoped by permission mode) | `read_file`, `apply_patch`, allowlisted `run_check`; files named like `auth` or `token` refuse the whole job | V2 for repo access; SHARED for the worker's own tool set | The worker uses its own computer and its own tools on the repo at `base` (section 7). Secrets never reach it; file names no longer refuse jobs. The worker's own tool policy is the provider's. |
| 9 | Running code and tests | Shell in the caller's environment | No shell; about 75% of dot builds came back blocked | V2 where the worker has a computer; SHARED where the provider withholds a shell or network | The worker runs code on its own computer and reports `worker_reported` evidence; Dalan can add `bridge_observed` checks on the result branch. |
| 10 | Result shape | Text plus files in the shared worktree or an isolated worktree branch | A patch in a bridge workspace; fleet tooling turns it into a branch | V2 | Branch, commit, draft PR, evidence. Dalan pushes the worker's patch with owner credentials when the worker cannot push (section 7.3). |
| 11 | Recovery after a crash | Claude Code: an in-process subagent dies with the process; the transcript is resumable. T3: delegated tasks and completions persist. | Store and outbox persist; the ACP turn dies with T3 | V2 | Work persists in Dalan; delivery reconciles after either side restarts (section 5, rule 4). Better than an in-process subagent. |
| 12 | Rate limits and breaks | The provider's error is visible to the caller at once | The worker goes quiet; jobs sit queued | SHARED | Status, not a workaround: `worker_state: break (until T)` in the forecast, and a child message when an accepted job is delayed by a break. |
| 13 | Provider policy refusals (for example OpenAI Guardian) | The refusal text reaches the caller | Often a blocked result with little reason | SHARED | The worker's refusal is passed through verbatim as `outcome: refused_by_provider`. |
| 14 | Session length | Context limits and compaction | Hosted sessions end after minutes (Muse about 7-10 min) | SHARED | Shown in the track record and forecast (`typical session ~N min`). Work is sized by the caller, as with a subagent. |
| 15 | Output quality | Varies by model | Varies by worker | SHARED | Shown as the per-kind track record: accepted, checks passed, n. |

## 2. What stays, changes or goes from main

| Item on main | Verdict | Why |
|---|---|---|
| Store: jobs, claims, epochs, receipts, outbox, lifecycle events | **Stays** (core) | Durable, tested, host-neutral. |
| C2 #33: relationship, work and authority lifetimes | **Stays** (core) | The enduring separation. Relationships gain a `requester_route` column (section 4). |
| #38 keyed answer journal | **Stays** (core) | Exactly-once answer across a crash. The T3 child route calls it. |
| #32 question purpose | **Stays** (core) | A `human_decision` question still bypasses the model. |
| C4 #40 typed control events | **Stays** (core) | `correct` becomes a fifth control type, `amend_work`, with outcome `applied_in_place` or `successor:<id>`. |
| B5 MCP `dalan_answer` and `dalan_questions` | **Stays**, and grows | The MCP surface gets parity with the CLI (section 4.2). |
| #36 wake hold while the parent is interrupted, and the R4 fence | **Changes**: legacy route only | On the child-task route, T3 owns the parent lifecycle and the wake. Dalan stops reading parent run status for that route. |
| `--deliver t3:<thread>` user-message wake (`src/destinations/t3.mjs`, `t3-transport.mjs`) | **Changes**: legacy adapter | It stays for callers that cannot use the child route, but it is no longer the default. Its protected-thread suppression stays. |
| `bin/dot-acp-agent.mjs` T3 ACP facade | **Changes**: becomes the primary T3 adapter | Already registered as T3 providers `dot` and `muse`. It needs: a question ends the turn, a follow-up prompt answers or corrects, forecast at the first agent message, delivery after a T3 restart, and no "usage break exceeded the turn wait limit" failure (section 5.2). |
| `assignments.thread_id`, `environment_id` NOT NULL; delivery string only `none` or `t3:` | **Changes** | Delivery becomes `{adapter, address, adapter_version}`, with T3 columns moved into the T3 adapter's own table. The core names no host. |
| Worker catalog `read_file`, `apply_patch`, `run_check` | **Changes**: kept for workers without a computer | A worker with its own computer gets the work as repo, base and task, and returns a branch or patch with evidence. |
| Host `run_check` allowlist and `scope_paths_read_isolation_unavailable` | **Changes**: becomes acceptance evidence, not the worker's only test route | Owner-side checks still run on the returned branch when configured. They label their evidence `bridge_observed`; the worker's own runs are labeled `worker_reported`. |
| Name-based refusals (`auth`, `sign*`, `token`, `*secret*` soft names) | **Goes** as whole-job refusal | Safety is "no secrets, tokens or keys reach a worker". Content scanning (`hasSecretContent`) and the hard secret-file list stay. A hard secret file is left out of anything Dalan ships; it does not refuse the job. |
| `status.dispatch` scoped to `dot` | **Goes** | It is replaced by a per-worker forecast that every route uses (section 6). |
| `dalan wait` loops as the wake for non-T3 callers (`docs/local-agent-requester.md`) | **Goes** as the documented wake | It stays as a tool for scripts. Section 4.3 gives native wakes. |

## 3. Core model (enduring)

The core owns six things, and nothing about any one host.

1. **Relationship**: who works for whom, with which route on each side (`requester_route`, `worker_route`) and adapter version.
2. **Work**: `{task, kind, priority_class, requirements, repo, base, inputs, outputs_expected}`. Requirements are capability names (`shell`, `internet`, `push:<org>`, `tests:<selector>`, `identified_questions`). Admission compares them with qualified worker capabilities and refuses before creating the job, never later.
3. **Authority**: grants per relationship and per work item. The safety line is a core invariant: **no credential, token or key enters a work payload, a worker tool result, or an artifact the worker can fetch.** Content scanning enforces it at submit and at every artifact download.
4. **Events**: one typed stream per work item: `admitted(forecast)`, `claimed`, `progress`, `question`, `answered`, `amended`, `artifact`, `finished(outcome, evidence)`, `cancelled`. Every adapter reads this stream. Delivery is "deliver the events this route subscribes to, at least once, keyed".
5. **Evidence**: each claim about the result carries its trust label: `worker_reported`, `bridge_observed` (owner-side check run on the result), or `owner_accepted`.
6. **Measures**: per kind and per worker: queue wait, start latency, outcome rates, check pass rate, acceptance rate, and "could not check my work" rate. Section 8 lists them.

Operations, the same on every route: `delegate`, `forecast`, `status`, `result`, `questions`, `answer`, `correct`, `cancel`, `accept|reject`, `artifact`.

## 4. Requester routes (versioned, disposable adapters)

The rule: **the caller uses the subagent call its host already has.** Dalan supplies an adapter per host. Each adapter states which capabilities it actually delivers (design for the expected capabilities; advertise only the delivered ones).

### 4.1 T3 Code child task (primary; covers Claude and Codex threads in T3)

- Call: `delegate_task {task, target:{providerInstanceId:"dot"|"muse"|<worker>}, isolation}`. T3 creates a child thread whose agent is Dalan's ACP facade. The parent gets T3's own reply: "Completion wakes this thread."
- The child turn is held while the work runs. This is right for a child: the long turn is the child's, not the parent's. The parent shows `waiting_for_children`.
- Completion: the facade ends the child turn with the result summary, branch, PR and evidence. T3 wakes the parent with its native delegate-completion notice. **No chat message reaches the parent thread.**
- Questions: the facade ends the child turn with the open questions (ids, text framed as untrusted data, purpose). T3 wakes the parent as for any child that stops to ask. The parent answers with `t3_thread_send` to the child. The facade maps that prompt to the keyed `answer` when a question is open, and otherwise to `correct`. A `human_decision` question is not answerable this way; the facade says so.
- Priority and requirements: given in the task text header (`priority: critical|normal|background`; `requires: ...`) or as ACP model options when T3 passes them. The facade parses them.
- Forecast: the facade's first agent message in the child is the admission answer. For `critical` with no free lane, the facade ends the turn at once with `refused: no free lane; next start ~N min`. The parent gets that within seconds and can route to a subscription agent instead.
- Restart: if T3 or the facade process dies mid-turn, the Dalan work continues. When it finishes, Dalan sends one keyed message to the child thread (`t3 thread send`, a documented host CLI). That starts a fresh child turn, which the facade answers at once from the stored result, so the parent is woken through the same native path. Probe P1 must confirm that T3 wakes the parent for that fresh child task.

### 4.2 MCP requester (any MCP host)

`dalan mcp` gets the full verb set (`dalan_delegate`, `dalan_forecast`, `dalan_status`, `dalan_result`, `dalan_questions`, `dalan_answer`, `dalan_correct`, `dalan_cancel`, `dalan_accept`) and every work field. The reply to `dalan_delegate` carries the forecast and a `next` text in the host's own style ("Completion wakes this session. Do not poll."). This holds only where a wake adapter (4.3) exists for that host. Where none exists, the reply says plainly that the caller must poll.

### 4.3 Wake adapters for hosts outside T3

| Host | Native wake Dalan can drive | Status |
|---|---|---|
| Claude Code session | Cross-session inbox socket (v2.1.224+): "When the receiving session is idle, Claude Code starts a new turn with the message." Gated by `crossSessionInbound` (accept, hold, refuse); with no value, a non-child sender may face a 5-minute approval dialog. A session that has exited restarts from its saved conversation when it gets a reply through agent view. | The docs give only the auth line. The Claude Code binary carries the example `{"type":"user","message":{"role":"user","content":"..."}}` after auth; untested. No CLI command sends a message. Probe P3 (one local session). Fallback: a background `dalan wait` (a native task notice while the session lives) plus a SessionStart hook that shows `dalan inbox`. |
| Claude Code, MCP channels | `notifications/claude/channel` from `dalan mcp` | Research preview; needs a development flag. Not the default. |
| Codex app-server | `turn/start` or `thread/inject_items` on a loaded thread | Unloaded threads cannot be woken; work waits in `dalan inbox`. |
| Codex CLI alone | None found | Poll, stated honestly. |

### 4.4 A2A peer (future)

When a peer speaks A2A, Dalan maps A2A task, message and artifact to work, question and artifact, behind a versioned adapter. Nothing in the core changes. Not built in v2; the core must not prevent it.

## 5. Delivery and wake rules

1. **Deliver on the caller's own path.** For the T3 child route, the child thread and T3's completion are the path. Dalan never posts results as chat into a parent thread on that route.
2. **One wake per decision.** Completion, a question, or a refusal wakes the caller. Progress never does.
3. **Keyed and at least once.** Every delivery has a key derived from `(work, event)`. A resend after a lost acknowledgment cannot double-wake.
4. **Reconcile after restart.** After a Dalan, facade or host restart, Dalan reconciles each open delivery against the host's own record before sending again.
5. **Inbox is the floor.** If no adapter can wake the caller, the event waits in `dalan inbox`, and `status` says so. That is a valid route, not an error.

## 6. Admission, forecast and track record

- Priority classes: `critical` (start now or refuse), `normal` (queue, with an estimate), `background` (queue behind normal).
- Forecast inputs, all already stored: free lanes per worker (capacity minus active claims), live subscriptions, recent claim activity, the queue ahead in the same or a higher class, and the 7-day queue-wait distribution per worker and kind.
- Answer shape: `{start: "now"|"queued"|"refused", eta_p50_min, eta_p90_min, basis_n, track: {kind, finished_ok, blocked, failed, checks_passed, accepted, n, window}}`. Below 10 samples it says `insufficient_history` and gives no number.
- The answer is a forecast, not a promise. No delegated-agent product shows a reliable ETA (see the prior-art list). Dalan reports its own measured basis, so a caller can judge it.

## 7. Worker capability (full native ability)

### 7.1 Inputs

A work item names `repo`, `base` (a pushed SHA) and the task. A worker with its own computer clones it itself. For a private repo the worker cannot clone, Dalan offers a job-scoped download of a git bundle at `base`, with hard secret files left out. That download is an artifact of the work item, not a credential.

### 7.2 Outputs

A worker returns one of: a pushed branch and commit (if it can push), or a patch or bundle. Either way it reports its own test runs as `worker_reported` evidence: command, exit code, and an output tail.

### 7.3 Materialize and check

When the worker returns a patch, Dalan pushes it to `dalan/<work-id>` with owner credentials, and opens a draft PR in orgs where the relationship grants `push:<org>`. Dalan never gives credentials to the worker. If the owner configured a check for that repo, Dalan runs it on the materialized branch and records `bridge_observed` evidence. Merge rules stay with the repo owner. Dalan never merges to a protected branch on its own authority.

### 7.4 What a worker may receive

Anything in the repos and data the relationship grants, including other people's data where the owner allows it. The one hard line: no secrets, tokens or keys. Whole-job refusals by path name go away. The hard secret-file list only removes those files from what Dalan ships.

## 8. What Dalan reports

Dalan reports facts about its own work. Fleet-level measures (delegation share per orchestrator, filler use) belong to the tooling that sits on top. Dalan supplies the fields they need: a `requester` on every work item, and the route that carried it.

| Report | Definition | Source |
|---|---|---|
| Track record per kind and worker | Finished, blocked, refused by provider, checks passed, accepted, and n over the window | Lifecycle events and report outcomes (per-kind grouping is being added) |
| Forecast accuracy | Forecast start time against actual claim time, p50 error | Forecast stored at admission (new) |
| Starved minutes | Minutes with queued eligible work and a free, live lane | `lane_utilization.idle_while_queued` (exists) |
| Could not check my work | Build results with no passing test run of either evidence label | Evidence labels (new) |
| Time to start, time to result | p50 and p90 per class and kind | Lifecycle events (exist) |
| Route share | Work and deliveries per requester route (T3 child, MCP, CLI) and per wake path | `requester_route` and delivery adapter columns (new) |

## 9. Workaround ledger

Each workaround names the missing capability it supplies and what removes it.

| Workaround | Missing capability | Removed when |
|---|---|---|
| Child turn held open by the ACP facade for the whole job | ACP v1 has no background work after a prompt turn | ACP v2 background activity ships in T3; the facade then ends the turn and reports later |
| Fresh child turn to deliver after a restart (4.1) | No host API to attach an outside result to a delegated child | T3 offers an outside-completion API for delegated tasks, or ACP v2 session resume with state sync |
| Questions as a turn end with text, answered by a child message | ACP v1 has no agent-initiated question except permission requests; MCP elicitation and Tasks `input_required` are not supported by hosted workers | MCP Tasks or ACP v2 input requests are supported end to end |
| Priority and requirements parsed from the task header | `delegate_task` has no priority or requirements field | T3 passes provider options through to ACP, or adds the fields |
| Forecast as the child's first message | No host shows a provider's admission answer at delegate time | A host field for provider admission or ETA |
| Dalan materializes branches for workers that cannot push | The worker's computer has no git credentials, and Dalan will not supply them | The worker host offers its own scoped repo write (for example, a GitHub app on the worker side) |
| Bundle download for private repos | The worker cannot clone private repos without a credential | Same as above |
| Inbox-socket wake for Claude Code (frame format undocumented) | No documented outside-completion API for Claude Code sessions | A documented message frame, or the SDK route |
| Keyed user-role T3 message (`--deliver t3:`) | The caller is not a T3 child-task parent | The caller moves to the child route |
| Workers pull work over MCP and must be woken through their own conversation | Hosted workers (ChatGPT, Muse) expose no inbound API | The worker host offers A2A, ACP or a task API |

## 10. Likeliest-wrong assumptions and the probes that settle them

| # | Assumption | Cheapest settling method | Fallback if false |
|---|---|---|---|
| P1 | T3 keeps a child turn held by an ACP provider alive for hours. After a T3 restart, a fresh child turn started by an outside send wakes the parent through delegate completion. | Read T3 source at the installed version for the provider turn timeout and the parent wake on a child send. Then one live run with a fake worker that takes 2 hours, plus one T3 restart. | Deliver after a restart through the legacy keyed message into the parent. Record it in the ledger. |
| P2 | The dot's computer can clone public repos, install, run tests and return a patch, with Cloud network access on. | One dot job on a public repo: clone, `npm ci`, run one test, return the diff and test output. | Keep the bridge workspace tools for that worker, and run the checks on the owner side. |
| P3 | Claude Code's inbox socket accepts a message from a non-child process under `crossSessionInbound: accept`. | Read the Claude Code source or binary for the frame format; one local test session. | Background `dalan wait` plus a SessionStart inbox hook. |
| P4 | T3 passes `target.options` to an ACP provider. | Read the T3 ACP driver source. | Task header parsing (already the plan). |

## 11. Prior art used

Captured in the research library (not in this repo): async completion contracts for seven coding harnesses; the late-2026 survey of how Claude Code, Codex, T3 Code, Copilot, Devin and Cursor return delegated work and which allow an outside wake; T3 local ACP providers running delegated children; the finding that delegated-agent products separate the job, its runs and its results, and that none shows a reliable ETA; hosted coding agents bridging to local orchestrators through PR and issue webhooks; the finding that agent standards fit edges, not contributor authority; and the finding that a ChatGPT agent can be woken only through its own conversation (MCP Events).
