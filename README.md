# Dalan

Give a bounded job to ChatGPT or Claude and review its report in your terminal. Dalan holds the queue; your selected client does the work. A small service on your computer, the *bridge*, holds the jobs; the worker connects to it over MCP. You submit a bounded task, follow its progress, and review the worker's report or patch before you accept it.

Use it when you want a second agent, a second account or another computer to do a job while you keep the accept or reject decision: for example, your coding agent hands a code review to an agent signed in to another account, and you read its report before you accept it.

- **Repository access starts denied.** A new worker can use no repository through Dalan until you grant one. Finishing a job does not accept its result: acceptance is a separate owner decision.
- **Any MCP client can be the worker.** Claude Code, Codex CLI, ChatGPT, Muse Spark (Meta) or your own agent connect over MCP (Model Context Protocol) with OAuth sign-in. Dalan does not run a model itself. See [Connect any MCP worker](#connect-any-mcp-worker) and [Connect ChatGPT](docs/connect-chatgpt.md). [T3 Code](docs/t3-integration.md#use-dalan-from-t3-code) can delegate to any of them.
- **The bridge listens only on your computer.** A hosted trial puts a temporary public route in front of it, only after you choose ChatGPT or claude.ai, and removes the route when you stop.

**Not for:** Dalan does not run, schedule or start agents for you, and it does not merge code. It queues work and returns reports for you to review.

**Help:** see [Still stuck?](#still-stuck) for the recovery steps and how to open an issue.

<a id="quickstart"></a>

## Try it with ChatGPT or claude.ai

You need Node.js 24 or newer on Linux or macOS (on Windows, use a WSL shell). Run:

```sh
npx -y @tnunamak/dalan try
```

Press Enter twice to choose ChatGPT (type `2` for claude.ai). Dalan then:

1. **Opens a temporary public HTTPS route.** The route is always on port 443, because some hosted clients (claude.ai) reach nothing else. It uses your computer's Tailscale Funnel on 443 when no other rule holds that port. If another rule holds 443, that rule is left alone and the trial starts its own temporary Tailscale node (`dalan-trial-<id>`, userspace, in the trial home); a new node asks for a one-time sign-in, whose link Dalan prints (set `DALAN_TS_AUTHKEY` to skip it). The node is ephemeral (no state on disk), so Tailscale drops it when it goes offline, even after a crash; Ctrl-C also logs it out. A later trial ends any daemon a crashed trial left. Otherwise it starts a Cloudflare Quick Tunnel and, if needed, downloads the `cloudflared` helper into your user cache after checking its SHA-256. It needs no account, domain, API key or placeholder. If Tailscale is missing or not ready for Funnel, it says why in one line and uses Cloudflare.
2. **Prints your complete connector URL** and the steps to add it in ChatGPT or claude.ai, plus one prompt to paste into a chat. Add the connector, sign in, and send the prompt.
3. **Asks you to approve the sign-in**, shows the code to compare with the sign-in page, and tells you when the hosted client has claimed and finished the demo job. Then you review its report and accept it if it is correct.

Keep the terminal open; Ctrl-C stops the trial and removes the public route. The connector URL contains a secret: it is printed once on your terminal and kept in a private file in the trial home. The trial needs your OAuth approval and grants no repository access. A Cloudflare address changes on every run, so each run needs a new connector; a ready Tailscale Funnel keeps its address. The hosted demo runs on your ChatGPT or claude.ai account, with that account's normal limits and any workspace permission it requires; Dalan runs no model. For other options, see `npx -y @tnunamak/dalan help try`.

Skip the question with `npx -y @tnunamak/dalan try --public --client chatgpt` (or `--client claude`; `--route tailscale` or `--route cloudflare` forces a route).

<a id="local-trial"></a>

## Try it on this computer only

Run `npx -y @tnunamak/dalan try --local` for a self-check with no account, no MCP client and no public route. You need:

- **Linux or macOS.** On Windows, [install WSL](https://learn.microsoft.com/windows/wsl/install) and run every command in the WSL shell.
- **Node.js 24 or newer.** Run `node --version`; it must print `v24` or higher. If it does not, install Node.js from the [official download page](https://nodejs.org/en/download) and open a new shell.
- **Optional: Git and Python 3.8 or newer**, for the repository part of the demo. Run `git --version` and `python3 --version`. Without them, the demo skips that part and says so.

The shell examples in this README use POSIX shell syntax (bash or zsh). Start the local demo with one command:

```sh
npx -y @tnunamak/dalan try --local
```

To run from a checkout instead, see [Install from source](#from-source).

`try` starts a bridge on `127.0.0.1` and runs a built-in demo worker against it. The first run takes about half a minute. npx asks once to install the package; answer `y`. A first run prints this (the request ID is shortened):

```text
$ npx @tnunamak/dalan try --local
Need to install the following packages:
@tnunamak/dalan@0.5.2
Ok to proceed? (y) y
npm notice run npx
npm notice run 'dalan' try
Dalan trial. Home: /home/you/.local/share/dalan-trial
✔ Bridge up on http://127.0.0.1:8799. Loopback only. Log: /home/you/.local/share/dalan-trial/server.log
✔ Self-check passed in 2.6 s: a demo worker, approved by this command, finished a job; the repository grant works and a second repository is refused.

Connect your worker as an HTTP MCP server with OAuth:
  MCP URL file: /home/you/.local/share/dalan-trial/resource-url
  MCP URL (secret hidden): http://127.0.0.1:8799/<secret>/mcp
  Keep the URL private.
  How to connect Claude Code, Codex or another client: https://github.com/tnunamak/dalan/blob/v0.5.2/README.md#connect-your-own-worker
  Callbacks: http://127.0.0.1/callback, http://localhost/callback. To add one, restart with:
  npx @tnunamak/dalan try --home '/home/you/.local/share/dalan-trial' --callback PATTERN
Job req_01234567… is queued for your worker. When it is connected, send it:
  "Request req_01234567… is your only job: claim it with Dalan, do what its brief asks, report progress and finish it with the claim_id. Stop if it is missing or cancelled. Claim no other job."
Waiting for your worker. Ctrl-C stops the bridge.
```

**Check:** look for the `✔ Self-check passed` line. The demo worker signed in through OAuth and finished a text job. When Git and Python are available, it also reads the permitted demo repository and is refused another; otherwise the output says that the repository part was skipped. That repository is local and needs no GitHub login.

`try` now keeps the bridge running and has queued a second job for your own worker. Leave this terminal open and continue below. Ctrl-C stops the bridge and keeps the trial home for the next run ([The trial home](#the-trial-home)).

<a id="connect-your-own-worker"></a>

## Connect your own worker

This step proves that your own client can do a job. You need a worker client installed and signed in on this computer, such as [Claude Code](https://code.claude.com/docs/en/quickstart), [Codex CLI](https://developers.openai.com/codex/cli/) or [opencode](docs/worker-clients.md#cli-worker-opencode). A client that runs on its provider's servers (ChatGPT, Claude on the web) cannot reach `127.0.0.1`; see [Expose the bridge](#expose-your-bridge) instead.

**Cost.** The built-in demo uses no AI model or account. Your own worker runs on the account signed in to Claude Code or Codex CLI, and is subject to that provider's access rules, usage limits and charges. Dalan runs no model and adds no charge.

**Who can connect.** The bridge listens only on `127.0.0.1`. A client needs the secret URL from the private file and your `y` at sign-in before it can act as a worker. These checks do not separate programs that run as your own Unix user: such a program can read the bridge's private files and use its admin socket. Connect only clients that you trust with your account, and run untrusted workers as a different Unix user or on another computer (see [Operations](docs/operations.md)).

1. **Add the bridge to your client.** In a second terminal, register the MCP URL from the private file that `try` printed, under the name `local`. The URL contains a secret. The commands read it from the file, so it does not go into your shell history, but the client may print it: keep that output private. If you passed `--home DIR` to `try`, use that directory in place of `~/.local/share/dalan-trial`.

   With Claude Code, register the server and sign in:

   ```sh
   claude mcp add --transport http --scope user local "$(cat ~/.local/share/dalan-trial/resource-url)"
   claude mcp login local
   ```

   `claude mcp login` opens the sign-in page and waits until you approve it in step 3. In an interactive `claude` session, `/mcp`, then `local`, then **Authenticate** does the same.

   With Codex CLI, register the server; Codex starts the sign-in at once and waits until it is approved:

   ```sh
   codex mcp add local --url "$(cat ~/.local/share/dalan-trial/resource-url)"
   ```

2. **Open the sign-in page.** The client opens a browser tab, or prints a URL for you to open once in a browser on this computer. Leave the tab open. It is titled "Connect to Dalan" and shows a pairing code such as `ABCD-1234`. The page also shows a `dalan connect approve` command: you do not need it, because `try` asks you instead.

3. **Approve in the `try` terminal.** A block of lines appears there with `code`, `client_name`, `redirect` and `scopes`. Check that `code` is the code in the browser tab and that `scopes` are `dalan.read dalan.work`. (Claude Code also asks for `t3.read t3.write`, optional integration scopes that give no extra access in this version.) Then answer `y` to `Approve this connection for worker "local"? [y/N]`.

   **Check:** `try` prints `Approved. Waiting for the worker to finish the job.` `claude mcp login` prints `Authenticated with "local". Its tools are now available in Claude Code.`; `codex mcp add` returns with `Successfully logged in.`

4. **Give the worker its job.** Queuing a job does not start a worker, so you start it. Open an interactive session (`claude` or `codex`), paste the prompt that `try` printed, and allow the Dalan tool calls when the client asks. To run it without an interactive session, Claude Code takes `claude -p "PROMPT" --allowedTools mcp__local`, which approves this server's tool calls in advance; in this mode Claude Code does not prompt, so it does not use tools that need approval.

   **Check:** `try` prints `✔ Your worker finished req_…. Report:` with the worker's report, then asks `Accept this result? [y/N]`. Answer `y`; `try` prints `Recorded as accepted.`

You have now done the whole loop: a job was queued, your worker claimed and finished it, and you reviewed and accepted the result.

If a step fails, look for its message here:

- **The browser shows `Connection attempt invalid or expired`.** Each visit to the sign-in URL starts a new attempt with a new code, and only a live attempt can be approved. Start the sign-in again in the client and approve the new code.
- **No approval block appears in the `try` terminal.** After a while, `try` prints the `dalan connect pending` and `dalan status` commands to run in another terminal, and it shows each new attempt as it arrives.
- **`npx @tnunamak/dalan try` fails with an npm error such as `ECONNREFUSED`, `ETIMEDOUT` or `ENOTFOUND`.** npm cannot reach the registry. Check the network or proxy with `npm config get registry` and `npm config get proxy`, then run the command again.
- **Your client uses a different callback.** `try` allows `http://127.0.0.1/callback` and `http://localhost/callback` on any port. Stop `try` and start it again with `--callback PATTERN` ([pattern rules](docs/setup-reference.md#callback-patterns)).

<a id="still-stuck"></a>

**Still stuck?** With `DALAN_HOME` set as in [Next steps](#next-steps), run `dalan status` and `dalan doctor`, and match their messages against the list above. If that does not help, [open an issue](https://github.com/tnunamak/dalan/issues) with the Dalan version, your OS, your worker client and its version, the command that you ran and the error with private values removed. Never include the private MCP URL, tokens or sign-in links. Report a vulnerability through the [security policy](SECURITY.md), not in an issue.

The [worker guide](docs/worker-clients.md) has the full Claude Code and Codex CLI recipes, including running Codex without a screen (`codex exec`).

## Next steps

Each row starts from a working trial.

| To do this | Go to |
|---|---|
| Run `dalan` commands against the trial bridge | Run `npm install -g @tnunamak/dalan`. In each shell, set `DALAN_HOME` to the **Home** printed by the running trial; the usual default is `~/.local/share/dalan-trial`. Then run `dalan status` and `dalan inbox --all`. |
| Give your worker a task of your own, with no file to write | [Your own first job](#your-own-first-job) |
| Give your worker a job on a real repository | [Give a worker a repository job](#separate-repository-assignment) |
| Let a coding agent submit and read jobs as tool calls | [`dalan mcp`](docs/local-agent-mcp.md) |
| Connect a worker on another computer, or a hosted client such as ChatGPT | [Expose the bridge](#expose-your-bridge), then [Connect any MCP worker](#connect-any-mcp-worker) |
| Keep a bridge running as a service | [Run Dalan as a service](docs/service-setup.md) |
| Delegate T3 Code tasks to your worker, or give a worker T3 tools | [T3 and orchestration integration](docs/t3-integration.md#use-dalan-from-t3-code) and [T3 tools](docs/t3-reverse-control.md) |
| See every command | `dalan help --all` |

<a id="your-own-first-job"></a>

### Your own first job

This gives your connected worker a task of your own, with no file to write and no JSON. Leave `try` running and use a second shell. First install the CLI and select the exact **Home** printed by the running trial. The export below shows the usual default; replace it before running the block if `try` used `--home DIR` or an existing `DALAN_HOME`. Then type your task:

```sh
npm install -g @tnunamak/dalan
export DALAN_HOME=~/.local/share/dalan-trial
printf 'Your task, on one line: '; IFS= read -r task
```

If `npm install -g @tnunamak/dalan` fails with `EACCES`, npm cannot write to its global install directory. Do not use `sudo`; [change npm's default directory](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally), or skip the install and write `npx @tnunamak/dalan` wherever this section says `dalan`.

Type the task and press Enter. The shell stores it as plain text, so quotes, `$` and backticks in it are safe. Then submit it:

```sh
dalan submit --worker local --execution none --deliver none --brief "$task Do not read files, run commands or call external services."
```

`--brief` makes a read-only job from the text. `submit` prints a `Request ID:` line and a `Send your worker:` line. Paste that prompt into your worker's session, then wait for the result in the same shell. Replace `REQUEST_ID` with the ID that `submit` printed:

```sh
dalan wait REQUEST_ID --timeout 3600 && dalan get REQUEST_ID
```

**Check:** `dalan get` prints `Job REQUEST_ID: finished`, then `Summary:` and your worker's answer. It then prints `Next: dalan decide REQUEST_ID accepted`, and its last line is `Full record: dalan get REQUEST_ID --json`. It may also print an `Outcome:` line. Review the answer, then run the `Next:` command to record your decision. If `wait` times out, the job is still open: check it with `dalan get REQUEST_ID` and ask the worker to check Dalan again.

<a id="what-dalan-is"></a>

## How Dalan works

Dalan has three roles, and one person can hold all three:

- The **owner** runs the bridge, a small Node.js service that stores jobs and results in SQLite. The owner decides which workers may connect and which repositories each worker may use.
- The **requester** submits jobs with the `dalan` command and reads the results. A requester can be you in a shell, a script, or a coding agent.
- The **worker** is an MCP client that signs in to the bridge with OAuth. It calls `list_pending` to find work, `claim` to take a job, `progress` to report, and `finish` to send the result.

Workers pull jobs; Dalan never starts a worker. You prompt or schedule the worker in its own client. The [pull-worker guide](docs/pull-workers.md) describes schedules and wake signals once the first job works.

A worker name, such as `local` or `chatgpt`, is a label that you choose for a connection. It does not select a vendor adapter: every worker uses the same job tools. A finished job and an accepted job are separate facts. Dalan returns reports and patches; it never pushes or merges them.

<a id="separate-repository-assignment"></a>

## Give a worker a repository job

The first job needs no repository. A repository job needs Git and Python 3.8 or newer on the bridge computer, because the bridge fetches the repository with them. The bridge also needs workspaces turned on, the worker needs a grant for that one repository, and the bridge needs a way to fetch it.

A bridge started by `dalan try` already has workspaces on. Leave `try` running and use a second shell with `DALAN_HOME` set ([Next steps](#next-steps)). For a bridge you started by hand, add `DALAN_ENABLE_WORKSPACE=1` to the server command from [step 3 of the manual setup](docs/manual-setup.md#owner-and-requester-setup) and restart it. Without that setting, repository calls fail with `capability_not_enabled`.

The repository can come from GitHub or from a clone on this computer:

- **A GitHub repository.** The bridge fetches with `gh auth token`. Install the [GitHub CLI](https://cli.github.com/) and run `gh auth login` as the user who runs the bridge. A service with its own home needs its own [GitHub access](docs/operations.md#service-github-access).
- **A clone on this computer (no GitHub login).** Pick a name `OWNER/REPO` for it, for example `local/my-project`. Start the bridge with a variable named `DALAN_GITHUB_URL_` plus that name in capitals, with every other character replaced by `_`, set to the clone's absolute path. For `local/my-project` the variable is `DALAN_GITHUB_URL_LOCAL_MY_PROJECT`. To use the trial bridge, stop `try` with Ctrl-C and start it again with the variable:

  ```sh
  DALAN_GITHUB_URL_LOCAL_MY_PROJECT=/path/to/my-project npx @tnunamak/dalan try --local
  ```

  The restart replaces your worker's connection with the demo worker again, so sign your worker in again as in [Connect your own worker](#connect-your-own-worker). For a bridge you started by hand, add the same variable to the server command instead. Use `local/my-project` wherever the steps below say `OWNER/REPO`. The clone needs at least one commit.

1. As owner, grant the worker one exact repository, then check the grant.

   ```sh
   dalan worker allow local OWNER/REPO
   dalan worker list local --json
   ```

   **Check:** the list contains only the repositories that you intend to allow. A new worker can use no repository; a grant for one repository does not grant its owner's other repositories. Grants take effect without a restart.

2. As requester, find the commit to pin. For a GitHub repository, `git ls-remote https://github.com/OWNER/REPO HEAD` prints it in the first column; for a local clone, run `git -C /path/to/my-project rev-parse HEAD`. Make a new request ID with `node -e "console.log(require('node:crypto').randomUUID())"`.

3. Save this job as `repository-job.json`, with your repository, commit and request ID. The job reads `README.md`; if the repository has none in its top directory, name another file.

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

4. Submit the job.

   ```sh
   dalan submit --worker local --execution none --deliver none --file repository-job.json --json
   ```

5. In your worker's client, send this prompt with your request ID:

   > Request REQUEST_ID is your only job: claim it with Dalan, do what its brief asks, report progress and finish it with the claim_id. Stop if it is missing or cancelled. Claim no other job.

   Then wait for the result, read it and record your decision:

   ```sh
   dalan wait REQUEST_ID
   dalan get REQUEST_ID
   dalan decide REQUEST_ID accepted
   ```

   **Check:** the report names the file's title and the exact commit that you pinned. Each repository job takes one repository; submit separate jobs for more.

If submission or claim says the repository is not allowed, run `dalan paths --json` to confirm that you are in the bridge's home, then `dalan worker list local --json`, and grant the exact repository. A queued job that loses its grant stays queued until the grant returns or you cancel the job. A GitHub authentication error means the bridge's home has no working GitHub credential.

Repository workspaces and host checks (tests that the bridge runs) are separate capabilities. `try` does not turn on host checks. They need Linux, explicit owner opt-in, an allowlisted repository and check, and resource budgets; see [execution and evidence](docs/operations.md#execution-capability-and-check-evidence). A finished job or a passing check never authorizes a merge.

<a id="expose-your-bridge"></a>

## Expose the bridge to other machines

To try a hosted client once, run `npx -y @tnunamak/dalan try` ([above](#quickstart)); it opens and removes its own public route. This section sets up a separate, permanent bridge.

A worker connects from wherever its MCP client runs. `127.0.0.1` reaches only the bridge computer. A worker on another computer needs a network route to the bridge, and a hosted client such as ChatGPT needs a public HTTPS address.

For this, set up a separate, long-running bridge with a stable HTTPS address. The setup script writes a systemd user service (Linux) or a launchd agent (macOS). The default route is [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), which needs no reverse proxy and no domain of your own:

1. Complete the [Tailscale Funnel prerequisites](docs/service-setup.md#with-tailscale-funnel).
2. Run the setup script from the installed package (`npm install -g @tnunamak/dalan`):

   ```sh
   node "$(npm root -g)/@tnunamak/dalan/scripts/worker-bridge-setup.mjs" --worker NAME --port PORT --home HOME_PATH --expose tailscale --start
   ```

   From a checkout, run `node scripts/worker-bridge-setup.mjs` with the same options.

   Setup picks the first free Funnel port (443, 8443 or 10000); add `--funnel-port N` to choose one.
3. Connect the worker: a native client on another computer follows [Native client on a remote HTTPS bridge](docs/worker-clients.md#native-client-on-a-remote-https-bridge); a hosted client follows its recipe in [Connect any MCP worker](#connect-any-mcp-worker).

If you already run an HTTPS reverse proxy, pass `--public-url https://bridge.example.com` instead of `--expose tailscale`; the [service guide](docs/service-setup.md) lists the routes to forward. A successful network check only shows that the address answers: run a first job through the new connection to prove that the worker can work.

<a id="support-matrix"></a>

## Connect any MCP worker

Any client that speaks HTTP MCP and completes the bridge's OAuth sign-in can be a worker. Start with the [worker guide](docs/worker-clients.md); it applies to Claude Code, Codex CLI, a script or a hosted chat client. The recipes add only the registration details of one client; the job tools and grant rules stay the same.

| Client | Guide |
|---|---|
| Any MCP client | [Connect a worker client](docs/worker-clients.md): the common protocol and client requirements |
| Codex CLI | [Native CLI worker: Codex CLI](docs/worker-clients.md#native-cli-worker-codex-cli) |
| Claude Code | [Native CLI worker: Claude Code](docs/worker-clients.md#native-cli-worker-claude-code) |
| opencode | [CLI worker: opencode](docs/worker-clients.md#cli-worker-opencode), with a model that supports tool calls |
| ChatGPT | [Connect ChatGPT](docs/connect-chatgpt.md) |
| Muse Spark (Meta) | [Send a job from Codex CLI to Muse Spark](docs/codex-to-muse.md) |
| Claude on the web (hosted) | [Claude cloud worker](docs/claude-worker-onboarding.md); separate from Claude Code |

Start each new worker by hand for its first job. Dalan never starts a worker, including after a reboot.

<a id="the-trial-home"></a>

## The trial home

`try` keeps everything in one private directory, the trial home: `--home DIR` if you pass it, else `DALAN_HOME` if it is set, else `~/.local/share/dalan-trial`.

- **What `try` refuses.** It refuses your real home directory and any non-empty directory without a `.dalan-trial` marker file, so it cannot take over an existing bridge home.
- **Keep it dedicated.** A directory that has the marker is reused without checking its other files. On exit, `try` deletes `demo/` and every `req_*.json` request file in the home, revokes the demo grant and deletes the demo repository. A run that was killed is cleaned up at the next start.
- **Use a short path on a local disk.** The bridge's admin socket path has a length limit, and network or FUSE file systems are not supported. If a home is too long or not on a local disk, use a new short directory: `npx @tnunamak/dalan try --local --home /short/local/path`. Do not use an existing bridge home.
- **A second run reuses the home**, its worker profile, job history and port. It first replaces the worker's connection with the demo worker, so sign in again in your client and approve it again after the demo.
- **To start over**, stop `try` and delete the trial home.
- **For scripts**, run `dalan try < /dev/null`: with standard input closed, `try` runs the self-check and stops.

`try` takes these options:

- `--local`: this computer only (the self-check above). `--public`: ChatGPT or claude.ai through a public route. With neither, a terminal is asked; with no terminal, `try` runs the local self-check and never opens a route.
- `--client chatgpt|claude` and `--route auto|tailscale|cloudflare`: the hosted client and public route. Each implies `--public`. A public trial gets a new trial home on every run unless you pass `--home`; its address is part of its sign-in identity, so a home is reused only at the same address.
- `--home DIR`: the trial home.
- `--port N`: the bridge port on this computer (for a public trial, never the public port). The default is the port that the home used before, otherwise 8799 or the next free port. A home keeps its port; for another port, start a separate trial with `--home NEW_DIR --port N`.
- `--callback PATTERN`: local mode only: allow one more OAuth callback pattern; repeatable.

`try` turns repository workspaces on (with at least 256 MiB of free disk) and makes only the demo repository available locally. Every other repository stays denied until you grant it. `try` does not turn on host checks.

**Commands against the trial.** Set `DALAN_HOME` as in [Next steps](#next-steps). While the default trial home `~/.local/share/dalan-trial` exists and `DALAN_HOME` is unset, every command except `dalan help`, `dalan paths`, `dalan doctor`, `dalan try`, `dalan mcp`, `dalan --version` and `dalan -v` stops with `DALAN_HOME is not set` and prints the `export` line to run, so it cannot use your normal home by mistake. `dalan doctor` runs instead, reports that no bridge home is selected and prints the `export` line to run. Without that trial home, an unset `DALAN_HOME` means your normal home.

**If the bridge does not start or stops.** `try` prints the path of `server.log` and three commands: one to read the log, one to retry the same home and port, and one to start in a new home with a free port. Read the log before you retry. `--port` alone cannot move an existing trial to another port.

<a id="step-by-step"></a>

## Advanced: the same setup by hand

`try` runs ordinary `dalan` commands in a private trial home. To run each piece yourself (a foreground bridge, your own worker name, or a client that `try` does not cover), follow [Manual setup](docs/manual-setup.md).

<a id="owner-and-requester-setup"></a>
<a id="worker-setup"></a>
<a id="submit-finish-and-read-the-result"></a>

It has three parts: [owner and requester setup](docs/manual-setup.md#owner-and-requester-setup), [worker setup](docs/manual-setup.md#worker-setup), and [submit, finish and read the result](docs/manual-setup.md#submit-finish-and-read-the-result), which has a complete first job in `first-job.json`. To give a job to the trial bridge with no file, see [Your own first job](#your-own-first-job).

<a id="commands-that-matter"></a>

## Operate and recover

- **Settings and commands.** The [setup reference](docs/setup-reference.md) lists environment settings and requester commands. The [protocol](PROTOCOL.md) defines the worker tools and lease rules.
- **Before you change a deployed bridge**, read [operations](docs/operations.md). Before an upgrade, read the [release notes](CHANGELOG.md) and follow [upgrade and rollback](docs/operations.md#upgrade-and-rollback): older code can refuse an upgraded database.
- **Backups.** Stop every process that writes to the bridge, then follow the [backup checklist](docs/dalan-upgrade.md#pre-upgrade-checklist). Back up receipts, artifacts and encryption keys with the databases. After a restore of older authorization state, a worker's newer token can fail with `invalid_grant`; connect that worker again.
- **Optional integrations.** Besides [T3 Code](docs/t3-integration.md#use-dalan-from-t3-code), the [setup reference](docs/setup-reference.md) lists the other optional integrations, and ordinary jobs need none of them.
- **Uninstall a trial.** Stop `dalan try` (Ctrl-C) and remove the connection from your client: `claude mcp remove --scope user local` or `codex mcp remove local`. Remove the `dalan` command as the [removal table](docs/operations.md#remove-an-installation) describes. The trial home holds private keys, connections and receipts: delete it only when you no longer need them. For a generated service, follow [service removal](docs/service-setup.md#remove-a-generated-service).

<a id="repository-layout"></a>

## Names you may see

Earlier versions of Dalan used other names, and some remain so that existing installations keep working. Use `dalan` and `DALAN_*` names for anything new. The [setup reference](docs/setup-reference.md#names-you-may-see) lists the older names and the optional integrations.

<a id="from-source"></a>

## Install from source

To work on Dalan, or to run the bridge by hand from a checkout:

```sh
git clone https://github.com/tnunamak/dalan.git
cd dalan
npm ci
node bin/dalan.mjs try
```

To put `dalan` on your PATH from the checkout, run `npm link` once (undo it with `npm unlink -g @tnunamak/dalan`). Without it, write `node bin/dalan.mjs` wherever this README says `dalan`. Installing from npm instead: `npm install -g @tnunamak/dalan` (remove it with `npm uninstall -g @tnunamak/dalan`).

Read the [contributing guide](CONTRIBUTING.md) before you open a pull request, and the [security policy](SECURITY.md) to report a vulnerability.

Licensed under the [Apache License 2.0](LICENSE).
