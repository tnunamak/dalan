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

Some upgrade tests also run against the source of releases from before Dalan was public. Maintainers keep those archives outside the repository and set `DALAN_PREPUBLIC_FIXTURES` to their directory; without it, those tests skip with the reason "pre-public release fixtures not present".

## Changes

Keep each pull request to one change. For a bug fix, add a failing test first, then fix the bug. Run the tests and state in the pull request which passed, failed, or could not run.

Do not include secrets or real hosts in fixtures, logs, issues, or pull requests. Use example.com and RFC 5737 documentation addresses such as 192.0.2.1, 198.51.100.1, and 203.0.113.1.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
