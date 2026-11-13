# Portable worker live-trial kit

This kit creates a disposable built-in authorization server and one worker profile named `fixture-a`. The bridge always binds to `127.0.0.1`; workspace execution is off, and the profile gives fixture-a no T3 capability. The dry run uses a fake OAuth client and loopback HTTP only.

Requirements: Node.js 24 or newer. Run from the Dalan repository root. No Docker or root access is required.

Client compatibility must be verified with the chosen connector. For ChatGPT and Claude cloud workers, use the separate [ChatGPT](../../docs/chatgpt-worker-onboarding.md) and [Claude](../../docs/claude-worker-onboarding.md) recipes. They begin with a manual, repository-free, execution-none text smoke; do not reuse this kit's worker-targeted job or enable its optional wake hook as a first step.

## 1. Set up the trial

Choose a Gozar route whose public HTTPS origin you know. `dalan setup` lists what Gozar can offer on this computer; the origin of the route you choose is the `--public-url`. Read what `dalan setup` shows for that route before you approve it: whether the address is stable or temporary, and whether the route operator can read traffic.

```sh
DALAN_LIVE_TRIAL_APPROVE_ROUTE=1 node scripts/live-trial/setup.mjs \
  --worker fixture-a \
  --public-url https://<route-origin> \
  --port 8787 \
  --route ROUTE
```

Setup starts the bridge on loopback, then asks Gozar to open `ROUTE` to the bridge's local port. It records the route in the manifest. If Gozar allocates an origin other than `--public-url`, setup closes the route and stops. The route lasts four hours unless you set `--lifetime-seconds` (1 to 86400); Gozar ends it at that deadline even if teardown never runs. Setup refuses `--route` without an HTTPS `--public-url`, and an HTTPS `--public-url` without `--route`, so that teardown can always identify the public route. `DALAN_LIVE_TRIAL_APPROVE_ROUTE=1` records that you approved the route.

Setup prints the disposable home path and the path to a mode-0600 file that holds the MCP resource URL. Setup never prints the resource URL. Read that private file when you configure fixture-a. The resource URL is the only URL to paste into fixture-a; it discovers the OAuth endpoints. The legacy `--reveal-resource-url` flag is unsupported and is rejected before setup creates anything.

## 2. Check the route

The bridge remains bound to `127.0.0.1:8787`. Setup already opened the public route; there is no separate forwarding step. If setup stopped with an error, nothing is left running and the home is removed.

## 3. Verify from outside your network

From a separate machine outside your network, run the public-surface check with the resource URL from the private file printed by setup:

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

## 6. Close the route

Teardown closes the route. Run it after the job checks pass, and before that if you no longer need the public address.

## 7. Teardown

```sh
HOME='<home printed by setup>' node scripts/live-trial/teardown.mjs --home '<home printed by setup>'
```

Teardown asks Gozar to remove the recorded route and checks that it is gone. It then closes the pairing window, settles trial jobs, revokes the active connection, stops the bridge, checks that the loopback port is closed, checks for trial-specific launchd/systemd/cron entries, and removes the private home.

If Gozar cannot confirm removal, teardown exits non-zero before stopping the bridge and keeps the home. Follow its printed recovery instructions: ask Gozar which route serves the trial's origin, have it removed, then rerun teardown. Do not let another process bind the trial port while the route may still be public.

## What the live fixture-a run must check

- fixture-a accepts the resource URL and uses OAuth 2.0 Dynamic Client Registration, or a client-registration path compatible with the built-in AS.
- fixture-a sends the exact `resource` value, requests an authorization-code flow, and supports PKCE S256. The built-in AS rejects PKCE `plain` and missing PKCE.
- fixture-a's refused callback is not in the bridge log. The operator takes the callback from fixture-a's connector details, verifies the host belongs to the connector provider, allows that exact HTTPS callback, and fixture-a retries within the same pairing window. Its callback may vary by app, account, region, or connection attempt.
- fixture-a's client authentication method works with the built-in AS. The fake client uses `none`; verify the real client's authentication method against this server.
- fixture-a follows the browser pairing interaction and returns through the exact redirect URI with the authorization code and state intact.
- fixture-a supports the bridge's Streamable HTTP/MCP behavior and a protocol version the bridge advertises. The dry run covers JSON requests; it does not test fixture-a's SSE handling.
- The real connector receives the process-wide catalog selected by `DALAN_CATALOG_PROFILE` and `DALAN_ENABLE_T3_TOOLS`. With T3 tools globally disabled, `t3_thread_*` names are absent and `notify_owner` is advertised; verify that fixture-a cannot call it without the `t3` capability.
- Confirm how the worker schedules pulls and whether a completed assignment can be fetched within its polling window.
- The public route reaches only the loopback bridge listener. Confirm the selected route and close it during teardown.

## Dry run

Run the full loopback-only fake-client flow:

```sh
node scripts/live-trial/dry-run.mjs
```

The script removes its temporary home after every run. It opens no public route, and it does not contact an external connector provider.

## Wake signal for a hook

For a worker that supports periodic hooks, a hook can run a script without connector credentials. It can poll the public wake signal and wake an agent that then claims through the connector. Save the URL on the bridge computer. Configure the hook on that computer to read the private file; keep the value out of terminal output and logs:

```sh
SIGNAL_FILE=$(dalan connect signal-token)  # prints a path, never the URL
SIGNAL_URL=$(cat "$SIGNAL_FILE")                 # read privately; do not echo or enable shell tracing
curl -fsS "$SIGNAL_URL" | grep -q '"work":true' && wake
```

The answer is `{"work":true}` or `{"work":false}` and nothing else. Poll every 60 seconds. The bridge refreshes the answer every 10 seconds. See "Wake signal for hook-driven workers" in `docs/portable-auth-profile.md`.
