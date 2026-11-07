# Job Protocol Fixture Profile v0: dot-bridge trace runner

This directory holds a test harness. It runs the 42 golden traces of the proposed *Job Protocol Fixture Profile v0* against the **real** dot-bridge server and a real SQLite store. It changes no product code at runtime. Use the runner output for a current, pinned conformance report; results depend on the exact source revision and configuration.

The complete runner and its gate regression tests run as part of `npm test`. The profile-version test and supplemental native authority cases also run there and through `npm run test:sandbox`.

## Run

```
node scripts/conformance/runner.mjs --out /path/evidence.json     # human table, writes the evidence bundle
node scripts/conformance/runner.mjs --json --out evidence.json    # JSON summary on stdout
node scripts/conformance/runner.mjs --traces T01,T05 --no-variants
```

Flags: `--out FILE`, `--json`, `--traces LIST`, `--no-variants` (skip the fault and race variants), `--no-diagnostic` (skip the lease-scaled run), `--clock-scale N`, `--keep-home` (keep the temp HOME of each trace). A gate run must use the complete manifest corpus and all required variants; filtered runs are diagnostic only and exit unsuccessfully.

A full run takes about 2 minutes. Exit status is 0 only if every trace passes and every required variant passes or holds its safety property. Do not run it at the same time as another full dot-bridge suite: each trace starts its own server on an ephemeral port in a temp HOME under `~/.tmp/cf-*` and removes it afterwards.

## Files

| File | Purpose |
|---|---|
| `extract-fixtures.mjs` | Pulls the 3 JSON Schemas and 42 traces out of the markdown profile into `fixtures/`, checks ids T01..T42, and records the document SHA-256 in `fixtures/MANIFEST.json`. Re-run it when the profile changes: `node scripts/conformance/extract-fixtures.mjs path-to-doc` or set `CONFORMANCE_DOC`. |
| `runner.mjs` | Runs every trace, compares reply and events exactly, checks storage invariants after each step, runs the variants, writes the evidence bundle. |
| `adapter-dot-bridge.mjs` | The dot-bridge adapter (reset, invoke, control, invariants). |
| `clock-preload.mjs` | `node --import` preload for the server under test: frozen test clock and manual scheduler tick. |
| `variants.mjs` | The required fault and race variants that the bridge allows. |
| `classification.json` | Hand-written category (a, b, c) and reason for each failing trace. |
| `fixtures/` | Generated. Do not edit by hand. |
| `native-authority-test.mjs` | Supplemental native authority cases. Their count and IDs are pinned separately from the 42 shared profile traces. |

## Conformance level

The adapter reaches **persistence-restart**: real server process, real SQLite database, `restart` = SIGKILL plus a new process on the same database. Some variants add **concurrent-race** results (parallel real requests). The bridge has no hook to hold a transaction after its snapshot read, so deterministic interleavings are out of reach. Each variant says what it did and did not do.

## Adapter rules

* Every command is a real bridge operation. The adapter never builds a reply from the fixture.
* Principals: `owner` is the admin unix socket with a per-job owner capability. `W1` and `W2` are MCP over HTTP with distinct OAuth subjects (a local fake issuer, as in the e2e scripts). `service` expire is one tick of the server's own scheduler. Other service operations use actual private native dispatcher/observer routes with separate role capabilities; the request body cannot select its principal.
* Clock: `clock-preload.mjs` patches `Date` in the server process and captures the server's 500 ms `drain` interval. The harness writes the clock file and sends SIGUSR2 to run one scheduler pass. `advance` never expires anything. `expire` is a separate scheduler tick. No product file is touched.
* The adapter opts into `DOT_BRIDGE_CATALOG_PROFILE=protocol-v0` and submits an immutable native protocol job. Replies use committed native command receipts, including the original revision and lease deadline on replay. Events come from `protocol_events`, whose sequence, revision, epoch and state are committed with each mutation. Ordinary non-protocol test jobs retain the legacy lifecycle projection; the official traces use native protocol records.
* Native error text maps to the closed code list through `ERROR_MAP` in the adapter (printed in the evidence bundle). An unmapped message becomes `NATIVE:<text>` and cannot match.
* IDs are normalized bijectively only: job to `req_fixture_<job>`, claim to `C<n>`, receipt to `R:<job>:<n>`, artifact to `art_fixture_<name>`. No state, error code, ordering or hash is normalized. Retired unsealed staging rows have no live client alias; snapshots retain each under `native-retired:<global artifact id>` so retained audit rows cannot collapse or overwrite a reused alias.
* Fixture fields without a native parameter are listed per step as `ignoredFixtureFields`. Mutation keys and revisions map to native `command_key` and `expected_revision`; worker epochs are checked against the grant. Claim and renewal durations map to native `lease_ms`. Artifact sealing forwards the requested digest and size. Result snapshots read the persisted selected artifact bindings, rather than treating every sealed upload as part of the result.
* Delivery operations use the actual durable waiter outbox and native service receipts, including restart recovery and acknowledgement of the same delivery. The trusted inert receiver queues actual native envelopes; the test controller injects non-send, delayed original arrival and lookup outcomes at that dependency boundary. Found requires an actual acceptance record in that receiver ledger. The adapter never writes native state or produces expected replies. Production transport dependencies must independently establish their evidence.
* `observe_stop` uses a native enrolled execution and scoped durable observation. The inert controller stops its enrolled synthetic execution, and the native observer validates the resulting evidence and commits the event. This proves protocol semantics, not cessation of ChatGPT or peer compute. Normal production construction cannot validate inert evidence. Renewal uses the native `renew_claim` tool; it cannot regrant or revive an expired claim.
* `service-bootstrap.mjs` composes the real server with the inert dependencies. It retains the unchanged frozen clock preload and binds only loopback. On restart, only the receiver/executor dependency ledger and actual native database survive; process-local caches do not. Shared schemas, all 42 traces, runner and clock are unchanged.

## Two runs

* **Official** (clock scale 1): fixture milliseconds are passed unchanged. The native protocol job persists its requested grant duration and fixed deadline. Only this run supplies the conformance count.
* **Diagnostic, lease-scaled** (clock scale 600): fixture time and requested durations are multiplied by 600. This remains an optional diagnostic, not conformance evidence. Use `--no-diagnostic` for the official 42-trace batch gate; required fault and race variants still run.

Each failing step also has `semanticMatch`. It is true when the step differs from the golden only by revision/seq/id numbering, lease times and events the bridge never journals (uploaded, sealed, waiter_registered, renewed, answered, consumed, stop_observed). It is a diagnostic aid to separate "concept absent" from real semantic differences. It never counts as a pass.

## Evidence bundle

`--out` writes: product name and commit, adapter commit, fixture and schema SHA-256, storage engine and version, level, clock and ID normalizations, error map, then per trace and per step: input, expected, actual, native calls, ignored fixture fields, invariant checks, status; the diagnostic run; the variants; the exit status.
