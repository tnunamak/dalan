# Claude Code local requester acceptance sheet

## Purpose

Prove that a local Claude Code requester can hand off bounded work, recover a question and retrieve a result without becoming the worker.

## Setup

Freeze this sheet at revision 919ed1c8a81b123d6617bb2e8e395e6e142e3769 before running anything; record the actual checkout SHA separately and correct any mismatch before starting.
Use Node 24 or newer, installed Dalan, and an interactive Claude Code session.
Complete the selected performer's sign-in once.
Record its exact worker name, bridge home, database path as BRIDGE_DB, versions and granted scope.
Use the same DALAN_HOME for every command.
The requester must never register as a worker or claim work.

Configure local stdio MCP once:

```sh
claude mcp add --scope user dalan --env DALAN_HOME="/absolute/trial/home" -- "$(command -v dalan)" mcp
```

Replace the home before running. Verify `dalan status --json` matches it.
Local MCP has local admin-socket authority, not separate worker credentials.
Sources: docs/local-agent-requester.md#instructions-to-paste; docs/local-agent-mcp.md#claude-code; src/mcp-stdio.mjs#TOOLS.

This document authorizes no run, paid session, approval or permission change. Obtain the owner's separate trial authorization.

## Order of jobs

1. Run the harmless `dalan try` path first. Use the actual selected performer, not the built-in demo, for the worker gate. The fixed brief is: “Report the exact phrase: bridge first report. Do not read files, run commands or call external services.” The assignment has empty inputs, read-only scope, expected text containing that phrase, execution none and delivery none. The worker claims, follows that brief and finishes. Require status finished and report.result exactly `bridge first report`. The built-in OAuth demo and optional pinned README demo are setup checks, not evidence that the selected performer worked. Sources: src/try.mjs#BRIEF, #REPORT, #runTry, #finishedNotice.

2. Submit one continuing-research job through local `dalan_submit`, execution none and delivery none. Freeze these public synthetic inputs in its brief: “Record A: January 1, released. Record B: January 2, withdrawn. Record C: January 3, revised.” Ask for a chronology and one clarification: whether withdrawn records belong in the final summary. End the requester turn before the worker asks. Save both timestamps. Recover the question in a new requester turn and give exactly one answer: “Include withdrawn records and label them withdrawn.” Require a three-record chronology with that label.

   Queuing never starts a hosted performer. Count the manual start and confirmation before waiting. CLI `dalan wait REQUEST_ID` exit 3 means a question or blocker, not completion. Inspect and stop; do not decide. For a structured question, use `dalan answer REQUEST_ID QUESTION_ID 'Include withdrawn records and label them withdrawn.'`. A generic blocker needs conversation resolution, not a fabricated question ID. At this pin there is no answer MCP tool. This sheet switches to `dalan_answer` once PR B5 ships and its contract is verified. Sources: src/mcp-stdio.mjs#TOOLS; src/cli-help.mjs#resolveHelp; src/answer-journal.mjs#prepare.

3. Run three separate copies of the bounded research job. Restart the worker mid-job; lose one answer reply; stop the requester before the result. Recover each original request ID. Do not replace a job after an uncertain submission. Retry an answer only with its saved envelope. Read back before retrying any uncertain action. Source: src/answer-journal.mjs#send, #reconcile.

## Acceptance criteria

- `dalan status --json` identifies the intended bridge and worker. No alternate performer substitutes.
- `dalan get REQUEST_ID --json` shows the original ID, claim, progress and terminal report after each cut. No duplicate terminal report or unsupported success claim is accepted.
- `dalan inbox --all --since all --json` reveals the waiting question or recovered result after the requester stops.
- For the research question, run:
  `sqlite3 -readonly "$BRIDGE_DB" "SELECT request_id,question_id,asked_at,answered_at,answer FROM job_questions ORDER BY asked_at;"`
  Require one question row for that job, asked after the saved parent-turn end, and one matching answer.
- `dalan get REQUEST_ID --json` must show the required phrase or chronology in report.result. Owner review precedes any decision.

Each hosted performer has its own gate. A local CLI/API simulation cannot pass a hosted trial. This sheet evaluates Claude Code only as requester.

## Allowed disclosure

Only the exact synthetic briefs and their answers may reach the selected performer. No private repositories, files, credentials or connector data. The optional built-in demo may read only dalan-demo/hello README.md at its pinned revision. It grants no production repository access.

## Cadence and timeouts

Record the granted claim lease from `dalan get REQUEST_ID --json`; never infer it from the wait timeout. Target five minutes per job. CLI wait defaults to 300 seconds; after two further timeouts declare a stall at fifteen minutes. MCP wait defaults to 120 seconds, capped at 300. Inspect at each timeout. Stop on cancellation, usage break or authority loss. Source: src/mcp-stdio.mjs#TOOLS.

## Spend ceiling

Five performer jobs; ninety minutes total including setup. No automatic replacements. Money ceiling: ______, owner-approved before starting.

## Human touches to count

Log every manual start, sign-in, approval, answer, restart and retry. Separate setup from routine interventions. A recovered job is not hands-free if a person rescued it.

## Result record

Save the frozen sheet, SHA, sanitized command outputs, IDs, timestamps, lease, question/answer evidence, report and touch/spend log under `trial-results/claude-code-requester/RUN_ID/`. Record each criterion as pass, fail or untested. Never save credentials or private connector URLs.
