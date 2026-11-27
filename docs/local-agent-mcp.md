# Use Dalan from a local agent (`dalan mcp`)

`dalan mcp` is a local MCP server on standard input and output. It lets an agent on the bridge computer (Claude Code, Codex) hand off a job and read the result as tool calls, without shell commands. It is not the worker endpoint: workers and ChatGPT connect to the bridge over HTTP as described in [connect any worker](worker-clients.md).

## Tools

| Tool | Does | Read-only |
| --- | --- | --- |
| `dalan_submit` | Queues an assignment, like `dalan submit`. Returns the `request_id` and the bridge verdict. A `clarify` or `reject` verdict comes back as an error result with its reasons. Optional: `worker`, `execution`, `dry_run`, `queue_anyway`, `refuse_defer`. | no |
| `dalan_forecast` | Returns admission verdict, reasons, and available queue or worker estimates without queuing or reserving a job. Pass `assignment`, with optional `worker` and `execution`. CLI equivalent: `dalan forecast`. | yes |
| `dalan_correct` | Queues a new job that corrects an earlier job you submitted, like `dalan submit --revises`. Pass `revises` (the earlier request_id) and `assignment`. The earlier job is not cancelled, but its result can no longer be accepted. | no |
| `dalan_cancel` | Cancels a queued job, or asks the worker on a claimed job to stop, like `dalan cancel`. Optional `reason`. | no |
| `dalan_accept` | Records your verdict on a finished job, like `dalan accept` or `dalan reject`. Pass `request_id` and `verdict` (`accept` or `reject`); optional `note`. | no |
| `dalan_wait` | Waits for a finished report, question, blocker, cancellation, worker break or timeout. `timeout_seconds` defaults to 120 and is capped at 300. A timeout returns `status: timeout`; call again to keep waiting. | yes |
| `dalan_result` | Returns the job state and, once finished, the report. Secrets are redacted. Output over 32 KiB is cut at 32 KiB and ends with a note on how to read the rest. | yes |
| `dalan_questions` | Lists identified questions for a job. Pass `id` (the request_id). Human-only questions require operator action. | yes |
| `dalan_answer` | Answers a question through the answer journal. Pass `id`, `question_id` and `text`. Exact retries reuse the saved attempt; different text is refused. Cannot answer human-only questions with owner authority alone. | no |
| `dalan_status` | Returns `dalan status --json`. | yes |

Each tool runs the matching `dalan` command with `--json`, so receipts, assignment checks and verdicts are the same as on the command line. Failures are tool results with `isError: true` and a message; they never end the server. Only protocol messages go to standard output; logs go to standard error.

## When the worker asks a question

If `dalan_wait` reports a waiting question, call `dalan_questions` with the job's `id`. Show the question to the person and ask for their answer; do not invent one. Send their reply with `dalan_answer`, using that same `id`, the returned `question_id` and their answer as `text`, then call `dalan_wait` again with `request_id`. Keep the same bridge home and request ID; do not submit another job.

If the question is marked human-only, stop and ask the person to take the required operator action instead. Owner authority alone cannot answer it. After the person confirms the action, call `dalan_wait` again. If there is only a blocker and no identified question, use `dalan_result` to show it and wait for its resolution. Questions and blockers do not authorize scope changes, spending, access grants or new result destinations.

Answers starting with a dash are refused; ask the person to rephrase so the answer does not start with a dash. Answers are journaled before sending. Resending the exact same answer to the same question is safe: it reuses the saved attempt rather than sending a second answer. After a lost reply, the same envelope may be retried; a different second answer is refused. Keep the same `DALAN_HOME` and journal. On an error, read `dalan_questions`/`dalan_result` to reconcile before retrying; do not change the text or delete the journal to bypass a refusal.

## Access

The server has the access of the user who starts it: it reaches the bridge through the local admin socket, as the CLI does. It opens no network port and has no separate credential. Do not run it for someone you would not give `dalan` to. For a service made by `dalan service install`, `dalan mcp` finds the remembered service home, so you set nothing. For a `dalan try` bridge or a bridge you started by hand, set `DALAN_HOME` in this MCP server's environment to the exact home of the running bridge, using the Home line that the running trial printed. A local `dalan try` prints `$HOME/.local/share/dalan-trial`; a public trial prints its own home. A trial home is not the CLI's normal default, and `dalan mcp` does not stop to ask which home you meant.

## Claude Code

For a service made by `dalan service install`:

```sh
claude mcp add --scope user dalan -- "$(command -v dalan)" mcp
```

For a `dalan try` bridge, add its home as an override. This example uses the home of a local `dalan try`; for a public trial, use the Home line your running bridge printed:

```sh
claude mcp add --scope user dalan --env DALAN_HOME="$HOME/.local/share/dalan-trial" -- "$(command -v dalan)" mcp
```

Keep `--scope user`. Without it, Claude Code registers the server for the current project only, and a session in another directory does not see it. `dalan mcp` needs Node 24 or newer (`node --version`).

## After a pairing that stopped part way

If a client stopped during pairing (a crash, a closed window), the worker name already has an active connection, and approving the retry fails with "already has an active connection". Approve the new code with `--replace`:

```sh
dalan connect approve CODE --worker W --replace
```

`--replace` ends the old connection for worker `W`. The new connection receives every queued and future job for `W`, including briefs you approved before the switch. Use it only for a code you started yourself.

## Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.dalan]
command = "/path/to/dalan"
args = ["mcp"]
env = { DALAN_HOME = "/absolute/path/to/the-running-bridge-home" }
```

Omit the `env` line for a service made by `dalan service install`.

Replace `/path/to/dalan` with the output of `command -v dalan`, or with `node /path/to/dalan/bin/dalan.mjs` split into `command = "node"` and `args = ["/path/to/dalan/bin/dalan.mjs", "mcp"]`.

Use an absolute home path in the TOML; do not leave `$HOME` or `~` in it. Start a new client session and ask it to call `dalan_status`. Check that the returned status belongs to your running bridge before submitting a job. If the call cannot connect, verify the configured home and run `dalan status --json` in a shell that selects the same home. For a complete submit-and-result example, follow [Send one small job and read the result](codex-to-muse.md#4-send-one-small-job-and-read-the-result), using your connected worker's name.
