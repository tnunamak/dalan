# A question can outlive its parent's run

Run `node scripts/question-relationship-e2e.mjs` from the repository root. This standalone acceptance test runs the same worker conversation twice: an owner using the CLI with `--deliver none` and `dalan wait`, and an owner using a T3 destination. It uses an isolated HOME, a real server process, real SQLite transactions and authenticated MCP worker calls. The deterministic demo worker is the script's `worker` function; it calls the real claim, question, renewal, consumption and finish handlers. No model or live T3 service runs.

The parent finishes its run before the worker asks whether to return JSON or plain text. The question remains identified as `Q` on the job. The CLI owner discovers it through `dalan wait` (exit 3), then lists it through `dalan questions`. The T3 owner receives one question notification on its bound thread. Two scheduler passes must not produce a duplicate.

The owner selects JSON. The test prepares the answer through R5's `prepare(job, questionId, text)` journal interface, sends it through `send(prepared)` to the real admin handler, and deliberately loses the committed reply. The saved attempt remains prepared. The worker renews its claim, advancing the job's revision past the answer. The test kills the server with SIGKILL and starts another process against the same database. `dalan answer` must resend the original key, revision and text, return the original receipt, and leave the revision unchanged. `reconcile(job, questionId)` confirms the journal's committed state. There must still be one answer receipt and one answered event.

The worker explicitly consumes the answer before it finishes. The CLI owner receives the finished state through `dalan wait`; it produces no T3 message. The T3 destination delivers one result notice to the bound parent thread. The report itself remains in Dalan for the owner to fetch.

A second job exercises interruption. While the parent's latest run is `interrupted`, the worker asks a question. Dalan must hold its wake. Starting a new parent run releases exactly one question notice. After the answer is consumed, the parent is interrupted again before the worker finishes. The report must remain stored, with no result notice sent during interruption. A new parent run releases exactly one result notice. The test counts messages added after each resume, so an early, incorrect send cannot satisfy the resume assertion. With no destination, leaving the result unread preserves it until a later `dalan wait`.

A follow-up is submitted with a fresh job ID and claim. It starts with no questions and does not change the earlier report. Continuing the relationship does not reopen terminal work.

## Responsibility boundary

T3 owns the parent thread, runs, lifecycle projection, admission of a new continuation, and stable acceptance of a message dispatch. Its destination adapter supplies an opaque generation and continuation-admission decision through `readGeneration` and `canAdmitContinuation`. Dalan stores that generation without interpreting the host's schema. T3 decides when a person has resumed the parent. Dalan does not choose the answer or start a reasoning model.

Dalan owns job and question identity, owner capabilities, claims, revisions, answer receipts, answer consumption, reports and durable notification state. The requester-side answer journal preserves the exact attempted command in `receipts/<job>.answers/<qid>.json`. Dalan's T3 adapter reads the host lifecycle before delivery, holds ineligible wakes, and releases them when the parent becomes eligible. The same core question and result flow works with the CLI and no destination.

The T3 side of this test uses the existing `t3code` stub pattern and `startT3ResultFixture` receiver. It proves Dalan's behavior against the supplied host metadata and dispatch receipts. It does not prove a live T3 stop/resume journey, hosted-worker activation, or an exact stop-versus-interrupt distinction. In the R6 contract, `interrupted` is held conservatively.

## Dependencies and baseline

The script collects cut failures and continues to later cuts. A failed assertion stays a failure; it is never converted into an expected pass. R5 and R6 are now merged, so the journal is required and the trace runs in the default suite. The table records the original main baseline at `4d2abf19`, before those dependencies merged.

| Cut | Main baseline |
| --- | --- |
| Question after parent run ended | Pass, both requesters |
| One question wake with repeated scheduler passes | Pass, both requesters |
| Journal and CLI replay after SIGKILL and revision advance | Waits on R5, both requesters |
| One answer receipt and answered event | Pass, both requesters |
| `consume_answer` | Pass, both requesters |
| Finish and result only to eligible parent | Pass, both requesters |
| Interrupted parent holds question wake | CLI passes; T3 waits on R6 |
| Held question delivered once after resume | CLI passes; T3 waits on R6 |
| Result retained while parent stopped | Pass, both requesters |
| Interrupted parent holds result wake | CLI passes; T3 waits on R6 |
| Held result delivered once after resume | CLI passes; T3 waits on R6 |
| Follow-up is a new job | Pass, both requesters |
| Destination generation/admission interface | T3 waits on R6 |

The test is registered in `scripts/test-segments.json`; its temporary test-listing exemption has been removed. Promotion to conformance traces T43+ comes afterward.
