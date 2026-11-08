# Dalan setup reference

Use this page after the [README](../README.md) first-job path works. It lists server settings, requester commands, worker tools and legacy service files. The npm package is `@tnunamak/dalan` and the CLI command is `dalan`; the command names of the `dot-bridge` package are not installed.

## Environment and storage

Set server variables in the process or service environment, then restart the bridge. Only the `dalan` command reads `DALAN_HOME`; it does not replace the server's `HOME`.

| Setting | Effect |
|---|---|
| `HOME` | Selects the bridge's private configuration, state and requester receipts. The server and requester must use the same home. |
| `DALAN_HOME` | The `dalan` command uses this directory as its `HOME`, so it reads the home of a server started with that `HOME`. `dalan try` uses it as the default trial home. |
| `DALAN_AUTH_MODE=builtin` | Uses the built-in OAuth authorization server. `oauth` selects an external issuer instead. |
| `DALAN_LOOPBACK=1` | Runs authenticated HTTP on loopback only. Requires `DALAN_AUTH_MODE=builtin` and a fixed `DALAN_PORT`; the public URL must be `http://127.0.0.1:<port>`. |
| `DALAN_PORT` | Sets the HTTP listener port; the server default is 8787. |
| `DALAN_ENABLE_WORKSPACE=1` | Enables repository and artifact tools. It does not authorize host checks. |
| `DALAN_TEST_OAUTH=1` | Allows HTTP for the existing isolated OAuth trial when `NODE_ENV` is not `production`. This is not a production setting. |
| `DALAN_DEV_ALLOW_UNAUTHENTICATED=1` | Allows the public route to run unauthenticated when `NODE_ENV` is not `production`, but only on a loopback bind (`DALAN_BIND_HOST=127.0.0.1`, `::1` or `localhost`); on a non-loopback bind the server refuses to start. For non-production fixtures only. |
| `DALAN_ALLOW_INSECURE_PUBLIC=1` | Same loopback-only unauthenticated allowance; it never bypasses the TLS reverse proxy requirement on a non-loopback bind. For non-production fixtures only. |
| `DALAN_CATALOG_PROFILE` | Selects `stable` by default, or an opt-in `questions-v1`, `protocol-v0` or compatibility `legacy-v46` catalog. Review the protocol before changing it. |

The corresponding old `DOT_BRIDGE_*` environment names remain readable for compatibility. Existing storage paths such as `.config/dot-bridge` are technical compatibility names, not worker identities. Startup never moves or merges data. To change roots, stop every component and follow the [explicit path migration](dalan-upgrade.md#existing-homes-and-explicit-path-migration) steps; do not rename state directories ad hoc. A service setup writes its private resource URL to `<bridge home>/resource-url`; manual init creates the OAuth files and the server creates the secret path configuration.

## Requester commands

The table lists the common commands. Run `dalan help --all` to see every command. Export `DALAN_HOME` in each shell, so that every command reads the same home and private receipts.

| Command | Result |
|---|---|
| `dalan status --explain` | Explains queue depth and active claims. |
| `dalan doctor --json` | Reports local execution readiness and configuration warnings. |
| `dalan submit --worker NAME --execution none --deliver none --file job.json --json` | Queues a job without requesting host checks or automatic owner delivery. |
| `dalan wait REQUEST_ID` | Waits for completion, a question, a blocker, cancellation or timeout. The default timeout is 300 seconds. |
| `dalan get REQUEST_ID --json` | Reads progress, report, artifacts and evidence; marks the result read. |
| `dalan inbox --all --json` | Finds receipts across requester sessions without marking results read. Covers the last 72 hours unless you pass `--since`. |
| `dalan note REQUEST_ID "text"` | Appends a job-specific message. |
| `dalan questions REQUEST_ID --json` | Lists identified questions when the selected catalog supports them. |
| `dalan answer REQUEST_ID QUESTION_ID "text"` | Answers an identified question; an ordinary note does not answer it. |
| `dalan artifact ARTIFACT_ID --output PATH` | Downloads a sealed artifact after get or wait records its owning request. PATH must not exist; its directory must. |
| `dalan decide REQUEST_ID accepted` | Records a review decision. Other choices are `applied`, `useful_no_change`, `useful_negative` and `not_useful`. |
| `dalan apply REQUEST_ID --dir CHECKOUT` | Verifies and applies a returned patch, then records `applied`. |
| `dalan cancel REQUEST_ID` | Withdraws a job. It does not prove that worker compute has stopped. |
| `dalan worker list NAME --json` | Shows a worker's exact repository grants and retained policy changes. |

Wait exits with 0 for a finished job, 1 for a command or transport error, 3 for a question or blocker, 4 for cancellation, 5 for a usage break, or 124 for timeout. Its summary need not contain the full report; use get before deciding.

A fresh shell with no session ID lists receipts across this bridge home. A resumed requester may have a different session label: use `dalan inbox --producer SAVED_ID --json` for the saved label, or `--all` to recover without it.

<a id="callback-patterns"></a>

## Callback patterns

`dalan connect allow-callback PATTERN` and `dalan try --callback PATTERN` take a pattern for the OAuth callback URI of a worker client. Allow the narrowest pattern for the client: its exact host and path. A callback pattern follows these rules:

- A loopback pattern is `http://HOST/PATH` with no port. It admits that exact host and path on any port. `127.0.0.1`, `localhost` and `[::1]` are the only HTTP hosts allowed, and `127.0.0.1` does not match `localhost`.
- An HTTPS pattern is `https://HOST[:PORT]/PATH`. Scheme, host and port match exactly. In the path, a whole `*` segment stands for one segment of letters, digits, `_` and `-`; use it only for a callback with a varying segment.
- A pattern may not contain a query or fragment, and a callback URI that has one never matches.

## Worker tools and optional authority

The [protocol](../PROTOCOL.md) defines the full tool list, inputs, outputs, catalogs and lease behavior. The worker uses `list_pending`, `claim`, `progress` and `finish` for the basic job lifecycle. Repository tools require a workspace grant and respect the job's pinned revision and paths.

T3 reverse control is opt-in. Its thread tools and `notify_owner` act outside a job claim. Review [T3 authority and audit](t3-reverse-control.md) before granting it. A worker does not need T3 to finish an ordinary job. The six `t3_thread_*` tools (`list`, `read` and `wait`, which read, and `create`, `send` and `set`, which start turns, send messages and change thread settings) are off unless the operator sets `DALAN_ENABLE_T3_TOOLS=1`, and then only a worker whose profile has the `t3` capability can call them. A fresh `dalan init` profile has no `t3` capability. The legacy `dot` profile, used when the workers file does not exist, has it. Granting it gives that worker the owner's full authority over every thread on the local T3: it can read, start, message and reconfigure any thread, because the bridge does not check which thread the caller owns. Cancelling a job does not revoke it. Grant it only to a fully trusted worker.

For upgrades, use the [changelog](../CHANGELOG.md) and [operations procedure](operations.md#upgrade-and-rollback). Package versions, database schema numbers and worker catalogs have different compatibility boundaries; replacing an executable is not a rollback of migrated state.

## Legacy service examples

The `dot-bridge.service`, `dot-bridge-selfcheck.service` and `dot-bridge-selfcheck.timer` examples are in `systemd/`. Keep these filenames when installing them for an existing deployment so service dependencies and timer targets still resolve. The legacy templates retain their original checkout default for compatibility. Set each example's `WorkingDirectory` to the deployed checkout and set `PATH` to a Node.js 24 installation before installing it. Units installed as copies, and drop-ins, do not need to change. A unit installed as a symbolic link to `dot-bridge.service`, `dot-bridge-selfcheck.service` or `dot-bridge-selfcheck.timer` in the repository root breaks when you update the checkout, because 0.5.0 removes those root links: before you update, point each such link at the same file in `systemd/`, then run `systemctl --user daemon-reload`. For a new installation, prefer the generator in the [service guide](service-setup.md): `node scripts/worker-bridge-setup.mjs --worker NAME --public-url https://bridge.example.com --port PORT --home HOME_PATH --start`. The external self-check is deployment-specific; configure it before enabling its timer.

<a id="names-you-may-see"></a>

## Names you may see

Earlier versions of Dalan used other names. Some remain so that existing installations keep working; use `dalan` and `DALAN_*` names for anything new.

- **`dot-bridge.service`, `dot-bridge-selfcheck.service` and `dot-bridge-selfcheck.timer`** are legacy systemd templates in `systemd/`. Do not use them for a new install; use `scripts/worker-bridge-setup.mjs`.
- **`.dot-bridge.json`** is the older name of a repository's check file, `.dalan.json`. Dalan still reads it when `.dalan.json` is absent.
- **`dot-bridge.*` OAuth scopes and `DOT_BRIDGE_*` settings** are older names that still work; the `dot-worker` command is replaced by `dalan`. They do not limit which client can be a worker.
- **T3 Code** is a separate desktop app for running coding agents. Dalan has an optional integration with it (the `t3.*` scopes, [T3 tools](t3-reverse-control.md) and [operator-registered tools](worker-clients.md#operator-registered-tools)). Ordinary jobs do not need it.
