# Dalan target architecture v2: remote workers as native subagents

Status: proposed, 2026-11-27. It supersedes the slice plans (the R4-R9 route decision and the A-D PR graph) where they conflict. It keeps the core ideas of the 2026-11-14 target architecture: separate relationship, work and authority, durable delivery, and host-neutral core.

## 1. The bar

An orchestrating agent (Claude Code, Codex, or a T3 Code thread running either) already knows how to use a subagent. It makes one call with a task, it may end its turn, and a native completion notice wakes it later with the result. Dalan's bar is **parity with that, from the caller's view**. Each difference that a caller can see is a gap that Dalan closes or names.

Dalan is the bridge only: relationships, work, authority, delivery and wake, worker capability, and the surface that requester agents call. Job generators, filler queues and fleet nudges are tooling on top of Dalan. They adopt Dalan; they are not part of it.

The bar has three parts, judged separately:
- **Live initial delegation**: call, forecast, completion wake and result while both host and facade stay up. The first v2 release must reach parity here.
- **Recovery parity**: the result after a host or facade restart. v2 makes the result durable and its status truthful, and finishes the original task through T3's own restart continuation. That claim waits for the P1 crash probes (section 10).
- **Interaction parity**: questions, corrections and cancel. v2 makes each one structured and honestly reported. Where the host cannot show it natively, the table below names the gap.

### 1.1 Parity table (caller's view)

Reference: a Claude Code `Agent` subagent or a Codex `spawn_agent` child. Gap kinds:
- **V2**: v2 closes it.
- **NATIVE**: it closes through a native protocol route once the host supports it. Until then a versioned adapter supplies it and is listed in section 9.
- **SHARED**: a provider limit that native subagents also have in some form. Dalan does not work around it. It reports the limit as an honest status the caller can see, the way a subagent's rate-limit error is visible.

| # | Property | Native subagent | Dalan worker on main (d0dd670) | Gap kind | v2 |
|---|---|---|---|---|---|
| 1 | How you call it | One tool call: prompt, model or target, isolation, background | T3: `delegate_task target:{providerInstanceId:"dot"}` already reaches Dalan through `bin/dot-acp-agent.mjs`; 3 of about 30,000 jobs in 7 days used it. CLI: `dalan submit` with about 20 flags. MCP `dalan_submit`: 6 fields, no delivery, no kind. | V2 | Each host's own subagent call (section 4). The same work fields on every route: task, priority class, requirements, repo, base. |
| 2 | Answer at submit | Starts at once, or fails at once (rate limit) | `queued`. Queue-wait data exists (`store.mjs:1175`) but is used only for `valid_until`. | V2 | Measured admission: `starts now` only with a reserved lane and a live worker; otherwise `queued` with measured claim and start latencies, and the count and age of eligible work ahead. For `critical`: `refused: no reservable lane`. Also the per-kind track record (section 6). |
| 3 | Wake on result | Native completion notice in a later turn; caller may end its turn | T3 only, as a user-role chat message into the parent; protected threads suppress it. A background `dalan wait` dies with the turn or with T3. | V2 (T3, Claude Code); NATIVE (Codex CLI) | The host's own child-completion path; never chat in a main thread (section 5). |
| 4 | Wake on question | Claude Code: no questions from subagents (`AskUserQuestion` removed); permission prompts surface in the main session. T3: a child stops and the parent is woken. | `ask_question` exists with keyed answers (#38) and purpose (#32). The pinned ACP facade renders a question as text and ends the turn (`bin/dot-acp-agent.mjs:295-299`); the next prompt becomes a steering note, not a keyed answer (`:191-205`). On the legacy route the question reaches T3 as chat carrying a `dalan answer` command. | V2 for structure; NATIVE for the host's question card (T3 shows a pending question only for a live `user_input` runtime request; ACP v2 input requests; MCP Tasks `input_required`) | The child's turn ends with a structured question: work id, question id, purpose, expected respondent. An answer counts only on the bound relationship (the child thread bound to that work) and must name the question, or there must be exactly one open question. Dalan stores the answer receipt before it acknowledges the wake. A message without a question reference is never an answer and never authority. A `human_decision` question cannot be answered this way. Until the host shows a question card, the parent sees the question as the child's text. |
| 5 | Correct running work | `SendMessage` to the agent; T3 `t3_thread_send` steer | `note` only | V2 | An explicit `correct` operation: applied in place where the worker can take it, otherwise successor work linked by `supersedes`. The caller makes the same call either way. A follow-up to the child without a question reference is a correction request, not an answer. |
| 6 | Cancel | `TaskStop`, `interrupt_agent`, `task_cancel` | The ACP facade maps T3 cancel to `cancel`, which withdraws only unclaimed work; claimed work keeps running and the caller is not told (`bin/dot-acp-agent.mjs:393-416`) | V2 for the report; SHARED for a mid-step stop | Two facts reported separately: `requester_interrupted` (the child turn stopped) and the worker's state (`withdrawn`, `stop_requested`, `still_running: result will be held, not delivered`). A hosted worker cannot always be stopped mid-step (C4 #40 already records this). |
| 7 | Streaming progress | Claude Code shows the subagent's transcript; T3 shows the child thread live | `progress` events stored; the ACP facade sends heartbeats; little reaches the caller | V2 | Facade relays the worker's `progress` and `ack_message` events as child-thread agent messages (visible, never a wake). |
| 8 | Tool and repo access | The caller's own tools, files and credentials (scoped by permission mode) | `read_file`, `apply_patch`, allowlisted `run_check`; files named like `auth` or `token` refuse the whole job | V2 for repo access; SHARED for the worker's own tool set | The worker uses its own computer and its own tools: a public repo at `base`, or for a private repo the scoped file set with a manifest (section 7.1). Secrets never reach it; a hard secret file is left out of the file set instead of refusing the job. The worker's own tool policy is the provider's. |
| 9 | Running code and tests | Shell in the caller's environment | No shell. In the 7 days to 2026-11-27 04:56 UTC, 6,875 of 6,989 build jobs (98.4%) had no passing check; 1,961 of them reported a blocked check, test or build (before-measures snapshot of the live store) | V2 where the worker has a computer; SHARED where the provider withholds a shell or network | The worker runs code on its own computer and reports `worker_reported` evidence; Dalan can add `bridge_observed` checks on the materialized branch. |
| 10 | Result shape | Text plus files in the shared worktree or an isolated worktree branch | A patch in a bridge workspace; fleet tooling turns it into a branch | V2 | Patch plus evidence by default. A branch and draft PR only after the owner authorizes that exact materialization (section 7.3). |
| 11 | Recovery after a crash | Claude Code: an in-process subagent dies with the process; the transcript is resumable. T3: delegated tasks and completions persist. | Store and outbox persist; the ACP turn dies with T3. The facade clears its saved pointer on finish (`bin/dot-acp-agent.mjs:383-387`), so a fresh prompt to the child starts a new acquire instead of replaying the result (`:191-209`). | V2 | Work and its terminal event persist in Dalan. On T3's restart continuation (`session/load`), the facade reattaches and finishes the original task, so the parent is woken natively. When T3 does not continue the run, the result waits in the recovery inbox and `status` says so. Claimed only after the P1 crash probes pass (sections 4.1, 10). |
| 12 | Rate limits and breaks | The provider's error is visible to the caller at once | The worker goes quiet; jobs sit queued | SHARED | Status, not a workaround: `worker_state: break (until T)` in the admission answer, and a child message when an accepted job is delayed by a break. |
| 13 | Provider policy refusals (for example OpenAI Guardian) | The refusal text reaches the caller | Often a blocked result with little reason | SHARED | The worker's refusal is passed through verbatim as `outcome: refused_by_provider`. |
| 14 | Session length | Context limits and compaction | Hosted sessions end after minutes (Muse about 7-10 min) | SHARED | Shown in the track record and admission answer (`typical session ~N min`). Work is sized by the caller, as with a subagent. |
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
| `--deliver t3:<thread>` user-message wake (`src/destinations/t3.mjs`, `t3-transport.mjs`) | **Changes**: legacy adapter | It stays for callers that cannot use the child route, but it is no longer the default. Its binding checks, protected-thread suppression and uncertain-send state stay (`src/destinations/t3.mjs:60-65, 94-126`). It moves out of the core only after its replacement is verified. |
| `bin/dot-acp-agent.mjs` T3 ACP facade | **Changes**: becomes the primary T3 adapter | Already registered as T3 providers `dot` and `muse`. It needs: a structured question that ends the turn, a follow-up prompt bound to an answer or a correction (parity rows 4-5), the admission answer as the first agent message, separate IDs for the original and any later host task (section 4.1), a cancel report that separates the requester from the worker, and no "usage break exceeded the turn wait limit" failure. |
| `assignments.thread_id`, `environment_id` NOT NULL; delivery string only `none` or `t3:` | **Changes** | Delivery becomes `{adapter, address, adapter_version}`, with T3 columns moved into the T3 adapter's own table. The core names no host. |
| Worker catalog `read_file`, `apply_patch`, `run_check` | **Changes**: kept for workers without a computer | A worker with its own computer gets the work as repo, base and task, and returns a branch or patch with evidence. |
| Host `run_check` allowlist and `scope_paths_read_isolation_unavailable` | **Changes**: becomes acceptance evidence, not the worker's only test route | Owner-side checks still run on the returned branch when configured. They label their evidence `bridge_observed`; the worker's own runs are labeled `worker_reported`. |
| Name-based refusals (`auth`, `sign*`, `token`, `*secret*` soft names) | **Goes** as whole-job refusal | Safety is "no secrets, tokens or keys reach a worker". The exclusion, symlink and patch-authorization boundary stays (`src/submission-policy.mjs:306-349, 417-448, 537-546`). A hard secret file is left out of the shipped file set; it does not refuse the job. Content scanning (`hasSecretContent`) stays as defense in depth, not as proof. |
| `status.dispatch` scoped to `dot` | **Changes**: per worker | It stays as a simple dispatch diagnostic, keyed by worker name. The admission answer (section 6) does not replace it. |
| `dalan wait` loops as the wake for non-T3 callers (`docs/local-agent-requester.md`) | **Goes** as the documented wake | It stays as a tool for scripts. Section 4.3 gives native wakes. |

## 3. Core model (enduring)

The core owns six things, and nothing about any one host.

1. **Relationship**: who works for whom, with which route on each side (`requester_route`, `worker_route`) and adapter version.
2. **Work**: `{task, kind, priority_class, requirements, repo, base, inputs, outputs_expected}`. Requirements are capability names (`shell`, `internet`, `push:<org>`, `tests:<selector>`, `identified_questions`). Admission compares them with qualified worker capabilities and refuses before creating the job, never later.
3. **Authority**: grants per relationship and per work item. The safety line is a core invariant: **no credential, token or key enters a work payload, a worker tool result, or an artifact the worker can fetch.** Content scanning enforces it at submit and at every artifact download.
4. **Events**: one typed stream per work item: `admitted(forecast)`, `claimed`, `progress`, `question`, `answered`, `amended`, `artifact`, `finished(outcome, evidence)`, `cancelled`. Every adapter reads this stream. Delivery is "deliver the events this route subscribes to, keyed by `(work, event)`, until the host's receipt is observed". Dalan cannot make delivery exactly once in a host that does not deduplicate its key, so an unconfirmed send is recorded as `uncertain` and shown, never silently resent (section 5).
5. **Evidence**: each claim about the result carries its trust label: `worker_reported` (the worker says so), `bridge_observed` (an owner-side check ran on the materialized result), or `owner_accepted`. A label states who observed the fact, not that the fact is true.
6. **Measures**: per kind and per worker: queue wait, start latency, outcome rates, check pass rate, acceptance rate, and "could not check my work" rate. Section 8 lists them.

Operations, the same on every route: `delegate`, `forecast`, `status`, `result`, `questions`, `answer`, `correct`, `cancel`, `accept|reject`, `artifact`.

## 4. Requester routes (versioned, disposable adapters)

The rule: **the caller uses the subagent call its host already has.** Dalan supplies an adapter per host. Each adapter states which capabilities it actually delivers (design for the expected capabilities; advertise only the delivered ones).

### 4.1 T3 Code child task (primary; covers Claude and Codex threads in T3)

- Call: `delegate_task {task, target:{providerInstanceId:"dot"|"muse"|<worker>}, isolation}`. T3 creates a child thread whose agent is Dalan's ACP facade. The parent gets T3's own reply: "Completion wakes this thread."
- The child turn is held while the work runs. This is right for a child: the long turn is the child's, not the parent's. The parent shows `waiting_for_children`.
- Completion: the facade ends the child turn with the result summary, branch, PR and evidence. T3 wakes the parent with its native delegate-completion notice. **No chat message reaches the parent thread.**
- Questions: the facade ends the child turn with a structured question block: work id, question id, purpose, expected respondent, and the text framed as untrusted data. T3 wakes the parent as for any child that ends its turn. The parent answers with `t3_thread_send` to the child, naming the question id. The facade accepts it as the keyed `answer` only under the rules in parity row 4, stores the receipt, then ends the turn. A prompt with no question reference becomes a `correct` request. A `human_decision` question is not answerable this way; the facade says so.
- Priority and requirements: given in the task text header (`priority: critical|normal|background`; `requires: ...`) or as ACP model options when T3 passes them. The facade parses them.
- Admission: the facade's first agent message in the child is the admission answer (section 6). For `critical` with no reservable lane, the facade ends the turn at once with `refused: no reservable lane`, plus the measured wait. The parent gets that within seconds and can route to a subscription agent instead.
- Cancel: T3 cancel ends the child turn. The facade reports `requester_interrupted` and, separately, what happened to the worker (parity row 6).
- Identity: in T3, a message to a finished child, or a follow-up delegate, is a **new host task** with its own task id. It is not an acknowledgment of the original. An already-open follow-up may be reused. T3 also has its own recovery continuation for the original task. The facade therefore stores, per work item: the Dalan work id, the original T3 task id, the immutable terminal event (with its hash), and any later host task id, each in its own field. A fresh prompt that names a work id with a stored terminal event is answered from that event and never starts a new acquire.
- Restart: if T3 or the facade dies mid-turn, the Dalan work continues and its terminal event is stored. T3 marks the interrupted run `cancelled`, then, for eligible runs, submits a separate restart continuation and calls `session/load` on a provider that advertises it (the facade does). While that continuation is pending, T3 holds the parent with the child task still running. If the continuation completes, the original task completes with its summary and the parent is woken natively; if it is declined or stopped, the task settles as `cancelled` (T3 3dbefda28: `ProviderRuntimeRecoveryService.ts:671-739`, `RestartContinuation.ts:170-237, 338-372`, `AcpSessionRuntime.ts:2464-2493`, `OrchestratorMcpService.ts:1934-1939`). So the facade's job on `session/load` is to reattach to the stored work and finish the original task from the stored terminal event. That is the primary recovery route. The recovery inbox (`status`, `dalan get`) is the floor when T3 does not continue the run. Dalan does not post into a protected parent. Sending a keyed message into the child (a new host task) is a separately gated step, used only after Dalan has reconciled host state against the exact terminal event.

### 4.2 MCP requester (any MCP host)

`dalan mcp` gets the full verb set (`dalan_delegate`, `dalan_forecast`, `dalan_status`, `dalan_result`, `dalan_questions`, `dalan_answer`, `dalan_correct`, `dalan_cancel`, `dalan_accept`) and every work field. Today the MCP tool is a bounded wait plus result and question operations (`src/mcp-stdio.mjs:20-35, 122-141`), not a deferred completion notice. The reply to `dalan_delegate` carries the admission answer and a truthful `next` text. By default that text says the caller must check `dalan_status` or `dalan_result` later, or read the inbox. It says "Completion wakes this session" only where a gated wake integration (4.3) is enabled for that host.

Native protocol route for MCP hosts: the MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663, MCP 2026-07-28), an official optional extension. Here `dalan_delegate` returns `resultType: task` instead of a final result. The host polls `tasks/get`, which reports `working`, `input_required`, `completed`, `failed` or `cancelled`. Dalan questions map to keyed `inputRequests`, and the caller's `tasks/update` answer maps to Dalan's keyed answer under the rules in parity row 4. Claude Code documents Tasks support and host polling ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)). That does not show that a disconnected or idle session wakes. Codex, ChatGPT and Cursor show no verified support as of 2026-11 (research library entry, 2026-11-27). Dalan offers Tasks only when the host negotiates the extension, and describes it as host polling, not a wake.

### 4.3 Wakes for hosts outside T3 (gated integrations, not v2 defaults)

v2 ships the disposition contract for every host: `status`, `result`, the inbox, and truthful labels for each. An outside wake is an independent integration. Each one gets its own gate (a documented host interface, a probe, and an opt-in setting) and ships separately from v2. v2 does not build these four adapters speculatively. The candidates, as of 2026-11:

| Host | Candidate wake | Status |
|---|---|---|
| Claude Code session | Cross-session inbox socket (v2.1.224+): "When the receiving session is idle, Claude Code starts a new turn with the message." Gated by `crossSessionInbound` (accept, hold, refuse). | Not on the default path. Only the auth line is documented; the message frame is not. Candidate only after a documented frame or SDK route exists (probe P3, off the release path). Default today: the inbox, with an optional SessionStart hook that shows `dalan inbox`. |
| Claude Code, MCP channels | `notifications/claude/channel` from `dalan mcp` | Research preview; needs a development flag. Not built. |
| Codex app-server | `turn/start` or `thread/inject_items` on a loaded thread | Unloaded threads cannot be woken. Not built; work waits in the inbox. |
| Codex CLI alone | None found | Poll, stated honestly. |

### 4.4 A2A peer (future)

When a peer speaks A2A, Dalan maps A2A task, message and artifact to work, question and artifact, behind a versioned adapter. It is a transport for work and results, not a source of authority: grants still come from the relationship. Nothing in the core changes. Not built in v2; the core must not prevent it.

## 5. Delivery and wake rules

1. **Deliver on the caller's own path.** For the T3 child route, the child thread and T3's completion are the path. Dalan never posts results as chat into a parent thread on that route, and never posts to a protected parent by default.
2. **One wake per decision.** Completion, a question, or a refusal wakes the caller. Progress never does.
3. **Observed receipt or stated uncertainty.** Every delivery has a key derived from `(work, event)`. A delivery is done only when Dalan observes the host's receipt. If Dalan cannot tell whether the host received it, the delivery is `uncertain` and `status` shows it. A stable local key does not stop a double wake in a host that ignores the key, so Dalan does not resend blindly.
4. **Reconcile before any retry.** After a Dalan, facade or host restart, Dalan reads the host's own record for the exact terminal event and the stored host task ids before it sends again. A new host task id is stored beside the original, never in its place.
5. **Inbox is the floor.** If no adapter can wake the caller, the event waits in `dalan inbox`, and `status` says so. That is a valid route, not an error.

## 6. Admission, forecast and track record

- Priority classes: `critical` (start now or refuse), `normal` (queue, with an estimate), `background` (queue behind normal).
- A free lane or a first claim is not a start. Today `queueWaitEvidence` (`src/store.mjs:1171-1198`) measures to the first stored claim and uses lower bounds for work that expired unclaimed. v2 measures two latencies: **claimed** (first claim) and **started** (the worker's first substantive event on the work, such as a workspace read or a progress event). Censored samples (expired or cancelled before a claim or a start) are counted in their own group and never mixed into the percentiles.
- Admission answer: `start: "now"` only when Dalan has reserved a lane for this work and the worker's subscription is live at that moment. Otherwise `start: "queued"` with the facts: eligible ready work ahead (count and oldest age, same or higher class), measured claimed and started latencies (p50/p90, n, window, censored count), and the worker state (`live`, `break until T`, `no live subscription`). `critical` without a reservation is `refused`. Below 10 samples it says `insufficient_history` and gives no number.
- Track record, with outcomes kept apart: `unable_to_run`, `checks_failed`, `check_passed`, `landed` (merged or applied by the owner), plus `refused_by_provider`, n and window. "No passing check" is never reported as one blocked number.
- `status.dispatch` stays as a simple diagnostic beside this answer (section 2).
- No delegated-agent product shows a reliable ETA (see the prior-art list). Dalan reports only measured values with their basis, so a caller can judge them.

## 7. Worker capability (full native ability)

### 7.1 Inputs

A work item names `repo`, `base` (a pushed SHA, the anchor) and the task. A worker with its own computer clones a public repo itself.

For a private repo, Dalan does not ship the whole checkout or any git metadata. A git bundle at `base` cannot leave files out and keep the commit's identity, so it is not used. Dalan ships the scoped file set the relationship permits, through the existing exclusion and symlink rules (`src/submission-policy.mjs:306-349, 417-448`): regular files only, hard secret files left out. A manifest goes with it: each path, its content hash, and the anchor SHA. The manifest is how the owner side later proves which files the patch was written against. That download is an artifact of the work item, not a credential.

### 7.2 Outputs

A worker returns a patch against the anchor, or, if it can push with its own access to a public repo, a branch and commit. It reports its own test runs as `worker_reported` evidence: command, exit code, and an output tail.

### 7.3 Materialize and check

The default result is the patch plus evidence. The owner side applies the patch to the anchored original commit, never to the worker's snapshot. Dalan first checks that the manifest hashes match the anchor and that the patch touches only permitted paths (the existing patch-authorization boundary, `src/submission-policy.mjs:537-546`). Dalan never gives credentials to the worker and never puts publisher authority into worker execution.

Turning a patch into a `dalan/<work-id>` branch and a draft PR is a separate, explicit owner decision: one authorization naming the exact repo, branch, patch hash and owner. A relationship grant such as `push:<org>` is not that consent, and neither is a worker's branch. If the owner configured a check for that repo, Dalan runs it on the materialized branch and records `bridge_observed` evidence. Merge rules stay with the repo owner. Dalan never merges to a protected branch on its own authority.

### 7.4 What a worker may receive

Anything in the repos and data the relationship grants, including other people's data where the owner allows it, within the scoped paths of the work. The one hard line: no secrets, tokens or keys. Whole-job refusals by path name go away; the hard secret-file list removes those files from what Dalan ships. Content scanning stays as defense in depth; it is not proof that nothing secret left.

## 8. What Dalan reports

Dalan reports facts about its own work. Fleet-level measures (delegation share per orchestrator, filler use) belong to the tooling that sits on top. Dalan supplies the fields they need: a `requester` on every work item, and the route that carried it.

| Report | Definition | Source |
|---|---|---|
| Track record per kind and worker | Separate counts: unable to run, checks failed, check passed, landed, refused by provider; n and window | Lifecycle events and report outcomes (per-kind grouping is being added) |
| Admission accuracy | For `start: now`: share that started within 5 minutes. For `queued`: stated p50 against actual start | Admission answer stored at submit (new) |
| Starved minutes | Minutes with queued eligible work and a free, live lane | `lane_utilization.idle_while_queued` (exists) |
| Could not check my work | Build results with no passing test run of either evidence label, split into no check run, check failed, and unable to run | Evidence labels (new) |
| Time to claim, time to start, time to result | p50 and p90 per class and kind; censored samples counted apart | Lifecycle events (exist); `started` event (new) |
| Uncertain deliveries | Deliveries with no observed host receipt | Delivery records (new) |
| Route share | Work and deliveries per requester route (T3 child, MCP, CLI) and per wake path | `requester_route` and delivery adapter columns (new) |

## 9. Workaround ledger

Each workaround names the missing capability it supplies and what removes it.

| Workaround | Missing capability | Removed when |
|---|---|---|
| Child turn held open by the ACP facade for the whole job | ACP v1 has no background work after a prompt turn | ACP v2 background activity ships in T3; the facade then ends the turn and reports later |
| Recovery inbox when T3 does not continue the run; a gated new host task to re-wake (4.1) | No host API to attach an outside result to the original delegated task. A message to the child is a new host task (T3 `tools.ts:282-291`, `OrchestratorMcpService.ts:3763-3816` at 3dbefda28) | T3 offers an outside-completion API for delegated tasks, or ACP v2 session resume with state sync |
| Questions as a structured block at a turn end, answered by a child message naming the question | ACP v1 has no agent-initiated question except permission requests. T3 shows a pending question only for a live `user_input` runtime request (`OrchestratorMcpService.ts:2061-2072`). Hosted workers do not support MCP elicitation or Tasks `input_required`. | MCP Tasks or ACP v2 input requests are supported end to end |
| Priority and requirements parsed from the task header | `delegate_task` has no priority or requirements field | T3 passes provider options through to ACP, or adds the fields |
| Admission answer as the child's first message | No host shows a provider's admission answer at delegate time | A host field for provider admission or ETA |
| Owner-authorized materialization of a branch and draft PR | The worker's computer has no git credentials, and Dalan will not supply them | The worker host offers its own scoped repo write (for example, a GitHub app on the worker side) |
| Scoped file set with a hash manifest for private repos | The worker cannot clone private repos without a credential, and a whole checkout would exceed the scoped grant | Same as above, with path-scoped read |
| Keyed user-role T3 message (`--deliver t3:`) | The caller is not a T3 child-task parent | The caller moves to the child route |
| Workers pull work over MCP and must be woken through their own conversation | Hosted workers (ChatGPT, Muse) expose no inbound API | The worker host offers A2A, ACP or a task API |

## 10. Likeliest-wrong assumptions and the probes that settle them

| # | Assumption | Cheapest settling method | Fallback if false |
|---|---|---|---|
| P1 | (a) T3 keeps a child turn held by an ACP provider alive for hours. **Settled by source read 2026-11-27**: the registry adapter sets no prompt inactivity timeout; only provider close, outage or abort end it. (b) The original result is neither lost nor delivered twice at each crash point, and T3's restart continuation with `session/load` completes the original task. **Source says yes, conditionally** (section 4.1); not yet run. (c) A message to a settled child is a new follow-up task. **Settled by source**: it needs a settled original and an eligible parent; it may reuse an open follow-up. | Source read done (T3 main 3dbefda28 and v0.1.13). Remaining: short scripted fault probes with a fake worker, one per crash point: before the facade finishes; after the final emit but before the host acknowledges; after the facade clears its saved pointer; and during a restart of both T3 and the facade. Each checks the stored IDs, the terminal event and the wake count. Only then one 2-hour soak. | Keep the recovery inbox as the only post-restart path. Never fall back to posting into a protected parent. |
| P2 | The ChatGPT worker's computer can clone public repos, install, run tests and return a patch, with Cloud network access on. | One ChatGPT-worker job on a public repo: clone, `npm ci`, run one test, return the diff and test output. | Keep the bridge workspace tools for that worker, and run the checks on the owner side. |
| P3 | Claude Code's inbox socket accepts a message from a non-child process under `crossSessionInbound: accept`. Off the release path (section 4.3). | Wait for a documented frame or SDK route; until then, no build. | The inbox plus an optional SessionStart hook. |
| P4 | T3 passes `target.options` to an ACP provider. **Settled by source read 2026-11-27: only as model configuration.** T3 validates options against the provider's advertised model config and applies them with `setConfigOption`; it does not pass arbitrary fields. | Done. | Task header parsing for priority and requirements (the plan). A provider could advertise `priority` as a config option; probe before relying on it. |
| P5 | The facade can raise a question that T3 shows as a native pending question. The shared ACP adapter converts some provider question forms into `user_input` (`packages/provider-acp/src/server/adapter.ts:8231-8265` at 3dbefda28). | Read that conversion path; one fake-provider run. | The structured text block of parity row 4. |

## 11. Prior art used

Captured in the research library (not in this repo): async completion contracts for seven coding harnesses; the late-2026 survey of how Claude Code, Codex, T3 Code, Copilot, Devin and Cursor return delegated work and which allow an outside wake; T3 local ACP providers running delegated children; the finding that delegated-agent products separate the job, its runs and its results, and that none shows a reliable ETA; hosted coding agents bridging to local orchestrators through PR and issue webhooks; the finding that agent standards fit edges, not contributor authority; and the finding that a ChatGPT agent can be woken only through its own conversation (MCP Events).

Primary sources behind the claims in sections 4 and 9, as read on 2026-11-27: [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) (Tasks support and polling); [ACP v2 migration guide](https://agentclientprotocol.com/protocol/v2/migration) (a preview; not an outside completion path); the MCP Tasks extension proposal SEP-2663 (`io.modelcontextprotocol/tasks`, MCP 2026-07-28); T3 Code source at commit 3dbefda28 (files and lines cited where used); Dalan `main` at d0dd670 (files and lines cited where used).

## 12. Separation: Dalan and the tooling built on it

Rule: this repository holds the bridge only: relationship, work, authority, delivery and wake, worker capability, and the surface that requester agents call. Tooling that an operator builds on top (job generators, admission gates, wake scripts, nudges to workers, filler rules, fleet reports) uses only Dalan's public interface. That interface is the CLI and MCP verbs, `status`/`metrics`/`get` JSON, the config files documented in `docs/`, and the requester adapters. Tooling holds no Dalan internals. Dalan holds no operator rules, host thread ids, account names or fleet vocabulary.

Where the line is crossed today, and where each piece moves:

| Crossing | Direction | Moves to |
|---|---|---|
| Host fields in the core schema: `assignments.thread_id` and `environment_id` NOT NULL, `parent_generation`, `t3_muted`, the `t3` notification kind, the `t3_audit` table | Host in core | The T3 adapter's own tables under `integrations/t3/`. The core keeps `{adapter, address, adapter_version}` (build L6). |
| T3 worker tools (`t3_thread_*`), `t3` worker capability, `t3.read`/`t3.write` scopes, `DALAN_T3_*`, `--allow-main`, `--thread`, `--producer-thread`, `main_thread_ids` | Host in core | A T3 tool pack and a T3 destination, loaded as adapters. `main_thread_ids` becomes the T3 adapter's own config. |
| The worker name `dot` hard-coded in the core: about 80 literals in `src/store.mjs` (dot-only `dispatch`, a break hold only for `dot`, a legacy default worker), plus `DOT_ACP_*`, the `dot-decision` prefix, and the `[dot-bridge event]` label | Deployment in core | Worker-neutral: every rule keyed by worker name from `workers.json`. The `DOT_*` names stay as aliases for one release. |
| ACP facade: T3 role-preamble stripping and the T3 envelope (`src/acp-bridge.mjs`), and the producer config's `deny_path_terms` and `repo_selection` read by the facade | Host and operator policy in core | `integrations/t3/acp-kit/`. Repo selection becomes a documented config of the facade, not a producer file. |
| `DALAN_ACP_PROSE_CHECK` (an external prose linter run on build output) | Operator tooling in the adapter | Stays as a generic, optional post-result hook with a documented contract. Dalan names no specific linter. |
| Operator scripts that open the bridge database or Dalan's home directly: 34 files, 23 of them opening `bridge.db` | Tooling into internals | `dalan status --json`, `dalan metrics --json`, and new read verbs for whatever they need (queue by class, per-kind record, deliveries). The schema is internal and may change without notice. |
| Patch landing (turning a worker patch into a branch and draft PR) done by operator tooling | Tooling doing bridge work | Dalan's materialize step, on an explicit owner authorization (section 7.3). Tooling keeps only its own merge policy. |
| Admission decisions in an operator gate (deny, then override on repeat) | Tooling doing bridge work | Dalan's admission answer and `critical` refusal (section 6). An operator gate may still apply its own routing policy on top. |

Test for the rule: a second operator with no fleet could install Dalan, use every requester route, and see no name or rule from this operator. And this operator's tooling keeps working across a Dalan schema change.

## 13. Consumers and the product-neutrality check

Dalan must not depend on T3, on any one fleet, or on any one product. Named consumers:

| Consumer | Uses | Must not require from Dalan |
|---|---|---|
| T3 Code threads (Claude, Codex) | The T3 child-task adapter (4.1) | Nothing T3-specific outside `integrations/t3/` |
| Plain Claude Code or Codex sessions | MCP requester (4.2) and wake adapters (4.3) | Nothing host-specific in the core |
| An operator's fleet tooling | The public interface (section 12) | Fleet rules in Dalan |
| Faravan (planned): people lend coding-agent time to people they trust | The relationship, work and authority model | Circles, lending strategies, presence, approval UI or people's names |

Faravan check: could Faravan's lending loop sit on Dalan without Dalan learning anything Faravan-specific?

- **Fits.**
  - A lending arrangement is a relationship with role symmetry: either member may request or serve. A borrowed job is work. The lender's rules (hours, limits, approval mode) are authority grants on that relationship.
  - The lender's local agent is a worker on the ACP-runtime pattern. The borrower's agent is a requester on the MCP route.
  - Results, questions, cancel and delivery are Dalan's unchanged.
- **Gap 1: authority has more than one human owner.** Dalan today has one owner and one operator key per install. Faravan needs two people, each the authority over their own side of a relationship. The core must keep authority per relationship side (C2 already separates the lifetimes) and must never assume one owner. v2 adds no new single-owner assumption.
- **Gap 2: no always-on host.** Dalan today is one server with one SQLite store. Faravan's rule is that any online member serves the circle. The core must stay usable as an embedded library with its own store per member, with relationships that span peers. v2 does not build this. It keeps the store behind the Store class, puts all host I/O in adapters, and adds nothing that assumes a single server.
- **Verdict.** Faravan fits the model. The two gaps are in authority ownership and deployment shape, not in the work model. v2 must not widen either gap, and a Faravan adapter must be possible without core changes beyond those two.
