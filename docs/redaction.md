# Secret redaction

Dalan masks credentials in what it writes to its logs, sends in alerts, returns to clients as errors, shows the owner when it reads a job (`dalan get` and `dalan wait` report text, progress notes and tool errors), and stores as report and other text artifacts (patch artifacts are not masked). The CLI prints those masked responses. Masking runs before any length clip, so a credential that crosses a clip boundary leaves no prefix.

**The local database keeps the exact text a worker sent.** It is masked when read out, not when stored, so a retried `finish` with the same body stays the same finish. Protect the database and its backups like the bridge's other secrets.

The masking rules live in `src/redaction.mjs` and `src/diagnostic.mjs`. Every sink uses the same rules, in this order:

1. **Known values.** Secrets the process holds (the bridge path secret, the operator key, the ntfy token, and environment variables whose names end in `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY` and similar) are registered at startup. Each one is masked in its raw form and in its percent-encoded, JSON-escaped, shell-quoted and base64 forms.
2. **Strong formats.** PEM armor and key bodies, and vendor token prefixes such as `ghp_`, `xoxb-`, `sk_live_` and `whsec_`.
3. **Credential fields.** Values under credential names (`password`, `token`, `api_key`, `Authorization`, `Cookie`, and names ending in `_token` or `_secret`), and Bearer or Basic credentials.

Text that parses as JSON is checked in its decoded form, so a secret or a credential field name written with a JSON escape (for example `\u0073` for `s`) is found like the plain spelling. JSON with nothing to mask keeps its original formatting.

A credential split across sibling fields or array items is joined and checked. Child output is masked a whole line at a time, and a PEM block is masked as one unit. A crash returns only an error id to the client; the masked detail goes to the local log.

The tests are in `scripts/secret-sinks-redaction-test.mjs`, `scripts/redaction-matrix-test.mjs` and `scripts/diagnostics-redaction-test.mjs`.

## Known residual risks

Redaction catches accidental leaks of registered secrets and known formats. It cannot stop a worker that deliberately encodes a secret it knows, for example as base64. These cases are not masked, and the project accepts them.

- **Encoded unknown values:** a credential that Dalan did not register is found only in plain text. Its base64 or percent-encoded form, or a JWT payload, is not decoded.
- **Split across log lines:** a secret that is split over two separate log entries is not found, because each entry is masked on its own.
- **Long ordinary-looking values:** there is no entropy or long-run rule, so an unregistered opaque value with no credential name and no known prefix passes.

Keep credentials out of tool arguments, assignment text and error messages; redaction does not catch every shape.
