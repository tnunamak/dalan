# Portable worker live-trial kit

This kit creates a disposable built-in authorization server and one worker profile named `fixture-a`. The bridge always binds to `127.0.0.1`; workspace execution is off, and the profile gives fixture-a no T3 capability. The dry run uses a fake OAuth client and loopback HTTP only.

Requirements: Node.js 24 or newer. Run from the Dalan repository root. No Docker or root access is required.

Client compatibility must be verified with the chosen connector. For ChatGPT and Claude cloud workers, use the separate [ChatGPT](../../docs/chatgpt-worker-onboarding.md) and [Claude](../../docs/claude-worker-onboarding.md) recipes. They begin with a manual, repository-free, execution-none text smoke; do not reuse this kit's worker-targeted job or enable its optional wake hook as a first step.

## 1. Set up the trial

For a Mac using its normal Tailscale node:

```sh
node scripts/live-trial/setup.mjs \
  --worker fixture-a \
  --public-url https://<mac-node>.ts.net \
  --port 8787 \
  --exposure mac-funnel
```

For an optional Linux userspace-node deployment, record its socket path:

```sh
node scripts/live-trial/setup.mjs \
  --worker fixture-a \
  --public-url https://<sample-host-second-node>.ts.net \
  --port 8787 \
  --exposure linux-second-node \
  --tailscale-socket /run/user/<uid>/tailscale-second/tailscaled.sock
```

Setup starts the bridge on loopback, records the exact Funnel mode, socket (for Linux), public port `443`, and local port in the manifest. It does not run Tailscale. Setup also starts a detached cutoff timer. Unless you set `--cutoff-seconds`, the timer disables and verifies this rule four hours after setup, even if teardown is never run. Its log is `exposure-cutoff.log` in the trial home. If the Tailscale command or daemon is unavailable when the timer fires, keep the home and use the manual recovery commands in that log or printed by teardown. The deadline starts at setup, before Funnel is enabled. If it has passed, do not enable or re-enable the rule; disable and verify any existing rule, then start a fresh setup for another trial.

Setup prints the disposable home path and the path to a mode-0600 file that holds the MCP resource URL. Setup never prints the resource URL. Read that private file when you configure fixture-a. The resource URL is the only URL to paste into fixture-a; it discovers the OAuth endpoints. The legacy `--reveal-resource-url` flag is unsupported and is rejected before setup creates anything.

## 2. Enable the trial forward

The bridge remains bound to `127.0.0.1:8787`. Enable only its Funnel endpoint on public HTTPS port 443.

On Mac:

```sh
tailscale funnel --bg --https=443 http://127.0.0.1:8787
```

On the Linux trial host, use the userspace node's own CLI socket:

```sh
tailscale --socket /run/user/<uid>/tailscale-second/tailscaled.sock \
  funnel --bg --https=443 http://127.0.0.1:8787
```

If using a separate userspace node, use only that node's socket; verify its startup and authentication before the trial.

## 3. Verify from outside the tailnet

From a separate machine outside the tailnet, run the public-surface check with the resource URL from the private file printed by setup:

```sh
RESOURCE_FILE='<private resource URL file printed by setup>'
node scripts/live-trial/check-public.mjs < "$RESOURCE_FILE"
```

The script prints four checks and does not print the secret-bearing URL:

- Path-suffixed protected-resource and authorization-server discovery return `200`.
- Unsuffixed discovery and root routes return `404`.
- MCP without a token returns `401`.
- `/admin` returns `404`.

All four must pass before you pair fixture-a. A connection or TLS failure means the public forward is not ready.

## 4. Pair fixture-a and allow its callback

1. Start the short owner pairing window before fixture-a registers:

   ```sh
   HOME='<home printed by setup>' node bin/dalan.mjs connect start --worker fixture-a
   ```

2. Add a custom MCP connector in fixture-a. Paste only the resource URL from the private file printed by setup. Let fixture-a begin OAuth and client registration.

3. If registration is refused because fixture-a's callback is not allowlisted, confirm the refusal in the bridge request log:

   ```sh
   TRIAL_HOME='<home printed by setup>'
   rg '"kind":"as_registration_refused"' "$TRIAL_HOME/.local/state/dalan/requests.jsonl"
   ```

   This `as_registration_refused` event covers a DCR refusal. A later callback error on the authorization page is a separate failure and does not produce this registration event. The event has only `at` and `kind` fields; it records no callback details and no request data. Take the complete HTTPS callback from fixture-a's connector details, verify that its host belongs to the connector provider, enter it as data, then allow it:

   ```sh
   printf 'Verified HTTPS callback URL: '
   IFS= read -r CALLBACK_URL
   HOME='<home printed by setup>' node bin/dalan.mjs connect allow-callback "$CALLBACK_URL"
   unset CALLBACK_URL
   ```

   fixture-a must retry registration within the same pairing window. Do not close or restart the window. If registration is still refused, compare the exact callback in fixture-a's connector details, including its scheme and port. A `*` can match one path segment, so inspect the path before allowing it. Queries, fragments, credentials, and non-HTTPS callbacks are refused. If registration was accepted without a refusal, continue to the pending request.

4. Inspect the pending request:

   ```sh
   HOME='<home printed by setup>' node bin/dalan.mjs connect pending
   ```

5. Compare the pairing code shown in fixture-a's browser with the code in `connect pending`; they must match exactly. Check that the callback host belongs to the connector provider, then check the callback path, resource, scopes, and client ID. Do not trust the client name. Approve only the exact code you compared:

   ```sh
   PAIRING_CODE='<code that matched in the browser and connect pending>'
   HOME='<home printed by setup>' node bin/dalan.mjs connect approve "$PAIRING_CODE" --worker fixture-a
   ```

   The browser flow must complete before the 10-minute pairing window expires. A valid vendor callback cannot prove which vendor account started the flow; start the connection yourself and compare the displayed code, as described in `docs/portable-auth-profile.md`.

## 5. Submit and verify one job

Submit one quiet-delivery text assignment to fixture-a and one same-shape control assignment to the default worker:

```sh
HOME='<home printed by setup>' node scripts/live-trial/job.mjs --home '<home printed by setup>'
```

The worker job includes a random nonce and waits for its report. It prints whether the report echoed the nonce. The default-worker-targeted control job must remain queued and unclaimed.

Check the owner-side records:

```sh
HOME='<home printed by setup>' node scripts/live-trial/verify.mjs --home '<home printed by setup>'
```

The verifier checks the active connection binding, claim and report attribution, nonce, target isolation, and that the profile has no T3 capability. A dry run also authenticates as the fake worker and checks actual `tools/list`, denied optional-tool calls, cross-worker claim denial, and the unknown-worker 403 boundary. The live connector holds its own OAuth token, so the owner verifier cannot inspect fixture-a's live `tools/list`; check that it receives the process-wide catalog selected by the configured profile and global T3 switch, and that calls without `t3` are denied.

The current built-in AS returns 401 for a revoked or unknown opaque token. It returns 403 when a valid token names a worker that is absent from the configured profile. The dry run checks both cases.

## 6. Disable and verify the forward

After the job checks pass, disable the exact rule that you enabled. The Tailscale CLI reference documents this `off` form and `funnel status --json` ([Tailscale Funnel CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel)).

On Mac:

```sh
tailscale funnel --bg --https=443 http://127.0.0.1:8787 off
tailscale funnel status --json
```

On the Linux trial host:

```sh
tailscale --socket /run/user/<uid>/tailscale-second/tailscaled.sock \
  funnel --bg --https=443 http://127.0.0.1:8787 off
tailscale --socket /run/user/<uid>/tailscale-second/tailscaled.sock \
  funnel status --json
```

Confirm that no `AllowFunnel` endpoint has a `Web` handler whose `Proxy` targets local port `8787`. If the off command fails or status cannot prove the route is gone, leave the bridge running and keep the trial home. Do not let another process bind the trial port while it may still be public.

## 7. Teardown

Run teardown after the public forward is disabled and verified:

```sh
HOME='<home printed by setup>' node scripts/live-trial/teardown.mjs --home '<home printed by setup>'
```

Teardown repeats Funnel off and status verification using the recorded mode, socket, and ports. It cancels the cutoff timer only after Funnel is confirmed clear. It then closes the pairing window, settles trial jobs, revokes the active connection, stops the bridge, checks that the loopback port is closed, checks for trial-specific launchd/systemd/cron entries, and removes the private home.

If Funnel off fails or status still shows the trial route, teardown exits non-zero before stopping the bridge and keeps the home. Follow its printed recovery instructions, verify the public route is gone, and rerun teardown. `--check-tailscale` adds status output after the teardown work; it does not replace the mandatory off/status gate.

## What the live fixture-a run must check

- fixture-a accepts the resource URL and uses OAuth 2.0 Dynamic Client Registration, or a client-registration path compatible with the built-in AS.
- fixture-a sends the exact `resource` value, requests an authorization-code flow, and supports PKCE S256. The built-in AS rejects PKCE `plain` and missing PKCE.
- fixture-a's refused callback is not in the bridge log. The operator takes the callback from fixture-a's connector details, verifies the host belongs to the connector provider, allows that exact HTTPS callback, and fixture-a retries within the same pairing window. Its callback may vary by app, account, region, or connection attempt.
- fixture-a's client authentication method works with the built-in AS. The fake client uses `none`; verify the real client's authentication method against this server.
- fixture-a follows the browser pairing interaction and returns through the exact redirect URI with the authorization code and state intact.
- fixture-a supports the bridge's Streamable HTTP/MCP behavior and a protocol version the bridge advertises. The dry run covers JSON requests; it does not test fixture-a's SSE handling.
- The real connector receives the process-wide catalog selected by `DALAN_CATALOG_PROFILE` and `DALAN_ENABLE_T3_TOOLS`. With T3 tools globally disabled, `t3_thread_*` names are absent and `notify_owner` is advertised; verify that fixture-a cannot call it without the `t3` capability.
- Confirm how the worker schedules pulls and whether a completed assignment can be fetched within its polling window.
- Public HTTPS port 443 reaches only the loopback bridge listener. Confirm the selected Mac Funnel or Linux trial host route and turn it off during teardown.

## Dry run

Run the full loopback-only fake-client flow:

```sh
node scripts/live-trial/dry-run.mjs
```

The script removes its temporary home after every run. It does not run Tailscale, Funnel, or any tunnel command, and it does not contact an external connector provider.

## Wake signal for a hook

For a worker that supports periodic hooks, a hook can run a script without connector credentials. It can poll the public wake signal and wake an agent that then claims through the connector. Save the URL on the bridge computer. Configure the hook on that computer to read the private file; keep the value out of terminal output and logs:

```sh
SIGNAL_FILE=$(dalan connect signal-token)  # prints a path, never the URL
SIGNAL_URL=$(cat "$SIGNAL_FILE")                 # read privately; do not echo or enable shell tracing
curl -fsS "$SIGNAL_URL" | grep -q '"work":true' && wake
```

The answer is `{"work":true}` or `{"work":false}` and nothing else. Poll every 60 seconds, or every 300 seconds when the exposure is ngrok (`signal-token` prints the interval on stderr). The bridge refreshes the answer every 10 seconds. See "Wake signal for hook-driven workers" in `docs/portable-auth-profile.md`.
