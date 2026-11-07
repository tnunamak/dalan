# Security

## Report a vulnerability

Use GitHub private vulnerability reporting. Never put secrets, exploit details, or private host information in public issues or pull requests.

To file a report, open **Security** on [this repository's page](https://github.com/tnunamak/dalan), then **Advisories**, then select **Report a vulnerability**. You can also go straight to <https://github.com/tnunamak/dalan/security/advisories/new>. GitHub asks you to sign in first if you have not.

This route works only if the repository has private vulnerability reporting enabled. If **Report a vulnerability** is missing, open a new issue, choose **Request a private security reporting route**, and include no details. Send the report after a private route exists.

Include the affected revision, impact, and steps to reproduce with sanitized examples.

## Secret redaction

The bridge masks credentials in logs, alerts, errors, in the report text and progress notes it shows the owner, and in stored report artifacts. The local database keeps the exact text a worker sent, so protect the database and its backups. Redaction catches accidental leaks of registered secrets and known formats, including JSON-escaped spellings such as a `\u0073` escape inside a JSON string or key. It cannot stop a worker that deliberately encodes a secret it knows. Two cases pass unmasked: base64-embedded secrets and secrets split across log lines. See [docs/redaction.md](docs/redaction.md).

## Known limits

These are real gaps that are not fixed. Each has a test that pins today's behavior, so a change to it is deliberate.

- **Without a workers file, external OAuth maps every allowed subject to the single worker.** Every subject on `OAUTH_ALLOWED_SUBJECTS` is the one legacy worker (`dot`); that list is your explicit grant, so list only subjects you trust as that worker. The list is exact match only (no wildcard), and an absent or empty list refuses to start. With a `workers.json` in external mode, every connection record must name its `subject`; `client_id` and `connection_id` only narrow it. Pinned by `scripts/auth-cache-test.mjs` and `scripts/worker-isolation-test.mjs`.
- **Approving a replacement (`--replace`) hands the new client every queued and future job for that worker, including briefs approved before the switch.** Approve only a code you started yourself. The principal is the worker, not the OAuth client: replacement exists so a worker can switch clients or recover after a crash. The approve error and output name the worker and say this.
- **A replacement worker connection can read jobs approved for the connection it replaced.** `get` and `list_pending` are open to every authenticated connection of the worker. After the owner approves connection B in place of A, B can read the brief and title of a queued job that was approved for A. B can also claim a job that is still queued, because a claim checks only that the claimant connection is live and that the job's own destination is still approved. B cannot take over a claim that A already holds while its lease is unexpired, and a call bound to such a claim is fenced to the connection that holds it. Risk: disclosure of that job's text, and the right to claim it, to a connection the owner approved for the worker but did not approve for that job. Pinned by `ReadAdmitted/get` and `ReadAdmitted/list_pending` in `scripts/claim-statechart-http-test.mjs`; the formal model in `spec/tla/ClaimsReads.cfg` shows the same read.
- **A queued job with no deadline whose approved destination changed stays queued.** Every claim of it is refused with `destination_changed`, and nothing cancels it automatically. Risk: queue clutter only, no data exposure. The owner recovers it with cancel and resubmit under a new request ID, or by restoring the approved destination. Pinned by `QueueProgress known limit` in `scripts/claim-statechart-test.mjs`; `spec/tla/Queue.cfg` shows the same non-progress.

## Scope and support

Reports may cover the bridge server, OAuth and claim admission, worker sandboxing, and the CLI. The latest npm release and the latest commit on main are supported. Where safe, check that the issue still affects the latest release or main before you report it.

This project is maintained by one person. The maintainer will review reports as time allows and may ask for more information. There is no guaranteed response time and no bug bounty.
