# @dalan/t3-acp-kit

This helper library supports Dalan’s optional T3 ACP adapter. MCP workers do not need it.

A small kit for ACP adapters that front a background job service for T3 Code. It holds small reusable pieces for ACP adapters, including Dalan’s `bin/dot-acp-agent.mjs`. No runtime dependencies. Node 22 or later.

```js
import { readOrCreateSecret, ownerToken, acquireLock, promptText, parseIdentity, createRefuse } from '../integrations/t3/acp-kit/src/index.mjs';
```

## API

| Module | Export | Purpose |
|---|---|---|
| `capability` | `readOrCreateSecret(file)` | 64-hex secret, created once, mode 0600, published with `link()`. Refuses any other mode (`state_permissions`) and a short secret. |
| | `ownerToken(secret, id)` | `HMAC-SHA256(secret, id)` hex. Derived, so it survives adapter restarts. |
| `session-store` | `SESSION_ID`, `assertSessionId(id)`, `sessionPath(dir, id, suffix)` | UUIDv4 check before a path is built (`invalid_session_id`). |
| | `writeJsonPrivate(file, value)` | Temp file plus rename. Creates the directory 0700, file 0600. |
| | `readJsonPrivate(file)` | `null` if absent. Refuses a file that is not exactly 0600. |
| | `assertPrivate(file)`, `removePrivate(file)` | Mode check; delete. |
| `lock` | `acquireLock(file, opts)` | Portable single-owner lock. Resolves `{ token, release }`, rejects `LockBusyError` (`code: 'session_busy'`). |
| | `ownerAlive(record)` | Staleness rule (pid alive and same start time). |
| `t3-envelope` | `promptText(blocks)` | User text from prompt blocks. Drops T3's runtime block and unwraps the instruction envelope, including `<runtime_info>` and `<pull_request_linking>` blocks that follow `</user_request>` in the same text. |
| | `unwrapUserRequest`, `isT3RuntimeBlock`, `stripRolePreamble` | The pieces of the above. |
| | `parseIdentity(text, { prefix, idPattern })` | First-line token `[<prefix>:<id>]` (for example, `dot-decision`). Returns `{ id, text, brief }`. |
| | `CONTINUE_PROMPT` | T3's restart continuation prompt. |
| `errors` | `createRefuse(RequestError)` | Returns `refuse(message, data?)` that builds `RequestError(-32000, ...)`. T3 records it as `provider_error`. The SDK class is injected. |
| | `CANCEL_BUDGET_MS` (5000), `CANCEL_CLEANUP_MS` (2000), `T3_CANCEL_WINDOW_MS` (10000), `cancelBudgetMs(raw)` | The cancel rule: answer within the budget, then at most the cleanup time. |

## Session lock

`acquireLock(file)` creates `file` with `open('wx', 0600)`. The file holds `{ pid, start_time, token, host }`.
`start_time` is an opaque string: Linux uses the boot id and field 22 of `/proc/<pid>/stat`; macOS uses `ps -o lstart= -p <pid>`.
Other platforms store `null` and fall back to pid liveness alone.

A lock is stale when its pid is dead, or the pid is alive with a different `start_time` (pid reuse). A file that cannot be
read is stale only when it is older than 3 s (it may be mid-write, or an empty leftover of the old flock adapter).
`release()` removes the file only while it holds our token. Held locks are also released on process `exit`; after SIGKILL the
next acquirer sees a dead pid.

Race-safe takeover. Deleting a stale file and creating a new one is not safe: a slow taker can delete the lock a fast taker
just made. So a taker first creates a guard `<lock>.takeover.<stale-token>.<n>` with `wx`. Under the guard it reads the lock
again and deletes it only if it is still that same stale generation, then creates the lock with `wx`. A guard left by a
crashed taker is skipped (next `n`). A loser of any race gets `LockBusyError`. Liveness is judged on this machine: the lock
must be on a local disk. The host name is for messages only (macOS host names change with the network).

Evidence: `test/lock.test.mjs` starts 8 child processes at the same instant against a planted stale lock, 6 rounds, and
checks the enter/leave log never shows two owners; another test races 8 processes on a missing lock (exactly one wins). A
mutant that deletes and creates without the guard fails the stale race test. The tests also cover pid reuse, SIGKILL of
the owner, a crashed taker's guard, and a legacy empty lock file.

## T3 adapter behavior

The following behavior informs adapter design; confirm it against the T3 version in use.

- **Steer is cancel then prompt.** T3 sends `session/cancel`. After the agent answers the active prompt with stop reason
  `cancelled`, T3 sends a NEW `session/prompt` about 200 ms later that carries only the steer text, not the original task.
  An adapter must not treat cancel as "abandon the job". Keep the job and let the next prompt reattach (worker), or use a
  grace window when the adapter requires one.
- **No `_meta` from T3.** T3 sends no `_meta` in `initialize`, `session/new`, `session/prompt` or `session/load`, and does not
  replay a `_meta` that the agent returned from `session/new`. When an adapter is respawned, T3 sends `initialize`, a fresh
  `session/new`, then `session/load { cwd, sessionId (the original), mcpServers }`, then `session/prompt`. Reattach must
  therefore bind on the T3 `sessionId` (plus the HMAC capability for bridge-side ownership). A delegator binding cannot come
  from T3.
- **`session/new` is T3's discovery probe.** T3 calls it on every refresh, with `cwd=$HOME` and no `mcpServers` from the probe
  clients. It must be free and instant: no bridge call, no lock, no file.
- **Cancel budget.** T3 allows 10 s after `session/cancel` for the prompt to return. Answer within `CANCEL_BUDGET_MS`, then
  spend at most `CANCEL_CLEANUP_MS` on cleanup.

## Not in the kit

Used by one adapter only: the admin socket client, `repoInputs`/`prepareAssignment`, result rendering, build eligibility,
diff packing, wait loops and turn guards (worker); `attemptId`/request-id retries (worker); the transcript and artifact files, and
`_meta` delegator checks.

## Tests

`npm test` in this directory (`node --test test/*.test.mjs`). The Dalan repository's root `npm test` runs these tests first.
