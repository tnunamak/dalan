# Dalan

Give a coding agent in ChatGPT, Claude on the web, or another MCP client a job from your computer, then review its report.

```sh
npx -y @tnunamak/dalan try
```

**Success:** Dalan prints a connector URL and a prompt. Add the connector to your hosted client, compare the sign-in code with the one in your terminal, approve the match, then paste the prompt into a chat with the connector enabled. The agent's report returns to your terminal.

<a id="quickstart"></a>

## Try it with your MCP client

You need Node.js 24 or newer, Linux or macOS (or WSL), and a hosted client account or workspace that permits custom MCP connectors.

**Tailscale prerequisite.** `--route tailscale` publishes through Tailscale Funnel, which your tailnet administrator must allow (a `funnel` entry in the tailnet access controls; HTTPS and MagicDNS must be on too). If Funnel is not allowed, Dalan stops before it publishes anything and tells you which setup step is missing, or prints Tailscale's own refusal. Enable Funnel once at <https://tailscale.com/kb/1223/funnel>, then run the command again. Other routes need no Tailscale setting; `dalan setup` lists them.

Start Dalan in an interactive terminal:

```sh
npx -y @tnunamak/dalan try
```

Choose ChatGPT or Claude on the web. Dalan asks Gozar for a public HTTPS route and shows what it chose before it opens anything. Routes come from Gozar; Dalan does not interpret the route name. `dalan setup` lists what Gozar can offer on this computer and saves your choice. To pick a route for one trial, pass its name:

```sh
dalan try --public --route tailscale
```

Some routes are temporary and some are stable. Some are run by a third party that terminates TLS and can read the connector URL and your traffic. Dalan prints the properties of the chosen route and asks for consent before it exposes anything. Keep private code and secrets out of the demo.

A temporary demo link can change or stop without warning, including within minutes. Dalan checks the original address and ends the trial when it detects a route change or loss. The trial ends after three hours at most; that is a limit on the trial, not a promise about the link. If the address changes or the route stops, start a fresh trial and replace the connector URL.

1. **Add the connector.** Follow Dalan's instructions to add the complete connector URL in your hosted client and start sign-in. Keep the URL private.
2. **Approve the sign-in.** Compare the code in the browser with the code in your terminal. Approve only when they match.
3. **Send the prompt.** Paste Dalan's prompt into a chat with the connector enabled. Dalan queues the demo job; it does not start the hosted chat for you.
4. **Review the report.** Read the report in your terminal before you accept or reject it.

The hosted demo is a text job, not a repository review. It grants no repository access. Your agent uses its own account, limits and billing; Dalan does not run a model.

### Stop a trial

Ctrl-C stops the trial. It also cancels a route that is still starting. Dalan closes its forwarding gate and attempts to remove its route. If it cannot confirm cleanup, it reports that. When Gozar cannot confirm route ownership, Dalan leaves the route alone and gives no stop command; use a different port and home for another trial.

If Gozar returns a cleanup-pending status for this trial, Dalan provides a recovery command that stops by port. Gozar does not bind that command to a session ID, so the route can change before the command runs. Inspect the current route before using it.

On stop, Dalan removes the connector URL file and the bridge's secret file for temporary routes. A trial prints its own home. If you run other `dalan` commands against a trial, set `DALAN_HOME` to that printed home first.

### Try without a public route

```sh
npx -y @tnunamak/dalan try --local
```

This runs a self-check with a built-in demo worker and then lets you connect a client on this computer. It does not open a public route. To connect a worker client by hand, see [manual setup](docs/manual-setup.md#worker-setup).

<a id="expose-your-bridge"></a>

## Install a long-running bridge

Install the CLI, then install the background service:

```sh
npm install -g @tnunamak/dalan
dalan service install --worker NAME --route tailscale
```

Linux runs the service as a systemd user service. macOS runs it as a launchd LaunchAgent. The commands are the same on both. `tailscale` publishes through Tailscale Funnel; any other Gozar route name works the same way, and `dalan setup` lists the routes Gozar can offer on this computer. The install creates the public HTTPS address through Gozar, picks a free port, and keeps its state in `~/.local/share/dalan-service`. Dalan remembers that home, so no other command needs `DALAN_HOME`. Repeat `--worker NAME` for each worker. Running the same install again changes nothing.

Install prints where the private connector URL file is, the next command to run, and a health check. Run these two checks:

```sh
dalan status
dalan doctor --auth
```

`dalan doctor --auth` runs an OAuth self-check against the public URL: dynamic registration, PKCE, `initialize` and `tools/list`. It prints no secrets. On macOS, host checks are unavailable and jobs run with `--execution none`.

Pair a worker, then approve it with the code the client shows. Compare that code with the one in your client before you approve:

```sh
dalan connect start --worker NAME
dalan connect pending
dalan connect approve CODE --worker NAME
```

Automatic updates are on by default: a daily check with up to one hour of random delay (a systemd timer on Linux, a launchd agent on macOS). The `dalan` on your PATH follows the service's current version. If any tool descriptor changes, Dalan stages the release and records `connector_refresh_required` without switching. Run `dalan service update --yes` to authorize that switch, then refresh the Dalan connector in each hosted client. The daily check never passes `--yes`.

```sh
dalan service status
dalan service update --check
dalan service auto-update off
dalan service uninstall
```

An update installs a separate version, checks every worker's tool catalog, restarts the bridge, and checks its health. A failed switch attempts to restore the previous version and saved state; a failed rollback is reported. Restarts interrupt client connections; these checks do not prove that every change in tool behavior is compatible. See [Run Dalan as a service](docs/service-setup.md) for options, an existing reverse proxy, worker migration and [update and recovery details](docs/service-setup.md#service-updates).

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
