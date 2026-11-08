# Dalan operations

The admin socket is mode `0600`, but every process that runs as the bridge's own user can connect to it, so run executors and worker processes as a different user. The current check sandbox does not enforce this separation: it confines the check process but does not change its Unix user.

Fresh homes use Dalan directories; existing installations retain their populated legacy roots. Use `dalan paths --json` with the service HOME and environment for the effective config, data, state and workspace roots. See [the upgrade guide](dalan-upgrade.md) for settings, catalog retention, local HTTP and explicit path migration.

## Versions and upgrades

**Versions (0.5.2).** Package releases and SQLite schema numbers are
separate: this package is 0.5.2 and `Store` supports schema 65. The recorded
0.2.0/0.3.0 release history is manual version bumps, changelog sections and tags;
it does not establish a general compatibility promise. The 0.3.0 changelog puts
operator actions first.

**Proposed 0.x policy (not a historical guarantee).** Use a patch bump
(`0.Y.Z -> 0.Y.(Z+1)`) for compatible fixes/documentation with no required
operator or consumer migration. Use a minor bump (`0.Y.Z -> 0.(Y+1).0`) for
features, required upgrade actions or breaking changes; 0.x minors may break
compatibility. Pin an exact release and read its operator notes before upgrading.
Treat these as breaking changes requiring a minor and explicit migration notes:
- A database schema/storage change that prevents older code from using the state
  (including an additive schema bump fenced against older binaries).
- Incompatible MCP tool names, inputs, outputs or advertised catalog semantics.
- Removed/renamed CLI flags or incompatible defaults, arguments or output.
- Incompatible config names, formats, defaults or required settings.
- Worker-contract changes to authority, leases, epochs, retries, result meaning
  or errors; follow the separately versioned native contract in [PROTOCOL](../PROTOCOL.md).
Even additive catalog changes need deliberate catalog review and coordinated
connector Refresh + worker reboot when the advertised profile changes; see
`scripts/catalog-golden-test.mjs` and the profile-specific protocol guidance.

**Current schema behavior.** Startup refuses `user_version > 65` before schema bootstrap, making no schema or row change; SQLite may create, recover or clean up the `-wal` and `-shm` files. `Store.migrate()` advances supported historical layouts to schema 65; version 65 needs no version upgrade. Versions 35 and later must carry `s1v2-worker-facts-20261022` in `schema_migrations`; abandoned worker-isolation layouts are refused. Valid layout, keys and private permissions are also required: a version number alone is not compatibility proof. Migrations never run down; never edit `user_version` to force an old build to open newer state.

**Release checklist (followed for 0.3.0).** Update `package.json` and the lockfile to the
same version; add a CHANGELOG section with operator actions first (backup,
schema/config/CLI migration and catalog refresh requirements). Review and test
the release, merge it, create an annotated `vX.Y.Z` tag on that merge commit,
then publish GitHub release notes with those actions and compatibility limits.

**Rollback.** Stop the service and restore a full, compatible pre-upgrade backup
with the older code, not just an older executable against the migrated database.
Follow [Upgrade and rollback](#upgrade-and-rollback) for the complete state set,
lock-file exclusions and compatible newer delivery-ACK preservation. Snapshot
restore loses later work; losing newer ACK proof can duplicate accepted notices.

## Opt-in legacy-v46 catalog

For one separately configured instance, set:

```ini
Environment=DALAN_CATALOG_PROFILE=legacy-v46
```

Omit this setting, or use explicit `stable`, to keep the main stable catalog
unchanged. This opt-in advertises the captured twelve-tool legacy catalog,
including its original claim description and no `lease_ms` argument. Internal
claim leases and authority checks still apply. Question, T3 and notification
tools are unavailable in this profile even for a capable worker.
This is a catalog compatibility option, not evidence of live deployment or a
completed migration. Existing `questions-v1` and `protocol-v0` behavior is unchanged.

Paths: `<home>` is your home directory and `<config>` is `<home>/.config`.

This page holds the operating detail for the bridge: service configuration, delivery and recovery, claims and leases, lifecycle metrics, usage breaks, workspaces and checks. It was moved out of the README, which now gives a short overview. Start with the [README](../README.md) if you have not seen the bridge before.

A Node 24 service stores immutable assignments, exposes worker MCP tools and MCP Events, and sends report or stored legacy watch notices to the exact bound T3 thread. The assignment path does not launch models, decide fallback, merge patches, or stop remote worker compute. The public endpoint is `https://dalan.example.com/<secret>/mcp`; OAuth authenticates worker requests, and `<config>/dalan/env` holds the additional path secret. The service listens on port 8787 by default.

The [reverse T3 wrapper](t3-reverse-control.md) adds OAuth-scoped thread list/read tools, a short `notify_owner` alert, append-only audit, and `dalan tell` for lightweight messages to worker. Use `dalan note REQUEST_ID "text"` for anything about a specific assignment; notes are append-only and returned by `get` and `claim`. `tell` emits the existing `assignment.available` event; `dalan untell MESSAGE_ID` withdraws a pending message.

**Fail-closed auth.** Production supports two authenticated modes: `DALAN_AUTH_MODE=builtin` uses the built-in authorization server and is what generated setup units select; `DALAN_AUTH_MODE=oauth` uses an external issuer and requires a valid mode-0600 `<config>/dalan/oauth.env`. A non-loopback HTTP listener also requires `DALAN_TRUST_PROXY=1` and an HTTPS reverse proxy. Neither is an insecure bypass. `DALAN_DEV_ALLOW_UNAUTHENTICATED=1` is for isolated non-production fixtures only; the legacy `DALAN_ALLOW_INSECURE_PUBLIC=1` alias is also refused in production. Neither permits authentication-off loopback mode. `DALAN_TEST_OAUTH=1` permits the test loopback HTTP URL and is ignored in production. Existing external-issuer installations may have service drop-ins with additional settings; preserve the settings required by that installation when upgrading.

## Authorization codes

The built-in authorization server gives authorization codes a nominal 600-second lifetime so a vendor login interstitial can finish before redemption. RFC 6749 section 4.1.2 requires short expiry, single use and binding to the client and redirect URI, and recommends at most 10 minutes. The 10-minute setting is a compatibility choice, not evidence that every vendor needs the full interval. Codes still require S256 PKCE and remain bound to the registered client, exact redirect URI and requested resource. Authorization-code redemption rejects at the stored expiry, measured in whole seconds. The adapter retains code records for an additional 15 seconds; this does not extend the redemption window. The bridge can show a generic invalid-or-expired message on its own interaction page; it cannot replace an error page rendered by the vendor.

## Refresh retries

The built-in authorization server rotates refresh tokens. For five seconds after a successful refresh, an identical retry of the previous token returns the same response, provided the connection and successor remain active. The deadline does not extend on retry. Reuse after the deadline or reuse of an older ancestor revokes the token family. The server stores the retry response encrypted. A bearer-token thief who obtains the previous token within the grace period can use the same retry; the server cannot distinguish that request from an honest retry.

## Built-in authorization server ownership

The built-in AS requires local state in a mode 0700 directory. Its process keeps a mode 0600 `as-owner.sqlite` database open in an exclusive transaction. Acquisition uses `PRAGMA busy_timeout=500; BEGIN EXCLUSIVE`, so a contending start or rotation reports ownership unavailable and exits. Stop the bridge, rotate the keys, then start the bridge. Rotation cannot run beside a live signer.

Only `acquireAsOwner` may open the ownership database. Never back up, sync, copy, read, unlink, rename or replace `as-owner.sqlite`; exclude it from directory-wide backup and sync jobs. A replacement can put contenders on different inodes. Inside the owning process, opening and closing another descriptor for this file releases its POSIX locks. The ownership file contains no application data and must be recreated locally after a restore, with the bridge stopped. Back up the key files and application databases separately while stopped.

A launcher that closes inherited descriptors must do so only in the child, after the fork and before exec. Never close descriptor ranges inside the bridge process: that can close the ownership database and release its lock while the signer is still alive. The owner test checks that closing descriptors in a child leaves the parent's ownership held.

On Linux, the AS refuses state directories whose `statfs` type is NFS (0x6969), SMB (0x517b), CIFS (0xff534d42), SMB2 (0xfe534d42) or FUSE (0x65735546), using the constants in Linux's `linux/magic.h`. This guard does not detect every remote or synchronized storage arrangement. On macOS, keep the state on local APFS; `<home>/.config` is local APFS by default. There is no macOS filesystem detector in this implementation. NFS with local-only locking, WebDAV, network shares and synchronized folders can let another host acquire a separate lock and are unsupported on either OS.

### Legacy unstamped keys

An old null retirement stamp has no proven last-issuance bound, so it counts toward the 8-key cap indefinitely. A cap refusal lists the affected signing kids or cookie-key positions (never cookie secrets). Do not delete these keys to make room. The small recovery below starts a fresh retention window for every null stamp, keeping every key and leaving existing numeric stamps unchanged.

1. Stop the bridge and keep it stopped during recovery. Back up `as-jwks.json` and `as-cookie-keys.json`, excluding the ownership file.
2. From the bridge checkout, as the service user (same HOME), run the following local command. It picks the same config root as the server, so a retained legacy root stays in use. It acquires the same ownership lock before it reads or writes keys; contention leaves the files unchanged.
3. Wait at least 3675 seconds after recovery (the longest configured cookie lifetime plus skew), then run `dalan as-rotate-keys` while stopped and start the bridge. The bridge may run during the waiting period; stop it again before rotation.

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import { acquireAsOwner, asFiles, loadKeys, writeAtomic } from './src/as-files.mjs';
import { defaultPath } from './src/paths.mjs';
const dir = defaultPath(os.homedir(), '.config/dot-bridge');
const owner = acquireAsOwner(dir);
try {
  loadKeys(dir);
  const files = asFiles(dir), at = Date.now();
  const jwks = JSON.parse(fs.readFileSync(files.jwks));
  const cookies = JSON.parse(fs.readFileSync(files.cookies));
  for (const kid of Object.keys(jwks.retired)) jwks.retired[kid] ??= at;
  cookies.keys.forEach((entry, index) => { if (index) entry.retired_at ??= at; });
  writeAtomic(files.jwks, JSON.stringify(jwks, null, 2) + '\n');
  writeAtomic(files.cookies, JSON.stringify(cookies, null, 2) + '\n');
  loadKeys(dir);
} finally { owner.release(); }
JS
```

## Use

The [first-job walkthrough](../README.md#quickstart) starts with `inputs: []`, `execution_scope: "read-only"`, and explicit `--worker NAME --execution none --deliver none`. It works without a repository grant or host checks. Follow it with receipt-based recovery before a separate repository assignment: `dalan worker allow NAME OWNER/REPO`, then `dalan worker list NAME --json` to verify exact authority. Basic macOS delegation stays on `none`; Linux host checks are an optional, separately admitted branch with the prerequisites below.

Generated setup cleanup is not an exposure-only toggle: `worker-bridge-setup.mjs --worker NAME --home HOME_PATH --remove` (the worker and home used at install; the recorded exposure is looked up in that home) stops/removes its generated services and recorded exposure. It retains the private home unless `--purge-home` is explicitly requested. For ngrok, the separately installed ngrok service still needs the printed stop/uninstall commands; do not infer that those commands ran.

See the [requester reference](usage.md) for the assignment sequence and [T3 and orchestration integration](t3-integration.md) for the owner thread. The local requester CLI uses a mode 0600 Unix socket at `<home>/.local/share/dalan/admin.sock`. It writes a mode 0600 receipt with a per-request owner capability before submit; the server stores only its hash. Retry the same `request_id`, payload and destination after a lost response. `get` and `cancel` require that receipt. Pause, resume, reconcile and adoption require the separate mode 0600 operator key at `<config>/dalan/operator.key`. Same-UID processes can still read these files; they are not distinct human identities.

`dalan submit` defaults to quiet `--deliver none`, retrieved through `wait` or `get`. Explicit T3 delivery verifies `t3code --json threads inspect --thread ID` and binds `runtime.environmentId`. Protected IDs in the mode 0600 `<config>/dalan/limits.json` `main_thread_ids` list require operator-authenticated `--allow-main` for submission. That flag admits a bound assignment; it does not enable notices to a protected destination. The bridge rereads protection before delivery, so adding an ID also quiets in-flight finish and blocker notices without a restart. Results and questions remain available through `wait` and `get`. Stored legacy watch and mute facts remain readable and enforced; no current command or admin route creates them. The assignment JSON cannot change after submission; a new revision or objective needs a new ID. Legacy requests have no owner capability and remain operator-read-only until explicitly adopted.

`dalan status --json` shows queue counts, pause reason, subscription state and expiry, last verification, last event 2xx, last claim, queue age and uncertain T3 deliveries. Liveness fields (additive): `claimed_outer_count` (all subjects' active claims), `max_claimed_outer_assignments` (the cap per recorded lane: subject in the legacy profile, worker in profile mode), `oldest_claim_age_ms`, `oldest_claim_progress_age_ms`, `last_worker_call_at` (the newest tool call recorded for the worker), `last_list_pending_at`, `oldest_unclaimed_event_2xx_age_ms`, `queue_classes` and `stale_claims`. Queued work is classified, never called simply "paused" or "missed": `pause_suspected` (no worker call and silence of at least 20 min), `at_capacity_healthy` (every active worker subscriber has no free capacity after counting its worker lanes and its principal's subject lanes from recorded claims, and the newest activity on at least one claim is younger than that claim's stored lease duration; the default is 60 min), `alive_not_claiming` (the default worker calls tools, slots are free, the item stays queued beyond twice the interval), `transport_failing` (no event ever got a 2xx), and `stale_claims` (claims past their persisted lease deadline, the same deadline the sweep uses, checked even with an empty queue; inspect `lease_expires_at`). The bridge's automatic claim abandonment requires lease expiry (actor `system`, reason `lease_expired`, checked by the independent maintenance timer, same path as `dalan abandon`): the item is requeued and its lane is free. A usage break does not hold the sweep and does not move `lease_expires_at`: a claim with no claimant activity for one lease period is released during a break too. After a bridge start, a claim whose last activity came before the start is not swept before the start plus that claim's own lease (`lease_ms`, one hour by default), the full lease a restart would have given it, so a deadline that ran out while the bridge was down or draining does not requeue work the worker may still be running; a claim the worker touched since the start has no grace. After that window, the first maintenance tick sweeps it. Native protocol fixed-deadline leases renew only through explicit `renew_claim`. Claim-bearing calls still require an unexpired grant under the applicable lease model; acquire a new epoch when permitted. Preparation expiry and default-worker-only skip expiry still run during a break and while delivery is paused (see **Preparation expiry** and **Skip expiry** under [Usage breaks and usage estimates](#usage-breaks-and-usage-estimates)). Merged or closed PRs are cancelled by the PR-head reviewer (`cancelled_reason` `pr_closed`); see docs/pr-head-reviewer.md. An expired lease also lets another claimant take the claim over; see [Claims and leases](#claims-and-leases). An event 2xx proves webhook transport only, while a claim is stronger evidence of worker wakeup. The bridge never treats worker `completed` as owner acceptance.

## Recovery and operation

`status --json` includes recent terminal unknown deliveries under `uncertain_terminal_deliveries`. Each record names its notification and request IDs, aging time and reason. `get ID --json` also shows the original attempt time and terminal fields, so operators can distinguish aging from confirmed delivery. An aged delivery still blocks a new claim until delivery is reconciled.

The service persists an attempt ID and `sending` before outbound calls. A separate mode 0600 SQLite ledger at `<home>/.local/share/dalan/delivery-acks.db`, independent of `bridge.db` and using `synchronous=FULL`, records only a positive transport acknowledgment: webhook 2xx or successful T3 CLI completion. It stores event IDs, body digests, destination/worker/environment binding digests and acknowledgment times, not URLs, keys, tokens or bodies. Webhook binding uses `DALAN_ENVIRONMENT_ID` when set, else the host name. The ledger is committed before the main outbox becomes `delivered`. A recovered row is suppressed only when all three key parts match and current delivery guards still pass. Missing evidence is unknown; unreadable, corrupt or unwritable evidence fails closed. Keep this file with backups. Restoring only `bridge.db` avoids resending a restored notice only if newer positive ACK proof survives and exactly matches its event ID, body digest and binding digest. Restoring both files to an older snapshot, or losing the ACK after the receiver accepted it, is not exactly-once and can cause an at-least-once duplicate: the receiver and bridge do not share an atomic transaction.

Local proof recovery starts at service startup and runs at most once per minute, single-flight so recovery runs do not overlap. Each tick handles up to 25 due uncertain notices in fair order. It checks the independent positive-ACK ledger against the stored T3 thread/environment binding or the current webhook subscription. The installed T3 CLI's bounded `threads search --query ... --limit 1` returns a snippet and a `source` field (`user` or `assistant`), but no full message or truncation/exact-match flag. Its `inspect` and `read` commands fetch the full thread projection before applying any local truncation. The bridge therefore does not run transcript scans on the timer. `dalan reconcile ID --json` remains the explicit, operator-triggered full transcript lookup. It confirms only an exact thread and environment match with an untruncated user message containing the event marker; missing or incomplete evidence remains unknown.

**Aged unknown delivery.** The age calculation assumes a trusted OS wall clock across restarts. At the single `UNCERTAIN_DELIVERY_MAX_AGE_MS` threshold (30 minutes) from the original attempt start (or `created_at` for migrated rows without that timestamp), an unresolved T3 owner notice becomes eligible for `uncertain_terminal`. Maintenance checks preserved positive ACK evidence before applying the age policy. This terminal state never retries the notice and records "delivery unknown, not proven undelivered", the request and notice IDs, the last attempt and the release reason. It ends automatic retry attempts without releasing the claim-epoch fence. A matching positive ACK or explicit transcript reconciliation can resolve an aged notice; until then it can still hold a new grant. It does not cancel or finish the job, change a lease, free capacity, or bypass worker and epoch fences. The transition is automatic; age alone never proves that a late message cannot arrive. Its informational alert uses the existing alert publisher; failed publication remains pending and retries on a later alert tick. One durable logical informational-alert episode is keyed by the notice ID, which is also included in the alert text. Alert transport is at least once: acceptance followed by a lost reply or local success-record failure can produce physical duplicates with the same ID. Retries stop after success is recorded, including across restart. Without an external publisher, the episode is logged once and remains pending for a publisher configured later. A late accepted notice remains possible. It must not create a second claim or completion, or regress assignment state; the bridge's worker, epoch and completion-idempotency fences still apply.

Event retries reuse one event ID, and a stored legacy watch is a one-shot attention notice and never launches fallback. Pause prevents new claims and outbound notices; resume drains eligible work. Cancel withdraws bridge authority, but `compute_stopped` remains false. Cancel is refused with `uncertain_delivery: reconcile first` while an owner delivery for the job is `uncertain`, `sending`, `uncertain_terminal` or `waiting`; run `dalan reconcile ID --json` first. A paused bridge is not a frozen database: do not copy `bridge.db` while the service runs, even when paused. Stop the service, then take the copy with SQLite's `.backup` command, as the [backup procedure](#upgrade-and-rollback) describes. Do not copy the database file by hand. With a still-valid claim, a new finish after cancellation retains bounded audit-only `late_evidence` and returns `assignment_cancelled`; it creates no report or successful late receipt and does not wake the owner. A `late:true` success can only repeat a matching already-stored legacy report.

**Delivery guarantee.** The current T3 `sendArgs` always uses `--if-busy steer` for CLI-delivered notices. Results sent through the result transport instead use orchestration `message.dispatch`: by default, `steer_active` targets the latest active run; if no active run exists, `queue_after_active` is selected when a queued run exists, and `start_immediately` otherwise. See [result retry and delivery](t3-result-retry-delivery.md) for the separate transport and lifecycle contract. "Never dropped" means every result, blocker and watch message is stored durably and its state stays visible in `dalan get` and `status`. It does not mean exactly-once. A send that fails with `invalid session credential` is a known pre-accept rejection from T3: the message stays `pending` and is retried with backoff under the same event ID, up to 8 attempts (`DALAN_T3_AUTH_RETRY_MAX` overrides this for tests), then becomes `uncertain` with a reason. Any other failure after a send starts stays `uncertain` without automatic resend. The transcript-marker lookup is available only through explicit manual reconciliation. Aging an unknown notice to `uncertain_terminal` stops automatic retry; it does not release the claim fence or prove delivery. A late accepted message remains possible.

**Claim refused with `claim_effects_unverified`.** The bridge will not give a job to a new worker until it has proof that the host checks of the earlier claim have stopped. The error `claim_effects_unverified: prior host work has not verifiably stopped` means that proof is missing. The usual causes: the stop recorder saw a process still alive in the check's control group (for example a task stuck in uninterruptible I/O), or the bridge or host stopped before the recorder wrote its result. The first verdict is kept as written and is not changed later.

The bridge looks again by itself, before each new claim and on restart. You can also ask now: `dalan verify-stops [ID]` (the bridge must be running). It accepts the stop only on fresh proof:

1. The host has rebooted since the check started (the boot id in the start receipt differs from the current one). A reboot ends every process.
2. Or, on the same boot, the check unit (`dot-bridge-host-check.service`) is no longer active, and a new scan of the recorded control group finds the directory gone or empty in its whole tree.

A process that is still alive, a read error, an unreadable boot id, or a check from before boot ids were recorded keeps the job refused. In that case find the process (`systemd-cgls` for the unit, or the pids listed as `remaining_pids` in the stop receipt under `<workspace-root>/host-receipts`), end it or reboot the host, and run `dalan verify-stops ID` again. Accepted proof is written as a separate `*.reverify.json` receipt beside the original. There is no flag that forces a stop to count as verified. Do not edit `check_jobs` by hand; that bypasses the check.

### Backup and operational rollback

Back up the application state consistently: `bridge.db`, its `bridge.db.secrets/storage.key`, the independent positive-ACK ledger, owner receipts, the artifact index and artifact bytes, and the relevant auth/config files including `as-storage.key`. Never copy the `bridge.db.secrets/owner.sqlite` lock file; it is recreated locally. Preserve their private permissions and binding identity. Exclude `as-owner.sqlite` as required by [authorization-server ownership](#built-in-authorization-server-ownership); it is not application backup data. A database-only backup is not a complete recovery set.

For an operational code rollback, preserve newer jobs, reports, receipts, artifact-index entries, artifacts and positive ACK proof; do not overwrite them with an older full-state snapshot merely to run older code. A schema-incompatible build needs a separately reviewed recovery plan, not a blind database downgrade. The legacy snapshot-restore recipe below is a destructive rollback boundary, not this state-preserving procedure. Restoring missing ACK evidence from backup may recover some proof but cannot establish exactly-once delivery for the lost interval. The transition to `uncertain_terminal` happens automatically. Regrant remains blocked until matching positive acknowledgment evidence or explicit reconciliation resolves the delivery.

### Legacy question ties

An owner can receive the same question again after upgrading a database whose legacy question and owner answer have identical timestamps. Legacy question bodies contain only the text, without a claim epoch or owner-note sequence. `Store.progress()` preserves a legacy notification only when the saved timestamps establish that it belongs to the current generation; an answer at or after its creation time, or an unproven later claim boundary, leaves a fresh question eligible.

The missing answer order cannot always be recovered. Consider two histories within one millisecond and the same claim: (1) answer, question, delivery; (2) question, delivery, answer. With quiet delivery and no active subscriptions, both histories save identical table contents and table-local rowids, apart from random object and attempt IDs. The first history needs duplicate suppression on retry. The second needs a new delivery when the worker asks the same text after the answer. Owner notes do not enter the lifecycle log, and legacy question notifications have no link to an owner-note sequence. A notification rowid orders notifications only; the owner-note sequence orders notes only. Random IDs and a set of delivered notification IDs establish identity, but cannot distinguish these histories.

The bridge therefore keeps a fresh question eligible when the legacy generation is ambiguous. It preserves the old notification ID, body and delivery evidence, including pending and uncertain states. The new notification records the claim epoch and latest owner-note sequence, so retries and restarts reuse it until another answer or claim changes that generation. This can repeat a previously delivered legacy question once per unchanged generation, but avoids suppressing a question that was never delivered after an answer. Do not deduplicate by text or mark uncertain notices delivered to remove this repeat. Removing it in every case requires historical generation or ordering evidence that these rows lack.

`scripts/state-machine-review-test.mjs` creates both histories with the pinned pre-upgrade Store and compares every table, including rowids and sequence counters, after replacing only random identity values. It checks pending, delivered and uncertain questions, then reopens each database with the current Store and verifies delivery eligibility, preservation of old evidence, and retry deduplication after another restart. These are local SQLite and waiter-delivery tests; they do not verify live external delivery.

### Claims and leases

After a lease-expiry or operator requeue, retained claim history keeps a learned `queue_p90` deadline from expiring the job, but an explicit requester deadline still applies.

Before first claim, an expired learned `queue_p90` deadline can be refreshed up to 2 times when queue history supplies a fresh window. The deadline is capped at `created_at` + 12 hours; no requeue occurs when less than the 15-minute floor remains. Each refresh records lifecycle reason `expired_requeued`; `get` exposes `expiry_requeues`, and `status --json` counts still-queued refreshed jobs in `queued_expired_requeued`. Requeues preserve pending notifications and armed watches; final cancellation suppresses them and sends the normal expiry notice.

Each claim has a `claim_id` and an `epoch`. Every claim-scoped call must present the active grant for the caller's verified subject and recorded worker. In built-in mode it must also come from the live connection recorded on the grant: `renew_claim`, `progress`, `ask_question`, `consume_answer`, `finish`, `artifact_chunk` and the five workspace tools otherwise fail with `connection_not_live` and change nothing (see the [connection fence](../PROTOCOL.md#connection-fence-built-in-mode)). A live legacy `claim` retry matches worker, subject, claimant and acquisition ID, including omission matching stored NULL. Exact retries precede rotation. In built-in mode a retry must come from the live connection that holds the grant, and for a destination-approved job while the live connection set matches the approval; it does not re-run destination or repository policy and records no blocker. No idle rotation, explicit resume or re-claim after abandonment can issue a successor before the prior deadline and verified host stop. See the [protocol truth table](../PROTOCOL.md#claims-and-worker-tools) and [pull-worker continuation rules](pull-workers.md#what-one-run-does).

A legacy non-protocol lease expires after its stored `lease_ms` since valid claim activity (default 60 min, bounded by `claim_lease_ms`). Native protocol grants instead expire at fixed `lease_deadline_at`; activity and repeated `claim` do not slide it, and renewal requires explicit `renew_claim` before expiry. `get` and owner notes do not extend it. An expired claim can remain recorded as active until the sweep, but mutations already fail with `lease_expired`. A known superseded grant fails with `claim_superseded`; an unknown grant fails with `invalid claim`. A takeover marks the old claim abandoned, increments the epoch and issues a new claim ID atomically. The worktree and sealed uploads move to the new claim; unsealed upload IDs stay with the old epoch, and check runs retain their original claim ID as evidence. A new finish requires a live, unexpired claim. An identical stored-report retry requires the same active claim, worker and subject, but does not require a live lease; a contradictory retry fails.

`dalan claims [--json]` lists active grants, epochs, lease deadlines and delivery gates. `dalan abandon ID [--reason TEXT] [--json]` ends an active claim and requeues the job, but does not shorten the prior deadline for regrant. Both require the operator key. Takeover and abandon are refused with `uncertain_delivery: reconcile first` while an owner delivery is `uncertain`, `sending`, `uncertain_terminal` or `waiting`, or an unresolved native question delivery holds the grant. Use operator reconciliation or matching positive acknowledgment evidence. Aging to `uncertain_terminal` after 30 minutes ends automatic retries but does not release the claim-epoch fence. Migration preserves existing claim IDs at epoch 1, but does not exempt them from lease validation.

### Objective identity

Migration v22 adds four nullable assignment columns, stored outside the payload and its hash like `review` and `priority`: `objective_key`, `revision`, `task_kind` and `source` (`drainer`, `fix-loop`, `agent` or `unknown`; a `drainer` or `fix-loop` claim must be proven by the request id of its own code path, see docs/usage.md). Admin `/submit` accepts an optional `meta: {objective_key, revision, task_kind, source}` (strings of at most 512 bytes; unknown fields or another source are rejected). A retry of an existing `request_id` is a `request_id conflict` only for a field that both the stored row and the retry carry with different values; a row without meta accepts a retry with meta and is not rewritten. The bridge never guesses a source: `dalan submit` sends `source: agent` unless `--source` says otherwise, and other callers of `/submit` that send no meta leave the columns null. Source identities: `drainer` and `fix-loop` mark rows from two earlier producers, a backlog drainer and a fix pipeline. A drainer row carries the manifest's `objective_key`, `revision` and `task_kind`. A fix-loop row carries `fix-loop:<repo>#<candidate id>`, the pinned head SHA and task kind `fix-loop`; the bridge still accepts that producer's earlier spelling of the name as input (see [Dalan upgrade](dalan-upgrade.md)). The bridge accepts either source only when the request id proves it. Current work is submitted by the requester through `dalan submit`, which sends `agent`; the older identities are historical metadata.

Older rows get meta only from `dalan backfill-objectives [--dry-run] [--json]` (operator key). The CLI reads its receipts (each holds the submitted payload), the manifests that remain and, on installations upgraded from the earlier fix-loop pipeline, its legacy ledger file (`<home>/.local/share/fix-loop/ledger.jsonl`, or the path the earlier release used), derives candidate tuples, and posts only tuples it can verify to the operator route `POST /backfill-objectives {tuples, dry_run}`; the server verifies each again against its stored payload. Verification: a drainer tuple must hash to the row's `request_id` (`dot_` + sha256 of `[repo, objective_key, revision, task_kind, 1]`) and its revision must equal the pinned `head_sha` or `base_sha`; a legacy-fix tuple must reproduce the row's `dotfix-` request id and match its repo and `base_sha`. Candidate tuples for consumed manifests come from the payload shape (PR number and head for `pr-review:`, module, lens and part for `audit:`), and count only when the hash matches. A row with no verifiable source stays null. Only rows whose four columns are all null are filled, so the command is idempotent; it reports counts updated per source, rejected, already set, and rows still without an objective.

### Lifecycle events and metrics

Every state change appends one row to `lifecycle_events` (`request_id`, `claim_id`, `epoch`, `type`, `at`, `actor`, `source`, `reason`) in the same transaction as the change. Types: `queued`, `claimed` (reason `new`, `reclaim`, `resume` or `takeover`), `working`, `waiting` (progress that leads with `QUESTION:`), `blocked` (`BLOCKED:`, `blocker:true`, or a blocked report), `completed` (the worker filed its terminal report, reason `outcome=...`; never acceptance), `consumed` (the owner first received the finished report through `wait` or `get`; `reject` also writes it with reason `rejected`), `accepted` (owner `accepted` or `applied` decisions, including the `dalan accept` alias; worker finish is not acceptance), `integrated` (the owner runs `dalan integrate ID --reason TEXT` through the operator-key route `/lifecycle`; idempotent per request), `abandoned`, `cancelled`, `delivery_sent`, `delivery_uncertain` and `reconciled` (T3, blocker and watch deliveries; webhook events write nothing), and `check_started`, `check_passed`, `check_failed`, `check_skipped`. Actors are `worker:<subject>` (older rows may carry `dot:<subject>`), `owner`, `operator`, `system` or `fix-loop`. Triggers reject UPDATE and DELETE; the only delete path is the hourly retention job, which sets a cutoff row inside its own transaction, rolls events older than 90 days into `lifecycle_daily(day, type, kind, count)` and deletes them (the trigger admits only rows older than that cutoff; it guards against accidents, not against a process that can change the schema). Migration v21 backfills history once, marked `source=backfill`, from assignments, the current claim (earlier epochs are unknown), progress, reports, cancellations, T3 delivery attempts and check jobs; it invents no `consumed`, `accepted`, `integrated`, `abandoned` or `check_skipped` history. `dalan metrics [--since RFC3339] [--json]` (no key needed, like `status`) reads the events. Definitions: *queue latency* is each `queued` event to the next `claimed`; *claim-to-first-activity* is `claimed` to the first `working`, `blocked`, `waiting` or `check_started`; a claim lasts from `claimed` to the next `claimed`, `completed`, `abandoned` or `cancelled` (or now). Inside a claim, the gap after a `blocked` or `waiting` event counts as blocked or waiting time, the gap after `check_started` counts as working (the check is running), any other gap of at most 20 minutes between consecutive claim activity events (claimed, progress, check events) counts as *working time*, and longer gaps count as idle. Utilization is working time over claimed time, and working time over (wall time × the per-subject lane cap); wall time starts at the window start or the first recorded event, whichever is later. *Kind* is the stored `task_kind` (assignment column, else the payload field) when present, else `review` (review mode) or the `execution_scope`, then `/` and the priority, for example `review/background`. *Rework* counts assignments submitted in the window whose `objective_key` was submitted earlier (at any time) with a different `revision`; *duplicates* count assignments whose `objective_key`+`revision` was submitted earlier under another `request_id`. A row cancelled because its preparation expired (`cancelled_reason` `expired`) is skipped by both: it was never worked, so its re-preparation is no duplicate. Both read the assignment columns `objective_key` and `revision` (migration v22), falling back to payload fields of the same name, and are split `by_source`. `objective_coverage` reports how many assignments in the window carry a key (`keyed`/`total`, also per source); when none does, rework and duplicates are unknown with that reason. See "Objective identity" below. Windows that reach rolled-up days report counts from the roll-ups and durations as unknown (`rolled up`).

Check metrics report separate `checks.passed`, `checks.failed` and `checks.skipped` counts. `checks.pass_rate` is passed / (passed + failed + skipped): a skipped check reduces the rate, and a window with only skipped checks reports zero. A window with no check outcomes reports an unknown pass rate. `status --explain` names all three counts.

Subscriptions default to 7 days, capped at 7 days. A verified refresh updates expiry. Lapsed subscriptions leave queued work visible; resubscribe creates a coalesced availability event for each still-queued request. A signing-key change is blocked while old-key events remain outstanding, because the receiver's rotation overlap behavior has not been verified. Unsubscribe revokes the subscription and suppresses retries.

The service checks subscription lapse, missing active subscriptions, repeated callback auth failures, and unclaimed assignments every minute. Health attention is published only after a condition has remained observed for at least 30 minutes. Recovery is published only if that episode has a recorded successful attention. Short episodes send neither message. Missing or failed publication stays retryable, and recorded success stops retries across restart. The timing assumes a trusted OS wall clock. Remote acceptance and the local success record are not atomic, so a lost reply can duplicate transport. Schema 50 adds nullable publication markers without treating older alert timestamps as proof of delivery. Subscription lapse still uses the configured alert lead time (`ALERT_LEAD_MS`) even if the queue is empty; the default is 6 hours. Named alerts are `skipped_by_worker`, `pause_suspected`, `stale_claims`, `transport_failing`, `unclaimed_queued` and `denial_mentioned`, each with attention after the delay and recovery after published attention (except `denial_mentioned`, which remains log-only: a progress or finish note that matches `auto-review`, `guardian`, `denied`, `not approved` or `paused out of precaution` raises one deduplicated alert quoting at most 80 characters, with token-like strings redacted; the bridge takes no action). Each new assignment gets its own availability event at once. After that the bridge re-wakes the default worker (named `dot` in the legacy profile) on a flat, coalesced cadence: on each tick, for each active subscription, it queues at most one fresh availability event, and only when all of these hold: the subscriber has room (`dot_lane_capacity` bounded by the claim cap, minus active claims in its recorded worker lanes and its principal's recorded subject lanes); no assignment wake (a submit event or a re-wake) for the subscription is pending, sending or failed (a failed one is retried, so that retry is the wake; pending or failed owner-note and message events never hold re-wake back); the last wake that went out to it (a submit event, a re-wake or an owner-note event, delivered or sending: each one wakes the default worker) is at least `queue_rewake_ms` old (default 90000, 90 s), unless a freed lane waives that interval once; and at least one queued item is eligible. An item is eligible when it has no owner-facing delivery that is uncertain or sending, its latest assignment wake for that subscription (owner-note events do not count) was not rejected by the callback with HTTP 410 or 413 (terminal), and, if it has been queued `queue_rewake_window_ms` (default 7200000, 2 h; counted from when it last entered the queue, so a requeue after abandon restarts it) or longer, no wake for it was delivered or sending in the last `queue_rewake_stale_ms` (default 1200000, 20 min). Inside the window the 90 s cadence applies; past it each item backs off to one re-wake per `queue_rewake_stale_ms`, without cancellation or parking based on re-wake age alone. The re-wake is an ordinary single event with its own id. It names the first eligible item in `list_pending` order (normal before background, then oldest; priority only orders, so background items stay listed and claimable while normal work is queued; an item the default worker skipped goes behind its peers) and is titled `N assignments queued (F free lanes); claim oldest first via list_pending: <brief>` when more than one item is eligible (F is the subscriber's free capacity; the head is the oldest eligible item). It marks nothing else delivered. Drain may send a queued re-wake later than it was chosen, so the bridge checks it again just before the send: the subscription must still be active, the bridge not paused, the subscriber must still have capacity, and the named item must still be queued and eligible. Otherwise the re-wake is suppressed unsent (`re-wake not sent: <reason>`), and the next tick picks a head again. A retry of a still-eligible re-wake keeps its event id and body. A suppressed event (assignment cancelled, subscription revoked or inactive at send time) woke nobody and does not count, so the next tick re-wakes. Re-wake is also suppressed during pause and with no active subscription. An item queued longer than the window is re-woken only on the stale backoff; while it stays queued (and has no uncertain delivery) it counts as unclaimed: `status --json` shows `unclaimed_after_reannounce` (`count`, `oldest_age_ms` since it entered the queue, up to 10 `request_ids`), `status --explain` shows `unclaimed=N`, and `unclaimed_queued` alerts after 30 continuous observed minutes and recovers only after published attention. Stale re-wake age alone neither cancels nor parks work. Explicit cancellation, preparation expiry and default-worker-only skip expiry still apply (see **Preparation expiry** and **Skip expiry** under [Usage breaks and usage estimates](#usage-breaks-and-usage-estimates)). The `pause_suspected`, `alive_not_claiming` and `at_capacity_healthy` classes remain status observations; re-wake does not depend on them. `<config>/dalan/limits.json` (mode 0600) can set `queue_rewake_ms` (default 90000, range 30000 to 3600000), `queue_rewake_window_ms` (default 7200000, range 600000 to 86400000), `queue_rewake_stale_ms` (default 1200000, range 300000 to 86400000), `pause_suspected_silence_ms` (default 1200000) and `claim_lease_ms` (default 3600000, range 60000 to 604800000); every key is optional. The legacy keys `assignment_reannounce_interval_ms` (60000 to 86400000) and `assignment_reannounce_max_count` (0 to 10) are still accepted and validated, but no longer drive re-wake: the interval only sets the `alive_not_claiming` status threshold (2x the interval), and the max count is ignored. The older `stale_claim_ms` key sets the lease only when `claim_lease_ms` is absent. An item is marked `skipped_by_worker` when the default worker passes it over: it claimed three assignments listed after an item it had just listed (passed over), or the item stayed among the first `free_lanes` assignments for 10 minutes after it first was, with no claim (a poll with no free lane resets that clock). Columns `listed_count`, `last_listed_at`, `skipped_by_worker_at` (migration 33), `last_seen_listed_at`, `eligible_since`, `passed_over` (migration 34). `get` shows `skipped_by_worker:{at,listed_count,passed_over}`, `status --json` shows `skipped_by_worker:{count,request_ids}`, the `skipped_by_worker` alert pages after 30 continuous observed minutes, and the item lists after its same-priority peers until it is claimed. Every `list_pending` answer logs `kind:list_pending_result` with `free_lanes`, `total` and the first 20 `request_ids`. `list_pending` results include `attention`: claimed assignments of the caller with owner notes it has not yet read through `get` or `claim`. `list_pending` results also include `free_lanes` (the lane capacity, bounded by the claim cap, minus the caller's active claims) and a `guidance` string: claim every assignment you can start now, up to `free_lanes`, in this turn. `claim` and `get` results include a short `guidance` string about auto-review denials; `claim` results add `queued_after_claim`, `free_lanes` and one sentence asking to claim more while lanes are free and work is queued. `<config>/dalan/alerts.env` (mode 0600) can set `NTFY_URL` and `ALERT_LEAD_MS`; without a publishable ntfy URL, alerts are logged to `<home>/.local/state/dalan/requests.jsonl`. Alerts contain no assignment text or secrets. The installed unit uses `UMask=0077`.

Optional self-check timers are deployment-specific, so review their endpoint, issuer, TLS and repository assumptions before enabling them. For token and subscription lifetime guidance, see [connection longevity](connection-longevity.md).

## Upgrade and rollback

The package version is `0.5.2`; the bridge database schema is version 65. Stop the service and every other writer before making a backup or replacing files; keep them stopped until the complete backup set is captured. Keep each backup set consistent: include `<home>/.local/share/dalan/bridge.db`, `delivery-acks.db`, `notify-sent.db`, `<config>/dalan/as.sqlite` when built-in authorization is used, the private `<config>/dalan` files, owner receipts in `<home>/.local/share/dalan/receipts`, and artifact ownership entries in `<home>/.local/share/dalan/artifact-index`. Preserve file permissions. Do not copy either `bridge.db.secrets/owner.sqlite` or `as-owner.sqlite` lock database; recreate them locally after restoring with the service stopped, as described above. If external OAuth is used, its issuer database is managed separately and is not part of this bridge backup.

Take each existing application database (`bridge.db`, `delivery-acks.db`, `notify-sent.db`, and `as.sqlite` when built-in authorization is used) with SQLite's `.backup` command into a fresh destination in a new backup directory. Run `umask 077` and create the directory with mode 0700 first, so every copy is private. For each existing source file, set `source` and `destination` to its full source and fresh backup paths, then run `[ ! -e "$destination" ] && sqlite3 -bail "$source" ".backup '$destination'" || exit 1` (use destination paths without single quotes). This refuses an existing destination, so it cannot overwrite an earlier backup such as the rollback set. Stop immediately on any error and discard the incomplete set; do not accept a partial set. Copy the matching keys and other non-database state listed here with their private permissions. Use `.backup` for every application database. If it fails, stop and fix the error; do not fall back to copying only the database file, because a stopped writer can leave committed rows in a `-wal` file or a hot `-journal` that SQLite needs for recovery. Use the installation's resolved roots, including legacy roots and configured paths. Never delete a `-wal` or `-journal` file from a live database just because the service stopped. When you restore a `.backup` snapshot, first move the current database and its `-wal`, `-shm` and `-journal` files aside together, with every process stopped; the snapshot is restored without the old database's sidecar files. The rollback recipe below does this for `bridge.db` (it removes `-wal` and `-shm`); when you restore `delivery-acks.db`, `notify-sent.db` or `as.sqlite` by hand, move aside that database's `-wal`, `-shm` and `-journal` files first.

**Worked backup recipe.** You need `sqlite3` (SQLite 3.27 or newer; macOS includes it) and `dalan` on your PATH. Set `DALAN_HOME` to the service's home, and stop the service first. The recipe checks with `lsof` that no process has a database open and stops if one does or if `lsof` reports an error, because it then opens the stopped databases read-write on purpose: a read-only open of a database whose write-ahead log files are gone fails on the `sqlite3` that macOS ships ("unable to open database file"). Run it as the user the service runs as, or as root: `lsof` does not see the open files of another user's processes. Run this in a shell:

```sh
umask 077
data_root="$(dalan paths --data-root)" || exit 1
config_root="$(dalan paths --config-root)" || exit 1
workspace_root="$(dalan paths --workspace-root)" || exit 1
command -v lsof >/dev/null || { echo "install lsof: the recipe uses it to confirm that no process has the databases open" >&2; exit 1; }
for f in "$data_root/bridge.db" "$data_root/delivery-acks.db" "$data_root/notify-sent.db" "$config_root/as.sqlite" "$config_root/workers-audit-checkpoint.sqlite"; do
  [ -e "$f" ] || continue
  holders="$(lsof -w -t "$f" 2>&1)"; status=$?
  if [ "$status" -eq 0 ]; then echo "a process still has $f open: stop the service first" >&2; exit 1; fi
  if [ -n "$holders" ]; then echo "could not check whether a process has $f open: $holders" >&2; exit 1; fi
done
backup="$HOME/dalan-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 0700 "$backup" "$backup/data" "$backup/config" || exit 1
for name in bridge.db delivery-acks.db notify-sent.db; do
  if [ -f "$data_root/$name" ]; then
    sqlite3 -bail "$data_root/$name" ".backup '$backup/data/$name'" || exit 1
    [ "$(sqlite3 "file:$backup/data/$name?immutable=1" 'PRAGMA integrity_check;')" = ok ] || exit 1
  fi
done
if [ -f "$config_root/as.sqlite" ]; then
  sqlite3 -bail "$config_root/as.sqlite" ".backup '$backup/config/as.sqlite'" || exit 1
  [ "$(sqlite3 "file:$backup/config/as.sqlite?immutable=1" 'PRAGMA integrity_check;')" = ok ] || exit 1
fi
if [ -f "$config_root/workers-audit-checkpoint.sqlite" ]; then
  sqlite3 -bail "$config_root/workers-audit-checkpoint.sqlite" ".backup '$backup/config/workers-audit-checkpoint.sqlite'" || exit 1
  [ "$(sqlite3 "file:$backup/config/workers-audit-checkpoint.sqlite?immutable=1" 'PRAGMA integrity_check;')" = ok ] || exit 1
fi
key="$data_root/bridge.db.secrets/storage.key"
if [ -f "$data_root/bridge.db" ]; then
  version="$(sqlite3 "$data_root/bridge.db" 'PRAGMA user_version;')" || exit 1
  marker="$(sqlite3 "$data_root/bridge.db" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='subscription_storage_meta';")" || exit 1
  if [ "$version" -ge 52 ] || [ "$marker" != 0 ] || [ -f "$key" ]; then
    mkdir -m 0700 "$backup/data/bridge.db.secrets" || exit 1
    cp -p "$key" "$backup/data/bridge.db.secrets/" || exit 1
  fi
fi
cp -Rp "$data_root/receipts" "$data_root/artifact-index" "$backup/data/" || exit 1
if [ -d "$workspace_root/artifacts" ]; then
  cp -Rp "$workspace_root/artifacts" "$backup/artifacts" || exit 1
else
  echo "no $workspace_root/artifacts: this install has stored no artifact bytes" >&2
fi
find "$config_root" -maxdepth 1 -type f ! -name '*.sqlite*' -exec sh -c 'cp -p "$@" "$0"' "$backup/config" {} + || exit 1
```

The loop skips `bridge.db.secrets/owner.sqlite` and `as-owner.sqlite` on purpose: they are lock databases. `workers-audit-checkpoint.sqlite` in the config directory is not disposable: it keeps the length and hash of `workers-audit.jsonl`, so it is saved with `.backup` and must be restored with that log. `bridge.db.secrets/storage.key` is not a lock database either. It is the key that decrypts the subscription secrets in `bridge.db`. The bridge treats a database as encrypted when its `user_version` is 52 or higher or it has the table `subscription_storage_meta`; it then refuses to start without the key (`subscription storage key is missing`). The recipe applies the same test: for an encrypted database it copies the key into `data/bridge.db.secrets/` and stops if it cannot. A database from before the key existed (schema 49, see [From 0.2.0](#from-020)) has no key and the recipe makes none; a key that does exist is always copied. The `find` line passes all files to `cp` in batches, and `find` fails if any copy fails. The other `cp` lines copy the receipts, the artifact index, the sealed artifact bytes and the private key and settings files (all non-database files in the config directory, including `as-storage.key`, the key for `as.sqlite`). The artifacts directory exists only after the install has stored artifact bytes; the recipe says so when it is absent. If another directory above does not exist on your installation, check the path with `dalan paths --json` and adjust; do not skip it silently. A workers file set by `DALAN_WORKERS_FILE` outside the config directory needs its own copy, with its checkpoint, as the upgrade guide says. Move the backup directory off the computer when it is complete.

**Check a restore.** The check copies the backup into a new, empty home and then reads it with `restore-check.mjs`. That script opens the databases read-only and decrypts what the bridge would decrypt. It starts no bridge, no delivery loop and no network socket, so a webhook subscription or pending notice in the restored copy is not sent. Set `backup` to the backup directory and, if you want to read one request back, `request_id` to a known recent request ID. Then run:

```sh
(
umask 077
export DALAN_HOME="$HOME/dalan-restore-check"
[ ! -e "$DALAN_HOME" ] || { echo "$DALAN_HOME exists; choose a new path" >&2; exit 1; }
mkdir -m 0700 "$DALAN_HOME" || exit 1
data_root="$(dalan paths --data-root)" || exit 1
config_root="$(dalan paths --config-root)" || exit 1
workspace_root="$(dalan paths --workspace-root)" || exit 1
mkdir -p "$data_root" "$config_root" "$workspace_root" || exit 1
cp -Rp "$backup/data/." "$data_root/" || exit 1
find "$backup/config" -maxdepth 1 -type f -exec sh -c 'cp -p "$@" "$0"' "$config_root" {} + || exit 1
if [ -d "$backup/artifacts" ]; then cp -Rp "$backup/artifacts" "$workspace_root/artifacts" || exit 1; fi
node "$(npm root -g)/@tnunamak/dalan/src/restore-check.mjs" "$data_root" "$config_root" "$request_id" || exit 1
)
```

From a checkout, run `node src/restore-check.mjs` in the checkout instead of the `npm root -g` path. With `request_id` empty, the script counts the assignments instead. The script prints one JSON line and exits 0 only when `bridge.db` passes `integrity_check`, its status reads back and every stored subscription secret decrypts with the restored key. For an encrypted database a missing key stops it with `subscription storage key is missing`, and a wrong key with `subscription storage cannot be decrypted with the restored key`. It also checks `as.sqlite` and `workers-audit-checkpoint.sqlite` when they are present. For `as.sqlite` it authenticates the storage verifier and decrypts every sealed row with `as-storage.key`, so a wrong key of the right size fails with `authorization storage cannot be decrypted with the restored key`. It does not prove that the whole service starts. To prove that, start the restored home as a service in an environment you have cut off from the network: nothing in these commands cuts it off, and a full start runs the delivery loops. A backup that fails this check is incomplete: take a new one. Delete the restore home when you are done.


This set covers the bridge. If you also upgrade or restore the separate [dead-man monitor](deadman.md), back up its database (`DOT_DEADMAN_DB`, default `/var/lib/dot-deadman/deadman.sqlite`) with `.backup` while that monitor is stopped, and keep that recovery set separate when the monitor runs on another host.

Accept a backup only when `sqlite3 "file:$destination?immutable=1" 'PRAGMA integrity_check;'` succeeds and returns exactly `ok` for each copied database. The `immutable=1` form checks the copy without creating `-wal` or `-shm` files beside it. Restore the complete set into a separate, disposable home and verify that compatible code opens it with the matching keys and reads a known recent assignment. Keep the restore check isolated from production endpoints and deliveries, with no paths pointing to live state; never point it at the live service.

Back up the sealed artifact bytes referenced by the database. Run `dalan paths --workspace-root` with the service’s HOME and environment to obtain the workspace root; its `artifacts` child contains these bytes. This command uses the runtime’s `DALAN_WORKSPACE_ROOT` precedence, legacy fallback, empty-value handling and installation-root selection. Use the Dalan CLI from the new release for these recovery commands, even when the serving build is older. Include any earlier locations still referenced by artifact rows and any separately retained downloads that you need. An owner-side download or cache directory alone does not replace the workspace artifacts. The backup recipes below use the same workspace-root setting.

Install the new code while the service is stopped (for a source install, follow [Upgrade a source install](dalan-upgrade.md#upgrade-a-source-install)), then start it and check its logs and `dalan status --json`. Supported older bridge schemas are migrated on startup. For rollback, stop the service and restore compatible database, authorization, configuration, receipt and artifact state together. Preserve the newer delivery ACK ledger when the target code can read it; verify compatibility before restarting. Restoring only `bridge.db` intentionally retains newer positive ACK proof. Do not overwrite that compatible newer ledger with its older backup.

If the current ACK ledger is missing, restore its compatible backup. If the newer ledger cannot be read by the target code, prefer code that supports it. Restoring an older compatible ledger instead loses later acknowledgments and can repeat already-accepted notices. A consistent backup does not recover ACKs recorded after that backup. Missing receipts or artifact bytes can also make prior results unavailable.

This build refuses startup when `bridge.db` has a SQLite `user_version` above 65. The refusal occurs before schema bootstrap, claim recovery, or listener startup; it reports both versions and makes no schema or row change. SQLite may create, recover or clean up the `-wal` and `-shm` files. Use code that supports the database version, or restore a consistent backup compatible with the code. Never lower `user_version` by hand. Some older builds do not check for a future schema and can modify a database they do not understand. Keep the service stopped during downgrade and restore the full compatible backup before running old code.

### Restart a service and check its state

Linux (systemd user manager):

```sh
systemctl --user restart dot-bridge-NAME.service
systemctl --user is-active dot-bridge-NAME.service
journalctl --user -u dot-bridge-NAME.service -n 20
```

macOS (launchd). `LABEL` is `org.dalan.dot-bridge-NAME`, or the label of the older release when it generated the service (find the file with `ls ~/Library/LaunchAgents | grep dot-bridge`):

```sh
launchctl kickstart -k user/$(id -u)/LABEL
launchctl print user/$(id -u)/LABEL | grep -E 'state|pid|runs'
```

`state = running` and a `pid` mean the bridge is up. `state = not running` with `runs = 0` means launchd loaded the agent but did not start it; run the `kickstart` line again. `launchctl bootstrap` loads an agent and `bootout` unloads it; neither is a restart.

`kickstart` works only on a loaded agent. After `bootout`, or after a reboot that did not load it, it fails with exit 113 (`Could not find service`). Load the agent first, then kick it:

```sh
launchctl bootstrap user/$(id -u) ~/Library/LaunchAgents/LABEL.plist
launchctl kickstart -k user/$(id -u)/LABEL
```

The generated agent has `KeepAlive`, so launchd starts the bridge again after it exits or is killed. launchd waits about 10 seconds between starts of one agent.

Setup loads the agent into the `user/UID` launchd domain. Earlier releases loaded it into `gui/UID`, and a `gui/UID` domain whose desktop session is idle or locked can be in on-demand-only mode: launchd then neither starts the agent at load nor restarts it after `kill -9`, and `launchctl print` shows `pended nondemand spawn = inefficient`. If your service was set up by an older release, run `worker-bridge-setup.mjs --repoint --worker NAME` (it adds the session types the user domain needs), stop the old agent with `launchctl bootout gui/$(id -u) PLIST`, and load it with the two commands above. `launchctl bootout` takes `gui/$(id -u)` instead of `user/$(id -u)` for an agent that is still loaded in the GUI domain.

### Smoke check an installed service

`dalan doctor` is a local check; it does not prove that a worker can finish a job. After setup, a restart or an upgrade, run these with `DALAN_HOME` set to the service's home:

1. `dalan status --json` exits 0 and shows the queue and worker state.
2. Confirm that the log shows `MCP listening on 127.0.0.1:PORT`.
3. Connect the worker's client as in [worker pairing](manual-setup.md#worker-setup), using the service's HTTPS URL from `$DALAN_HOME/resource-url`. The `try` command does not run against an existing service, and a plain loopback URL is not accepted outside loopback mode.
4. Submit the repository-free job from [the manual setup](manual-setup.md#submit-finish-and-read-the-result) with `dalan submit --worker NAME --execution none --deliver none --file first-job.json --json`, prompt the worker, then run `dalan wait REQUEST_ID` and `dalan decide REQUEST_ID accepted`. The job must reach `finished`.

Restart the service once more and run `dalan get REQUEST_ID`: the job must still be `finished`.

### Remove an installation

Remove only what you created. An install can leave these behind:

| What | How to remove |
|---|---|
| Generated service (systemd unit or launchd plist, and any recorded exposure) | `node scripts/worker-bridge-setup.mjs --remove --worker NAME --home HOME_PATH`. It finds only a service generated under the current names. Stop an agent of a release before 0.4.0 and delete its plist by hand first (`ls ~/Library/LaunchAgents | grep dot-bridge`). |
| Bridge home: database, keys, receipts, artifacts | Add `--purge-home` to the command above, or delete `HOME_PATH` yourself. This destroys private keys and job history. `--purge-home` refuses, and names what it found, while another unit file in the user's unit directory (`~/.config/systemd/user` or `~/Library/LaunchAgents`) names `HOME_PATH`, or while a process holds the home's `bridge.db` open; stop that service first. |
| Trial home (`dalan try` keeps it) | Delete `<HOME>/.local/share/dalan-trial` (or the directory given to `try --home`). |
| Worker-client registration | `codex mcp remove NAME` or `claude mcp remove --scope user NAME`, with the name you registered (`local` for `try`). Then open the Codex `config.toml` (`$CODEX_HOME/config.toml` if `CODEX_HOME` is set, otherwise `~/.codex/config.toml`) and remove any `[mcp_servers.NAME.tools.*]` tables you added. `codex mcp remove` may already have removed them. |
| The `dalan` command | Installed with `npm install -g @tnunamak/dalan`: run `npm uninstall -g @tnunamak/dalan`. Linked from a checkout with `npm link`: run `npm unlink -g @tnunamak/dalan`, then delete the checkout. Started with `npx @tnunamak/dalan try`: npx leaves a copy in its cache. To find only Dalan's entry, run `grep -l '"@tnunamak/dalan"' ~/.npm/_npx/*/package.json`; delete the directory that holds each file it lists, after you check its contents. Do not delete all of `~/.npm/_npx` or run `npm cache clean --force` unless you accept losing the cached copies of other packages too; both are optional. |
| Upgrade staging install | The [npm upgrade](dalan-upgrade.md#upgrade-an-npm-install) installs a second copy of Dalan and its dependencies in `$HOME/dalan-new` (or the directory you gave to `npm install --prefix`) for the drain. First check that no service runs code from it. Linux: `grep -Rl dalan-new ~/.config/systemd/user`. macOS: `grep -RSl dalan-new ~/Library/LaunchAgents`. `grep` exits 1 and prints nothing when it finds none; any other exit status, or any error message, means the check failed, so do not delete anything until you fix it. Then delete that one directory, `rm -rf "$HOME/dalan-new"`. It holds no bridge home. Do not delete other npm installs. |
| ngrok service (only with `--expose ngrok`) | If you installed ngrok's system service with the commands setup printed, run `ngrok service stop`, then `ngrok service uninstall`. `--remove` does not run them. |
| Setup lock file | `/tmp/dot-bridge-setup-locks-UID/install.lock` is an empty file that setup creates and never deletes. It holds no data; delete it if you want nothing left. |
| Older installs | Directories named `dot-bridge` under `~/.config`, `~/.local/share` and `~/.local/state`, if the install predates the rename. |

Check that nothing is left: `systemctl --user list-units 'dot-bridge-*'` on Linux, `launchctl list | grep dot-bridge` on macOS, and for the bridge port `ss -ltn | grep PORT` on Linux or `lsof -nP -iTCP:PORT -sTCP:LISTEN` on macOS.

### From 0.2.0

0.2.0 uses schema 49; this release supports schema 65. Stop the service and take the consistent backup above **before first startup**. Include the subscription key at `bridge.db.secrets/storage.key` and built-in-AS `as-storage.key` when present; do not copy either `bridge.db.secrets/owner.sqlite` or `as-owner.sqlite` lock file. Preserve the private permissions and the artifact bytes, receipts and positive ACK proof.

The table comes from a source review of `Store.migrate()` and the helper migrations it calls. The migration batch runs in one `BEGIN IMMEDIATE` transaction. “Additive” describes the SQL, not backward compatibility:

| Schema | Change and additivity |
| --- | --- |
| 50 | Add nullable alert publication fields: `alert_episodes.attention_sent_at`, `worker_breaks.alert_first_observed_at` and `attention_published_at`. Additive; old timestamps are not treated as delivery proof. |
| 51 | Advance the schema fence to prevent older servers writing plaintext AS state. Version-only in this Store migration; not a downgrade guarantee. |
| 52 | Add `subscription_storage_meta`, encrypt existing subscription secrets/connections, replace the connection-immutability trigger, and validate storage. **Not additive-only:** existing values are rewritten. Startup checkpoints and VACUUM remove legacy pages before marking storage ready; plaintext-write guards are installed. |
| 53 | Add nullable `claims.lease_ms` and backfill null durations from `claim_lease_ms` as configured at the **first** upgraded startup. Additive structure with a data backfill. |
| 54 | Add `owner_submit_commands` for keyed submission intent and receipts. Additive. |
| 55 | Add `job_questions` and `question_answer_wakes` for grant-bound questions and answer wakes. Additive. |
| 56 | Add `protocol_jobs`, `protocol_events` and nullable `claims.lease_deadline_at`; invoke claim-command, artifact-journal, result-binding, job-retention and owner-waiter migrations. The helpers create new tables (`CREATE TABLE IF NOT EXISTS`). No existing claim, assignment or progress column is rewritten or dropped. On a 0.2.0 database the new tables start empty; 0.2.0 has no protocol jobs. |
| 57 | Create the protocol delivery-attempt, delivery-receipt and stop-observer tables, then set version 57. Additive: no backfill, delete, drop or alter of existing tables. |
| 58 | Create `submit_supersedes` with foreign keys to assignments. |
| 59 | Add `assignments.expiry_requeues` with a full retry budget for existing rows; deadlines and claims do not change. |
| 60 | Create destination approval and block records, approval immutability triggers, and nullable `claims.destination_revision`. Existing jobs are not retroactively approved. |
| 61 | Add nullable `claims.connection_id` without inferring or backfilling a connection from the live set. Older grants keep NULL; built-in claim mutations require the recorded live granting connection. |
| 62 | Add nullable lease boot and monotonic deadline fields on `claims`. Additive. |
| 65 | Rename `dot_breaks` to `worker_breaks` (with its index) and `assignments.skipped_by_dot_at` to `skipped_at`; the `break_notices` foreign key follows the table. Data is unchanged, but older code looks for the old names, so **roll back only from the backup taken before this upgrade**. Schemas 63 and 64 belong to migrations merged before this one. A database that reached schema 35 under the earlier step keeps `DEFAULT 'dot'` on `assignments.target_worker` and `messages.target_worker` in its stored schema text (SQLite cannot change a default without rebuilding the table); a new database has an empty default, and every insert names the worker. |

**Live claims:** the `v0.2.0 live claim survives upgrade to schema 57` fixture is historical evidence for that upgrade, not a current built-in claim-continuity guarantee. Migration 61 retains older claim records but leaves their connection binding NULL. In built-in mode, those grants cannot mutate or retry as the holding connection (`connection_not_live`); wait for the prior lease deadline and verified host stop before acquiring a successor. The historical fixture does not bypass current connection, destination or lease guards. Two additional lease limits apply:

- Downtime does not renew a lease. A legacy claim expires by its last activity plus `lease_ms`. Restart grace only delays abandonment; it does not let an expired claim act. A new `finish` or `progress` on a claim that expired while the service was stopped fails, and the job must be claimed again. An exact retry of a `finish` that was already committed still returns its stored receipt.
- Migration 53 copies `claim_lease_ms` (or the legacy `stale_claim_ms`) from `limits.json` at the first upgraded startup. Keep that setting unchanged across the upgrade, or existing claims get the new duration.

**Keys and file modes:** a 0.2.0 install may have no `bridge.db.secrets/storage.key` yet. The upgrading startup creates it, then encrypts subscription rows with it. Without that key the upgraded database cannot be opened. Startup refuses files with the wrong owner or mode: `bridge.db.secrets` must be a directory owned by the service user with mode 0700, `storage.key` a 32-byte regular file with mode 0600, and `limits.json` mode 0600. Run the new release as the same user with the same HOME as 0.2.0. Never create or edit key contents by hand.

Upgrade steps:

1. Drain built-in-mode claims (let them finish or expire), then stop the service.
2. Take the backup above and keep this set as the rollback set.
3. Install the new release without changing `limits.json`.
4. Start the service, check its logs and run `dalan status --json`.
5. Drain claims as needed and stop the service and every other writer again. Take and verify a second consistent backup as above, including the new `storage.key`, then restart the service and check its logs and `dalan status --json`. Do not overwrite the rollback set.

Short downtime does not keep a built-in claim valid across migration 61. A claim left in flight cannot act after the upgrade; wait for its lease deadline and verified host stop before acquiring a successor.

**Rollback limit:** 0.2.0 refuses a database newer than schema 49 (see the 0.2.0 changelog); this build refuses versions above 65 before schema bootstrap. Do not lower `user_version` or undo encryption by hand. Use compatible code, or a separately reviewed restore of the complete pre-upgrade state. Restoring that snapshot discards later work; preserve compatible newer ACK proof and account for possible duplicate notices if proof is lost.

The request log rotates before the next append after it exceeds 32 MiB, retaining four older files (`requests.jsonl.1` through `.4`, newest to oldest). Set `DALAN_LOG_MAX_BYTES` and `DALAN_LOG_KEEP` to positive integers to override these defaults. Each line stays whole, so a file can exceed the threshold by one line. Fresh logs use mode 0600, and break-usage backfills read all retained generations, oldest first; older history is discarded when retention fills.

MCP arrivals and response outcomes are logged without request contents or secrets. A failed tool call's `mcp_outcome` line also carries `tool_error_message`: the bridge's error text, redacted like alert notes and cut to 300 characters (null for a successful call).

### Usage breaks and usage estimates

The bridge records usage breaks and slows the worker only on evidence: an owner-confirmed break or a pause. Rate limits are estimates that it reports and never enforces. See [usage](usage.md#usage-breaks-and-usage-estimates) for the commands.

- **Break state.** Table `worker_breaks` (migration 25): `since`, `until` (NULL while active), `reason`, `source` (`owner` or `inferred`), `end_source` (`tool_call` or `owner`) and a usage snapshot. `dalan break --reason TEXT [--since RFC3339]` marks one (operator key, like `pause`); over an active break it takes it over (source `owner`, new reason). `dalan break --clear` ends it. The per-minute alert loop infers a break when all three hold: no worker tool call (any subject) for `worker_break_silence_ms` (default 1200000, 20 min), an availability event got a 2xx after the last call, and work is queued; `since` is the last call. A default worker that never made a tool call is not inferred. A break the owner cleared is not inferred again until the default worker calls again. The default worker's next authenticated tool call ends the active break.
- **Evidence rule.** The bridge holds work only on evidence: an owner-confirmed break (`worker_breaks.source='owner'`) or an operator pause. An inferred break (silence) is recorded, may alert after the queued-work delay, is ended by the next tool call and excluded from queued age, but holds nothing: re-wakes keep the normal cadence and refill is not held. The rolling limits below are estimates and never hold work.
- **During an owner-confirmed break.** No re-wakes except one probe (the usual head re-wake) every `worker_break_probe_ms` (default 1800000, 30 min). A new submit still sends its own first event. Break time does not count as queued age, so the re-wake window and `unclaimed_after_reannounce` do not advance. The break itself does not park or cancel work. Explicit cancellation, preparation expiry and default-worker-only skip expiry still apply during a break (see **Preparation expiry** and **Skip expiry** below); delivery pause does not suppress the maintenance sweeps. Each owner gets one notice per break: a T3 thread with queued normal work gets one message through the T3 adapter (marker, `--if-busy steer`, uncertain/reconcile rules; a muted or protected thread keeps it in the wait queue), and each queued normal `delivery=none` request gets one wait-queue attention row, which `dalan wait` returns as `status:"worker_break"` (exit 5). `get` lists `worker_break_notices`. Refill (`/owner-states` `refill.held`, `dalan wait --drained`, the ACP adapter) is held only by a pause or an owner break. Readers of `/status` that gate on `worker_break.active` should also check `worker_break.source==='owner'`.
- **Alerts.** A `worker_break` alert requires 30 continuous observed minutes with queued worker work. An observed empty queue resets that timer. An idle break stays quiet; an ended, unpaged break does not send a retrospective attention/recovery pair. A published attention allows one `worker_break resolved` at end, each edge marked only after successful publication. The same queued-work requirement applies to `pause_suspected`. For an inferred break the start text says the default worker "may be on a usage break" and "Not confirmed, so nothing is held"; confirm with `dalan break --reason TEXT`.
- **Ledger.** Every break start records claims, finishes, tool calls, checks over 60 s and response bytes (total and per tool) in the 1h, 6h and 24h before `since`. Tool calls come from `worker_calls` (per recorded worker, subject, tool and minute, kept 48 h); `tool_calls` is `null` when the counter has no data before `since`, and `tool_calls_partial` marks a window that starts before the counter's first minute. `dalan breaks [--json]` lists the ledger.
- **Usage estimates.** `max_claims_per_hour` (default 90), `max_tool_calls_per_24h` (default 10000, rolling 24 h), `max_tool_calls_per_hour` (default 1000), `max_response_bytes_per_24h` (default 100000000, rolling 24 h) and `max_response_bytes_per_hour` (default 8000000) are operator-configured reporting estimates, not published provider limits. Reaching one holds nothing: no re-wake suppression, no hiding of background work in `list_pending`, no refill hold; the default worker's calls are never refused. A recorded owner-marked break cuts the byte and tool-call estimates to 70% of its ledger, and the claims estimate to 70% of its busiest claim hour (only ever lower; never below 25% of the configured value; `learned_limits`, migration 28). An inferred break teaches nothing (its last hour is quiet by construction). `dalan learned [--clear]` lists or removes learned limits and shows `over_estimate`. When an estimate is reached, `status --json` lists it in `throttle.over_estimate` and the alert `usage_over_estimate` pages once after 30 continuous observed minutes per episode (`usage_over_estimate: NAME USED/LIMIT`; learned ones add the configured value, learned value and break). `throttle` also shows the rolling counts and the effective, configured and learned limits; `rewake_throttled`, `submit_throttled` and `normal_rewake_throttled` are always false and `holding` is always empty, kept for older readers. `status --explain` always shows `calls=1h:C/MAX,24h:C/MAX bytes=1h:B/MAX,24h:B/MAX` and adds `over_estimate=NAME+NAME` when any is reached. The ledger snapshot has response bytes per tool; `dalan break-usage-backfill --id N` fills them for an older break from the request log.
- **Skip expiry.** A queued assignment that has been `skipped_by_worker` for at least `DALAN_SKIP_EXPIRE_HOURS` (default 6) and was passed over at least 3 times is cancelled by the independent maintenance timer with status `cancelled`, `cancelled_reason` `skipped_by_worker`, a lifecycle `cancelled` event (actor `system`, reason `skipped_by_worker`) and its pending events and watches suppressed. The request log gets `skip_expired` with the ids. The sender sees it: `dalan wait ID` returns `status:"cancelled"` with `cancelled_reason` (exit 4) and `get` shows `cancelled_reason`. Claimed assignments and other target workers are never touched. A usage break and delivery pause do not suppress this sweep, even for a qualifying assignment without a preparation deadline. Set the variable in the bridge environment; a non-positive or non-numeric value keeps the default.
- **Preparation expiry.** For every worker, a queued assignment whose effective `valid_until` has passed is expired: no worker can claim it (the PR preflight refuses an expired preparation). An independent maintenance timer sweeps every 500 ms, including while delivery is paused, right after each default worker tool call (the call that ends a break) and after `dalan break --clear`. A row whose deadline came from the learned `queue_p90` default is requeued, not cancelled, while it still has requeue budget (`expiry_requeues`, added by migration 59, below 2) and a fresh learned deadline can be computed: it stays `queued` with a freshly computed deadline for its worker/kind, `expiry_requeues` incremented, and a lifecycle `queued` event with actor `system` and reason `expired_requeued`; the request log gets `assignments_expired_requeued` with the ids. The fresh deadline never passes `created_at` + 12 hours (the `QUEUE_WINDOW` cap): it is clamped to that cap, and a row with less than the 15-minute floor remaining before that cap is cancelled instead. A row with no computable fresh deadline (insufficient queue history), with `expiry_requeues` already 2, or with an explicit requester deadline is cancelled as before: status `cancelled`, `cancelled_reason` `expired` (column added by migration 27, beside `valid_until`, which stores the explicit or learned deadline; an owner cancel leaves the reason NULL), a lifecycle `cancelled` event with actor `system` and reason `expired`, and its pending events and watches suppressed as `cancel` does. The request log gets `assignments_expired` with the cancelled ids. A cancelled row's claim error (`assignment_expired: ...`) no longer promises a requeue: it names the deadline and states the bridge will not requeue it. `get` shows `expiry_requeues` and the lifecycle events, including requeues. This preparation-expiry sweep leaves claimed assignments and assignments without `valid_until` alone. Pause and usage breaks do not stop wall-clock passage or extend stored deadlines. A valid explicit deadline wins. Learned `queue_p90` defaults apply only to normal-priority submissions while not paused, and for `dot` only outside an owner-confirmed break; background submissions and these holds suppress learned defaults, not explicit deadlines. An inferred break alone does not suppress a default. With at least 5 samples for that worker and task kind over 7 days, the learned window is 3 times p90, clamped to 15 minutes–12 hours; insufficient history supplies no default. Until the sweep runs, an expired item is not live queue: `list_pending` and its lane hints never list it, `claim` answers `assignment_expired: ...` instead of a preflight error, and the queued counts in `status` (`counts`, `priority_counts`, `throttle.queued`), the background cap and configured admission checks leave it out; `status --json` reports it as `queued_expired` (`count`, `oldest_expired_at`), and reports still-queued previously-requeued rows as `queued_expired_requeued` (`count`, `oldest_valid_until`), `status --explain` adds `queued_expired=N` when N > 0, and liveness classes it `expired` (not `alive_not_claiming`). `/admission` reports the expiry; inspect the actual status after the sweep before preparing replacement work (see [requester commands](setup-reference.md#requester-commands)); submit replacement work under a new request ID with refreshed pinned inputs and validity.
- **Compact thread list.** `t3_thread_list` returns the newest 50 threads (within 16000 bytes of entries) in compact form with `total`, `truncated` and per-project counts, returning a bounded compact response ([contract](t3-reverse-control.md#compact-t3_thread_list-result)).

### Execution capability and check evidence

Check rows expose `skipped_segments`, `skipped_segment_names` and `check_summary`; new receipts persist these fields in `check_runs.evidence` before preview truncation. A run with reported skips has status `skipped` and a `check_skipped` lifecycle event. Failure, timeout or cancellation with skips remains `failed` with a `check_failed` event. Exit 77 implies at least one skip even without a named segment. Historical completed rows are projected with the same coverage rules when their stored output or exit code proves a skip.

The repository's `default` check starts with the security regression suite and skip-reporting tests. Its existing `test:sandbox` command chain stops at a failed or skipped command; a refused executor journey therefore leaves the check incomplete and names the skipped segment in its summary. The full `npm test` segment runner continues through skips and lists each skipped command separately.

Since migration 37 an assignment has an `execution` column: `none`, `worker` or `host`. `dalan submit --execution VALUE` sets it. Without the flag the legacy profile uses `host` (host execution still requires the separate operator opt-in below) and a `workers.json` profile uses its top-level `default_execution` (absent means `none`). Only `host` jobs probe host prerequisites at submit. A `host` job on a host with no `/usr/bin/bwrap` is refused with `capability_not_available: host_execution (bwrap not found)`. `--require-capability a,b` (host jobs only) refuses the job unless the backend declares each capability `verified`. `run_check` on a `none` or `worker` job answers `capability_not_available` and runs nothing. `dalan doctor` prints the executor state and the declared table. The historical backend table comes from `scripts/sandbox-probe-e2e.mjs`. Opted-in execution reports `linux-bwrap-systemd` version 1; `scripts/host-budgets-test.mjs` tests its resource and lifecycle boundary.

Host checks are **off by default**, including for assignments with `execution: host`. An operator opts in by setting `DALAN_HOST_CHECKS=1` in the bridge service environment. A second owner-only file, `<config>/dalan/host-check-allowlist.json`, must permit the exact repository/check ID pair. It has a closed version-1 shape: `{ "version": 1, "checks": [{ "repo": "OWNER/REPO", "check_id": "name" }] }`. Create it as a regular file owned by the bridge service UID with mode 0600. Missing, empty, malformed, symlinked, foreign-owned, wrong-mode or unknown-version policy denies checks. Wildcards and extra keys are invalid. Repository spelling must match the owner definition key exactly.

Example allowlist entries (not installed automatically):

```json
{
  "version": 1,
  "checks": [
    { "repo": "example-org/example-repo", "check_id": "host-disk" },
    { "repo": "example-org/example-repo", "check_id": "docs-consistency" },
    { "repo": "example-org/example-repo", "check_id": "auth-smoke" },
    { "repo": "example-org/example-repo", "check_id": "metrics-batch" },
    { "repo": "example-org/example-repo", "check_id": "storage-recovery" },
    { "repo": "example-org/example-repo", "check_id": "compat-v1" },
    { "repo": "example-org/example-tools", "check_id": "log-backup" }
  ]
}
```

Each permitted pair also needs a current definition in the owner-configured `checks.json`, including an owner `host_budget`. Pinned repository metadata and candidate changes can describe checks but cannot grant host execution or replace that owner definition. At launch, the bridge rereads both files after source preparation and compares the selected definition with the current owner definition. Revoking or changing a pair before launch blocks that launch. Removing permission does not stop a check that already launched; normal cancellation, claim/epoch and process-stop guards still apply. This allowlist does not widen read grants: the whole-checkout executor still requires an owner-approved repository-wide read grant. Jobs with `execution=worker` or `execution=none` do not run host checks.

For example, an owner may allow these repository/check pairs: `example-org/example-repo` with `host-disk`, `docs-consistency`, `auth-smoke`, `metrics-batch`, `storage-recovery` and `compat-v1`; and `example-org/example-tools` with `log-backup`. These entries are examples only and are not installed automatically. Removing `DALAN_HOST_CHECKS=1` or revoking the pair refuses subsequent launches; neither action cancels an already-running check. Existing cancellation still stops active checks. Linux needs bubblewrap with `--size`, `--disable-userns` and `--as-pid-1`, Python 3.12+, a running systemd user manager, unified cgroups, and working memory, swap, CPU and PID controllers. Missing controllers or failed service setup refuse execution. There is no fallback to the legacy launcher. macOS and other platforms refuse even with the setting enabled.

Every host-runnable check needs a current owner-configured definition with all six `host_budget` fields. A repository definition may tighten those limits, but cannot raise the owner limits, replace the owner command or authorize another ID. There are no per-check defaults. For example, this is one repository-entry fragment for the mode-0600 host checks file, not the complete file. Place it under the exact repository key:

```json
{"checks":{"default":{"argv":["/runtime/node","--test","test/example.test.mjs"],"timeout_ms":60000,"output_bytes":65536,"host_budget":{"cpu_ms":30000,"wall_ms":60000,"memory_bytes":536870912,"processes":64,"disk_write_bytes":67108864,"output_bytes":65536}}}}
```

The execution service budgets its own preparation: source archive creation, transfer and extraction, namespace setup and seccomp setup. Preparation shares CPU, wall, memory, process and writable-storage allowances with optional `install_argv` and `argv`; the output allowance covers phase output. Git fetching and worktree preparation, metadata discovery, evidence hashing and retained output artifacts happen outside the service and are not covered by these per-check budgets. This execution preparation is separate from the assignment deadline described under **Preparation expiry**. The smaller of `timeout_ms` and `wall_ms` applies; the smaller output allowance applies. Retrying a completed check creates another invocation and spends another allowance. Required budgets also apply to jobs queued before the operator opted in.

Owner-side integrator verification also requires `DALAN_HOST_CHECKS=1`. Each evidence-plan check gets a separate service envelope with fixed limits: 30 seconds CPU, 60 seconds wall time, 512 MiB memory, 64 tasks, 64 MiB writable storage and 256 KiB output. An evidence plan cannot raise these limits. The integrator's Git checkout, patch application and host-side copy for each check occur outside the envelope; its check receipt records the limits, usage and verified stop.

| Field | Allowed range | Enforcement |
| --- | --- | --- |
| `cpu_ms` | 50–120,000 ms | Whole-service `cpu.stat` usage, including short-lived children and execution preparation. Git fetching and other host work outside the service are not budgeted. An external supervisor and namespace supervisor sample every 10 ms and stop the job on exhaustion. `CPUQuota=100%` limits aggregate CPU rate. |
| `wall_ms` | 100–180,000 ms | systemd `RuntimeMaxSec`, independent of the bridge and check supervisor. Cleanup sends SIGKILL without a graceful execution extension. |
| `memory_bytes` | 128 MiB–1 GiB, multiples of 4096 | Kernel `MemoryMax`, including supervisor processes and tmpfs pages; `MemorySwapMax=0` and whole-group kernel OOM kills. |
| `processes` | 16–128 tasks | Kernel `TasksMax` / `pids.max`, including threads and trusted supervision. A failed fork increments `pids.events` and fails the check. |
| `disk_write_bytes` | 1–256 MiB, multiples of 4096 | One size-limited tmpfs holds the candidate copy, writable cache, HOME and temporary files. Prepared dependencies are mounted read-only and do not consume this writable-storage allowance. Root and proc are read-only; only fixed null/random devices are exposed, and shared-memory files use the bounded tmpfs. No PTY allocator is exposed. There are no writable host binds or shared writable caches. |
| `output_bytes` | 1 KiB–1 MiB | Combined stdout/stderr across both phases. The supervisor retains only the allowance and kills the namespace when another byte arrives. The bridge separately caps the receipt transport. |

Admission atomically reserves `dot-bridge-host-check.service`, one active envelope per Unix user across bridge processes. The ceilings above define that slot's capacity; a competing invocation is refused as busy. systemd applies the kernel limits and `Nice=10` before the source producer starts. The service verifies them before transferring any repository bytes. It owns the whole process tree with `KillMode=control-group`; a main-supervisor crash kills descendants. Closing the bridge control pipe stops the service, with the independent wall deadline as fallback. No application reservation files or expiry timestamps survive to strand capacity. The unit is collected after cleanup. The stop receipt includes its invocation ID and checks that only the stop recorder remains in the cgroup; a missing receipt or surviving process never becomes a verified stop.

The namespace supervisor runs as PID 1 and sets itself non-dumpable. Guest processes cannot signal namespace init to death or use `/proc/1/fd` to forge its receipt. Each command receives separate output pipes and closed inherited descriptors. The supervisor kills and reaps all phase descendants before starting the next phase. Source enters through a streamed archive with safe extraction; masked originals are omitted and approved source overlays stay read-only. A narrow `scope_paths` or any `scope_excluded` still refuses: this backend requires an owner-approved repository-wide read grant. An invalid sensitive-path policy also refuses before launch.

Both phases are offline. Networked package fetching is not supported by this backend. Before a check of a repository with a root npm lockfile, the owner prepares dependencies with the same Node runtime as the bridge:

```sh
dalan prepare-deps /path/to/pinned/source --json
```

This local owner command runs `npm ci --ignore-scripts --no-audit --no-fund` in a fresh directory with the owner's normal network. It copies only the root manifest and lockfile, leaves the checkout unchanged, and does not copy project npm settings or credentials into the prepared tree. The private cache at `~/.dalan/prepared-node-modules` is keyed by the exact lockfile hash and Node version, ABI, platform and architecture; metadata also binds the manifest hash. Cache ancestors must be owner- or root-controlled without group or other write access. Workspaces and local package dependencies are unsupported. Packages that need lifecycle scripts are unsupported by this preparation path.

Checks only look up the prepared tree; workers cannot prepare it. A missing or invalid entry fails with `dependencies_unprepared` and an owner recovery command. `dalan prepare-deps /path/to/pinned/source --replace-invalid` rebuilds an invalid entry and retains its old directory under `.replaced-*` in the private cache, so an existing mount is not modified. The owner can remove those retained directories after checks using the old input have ended. Preparation does not enable a check or change the repository/check allowlist.

The tree is mounted read-only at the guest's root `node_modules`. Ambient `node_modules` directories are omitted from the source archive, and the protected supervisor verifies the copied manifest and lock hashes before launching either phase. A changed lock needs a matching preparation; there is no network or installed-checkout fallback. Checks without a root lock get no prepared tree. An explicit `install_argv` still runs offline within its existing envelope; it cannot replace the read-only tree. Preparation and lookup happen on the host outside that envelope. The guest retains its original CPU, wall, memory, process and output limits; read-only dependency pages remain subject to the service's memory limit.

Writes remain in the private execution copy and are discarded when its namespace exits. Only captured output is exported. Receipts identify `execution_storage: private_tmpfs_copy_not_exported` and the selected dependency identity; they do not claim host worktree hashes observe install or post-check mutations in that copy, or attest the entire executed source. The original candidate diff remains available for owner review.

Budget failures store a failed check with `budget exceeded: cpu|wall|memory|processes|disk_write|output`. Supervisor loss says `supervisor interrupted`. Admission and source transfer or extraction failures retain their own reasons. Evidence in `check_runs.evidence` includes the limits, available observed usage, service result and stop proof. On a wall kill, the bridge retains bounded partial output and the most recent usage snapshot, labeled `usage_complete: false`. Roughly the final 100 ms may be absent; an early kill or OOM can leave usage unavailable. The service manager still supplies its stop result. The bridge labels its execution receipts `bridge_verified`; a worker's own reports remain `worker_attested`. Neither label proves that the check definition tests the intended behavior. `immutable_input_snapshot` remains unsupported.

Limits: CPU and output are observed by a supervisor, so stopping can overshoot by a scheduling interval or an in-flight read. The 10 ms CPU interval is not a hard overshoot bound on a loaded host. `disk_write_bytes` measures allocated writable capacity, not cumulative rewrites or wear on a block device; guest writes use tmpfs. Memory also limits tmpfs inode and metadata consumption. Fixed control files and namespace setup consume additional memory within the cgroup. The slot does not preallocate physical RAM against unrelated host programs or coordinate other Unix users. Git fetching and worktree setup, metadata discovery, evidence hashing and retained output artifacts keep their existing limits and are outside the execution service. The limits do not hold across a kernel crash or an uninterruptible kernel task. Execution is disabled on macOS.

The supervisor requires libseccomp and installs an inherited filter before any phase starts; failure to install it refuses the check. It denies inotify and fanotify creation, POSIX message queue creation, and keyring operations because their quotas can affect the host user. Watch-mode checks are unsupported: `inotify_init` and `inotify_init1` return `EPERM`. A failed phase includes a restriction notice when output space permits; the notice does not establish why the phase failed. POSIX message queues and keyring-dependent checks are also unsupported. The filter has been qualified only for the native architecture; 32-bit compatibility binaries are unsupported and their behavior has not been verified. Bubblewrap disables creation of further user namespaces, and the private IPC namespace isolates System V IPC objects. Other shared per-user or system-wide kernel resources, including queued signals and open files, are not exhaustively isolated or audited by these budgets.

Run the Linux qualification with an outer timeout and reduced priority: `timeout --kill-after=5s 150s nice -n 10 node --test scripts/host-budgets-test.mjs`. It exercises fork exhaustion, memory growth, disk filling, wall/CPU exhaustion, output flooding, killed/frozen supervisors, bridge death, concurrent admission, cumulative phases, receipt protection and a persisted host-check result. On other platforms those kernel journeys explicitly skip. The older host journeys have no budget declarations and still test default-off refusal before skipping execution.

### Worker identity and rollback

`workers.json` maps approved token connections to workers. An install whose `bridge.db` already carries a schema (an empty or schema-less file does not count) and never loaded a profile may omit it and keeps the legacy profile (one worker named `dot`). A fresh install without `workers.json` refuses to start and asks for `dalan init --worker NAME`; run `dalan init --legacy --public-url URL` (it writes a `legacy-profile` marker next to `as.json`) or set `DALAN_LEGACY_PROFILE=1` to run the legacy profile on a new host. The bridge records when it loads a profile; if that file later goes missing, startup stops unless the operator sets `DALAN_LEGACY_PROFILE=1` to select legacy mode explicitly. Set `DALAN_WORKERS_FILE` to choose another file. The file must be mode 0600. With an external issuer, every connection record needs `issuer` and `subject`; it also needs `client_id` unless it has `connection_id`, and `connection_id` and `client_id` only narrow the record further. A record without `subject` fails at startup. For example:

```json
{"workers":{"acme":{"connections":[{"issuer":"https://issuer.example/realm","subject":"owner","client_id":"acme-client"}],"capabilities":["t3"],"repos":[]},"example-worker":{"connections":[{"issuer":"https://issuer.example/realm","subject":"owner","client_id":"example-client"}],"repos":[]}},"default_execution":"none"}
```

Submit with `dalan submit --worker NAME`. In profile mode, omitting it is refused with the configured worker names, except that a profile with exactly one worker defaults to it; only a legacy install (a database but no `workers.json`) defaults to `dot`. A new host starts with `dalan init --public-url URL --worker NAME`, which writes `workers.json` with `repos: []` for the worker (mode 0600, no `t3` capability, no host execution, and no repository access) and refuses to overwrite one that exists. `dalan init --legacy` writes none and keeps the legacy profile, for existing worker hosts only. `as-init` creates the AS files alone. `tell --worker NAME` targets a lightweight message. `pool` is unsupported as a target, name or configuration key. Assignments, claims and subscriptions retain their recorded identity when the profile changes. Removed workers see nothing; their subscriptions are revoked on startup and refused at delivery. Migration 35 has the durable identity `s1v2-worker-facts-20261022`. An abandoned worker-isolation database without that identity is refused: restore its pre-isolation backup. The supported upgrade starts from schema version 34, including live claims and unsealed uploads. The base supported exactly one worker. Subject-bearing facts outside the deployment's allowed subjects become `unknown`, never worker.

### Repository access per worker

`workers.json` restricts each worker to exact GitHub repositories:

```json
{"workers":{"alpha":{"repos":["example-org/example-project","example-org/example-docs"]},"beta":{"repos":["example-org/example-project"]}}}
```

The owner CLI changes one worker's policy atomically and keeps its other profile fields:

```sh
dalan worker list
dalan worker list alpha --json
dalan worker allow alpha example-org/example-project
dalan worker deny alpha example-org/example-project
```

`repos` contains exact, case-insensitive `OWNER/REPO` entries only. A future repository under an allowed owner stays denied. `owner/*`, `repo_access: "any"`, `denied_repos`, and `--any` are rejected. An explicit empty list denies all repository jobs. Fresh omitted policies also deny all. Existing installations receive a one-time exact list from each worker's retained claims and jobs still queued and live under the service's expiry rules; the profile-less legacy worker stores it without creating a connection profile. Expired queued jobs do not add repositories. The migration journal and its audit commit together, and restarts never reseed. See [the upgrade migration](dalan-upgrade.md#preserve-historical-repositories-on-upgrade). Fresh profiles start with `repos: []`; use `dalan worker allow NAME OWNER/REPO` to grant each exact repository. `deny` on an already-denied repository is a no-op. List and doctor report exact lists; a missing profile reports whether a persisted exact policy exists or repository work is denied. Admission checks policy before fetch, and claims check the current policy again after resolution. Tightening blocks new admission and claims at once. Queued rows remain durable; already-valid grants may finish under unchanged lease, check, epoch and cancellation guards. No running work is forcibly cancelled or mutated.

`dalan worker list --json` includes the latest 20 retained changes from `workers-audit.jsonl`: event ID, timestamp, host operator UID, worker, and exact before/after lists. It reads at most the last 1 MiB of the append-only audit, plus the private one-time migration journal. If history is bounded, incomplete or unreadable, `change_count` is null and `changes_truncated` is true; current policy stays visible. Invalid history produces a diagnostic without echoing its contents. The UID is the host operator identity, separate from the OAuth worker identity. CLI edits write audit entries. A direct edit of `workers.json` is picked up at the next admission or claim check, and no grant applies without an audit record: when the bridge loads the file and finds a repository that its latest audit event does not list, it first appends an event marked `source: config-reconcile` and applies the grant only if that write succeeds (if the audit trail is unwritable or corrupt, the grant stays denied). Lists that predate the audit are recorded the same way once, so upgrades need no config edit. `dalan doctor` and `dalan worker list` report grants that have no audit record yet, and doctor also reports grants the bridge had to record itself, so you can confirm you meant them. Every writer of the audit (the bridge when it loads the file, and `worker allow` and `deny`) holds one lock, `workers-audit-checkpoint.sqlite` in the config directory, across its read, compare and append, so parallel loads write one event and a loader cannot record a list that a concurrent `deny` has since removed. That file also keeps a checkpoint of the audit log (byte length, SHA-256 and last event id), updated with each append. If `workers-audit.jsonl` is missing, shorter than the checkpoint, or its recorded prefix changed, the bridge fails closed: every grant without a matching event is denied, nothing is written, and `dalan doctor` and `dalan worker list` report that the audit log failed its checkpoint. To recover, review `workers.json`, then run `dalan worker allow NAME OWNER/REPO` for each grant you want; the first `allow` or `deny` drops from `workers.json` every grant the surviving audit does not list (it never adds one) and records the log as the new baseline. Only an install with no checkpoint at all (never audited) has its existing lists recorded once. The checkpoint stops accidental loss and one-sided tampering. A same-user actor who deletes both the checkpoint file and the log looks like a never-audited install; that actor can also rewrite `workers.json` and the queue, so the files are not tamper-proof against a compromised account. Known limit: the checkpoint does not stop a same-user actor from appending a forged event to the log together with a matching `workers.json` edit; such an event looks audited. Only a compromised operator account can do this, and that account can run `dalan worker allow` anyway. `worker allow` and `deny` first record any repository you added by hand as its own `config-reconcile` event, so the event for the command records only the repository you named. A repository grant is recorded in the audit before it takes effect; if the audit write fails, the grant is not applied. A removal takes effect first and reports a missing audit event with nonzero status; repeating a no-op edit does not create an event.

#### Legacy repository-policy migration

With the old service stopped, run the new build's `dalan worker migrate-repos --json`, `dalan doctor --json` and `dalan worker list --json` under the service HOME and environment. This reads retained claims and jobs still queued and live under the expiry rules, then publishes exact lists, including a repos-only list for worker without `workers.json`; it never invents connection bindings. Startup performs the same migration automatically. Explicit lists stay unchanged. `dalan worker allow NAME OWNER/REPO` and `deny` then edit the exact policy, including the profile-less worker's list, with an owner audit event. Keep `workers-repos.json` in the consistent config backup. A fresh installation without eligible history grants no repositories.


Repository work uses the bridge host's full GitHub credential through Git askpass. The worker policy does not narrow that credential. This is an accepted credential-boundary risk. Use a fine-grained, read-only `GH_TOKEN` limited to the union of allowed repositories; grant Contents: read and Pull requests: read only when pinned PR inputs need it. Assignment preparation fetches the exact base and optional head commits, including their histories and file contents. It does not refresh unrelated branches, tags or pull request refs. Existing cached refs remain available.

Switching a host from legacy mode to a `workers.json` profile retires every legacy subscription that has no verified persisted connection, including an old OAuth callback. The bridge suppresses that subscription's unsent wakes. The default worker must send a new authenticated `events/subscribe` request before it receives wake-ups again; a successful subscription replays still-queued work and records the approved connection. Check `dalan status --json`: after retirement, `subscriptions_active` is `0` and `subscription.state` is `revoked` (or `absent` if no row remains). The bridge does not create a replacement subscription. ChatGPT's MCP Events client is documented to refresh before a finite `refreshBefore`, but this early-retirement path has not been observed and that refresh may be days away. For immediate wake-ups, reconnect or refresh the default worker connector on the approved OAuth client to prompt `events/subscribe`, then confirm `subscriptions_active` is nonzero and `subscription.state` is `active`.

**Pre-isolation recovery backup.** Before upgrading a pre-isolation installation, stop every writer and follow the complete [worked backup and restore-check procedure](#upgrade-and-rollback). Keep that verified recovery set separately and label it with the installed version and date. Include the matching keys, configuration, receipts, artifact index and artifact bytes. Exclude both ownership-lock databases. Do not use a shorter directory-copy recipe: recovery from an abandoned worker-isolation schema requires a complete, compatible pre-upgrade set.

Upload IDs chosen by workers are request-scoped aliases. The server gives each upload a globally unique `id`; owner get, `/artifact` and the CLI artifact cache use only that ID. Existing worker IDs remain valid. Assignment error parity uses an absent-ID gate before validation and effects; it makes no timing-equivalence claim. Limitation: usage breaks are tracked only for the default worker. Break inference, ledgers and probe budgets are not per worker.

**Public-route gate.** When you move a legacy single-worker deployment to multiple workers, keep the public multi-vendor route closed until a real issuer revocation plus refresh/reissue test passes against the legacy build: a non-default-worker client's previously valid access token must fail, and refreshing or reissuing must not restore access. The legacy build cannot distinguish clients sharing a subject. Disabling a bridge mapping alone does not revoke a bearer token there. The test issuer in `worker-isolation-test.mjs` is a simulator: it proves local expiry and a simulated refusal to issue, not real issuer revocation, refresh invalidation or other clients' token state.

The retired pre-worker rollback procedure is retained in the [historical appendix](#historical-appendix-pre-worker-rollback). Current recovery uses compatible code or a reviewed complete backup restore as described under [Upgrade and rollback](#upgrade-and-rollback).

## Test

```sh
npm test
```

The fake-worker, durability, workspace, and OAuth tests use isolated temporary HOME directories and non-production ports. They do not send real T3 messages or use model API keys. Tests cover duplicate submit/claim/finish, owner receipt, watches, pause, cancellation, expiry and refresh, interrupted events, report persistence, ambiguous sends, transcript reconciliation, stopped threads, alert dedup, confined checks, patch/artifact transfer, OAuth rejection, and claim capacity. `DALAN_ALLOW_PRIVATE_WEBHOOKS=1` and `DALAN_T3_DRY_RUN=1` are test-only flags.

For each installation, validate worker claim and finish. If you enable signed events, T3 delivery or work-task accounting, validate those integrations separately.

## Protocol

[PROTOCOL.md](../PROTOCOL.md) defines the worker tools. OAuth authenticates the live worker connection, the six published implementation tool names and required input fields are unchanged, and `progress.blocker` is optional. The workspace gate requires OAuth mode and `DALAN_ENABLE_WORKSPACE=1`.

## GitHub workspaces

The bridge fetches repositories for workspace tools with the GitHub credential of the user that runs it. The sections below cover that credential, the owner submit command keys, and database upgrades at service start.

### Service GitHub access

The shell login used to clone this repository does not authenticate the generated service. The service runs with its own `HOME` and `PATH`; Git askpass calls `gh auth token` inside that environment. Give the service a separate GitHub CLI login in the private home selected by `worker-bridge-setup`. The setup script does not copy a caller's token.

Run the following as the same Unix user who runs the bridge.

For `dalan try`, first run `export DALAN_HOME=<trial home>` in this shell, with the trial home from the first line `try` printed. This shell's `PATH` must match the shell that launched `try`: `try` inherits the launching shell's `PATH`. If you installed `gh` or changed `PATH` afterward, restart `try` from the updated shell and reconnect your worker.

```sh
SERVICE_HOME="${DALAN_HOME:?Export DALAN_HOME as the trial home that try printed first}"
SERVICE_PATH="$PATH"
```

For a manual foreground server, use its `DALAN_HOME` and launching `PATH` in the same two assignments. For a generated service, use instead the `HOME` and `PATH` from `dot-bridge-NAME.service` (systemd) or the `EnvironmentVariables` in `<home>/Library/LaunchAgents/org.dalan.dot-bridge-NAME.plist` (launchd; `<home>` is the home of the user who ran setup, not the private bridge home):

```sh
SERVICE_HOME='/absolute/bridge/home'
SERVICE_PATH='/exact/service/path'
```

Run only the assignment pair for your setup, then:

```sh
umask 077
HOME="$SERVICE_HOME" PATH="$SERVICE_PATH" gh auth login
HOME="$SERVICE_HOME" PATH="$SERVICE_PATH" gh auth status
```

Choose GitHub.com and HTTPS. Status should identify the intended account and a successful login. Login uses the system credential store when available and otherwise a plaintext file; status shows which. A private `HOME` separates configuration but does not isolate a shared system credential store. Keep the bridge home owner-only. For organization-managed tokens, use the service manager's per-service secret mechanism, never a logged command or shared manager environment. Restart a generated service after credential changes. A restarted `try` replaces the worker connection, so reconnect and approve the worker again.

Worker repository policy is not a credential boundary: the bridge host credential can read any repository that credential permits, even though each worker is admitted only for exact repository grants. Prefer a fine-grained, read-only credential limited to the intended repositories. Grant Contents: read; add Pull requests: read only if pinned PR inputs need it. Set `dalan worker allow NAME OWNER/REPO` for each exact worker grant after its profile is ready.

If repository fetch reports that `gh` is missing, check the service's `PATH`. If it reports authentication failure, run `gh auth status` with the service `HOME` and `PATH`, then complete `gh auth login` in that same environment. These diagnostics do not print credential contents.

Each implementation request names a GitHub repository as `owner/name` and a full base commit SHA. The bridge uses the host's GitHub authentication to fetch that commit into a bare-mirror cache isolated by the resolved worker and a detached per-request worktree under `<home>/.tmp/dalan/worktrees/<request_id>`. A previously validated claim-bound workspace keeps its saved legacy common directory until it finishes; cleanup does not move or purge it while active. For configured workers, only exact repositories in that worker's `repos` list are eligible. A missing policy on a fresh host denies repository work; upgraded legacy hosts use their one-time exact history seed. `dalan worker list` reports the effective policy. Policy checks precede every fresh HTTP repository claim; an exact live retry of the holding grant is not re-checked, as a live grant may still finish after revocation. Queued rows stay durable and blocked. Existing valid grants may finish under unchanged lease, check, epoch and cancellation guards. The Git askpass still uses the full host `gh`/`GH_TOKEN` credential, which is not narrowed by this policy; a fine-grained read-only PAT limited to the allowed-repository union is recommended (Contents: read; Pull requests: read only when PR inputs require it). Clone URLs with embedded credentials are rejected, and the sandbox gets no GitHub token, `.git` data, host home, credential helpers, or sockets. A new revision needs a new request ID. The owner retrieves sealed evidence with `dalan get ID --json` then `dalan artifact ARTIFACT_ID --output PATH` (a new file in an existing directory). Artifacts are kept for 14 days. A finished job's worktree is removed after 6 hours, sooner once the owner has read the result or when disk space is low. The bridge never pushes, merges, or deploys.

Checks are detected from `package.json`, `pyproject.toml`/pytest, Cargo, Go, or a Makefile `test` target. Repository `.dalan.json` (or the legacy `.dot-bridge.json` fallback) describes checks and may tighten a budget; owner `<config>/dalan/checks.json` supplies the host command. `claim` and `get` add runnable `available_checks` only for implementation assignments when workspace tools are enabled; host jobs list only checks permitted by the owner allowlist and current owner definition. Worker and none jobs keep declared metadata for information, but do not claim that it can run on the host. Repository-backed `workspace_result` includes check discovery; without repository input it returns only `checks` and sealed `artifacts`. An eligible `run_check` with an unknown or unpermitted `check_id` returns a structured refusal without creating a check run or output artifact. With the host opt-in, exact owner allowlist pair and explicit owner budgets above, installation and checking share one offline, resource-contained execution copy, an isolated HOME and bounded output. The sandbox exposes an empty user systemd scope list; other `systemctl` operations fail without reaching the host bus. Isolated loopback works in the networkless phase. This repo's historical `default` check runs `npm run test:sandbox` but has no host budget or owner authorization. The full `npm test` suite includes `workspace-e2e.mjs`, which launches bubblewrap and cannot create a nested namespace inside the check sandbox; run it on the host. Local fake-JWKS and bubblewrap tests are in `scripts/auth-e2e.mjs` and `scripts/workspace-e2e.mjs`.

A check spec can also carry `prerequisites`, `readiness_argv` and `test_paths`; detected checks derive the first and last where they can (npm: the `engines.node` floor, `package-lock.json` when `npm ci` is used, and the files or directories the `test` script names; pnpm/yarn/uv/cargo/go/make: that binary; pytest `testpaths`; Cargo `tests`; Go `./...`), and an override may declare them: `"prerequisites": {"binaries": ["uv"], "lockfile": "uv.lock" | true, "runtime": "node>=24"}`, `"readiness_argv": [...]`, `"test_paths": ["tests"]`. Anything not derivable or declared is `null` with a `*_reason`, never an empty list. When an implementation request uses `execution=host`, the bridge reads this metadata at the pinned `base_sha` (a `git show` into a temp directory, no worktree) and checks the `default` check: each binary must exist in the host `/usr/bin` (the check sandbox ro-binds `/usr`, so host presence is the honest signal), the lockfile must exist at `base_sha`, and a `node>=N` runtime must hold for the running bridge process. A failure of an owner-authorized default check refuses admission with `BLOCKED: check prerequisites unmet: ...` (a blocking `check_prerequisites_unmet` defer) before any row is queued, so no claim is wasted. An unallowlisted default is still inspected, but unmet prerequisites are warnings; this keeps a separately selected owner-authorized check usable without granting the default. Unmet prerequisites of other checks also come back as warnings. `readiness_argv` is recorded as skipped at admission: running a repository-declared command needs the sandboxed checkout and is unsafe on the host. The submit response adds `check_readiness: {probed, warnings, skipped}`, and the owner-side `dalan get ID --json` adds `check_metadata`; host-mode `available_checks` includes only runnable owner-authorized checks. Unreadable host check metadata is classified as `check_metadata_unreadable`. For `execution=none` or `worker`, host probes are skipped and unreadable metadata does not block admission; the regression-test scope rule still applies in every execution mode.

`run_check` returns a completed receipt for a quick check or `{check_run_id,status:"running"}` after about 20 seconds. Retry the same `check_id` and diff while it runs to get the same ID; poll `workspace_result` or `get` for completion. A service restart marks an interrupted check as `interrupted`. Sealed `artifact_chunk` uploads work for any claimed assignment, including read-only assignments without a GitHub workspace; `workspace_result` and `get` list them, and only the assignment owner can download them.

Migration from the old project policy: remove `<config>/dalan/projects.json`; replace assignment `project_id` with `github_repo`, and keep the pinned `base_sha`. Put any fixed check override in `.dalan.json` or the host checks file. The old per-repository eligibility and local path map are no longer read.

`<config>/dalan/limits.json` (mode 0600) sets `max_claimed_outer_assignments`; the historical cap-1 example permits one outer claim. Capacity counts all active worker-scoped claims for that worker plus the caller's historical subject-scoped claims for the same worker. Legacy subject-scoped claims count only for their subject; worker-scoped claims share capacity across subjects. Mixed historical rows count according to their recorded `lane_scope` and `lane_key`. A fresh claim, or an expired-lease takeover, that would exceed the configured cap for those recorded lanes returns `capacity_full`; an exact live retry from the holding connection stays idempotent and is not re-judged against later destination or repository-policy changes (see [Claims and leases](#claims-and-leases)). Read the active cap from `dalan status --json`. `worker_lane_capacity` (integer 1..10, default 6) is the lane count that utilization metrics divide by; it does not limit claims (see docs/usage.md, "Lane utilization").

Fresh submissions enforce UTF-8 byte caps and explicit pinned repository scopes. The [submission policy](../PROTOCOL.md#submission-policy) defines sensitive exclusions and exact-path exceptions.

The [external dead-man monitor](deadman.md) is configured separately from the bridge service.

### Owner submit command keys

Local clients of `POST /submit` can set `command_key`, a nonempty string of at most 128 characters. The bridge stores its digest and the accepted submission intent in the same transaction as the job. Reuse the key and owner capability to recover the original submit decision after a dropped response or restart. Its `status` is the original submit status; use `get` for current job state. A changed intent returns `KEY_CONFLICT`. A different or omitted key on an already keyed job returns `EXISTS`. Keys are scoped to the job and owner; they are not credentials. Existing unkeyed jobs retain their current retries and cannot be adopted by adding a key. The CLI continues to use unkeyed submission.

### Starting the service and upgrading its database

Importing `src/server.mjs` defines `main()` without starting the service or creating files. Running `node src/server.mjs` validates auth and configuration before opening the service database. `Store` refuses to initialize or upgrade a default-home database unless the caller explicitly enables `allowDefaultHomeMigration`; service startup supplies that option. Current-version databases and nondefault test fixtures retain their existing behavior. This prevents accidental migrations by local tools; it does not restrict deliberate code running under the same Unix user.

## Historical appendix: pre-worker rollback

**Do not run this historical recipe against schema 65 or other current layouts.** It omits newer retained relationships, including `submit_supersedes`. For a current downgrade, stop the service and use matching code or a separately reviewed restore of a complete compatible pre-upgrade backup, preserving compatible newer positive-ACK evidence. Do not alter `user_version` or delete relationship data to force compatibility. The following is retained only as a historical reference for the pre-worker build.

Rollback discards non-default-worker rows from the serving database to prevent even known-ID reads by the old worker. The backup retains them. Run these steps in order; do not expose the old route before the issuer gate passes.

1. **Close the public route and revoke non-default-worker clients at the issuer.** End their sessions, revoke refresh credentials, and wait out access-token lifetimes if revocation is not immediate. Verify the real issuer gate above.
2. **Pause new claims.**

<!-- rollback-pause -->
```sh
dalan pause --reason "rollback to the pre-worker build"
```

3. **DRAIN uploads and claims.** Allow existing workers to seal their uploads and finish while paused, or abandon their claims (`dalan abandon ID --reason "rollback drain"`). An abandoned upload must be sealed before abandoning, or removed with its partial file by the operator after verifying it is no longer being written. Never roll back with an unsealed upload on a non-terminal request. Wait for checks to finish too, then stop the service. Its guards refuse any remaining live claim, running check or non-terminal unsealed upload. Terminal (`finished` or `cancelled`) requests may retain unsealed rows and partial files; these stay as they are and cannot be downloaded or finished as artifacts on the old build.
4. **Back up AFTER stop and drain.** Back up the DB, optional profile and artifact bytes together, with no service writing. Keep them until restore is no longer needed. Use the same workspace-root environment as the service and fresh backup destinations.

<!-- rollback-backup -->
```sh
bridge_data_root="$(dalan paths --data-root)" || exit 1
bridge_config_root="$(dalan paths --config-root)" || exit 1
sqlite3 -bail "${bridge_data_root}/bridge.db" ".backup '${bridge_data_root}/bridge.db.pre-rollback'"
if [ -f "${bridge_data_root}/delivery-acks.db" ]; then
  sqlite3 -bail "${bridge_data_root}/delivery-acks.db" ".backup '${bridge_data_root}/delivery-acks.db.pre-rollback'"
  chmod 600 "${bridge_data_root}/delivery-acks.db.pre-rollback"
fi
if [ -f "${bridge_config_root}/workers.json" ]; then
  cp -p "${bridge_config_root}/workers.json" "${bridge_config_root}/workers.json.pre-rollback"
fi
if [ -f "${bridge_config_root}/workers-repos.json" ]; then
  cp -p "${bridge_config_root}/workers-repos.json" "${bridge_config_root}/workers-repos.json.pre-rollback"
fi
bridge_workspace_root="$(dalan paths --workspace-root)" || exit 1
cp -a "${bridge_workspace_root}/artifacts" "${bridge_workspace_root}/artifacts.pre-rollback"
```

5. **Save this SQL as `rollback.sql`.** It runs as one transaction. Foreign-key checks stay enabled. Only the globally unique artifact key remains; the old build can safely update and delete by ID. Usage tables are restored to the old build's subject keys; only worker usage is retained in the serving copy.

<!-- rollback-sql -->
```sql
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
CREATE TEMP TABLE rollback_guard (remaining INTEGER CHECK(remaining=0));
INSERT INTO rollback_guard SELECT count(*) FROM artifacts r JOIN assignments a USING(request_id) WHERE r.sealed=0 AND a.status NOT IN ('finished','cancelled');
INSERT INTO rollback_guard SELECT count(*) FROM claims c JOIN assignments a USING(request_id) WHERE c.state='active' AND a.status='claimed';
INSERT INTO rollback_guard SELECT count(*) FROM check_jobs WHERE status='running';
CREATE TEMP TABLE removed_requests AS SELECT request_id FROM assignments WHERE target_worker<>'dot';
DROP TRIGGER owner_notes_no_delete;
DROP TRIGGER lifecycle_events_no_delete;
DELETE FROM notifications WHERE request_id IN removed_requests OR subscription_id IN (SELECT id FROM subscriptions WHERE worker<>'dot') OR message_id IN (SELECT message_id FROM messages WHERE target_worker<>'dot');
DELETE FROM assignment_reannouncements WHERE request_id IN removed_requests OR subscription_id IN (SELECT id FROM subscriptions WHERE worker<>'dot');
DELETE FROM subscriptions WHERE worker<>'dot';
DELETE FROM messages WHERE target_worker<>'dot';
DELETE FROM watches WHERE request_id IN removed_requests;
DELETE FROM pr_preflights WHERE request_id IN removed_requests;
DELETE FROM assignment_delivery_mutes WHERE request_id IN removed_requests;
DELETE FROM owner_notes WHERE request_id IN removed_requests;
DELETE FROM progress WHERE request_id IN removed_requests;
DELETE FROM reports WHERE request_id IN removed_requests;
DELETE FROM workspaces WHERE request_id IN removed_requests;
DELETE FROM artifacts WHERE request_id IN removed_requests;
DELETE FROM check_jobs WHERE request_id IN removed_requests;
DELETE FROM check_runs WHERE request_id IN removed_requests;
DELETE FROM claims WHERE request_id IN removed_requests;
DELETE FROM claim_denials WHERE request_id IN removed_requests OR reported_in IN removed_requests;
DELETE FROM lifecycle_events WHERE request_id IN removed_requests;
DELETE FROM assignments WHERE request_id IN removed_requests;
CREATE TRIGGER owner_notes_no_delete BEFORE DELETE ON owner_notes BEGIN SELECT RAISE(ABORT,'owner notes are append-only'); END;
CREATE TRIGGER lifecycle_events_no_delete BEFORE DELETE ON lifecycle_events WHEN NOT EXISTS(SELECT 1 FROM lifecycle_retention WHERE id=1 AND cutoff IS NOT NULL AND old.at<cutoff) BEGIN SELECT RAISE(ABORT,'lifecycle events are append-only'); END;
CREATE TABLE worker_activity_old (subject TEXT PRIMARY KEY,last_call_at TEXT NOT NULL,last_list_pending_at TEXT);
INSERT INTO worker_activity_old SELECT subject,last_call_at,last_list_pending_at FROM worker_activity WHERE worker='dot';
DROP TABLE worker_activity;
ALTER TABLE worker_activity_old RENAME TO worker_activity;
CREATE TABLE worker_calls_old (subject TEXT NOT NULL,minute INTEGER NOT NULL,tool TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,bytes INTEGER,PRIMARY KEY(subject,minute,tool));
INSERT INTO worker_calls_old SELECT subject,minute,tool,count,bytes FROM worker_calls WHERE worker='dot';
DROP TABLE worker_calls;
ALTER TABLE worker_calls_old RENAME TO worker_calls;
CREATE INDEX worker_calls_minute ON worker_calls(minute);
DELETE FROM schema_migrations WHERE identity='s1v2-worker-facts-20261022';
ALTER TABLE worker_breaks RENAME TO dot_breaks;
DROP INDEX worker_breaks_one_active;
CREATE UNIQUE INDEX dot_breaks_one_active ON dot_breaks(COALESCE(until,'')) WHERE until IS NULL;
ALTER TABLE assignments RENAME COLUMN skipped_at TO skipped_by_dot_at;
COMMIT;
```

<!-- rollback-apply -->
```sh
bridge_data_root="$(dalan paths --data-root)" || exit 1
bridge_config_root="$(dalan paths --config-root)" || exit 1
sqlite3 -bail "${bridge_data_root}/bridge.db" < rollback.sql
```

6. **Remove the profile, install the old build and start it.** Keep the public route closed until the real issuer gate passes. Then resume:

<!-- rollback-resume -->
```sh
dalan resume
```

**Restore.** Stop the old service first. Restore the DB, profile and configured workspace artifact bytes, then install the new build. Retain compatible newer ACK proof; the recipe restores the ACK backup only when the current ledger is missing. Verify any existing ledger's compatibility before starting. If it is incompatible, choose compatible code or follow the explicit ACK-loss risk described under [Upgrade and rollback](#upgrade-and-rollback); do not silently replace it with older proof. Re-enable clients at the issuer only after verification. The new build refuses the rolled-back DB. Restoring the backup is the only roll-forward path, and it discards ALL work done on the old build after rollback, including uploads, claim changes and reports. The backup preserves the rollback pause: after verification, run `dalan resume` to accept claims again.

<!-- rollback-restore -->
```sh
bridge_data_root="$(dalan paths --data-root)" || exit 1
bridge_config_root="$(dalan paths --config-root)" || exit 1
cp -p "${bridge_data_root}/bridge.db.pre-rollback" "${bridge_data_root}/bridge.db"
rm -f "${bridge_data_root}/bridge.db-wal" "${bridge_data_root}/bridge.db-shm"
if [ ! -f "${bridge_data_root}/delivery-acks.db" ] && [ -f "${bridge_data_root}/delivery-acks.db.pre-rollback" ]; then
  cp -p "${bridge_data_root}/delivery-acks.db.pre-rollback" "${bridge_data_root}/delivery-acks.db"
fi
if [ -f "${bridge_config_root}/workers.json.pre-rollback" ]; then
  cp -p "${bridge_config_root}/workers.json.pre-rollback" "${bridge_config_root}/workers.json"
else
  rm -f "${bridge_config_root}/workers.json"
fi
if [ -f "${bridge_config_root}/workers-repos.json.pre-rollback" ]; then
  cp -p "${bridge_config_root}/workers-repos.json.pre-rollback" "${bridge_config_root}/workers-repos.json"
else
  rm -f "${bridge_config_root}/workers-repos.json"
fi
bridge_workspace_root="$(dalan paths --workspace-root)" || exit 1
rm -rf "${bridge_workspace_root}/artifacts"
cp -a "${bridge_workspace_root}/artifacts.pre-rollback" "${bridge_workspace_root}/artifacts"
```
