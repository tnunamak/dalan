# Dalan operator duties

This is a checklist of operator responsibilities, not another operating manual. Follow [operations](operations.md) for procedures and [the Dalan upgrade guide](dalan-upgrade.md) for command, setting and path compatibility. Use the service's HOME and environment when checking an installation.

Each duty names a command or registered test, its source, and the limits of that evidence. A test name is an entry point, not a claim that it passed on this host. Run `node scripts/operator-duties-test.mjs` for this document's structural check: it reads repository files only, validates cited files, links, CLI forms and suite registrations, and executes none of the cited commands. It does not prove operational readiness or the semantic completeness of a regression test.

## Backup and restore

- **Duty:** Keep a consistent, stopped-service recovery set, including the required keys, receipts, artifact ownership/bytes and positive delivery-ACK evidence. Exclude the local ownership lock files and preserve private permissions; follow the linked inventory rather than copying an entire state directory blindly.
- **Check:** `dalan paths --json` identifies the effective roots for the inventory; `node scripts/worker-isolation-test.mjs` is the backup and rollback regression test.
- **Gap:** Root discovery and a local fixture are not a scheduled backup, an age check or a second-host restore drill. A database-only snapshot is incomplete; an older ACK snapshot can lose proof of accepted notices and permit duplicates.
- **Source:** [Backup and operational rollback](operations.md#backup-and-operational-rollback), [upgrade and rollback](operations.md#upgrade-and-rollback).

## Key and token rotation

- **Duty:** Follow the built-in authorization server's stopped-service ownership procedure for `dalan as-rotate-keys`. Keep signing, cookie and storage keys private, and plan separately for replacement of other exposed credentials.
- **Check:** `node scripts/builtin-as-owner-test.mjs` covers ownership and key rotation.
- **Gap:** The AS rotation command is not a rotation of every deployment credential. A fixture does not establish the operator's rotation schedule or verify recovery from a real credential exposure.
- **Source:** [Authorization-server ownership](operations.md#built-in-authorization-server-ownership), [CLI implementation](../bin/dot-worker.mjs).

## Upgrades and migrations

- **Duty:** Read release/operator notes, take a compatible stopped-service backup, and keep a reviewed rollback path. Never lower the database schema version by hand. Use Dalan names while respecting existing legacy roots and setting fallbacks; path migration is explicit, not an automatic rename.
- **Check:** After the planned upgrade, inspect `dalan paths --json`, `dalan status --json` and `dalan doctor --json`; `node scripts/migration-atomicity-test.mjs` covers migrations.
- **Gap:** Doctor reports local executor declarations and repository policy, not a successful live worker job. Fixtures do not establish that every historical schema or the actual deployment was upgraded correctly; perform the authenticated smoke job in the upgrade guide.
- **Source:** [Versions and upgrades](operations.md#versions-and-upgrades), [Dalan upgrade guide](dalan-upgrade.md), [schema guard and migrations](../src/store.mjs), [doctor implementation](../bin/dot-worker.mjs).

## Retention and deletion

- **Duty:** Track retention separately for protocol jobs, lifecycle history, logs, artifacts and other deployment state. Protocol job retention has an explicit cutoff and durable logical tombstone/fence; purge is deferred until native state is terminal and compute is confirmed stopped. Do not describe it as secure byte erasure.
- **Check:** `node scripts/job-retention-test.mjs` and `node scripts/protocol-retention-test.mjs` cover retention.
- **Gap:** The helper retains audit evidence and can leave purge pending. Its existence is not a universal retention window, requester-wide deletion operation, or proof that every backup and external copy has been erased.
- **Source:** [Retention helper](../src/job-retention.mjs), [protocol retention admission](../src/store.mjs), [lifecycle retention](operations.md#lifecycle-events-and-metrics), [artifact/worktree retention](operations.md#github-workspaces).

## Incident response

- **Duty:** Use the documented pause, claim and delivery-reconciliation procedures when intervention is needed. Pause prevents new claims and outbound notices; cancellation or abandonment must not be mistaken for proof that remote computation stopped. Preserve unknown-delivery evidence instead of assuming a retry is safe.
- **Check:** `dalan status --json` shows pause/delivery state; `dalan claims --json` shows active grants and delivery gates. `node scripts/claims-admin-e2e.mjs` covers claim administration.
- **Gap:** A bridge authority change is not remote process-stop evidence, and a stored alert is not proof that a person received it. Rehearse the deployment's response and escalation procedure separately.
- **Source:** [Recovery and operation](operations.md#recovery-and-operation), [claims and leases](operations.md#claims-and-leases).

## Capacity

- **Duty:** Review the effective claim cap and its recorded worker/subject lanes, and keep artifact/workspace storage within the host's capacity. Do not confuse the utilization denominator with the claim cap, or usage estimates with enforced limits.
- **Check:** `dalan status --json` exposes the active cap and usage state; `dalan doctor --json` reports local executor readiness and declared capabilities.
- **Gap:** These observations do not prove sustained-load capacity, disk headroom or a successful host check. Disabled/unsupported execution is not a passing check.
- **Source:** [Workspaces and claim capacity](operations.md#github-workspaces), [usage estimates](operations.md#usage-breaks-and-usage-estimates), [executor evidence](operations.md#execution-capability-and-check-evidence), [CLI implementation](../bin/dot-worker.mjs).

## Abuse handling

- **Duty:** Admit repository work only for exact worker repository grants. A missing profile, omitted list or empty list denies repository jobs; legacy identity recovery does not grant access. Tightening policy blocks new admission/claims but does not forcibly cancel already-valid grants.
- **Check:** `dalan worker list NAME --json` and `dalan doctor --json` expose effective repository policy. `node --test scripts/dalan-legacy-repos-test.mjs` covers the deny-by-default rule.
- **Gap:** A worker allow-list does not narrow the host GitHub credential. Verify that credential's least-privilege scope separately; policy inspection is not an external abuse-reporting channel.
- **Source:** [Repository access per worker](operations.md#repository-access-per-worker), [repository-policy upgrade](dalan-upgrade.md#repository-policy-requires-an-explicit-list).

## Status and availability

- **Duty:** Inspect queue, subscription, lease and delivery state and respond to stalled work. Distinguish webhook transport acceptance, worker activity, terminal worker reports and owner acceptance.
- **Check:** `dalan status --json` and `dalan status --explain` provide the live bridge observations and their explanation.
- **Gap:** An event 2xx proves transport only, not worker wakeup or owner acceptance. Local status cannot establish off-host availability or that an alert reached a human; doctor is not a bridge liveness probe.
- **Source:** [Use and status](operations.md#use), [recovery and delivery evidence](operations.md#recovery-and-operation), [CLI implementation](../bin/dot-worker.mjs).

## Identity and access

- **Duty:** Review approved worker connections and exact repository grants on an operator-defined schedule. Preserve verified identity bindings during upgrades, protect owner/operator capabilities, and keep service credentials separate from worker repository policy.
- **Check:** `dalan worker list NAME --json` checks current repository grants; `node scripts/auth-e2e.mjs` and `node scripts/builtin-as-e2e.mjs` cover authentication.
- **Gap:** Repository listing is not an audit of OAuth connection approval or token revocation. Regression fixtures do not perform the scheduled access review or verify the live service credential's scope.
- **Source:** [Worker identity](operations.md#worker-identity-and-rollback), [owner/operator capabilities](operations.md#use), [service GitHub access](operations.md#service-github-access).
