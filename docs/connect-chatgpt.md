# Connect ChatGPT as a Dalan worker

This guide takes you from a built-in OAuth connection to one completed job. Dalan accepts any MCP client that supports OAuth with Dynamic Client Registration (DCR) and PKCE; ChatGPT is one example, and the steps below are optional conveniences for it. The owner runs Dalan and approves the connection by matching a code; the ChatGPT user connects the worker and starts its run. One person can perform both roles. Use ChatGPT on the web with custom MCP connections enabled for your account or workspace; UI labels can vary.

A client you have not listed here follows the same flow: give it the complete MCP URL, let it register itself, then compare the code and redirect in the pending attempt before you approve. Dalan shows a curated name and icon only when the redirect's exact HTTPS origin is a known one, such as `https://chatgpt.com`. That label is a convenience, not proof of who is connecting, and it never decides whether you may approve.

**Just trying it?** Follow the [README hosted trial](../README.md#quickstart). It prints the connector URL and steps for a short hosted demo, then returns the agent's report to your terminal. The rest of this guide sets up a permanent bridge.

## Owner setup

1. Follow the [service setup](service-setup.md): `dalan service install --worker NAME --route tailscale` creates the public HTTPS address. Use the service's worker name wherever this guide says `NAME`.

   ```sh
   dalan status
   dalan doctor --auth
   ```

   Status shows the running bridge. Read the complete MCP URL from the private connector URL file that install printed. It has the form `https://HOST/<secret>/mcp`; enter the actual URL only in connector setup. A localhost URL cannot reach the bridge from ChatGPT's servers.

2. Open a pairing window for that worker.

   ```sh
   dalan connect start --worker NAME
   ```

   The response shows an open window for `NAME`; the default is ten minutes. No callback list is needed: ChatGPT registers itself, and you compare its redirect when you approve.

## ChatGPT user setup

1. In ChatGPT web, enable custom connector creation. Open **Settings → Apps → Advanced → Developer mode**. Then open **Plugins → Create**, enter a connection name and the owner's complete MCP URL, and select **OAuth** authentication. If the UI instead shows **Plugins → plus → Add custom MCP server**, follow [worker onboarding section 3](chatgpt-worker-onboarding.md#3-add-pair-and-inspect-the-connector); the pairing and code-match checks are the same.

   Let ChatGPT discover the OAuth settings and select its offered Dynamic Client Registration, which registers this client with Dalan. Review the risk acknowledgement and choose **Create**. Do not enter static client credentials. A browser page should show a pairing code; keep it open.

2. Ask the owner to inspect the exact pending attempt on the bridge computer.

   ```sh
   dalan connect pending
   ```

   Match the code on the browser page, worker `NAME`, resource, client ID, redirect and requested scopes. The client name is untrusted text; a curated ChatGPT label appears only for an exact `https://chatgpt.com` redirect and does not replace the code match. ChatGPT may use the stable redirect or a callback-ID-specific redirect described in [Check the redirect](chatgpt-worker-onboarding.md#2-check-the-redirect-before-approval). If attempts are ambiguous or a value differs unexpectedly, resolve that before approval.

   ```sh
   dalan connect approve CODE --worker NAME
   ```

   The owner replaces `CODE` with the matched code. Approval should let the waiting browser return to ChatGPT. A saved connector is not yet proof of a working job.

3. As requester, save the [first-job JSON](manual-setup.md#submit-finish-and-read-the-result) from the manual setup with a new request ID, then submit it to this worker.

   ```sh
   dalan submit --worker NAME --execution none --deliver none --file first-job.json --json
   ```

   The response contains that request ID. In a new ChatGPT conversation, use **+** to attach the connector. Send the manual setup's worker prompt with this request ID. Submission alone does not start ChatGPT.

   After you start the worker, run wait and get in the requester shell.

   ```sh
   dalan wait REQUEST_ID
   dalan get REQUEST_ID
   ```

   Success is a finished report containing `bridge first report`. Read the report. If you accept it, record that decision.

   ```sh
   dalan decide REQUEST_ID accepted
   ```

## When connection fails

If ChatGPT says “Couldn't discover OAuth settings” or “Some app settings were rejected,” first check that the bridge is running (`dalan status --json` in the service's Home) and that ChatGPT has the complete HTTPS MCP URL, then inspect the discovery, registration, tunnel and TLS stages rather than assuming a single cause. Do not change authentication to get past the error. OpenAI does not document a universal port requirement for public custom MCP endpoints. See its [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [OAuth guide](https://developers.openai.com/plugins/build/auth).

HTTP 421 means the incoming Host does not match the configured public origin, including any non-default port. Preserve Host through the proxy; forwarding a different `X-Forwarded-Host` does not fix it. See [network setup](service-setup.md).

If the pairing window expired, open it again with `dalan connect start --worker NAME`, restart connection in ChatGPT and compare the new code with pending attempts. If registration is refused, read the reason, then compare the redirect's exact scheme, host and path with what ChatGPT shows for this connection. Public discovery probes do not prove browser approval, token exchange or authenticated MCP calls work.

This guide covers ChatGPT on the web; set up a mobile browser separately. Repeat the first job after you reconnect or change endpoint settings, and configure [wake hooks or schedules](pull-workers.md) only after manual jobs work.
