# Run Dalan as a service

Install Dalan once to keep your MCP agent connected to your Mac or Linux computer. You do not need to run the trial first.

Before you begin, install Node.js 24 or newer and Tailscale with Funnel enabled. Your agent's account must allow custom MCP connectors. The commands below are the same on macOS and Linux.

**Tailscale prerequisite.** `--route tailscale` publishes through Tailscale Funnel, which your tailnet administrator must allow (a `funnel` entry in the tailnet access controls; HTTPS and MagicDNS must be on too). If Funnel is not allowed, Dalan stops before it publishes anything and tells you which setup step is missing, or prints Tailscale's own refusal. Enable Funnel once at <https://tailscale.com/kb/1223/funnel>, then run the command again. Other routes need no Tailscale setting; `dalan setup` lists them.

<a id="owner-setup"></a>

## Install and connect your agent

This example names your worker `assistant`. Choose another lowercase name if you prefer, and use it in every command.

```sh
npm install -g @tnunamak/dalan
dalan service install --worker assistant --route tailscale
dalan connect start --worker assistant
```

Dalan installs a background service, chooses a free port and remembers its settings. No environment variables or manual server process are needed.

Add the private connector URL shown by Dalan to the agent's MCP settings. Start sign-in in that client, then check the pending request:
```sh
dalan connect pending
```

Compare the pending code with the code in your client. If they match, replace `CODE` with that code:
```sh
dalan connect approve CODE --worker assistant
```

Do not approve a code you did not request, and do not share the connector URL or codes.

Next, [send your first job](../README.md#give-your-connected-agent-a-job), using `assistant` as the worker name. Dalan queues jobs; you must ask your agent to claim them. A new installation has no repository grants or permission to run host checks.

### Optional checks

After pairing, use these if you need to diagnose the service:
```sh
dalan status
dalan doctor --auth
```

The authentication check tests the public route and sign-in flow, not whether an agent can complete a job.

### More workers and advanced setup

To configure several workers, repeat the flag in the install command, for example `dalan service install --worker assistant --worker reviewer --route tailscale`, and pair each separately. A worker name starts with a lowercase letter, uses lowercase letters, digits, hyphens or underscores, and is at most 32 characters; `pool` and `unknown` are reserved.

### Pairing details

A client on this computer with a loopback callback needs `--confirm-redirect` with the exact redirect that `pending` shows; see [worker pairing](manual-setup.md#worker-setup). A worker on another computer follows [Native client on a remote HTTPS bridge](worker-clients.md#native-client-on-a-remote-https-bridge). Then run [submit, finish and read the result](manual-setup.md#submit-finish-and-read-the-result) with `--worker` set to your worker's name.

Where the README and manual setup use the trial worker `local`, use your service's `NAME`:

- Submission: pass `--worker NAME` to `dalan submit` for the first job and for every repository job.
- Repository grants: `dalan worker allow NAME OWNER/REPO` and `dalan worker list NAME --json`.

`wait`, `get` and `decide` select the job by request ID and take no worker flag.

The rest of this guide covers advanced routes, migration, updates and removal. None is required for the first connection.

### An existing reverse proxy

If you already serve a stable HTTPS address through your own reverse proxy, register that address with Gozar instead of asking Gozar for a new route:

```sh
dalan service install --worker assistant --public-url https://PUBLIC_HOST --port PORT --target TARGET_HOST:TARGET_PORT
```

Gozar records and verifies an origin-to-target route that your reverse proxy already serves; it does not edit the proxy. Prepare the proxy first so the public origin forwards to the address in `--target`. Preserve the public `Host` header. The bridge rejects requests with another Host, including requests that try to replace it with `X-Forwarded-Host`. TLS ends at the proxy. Keep the secret path out of proxy logs.

The proxy must forward these routes without removing their prefixes, methods, query strings, authorization headers or cookies:

| Route | Purpose |
|---|---|
| `/<secret>/mcp` | Carries worker MCP requests. |
| `/.well-known/oauth-protected-resource/<secret>/mcp` | Identifies the protected resource and authorization server. |
| `/.well-known/oauth-authorization-server/<secret>/oauth` | Publishes OAuth endpoints. |
| `/.well-known/openid-configuration/<secret>/oauth` | Provides the discovery alias. |
| `/<secret>/oauth` and `/<secret>/oauth/*` | Handle OAuth and browser pairing. |
| `/signal/*` | Answers wake hooks when configured. |
| `/.well-known/gozar/service` | Answers the Gozar check, with its query string. |

An unauthenticated request to `/admin` on the public origin must return 404. The Dalan process listens on `127.0.0.1:PORT`. When the target is another address on this computer, pass `--lan-port N`; the service then opens the target address and forwards it to the loopback listener. Use a distinct non-wildcard address, not 0.0.0.0, which collides with loopback. If Gozar runs on this computer and reaches loopback directly, use `--target 127.0.0.1:PORT`. Challenge verification binds the receiving socket port to the declared target port. Translating to a different numeric port needs an explicit, trusted `--verify-cmd COMMAND`. If the origin filters the Gozar verifier by source IP, pass the same option. Install succeeds only when Gozar returns a verified route.

### Migrate an older bridge

For existing installations, create the new home and copy each worker's repository allowlist. Replace the example paths with the old bridge homes on this computer:

```sh
dalan service migrate-workers \
  --home "$HOME/.local/share/dalan-service" \
  --source "$HOME/.config/dot-bridge/workers.json" \
  --source "$HOME/OLD_BRIDGE_TWO/.config/dot-bridge/workers.json" \
  --source "$HOME/OLD_BRIDGE_THREE/.config/dot-bridge/workers.json"
```

The helper reads the source files without changing them. If an older home has no `workers.json`, it can read the adjacent `workers-repos.json` migration journal. It preserves worker names and repository allowlists, and copies supported worker capabilities and guidance. It does not copy OAuth registrations, tokens, jobs or results. The new bridge starts with `default_execution: none`. Workspace access defaults to denied; add `--workspace-worker NAME` for each worker that needs an explicit workspace grant. This option records the owner's grant; it does not require an earlier audit record. Existing explicit `workspaceAllowed` and T3 capability settings are retained. Destination declarations are copied, but old destination approvals bind old jobs and connections, so each new job requires a fresh approval.

Optionally pass `--source-db PATH` for each old job database. The helper opens it read-only and writes a private `service-migration.json` checklist containing active subscription counts, callback origins and destination approval counts. It omits callback paths, query strings, signing secrets and encrypted records. This checklist grants no authority. Re-enrol every connector, call `events/subscribe` with a fresh signing key, and approve each new destination revision. Without `--source-db`, the checklist still records those required steps but has no old subscription inventory. For a brand-new bridge, skip migration and pass `--worker NAME` once for each worker instead; those initial workers have empty repository allowlists, no capabilities, and no host execution.

### Move from a trial to a service

A service needs a fresh home; do not point it at a trial home. To keep trial results, save them first while `dalan try` still runs: with `DALAN_HOME` set to the trial home that `try` printed, run `dalan inbox --all --json` to list request IDs, then `dalan get REQUEST_ID --json > result-REQUEST_ID.json` for each result you want. Then stop the trial with Ctrl-C, install the service, and pair the worker again. Pairing replaces the worker client's old connection; remove the old entry first with `codex mcp remove NAME` or `claude mcp remove --scope user NAME`.

### Keep the service running

On Linux the service starts when the systemd user manager starts. Without lingering, that may be your first login after a reboot. If the bridge must start before login, ask an administrator to run `loginctl enable-linger USER` for the account that owns the bridge; install does not check or warn about it. On macOS the LaunchAgent starts when you log in and stops when you log out, so it does not run unattended after a reboot until someone logs in.

`--write-units-only` writes the service files without initializing the bridge home, starting the service or calling Gozar. It is for offline inspection; run the normal install to finish setup.

### Restarting and backing up built-in sign-ins

With compatible code, a restart using the same private home and issuer preserves an unexpired built-in OAuth access token while its grant and connection remain live. The issuer includes the public origin and secret path. Access tokens last up to one hour.

Before an upgrade or restore, stop the bridge and every other writer and make a consistent SQLite backup. Preserve the complete active private config directory, including `as.json`, `as-jwks.json`, `as-cookie-keys.json`, `as.sqlite` and its sibling `as-storage.key`; the keys alone cannot restore sign-ins. Follow the [backup and rollback steps](operations.md#upgrade-and-rollback).

For the built-in public-client flow, a client that loses a refresh response can recover it only by retrying the identical request within five seconds, while the successor token and connection remain live. A retry after that window can fail and require the client to pair again. This is not a promise of recovery after a longer outage or across incompatible code or storage changes.

<a id="after-a-reboot"></a>

## After a reboot

The bridge and the worker come back by separate rules:

- **Bridge.** Linux starts it with the systemd user manager (see lingering above). macOS starts it at your login. Check with `dalan service status` and `dalan status`.
- **Your agent.** Dalan does not start or schedule the agent. Once `dalan status` answers, open the client where you connected the agent and ask it: “Use Dalan to list pending jobs, claim the oldest job within your permissions, follow its brief, report progress and finish it. Stop when no jobs remain.” Check the result with `dalan wait REQUEST_ID` or `dalan get REQUEST_ID --json`, replacing `REQUEST_ID` with your job's ID.

A schedule or hook in the worker's vendor tool is outside Dalan's supported path; [pull workers](pull-workers.md#ways-to-start-a-run) lists the patterns and what they cost. A queued job still expires under the [preparation-expiry rule](pull-workers.md#jobs-the-worker-never-takes) if no worker claims it in time.

## Service updates

New installs enable a daily update check with up to one hour of random delay: a systemd user timer on Linux and a launchd agent on macOS. A missed run can run after the user manager or login session next starts. Installation with `--no-auto-update` disables the timer; `--auto-update` explicitly enables it. Reinstalling preserves the saved choice unless you pass one of those flags. The timer needs your systemd user manager to run; it does not configure login lingering.

```sh
dalan service update --check
dalan service update
dalan service status --json
dalan service auto-update off
dalan service auto-update on
```

The home defaults to `~/.local/share/dalan-service` and Dalan remembers it; pass `--home DIR` only to select a different one. `service status` shows the selected version, saved automatic-update preference and last update result. On Linux, use `systemctl --user list-timers` to inspect the actual timer schedule. Turning updates off prevents future starts; it does not cancel an update already running. Preference changes refuse while an update holds the home lock. A release that was rolled back is recorded and skipped on later runs, including the timer; `dalan service update --retry` tries it again, and a newer or republished release is attempted normally. `service status` shows it as `failed_release`.

`--check` queries the public npm registry for the latest stable `@tnunamak/dalan` version and reports availability without installation or restart. A normal update installs the exact release under `HOME/versions/<version>`, with npm integrity checks and install scripts disabled. The registry's integrity value binds the downloaded bytes to its metadata; it is not an independent publisher signature. The original package must remain available until the first successful update. Later starts use the selected package through `HOME/current`.

Before switching, Dalan starts the candidate on a scratch loopback port against a private copy of the worker configuration, fresh mutable state, and synthetic keys made for that check. It never receives the service's signing, cookie, storage or operator keys. It checks initialization, ping and complete tool descriptors for every configured worker, then compares them with the running bridge. An unreachable worker, failed check or incomplete catalog stops the update. This local check does not test the public HTTPS route or hosted-client OAuth sign-in.

If a descriptor changes, the candidate stays staged and the last result is `connector_refresh_required`. To authorize switching to that release, run:

```sh
dalan service update --yes
```

Refresh the Dalan connector in each hosted client after that switch. `--yes` allows the catalog change; it does not skip integrity, scratch checks or post-restart health checks. The timer never supplies it. Equal catalogs permit an automatic switch, but they cannot prove equal tool behavior or authorization semantics. Restarting interrupts connections and can interrupt in-progress requests.

While a switch is in progress, the restarted candidate refuses every worker call, OAuth request and owner command with a retryable 503 (`service_updating`, with `Retry-After`) and starts no background writer, until the update commits or rolls back. A rollback restores the saved state, so no change that Dalan acknowledged can be lost. Hosted clients retry after the window. For a switch, Dalan stops the bridge, saves its persistent configuration and data, selects the candidate, restarts the unit and checks local health and catalogs. On failure it attempts to stop the candidate, restore the previous selection and saved state, then restart and check the old version. A failed rollback is reported separately. An interrupted switch leaves a transaction record for recovery. Recovery runs when the service starts (an `ExecStartPre` step, `dalan service recover`) and again on the next update attempt; it does nothing while another update is running. Retention keeps three staged versions, including the active and previous versions. This is update recovery, not a replacement for your own backups.

A service installed by 0.6.0 or 0.6.1 is adopted by its first `dalan service update` with no other step: Dalan reads the package path and node binary from the service unit, keeps that node binary, and leaves the original package in place until a later update succeeds. To turn on the daily timer for such a service, run `dalan service auto-update on`, or enroll it the long way: install the current Dalan package, then repeat its original `dalan service install` command with the same home, origin, port and target. Enrollment preserves keys and worker grants, changes the unit's package path and restarts it. Its timer stays off unless you pass `--auto-update` or run `service auto-update on`. A modified unit is refused for inspection. These update commands cover the service made by `dalan service install`; services from the older setup script are not enrolled automatically.

## Remove the service

```sh
dalan service uninstall
```

This stops and removes the service, its update timer or agent and its public route. It never deletes data: the private home, keys and state move to `<home>.removed-<date>`, and the command prints that path. Delete that directory yourself when you want the data gone. A modified service definition may need inspection instead of automatic removal. The full list of things an uninstall must remove (homes, trial home, client entries) is in [operations](operations.md#remove-an-installation).

## Legacy

Installations made by `scripts/worker-bridge-setup.mjs` in earlier releases keep working; that script is kept for compatibility only. See [operations](operations.md#restart-a-service-and-check-its-state) and the [upgrade guide](dalan-upgrade.md) to manage or replace one.
