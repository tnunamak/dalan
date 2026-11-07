# Run Dalan as a service

Use this guide after a first job works with `dalan try`, when you want a bridge that keeps running or a worker on another computer. Built-in OAuth binds the bridge to `127.0.0.1`; a tunnel or HTTPS reverse proxy forwards worker traffic to that listener. The owner CLI uses a private Unix socket, which must never be exposed through the proxy.

## Keep a local trial working

Setup has no local-only service mode, and it needs either `--public-url https://HOST` or `--expose tailscale` (or `--expose ngrok`, for the [ngrok](https://ngrok.com/) tunnel service), so a service always has an HTTPS origin. Dalan does not supply a launchd or systemd recipe for a bridge that serves only `127.0.0.1`, and it cannot convert the paired trial home into a service. Do not point setup at the trial home: it needs a fresh home.

To go from a trial to a service:

1. Keep the trial home if you want its results. Save them first, while `dalan try` still runs: with `DALAN_HOME` set to the trial home, run `dalan inbox --all --json` to list the request IDs, then `dalan get REQUEST_ID --json > result-REQUEST_ID.json` for each result you want. Then stop `dalan try` with Ctrl-C.
2. Run setup below with a new home. It makes a new bridge, with its own keys and port.
3. Pair the worker again, as the setup steps below describe. Re-running `try` or pairing replaces the worker client's old connection. Remove the old entry first with `codex mcp remove NAME` or `claude mcp remove --scope user NAME`.
4. Run the first job again on the new bridge. Read old results from the files you saved in step 1. To read a result you did not save, the trial bridge must run again: `dalan get` asks the running bridge through the admin socket in `DALAN_HOME`, so with the trial stopped it fails with `connect ECONNREFUSED`, and setting `DALAN_HOME` does not start it. Start the retained trial bridge by hand, from the Dalan checkout or package directory, on the port that its `as.json` names (the trial home is tied to that port), then read the result from a second shell:

   ```sh
   export DALAN_HOME=TRIAL_HOME
   port="$(sed -n 's#.*"public_url": *"http://127.0.0.1:\([0-9][0-9]*\)".*#\1#p' "$(dalan paths --config-root)/as.json")"
   HOME="$DALAN_HOME" DALAN_LOOPBACK=1 DALAN_AUTH_MODE=builtin DALAN_PORT="$port" node src/server.mjs
   # second shell, with DALAN_HOME set to TRIAL_HOME again:
   dalan get REQUEST_ID --json
   ```

   Stop it with Ctrl-C when you have read the results. Do not run `dalan try` for this, because it pairs the worker again and replaces the worker client's connection to the new bridge. If the new service already listens on the trial's port, read the old results before you start the service.

If you want only a bridge on this computer that stays up, run the server in a terminal as the [manual setup](manual-setup.md#owner-and-requester-setup) describes, which is the supported local path.

## Owner setup

You need the installed package (from `npm install -g @tnunamak/dalan`) or a checkout, a stable Node.js 24 LTS or newer executable, a fresh private bridge home, and a free port from 1024 through 65535. Use short, space-free paths without symlinks; on Linux, starting the service needs a running systemd user manager; on macOS, it needs the user's launchd domain (`user/UID`), which exists while that user has a login session. The script checks those before writing a service with `--start`.

On macOS the service is a LaunchAgent. A LaunchAgent starts when you log in to the Mac and stops when you log out, so it does not run after a reboot until someone logs in and you cannot rely on it for unattended availability.

**After a reboot on macOS:**

- **Check:** log in, then run `dalan status --json` (with `DALAN_HOME` set to the service home) and send one first job to prove the worker path still works.
- **Check the agent itself:** run `launchctl print user/$(id -u)/org.dalan.dot-bridge-NAME | grep -E 'state|pid|runs'`. Setup loads the agent into the `user/UID` domain, and `state = running` with a `pid` means the bridge is up.

**Symptom: `launchctl print` prints `Could not find service`.**

- That print only says that the agent is not in the `user/UID` domain; it does not say the service failed.
- **Check:** run `dalan status --json`, and run the same `launchctl print` with `gui/$(id -u)` in place of `user/$(id -u)`. An agent that an older release loaded lives in `gui/UID`.
- **Action:** if neither shows `state = running` and `dalan status --json` fails, load the agent with the `bootstrap` and `kickstart` lines in [Restart a service and check its state](operations.md#restart-a-service-and-check-its-state).

The domain and label are the ones that `worker-bridge-setup.mjs` writes.

### After a reboot

The bridge and the worker come back by separate rules:

- **Bridge, Linux.** The generated unit is wanted by `default.target`, so it starts when your systemd user manager starts. Without lingering, that is your first login after the reboot; with lingering (an administrator runs `loginctl enable-linger USER`; setup warns when it is off), it is the boot. Check with `systemctl --user is-active dot-bridge-NAME.service`, which must print `active`.
- **Bridge, macOS.** It starts at your login, as described above.
- **Worker, both systems.** Dalan has no worker scheduler, and nothing wakes the worker when the bridge returns. Jobs wait in the queue until a worker run claims them. The supported way is manual, and it takes three steps. First wait until `dalan status --json` answers, with `DALAN_HOME` set to the service home. Then prompt the worker in its own client, for example: "Use Dalan to list pending work. Claim the oldest job you may claim, read it, report progress and finish it exactly as instructed. Stop when nothing is pending." In Codex, `codex exec "PROMPT" < /dev/null` runs that without a screen (see [worker clients](worker-clients.md)). Last, check that the job moved: `dalan wait REQUEST_ID` returns `finished`, or `dalan get REQUEST_ID --json` shows the report.

A schedule or hook in the worker's vendor tool is outside Dalan's supported path; [pull workers](pull-workers.md#ways-to-start-a-run) lists the patterns and what they cost. A queued job still expires under the [preparation-expiry rule](pull-workers.md#jobs-the-worker-never-takes) if no worker claims it in time.

Setup writes the service definition under the `HOME` (macOS: `$HOME/Library/LaunchAgents`) or `XDG_CONFIG_HOME` (Linux: `$XDG_CONFIG_HOME/systemd/user`) of the shell that runs it. The service manager reads only the real user locations, so run setup with your normal `HOME` and `XDG_CONFIG_HOME`; a different value writes a definition the manager does not see. Concurrent setup runs for one user serialize on a lock file in `/tmp/dot-bridge-setup-locks-UID`. A test run that must not wait on that lock can set `DALAN_SETUP_LOCK_DIR` to its own absolute directory.

Choose a worker name of up to 32 characters, starting with a lowercase letter and continuing with lowercase letters, digits, `-` or `_`. `pool` and `unknown` are reserved, and you replace `NAME`, `PORT`, `HOME_PATH` and the example hostname in the commands below.

### With an existing HTTPS reverse proxy

1. Configure a stable HTTPS origin that forwards to the bridge computer at `127.0.0.1:PORT`. Preserve the public `Host` header, including a non-default port. Rewriting Host to localhost returns HTTP 421; `X-Forwarded-Host` does not override this check.

   Forward the following routes without removing their prefixes, methods, query strings, authorization headers or cookies.

   | Route | Purpose |
   |---|---|
   | `/<secret>/mcp` | Carries worker MCP requests. |
   | `/.well-known/oauth-protected-resource/<secret>/mcp` | Identifies the protected resource and authorization server. |
   | `/.well-known/oauth-authorization-server/<secret>/oauth` | Publishes OAuth endpoints. |
   | `/.well-known/openid-configuration/<secret>/oauth` | Provides the discovery alias. |
   | `/<secret>/oauth` and `/<secret>/oauth/*` | Handle OAuth and browser pairing. |
   | `/signal/*` | Answers wake hooks when configured. |

   The proxy should terminate TLS and keep secret-bearing paths out of access logs. An unauthenticated request to `/admin` should return 404.

2. Generate and start the bridge from a checkout:

   ```sh
   node scripts/worker-bridge-setup.mjs --worker NAME --public-url https://bridge.example.com --port PORT --home HOME_PATH --start
   ```

   From an npm install (`scripts/worker-bridge-setup.mjs` ships in the package), use the installed copy with the same options:

   ```sh
   node "$(npm root -g)/@tnunamak/dalan/scripts/worker-bridge-setup.mjs" --worker NAME --public-url https://bridge.example.com --port PORT --home HOME_PATH --start
   ```

   Setup reports the private home and service definition. With an explicit `--public-url` it does not verify public DNS or HTTPS: before pairing, check that an unauthenticated request to `/admin` on the public origin returns 404. It enables repository tools unless you pass `--no-repo-tools`; it does not enable host checks or grant repositories. A reverse proxy on another Linux LAN computer can reach a generated forwarder by adding `--lan-forward ADDR:PORT`. Anything on that network can reach this forwarder, so retain HTTPS and OAuth at the public origin.

3. Set `DALAN_HOME` to the exact generated home and make `dalan` available on your PATH with the [manual setup](manual-setup.md#owner-and-requester-setup) steps (no shell helper is needed). The complete MCP URL is in the mode-0600 file `$DALAN_HOME/resource-url`. Use it only in the intended worker's connector settings.

   ```sh
   dalan status --json
   ```

   Status returns the running bridge's state. Continue with [worker pairing](manual-setup.md#worker-setup), using this HTTPS endpoint instead of the local loopback URL. Skip the manual setup's `dalan init` and foreground `node src/server.mjs` steps: the setup script already created the profile and started the service. The `<secret>` in each route above is the `BRIDGE_PATH_SECRET` from the manual [worker setup](manual-setup.md#worker-setup).

   The README and manual setup examples use the trial worker `local`. In every command that names a worker, replace `local` with your service's `NAME`:

   - Pairing: `dalan connect start --worker NAME` and `dalan connect approve CODE --worker NAME`.
   - Submission: `dalan submit --worker NAME ...` for the first job and for every repository job.
   - Repository grants: `dalan worker allow NAME OWNER/REPO` and `dalan worker list NAME --json`.

   `wait`, `get` and `decide` select the job by request ID and take no worker flag. Run them with `DALAN_HOME` set to this service's home; with the trial home they will not find the job.

### With Tailscale Funnel

A tailnet is your Tailscale private network. Check each item below before you run setup. Setup checks them too and stops with the exact next step when one is missing.

1. **Tailscale daemon.** On macOS, Funnel needs the open-source `tailscaled`. The App Store app and the Standalone app do not supply it, and they conflict with it. If one of them is installed, quit it and move it to the Trash. Then install the daemon with [Homebrew](https://brew.sh/) and sign in:

   ```sh
   brew install tailscale && sudo brew services start tailscale && sudo tailscale up
   ```

   See [macOS variants](https://tailscale.com/docs/concepts/macos-variants); on Linux, use the [installation guide](https://tailscale.com/download).
2. **Signed in.** Run `tailscale version` and `tailscale status`. The host must show as signed in.
3. **MagicDNS** (Tailscale's automatic DNS names for your devices). Turn it on at the [DNS page](https://console.tailscale.com/admin/dns).
4. **HTTPS Certificates.** On the same page, choose Enable HTTPS. Your machine's name then appears in public certificate transparency logs.
5. **Funnel policy.** In [Access controls](https://console.tailscale.com/admin/acls), add Funnel to the policy (the "Add Funnel to policy" button).
6. **Your shell user.** The user who runs setup must be allowed to manage Tailscale without `sudo`. If `tailscale funnel status` asks for `sudo`, run `sudo tailscale set --operator="$USER"` once.

Run setup with Funnel instead of an explicit public URL. From a checkout:

```sh
node scripts/worker-bridge-setup.mjs --worker NAME --port PORT --home HOME_PATH --expose tailscale --start
```

From an npm install:

```sh
node "$(npm root -g)/@tnunamak/dalan/scripts/worker-bridge-setup.mjs" --worker NAME --port PORT --home HOME_PATH --expose tailscale --start
```

Setup should report the derived HTTPS origin, generated service and exposure verification. It chooses the first free Funnel port from 443, 8443 and 10000, and the origin it prints includes that port when it is not 443. Pass `--funnel-port N` only to choose one; setup refuses a port that another Funnel or Serve rule already uses and never replaces that rule. Verify the selected port with the target client.

Setup prints a `dalan()` shell function for the owner commands; you can use it or set `DALAN_HOME` as step 1 says. Continue as follows, and skip `dalan init` and the foreground `node src/server.mjs` step, because setup already created and started this service.

1. Export `DALAN_HOME="HOME_PATH"` with the exact home you passed above, and run `dalan status --json`. Make `dalan` available on your PATH with the [manual setup](manual-setup.md#owner-and-requester-setup) steps. The private MCP URL is in `$DALAN_HOME/resource-url`, as in step 3 of the reverse-proxy route.
2. A worker on this computer follows [worker pairing](manual-setup.md#worker-setup). A worker on another computer follows [Native client on a remote HTTPS bridge](worker-clients.md#native-client-on-a-remote-https-bridge). Then run [submit, finish and read the result](manual-setup.md#submit-finish-and-read-the-result), replacing `local` with `NAME` in every command.

### When setup stops before verification

Setup with `--expose tailscale` or `--expose ngrok` can leave the home, service and keys in place if public DNS or HTTPS is not ready. Run the exact `--retry-public-check` command it prints after fixing the public route. That checks the existing installation without replacing its keys; do not rerun a fresh install over it. DNS checks can take up to ten minutes, followed by up to two minutes for HTTPS plus request overhead.

The retry has the form below. It needs the exposure record that those two modes save, so it does not work for an install made with an explicit `--public-url`.

```sh
node scripts/worker-bridge-setup.mjs --retry-public-check --worker NAME --public-url EXPOSURE_URL --port PORT --home HOME_PATH
```

It should mark the existing exposure verified. A 404 from unauthenticated `/admin` proves the expected public route answers, not that OAuth pairing or a worker job works, so complete both separately.

## Remove a generated service

Use the same worker and home that created it. The full list of things an uninstall must remove (service, homes, trial home, client entries, lock file) is in [operations](operations.md#remove-an-installation).

```sh
node scripts/worker-bridge-setup.mjs --remove --worker NAME --home HOME_PATH
```

From an npm install, run `node "$(npm root -g)/@tnunamak/dalan/scripts/worker-bridge-setup.mjs"` with the same options.

The script stops and removes its generated service and any unchanged recorded Funnel rule. It checks generated markers before removal and refuses to disable a Funnel rule that has changed. It retains the private home, keys and state. Add `--purge-home` only when you intend to delete those too. An interrupted copy or a modified service may require inspection instead of automatic removal.
