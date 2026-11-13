# ChatGPT cloud worker: manual first connection

This recipe is for a ChatGPT-hosted worker using a remote MCP connector with the bridge's built-in authorization server. Dalan's flow is generic: any MCP client that supports OAuth with Dynamic Client Registration (DCR) and PKCE can connect, and the owner approves it by matching the code. The ChatGPT steps here are optional vendor notes. It is not a Codex CLI requester setup, an API integration, or a claim that every paid account can run an unattended worker. The first acceptance test is **one repository-free text assignment, execution none, triggered manually**. No schedule or signal hook is part of onboarding.

The owner completes the setup and first-job checks below on the intended account and computer. The commands below are for a separately authorized operator.

## 1. Check features and the existing bridge

- Confirm that the intended account/workspace can add a custom remote MCP server, authorize it with OAuth, and invoke its tools in the intended cloud conversation. OpenAI says account/workspace policies govern custom MCP access; stop if the controls are absent rather than changing a subscription or policy. [Connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#add-the-mcp-server)
- Background runs, schedules, push wake and continuous execution are separate capabilities and not prerequisites for this manual smoke; ordinary chat access does not prove any of them.
- Have the owner complete the [public-service owner setup](service-setup.md#owner-setup) (`dalan service install --worker NAME --route <id>`, with an id from `dalan routes`). Retain the same service home, worker profile and private `resource-url` file throughout this recipe. Use an existing dedicated worker profile with no T3 capability and no allowed repositories. `NAME` below means that exact profile name, not the account display name. Do not change the profile to make a failed test pass.
- Use the existing public **HTTPS resource URL**, including its secret path and `/mcp`, from `<bridge-home>/resource-url` (mode 0600); never substitute the host root or an authorization endpoint. Prefer standard public port 443 for the trial. This is a conservative deployment choice, not a claim that OpenAI forbids other ports. OpenAI documents public HTTPS and authentication discovery for this path. [Endpoint requirements](https://developers.openai.com/plugins/deploy/connect-chatgpt#prepare-the-endpoint)
- Before account linking, have the owner verify the public surface from outside the private network: path-suffixed resource/authorization discovery returns 200; tokenless MCP returns 401; unsuffixed discovery, root and `/admin` return 404. The existing [live-trial public check](https://github.com/tnunamak/dalan/blob/main/scripts/live-trial/README.md#3-verify-from-outside-the-tailnet) reads the resource URL from a private file. Reuse its check, but not its job: that job is not this smoke.

## 2. Check the redirect before approval

**Do not paste a callback template, and do not edit any callback list.** The bridge accepts a structurally valid HTTPS redirect from a registering client and shows you the full redirect when you approve. Your job is to compare it. OpenAI directs operators to the exact production redirect shown on the MCP server's management page. Current documentation distinguishes callback-ID-specific `https://chatgpt.com/connector/oauth/{callback_id}` from stable `https://chatgpt.com/connector_platform_oauth_redirect`; stable selection depends on issuer-identification support, with an older-server exception. This recipe does not assume which mode the pinned bridge will select. [Redirect rules](https://developers.openai.com/plugins/build/auth#redirect-url)

The same source documents protected-resource discovery, Dynamic Client Registration (DCR) through `registration_endpoint`, and Client ID Metadata Documents (CIMD) as a different client-identity path. DCR registers a client; CIMD does not. A predefined/static OAuth client instead requires an already registered ID and matching client-authentication method. A static client secret is not a bearer token. [OAuth/client registration](https://developers.openai.com/plugins/build/auth#oauth-flow)

For this built-in recipe, use DCR only if offered and compatible. This recipe covers Dynamic Client Registration; other registration methods need separate instructions from the owner. Do not invent credentials, switch issuers, add headers, or modify discovery/auth policy. If only another method is available, stop and ask the owner for that separately validated path.

Owner sequence:

1. For a normal first connection, follow [Connect ChatGPT](connect-chatgpt.md). Open the short pairing window on the bridge host:

   ```sh
   dalan connect start --worker NAME
   ```

2. When ChatGPT registers, read the redirect in the pending attempt. Check HTTPS, the exact host `chatgpt.com` and the full path, including any connection-specific suffix. A curated ChatGPT name or icon appears only when the redirect's exact origin is `https://chatgpt.com`; a lookalike host, another port or plain HTTP shows only the generic label. The label is a convenience and never a reason to approve. The bridge refuses callback queries that change the redirect, fragments and credentials. The `as_registration_refused` log records no callback details; it is not a callback source. [Bridge callback handling](https://github.com/tnunamak/dalan/blob/main/scripts/live-trial/README.md#4-pair-fixture-a-and-allow-its-callback)

If the redirect differs from what ChatGPT showed, do not approve; restart the connection. Record the redirect that ChatGPT showed so you can compare it with the pending attempt.

## 3. Add, pair and inspect the connector

The current documented entry is **ChatGPT Plugins → plus → Add custom MCP server**. Supply a descriptive name and the bridge's exact resource URL, configure OAuth, review the risk warning, and create the personal plugin. Do not copy the quickstart's unauthenticated example. Inspect the discovered tools and install only for the intended account. [Connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#add-the-mcp-server), [personal-plugin quickstart](https://developers.openai.com/plugins/quickstart)

If the UI instead shows **Settings → Apps → Advanced → Developer mode** and **Plugins → Create**, follow [ChatGPT user setup](connect-chatgpt.md#chatgpt-user-setup); the pairing and code-match checks are the same. For other UI differences, use current official guidance for the screen actually present.

During the owner-initiated browser flow:

```sh
dalan connect pending
```

Compare the browser pairing code **exactly** with the local pending code. Check the expected worker, client ID, full callback, resource and scopes; a familiar client name, curated label or vendor redirect does not establish which account initiated the flow. Approve only the matching code, within the 10-minute window:

```sh
dalan connect approve CODE --worker NAME
```

These are bridge pairing requirements, not vendor UI claims. A missing/mismatched code, unexpected scopes or expired window is a stop, not permission to approve an entry without code comparison over a trusted channel. [Bridge pairing flow](https://github.com/tnunamak/dalan/blob/main/scripts/live-trial/README.md#4-pair-fixture-a-and-allow-its-callback)

Before a job, inspect the actual connected catalog. The text smoke needs `list_pending`, `get`, `claim`, `progress` and `finish`; `ack_message` is useful only for messages. With the global T3 switch off, a modern process catalog omits `t3_thread_*` and advertises `notify_owner` to every worker; a worker without `t3` must still receive a denied result if it calls that tool. Advertised names do not grant authority. Repository tools, if enabled on the existing host, are not needed and must not be called by this execution-none job. Missing tools or unexpected privilege are blockers, not reasons to expand the profile.

For stale schemas, OpenAI documents refreshing the connection and retesting in a new conversation. [Metadata refresh](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata) Verify that the refreshed tool catalog exposes optional `acquisition_id`. Do not infer that every client needs, or never needs, a new conversation. Inspect the live `claim` schema and record what actually refreshed; any new Work/Codex task needs its own required authorization.

## 4. One owner-submitted text smoke

Only after the owner authorizes a real trial, create the assignment locally. This generates a unique request ID and harmless nonce; it does not submit anything:

```sh
node --input-type=module > first-job.json <<'NODE'
import { randomUUID } from 'node:crypto';
const nonce = randomUUID();
console.log(JSON.stringify({
  schema_version: 1,
  request_id: `req_${randomUUID()}`,
  brief: `Text-only bridge smoke. Return exactly SMOKE ${nonce}. Do not access repositories, run checks, start other jobs, or change any state outside this assignment's claim/progress/finish lifecycle.`,
  inputs: [],
  scope_paths: [],
  execution_scope: 'read-only',
  expected_output: `A completed text report containing exactly SMOKE ${nonce}.`
}, null, 2));
NODE
```

The distinction matters: **`execution_scope` is `read-only`; executor selection is separately `--execution none`**, not `execution_scope: "none"`. No repository input or repository grant is required. The owner submits to the existing selected profile with quiet delivery (the default):

```sh
dalan submit --worker NAME --execution none --file first-job.json
dalan get REQUEST_ID --json
```

Use the `request_id` from the submit response for `REQUEST_ID`. Save the JSON and that ID; if the response is lost, retry the identical file/ID, not a new job. Confirm `execution` is `none` and the intended target worker before continuing.

Manually ask the already authorized cloud conversation to do exactly this (replace `REQUEST_ID` with the confirmed ID and explicitly select the connected bridge):

> Check the bridge once for REQUEST_ID only. Read it with get and stop if cancelled, revoked, mismatched or outside this text-only scope. Use list_pending to locate it. Before claiming, generate and privately save one random acquisition_id for this run. Never print this claim nonce (acquisition_id), even in diagnostics, examples or reports. Keep it in private saved run state and reuse it only for this acquisition. Use your stable claimant and that same acquisition_id on every claim retry. Save only the claim_id directly returned by your claim; do not borrow a grant from get. Read owner notes, send progress, echo the assigned nonce through a completed text finish using the current tool schema, then stop. Do not claim another job, call repository/check tools, create a Work/Codex task, invoke a model API, or add a schedule.

For ChatGPT's documented direct plugin invocation, select the plugin using `@` in the intended authorized conversation; this is not permission to start a new Work task. [Official quickstart](https://developers.openai.com/plugins/quickstart) No push delivery or scheduled wake is assumed. A blocker must go through `progress` to the submitting owner, not to an unrelated person.

After the worker finishes, the owner reads the bridge record, not just the chat reply:

```sh
dalan get REQUEST_ID --json
```

Confirm that the job's status is `finished` and its report outcome is `completed`. Check the intended worker, execution `none` and the exact `SMOKE` value from `first-job.json`. A chat answer without the matching bridge report is not completion. After reviewing the report, run `dalan decide REQUEST_ID accepted`. Stop after this one job; repository work and recurring runs need their own setup.

## 5. Limits and owner acceptance record

Keep a redacted ledger with date, account/workspace feature availability, bridge commit, worker profile, public-surface results, exact redirect **source**, chosen registration method, matching-code result, displayed tool names/schema, request ID, manual trigger time, claim/finish result and owner `get` result. Keep resource URLs, private URLs, codes, claim/acquisition IDs, tokens and client secrets out of shared evidence.

Do not mark the journey accepted until the owner completes every required check on the intended account and computer. This recipe covers manual jobs with Dynamic Client Registration on ChatGPT web. Other registration methods, mobile or older UI variants, long-lived refresh and unattended wake need separate setup instructions.

If a gate fails, report the exact step, sanitized error and next observation to the submitting owner. Leave schedules off, do not create another job to hide the failure, and use the owner's existing teardown plan for any authorized trial exposure. This page authorizes no login, settings, subscription, permission or host-network change.
