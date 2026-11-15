# ChatGPT agent hosted-performer acceptance

## Purpose
Prove that the ChatGPT agent can claim and finish bounded work over MCP after the requester stops, without substituting a local worker.

## Setup
Freeze this sheet and its revision before the first submission. Record RUN_ID, bridge revision, hosted client version, worker name and trial home.
Install Node.js 24 or newer and Dalan. In an interactive terminal, run `dalan try --public`, connect the ChatGPT agent over HTTP MCP with OAuth, and approve only the matching connection. Keep its private URL out of evidence. These are one-time setup touches, not routine intervention.

Set DALAN_HOME to the printed trial home for every observation below. Keep the bridge and its public route running independently of the requester.
Record `dalan status` before submitting work. Sign-in must be complete; a pairing window alone is insufficient.
The requester submits; the hosted performer claims. Queuing alone does not start the performer. Count the initial manual prompt explicitly (docs/local-agent-requester.md#instructions-to-paste).

## Order of jobs
1. **Harmless job.** Use the harmless brief defined by src/try.mjs#BRIEF: “Report the exact phrase: bridge first report. Do not read files, run commands or call external services.”
   src/try.mjs#runTry submits a schema-version-1 request with a generated request ID, empty inputs, read-only scope, expected text containing that phrase, execution none and delivery none. The performer must claim that request over MCP and finish with exactly `bridge first report`.
   The local flow first runs a built-in demo and a repository self-check before its own-worker job. Neither is hosted evidence. Public mode dispatches separately; save the actual hosted request from `dalan get REQUEST_ID --json` and require the same harmless contract. A mismatch stops this gate.
2. **Continuing research.** Submit one text-only job: “From the inline facts Alpha takes 2 days and Beta takes 3 days, recommend one option. After the requester turn ends, ask exactly once whether speed or capacity matters. Wait for the answer. Use no outside sources.”
   End the parent turn before the question. Answer “speed” once in the hosted conversation, as docs/local-agent-requester.md#instructions-to-paste prescribes. Continue the same request; expect Alpha, citing 2 versus 3 days. This is a persistence probe, not a research-quality benchmark.
3. **Interruption cuts.** Use three separate text-only copies of the harmless job. Restart the hosted worker after claim but before finish. For the next, drop the finish reply after submission and reconcile before retrying. For the last, stop the parent session before the result, leaving bridge and worker running. Record cut timestamps and request IDs. Do not kill the bridge to simulate a stopped parent.

## Acceptance criteria
Replace REQUEST_ID with the captured ID; never invent or reuse another job's ID.
- `dalan status` before and after each cut shows the bridge remains available. Save both outputs.
- `dalan get REQUEST_ID --json` proves the hosted worker claimed the intended immutable brief. Save claim identity and activity; setup screenshots alone fail.
- For each harmless job, that command shows status finished and report.result exactly `bridge first report`. Require completed outcome, not a blocker presented as success (src/try.mjs#finishedNotice).
- For research, successive get snapshots show one question after the saved parent-end timestamp, then the completed answer. Save the single answer and hosted transcript timestamps alongside them. A command snapshot alone cannot prove the parent ended.
- After restart or lost reply, get snapshots show reconciliation of the same request, not a replacement submission or contradictory report. Record any changed claim or expiry. If continuity cannot be demonstrated, fail.
- `dalan inbox` and get after parent restart expose the stored result without resubmission. Worker completion is not owner acceptance; save the later owner decision separately.
- Any missing observation is not tested, never pass. Another hosted performer passing does not pass this one. CLI or API impersonation does not count.

## Allowed disclosure
No repositories or files are granted to the performer. Only these inline briefs, synthetic facts, request state and its own progress/results may be seen. No credentials, private URLs, unrelated history or external services. Operators retain sanitized evidence privately.

## Cadence and timeouts
Request a 60-second claim lease; record the actual granted expiry before continuing. Unsupported duration blocks the cut until the sheet is revised before a new run.
Expect harmless jobs within 2 minutes, research within 5 minutes including the answer, each cut within 5 minutes. Observe every 15 seconds. Declare a stall after 60 seconds without new activity; stop at the job deadline. These are trial limits, not product defaults.

## Spend ceiling
Five hosted jobs, no replacement submissions, 30-minute run limit excluding setup. Money ceiling: ______; owner must fill it before execution. No metered execution is authorized by this sheet.

## Human touches to count
Count every manual start, prompt, approval, answer, restart, retry and review decision. Separate setup from routine touches; never erase failed attempts.

## Result record
Save this frozen sheet, sanitized command outputs, request IDs, timestamps, hosted transcript, touch ledger, actual lease and spend, and per-criterion pass/fail/not-tested reasons under `trial-results/chatgpt-agent/RUN_ID/`.
Keep secrets out. Check public wording against scripts/public-scan.mjs#GENERIC_RULES. This document records no trial pass.
