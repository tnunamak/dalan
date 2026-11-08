# Use Dalan from a local agent (`dalan mcp`)

`dalan mcp` is a local MCP server on standard input and output. It lets an agent on the bridge computer (Claude Code, Codex) hand off a job and read the result as tool calls, without shell commands. It is not the worker endpoint: workers and ChatGPT connect to the bridge over HTTP as described in [connect any worker](worker-clients.md).

## Tools

| Tool | Does | Read-only |
| --- | --- | --- |
| `dalan_submit` | Queues an assignment, like `dalan submit`. Returns the `request_id` and the bridge verdict. A `clarify` or `reject` verdict comes back as an error result with its reasons. Optional: `worker`, `execution`, `dry_run`, `queue_anyway`, `refuse_defer`. | no |
| `dalan_wait` | Waits for a finished report, question, blocker, cancellation, worker break or timeout. `timeout_seconds` defaults to 120 and is capped at 300. A timeout returns `status: timeout`; call again to keep waiting. | yes |
| `dalan_result` | Returns the job state and, once finished, the report. Secrets are redacted. Output over 32 KiB is cut at 32 KiB and ends with a note on how to read the rest. | yes |
| `dalan_status` | Returns `dalan status --json`. | yes |

Each tool runs the matching `dalan` command with `--json`, so receipts, assignment checks and verdicts are the same as on the command line. Failures are tool results with `isError: true` and a message; they never end the server. Only protocol messages go to standard output; logs go to standard error.

## Access

The server has the access of the user who starts it: it reaches the bridge through the local admin socket, as the CLI does. It opens no network port and has no separate credential. Do not run it for someone you would not give `dalan` to. Set `DALAN_HOME` explicitly in this MCP server's environment to the exact home of the running bridge. For a normal `dalan try`, that is `$HOME/.local/share/dalan-trial`; if the trial printed another home, use that instead. The trial home is not the CLI's normal default, and `dalan mcp` does not stop to ask which home you meant.

## Claude Code

This example uses the usual trial home. Replace it with the home printed by your running bridge, and replace `/path/to/dalan` as described below.

```sh
claude mcp add dalan --env DALAN_HOME="$HOME/.local/share/dalan-trial" -- /path/to/dalan mcp
```

## Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.dalan]
command = "/path/to/dalan"
args = ["mcp"]
env = { DALAN_HOME = "/absolute/path/to/the-running-bridge-home" }
```

Replace `/path/to/dalan` with the output of `command -v dalan`, or with `node /path/to/dalan/bin/dalan.mjs` split into `command = "node"` and `args = ["/path/to/dalan/bin/dalan.mjs", "mcp"]`.

Use an absolute home path in the TOML; do not leave `$HOME` or `~` in it. Start a new client session and ask it to call `dalan_status`. Check that the returned status belongs to your running bridge before submitting a job. If the call cannot connect, verify the configured home and run `dalan status --json` in a shell using that same `DALAN_HOME`. For a complete submit-and-result example, follow [Send one small job and read the result](codex-to-muse.md#4-send-one-small-job-and-read-the-result), using your connected worker's name.
