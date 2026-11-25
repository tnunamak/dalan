# Authority and lifetime

A participant is an identity. Requesting, performing, lending, and borrowing are independent grants, not identity classes. An accepted job does not grant a tool or destination permission. This is a source map, not proof of live hosted authorization.

| Role | Grant that carries it today | Gap | Enforcer revokes by |
|---|---|---|---|
| Request | Per-job owner capability `src/store.mjs#owner`; admin socket/operator key `src/server.mjs#operatorKey`; destination approval and submission policy `src/store.mjs#destinationAdmissionInTransaction` | Requesters need the local host administrative surface. D4 adds a requester catalog profile for hosts unable to run Dalan. | Owner-hash check, administrative access control, current destination admission, and retention fence; no inference from role name |
| Perform | Enrolled worker connection `src/workers.mjs#connectionsDigest`; claim epoch and lease `src/store.mjs#lease_deadline_at` | Hosted path exists. Runtime and peer adapters remain D3/D5. | Reject a stale connection, epoch, cancelled job, or expired lease at the enforcing operation |
| Lend tools | Registration and per-worker grants `src/tool-registry.mjs#grantChange`; `src/store.mjs#registered_tools`, `src/store.mjs#tool_grants` | T3 grants are broad and job-independent; C3 adds scope. | Owner revocation `src/tool-registry.mjs#revoke`; disabled registration or absent grant denies access |
| Borrow tools | list_tools, call_tool_read, call_tool_write `src/server.mjs#list_tools` | No additional role surface required. | Registry checks the current grant; possession of a tool name does not authorize a call |

| Lifetime | Where it lives | Revoked by | Enforcer revokes by |
|---|---|---|---|
| Relationship | NEW per-side relationships row with shared relationship_id (C2). Today implicit in worker profile and destination thread. | Ending the relationship; jobs, questions and results remain. | Planned relationship admission fence, not erasure or automatic cancellation of retained work |
| Work | assignments, claims, job_questions, protocol_events `src/store.mjs#job_questions`, `src/store.mjs#protocol_events` | Terminal state, cancel, retention tombstone | Job transition/epoch checks and `src/protocol-retention.mjs#assertProtocolAvailable` |
| Authority | Separate owner capability, lease, connection fence, tool grants, destination approvals and retention. C2 proposes a read-only dalan grants composition, not a new grant store. | Each grant's enforcer | Lease deadline, connection digest, registry revocation, owner-hash validation, destination admission and retention fences remain local to their enforcers |

Relationship continuity must not extend authority lifetime. Revocation after an await requires current authority at the effect, not merely at request admission. Ending foreground activity is not evidence that a native operation stopped.
