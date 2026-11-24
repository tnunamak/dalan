# Contributing

Issues and pull requests are welcome. The maintainer sets the roadmap and decides which changes to accept. Discuss large changes before starting work.

## Tests

The full suite runs on Linux and needs GNU coreutils `timeout` and `nice` on PATH. On macOS, install coreutils and add its `gnubin` directory to PATH so `timeout` resolves. The full suite also starts `bubblewrap` sandboxes, so it needs a Linux host where `bwrap` can create user namespaces; a nested container or macOS cannot run those segments. `npm run test:sandbox` runs the subset that works inside such a confined environment; it is not evidence for the full suite. See [execution and evidence](docs/operations.md#execution-capability-and-check-evidence).

Use Node.js 24 or newer. From the repository root, run:

```sh
npm ci --ignore-scripts
DALAN_HOST_CHECKS=0 npm test
```

`DALAN_HOST_CHECKS=0` turns host checks off by default; tests that exercise host checks may still turn them on.

For concurrent runs, use a separate Git worktree and a separate short `TMPDIR` for each run (for example `/tmp/s-a-$$` and `/tmp/s-b-$$`). The temporary directory must exist before the run starts. Unix socket paths must fit within 107 bytes. Each test owns its temporary homes, databases, listeners, and host-check systemd units; installed dependencies and the toolchain may be shared read-only. Host-check resource ceilings apply per check, so concurrent runs add their resource use together.

When running the installed Gozar journey on its own, point `TMPDIR` at a short, existing, writable directory on disk, especially if the isolated `HOME` is deeply nested. The journey creates and removes its own fixture directory under that temporary root.

New HTTP fixtures should bind port `0` and read the listening port. A fixture that must write its URL before starting a child should use `reservedPort({ start })` from `src/test-support/port.mjs` and report an actual bind failure with `error.code = 'EADDRINUSE'`; the helper then retries setup on another port. Calling `reservedPort()` without a startup callback only supplies a candidate, which can be taken before the listener binds. Tests that deliberately exercise a named or occupied port must retain that behavior rather than silently changing ports.

Some upgrade tests also run against the source of releases from before Dalan was public. Maintainers keep those archives outside the repository and set `DALAN_PREPUBLIC_FIXTURES` to their directory; without it, those tests skip with the reason "pre-public release fixtures not present".

## Changes

Keep each pull request to one change. For a bug fix, add a failing test first, then fix the bug. Run the tests and state in the pull request which passed, failed, or could not run.

Do not include secrets or real hosts in fixtures, logs, issues, or pull requests. Use example.com and RFC 5737 documentation addresses such as 192.0.2.1, 198.51.100.1, and 203.0.113.1.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
