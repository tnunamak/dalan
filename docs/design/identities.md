# Identity boundaries

Pinned source: cb6b119196f025ac8cbbf93f0ee8bd0a30221654. These are distinct identities, not interchangeable credentials. NEW and Candidate entries are design targets, not implemented claims.

| Identity | Lives at | Status | Must never become |
|---|---|---|---|
| Authenticated principal | OAuth subject `src/auth.mjs#subject`; per-job owner hash `src/store.mjs#owner_hash`; operator key `src/server.mjs#operatorKey` | Exists | A job, session, or delegated role |
| Enrolled connection | workers.json connections; fence and digest `src/workers.mjs#connectionsDigest` | Exists | The principal or permanent relationship |
| Relationship | Proposed relationships.relationship_id | NEW (C2) | A worker connection, job, or authority grant |
| Logical shared context | Candidate meta.objective_key if C1 step 0 confirms its semantics; otherwise proposed relationships.context_ref | Candidate | A native session or permission |
| Work or request | assignments.request_id `src/store.mjs#request_id` | Exists | A question or parent session |
| Native session | T3 delivery in `src/destinations/t3.mjs#createT3Destination`; ACP session in `bin/dot-acp-agent.mjs#sessionFile` | Exists, connector-only | A core identity or grant |
| Claim and lease epoch | claims.claim_id and protocol_events.epoch `src/store.mjs#protocol_events` | Exists | Stable work identity or connection identity |
| Question | job_questions(request_id, question_id) `src/store.mjs#job_questions` | Exists | A task node or consent grant |
| Material input revision | Candidate meta.revision plus assignments.payload_hash | Candidate (C1) | Protocol mutation revision |
| Protocol mutation revision | protocol_events.revision; expected_revision `src/protocol-owner-command.mjs#executeProtocolOwnerCommand` | Exists | Material input identity |
| Operation key | Worker receipts `src/claim-command-ledger.mjs#createClaimCommands`; owner_submit_commands and tool_idempotency `src/store.mjs#owner_submit_commands`, `src/store.mjs#tool_idempotency`; answer:<question_id> journal key `src/answer-journal.mjs#prepare` (R5) | Exists | A grant, arbitrary retry, or changed intent |
| Artifact | artifacts.id, sha256 and sealing `src/store.mjs#sha256`; byte journal `src/artifact-journal.mjs#createArtifactJournal` | Exists | A delivery acknowledgment or unverified source claim |
| Delivery attempt | notifications.id and attempt_id `src/store.mjs#attempt_id`; `src/ack-ledger.mjs#AckLedger` | Exists | A new operation or completed work |
| Parent lifecycle generation | Opaque parent_generation column `src/store.mjs#parent_generation`; destination capture/read `src/destinations/t3.mjs#readGeneration` | Exists at this pin (NEW in original R6 plan) | Core session state or authority to resurrect a parent |

The objective metadata exists in `src/objectives.mjs#metaFields`. That fact alone does not confirm it as shared context or material input identity. C1 step 0 must decide those semantics before promotion.
