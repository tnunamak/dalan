# Remaining native MUST coverage

The shared profile remains at 42 source-pinned traces. Three supplemental native authority cases are registered separately so they do not rewrite the shared profile or imply that its source changed.

The new cases cover a revoked holder's no-effect refusal, approval after a destination declaration changes, and refusal to replay a grant through a replacement connection. Other repository tests already cover additional connection and destination behavior, including workspace fencing, connection replacement, destination drift, and refusal persistence. The following requirements still lack a dedicated conformance case in this harness, in the review's risk order:

1. **Authority and admission:** every claim-affecting verb and replay path; reads and cursor movement from non-holder connections; null connection IDs; retry ordering; destination configuration read failures, live connection-set digest changes, restoration, listing behavior, and races around transaction fences.
2. **Lease, replay and terminal state:** before/equal/after deadline boundaries for each mutation; changed retry intent; grant and authentication precedence; post-expiry finish; abandon/resume; stop evidence; cancellation races; no-answer, unconsumed-answer, terminal-consume, and failed-finish cases.
3. **Durable services and delivery:** all private service roles and replay tuples; public and worker denial; crashes across state, outbox, transport, acknowledgment and callback; mismatched delivery evidence; delayed arrival; question delivery during regrant; stop-evidence validation and owner projection.
4. **Artifacts and retention:** chunk offset, encoding, size, digest and retry boundaries; successor reseal provenance; post-tombstone operations; report archive size, schema, redaction, atomicity and selection rules; legacy retention controls.
5. **Versions, schemas and compatibility:** exhaustive missing, extra, type and bounds cases; stable and optional catalog versions; every native error branch; MCP negotiation versions. The current version test covers pinned profile identity, hashes, schema validation, v0 acceptance and unsupported-version refusal.
6. **Operational compatibility:** migration and supersession combinations; queue and deadline policy; webhook signature, retry, wake and key rotation; workspace scope and host budgets; note, brief, patch, chunk and sensitive-path boundaries.
7. **OAuth negative boundaries:** issuer, audience, expiry, signature and scope refusals; unauthenticated HTTP 401 and `WWW-Authenticate`; insufficient-scope metadata. The conformance adapter uses valid tokens, so these remain outside this harness.

This list describes missing harness evidence, not a claim that every listed product behavior lacks another repository test. The original profile source is not included in the checkout, so its bytes cannot be re-extracted here; the runner verifies the implementation's fixed digest against the manifest.
