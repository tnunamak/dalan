# Relationships and grants

A relationship records the worker and its declared continuity. New jobs for that worker carry its relationship ID. `dalan relationships list` includes ended relationships; `dalan relationships end ID` prevents new direct or routed submissions, including submissions that omit the ID. A routed submission checks every candidate and records each relationship at admission; an already accepted order can still be acquired after a relationship ends. Existing jobs, questions, results and grants remain available under their own rules. Exact retries retain their original receipt.

Worker repository enrollment and connection approval create a relationship without another approval. When a worker is configured while the service is offline before its database exists, the next service start creates the row. Existing ended relationships are never reopened by worker enrollment, connection approval or restart. Legacy single-worker profiles without a relationship remain usable.

`dalan grants --json` shows the relationships and the current grants from each enforcer. Each grant has an `enforcer` and an `expires_at` field; null means the enforcer has no recorded deadline, except an external connection explicitly marked `expiry_status: unknown`. Job owner capabilities for protocol jobs expire at their retention deadline. Ending a relationship does not revoke any grant.

Schema 70 is reserved for this migration. Migrations are serialized on merge: if an earlier branch uses this number, renumber the guard and its `PRAGMA user_version` together, along with the supported schema version and schema fixtures.
