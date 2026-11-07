# Retry-stable T3 job results

JOB-RESULT delivery derives receiver IDs from `sha256(JSON.stringify([job_id, effect_id]))`. The job ID is the immutable request ID and the effect ID is the durable T3 outbox event ID. Epoch is not an input. The bridge sends both a deterministic command ID and message ID through `orchestration.dispatchCommand`; receiver command receipts therefore remain stable across fresh T3 auth and WebSocket sessions.

The adapter uses the `t3 auth session issue/revoke` commands, the local T3 runtime descriptor, the authenticated `/api/auth/websocket-ticket` endpoint, and the T3 orchestration WebSocket RPC. It imports no private `@bvdm/t3code-cli` modules. Tokens and tickets stay in memory and are not included in errors or output. The RPC request matches the installed CLI transport: `{_tag:"Request",id,tag:"orchestration.dispatchCommand",payload,headers:[]}` and the response is its matching `Exit` message. T3 requires protocol 2 and a loopback origin.

The bridge process must be able to resolve both `t3code` (submit and delivery run `threads inspect` against `http://127.0.0.1:3773` through it) and the matching `t3` auth command on `PATH`. Set `DALAN_T3_COMMAND` to the auth command's executable path when it is not on the service `PATH`; it does not configure `t3code`; set `T3CODE_HOME` if T3 uses a non-default data directory.

By default, result delivery selects `steer_active` for the latest active run; if no active run exists, it selects `queue_after_active` when a queued run exists and `start_immediately` otherwise. The ordinary delivery path verifies the stored thread and environment binding before dispatch. The pinned receiver implementation does not reject a same-key payload mismatch, so the bridge relies on the immutable job/effect body staying unchanged.

## Focused mock check

Run `node scripts/t3-result-delivery-test.mjs`. The mock persists a receiver receipt, message, run and effect, drops the first response, then accepts a retry from a second transport session. It verifies one persisted effect and stable IDs, but it does not prove behavior against a real receiver.

## Owner-run live proof

The harness defaults to dry-run. It reads the supplied SQLite database in read-only mode, verifies that the explicit project maps to the exact supplied repository root, and prints the planned operation. It does not issue auth or dispatch unless `--execute` is present. For execution, it creates an empty scratch thread with the installed `@bvdm/t3code-cli` internal API and a `thread.create` command. The pinned API package version and exported method shapes are checked first. The scratch uses model metadata with approval-required runtime and plan interaction settings; it sends no provider prompt and never calls `launchThread`.

Each of two result sends uses the real `dispatchT3Result` path, which creates a fresh auth and WebSocket session. Before and after each send, the harness opens the supplied database read-only and checks command receipt, stable message, thread run, and outbox counts. It requires one persisted receipt, message, and held run after the first send; no `provider-turn.start` outbox effect or running/starting run before or after either send; and identical scoped counts after the retry. The scratch thread is left held for owner review. The harness does not archive it or release the run.

```sh
node scripts/t3-result-live-proof.mjs \
  --project-id PROJECT_ID \
  --environment-id ENVIRONMENT_ID \
  --database /absolute/path/to/statev2.sqlite \
  --cli-root /absolute/path/to/t3code-cli \
  --repo-root /absolute/path/to/repository

node scripts/t3-result-live-proof.mjs \
  --project-id PROJECT_ID \
  --environment-id ENVIRONMENT_ID \
  --database /absolute/path/to/statev2.sqlite \
  --cli-root /absolute/path/to/t3code-cli \
  --repo-root /absolute/path/to/repository \
  --t3-command /absolute/path/to/t3 \
  --execute
```

The explicit `--t3-command` path prevents CLI fallback to `npx` or external network access. On failure, the script prints the current phase and scratch thread ID without printing credentials. Leave that thread held and inspect only its scoped receiver rows before any cleanup or release. This proof does not simulate a dropped response or restart the receiver.

The running T3 server and auth command must match versions. A desktop server may differ from the standalone command on PATH; supply a matching local command wrapper when necessary. The proof reads the actual durable `orchestration_command_receipts` store (thread binding is its `aggregate_id`), alongside the V2 message/run/effect projections. To retry an already inspected, owned scratch thread without creating another, pass `--thread-id ID`. Add `--resume` only after verifying that exactly one accepted effect with the same deterministic proof identity exists; the harness then proves replay without creating new messages or runs. It still requires zero provider-start effects.
