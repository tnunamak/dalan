# Request: expose a thread stop sequence

To the T3 Code maintainers.

## 1. Request

Add a monotonic integer `stopSeq` to the thread projection. Increment it once per committed `thread.stop` event, not for `run.interrupt` or a new run. A stop request on an already-stopped thread is a no-op: it commits no new `thread.stop` event and does not increment the sequence. Require `stopSeq` in the thread object returned by `threads inspect`; this is an output requirement, not an assumption about how the CLI builds its view. Optionally add an `ifStopSeq` precondition to both `message.dispatch` and the `threads send` CLI path: refuse dispatch if the current sequence differs, and evaluate the condition in the same commit as admitting the message. The CLI must accept and forward the precondition because the external sender delivers through `threads send`. These field and precondition semantics are proposed, not existing behavior.

## 2. Problem

An external task service that wakes a T3 thread when a delegated job reports may deliver a late result or a question. It must not restart a thread the user stopped.

The supplied investigation reports these observations on T3 build 4643 using one throwaway thread:

- After both `thread.stop` and `run.interrupt`, the readable run status was `interrupted`. The two cases looked the same to the sender. **Source: measured on build 4643.**
- Both paths end at the same stop handling and call `markStoppedRun`. **Source: read in T3 source at build 4643, `Orchestrator.ts:862-884` and `Orchestrator.ts:12188`.**
- A plain `message.dispatch` after a stop started a new run. **Source: measured on build 4643.** Dispatch uses `createdBy: 'user'`, and a user send releases the hold. **Source: read in T3 source at build 4643, `Orchestrator.ts:6842-6848`.**
- Resending the same dispatch `commandId` was deduplicated. **Source: measured on build 4643.** Delivery idempotency already worked in that experiment; the missing distinction concerns stop intent.

These observations do not establish behavior for other builds or every lifecycle path. They show that the inspected status cannot distinguish a user thread stop from a run interruption. A conservative external sender must therefore hold every wake to an interrupted thread, including wakes the user may want.

The consumer now holds wakes when the latest run is `interrupted`, `cancelled` or `canceled`, and fails closed for any unrecognized latest-run status. When a latest run exists, only `completed`, `running` or `failed` passes that run-status gate; a thread with no latest run has none to check. Delivery then requires an active thread, as well as matching thread and environment bindings. This conservatively holds plain interrupts too. **Source: read in the consumer at pin `0bf28e19c953625c813ed60d321534c548397d61`, `src/t3.mjs#classifyThread`, `#inspectThread` and `#deliverT3`; CLI delivery is defined by `#sendArgs` and `#deliverT3`; comparison against the build-4643 measurement above.** Changing this reader alone cannot recover the missing distinction.

## 3. Client behavior

The proposed client records `stopSeq` when submitting work for the thread. Before delivering a question or result, it reads the thread projection. It sends only when the value is unchanged. Otherwise it retains the result and displays it as held.

A read followed by an unconditional send still races with a stop. With `ifStopSeq`, the client supplies its recorded value on dispatch. A stop committed first makes that dispatch fail without starting a run. The client keeps the held result rather than retrying with a newly read value.

A user resume does not erase the counter. Delivering held work after resume requires a newly authorized delivery baseline, not automatic adoption of the current value.

## 4. Why not alternatives?

A run-status heuristic cannot distinguish the two measured cases. A new event type alone would require clients to replay history to reconstruct the distinction. A boolean stopped flag makes comparison ambiguous when resume clears it. A monotonic counter preserves whether a stop occurred since a particular submission. These are design tradeoffs, not additional claims about T3 internals.

## 5. Compatibility

Make the field additive, with an initial value of zero for existing threads. If derived from the event log, no migration of old events is needed. Define the initial baseline consistently; replay must not reset an already exposed sequence.

Clients that ignore the field keep their current behavior. Dispatch without the optional precondition retains current semantics. Clients using it can distinguish a precondition refusal from a committed dispatch and preserve existing `commandId` deduplication.

## 6. Proposed maintainer test

1. Read `stopSeq = s`. Commit `thread.stop`; inspect `s + 1`.
2. Dispatch with `ifStopSeq: s`. Assert refusal, no admitted message and no new run.
3. Resume through an explicit user action. Assert the sequence stays `s + 1`. Dispatch newly authorized work with that value; assert acceptance.
4. On a separate running thread, record its sequence, call only `run.interrupt`, and assert the sequence is unchanged.
5. Start a new run without a thread stop and assert no increment.

These are acceptance tests for the proposed change. They have not been run against an implementation of it.
