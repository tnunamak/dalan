# Use Dalan from a local agent (`dalan mcp`)

`dalan mcp` is a local MCP server on standard input and output. It lets an agent on the bridge computer (Claude Code, Codex) hand off a job and read the result as tool calls, without shell commands. It is not the worker endpoint: workers and ChatGPT connect to the bridge over HTTP as described in [connect any worker](worker-clients.md).

## Tools

| Tool | Does | Read-only |
| --- | --- | --- |
| `dalan_submit` | Queues an assignment, like `dalan submit`. Returns the `request_id` and the bridge verdict. A `clarify` or `reject` verdict comes back as an error result with its reasons. Optional: `worker`, `execution`, `dry_run`, `queue_anyway`, `refuse_defer`. | no |
| `dalan_wait` | Waits for a stop. `timeout_seconds` defaults to 120 and is capped at 300. On timeout it returns the current state (`"status": "timeout"`); call it again. | yes |
| `dalan_result` | Returns the job state and, once finished, the report. Secrets are redacted. Output over 32 KiB is cut at 32 KiB and ends with a note on how to read the rest. | yes |
| `dalan_status` | Returns `dalan status --json`. | yes |

Each tool runs the matching `dalan` command with `--json`, so receipts, assignment checks and verdicts are the same as on the command line. Failures are tool results with `isError: true` and a message; they never end the server. Only protocol messages go to standard output; logs go to standard error.

## Access

The server has the access of the user who starts it: it reaches the bridge through the local admin socket, as the CLI does. It opens no network port and has no separate credential. Do not run it for someone you would not give `dalan` to. Set `DALAN_HOME` in the server environment if your bridge home is not the default.

## Claude Code

```sh
claude mcp add dalan -- /path/to/dalan mcp
# with a custom bridge home:
claude mcp add dalan --env DALAN_HOME=/path/to/bridge-home -- /path/to/dalan mcp
```

## Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.dalan]
command = "/path/to/dalan"
args = ["mcp"]
# env = { DALAN_HOME = "/path/to/bridge-home" }
```

Replace `/path/to/dalan` with the output of `command -v dalan`, or with `node /path/to/dalan/bin/dalan.mjs` split into `command = "node"` and `args = ["/path/to/dalan/bin/dalan.mjs", "mcp"]`.
