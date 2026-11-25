# Muse hosted-performer acceptance sheet

## Purpose
Prove that Muse can complete and resume bounded research jobs through its hosted MCP connection without depending on a live requester turn.

## Setup
Freeze this sheet and record its revision before starting. This is a test plan, not a passing trial.

Use Node.js 24 or newer and a private, disposable Dalan trial home. Start `dalan try --public` in an interactive terminal. Complete Muse's MCP sign-in and approve the intended connection. Keep the connector URL private. Record the actual worker name; never infer it from the product name.

Export the printed trial home as DALAN_HOME in each observer shell. Keep the bridge running separately from the requester session. Capture `dalan status` before each job. Initial installation, connection approval and route setup are setup touches, recorded separately from routine touches.

Sources: src/try.mjs#runTry; docs/local-agent-requester.md#Instructions-to-paste. Public mode delegates to the hosted flow; a local self-check is not hosted evidence.

## Order of jobs
1. **Harmless report.** The source's submit helper creates a version-1 request with a fresh request ID, empty inputs, read-only execution scope, and expected output “Text report containing: bridge first report.” Its exact brief is: “Report the exact phrase: bridge first report. Do not read files, run commands or call external services.” Submission uses execution none and delivery none. Muse must claim the hosted job and finish with exactly `bridge first report`. Record the actual assignment from `dalan get REQUEST_ID --json`; stop if the hosted job differs instead of silently changing the criterion. The built-in demo's report does not qualify. Sources: src/try.mjs#BRIEF, src/try.mjs#REPORT, src/try.mjs#runTry.

2. **Continuing research.** Submit one text-only job with this supplied packet: “Option A takes two days and costs three units. Option B takes four days and costs one unit.” Ask Muse to compare the options. After the requester turn ends, Muse must ask exactly one question: “Which matters more: time or cost?” Answer once: “Time.” Muse must then recommend A, cite the supplied durations and costs, and explain the tradeoff. No external research is permitted. Use the existing scoped question/answer flow; inability to do this is a failed gate, not permission to substitute a different interface.

3. **Interruption cuts.** Use three separate copies of the same packet job. Restart the hosted worker after its claim and progress, before completion. In the second copy, interrupt observation of the completion reply and reconcile the same request ID before retrying. In the third, stop the requester session before Muse finishes while leaving the bridge alive. Record the precise cut and its evidence. Do not kill unrelated processes or manufacture a lost transport reply by merely hiding terminal output.

## Acceptance criteria
Run `dalan get REQUEST_ID --json` before and after every cut. Save both outputs.
- Harmless job: status is finished, report outcome is completed, and report result equals the exact phrase.
- Research: recorded question occurs after the logged parent-turn end; one answer precedes the retained result; recommendation and cited packet facts are correct. Correlate get output with timestamped hosted transcripts.
- Restart: get shows one logical request and a valid current claim history; resumed work finishes without conflicting terminal reports.
- Lost reply: get recovers the retained report under the same ID. No replacement submission or repeated effect is needed.
- Parent stopped: get from a new observer session retrieves the finished result without restarting the requester.
- `dalan status` remains reachable throughout. A missing report, unverifiable cut, manual repair or conflicting result fails the affected gate.

Muse is its own gate. Success by the ChatGPT agent or any other performer does not pass Muse. CLI/API execution may observe or submit; it cannot impersonate the hosted worker.

## Allowed disclosure
Muse may see only these text briefs, the synthetic packet, the single answer, and its own assignment/progress/result metadata. No repositories, files, credentials, personal records or other jobs are authorized. The code citations are operator documentation, not worker read grants.

## Cadence and timeouts
Record the granted claim lease and expiry from get; do not assume a default. Require progress at least every minute and before expiry. Expected wall time: two minutes for the report; five minutes per research/cut job, excluding a recorded answer delay. No claim after 60 seconds triggers inspection; five minutes without progress or a missed lease is a stall. Stop at the time ceiling rather than retry indefinitely.

## Spend ceiling
At most five hosted jobs, one attempt per cut, and 30 minutes after setup. Money ceiling: ______ (owner fills before starting). No automatic extra jobs or paid upgrades.

## Human touches to count
Log every manual start, approval, prompt, answer, restart, retry and repair with timestamp and reason. Label planned cuts separately; do not omit them from totals.

## Result record
Save the frozen sheet, source revision, worker identity, request IDs, sanitized get/status outputs, hosted transcripts, lease evidence, cut timestamps, touch ledger, elapsed time, actual spend and per-gate verdict under `trial-results/muse/RUN_ID/`. Exclude connector URLs and credentials. Missing evidence means not verified. Authoring this sheet is not user validation.
