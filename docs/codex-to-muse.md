# Send a job from Codex CLI to Muse

Codex CLI submits a job through a local `dalan mcp` process. Muse (muse.ai), a hosted cloud agent, connects to the bridge over HTTPS and returns a report. You read it and record an accept or reject decision. The bridge queues work; you start the worker in Muse.

## What you need

- Linux with systemd user services, or macOS with launchd.
- Node.js 24 or newer and npm.
- Codex CLI installed and signed in on the bridge computer.
- A Muse account with remote MCP connections and tool calls available.
- A public HTTPS address that Muse can reach. A Gozar route provides it.

A route makes the bridge reachable from the public internet. Some routes are run by a third party that terminates TLS and can read the connector URL and traffic; others do not. `dalan setup` shows what each route offers. Keep the full MCP URL private: its path contains a secret. Your Codex and Muse accounts retain their own usage limits and charges.

This first job uses no repository and runs no checks. Use a dedicated worker named `muse`. Do not reuse another worker's connection.

## 1. Start and expose the bridge

Install Dalan, then install the service with a dedicated worker named `muse`. `ROUTE` is the name of a Gozar route; `dalan setup` lists what Gozar can offer on this computer.

```sh
npm install -g @tnunamak/dalan
dalan service install --worker muse --route ROUTE
dalan status
dalan doctor --auth
```

Install keeps the bridge's state in `~/.local/share/dalan-service`, which `dalan` remembers; no `DALAN_HOME` is needed. A new worker has no repository grants, and host checks stay off. Open the private connector URL file that install printed and use its entire URL in step 2. Do not substitute the public hostname alone or a loopback URL. For an existing HTTPS reverse proxy, see the [service guide](service-setup.md#an-existing-reverse-proxy).

**Check:** install prints the path of the private connector URL file, and `dalan doctor --auth` passes. `dalan status` returns the queue state. The public check proves reachability and sign-in, not that Muse has finished a job.

## 2. Connect Muse as the worker

Dalan's flow is generic: any MCP client that supports OAuth with Dynamic Client Registration (DCR) and PKCE can connect, and you approve it by matching the code. Muse is one such client. No callback list needs editing. Muse has used this redirect:

```text
https://agent.meta.ai/api/hatch/oauth/callback
```

A curated Muse name and icon appear only when the redirect's exact origin is `https://agent.meta.ai`. A lookalike host, another port or plain HTTP shows only the generic label. The label is a convenience and never a reason to approve.

Start a pairing window:

```sh
dalan connect start --worker muse
```

In Muse, add a remote MCP server with the complete URL from `resource-url`. Start its OAuth sign-in and leave the Dalan sign-in page open. These are general actions, not names of Muse controls.

On the bridge computer:

```sh
dalan connect pending
```

Compare the code with the one in your browser. Check that the worker is `muse`, the redirect is the one Muse showed for this connection (the value above, unless Muse's documentation says otherwise) and the resource identifies your bridge. Check the scopes: ordinary jobs need `dalan.read` and `dalan.work`. The older `dot-bridge.read` and `dot-bridge.work` names are aliases. The bridge also advertises `t3.read` and `t3.write`; those names do not replace the Dalan job scopes. Do not approve an unexpected connection or rely on its client name, which the app supplies.

Replace `CODE` with your matching pending code:

```sh
dalan connect approve CODE --worker muse
dalan connect list
```

Complete the sign-in in the browser and return to Muse. Do not add `--replace` to resolve a conflict casually: it transfers this worker's queued and future jobs to the new connection.

**Check:** approval prints `Approved "CODE" for worker "muse".` with your actual code. The connection list contains worker `muse` with `revoked_at: null`. Ask Muse to list pending Dalan jobs; a successful reply, even an empty list, confirms tool access.

## 3. Add the local requester to Codex

Codex uses standard input and output, not the public worker URL. Find the installed executable in the owner shell:

```sh
command -v dalan
```

Add this entry to `~/.codex/config.toml`. Replace both paths with absolute paths from your computer. Do not leave `~` or `$HOME` in the example values.

```toml
[mcp_servers.dalan]
command = "/absolute/path/to/dalan"
args = ["mcp"]
```

`dalan mcp` finds the remembered service home. Add `env = { DALAN_HOME = "/absolute/path/to/home" }` only to select a different home.

Start a new Codex CLI session on this computer so it loads the entry. Ask it to call `dalan_status`. To call these tools from `codex exec`, which has no screen to approve them, set per-tool approval for the `dalan` server as the `codex exec` paragraph of [Worker clients](worker-clients.md#native-cli-worker-codex-cli) describes.

The local server has the access of the Unix user running it. It uses the bridge's admin socket and needs no separate OAuth connection. Give it only to an agent you trust with your local Dalan CLI access.

**Check:** Codex exposes `dalan_submit`, `dalan_wait`, `dalan_result` and `dalan_status`. The status call returns your bridge's JSON status rather than a connection error.

## 4. Send one small job and read the result

Ask Codex to call `dalan_submit` with this object. Replace the request ID with a fresh `req_` plus UUID for each new job; keep the same ID when retrying that same submission.

```json
{
  "worker": "muse",
  "execution": "none",
  "assignment": {
    "schema_version": 1,
    "request_id": "req_REPLACE_WITH_NEW_UUID",
    "brief": "Write one sentence explaining why a finished job still needs owner review. Do not read files, run commands or call external services other than Dalan job tools.",
    "inputs": [],
    "expected_output": "One plain-text sentence.",
    "execution_scope": "read-only"
  }
}
```

Read the returned verdict and request ID. If the tool returns an error with reasons, fix the submission before proceeding. A queued job does not launch Muse. In your Muse conversation, send this instruction with the returned ID:

> Request REQUEST_ID is your only job: claim it with Dalan, do what its brief asks, report progress and finish it with the claim_id. Stop if it is missing or cancelled. Claim no other job.

Allow the job tool calls in Muse. Back in Codex, ask it to call `dalan_wait` with `{"request_id":"REQUEST_ID","timeout_seconds":120}`, then `dalan_result` with `{"request_id":"REQUEST_ID"}`.

A wait can stop for a question, blocker or cancellation as well as a result. Read the state. If it reports `timeout`, the job remains open; inspect it and wait again. The local tool defaults to 120 seconds and caps each wait at 300 seconds. This route defaults to no external result delivery, so read the result here.

**Check:** `dalan_result` returns `status: "finished"` and a report containing the sentence. Read the report's outcome and content; a finished state alone does not establish success or acceptance.

## 5. Accept or reject the result

The local MCP server has no decision tool. In your owner shell, replace `REQUEST_ID` and choose one command.

Accept a satisfactory answer:

```sh
dalan decide REQUEST_ID accepted --json
```

Reject an answer that is not useful:

```sh
dalan decide REQUEST_ID not_useful --json
```

Do not use `rejected`: it is not a supported decision word. This records your review; it does not apply a patch or merge code.

**Check:** the command succeeds and returns the recorded decision in its JSON response.

## Troubleshooting

- **The public check fails.** Run `dalan doctor --auth` and read its failing step. Running `dalan service install` again with the same options is safe; it changes nothing that already works.
- **The sign-in page says `Not accepting connections` or `Connection attempt invalid or expired`.** Open a new pairing window with `dalan connect start --worker muse`, restart sign-in in Muse, and compare the new code with `dalan connect pending`.
- **Registration is refused.** The bridge refuses a redirect that is not a valid HTTPS URL, or that carries credentials or a fragment. Read the reason, compare the redirect with what Muse's connection flow shows, then restart sign-in. Do not approve a connection whose redirect you cannot match to the client you started.
- **Codex cannot reach the bridge.** A CLI error beginning `cannot reach the bridge:` means the selected home's bridge is not running. Run `dalan status --json` and `dalan service status` in an owner shell. If the Codex entry sets `DALAN_HOME`, check that it is the absolute path of the running bridge's home. Do not register the public URL as Codex's requester endpoint.
- **Approval says the worker already has an active connection.** Inspect `dalan connect list`. Continue with the existing intended Muse connection, or deliberately revoke it before pairing again. Do not approve a different client just because it calls itself Muse.

## Removal

First disconnect the worker while the bridge is running:

```sh
dalan connect revoke muse
dalan connect stop
```

Remove the remote MCP server from Muse. Remove only the `mcp_servers.dalan` entry you added to Codex's configuration and start a new Codex session.

Remove this dedicated service and its public route:

```sh
dalan service uninstall
```

This command moves the bridge home, including its keys and job history, aside and does not delete it; delete the moved directory when you want the data gone. See [service removal](service-setup.md#remove-the-service).
