# Failure closure map

The Closed by column names planned PR responsibility, not merged or tested closure. characterized marks the supplied A1 characterization targets and existing source seams; no traces were executed for this document. gap marks a partial facility that does not by itself solve the failure. open means no facility identified at this pin. A cited facility is an anchor, not a claim that the whole failure is solved.

| F | Title | Facility today | Closed by (PR id) | Status |
|---|---|---|---|---|
| F01 | Lost creation reply | `src/store.mjs#owner_submit_commands` | A1 | characterized |
| F02 | Conflicting idempotency payload | `src/protocol-owner-command.mjs#executeProtocolOwnerCommand` | A1, B1 | characterized |
| F03 | Completion precedes start response | `src/result-binding.mjs#terminalAuthority` | A1 | characterized |
| F04 | Question after foreground ends | `src/store.mjs#askQuestion` | A1, B2 | characterized |
| F05 | Pending question restart | `src/store.mjs#job_questions` | A1, B2 | characterized |
| F06 | Answer saved before preparation | `src/answer-journal.mjs#prepare` | B1 | gap |
| F07 | Answer prepared before send | `src/answer-journal.mjs#send` | B1 | gap |
| F08 | Remote answer committed; reply lost | `src/answer-journal.mjs#reconcile` | B1 | gap |
| F09 | Human consent sent to model | `src/store.mjs#QUESTION_PURPOSES`; `src/destinations/t3.mjs#messageFor` | B3 | gap |
| F10 | Question node equals task node | `src/store.mjs#job_questions` | A1, B4 | characterized |
| F11 | Correction before finish | none | C1 | open |
| F12 | Finish before correction | none | C1 | open |
| F13 | Correction with question outstanding | none | B3, C1 | open |
| F14 | Stale epoch write | `src/store.mjs#consumeAnswer` | A1, B4 | characterized |
| F15 | Connection replaced | `src/workers.mjs#connectionsDigest` | A1, C2 | characterized |
| F16 | Revocation after await | `src/store.mjs#destinationAdmissionInTransaction` | A1 | characterized |
| F17 | Unauthorized destination | `src/store.mjs#destinationSnapshot` | C3 | gap |
| F18 | Onward widening | none | D4 | open |
| F19 | Result acknowledgment lost | `src/notify-ledger.mjs#NotifyLedger` | B2, B4 | gap |
| F20 | Sibling canceled | `src/protocol-stop-observer.mjs#createProtocolStopObserver` | A1 | characterized |
| F21 | Parent stopped before return | `src/destinations/t3.mjs#canAdmitContinuation` | B2, C4 | gap |
| F22 | Foreground interrupted | `src/t3-control.mjs#runT3Tool` | B2, C4 | gap |
| F23 | Stop denied or unobservable | `src/protocol-stop-observer.mjs#createProtocolStopObserver` | B2, C4, D3 | gap |
| F24 | Receipt retention loss | `src/protocol-retention.mjs#assertProtocolAvailable` | A1, B1, C7 | characterized |
| F25 | Interior feed gap | `src/durable-waiters.mjs#createDurableWaiters` | A1, B4, C7 | characterized |
| F26 | Exclusive wait deadlock | `src/protocol-owner-waiters.mjs#createProtocolOwnerWaiters` | A1, B4 | characterized |
| F27 | Replayable resume repeats effect | `src/answer-journal.mjs#send` | B1, D3 | gap |
| F28 | Tool-level error in completed task | `src/mcp-outcome.mjs#recordMcpResponse` | A1, C5 | characterized |
| F29 | Tasks capability absent | `src/execution.mjs#admitAdapterCapabilities` | C5 | gap |
| F30 | Webhook accepted but no agent | `src/notify-ledger.mjs#NotifyLedger` | B2, D1 | gap |
| F31 | Catalog/credential renewal failure | none | C5, D1 | open |
| F32 | Rollback forgets a remote commit | `src/claim-command-ledger.mjs#createClaimCommands` | B4, C7 | gap |
| F33 | Artifact bytes or source mismatch | `src/artifact-journal.mjs#artifactBytesDigest` | C6 | gap |
| F34 | Native-to-HTTP tool re-export | none | C3, D4 | open |
| F35 | Policy order lacks availability event | `src/pull-queue.mjs#PullQueue` | A1, D1 | characterized |
| F36 | Only one host succeeds | none | D1 | open |

## Requirement index

Requirements below are design acceptance obligations, not a count of implemented features or user validation.

| Requirement | Name |
|---|---|
| R01 | Core host neutrality |
| R02 | Relationship continuity |
| R03 | Separate authority lifetime |
| R04 | Role symmetry |
| R05 | Authenticated identity |
| R06 | Capability intersection |
| R07 | No silent downgrade |
| R08 | Immutable attempt |
| R09 | Creation uncertainty |
| R10 | Durable external question |
| R11 | One answer authority |
| R12 | Exact answer replay |
| R13 | Clarification versus consent |
| R14 | Material input identity |
| R15 | Correction races |
| R16 | Terminal immutability |
| R17 | Selective tool grants |
| R18 | Onward attenuation |
| R19 | Current authority at effect |
| R20 | Typed control |
| R21 | No parent resurrection |
| R22 | Independent returns |
| R23 | Artifact provenance |
| R24 | Retention truth |
| R25 | No deadlocking waits |
| R26 | Native resume truth |
| R27 | Activation separation |
| R28 | Real hosted permission |
| R29 | Incremental migration |
| R30 | Rollback after effects |
| R31 | Native capabilities retained |
| R32 | No mandatory platform |
| R33 | No unauthorized fallback |
| R34 | Versioned route qualification |
| R35 | Independent portability |
| R36 | Operator burden and economics |
| R37 | Policy-order discovery |
| R38 | Safe source scope |
