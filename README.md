# Dalan

Give a coding agent in ChatGPT, Claude on the web, or another MCP client a job from your computer, then review its report.

```sh
npx -y @tnunamak/dalan try
```

**Success:** Dalan prints a connector URL and a prompt. Add the connector to your hosted client, compare the sign-in code with the one in your terminal, approve the match, then paste the prompt into a chat with the connector enabled. The agent's report returns to your terminal.

<a id="quickstart"></a>

## Try it with your MCP client

You need Node.js 24 or newer, Linux or macOS (or WSL), and a hosted client account or workspace that permits custom MCP connectors.

Start Dalan in an interactive terminal:

```sh
npx -y @tnunamak/dalan try
```

Choose ChatGPT or Claude on the web. In `auto` mode, a saved Gozar choice or an older saved localhost.run choice selects Gozar. Otherwise Dalan uses Tailscale when a route is usable, and Gozar when Tailscale is not usable.

When Dalan selects Gozar, it names tunnl.gg, links its [terms](https://tunnl.gg/terms) and [privacy notice](https://tunnl.gg/privacy), and asks for consent before exposure. After you consent, Gozar creates a key for this installation and opens a route through its key-bound `tunnl-gg` relay. Dalan does not use or pass your SSH keys. The relay terminates TLS and can see the connector URL and traffic. Keep private code and secrets out of the demo.

A temporary demo link can change or stop without warning, including within minutes. Dalan checks the original address and ends the trial when it detects a route change or loss. The trial ends after three hours at most; that is a limit on the trial, not a promise about the link. If the address changes or the route stops, start a fresh trial and replace the connector URL.

1. **Add the connector.** Follow Dalan's instructions to add the complete connector URL in your hosted client and start sign-in. Keep the URL private.
2. **Approve the sign-in.** Compare the code in the browser with the code in your terminal. Approve only when they match.
3. **Send the prompt.** Paste Dalan's prompt into a chat with the connector enabled. Dalan queues the demo job; it does not start the hosted chat for you.
4. **Review the report.** Read the report in your terminal before you accept or reject it.

The hosted demo is a text job, not a repository review. It grants no repository access. Your agent uses its own account, limits and billing; Dalan does not run a model.

### Stop a trial

Ctrl-C stops the trial. It also cancels a route that is still starting. Dalan closes its forwarding gate and attempts to remove its route. If it cannot confirm cleanup, it reports that. When Gozar cannot confirm route ownership, Dalan leaves the route alone and gives no stop command; use a different port and home for another trial.

If Gozar returns a cleanup-pending status for this trial, Dalan provides a recovery command that stops by port. Gozar does not bind that command to a session ID, so the route can change before the command runs. Inspect the current route before using it.

On stop, Dalan removes the connector URL file. It also removes the bridge's secret file for temporary routes. It keeps the bridge configuration when a Tailscale route reuses the same home.

### Try without a public route

```sh
npx -y @tnunamak/dalan try --local
```

This runs a self-check with a built-in demo worker and then lets you connect a client on this computer. It does not open a public route. To connect a worker client by hand, see [manual setup](docs/manual-setup.md#worker-setup).

## Use a Tailscale route

`npx -y @tnunamak/dalan setup` saves a route choice for public trials. If Tailscale is ready for Funnel, setup asks whether to save Tailscale or Gozar for temporary links. If Tailscale is not ready, setup prints Tailscale installation instructions or lets you save Gozar. It does not install a background service or move a connector to a new address.

Use Tailscale explicitly:

```sh
npx -y @tnunamak/dalan setup
npx -y @tnunamak/dalan try --public --route tailscale --client chatgpt
```

Use `--client claude` for claude.ai. Tailscale login, client sign-in and approval may still be required. An explicit `--route tailscale` does not fall back to a trial link: if the route cannot start, Dalan stops and explains why.

An explicit `--route tailscale` trial uses HTTPS port 443. When the port is available, Dalan opens its own Funnel rule for the trial and attempts to remove only that rule when it stops. If another rule already holds port 443, Dalan can start an isolated, temporary Tailscale node instead. It does not reuse or change the other rule. That node uses a new address and may need a one-time sign-in. A new address needs a new client sign-in.

If the public address does not answer, the trial prints `TLS certificate: ok` or `TLS certificate: error (...)`. The trial keeps a masked copy of the temporary node's log as `tailscaled.log` in the trial home.

### Choose another relay

`--route gozar` explicitly selects the Gozar relay. Dalan still asks for consent before it exposes the route.

`--route localhost.run` remains available as an explicit option. It uses OpenSSH and a temporary third-party relay. The relay terminates TLS and can inspect the connector URL and forwarded traffic. Dalan prints this notice before it starts the route. The address can change or stop without warning. Dalan attempts to close the route and reports cleanup it cannot confirm.

In `auto` mode, a saved Gozar choice or an older saved localhost.run choice selects Gozar. Otherwise, auto uses a usable Tailscale route and selects Gozar when Tailscale is unavailable.

<a id="expose-your-bridge"></a>

## Install a long-running bridge

Install the CLI:

```sh
npm install -g @tnunamak/dalan
```

For a bridge that runs in the background on Linux, follow [Run Dalan as a service](docs/service-setup.md). `dalan service install` installs a systemd user service and registers an existing HTTPS origin with Gozar. It does not configure your reverse proxy. One bridge can serve several workers with built-in sign-in and a stable tool catalog.

New service installs enable daily update checks with up to one hour of jitter. `dalan service update --check --home DIR` reports the newest npm release without installing it. An update installs a separate version, checks every worker's tool catalog, restarts the bridge, and checks its health. A failed switch attempts to restore the previous version and saved state; a failed rollback is reported. Restarts interrupt client connections; these checks do not prove that every change in tool behavior is compatible.

If any tool descriptor changes, Dalan stages the release and records `connector_refresh_required` without switching. Run `dalan service update --yes --home DIR` to authorize that switch, then refresh the Dalan connector in each hosted client. The daily timer never passes `--yes`. Use `dalan service status --home DIR` for the last result, or `dalan service auto-update off --home DIR` to disable future scheduled checks. Pass `--no-auto-update` during installation to opt out. Existing service preferences are preserved. See [update and recovery details](docs/service-setup.md#service-updates). These commands support Linux systemd services; they do not add launchd support.

For an existing bridge, migrate worker settings into a new home before you install the service. Repeat `--source` for each old workers file. Use `--workspace-worker` for each worker that needs workspace access:

```sh
dalan service migrate-workers \
  --home "$HOME/.local/share/dalan-service" \
  --source "$HOME/OLD_BRIDGE/.config/dot-bridge/workers.json" \
  --source-db "$HOME/OLD_BRIDGE/.local/share/dot-bridge/bridge.db" \
  --workspace-worker WORKER
```

Migration reads source files without changing them. It copies only repository grants backed by validated audit records. If a checkpoint fails, all source grants are denied until the owner re-approves them. It denies and reports unaudited additions. It preserves supported worker settings, but does not copy OAuth connections, tokens, jobs, results or old destination approvals. The new service defaults execution to `none`. It preserves explicit `workspaceAllowed` settings. Workspace access stays denied by default; pass `--workspace-worker NAME` to grant it to each worker that needs it. Pair every connector again, create new subscriptions with fresh signing keys, and approve each new destination revision. See [service setup](docs/service-setup.md#install-one-bridge-for-several-workers) for details.

For a new service home, pass `--worker NAME` once for each worker instead of migrating. See `dalan help service` for the install options.

## Give your connected agent a job

In another terminal, replace `WORKER` with the name of your connected worker:

```sh
dalan submit --worker WORKER --execution none --deliver none --brief "Explain what a database index does. Do not read files, run commands or call external services."
```

Send the agent the request ID that Dalan prints. Ask it to claim that job, follow its brief and return a report. Queuing a job does not start the agent.

Replace `REQUEST_ID` with that ID, then wait and read the result:

```sh
dalan wait REQUEST_ID
dalan get REQUEST_ID --json
```

Read the report before recording your decision:

```sh
dalan decide REQUEST_ID accepted
```

A finished job and an accepted result are separate steps. Acceptance does not apply a patch. After review, apply a finished job's patch with:

```sh
dalan apply REQUEST_ID --dir PATH
```

<a id="separate-repository-assignment"></a>

## Give a worker a repository job

The first job needs no repository. Repository jobs need Git and Python 3.8 or newer on the bridge computer, workspaces enabled, and an exact repository grant for the worker. The hosted demo does not enable repository work. A repository grant and a job's read/write scope are separate limits; host checks are another capability.

```sh
dalan worker allow WORKER OWNER/REPO
dalan worker list WORKER --json
```

Revoke access when the worker no longer needs it:

```sh
dalan worker deny WORKER OWNER/REPO
```

For a read-only repository job, replace the request ID, repository and full commit SHA below. Choose a file that exists at that commit:

```json
{
  "schema_version": 1,
  "request_id": "req_<new UUID>",
  "brief": "Read README.md at the pinned commit and report its title. Do not run checks or change files.",
  "inputs": [{"github_repo": "OWNER/REPO", "base_sha": "<full 40-character commit SHA>"}],
  "expected_output": "README title and pinned revision; no patch or check claim.",
  "scope_paths": ["README.md"],
  "execution_scope": "read-only"
}
```

Save it as `repository-job.json`, then submit, wait, read the report and record your decision:

```sh
dalan submit --worker WORKER --execution none --deliver none --file repository-job.json --json
dalan wait REQUEST_ID
dalan get REQUEST_ID
dalan decide REQUEST_ID accepted
```

The host's GitHub credential must be able to read the repository. For local clones, manual bridge setup and workspace configuration, see [manual setup](docs/manual-setup.md#owner-and-requester-setup) and the [setup reference](docs/setup-reference.md). Keep private repository credentials out of the job brief.

<a id="support-matrix"></a>
<a id="connect-your-own-worker"></a>

## Connect any MCP worker

Any client that speaks HTTP MCP and completes the bridge's OAuth sign-in can be a worker. Start with the [worker guide](docs/worker-clients.md); client recipes add registration details, while job tools and grant rules stay the same.

| Client | Guide |
|---|---|
| Any MCP client | [Connect a worker client](docs/worker-clients.md) |
| Codex CLI | [Native CLI worker: Codex CLI](docs/worker-clients.md#native-cli-worker-codex-cli) |
| Claude Code | [Native CLI worker: Claude Code](docs/worker-clients.md#native-cli-worker-claude-code) |
| opencode | [CLI worker: opencode](docs/worker-clients.md#cli-worker-opencode) |
| ChatGPT | [Connect ChatGPT](docs/connect-chatgpt.md) |
| Claude on the web | [Claude cloud worker](docs/claude-worker-onboarding.md) |

## Upgrade

Read the release notes and follow the ordered [upgrade guide](docs/dalan-upgrade.md) before an upgrade. This release changes the worker tool list. After you upgrade, refresh the Dalan connection once in each worker client.

For a compatible-code restart, built-in OAuth keeps an unexpired access token only when the bridge uses the same private home and issuer and its grant and connection remain live. Access tokens last up to one hour. Before an upgrade or restore, stop the bridge and every other writer, then make a consistent SQLite backup. Preserve the complete active private config directory, including `as.json`, `as-jwks.json`, `as-cookie-keys.json`, `as.sqlite` and its sibling `as-storage.key`; the keys alone cannot restore sign-ins. Follow the [backup and rollback steps](docs/operations.md#upgrade-and-rollback).

For the built-in public-client flow, a client that loses a refresh response can recover it only by retrying the identical request within five seconds, while the successor token and connection remain live. A retry after that window can fail and require the client to pair again. This is not a promise of recovery after a longer outage or across incompatible code or storage changes.

## Reference

| Need | Command or guide |
| --- | --- |
| Command help | `dalan help --all` |
| Trial options | `dalan help try` |
| Bridge and queue state | `dalan status --json` |
| Results needing attention | `dalan inbox --all` |
| A full job record | `dalan get REQUEST_ID --json` |
| Host diagnostics | `dalan doctor --json` |
| File locations | `dalan paths --json` |
| Cancel a job | `dalan cancel REQUEST_ID` |
| Run a bridge in the background | [Service setup](docs/service-setup.md) |
| Upgrade or remove an installation | [Operations](docs/operations.md) |
| Release changes | [Changelog](CHANGELOG.md) |

When asking for help, share the failing step and error. Do not share private connector URLs, pairing codes or credentials.

Licensed under Apache-2.0.
