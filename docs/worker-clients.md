# Connect a worker client

A worker is any MCP client that signs in to a Dalan bridge with OAuth, claims a job, reports progress and finishes it. This guide has the exact steps for Claude Code, Codex CLI and opencode, and the requirements for any other client.

Start from the section that matches your bridge:

| Your bridge | Your client | Go to |
|---|---|---|
| `dalan try` is running on this computer | Claude Code or Codex CLI on this computer | [Claude Code](#native-cli-worker-claude-code) or [Codex CLI](#native-cli-worker-codex-cli), "From `dalan try`" |
| `dalan try` is running on this computer | opencode on this computer | [opencode](#cli-worker-opencode) |
| A bridge that you started by hand ([manual setup](manual-setup.md#step-by-step)) | Claude Code or Codex CLI on this computer | The same sections, "From a bridge you started by hand" |
| A bridge with a public HTTPS address ([service guide](service-setup.md)) | A client on another computer | [Native client on a remote HTTPS bridge](#native-client-on-a-remote-https-bridge) |
| A bridge with a public HTTPS address | ChatGPT or Claude on the web | [Connect ChatGPT](connect-chatgpt.md) or [Claude cloud worker](claude-worker-onboarding.md) |

Install your client and sign in to it first: [Claude Code](https://code.claude.com/docs/en/quickstart), [Codex CLI](https://developers.openai.com/codex/cli/) or opencode. Check that `claude --version` or `codex --version` works; Dalan does not require a particular client.

## Requirements for any client

- **HTTP MCP with OAuth.** The client connects to the bridge's MCP URL and signs in through the bridge's built-in OAuth server.
- **An allowed callback.** OAuth returns to the client through a callback URI. The bridge accepts only the patterns that the owner allowed with `dalan connect allow-callback`; `dalan try` allows `http://127.0.0.1/callback` and `http://localhost/callback` on any port, and the [setup reference](setup-reference.md#callback-patterns) has the pattern rules.
- **A reachable bridge.** A client on the bridge computer can use `127.0.0.1`. A client on another computer needs a route to the bridge, and a hosted client needs a public HTTPS address.
- **A browser on the client's computer.** The browser must run on the computer that runs the client's callback listener.

The MCP URL contains a secret path, so give it only to the client that you connect.

## Native CLI worker: Claude Code

**From `dalan try`.** The bridge, the worker `local` and the callback pattern already exist. Register the server, then sign in:

```sh
claude mcp add --transport http --scope user local "$(cat ~/.local/share/dalan-trial/resource-url)"
claude mcp login local
```

If you passed `--home DIR` to `try`, read `DIR/resource-url` instead. `claude mcp login` opens the sign-in page and waits; in an interactive `claude` session, `/mcp`, then `local`, then **Authenticate** does the same. Approve the attempt by answering `y` in the `try` terminal; you do not run `dalan connect` commands.

**From a bridge you started by hand.** Allow the callback, open a pairing window, then register the server. Replace `WORKER` with the worker name that you initialized and `SECRET` with the `BRIDGE_PATH_SECRET` value (see [Worker setup](manual-setup.md#worker-setup)):

```sh
dalan connect allow-callback 'http://localhost/callback'
dalan connect start --worker WORKER
claude mcp add --transport http --scope user WORKER 'http://127.0.0.1:8799/SECRET/mcp'
```

Run `claude mcp login WORKER`; it opens the sign-in page and waits. (In an interactive `claude` session, `/mcp`, then `WORKER`, then **Authenticate** does the same.) In the owner shell, run `dalan connect pending`, check that the code, redirect and scopes match, and approve:

```sh
dalan connect approve CODE --worker WORKER --confirm-redirect REDIRECT
```

A native client needs the exact redirect that `pending` shows. Add `--replace` only to replace an existing connection.

**What you see.** Claude Code prints a sign-in URL and tries to open a browser. It uses `http://localhost:PORT/callback` with a random port, which is why the pattern uses `localhost`. It asks for the scopes `dalan.read dalan.work t3.read t3.write` (or the older `dot-bridge.*` names); Dalan accepts them, and the `t3.*` scopes give no extra access. The client name in `pending` is `Claude Code (WORKER)`.

**Check:** `claude mcp login` prints `Authenticated with "WORKER". Its tools are now available in Claude Code.`

**Run the job.** Submit a job with `--deliver none`, then prompt Claude Code to use only the Dalan server: list pending jobs, claim the job, report progress and finish it. If your Claude Code account has other MCP connectors, name the server in the prompt so the worker does not use them. `dalan wait REQUEST_ID` returns `finished` when the job is done.

To remove the registration later, run `claude mcp remove --scope user WORKER`.

## CLI worker: opencode

Use a model that supports tool calls; the worker does its job through tool calls.

Work in a project directory whose `opencode.json` already configures your model provider. Deny these tools there:

```json
"permission": { "bash": "deny", "edit": "deny", "webfetch": "deny", "websearch": "deny", "execute": "deny" }
```

`execute` is opencode's code tool. It runs JavaScript that can fetch any URL, so denying `bash` and `webfetch` alone does not stop the worker from reaching the network. The worker can still read files in that directory and below it, so keep secrets out of it.

opencode's own prompt still suggests `execute`, and a model that follows it writes the call as text and stops. Dalan writes guidance for the model to `worker-instructions.md` in the bridge home, next to `resource-url`: `dalan try` writes it to the trial home, and the service setup writes it to the bridge home that it creates. Load it with the `instructions` list in the same `opencode.json`; the file stays in the bridge home, not in your project:

```json
"instructions": ["~/.local/share/dalan-trial/worker-instructions.md"]
```

If you passed `--home DIR` to `try`, use `DIR/worker-instructions.md`. For a service bridge, use `BRIDGE_HOME/worker-instructions.md`.

Register the bridge from `dalan try`:

```sh
opencode mcp add local --url "$(cat ~/.local/share/dalan-trial/resource-url)"
```

This writes a `local` entry under `mcp.servers` in `opencode.json`. Add `"codemode": false` to that entry:

```json
"local": { "type": "remote", "url": "…", "codemode": false }
```

By default opencode calls MCP tools through `execute`, which is denied above. With `codemode` off, the Dalan tools are direct tools named `local_claim`, `local_finish` and so on, and the worker can use them.

Sign in. Approve the attempt by answering `y` in the `try` terminal:

```sh
opencode mcp auth local --standalone
```

Give it the job that `try` printed. Replace `PROVIDER/MODEL` with your model, and `PROMPT` with the prompt:

```sh
opencode run --standalone --auto -m PROVIDER/MODEL "PROMPT"
```

`--auto` approves every tool call that `opencode.json` does not deny, including the Dalan tools. With this configuration the worker cannot fetch a page, run a command or edit a file. An opencode release that adds a tool can change this; check your configuration again after an upgrade. opencode 2.2 has no `mcp remove` command; to remove the registration, delete the `local` entry from `opencode.json`.

## Native CLI worker: Codex CLI

This recipe uses a loopback bridge, built-in OAuth and a plain shell as the requester; it needs no public URL.

**From `dalan try`.** Register the server under the name `local`:

```sh
codex mcp add local --url "$(cat ~/.local/share/dalan-trial/resource-url)"
```

If you passed `--home DIR` to `try`, read `DIR/resource-url` instead. Approve the attempt by answering `y` in the `try` terminal, then send the worker the prompt that `try` printed.

**From a bridge you started by hand.** Allow the callback, open a pairing window, then register the server. Replace `WORKER` and `SECRET` as in the Claude Code section:

```sh
dalan connect allow-callback 'http://127.0.0.1/callback'
dalan connect start --worker WORKER
codex mcp add WORKER --url 'http://127.0.0.1:8799/SECRET/mcp'
```

**Sign in.** `codex mcp add` writes the server to `~/.codex/config.toml` and starts the OAuth sign-in at once. It prints an authorization URL and does not return until the attempt is approved. There is no separate `codex mcp login` step the first time; use `codex mcp login WORKER` only to sign in again later.

1. Open the printed URL once, in one browser on the same computer, and leave the tab open. The page shows a pairing code and checks again every few seconds. Codex picks a random callback port; the portless pattern admits it.
2. Approve that exact code: from `dalan try`, check that the code and redirect match the page, then answer `y` in the `try` terminal. From a bridge you started by hand, run `dalan connect pending`, match the code, and run the same `dalan connect approve` command as in the Claude Code section.
3. **Check:** the page finishes and `codex mcp add` returns with `Successfully logged in.`

Each visit to the URL starts a new attempt with its own code, and only a live attempt can be approved. The bridge answers `Connection attempt invalid or expired` for an attempt that it no longer holds, for example when a script fetched the URL without keeping the page open, or when a different attempt's code was approved. If you see that error, stop `codex mcp add` (Ctrl-C), run `codex mcp remove WORKER`, and start again from `codex mcp add`.

**Run the job in an interactive session.** Start `codex`, paste the job prompt, and allow the Dalan tool calls when Codex asks.

**Run the job without a screen (`codex exec`).** `codex exec` has no one to ask, so its approval policy is `never`, and Codex refuses every MCP tool call that needs approval:

```text
MCP tool call requires approval, but approval policy is never
```

Approve only the five tools that the job needs, for this server only. Add this to `$CODEX_HOME/config.toml` if `CODEX_HOME` is set, otherwise to `~/.codex/config.toml`, with the server name that you passed to `codex mcp add` in place of `acme`:

```toml
[mcp_servers.acme.tools.list_pending]
approval_mode = "approve"
[mcp_servers.acme.tools.get]
approval_mode = "approve"
[mcp_servers.acme.tools.claim]
approval_mode = "approve"
[mcp_servers.acme.tools.progress]
approval_mode = "approve"
[mcp_servers.acme.tools.finish]
approval_mode = "approve"
```

Every other tool of that server, and every other server, still needs approval and fails under `codex exec`. Do not use `--dangerously-bypass-approvals-and-sandbox` instead: it turns off all approvals and the sandbox for everything the model does. A job that uses repository tools (`list_files`, `read_file` and others) needs those names added the same way. `default_tools_approval_mode = "approve"` under `[mcp_servers.acme]` approves every tool of the server, including tools added later; prefer the per-tool list. Without one of these forms the call fails with the message above.

Run `codex exec` from a Git repository that you trust. Outside a Git repository, Codex stops with `Not inside a trusted directory and --skip-git-repo-check was not specified`. If you have no such repository, make an empty directory for the worker, change into it, and add `--skip-git-repo-check` after `codex exec`; add it only in a directory that you trust. Replace `REQUEST_ID` with the `request_id` that `dalan submit` returned and `acme` with your server name:

```sh
codex exec "Use the acme MCP server (Dalan) to list pending work. Find only REQUEST_ID, claim it, read its brief and cancellation state, report progress, and finish that repository-free text job exactly as instructed. Keep the returned claim_id for progress and finish. Do not claim other jobs, read files, run commands or call external services. If the job is missing or cancelled, stop and report that." < /dev/null
```

The `< /dev/null` stops Codex from waiting on standard input. **Check:** the worker calls `list_pending`, `claim`, `progress` and `finish`, and `dalan wait REQUEST_ID` returns `finished`.

To remove the registration later, run `codex mcp remove WORKER`, then delete any `[mcp_servers.WORKER.tools.*]` tables that remain in `config.toml`.

## Native client on a remote HTTPS bridge

A native client (Codex CLI, Claude Code) on another computer can use a bridge that has a public HTTPS address. The client still uses a loopback callback on its own computer, so the owner must allow that exact host and path on the bridge: `dalan connect allow-callback 'http://127.0.0.1/callback'` for Codex CLI, or `dalan connect allow-callback 'http://localhost/callback'` for Claude Code. Leave out the port; the client chooses it. `localhost` needs its own allow command and resolves on the client's computer. Other HTTP callbacks stay refused; a callback that is not loopback must use HTTPS.

Nothing proves who a native client is, neither its name nor its loopback host. The person at the client reads the pairing code from the browser page on their computer and tells the owner over a trusted channel. The owner compares it with `dalan connect pending` and approves that code with `--confirm-redirect` set to the exact redirect shown; the flag catches a typo only. Registration alone grants no access.

Each native attempt is approved by its own code, and a later attempt cannot take the approval of an earlier one. Many attempts during an open window can fill the limit of five pending attempts; `dalan connect reset` clears them. For a hosted client, only the newest attempt can be approved. If a code matches no pending entry, run `dalan connect pending` and compare the codes before you retry.

### Worked example: Codex CLI on another computer

This example uses a bridge from the [Tailscale Funnel setup](service-setup.md#with-tailscale-funnel), a worker named `NAME` and Codex CLI on the worker computer. No reverse proxy and no domain of your own are involved.

1. On the bridge computer, with `DALAN_HOME` set to the bridge home, allow the callback and open a pairing window:

   ```sh
   dalan connect allow-callback 'http://127.0.0.1/callback'
   dalan connect start --worker NAME
   ```

2. Copy the private file `$DALAN_HOME/resource-url` to the worker computer over a trusted channel such as `scp`, and keep it at mode 0600, because it holds the bridge's secret path.
3. On the worker computer, add the server. The command prints an authorization URL and waits:

   ```sh
   codex mcp add NAME --url "$(cat resource-url)"
   ```

4. On the worker computer, open the printed URL once in a browser and leave the tab open. Read the pairing code from the page. Each visit starts a new attempt with a new code, so use the code from the page that you keep.
5. On the bridge computer, run `dalan connect pending`. Compare the code and the redirect with the page, then run `dalan connect approve CODE --worker NAME --confirm-redirect REDIRECT`.
6. **Check:** `codex mcp add` ends with `Successfully logged in.` Add the five tool approvals from the [Codex CLI section](#native-cli-worker-codex-cli) to the worker computer's `config.toml`. Submit the README's first job with `--worker NAME`, run `codex exec` on the worker computer, then use `dalan wait`, `get` and `decide` on the bridge computer.

To undo it, run `codex mcp remove NAME` on the worker computer, and `node "$(npm root -g)/@tnunamak/dalan/scripts/worker-bridge-setup.mjs" --remove --worker NAME --home HOME_PATH` on the bridge computer (from a checkout, `node scripts/worker-bridge-setup.mjs` with the same options); that also turns off the Funnel rule that setup created.

## Worker names and more than one worker

A worker name labels one connection and its job queue; it loads no vendor-specific code. Use a lowercase name of up to 32 characters that starts with a letter and contains letters, digits, `_` or `-`; `pool` and `unknown` are reserved.

`try` and the README use the name `local`. To use another name, initialize it in a new bridge home and use it in every command that names a worker:

```sh
export DALAN_HOME="$HOME/.local/share/dalan-personal" DALAN_LOOPBACK=1
dalan init --worker personal --public-url http://127.0.0.1:8799
dalan connect allow-callback 'CALLBACK_PATTERN'
dalan connect start --worker personal
dalan connect pending
dalan connect approve CODE --worker personal
```

`DALAN_HOME` selects the new bridge home, and `init` accepts an `http://127.0.0.1` URL only with `DALAN_LOOPBACK=1`. Start the bridge for that home with `DALAN_LOOPBACK=1 DALAN_AUTH_MODE=builtin`, as [manual setup](manual-setup.md#owner-and-requester-setup) shows; the server refuses loopback mode without built-in OAuth. Export `DALAN_HOME` in every shell that runs these commands.

Run one `allow-callback` command, for the callback that your client really uses. For a native client, add `--confirm-redirect REDIRECT` to the approve command, with the exact redirect that `pending` shows. A fresh `init` creates one worker, refuses to overwrite an existing profile, grants no repositories and no T3 Code access, and sets execution to `none`. Approval binds the connection to that worker. Changing the model or vendor in the client does not change the connection or its repository grants.

For repository work, grant exact repositories with `dalan worker allow personal OWNER/REPO`. Workspace tools, host checks and repository grants are separate controls; see the README's [repository job](../README.md#separate-repository-assignment) and [operations](operations.md) before you enable execution. A finished job is separate from owner acceptance, patch application and merge authority. See [pull workers](pull-workers.md) for schedules and wake signals after the first job works.

These examples use built-in OAuth, while an external OAuth issuer uses connection identity records in the worker profile; see [authentication profiles](portable-auth-profile.md). A deployment with several workers must configure each identity explicitly.

## Operator-registered tools

This is an advanced feature; a first job does not need it. The owner can give a worker an extra ability without making the worker's client refresh its tool list. The owner registers a tool on the bridge and grants it to a worker. The worker finds it with `list_tools` and runs it with `call_tool_read` or `call_tool_write`. These three tools are in every catalog profile except `legacy-v46`, and a registry change never changes `tools/list`.

The registry ships with one handler kind, `t3_post`. It posts a message to one fixed T3 Code thread. A `t3_post` tool must have `"class": "write"`, because a post is a write effect. Registration refuses any other class and names the class that is required. Custom handler kinds, for example a command handler, are planned. They are not available yet, and the registry cannot run an arbitrary command.

Save this as `owner_message.json` and replace `THREAD_ID` with the ID of the thread that receives the messages. The bridge computer needs the `t3-post` command on the bridge's `PATH`.

```json
{
  "name": "owner_message",
  "description": "Send a question or a blocker to the owner.",
  "class": "write",
  "inputSchema": {
    "type": "object",
    "properties": {
      "kind": { "type": "string", "enum": ["question", "blocker"] },
      "text": { "type": "string", "minLength": 1, "maxLength": 2000 }
    },
    "required": ["kind", "text"],
    "additionalProperties": false
  },
  "handler": { "kind": "t3_post", "thread_id": "THREAD_ID" }
}
```

On the bridge computer, run these commands. `WORKER` is the name of a configured worker.

```sh
dalan tool add --file owner_message.json
dalan tool grant owner_message WORKER
dalan tool list
dalan tool revoke owner_message WORKER   # take the ability back
dalan tool remove owner_message          # delete the tool and all its grants
```

A new tool is denied to every worker until you grant it. `dalan tool list` shows each tool, its class and its granted workers. There is no command to disable or edit a tool. To change one, remove it and add the new file. A grant is lost when you remove the tool, so grant it again.

The worker calls `list_tools`. The reply holds `registry_version` and, for each tool, its `class` and `schema_hash`. Then the worker calls `call_tool_write` with `tool`, `arguments`, the `schema_hash` from `list_tools`, and an `idempotency_key` that is new for each message:

```json
{ "tool": "owner_message", "arguments": { "kind": "question", "text": "Which branch should I use?" },
  "schema_hash": "<from list_tools>", "idempotency_key": "<new for each message>" }
```

If the registry changed, the call fails with `stale_registry`. Call `list_tools` again and use the new `schema_hash`. Limits, retries and errors for `owner_message` are in [the T3 guide](t3-reverse-control.md#adding-abilities-without-a-refresh).

**A grant is standing authority.** The bridge has no per-call approval step. After you grant a tool, the worker can call it until you revoke the grant or remove the tool. A revoke or a remove also discards the messages that worker queued but the bridge has not yet delivered. A grant to a name that is not a configured worker has no effect, so check the spelling.

## Optional integrations and compatibility

Ordinary worker jobs need neither of these integrations.

- **T3 Code** is a separate desktop app for running coding agents. Dalan can give a worker tools that read T3 Code threads or post to one. These tools act outside a job claim. The registered `t3_post` tool above needs only its own tool grant and the `t3-post` command. The thread tools need the server setting `DALAN_ENABLE_T3_TOOLS=1`, the worker's `t3` capability and the `t3code` command on the service's `PATH`; with a named-worker profile, the bridge does not start if the setting is on, a worker has the capability and `t3code` is missing. Owner notification tools need the same capability. A fresh worker has none of this access. Grant it only deliberately; see [T3 authority](t3-reverse-control.md).
- **ACP** (Agent Client Protocol) is a separate protocol that Dalan's optional requester adapter uses to connect a background job to T3 Code. The `integrations/t3/acp-kit` source library supplies that adapter's session, locking and prompt helpers. It is not a worker SDK, and an MCP worker does not need it. Advanced adapter settings: `DALAN_ACP_BUILD_OWNERS` is the comma-separated allowlist of repository owners for builds, and `DALAN_ACP_REPO_CONFIG` selects the repository exclusion file. The older `DOT_ACP_*` names still work.

Use `dalan` and `DALAN_*` settings for new installations. `DOT_BRIDGE_*` settings, old data directories, `dot-bridge.*` OAuth scopes and installed `dot-bridge` unit names are compatibility names from earlier versions; they do not limit which client can be a worker. Do not rename populated directories or edit wire identifiers to match a worker's name.

Callback handling, tool-list refresh and wake support vary by client, so watch the first job in your client before you rely on unattended work.
