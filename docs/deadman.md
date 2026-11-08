# External heartbeat dead-man

`dalan-deadman` is a small receiver for health-gated pings from the bridge host. Run it on an independently powered and networked host of your choice. It stores heartbeat and episode state in SQLite on that host. The bridge host sends `POST /heartbeat` with `Authorization: Bearer <token>` and `{"healthy":true}`. The body is limited to 1 KiB. The receiver accepts only `{"healthy":true}`; any other field, including a sender timestamp, gets HTTP 400. It records its own receive time.

The receiver opens an episode after five minutes without a heartbeat. A new process waits through a five-minute startup grace period for a ping before opening a new episode; an episode already open before restart keeps its alert and reminder state. It sends one initial notification, then one reminder two hours after a confirmed initial notification if the episode remains open. It clears an episode only after timely pings continue for 15 minutes. A tick that observes a late or missing heartbeat resets the recovery clock. Deadline arithmetic uses a monotonic logical clock while the process runs, so wall-clock steps do not freeze recovery. The receiver anchors that clock across restarts using persisted state and nonnegative wall-clock downtime. A new episode is created for a later outage.

Notification publication is optional: set `DOT_DEADMAN_NTFY_URL` to an HTTPS ntfy topic URL and, if required, set `DOT_DEADMAN_NTFY_TOKEN`. Missing publisher configuration leaves delivery pending and makes no off-host delivery claim. Confirmed 4xx rejections and failures observed before transport is ready are retried after one minute. Publication uses a total five-second deadline: a timeout before TCP connection (or TLS handshake) completes is safe to retry. A timeout after transport is ready, a 5xx response, or a process crash during publication is marked uncertain and is not resent automatically, because the provider may have accepted the notification. The database retains that evidence. The publisher never follows redirects; redirects and TLS certificate/protocol failures before a completed handshake are recorded as publisher configuration errors and retried only after service restart, once the endpoint is corrected. Publisher tokens with control characters or invalid header values, and URLs containing user credentials, are rejected before the monitor starts. Configuration errors contain no token or URL credentials. Messages contain no heartbeat payload, token, or bridge assignment text.

One auditable state machine holds all of this policy, which is easier to test than a notification provider's vendor-specific repeat, reminder and hysteresis settings. The provider only transports notifications; it does not decide when an episode starts or clears.

## Operator setup

Path examples use fresh-home defaults. For an existing installation, use the roots from `dalan paths --json`; populated legacy roots remain active. See [the upgrade guide](dalan-upgrade.md).

**Upgrading an install that relied on the drainer gate: set `DALAN_DRAINER_HEALTH_FILE` to its drainer evidence file before restarting the heartbeat, or the heartbeat will ping on bridge health alone. The value must be an absolute path; a relative path resolves against the service `WorkingDirectory`.**

Install the repository on the independent host at `/opt/dot-bridge` or edit the service's paths. Create the `dot-deadman` account, install Node 24+, and create `/etc/dot-deadman.env` with mode 0600:

```sh
DOT_DEADMAN_TOKEN=<random bearer-safe value of at least 32 characters>
DOT_DEADMAN_NTFY_URL=https://ntfy.example.net/dot-deadman
DOT_DEADMAN_NTFY_TOKEN=<optional provider token>
```

The service listens on `127.0.0.1:8788`; put an HTTPS reverse proxy in front of it for the bridge host, or use a private authenticated transport. Keep the bearer token only on the bridge host and the receiver host. The configured notification URL must be canonical and must not redirect. The receiver rejects a remote plain-HTTP publisher URL at startup. The unit resolves Node through `/usr/local/bin:/usr/bin:/bin` and the CLI requires Node 24+. Install Node there or set `ExecStart` to its installed absolute path. Then enable `systemd/dot-deadman.service` on the independent host.

On the bridge host, create `~/.config/dalan/deadman.env` with mode 0600:

```sh
DOT_DEADMAN_URL=https://dot-deadman.example.net/dot-deadman
DOT_DEADMAN_TOKEN=<same bearer token>
```

The pinger appends `/heartbeat` to the configured base path, so the example sends to `/dot-deadman/heartbeat`. Configure the reverse proxy to strip `/dot-deadman` before forwarding, because the receiver serves exactly `/heartbeat`. Its environment parser accepts matching single or double quotes around values and LF or CRLF line endings. Tokens use bearer characters (letters, digits, `-._~+/` and optional trailing `=`); URL credentials and other schemes are rejected before sending. Remote endpoints require HTTPS; plain HTTP is allowed only on loopback for tests.

The user heartbeat timer runs `bin/dot-heartbeat.mjs`, which requires a successful `/status` check on the bridge's admin socket. Empty supply, ordinary policy refusals and intentional operator pause count as healthy. A missing socket or invalid status prevents the external ping. Fresh installs do not need a drainer: when `DALAN_DRAINER_HEALTH_FILE` is unset or empty, drainer files are ignored, including stale files left on disk.

For installs that run a drainer, explicitly opt in by adding `Environment=DALAN_DRAINER_HEALTH_FILE=%h/.local/share/dalan/drainer-health.json` to the heartbeat service's `[Service]` section (a commented example is included). Use the actual data root from `dalan paths --json`; existing installs using legacy roots should point this setting to their existing drainer-health file. With the setting enabled, missing, malformed, unhealthy, more than 150 seconds old, or more than 30 seconds future-dated evidence prevents the ping. The checker atomically writes `~/.local/share/dalan/health.json` only after those checks pass:

```json
{"healthy":true,"observed_at":"2000-01-01T00:00:00.000Z"}
```

The pinger independently requires a timestamp no more than 90 seconds old and no more than 30 seconds in the future. A failed local check removes stale positive evidence. Install `systemd/dot-bridge-heartbeat.service` and its timer in `~/.config/systemd/user/`; set the unit PATH (replace `/ABSOLUTE/PATH/TO/NODE/BIN` with your Node binary directory) so it resolves Node 24+. For user units to run when logged out, enable lingering with `loginctl enable-linger <user>`. Adjust `WorkingDirectory` and `ExecStart` to the checkout, and set `Environment=DOT_DEADMAN_ENV=%h/.config/dalan/deadman.env` to the private file above (use the actual config root for existing installations). Run `systemctl --user daemon-reload`, then `systemctl --user enable --now dot-bridge-heartbeat.timer` after the bridge and independent receiver are configured. If opting in to drainer evidence, configure and enable its writer/timer first. These files do not install or restart the live bridge.

The timer is one minute; the five-minute receiver deadline tolerates a few missed runs. A successful HTTP response proves only that the remote receiver accepted a heartbeat. It does not prove the external provider delivered an alert or that a person saw it. Test provider delivery and host/network-loss notification separately before claiming the dead-man path is operational.

## Local check

From a source checkout installed with `npm ci`, run the deterministic state and HTTP boundary checks below. These test scripts are not included in the npm package:

```sh
node scripts/deadman-test.mjs
node scripts/deadman-transport-test.mjs
node scripts/host-health-test.mjs
node scripts/heartbeat-e2e.mjs
```

The tests use fake time, temporary SQLite databases, and loopback listeners, including a stopped listener with a full accept queue to prove safe retry before connection. They do not contact an external host or notification provider.
