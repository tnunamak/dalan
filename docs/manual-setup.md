<a id="step-by-step"></a>

# Manual setup

`try` runs ordinary `dalan` commands in a private trial home. Use this page to run each piece yourself: to keep the bridge in the foreground, to choose your own worker name, or to set up a client that `try` does not cover. You need a [checkout](../README.md#from-source), two shells and a worker client with OAuth.

<a id="owner-and-requester-setup"></a>

## Owner and requester setup

1. Clone and install Dalan, and put `dalan` on your PATH.

   ```sh
   git clone https://github.com/tnunamak/dalan.git
   cd dalan
   node --version
   npm ci
   npm link
   ```

   **Check:** Node prints `v24` or higher, and npm finishes without an error. The server in step 3 starts Node with a changed `HOME`, so use a Node executable that works then; a version-manager shim can depend on your usual home directory.

2. Choose a new, private bridge home. It must not exist yet and must not be a `try` home (`init` refuses an existing profile). Export it in every shell that you use, including the server shell; `dalan` reads it as the bridge's home. Keep paths short and free of spaces.

   ```sh
   export DALAN_HOME="$HOME/.local/share/dalan-manual-trial"
   ```

   If you forget this in a new shell, `dalan` stops with `DALAN_HOME is not set` while the default trial home exists. Without a trial home, it uses your normal home, and `dalan status --json` then shows an unexpected bridge or fails. In both cases, export the variable again.

3. Create the worker profile and start the bridge on loopback with built-in OAuth. The listener binds only `127.0.0.1`, and every MCP call still needs an approved OAuth token.

   ```sh
   export DALAN_LOOPBACK=1 DALAN_AUTH_MODE=builtin DALAN_PORT=8799
   dalan init --worker local --public-url http://127.0.0.1:8799
   HOME="$DALAN_HOME" DALAN_LOOPBACK=1 DALAN_AUTH_MODE=builtin DALAN_PORT=8799 node src/server.mjs
   ```

   **Check:** `init` reports a new worker profile for `local`, and the server prints `MCP listening on 127.0.0.1:8799` and keeps running. Leave this terminal open: closing it stops the bridge. If you plan a repository job, add `DALAN_ENABLE_WORKSPACE=1` to the server command now to save a restart. If the port is taken, choose another free port in both commands.

4. In a second shell, export the same `DALAN_HOME`, then check the bridge.

   ```sh
   dalan paths --json
   dalan status --json
   dalan doctor --json
   ```

   **Check:** `config_dir` is inside your bridge home, and status returns the queue state. Doctor may say that host checks are unavailable; the first job does not need them. A socket connection error means the server is not running or this shell uses another home. (`DALAN_PORT` sets the MCP listener port, not the admin socket, which is derived from the home.)

<a id="worker-setup"></a>

## Worker setup

1. **Allow the client's callback and open a pairing window**, both before you add the connection in the client. Find your client's callback URI, then allow the narrowest pattern for it: its exact host and path. For example, Codex CLI uses `http://127.0.0.1/callback` and Claude Code uses `http://localhost/callback`.

   ```sh
   dalan connect allow-callback 'CALLBACK_PATTERN'
   dalan connect start --worker local
   ```

   The [callback pattern rules](setup-reference.md#callback-patterns) list what a pattern may contain and what it matches.

   **Check:** `dalan connect pending` shows an open window for `local`. The window stays open for 10 minutes (`--minutes N` changes it); if it reports `No pairing window is open`, run `dalan connect start --worker local` again.

2. **Add the connection in the client**, on the same computer. The MCP URL is `http://127.0.0.1:8799/SECRET/mcp`, where `SECRET` is the `BRIDGE_PATH_SECRET` value in `$DALAN_HOME/.config/dalan/env` (on an older, unmigrated home: `$DALAN_HOME/.config/dot-bridge/env`). Keep the URL private. Choose OAuth authentication. Codex CLI starts the sign-in as soon as you add the connection; the [Codex recipe](worker-clients.md#native-cli-worker-codex-cli) shows the order.

3. **Approve the sign-in.** Start the sign-in in the client and keep the browser page with the pairing code open. In the owner shell, inspect the pending attempt, then approve it. A client on this computer with a loopback callback is a native client; its approval needs `--confirm-redirect` with the exact redirect that `pending` shows.

   ```sh
   dalan connect pending
   dalan connect approve CODE --worker local --confirm-redirect REDIRECT
   ```

   For a hosted client with an HTTPS callback, leave out `--confirm-redirect` (the command refuses it there):

   ```sh
   dalan connect approve CODE --worker local
   ```

   Before you approve, compare the code with the browser page and check the redirect. `pending` shows the MCP URL with the secret hidden as `<secret>`; check its scheme, host, port and the `/mcp` ending. Expect the scopes `dalan.read dalan.work`. The older names `dot-bridge.read dot-bridge.work` give the same access. Dalan also accepts `openid` and two optional integration scopes, `t3.read` and `t3.write`; in this version those two give no extra access, but do not approve a scope that you did not expect. The client name comes from the client and proves nothing about its identity, and `--confirm-redirect` only catches a typo.

   For a native client, each attempt has its own code: approving one code approves no other. For a hosted client, only the newest attempt can be approved. When the worker is on another person's computer, they read the code from their browser page and tell you over a trusted channel.

   **Check:** the browser returns to the client, which now lists Dalan's tools, including `list_pending` and `claim`.

<a id="submit-finish-and-read-the-result"></a>

## Submit, finish and read the result

Any shell or coding agent that can run `dalan` can be the requester. Run these commands with `dalan` on your PATH and `DALAN_HOME` set to the bridge home.

1. Make a request ID with `node -e "console.log(require('node:crypto').randomUUID())"`, then save this job as `first-job.json` with that ID. Never reuse another job's ID, and keep the file for retries.

   ```json
   {
     "schema_version": 1,
     "request_id": "req_<stable UUID>",
     "brief": "Report the exact phrase: bridge first report. Do not read files, run commands or call external services.",
     "inputs": [],
     "expected_output": "Text report containing: bridge first report.",
     "execution_scope": "read-only"
   }
   ```

   ```sh
   dalan submit --worker local --execution none --deliver none --file first-job.json --json
   ```

   **Check:** the response contains your `request_id`; use it as `REQUEST_ID` below. If the response is lost, submit the same file with the same options again: the bridge recognizes the same job.

2. In the worker client, send this prompt with your request ID:

   > Request REQUEST_ID is your only job: claim it with Dalan, do what its brief asks, report progress and finish it with the claim_id. Stop if it is missing or cancelled. Claim no other job.

   The worker calls `list_pending`, `claim`, `progress` and `finish`.

3. Wait for the result and read the report.

   ```sh
   dalan wait REQUEST_ID
   dalan get REQUEST_ID
   ```

   **Check:** the job is finished and its report contains `bridge first report`. If nothing happens, the job is only queued: send the prompt in step 2. If `wait` times out, inspect the job with `get` and ask the worker to check Dalan again.

   To find results later, for example after a restart, run `dalan inbox --all --json`. It covers the last 72 hours; add `--since` for older results. In a fresh shell with no session ID, plain `dalan inbox` lists every receipt in this bridge home. A resumed agent can have a different session label from its earlier one: use the saved label with `--producer ID`, or `--all` to list every receipt.

4. Review the report and record your decision.

   ```sh
   dalan decide REQUEST_ID accepted
   ```

   **Check:** the response records `accepted`. Review a real report or patch before you accept or apply it. When you are done, press Ctrl-C in the server terminal. Keep the bridge home if you need its receipts or connection again.
