# Reuse ledger

Pinned source: cb6b119196f025ac8cbbf93f0ee8bd0a30221654. RETAIN describes current modules, not test execution. ADD, NEW, OPT and UP describe proposed work. No product code changes belong to A2.

## Retained modules

License `repo` identifies first-party code, not a license assertion for its dependencies. Node built-ins are not vendored packages. The ACP facade imports @agentclientprotocol/sdk 1.8.0 as declared in package.json. Its installed package.json is absent from this checkout; the dependency license is UNVERIFIED, not inferred from Dalan's license. Transitive dependency licenses need their own manifests before redistribution.

| Module | Does today | Disposition | License |
|---|---|---|---|
| `src/store.mjs#askQuestion` | Jobs, claims, reports; identified questions, answers and consumption. Owner capabilities, keyed submission, late evidence, decisions and transactional notification outbox. | RETAIN purpose and opaque generation; ADD revises, relationship and grant scope | repo |
| `src/protocol-owner-command.mjs#executeProtocolOwnerCommand` | Keyed owner commands bind job, owner hash, key, expected revision, operation and payload. Exact retry replays; changed identity conflicts. | RETAIN | repo |
| `src/claim-command-ledger.mjs#createClaimCommands` | Worker command receipts. | RETAIN | repo |
| `src/protocol-owner-waiters.mjs#createProtocolOwnerWaiters` | Durable owner wait materialization. | RETAIN | repo |
| `src/durable-waiters.mjs#createDurableWaiters` | Durable wait records across restart. | RETAIN | repo |
| `src/artifact-journal.mjs#createArtifactJournal` | Chunked byte-verified artifacts. | RETAIN | repo |
| `src/result-binding.mjs#createResultBindings` | Terminal result bindings to artifact digests. | RETAIN | repo |
| `src/protocol-stop-observer.mjs#createProtocolStopObserver` | Scoped stop observations require trusted evidence. | RETAIN | repo |
| `src/protocol-retention.mjs#assertProtocolAvailable` | Retention tombstones fence access. | RETAIN | repo |
| `src/lifecycle.mjs#lifecycleTypes` | Append-only lifecycle records coordinated with mutations. | RETAIN + ADD typed control events (C4) | repo |
| `src/destinations/index.mjs#createDestinations` | Requester destination adapter selection. | RETAIN; generation admission is implemented in the T3 destination | repo |
| `src/destinations/none.mjs#createNoneDestination` | No-delivery destination. | RETAIN | repo |
| `src/destinations/t3.mjs#createT3Destination` | Requester result delivery uses a stable message identity. | RETAIN opaque generation admission; inspect/send remains best effort, not an atomic upstream fence | repo |
| `src/ack-ledger.mjs#AckLedger` | Acknowledgment evidence for send attempts. | RETAIN | repo |
| `src/notify-ledger.mjs#NotifyLedger` | Durable send ledger; uncertain sends need reconciliation, not blind resend. | RETAIN | repo |
| `src/workers.mjs#parseWorkers` | Worker profiles, enrollment and connection digests. | RETAIN adapter declaration; ADD relationship link | repo |
| `src/tool-registry.mjs#createToolRegistry` | Default-deny worker grants, closed handler kinds and argument-free audit. | RETAIN + ADD grant scope (C3) | repo |
| `src/execution.mjs#admitHostExecution` | Capability declarations and execution admission. | RETAIN qualification pattern (C5) | repo |
| `scripts/capability-table-test.mjs#gate` | Checks declared capabilities against the gate. | RETAIN qualification pattern (C5) | repo |
| `src/mcp-stdio.mjs#TOOLS` | Requester MCP surface. | RETAIN + ADD dalan_answer and dalan_questions (B5) | repo |
| `bin/dot-worker.mjs#writeReceipt` | Requester CLI and owner receipt files. Existing receipt is not the proposed answer journal. | RETAIN + ADD answer/questions surface (B5) | repo |
| `src/demo-worker.mjs#workJob` | Deterministic worker. | RETAIN first-job prover and B4 fixture | repo |
| `src/try.mjs#beginPairing` | Harmless first-job route through OAuth enrollment. | RETAIN first-job prover and B4 fixture | repo |
| `src/pull-queue.mjs#PullQueue` | Policy-order queue; discovery and acquisition are distinct. | RETAIN route characterization A1 and live D1 | repo |
| `src/work-order.mjs#compileWorkOrder` | Policy work-order compilation and source scope checks. | RETAIN | repo |
| `src/acp-bridge.mjs#prepareAssignment` | ACP facade for T3 requester assignment preparation. | RETAIN as is; B-thin wake covers blocked-question continuation | repo |
| `bin/dot-acp-agent.mjs#runTurn` | ACP agent facade; blocked question ends the foreground turn rather than becoming native durable continuation. | RETAIN as is | repo; @agentclientprotocol/sdk: UNVERIFIED (package manifest unavailable) |
| `src/mcp-outcome.mjs#recordMcpResponse` | Tool response outcome is separate from job completed/blocked/failed (F28). | RETAIN | repo |
| `src/t3.mjs#inspectThread` | T3 thread inspection and classification. | RETAIN T3 adapter; generation comparison is present, atomic upstream fencing remains unverified | repo |
| `src/t3-transport.mjs#dispatchT3Result` | Stable-id T3 result dispatch. | RETAIN | repo |
| `src/t3-control.mjs#runT3Tool` | T3 reverse-control operations. | RETAIN | repo |
| `src/t3-audit.mjs#prepareT3Audit` | T3 control audit admission and records. | RETAIN | repo |
| scripts/conformance/ | Golden trace suite with real-server and SQLite harness; the design input specifies 42 traces. Count is not a test-pass claim. | RETAIN executable contract (D3); recheck the count when the suite changes | repo |

Additional source anchors: `src/store.mjs#answerQuestion`, `src/store.mjs#consumeAnswer`, `src/store.mjs#owner_submit_commands`, `src/store.mjs#destinationSnapshot`. Requester answer replay now also has `src/answer-journal.mjs#prepare`, `src/answer-journal.mjs#send` and `src/answer-journal.mjs#reconcile`.

## Small additions

The following rows separate implemented additions from remaining plans. The pinned `src/store.mjs#SUPPORTED_SCHEMA_VERSION` is 68. Schema 67 adds question purpose; schema 68 adds parent_generation and held notifications. Numbers 69–71 remain design reservations, not applied migrations. Reconcile merged migrations before implementation.

| Module | Does today | Disposition | License |
|---|---|---|---|
| `src/answer-journal.mjs#prepare` | Saves exact key, expected revision and text before send. `src/answer-journal.mjs#send` retries that envelope; reconcile reads back. | RETAIN (formerly NEW); R08, R11, R12 (R5). Runtime crash characterization remains a GAP here. | repo |
| `src/store.mjs#parent_generation` | Schema 68 persists an opaque value. `src/destinations/t3.mjs#readGeneration` owns decoding. | RETAIN (formerly NEW); R21 (R6). Atomic upstream stop/send fence remains a GAP. | repo |
| `src/store.mjs#QUESTION_PURPOSES` | Schema 67 distinguishes clarification, human decision, authentication and tool permission. `src/destinations/t3.mjs#messageFor` requests human handling for non-clarifications. | RETAIN (formerly branch plan), R13 (R7); `src/server.mjs#requireOperatorForHumanQuestion` requires the operator boundary; live human authorization is not runtime-certified here. | repo |
| src/store.mjs and CLI: revises link and stale guard | NEW semantic link, not a mutable attempt. | ADD migration 69, submit/decide and submit --revises; R14–R16 (C1) | repo (planned) |
| src/store.mjs, src/workers.mjs and CLI: relationships | NEW per-side relationship row and assignments.relationship_id; read-only grants composition. | ADD migration 70, relationships/grants commands; R02–R04, R18 (C2) | repo (planned) |
| src/tool-registry.mjs, src/server.mjs and store: tool_grants.scope | NEW scope on existing grant store. | ADD migration 71 and T3 wiring; R17, R19 (C3) | repo (planned) |
| `src/execution.mjs#ADAPTER_QUALIFICATIONS` and `src/execution.mjs#admitAdapterCapabilities` | mcp and protocol-v0 adapter declarations; only protocol-v0 declares identified_questions verified, restricted to that catalog. | RETAIN initial C5; further route/version qualification remains planned. R06, R07, R34; no hosted-provider certification. | repo |
| src/lifecycle.mjs, src/inbox.mjs, src/status-summary.mjs: typed control and held-wake display | Held delivery exists in `src/destinations/t3.mjs#holdItem`; wider typed-control semantics remain planned. | RETAIN held delivery; ADD remaining R20, R21 (C4, D2); no parent resurrection | repo (planned) |

## Optional and upstream work

| Module | Does today | Disposition | License |
|---|---|---|---|
| bin/dalan-acp-worker.mjs | Not built. | OPT ACP-client performer (D3) | repo (planned); future dependencies UNVERIFIED |
| A2A pull worker | Not built. | OPT D5 only for a named peer | UNVERIFIED until selected |
| Requester catalog profile | Not built. | OPT catalog change D4 for hosts unable to run Dalan | repo (planned) |
| T3 stopSeq / message.dispatch ifStopSeq | Upstream capability proposal; not Dalan code. | UP B6; do not emulate a missing stop fence with an unsafe fallback | upstream, UNVERIFIED |

Not built: a RequesterPort/WorkerPort layer, BindingIdentity table, route-negotiation service, broker, workflow engine, or universal capability token. These additions are not prerequisites for retaining the current facilities.

## Verification gaps

GAP: no runtime tests or live host/provider qualification were executed. Source anchors identify facilities, not proven failure closure. GAP: atomic upstream stop/send admission remains unavailable in this inspection. GAP: correction/relationship/scoped-tool semantics and their planned migrations remain design work. GAP: third-party package manifests were unavailable for @agentclientprotocol/sdk and @tnunamak/gozar, so their licenses are UNVERIFIED; root package declarations cannot establish dependency licenses. The latter is imported by `src/server.mjs#main`. No dependency license is inferred from the first-party repo label.
