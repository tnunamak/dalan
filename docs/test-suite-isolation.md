# Test-suite resource census

The ordered commands in `scripts/test-segments.json` are the audit boundary. The suite owns mutable state below private, randomly allocated roots. Tests may allocate more private children. Code, installed dependencies, system binaries, and kernel metadata remain shared read-only inputs. Real systemd checks share the user manager but use a distinct unit name per suite.

## Confirmed failures

| Failure | Shared resource or race | Correction and evidence |
| --- | --- | --- |
| `persistent-setup-test.mjs`, `install-inbox-test.mjs` | The setup mutex defaults to one lock per Unix user (`scripts/worker-bridge-setup.mjs:198`, `:918`). Separate HOME/TMPDIR values do not relocate that default. | The runner exports one private `DALAN_SETUP_LOCK_DIR` to every segment (`scripts/test-segments.mjs:32`). Two concurrent unmodified persistent fixtures produced one pass and one lock failure; both passed with separate overrides. |
| Both verifier segments, filter-safety, worktree-filter-context | The integrator's restricted child environment omitted `DALAN_HOST_CHECK_UNIT_SUFFIX`, so every suite's child used the fixed production unit (`src/integrator.mjs:132`). | Forward that existing seam only from non-production test invocations; the restricted test child is explicitly test-mode. A production-mode child ignores an inherited suffix and uses the fixed service name. Two verifier copies with different parent suffixes reproduced one failure before forwarding; both passed afterward. |
| Optional host regrant journey | Its conformance adapter also constructs an environment explicitly (`scripts/conformance/adapter-dot-bridge.mjs:141`). | Preserve the suite suffix there too. This optional journey currently refuses before its host check because the fixture has no worker repository policy; that independent refusal was not changed. |
| Host-budget production-name regression | The regression itself temporarily unset the suffix and started the shared production unit (`scripts/host-budgets-test.mjs:162`). | Intercept systemd spawn to assert the exact unsuffixed argument. Real concurrent admission/cancellation tests use only suite-owned units (`scripts/host-budgets-test.mjs:184`). Production still defaults to one active envelope per user. |
| `workspace-policy-held-claim-e2e.mjs` | This is an intra-fixture race: its own lease sweeper may abandon the expired claim before cleanup calls `abandon` again (`scripts/workspace-policy-held-claim-e2e.mjs:128`, `src/store.mjs:2710`). | Force the real sweep before cleanup and cancel the fixture request, which accepts queued or claimed state. The forced-sweep control failed with “no active claim” before this change and passed after it. The SIGTERM log is the fixture's own finally cleanup (`:49`). |

Two concurrent seven-segment reproductions covered persistent setup, inbox installation, both verifier entries, both filter fixtures, and the held-claim workspace fixture. Both reported seven passes and no skips.

The first full pair also exposed a budget-result ordering race: the outer supervisor can report CPU exhaustion, then its child sees EOF and reports an interruption. `src/host-budget.mjs` now remembers the observed CPU violation while retaining later usage and phase details. A synthetic trusted-pipe regression (`scripts/host-budgets-test.mjs`) fails before this change and passes afterward. Kernel limits and production reservation behavior are unchanged.

## Resource ownership

| Resource | Access sites | Isolation / shared-read contract |
| --- | --- | --- |
| Home scratch, databases, receipts, repo caches, owner configuration, downloads | `src/paths.mjs`; all home call sites indexed below; integrator fixtures at `scripts/integrator-verifier-test.mjs:12`, `integrator-filter-safety-test.mjs:12`, `integrator-worktree-filter-context-test.mjs:12` | Runner allocates a private HOME below the original home scratch directory and pre-creates its `.tmp` (`scripts/test-segments.mjs:28`). Keeping HOME outside `/tmp` preserves prepared-cache ancestor checks; temporary files and sockets still use a short TMPDIR. Explicit fixture HOMEs are already random children. No fixture writes the operator's real HOME. |
| XDG config/data/state/cache | `scripts/worker-bridge-setup.mjs:228`, `src/test-support/fixture-env.mjs:10` | Runner clears inherited XDG base-directory overrides so defaults follow each fixture's HOME (`scripts/test-segments.mjs:38`). Helpers that set explicit XDG directories put them under their private fixture HOME. |
| Temporary files, SQLite files, Unix admin sockets | `src/admin-socket.mjs`; `scripts/mcp-schema-conformance-test.mjs:21`; `scripts/test-segments.mjs:30` | Suite-private TMPDIR and DOT_BRIDGE_TEST_TMP; fixture mkdtemp children. Short roots keep socket addresses within the platform limit. Schema fixture's long-path fallback also uses mkdtemp, never a fixed socket leaf. |
| Setup SQLite mutex | `scripts/worker-bridge-setup.mjs:198`, `:918`; `scripts/persistent-setup-test.mjs:300` | One suite-private override directory. Tests of a specific lock use their own fixture directory. Production's per-user default is unchanged. |
| systemd units / cgroups / host-stop records | `src/host-budget.mjs:79`, `src/host-stop-reverify.mjs:37`; `scripts/host-budgets-test.mjs`; `scripts/require-integrator-host-budget.mjs:16` | Suite unit suffix is retained through non-production test child environments. Production-mode host checks always use the fixed unit name, even if a test suffix is inherited. Cleanup and re-verification address the unit from that run's receipt. Unsuffixed naming is tested with spawn interception, never a live shared unit. |
| User systemd bus and runtime directory | `src/integrator.mjs:135`; `scripts/regrant-effects-e2e.mjs:117` | XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS remain host inputs so real kernel-budget checks can run. The manager is shared; every mutable unit/cgroup/receipt is owned by one suite. No global stop or unit enumeration assertion is used. |
| npm cache and user configuration | `scripts/test-segments.mjs:33`; `src/prepared-node-modules.mjs:103` | Runner redirects npm_config_cache. User configuration defaults follow private HOME. Installed dependency files are immutable test inputs; fixture package operations use private repositories. |
| Git repositories, refs, worktrees, hooks, filter configuration | `src/integrator.mjs:86`; `scripts/integrator-worktree-filter-context-test.mjs:72`; `scripts/mirror-fetch-test.mjs:18` | Mutable repositories and worktrees live below private fixture roots. Source checkout and its Git metadata are read inputs. GIT_CONFIG_GLOBAL defaults to `/dev/null` (`scripts/test-segments.mjs:24`); an explicit caller override is an intentional read input. The mirror canaries at `scripts/mirror-fetch-test.mjs:133` now read suite HOME. |
| TCP listeners and OAuth issuer URLs | `src/test-support/port.mjs:11`, `:38`; `scripts/builtin-as-e2e.mjs:119`; `scripts/workspace-policy-held-claim-e2e.mjs:30` | Servers bind 0 and read the actual bound port, or retry the complete configured startup after EADDRINUSE. The production trial searches a range and retries bind failures; shutdown assertions inspect the fixture's private admin socket (`scripts/dalan-try-test.mjs:74`). |
| Fixed setup ports such as 18792 and 18805 | `scripts/persistent-setup-test.mjs:49`, `:302`; `scripts/install-inbox-test.mjs:154` | These are generated configuration / negative assertion data. Fake systemctl and launchctl never execute the generated server command (`scripts/persistent-setup-test.mjs:20`, `:377`). Setup invokes only `dalan init` (`scripts/worker-bridge-setup.mjs:355`), so these ports are not bound. |
| PIDs, process groups, kill markers | `scripts/test-segments.mjs:42`; `scripts/host-budgets-test.mjs:125`; `scripts/conformance/adapter-dot-bridge.mjs:167` | OS-assigned IDs, owned child handles/groups, or random marker strings. Fault injection targets only that fixture's processes; no pkill/killall or shared tmux server is used. |
| OS account home, binaries, `/proc`, `/sys/fs/cgroup`, libraries | `scripts/worker-bridge-setup.mjs:89`; `scripts/require-host-sandbox.mjs:10`; `scripts/host-budgets-test.mjs:146` | Shared identity/read-only readiness, process or sandbox-security inputs. Account lookup is used for safety checks; setup tests name explicit fixture homes. Cgroup mutations belong to the suite-specific systemd unit. Denied paths in `scripts/workspace-e2e.mjs:20` are sandbox test inputs. |
| External routes, catalogs, workers, service managers | `src/test-support/gozar-fake.mjs`; `src/test-support/public-host-fetch.mjs`; `scripts/persistent-setup-test.mjs:20` | Ordinary suite uses local fake providers, loopback fixtures, and service-manager shims. Live/archived journeys remain opt-in and explicitly skipped when not configured. No live bridge/catalog mutation is part of this proof. |

Signal handlers and final cleanup are registered before suite allocation. The suite HOME and temporary root are removed only after the active segment's process group has settled, including handled interrupts. If stop confirmation fails, the runner retains HOME, TMPDIR, setup-lock state and skip reports, then prints `SUITE ROOTS RETAINED` with their paths, the process group, and observable surviving PIDs. Stop only those owned processes and confirm their exit before deleting the retained roots. A SIGKILL cannot run finally cleanup; the caller must track and remove both owned roots afterward.

## Home-access census index

This is a conservative source inventory of every explicit `homedir()` and `userInfo()` call in scripts and first-party source (including optional/manual helpers). The runner's private HOME covers homedir defaults; account-home lookups remain read-only safety checks. Generated paths, mock strings, and guest denial probes do not mean the host path is written. The table above records the runtime classification rather than treating every literal as a listener or mutable shared file.

| File | Lines |
| --- | --- |
| `scripts/acp-prose-check-test.mjs` | 10, 109 |
| `scripts/adapter-conformance-test.mjs` | 19, 20 |
| `scripts/admission-measure-test.mjs` | 8 |
| `scripts/admission-measure.mjs` | 84 |
| `scripts/answer-journal-e2e.mjs` | 20, 23 |
| `scripts/as-encrypted-storage-test.mjs` | 8 |
| `scripts/as-key-publication-test.mjs` | 26 |
| `scripts/auth-repository-security-test.mjs` | 15 |
| `scripts/backup-recipe-test.mjs` | 28 |
| `scripts/builtin-as-code-lifetime-test.mjs` | 12 |
| `scripts/builtin-as-complete-crash-test.mjs` | 14 |
| `scripts/builtin-as-e2e.mjs` | 25 |
| `scripts/builtin-as-exposure-test.mjs` | 15 |
| `scripts/builtin-as-owner-test.mjs` | 52 |
| `scripts/builtin-as-race-test.mjs` | 14 |
| `scripts/builtin-as-static-client-test.mjs` | 15 |
| `scripts/builtin-claim-admission-e2e.mjs` | 15 |
| `scripts/catalog-v2-test.mjs` | 12 |
| `scripts/check-readiness-lifecycle-test.mjs` | 9 |
| `scripts/child-registry-inspection-test.mjs` | 8 |
| `scripts/claim-binding-followups-e2e.mjs` | 19 |
| `scripts/claim-expiry-guidance-test.mjs` | 6 |
| `scripts/claim-fence-await-race-e2e.mjs` | 23 |
| `scripts/claim-metadata-redaction-test.mjs` | 32 |
| `scripts/claim-statechart-fixture.mjs` | 7 |
| `scripts/cleanup-nonblocking-e2e.mjs` | 11 |
| `scripts/conformance/adapter-dot-bridge.mjs` | 109, 110 |
| `scripts/conformance/native-authority-test.mjs` | 22 |
| `scripts/conformance/service-bootstrap.mjs` | 6 |
| `scripts/daily-selfcheck.mjs` | 26 |
| `scripts/dalan-mcp-test.mjs` | 17 |
| `scripts/dalan-setup-test.mjs` | 13 |
| `scripts/dalan-try-hosted-test.mjs` | 30 |
| `scripts/dalan-try-test.mjs` | 21 |
| `scripts/deadman-publication-crash-test.mjs` | 9 |
| `scripts/deadman-readonly-status-test.mjs` | 10 |
| `scripts/doctor-auth-test.mjs` | 15 |
| `scripts/generic-client-journey-e2e.mjs` | 16 |
| `scripts/generic-profile-test.mjs` | 12 |
| `scripts/gozar-migration-e2e.mjs` | 21 |
| `scripts/gozar-route-contract-test.mjs` | 21 |
| `scripts/host-budget-cpu-readback-test.mjs` | 7 |
| `scripts/host-check-allowlist-http-test.mjs` | 17 |
| `scripts/host-receipt-publication-crash-test.mjs` | 8 |
| `scripts/host-recovery-live-test.mjs` | 12 |
| `scripts/host-recovery-test.mjs` | 8 |
| `scripts/host-stop-path-audit-test.mjs` | 14 |
| `scripts/host-stop-reverify-test.mjs` | 10 |
| `scripts/inbox-e2e.mjs` | 16 |
| `scripts/install-gate-test.mjs` | 10 |
| `scripts/integrator-attempt-trace-test.mjs` | 12 |
| `scripts/integrator-check-input-test.mjs` | 10 |
| `scripts/integrator-filter-safety-test.mjs` | 12 |
| `scripts/integrator-policy-rejection-test.mjs` | 11 |
| `scripts/integrator-safety-test.mjs` | 14, 15 |
| `scripts/integrator-verifier-test.mjs` | 13 |
| `scripts/integrator-worktree-filter-context-test.mjs` | 12 |
| `scripts/lease-deadline-clock-origin-test.mjs` | 10 |
| `scripts/lease-deadline-restart-test.mjs` | 8 |
| `scripts/lease-migrated-null-deadline-test.mjs` | 7 |
| `scripts/legacy-acquisition-guidance-test.mjs` | 12 |
| `scripts/legacy-init-start-test.mjs` | 12 |
| `scripts/live-trial/common.mjs` | 271 |
| `scripts/live-trial/dry-run.mjs` | 27, 106, 108 |
| `scripts/live-trial/setup.mjs` | 65 |
| `scripts/live-trial/teardown.mjs` | 93, 99, 172 |
| `scripts/maintenance-liveness-test.mjs` | 13 |
| `scripts/mcp-outcome-e2e.mjs` | 14 |
| `scripts/mcp-sse-idle-test.mjs` | 17 |
| `scripts/message-e2e.mjs` | 14 |
| `scripts/mirror-fetch-test.mjs` | 18, 133 |
| `scripts/neutral-schema-upgrade-test.mjs` | 15 |
| `scripts/neutral-worker-e2e.mjs` | 24 |
| `scripts/notify-ledger-admin-test.mjs` | 10 |
| `scripts/notify-ledger-crash-test.mjs` | 17 |
| `scripts/notify-ledger-reconcile-test.mjs` | 11 |
| `scripts/one-bridge-workers-e2e.mjs` | 16 |
| `scripts/outcomes.mjs` | 4 |
| `scripts/owner-report-artifact-e2e.mjs` | 163 |
| `scripts/patch-apply-default-test.mjs` | 10 |
| `scripts/patch-apply-path-spaces-test.mjs` | 11 |
| `scripts/pause-claim-hint-test.mjs` | 11 |
| `scripts/pinned-repository-fetch-test.mjs` | 8 |
| `scripts/prepared-dependencies-host-test.mjs` | 20 |
| `scripts/prepared-node-modules-test.mjs` | 8 |
| `scripts/prose-inspection-cleanup-test.mjs` | 9 |
| `scripts/protocol-retention-break-alert-test.mjs` | 8 |
| `scripts/protocol-scheduler-test.mjs` | 7 |
| `scripts/pull-queue-destination-test.mjs` | 8 |
| `scripts/pull-queue-test.mjs` | 13 |
| `scripts/queue-wait-perf-test.mjs` | 8 |
| `scripts/redaction-matrix-test.mjs` | 82 |
| `scripts/registry-e2e.mjs` | 14 |
| `scripts/regrant-effects-e2e.mjs` | 12 |
| `scripts/regrant-waiter-fencing-test.mjs` | 32 |
| `scripts/remote-loopback-callback-test.mjs` | 47, 56 |
| `scripts/route-setup-discard-test.mjs` | 10 |
| `scripts/sandbox-probe-e2e.mjs` | 27 |
| `scripts/sandbox-source-exemption-test.mjs` | 10 |
| `scripts/schema-fixture-guard-test.mjs` | 10 |
| `scripts/scope-names-e2e.mjs` | 15 |
| `scripts/secret-sinks-redaction-test.mjs` | 156, 178, 362, 386, 473, 501, 620 |
| `scripts/service-auto-update-test.mjs` | 12 |
| `scripts/service-install-test.mjs` | 13 |
| `scripts/service-legacy-probe-test.mjs` | 11 |
| `scripts/service-migrate-workers-test.mjs` | 11, 12 |
| `scripts/service-one-command-test.mjs` | 21 |
| `scripts/service-update-gate-test.mjs` | 13 |
| `scripts/service-update-journey-test.mjs` | 14 |
| `scripts/service-update-runtime-test.mjs` | 12 |
| `scripts/shutdown-signal-log-test.mjs` | 12 |
| `scripts/signal-endpoint-test.mjs` | 16 |
| `scripts/subscription-storage-test.mjs` | 31 |
| `scripts/t3-scope-e2e.mjs` | 13 |
| `scripts/t3-tools-e2e.mjs` | 14 |
| `scripts/t3-top-level-tools-noref-test.mjs` | 17 |
| `scripts/t3-top-level-tools-test.mjs` | 25 |
| `scripts/t3-wake-fence-e2e.mjs` | 20 |
| `scripts/test-ntfy-alert.mjs` | 3 |
| `scripts/test-segments-test.mjs` | 11, 106 |
| `scripts/test-segments.mjs` | 35 |
| `scripts/tool-registry-admission-test.mjs` | 11 |
| `scripts/tool-registry-test.mjs` | 14 |
| `scripts/tool-scheme-scopes-e2e.mjs` | 16 |
| `scripts/upgrade-release-fixture-test.mjs` | 20, 79 |
| `scripts/work-order-e2e.mjs` | 14 |
| `scripts/work-order-test.mjs` | 6 |
| `scripts/worker-bridge-setup.mjs` | 89, 105, 228, 231, 758 |
| `scripts/worker-isolation-test.mjs` | 22 |
| `scripts/worker-route-reference-test.mjs` | 54 |
| `scripts/worker-repo-cache-test.mjs` | 7 |
| `scripts/worker-repo-policy-e2e.mjs` | 14 |
| `scripts/workspace-disk-test.mjs` | 8 |
| `scripts/workspace-inspection-cleanup-test.mjs` | 7 |
| `scripts/workspace-nosandbox-e2e.mjs` | 22 |
| `src/acp-bridge.mjs` | 26, 264 |
| `src/alerts.mjs` | 11 |
| `src/auth.mjs` | 10 |
| `src/child-registry.mjs` | 10 |
| `src/connect-cli.mjs` | 114 |
| `src/default-home.mjs` | 9, 36 |
| `src/gozar-routes.mjs` | 46 |
| `src/host-check-allowlist.mjs` | 6 |
| `src/integrator.mjs` | 19 |
| `src/limits.mjs` | 8, 16, 25 |
| `src/paths.mjs` | 52, 56 |
| `src/pr-head-reviewer.mjs` | 15 |
| `src/prepared-node-modules.mjs` | 10 |
| `src/projects.mjs` | 15, 90 |
| `src/route-setting.mjs` | 14 |
| `src/server.mjs` | 57 |
| `src/service-launchd.mjs` | 23 |
| `src/service-update-gate.mjs` | 9 |
| `src/service-update-runtime.mjs` | 250 |
| `src/service-update.mjs` | 118 |
| `src/service.mjs` | 109, 347, 403 |
| `src/store.mjs` | 149, 252, 253 |
| `src/submission-policy.mjs` | 101 |
| `src/t3-transport.mjs` | 30 |
| `src/try-hosted.mjs` | 109 |
| `src/try.mjs` | 55, 84, 271 |
| `src/workers.mjs` | 170, 179 |
