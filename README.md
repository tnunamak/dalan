# Dalan

Put your MCP-only agent to work on coding jobs from your Mac or Linux computer. The hosted agent is the worker: it connects to your local Dalan bridge over MCP and claims jobs you queue. With explicit repository grants and workspace setup, it can return findings or a patch for you to review. You decide whether to apply changes. Dalan does not run a model or start the agent.

Before you begin, install [Node.js](https://nodejs.org) 24 or newer and [Tailscale](https://tailscale.com/download) with Funnel enabled. Your agent's account must allow custom MCP connectors.

**Tailscale prerequisite.** `--route tailscale` publishes through Tailscale Funnel, which your tailnet administrator must allow (a `funnel` entry in the tailnet access controls; HTTPS and MagicDNS must be on too). If Funnel is not allowed, Dalan stops before it publishes anything and tells you which setup step is missing, or prints Tailscale's own refusal. Enable Funnel once at <https://tailscale.com/kb/1223/funnel>, then run the command again. Other routes need no Tailscale setting; `dalan setup` lists them.

<a id="quickstart"></a>

**Just exploring?** Run a temporary, text-only trial:

```sh
npm install -g @tnunamak/dalan
dalan try --public --route tailscale
```

Follow the terminal instructions to add the connector and approve only the matching sign-in code. Paste the supplied prompt into your agent's chat. Success is a report returned to your terminal.

The trial has no repository access. Keep private code and secrets out of it. It ends after three hours at most. Its public link can change or stop without warning. For a local-only trial that opens no public route, run `dalan try --local`; to connect a worker client by hand, see [manual setup](docs/manual-setup.md#worker-setup). For a persistent connection, use the installation steps below.

### Stop a trial

Ctrl-C stops the trial and cancels a route that is still starting. Dalan closes its forwarding gate and attempts to remove its route. If it cannot confirm cleanup, it reports that. When Gozar cannot confirm route ownership, Dalan leaves the route alone and gives no stop command.

If Gozar reports cleanup as pending, Dalan prints a recovery command that stops by port. Gozar does not bind that command to a session, so inspect the current route before you run it.

A trial prints its own home. Set `DALAN_HOME` to that home before you run other `dalan` commands against the trial. On stop, Dalan removes the connector URL file and the bridge's secret file for temporary routes.

<a id="expose-your-bridge"></a>

## Install a persistent connection

This example names your hosted worker `assistant`; use that name consistently.

If you tried the temporary trial first, save any results you want (see [service setup](docs/service-setup.md)), stop it with Ctrl-C, and unset the trial's `DALAN_HOME` before you install:

```sh
unset DALAN_HOME
```

The persistent service uses a fresh home and needs a new sign-in. Do not reuse the trial home.

```sh
npm install -g @tnunamak/dalan
dalan service install --worker assistant --route tailscale
dalan connect start --worker assistant
```

Add the private connector URL shown by Dalan to your agent's MCP settings and start sign-in. Compare the code shown in your client with the pending code in your terminal:
```sh
dalan connect pending
```

Only if they match, replace `CODE` below with that code and approve:
```sh
dalan connect approve CODE --worker assistant
```

Keep the connector URL and pairing codes private. You are ready to send a job when the client finishes sign-in.

Dalan runs as a user service. On macOS it starts at login and stops at logout. On Linux it follows the systemd user manager; starting before login needs administrator setup. Installing a service does not start your AI agent. On macOS, jobs run with `--execution none`.

Automatic updates are enabled by default. Updates that change the tools exposed to your agent require approval and a connector refresh. See [service setup](docs/service-setup.md) for diagnostics, update controls, other routes and recovery.

## Give your connected agent a job

In another terminal, send a text-only job to the worker you just connected. If you chose a name other than `assistant`, use it instead. `--execution none` lets the job run no commands on your computer; `--deliver none` sends the result nowhere except back to Dalan, where you read it:

```sh
dalan submit --worker assistant --execution none --deliver none --brief "Explain what a database index does. Do not read files, run commands or call external services."
```

This first job needs no repository and returns a report, not a patch. Copy the request ID that Dalan prints. In the connected agent's chat, send this, replacing `REQUEST_ID` with that ID:

> Use Dalan to claim job REQUEST_ID, follow its brief, report progress, and finish with your answer. Do not expand its permissions.

Queuing a job does not start the agent. After you have prompted it, replace `REQUEST_ID` with the same ID, then wait and read the result:

```sh
dalan wait REQUEST_ID
dalan get REQUEST_ID --json
```

Read the answer in `report.result` and its outcome in `report.outcome`. A missing or null report means there is no report yet. A blocked or failed outcome is not a successful answer.

`wait` defaults to 300 seconds. Exit 0 means finished, 3 a question or blocker, 4 cancelled, 5 the worker is on a usage break, and 124 timed out with the job still open. After a nonzero exit, inspect the job with `dalan get` before you continue. Do not submit again only because the wait timed out.

Only after you read a finished answer and find it useful, record your decision:

```sh
dalan decide REQUEST_ID accepted
```

A finished job and an accepted result are separate steps. Acceptance records your review; it does not change your files.

The text-only job above returns no patch to apply. A later [repository job](#separate-repository-assignment) can return one. Inspect it first, then replace `REQUEST_ID` with that job's ID and `PATH` with your local repository directory:

```sh
dalan apply REQUEST_ID --dir PATH
```

<a id="send-jobs-from-your-local-agent"></a>

## Send jobs from your local agent

A local coding agent with a shell (Claude Code, Codex CLI) can be the requester. It runs `dalan submit`, `wait`, `get` and `decide`. The hosted agent, such as Muse, stays the worker: it connects over MCP and claims the job. The requester needs no MCP connection. Copy the [instruction block](docs/local-agent-requester.md#instructions-to-paste) into your agent's instructions.

<a id="separate-repository-assignment"></a>

## Give a worker a repository job

The text-only job proves pairing and reporting, not coding access. Before you submit a repository job, complete [workspace setup](docs/manual-setup.md#owner-and-requester-setup). Git and Python 3.8 or newer must be installed on the bridge computer, workspaces must be enabled on both the worker grant and the host, and the host's GitHub credential must be able to read the repository. Then grant only the repository below. A repository grant alone does not enable workspaces.

The first repository job below reads one file at a pinned commit. It does not edit files or run checks. The trial has no repository access.

Replace `WORKER` with your worker's name (`assistant` above) and `OWNER/REPO` with the repository:

```sh
dalan worker allow WORKER OWNER/REPO
dalan worker list WORKER --json
```

Revoke access when the worker no longer needs it:

```sh
dalan worker deny WORKER OWNER/REPO
```

For a read-only repository job, replace the request ID (`req_` plus a new lowercase UUID), repository and full commit SHA below. Choose a file that exists at that commit:

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

Save it as `repository-job.json`. Replace `WORKER` as above, and `REQUEST_ID` with the ID that `submit` prints. Then submit, wait, read the report and record your decision:

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

Any client that speaks HTTP MCP and completes the bridge's OAuth sign-in can be a worker. Start with the [worker guide](docs/worker-clients.md).

| Client | Guide |
|---|---|
| Any MCP client | [Connect a worker client](docs/worker-clients.md) |
| Codex CLI | [Native CLI worker: Codex CLI](docs/worker-clients.md#native-cli-worker-codex-cli) |
| Claude Code | [Native CLI worker: Claude Code](docs/worker-clients.md#native-cli-worker-claude-code) |
| opencode | [CLI worker: opencode](docs/worker-clients.md#cli-worker-opencode) |
| ChatGPT | [Connect ChatGPT](docs/connect-chatgpt.md) |
| Claude on the web | [Claude cloud worker](docs/claude-worker-onboarding.md) |

## Upgrade

For an installed service, follow [service updates](docs/service-setup.md#service-updates). Dalan checks daily by default; a tool-catalog change waits for your approval before switching and requires a refresh in each connected client.

For an older or manually managed installation, follow the [upgrade guide](docs/dalan-upgrade.md). Before upgrading or restoring, use the [backup and rollback instructions](docs/operations.md#upgrade-and-rollback). Do not copy keys alone or mix files from different backups.

## Reference

Replace `REQUEST_ID` with a job's ID.

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
