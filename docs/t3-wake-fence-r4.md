# T3 wake fence: what T3 exposes about a stopped parent

Dalan wakes a parent T3 thread when a worker asks a question or finishes. A wake is a plain user message. This note records what T3 reports about a thread after a normal finish, an interrupt and a stop, and how Dalan uses it.

## Measurements (R4 probe)

Date 2026-11-15. T3 server `0.1.10-nightly.20261113.4643.1`, orchestrator protocol 2, `t3code` CLI 0.3.0. One throwaway thread in the scratch project, a cheap model, low effort, six short turns. The thread was renamed, archived and settled afterwards. Each value is a field of `t3code --json threads inspect` under `data.thread`.

| State | `status` | `runStatus` | `activeRun` | `latestRun.status` |
| --- | --- | --- | --- | --- |
| Normal finish | `active` | `completed` | `null` | `completed` |
| Running | `active` | `running` | set | `running` |
| After `threads interrupt` | `active` | `interrupted` | `null` | `interrupted` |
| After stop (MCP `t3_thread_interrupt` with `stop:true`) | `active` | `interrupted` | `null` | `interrupted` |

1. **Stop and interrupt look the same.** The two inspect payloads differ only in run ordinal and timestamps. No readable field tells a stop from an interrupt. T3 has no `stopped` status, so the old `stopped` fixture was invented.
2. **A plain send after stop starts a new run.** A `message.dispatch` with a fresh command id (the same path as `src/t3-transport.mjs`) moved the thread from run 5 `interrupted` to run 6 `completed`. A Dalan wake therefore resurrects a stopped parent.
3. **A resend with the same command id is one dispatch.** Sending the same `commandId` and `messageId` again returned the same `sequence` and left the thread at run 6. A resend with a different body and the same ids also returned the same `sequence` and made no new run. The CLI path (`t3code threads send`) draws a random command id, so it has no such protection.

The thread states are copied into `scripts/fixtures/t3-r4-thread-states.mjs`. The e2e and adapter tests use them.

## Decision

Measurement 2 says a wake can resurrect a stopped parent. Measurement 1 says nothing separates stop from interrupt. So Dalan treats a latest run in `interrupted`, `cancelled` or `canceled` as held, and does not send the wake. A latest run in any status other than `completed`, `running` or `failed` is held too, with the reason `latest run status "<status>" is not recognized` in the wait queue, so a status T3 adds later waits and says why. This also holds back a wake for a parent that the user only interrupted. That is the conservative over-fence, chosen over waking a stopped parent. A `failed` run is not held: it errored on its own, and a wake that starts a new run is how a crashed or usage-limited parent resumes. The probe recorded a user stop and a user interrupt as `interrupted`, never as `failed`.

`interrupted` is treated as held until the parent resumes. Held wakes stay in the durable wait queue and in `dalan inbox`. They are not dropped, and a restart keeps them. A timer (`DALAN_T3_HELD_RECHECK_MS`, default 15 s) inspects each held wake's parent. When the parent is active again with no held reason, which means a new run with a higher ordinal started, the wake goes back to its original kind (`blocker` or `t3`) and the next drain sends it once, through the stable-ID path. A resend after that is deduped by T3. A question that its job's result superseded is not released. The original kind is kept in `notifications.held_kind`, a nullable column added by migration 68.

Dalan also records the parent generation when a job is submitted: thread id, environment id, latest run id and run ordinal. The T3 destination writes it with `capture()` as one opaque string in `assignments.parent_generation`, and reads it with `readGeneration()`. The Store keeps the string and never parses it, so the core has no T3 columns. `canAdmitContinuation(row)` is the fence: a wake is held if the thread or environment changed, or if the latest ordinal went down. All three methods are on the destination interface (`src/destinations/index.mjs`); the `none` destination records nothing and always admits. The column and `held_kind` arrive together in migration 68, after the question-purpose column of 67.

Blocker and question wakes now use the stable-id path that result wakes use. Their command id comes from the job id and notification id, so a resend after a lost ack is one dispatch (measurement 3). The question text is quoted as data in the wake message.

## Not claimed

- The fence is not atomic. Dalan checks, then sends. A parent that is stopped between the check and the send is still woken.
- A parent that was stopped and then resumed by its user looks eligible. A resumed run is a newer run, and Dalan cannot tell that from a normal finish.
- Wakes that go through the CLI path (watch and break notices) have no stable id.
- Result text is not framed as untrusted data. Only question text is.
- Jobs created from the policy queue have no recorded generation. The ordinal check is skipped for them. The held-status check still applies.

## Upstream ask

One field would close the first two gaps: a monotonic `stopSeq` on the thread, raised by `thread.stop` only, plus an optional `ifStopSeq` guard on `message.dispatch` that rejects the send when the counter moved. With it, Dalan could record `stopSeq` at submit, send with the guard, and drop the over-fence for plain interrupts. Dalan does not patch T3 for this.
