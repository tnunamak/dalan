# Claude cloud worker: manual first connection

This recipe connects a Claude-hosted conversation to the bridge's built-in authorization server through a remote MCP custom connector. It is not Claude Code's local MCP/requester flow or a Messages API integration. Start with **one repository-free text assignment, execution none, triggered manually**. Do not enable a schedule, hosted background feature or signal hook for the first smoke.

For a new hosted-worker installation, begin with [Run Dalan as a service](service-setup.md#owner-setup), using a public HTTPS origin and your selected worker `NAME`. A provider-hosted connector cannot reach the README's loopback trial. Install the checkout using [owner and requester setup](manual-setup.md#owner-and-requester-setup), then follow the service guide rather than starting the loopback server. Keep the service's bridge home and worker identity throughout pairing, submission and result retrieval.

The owner completes the setup and first-job checks below on the intended account and computer. All commands below are for a separately authorized operator.

## 1. Check features and the existing bridge

- Confirm that this account/workspace can add or use a custom remote MCP connector, perform OAuth, enable it in a conversation, and call the required tools. On managed plans, organization role and connector access matter; the official help page describes owner setup before member connection. A plan label alone is not an access test. [Custom connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- Unattended execution and background-worker availability are separate observations. An interactive manual smoke proves neither. If a required connector control is absent, stop and have the owner verify access; do not upgrade, change roles, or add a subscription.
- Complete [service setup](service-setup.md#owner-setup), put `dalan` on your PATH, and export `DALAN_HOME` to the generated service home. Use a dedicated worker with no T3 capability and no allowed repositories for this first job. `NAME` below means that worker's profile name, not the account display name.
- Supply the public **HTTPS resource URL** from the private `<bridge-home>/resource-url` file, including its secret path and `/mcp`. Do not use the origin, an OAuth endpoint or localhost. Claude's remote connector traffic originates from Anthropic infrastructure, even when the UI is on a local device. [Network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp#network-requirements)
- Prefer public HTTPS port 443 as a simple trial default, not an asserted Claude port restriction. Have the owner verify path-suffixed resource/authorization discovery (200), tokenless MCP (401), and unsuffixed discovery/root/`/admin` (404) from outside the private network. The [public-surface checker](https://github.com/tnunamak/dalan/blob/main/scripts/live-trial/README.md#3-verify-from-outside-the-tailnet) consumes a private resource-file value; do not reuse an unrelated example job.

## 2. Allow the sourced callback, then choose registration

Anthropic documents this exact callback for hosted Claude surfaces:

```text
https://claude.ai/api/mcp/auth_callback
```

Claude Code uses a different loopback flow; do not weaken the bridge's HTTPS callback policy to accommodate it in this cloud-worker recipe. [Official callback URLs](https://claude.com/docs/connectors/building/authentication#callback-urls)

On the bridge host, **before registration**:

```sh
dalan connect allow-callback 'https://claude.ai/api/mcp/auth_callback'
dalan connect start --worker NAME
```

The current custom-connector UI distinguishes automatic registration, a published Client ID Metadata Document (CIMD), and a supplied OAuth client. Choose **Register automatically** for this Dynamic Client Registration (DCR) recipe, not the published-identity default simply because it is recommended in the UI. [Connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

DCR discovers `registration_endpoint` and creates the client. A static OAuth client requires the owner to register the exact redirect first and supply the matching client ID/authentication credentials; it is not a static request-header token. CIMD is another identity method, not DCR. [Claude authentication](https://claude.com/docs/connectors/building/authentication#register-claude-as-an-oauth-client)

This recipe covers automatic client registration; other registration methods need separate instructions from the owner. If automatic registration is absent or fails, stop and ask for an owner-validated variant; do not invent client credentials, switch to no-auth, add bearer headers, change issuers or broaden callback patterns. Verify a differing callback against current official hosted-surface documentation before making any allowlist change.

## 3. Add, pair and inspect the connector

For the documented individual-account path, open **Customize → Connectors**, use **+ Add**, then **Add custom connector**. Enter the name and exact resource URL, review detected authentication, and choose OAuth sign-in plus automatic registration. Managed workspaces follow the owner/member steps in the same source rather than this individual's path. [Official setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

If the screen differs, record the current labels and the role and access outcome before you proceed.

In the browser flow you initiated, wait for the bridge's pairing code. On the owner host:

```sh
dalan connect pending
```

Compare the browser and local codes exactly. Check the requested worker, full callback, resource, scopes and client ID. The client name and `claude.ai` hostname alone cannot identify the initiating account. Approve only the matching code within the 10-minute pairing window:

```sh
dalan connect approve CODE --worker NAME
```

These are bridge requirements. A code mismatch, expired window or unexpected callback/scope means stop, not auto-approve. The `as_registration_refused` DCR-refusal log records no callback details; never reconstruct an allowlist entry from it. [Bridge pairing requirements](https://github.com/tnunamak/dalan/blob/main/scripts/live-trial/README.md#4-pair-fixture-a-and-allow-its-callback)

Anthropic's test guide says to verify connected state, review **Tool permissions**, then enable the connector from **+ → Connectors** in a chat and confirm an actual tool call. [Test guide](https://claude.com/docs/connectors/building/testing#test-in-claude-as-a-custom-connector)

For this smoke, require `list_pending`, `get`, `claim`, `progress` and `finish`; `ack_message` is only for messages. With global T3 tools disabled, the process-wide catalog omits `t3_thread_*` and still advertises `notify_owner`; the worker's missing `t3` capability must make a direct `notify_owner` call fail. Advertised names do not grant authority. Repository tools may depend on existing host configuration, but are unnecessary and must not be called for the execution-none job. Verify the actual `claim` schema, including optional `acquisition_id`, instead of importing ChatGPT's refresh behavior. Missing tools or excess privileges are owner blockers; do not expand policy.

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

Use the connector you enabled in the intended Claude chat. Push delivery and scheduled wake are not assumed. A blocker must go through `progress` to the submitting owner, not to an unrelated person.

After the worker finishes, the owner reads the bridge record, not just the chat reply:

```sh
dalan get REQUEST_ID --json
```

Confirm that the job's status is `finished` and its report outcome is `completed`. Check the intended worker, execution `none` and the exact `SMOKE` value from `first-job.json`. A chat answer without the matching bridge report is not completion. After reviewing the report, run `dalan decide REQUEST_ID accepted`. Stop after this one job; repository work and recurring runs need their own setup.

## 5. Limits and owner acceptance record

Record a redacted date/account-feature/bridge-commit ledger: worker profile, public-surface outcomes, official callback source and actual match, DCR selection, exact pairing-code comparison outcome, displayed catalog/schema, request ID, manual trigger, claim/finish result and owner `get`. Keep resource URLs (they contain the secret path), codes, credentials and claim/acquisition IDs out of shared evidence.

Acceptance requires the intended account and computer to pass every check. This recipe covers manual jobs with automatic registration. Other registration methods, long-lived token refresh, hosted background execution, automatic wake and schedules need separate setup instructions.

If a gate fails, send the exact failed step, sanitized error and required next observation to the submitting owner. Do not start a replacement job or change the profile to hide the failure. Keep recurring triggers disabled and use the owner's teardown plan for any authorized trial exposure. This recipe grants no authority for account, permission, subscription or host-network changes.
