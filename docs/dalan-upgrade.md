# Upgrade to Dalan

`dalan` is the main command. The package also installs `dalan-worker`, `dalan-acp-agent`, `dalan-alert`, `dalan-deadman`, `dalan-heartbeat` and `dalan-pr-reviewer`. It does not install the commands of the `dot-bridge` package; change scripts, units and timers that run `dot-worker`, `dot-deadman`, `dot-heartbeat`, `dot-alert`, `dot-acp-agent` or `dot-pr-reviewer` to the `dalan` or `dalan-*` command. `DALAN_X` takes precedence over `DOT_BRIDGE_X`, including an explicitly empty value except `AUTH_MODE`; an empty `DALAN_AUTH_MODE` falls back to a non-empty legacy auth mode, or stays unset if neither supplies one; an actual legacy fallback emits at most one warning from the main thread in each process. The `DOT_ACP_*` and `DOT_DRAINED_*` adapter settings keep their existing names.

## Pre-upgrade checklist

Run these checks under each service's HOME and environment, using the new build. The operator remains responsible for service, proxy and connector changes.

Upgrade in this order: drain built-in-auth claims while the old service runs; stop every writer; take and verify the complete backup; replace the code; complete the stopped-service repository migration and any configuration or path changes; start the service; run `dalan resume` if you drained; then refresh connectors and finish the schema, status and authenticated smoke checks. Keep the backup until the post-start checks pass. The checklist below identifies requirements, not a separate sequence to run before startup. [Upgrade an npm install](#upgrade-an-npm-install) and [Upgrade a source install](#upgrade-a-source-install) provide the ordered steps.

**Run a command in the service's environment.** A generated service sets only `HOME` (the bridge home), `NODE_ENV=production`, `DALAN_AUTH_MODE=builtin`, `DALAN_PORT`, `PATH`, and `DALAN_ENABLE_WORKSPACE=1` when repository tools are on. Read them, then run each command with those values in front of that one command. Do not `export` them or change `HOME` in your shell: `launchctl` and `systemctl --user` need your own `HOME`.

Your shell can carry more than the service has. The README tells you to `export DALAN_HOME=...` and `DALAN_LOOPBACK=1` for a trial, and `dalan` makes `DALAN_HOME` win over the `HOME` you pass, so an inherited `DALAN_HOME` points every command at the trial, not at the service. `env -u NAME` removes a variable from one command. List the `DALAN_` and `DOT_BRIDGE_` names your shell exports, and remove each one that the service does not set:

```sh
env | grep -E '^(DALAN|DOT_BRIDGE)_' | cut -d= -f1
# Linux: read the values
systemctl --user show dot-bridge-NAME.service -p Environment --value
# macOS: read the values
plutil -p ~/Library/LaunchAgents/LABEL.plist | grep -A12 EnvironmentVariables
# then, for every dalan or node command in this guide (BRIDGE_HOME and PORT from the output above;
# add one -u for each other name the first command listed). Exception: do not put HOME=BRIDGE_HOME on the
# service-file commands `worker-bridge-setup.mjs --repoint`, `--remove` and `--write-units-only`. They find the unit
# files (macOS plists, Linux units) under your own HOME, so run them with your normal HOME:
env -u DALAN_HOME -u DALAN_LOOPBACK HOME=BRIDGE_HOME NODE_ENV=production DALAN_AUTH_MODE=builtin DALAN_PORT=PORT dalan doctor --json
```

Before the first command that writes (`worker migrate-repos`, the drain, `resume`), check where the command resolves: `env -u DALAN_HOME -u DALAN_LOOPBACK HOME=BRIDGE_HOME dalan paths --json` must print `config_dir`, `data_dir` and `state_dir` under `BRIDGE_HOME`. If they are under another home, a variable is still set.

Before checklist item 2 or the first start of the new version, stop every writer and take a consistent backup of each existing installation, even when paths and schema do not change. Include the config, data and state roots, but not the ownership-lock files described below. Take each SQLite database with `.backup`, as described in [operations](operations.md#upgrade-and-rollback). If `DALAN_WORKERS_FILE` points outside the config root, also include that workers file, its sibling `<name>-repos.json` journal, and its matching repository-policy audit log and checkpoint. Preserve the audit log and checkpoint as a pair, taking the checkpoint database with SQLite `.backup`. Resolve their actual configured locations before backing up; `dalan paths` does not list overridden files. `dalan paths` does not list overridden files. Step 2 reads the database without changing it, but it writes a one-time journal and can update the workers file.

1. If a requester uses T3 reverse control, set `DALAN_ENABLE_T3_TOOLS=1` before restart, retain its `t3` worker capability and inspect doctor. The legacy spelling is `DOT_BRIDGE_ENABLE_T3_TOOLS=1` when the new name is unset.
2. With the old service stopped, run `dalan worker migrate-repos --json` under that service's own HOME and environment file. Check that its `database` and `workers_file` belong to the same bridge; a mismatch seeds one bridge's job history into another bridge's lists, and the seed is not repeated. Then run `dalan doctor --json` and `dalan worker list --json`. Inspect each worker's migration-seeded exact list and add any further owner-approved repository with `dalan worker allow NAME OWNER/REPO`. The allow and deny commands refuse a workers file that is a symlink; edit the real file in that case. Fresh and explicit empty lists still deny repository work.
3. After upgrading, refresh non-legacy connectors and restart worker conversations to load the Dalan identity and, for a `t3`-capable worker, `notify_owner`.
4. For non-loopback external-OAuth HTTP, configure an HTTPS reverse proxy and set `DALAN_TRUST_PROXY=1`; same-machine workers can instead use the authenticated loopback profile below.
5. If migrating paths, stop every component and take the consistent backup of the SQLite databases (see [operations](operations.md#upgrade-and-rollback)) and encryption keys. Use the explicit procedure below for all roots, then verify `dalan paths`, `status`, `doctor` and an authenticated smoke job before removing the backup. A partial new root can remain inactive while the legacy root serves data.
6. After an explicit migration, update hardcoded socket, adapter, monitor and script paths and verify their operation. Valid mixed config/data roots are supported without file merging; the resolved roots are authoritative.
7. If any bridge is still on 0.2.0, take the schema-49 backup described in [operations](operations.md#from-020) before upgrading to schema 65. Drain built-in-mode claims before upgrading: older claims have no recorded connection and cannot act after migration; they must expire before a new grant can be acquired. See the [connection fence](portable-auth-profile.md#connect-a-worker).
8. Keep every existing catalog pin, including `legacy-v46`. Do not send `lease_ms` to a legacy-v46 bridge; its captured schema does not accept that field.
9. After every upgrade, whether or not paths changed: confirm the service is running and read its startup warnings; confirm the schema (below); run `dalan paths`, `status` and `doctor` under its environment; check authenticated connector discovery; and finish one repository-free worker job. If the worker does repository work, also finish one job on an allowed repository. `doctor` is local only and does not prove the service accepts work. Upgrade one bridge and pass this step before starting the next.

**Confirm the schema.** `dalan --version` is the package version, not the database schema. The service migrates `bridge.db` when it starts, so run this after the first start of the new version (checklist item 6 of the order above), under the service's environment, whether or not the service is running. It reads the database and changes nothing:

```sh
sqlite3 -readonly "$(env -u DALAN_HOME -u DALAN_LOOPBACK HOME=BRIDGE_HOME dalan paths --data-root)/bridge.db" 'PRAGMA user_version;'
```

For this release it must print `65`. A smaller number means the new version has not started on this database yet (the service is still the old code, or it stopped at start; read its log). A larger number is a database from a newer release: the service refuses to start on it, and you must not lower the number by hand (see [operations](operations.md#upgrade-and-rollback)).

An empty new `AUTH_MODE` is treated as unset so a templated variable cannot mask `DOT_BRIDGE_AUTH_MODE=builtin`. Without either auth mode, startup still fails closed. Other empty new names keep precedence: an empty bind is refused in builtin/loopback modes, an empty catalog selects `stable`, and an empty workers-file setting selects the effective default profile path rather than a legacy override. Check templated units for these cases.

## Upgrade an npm install

Releases before 0.4.0 were published as `dot-bridge`. The old package installs the commands `dot-worker`, `dot-deadman` and `dot-heartbeat`; Dalan installs `dalan` and `dalan-*` only. Remove the old package first so those old commands leave `PATH`; this removes only the code and leaves every bridge home, database and key alone, so a service that still names that code must be pointed at the new copy before it starts. Run step 1 while the old service is running. Then stop the service in step 2 and take the [backup](operations.md#upgrade-and-rollback) in step 3 before replacing code. Replace `NAME` with the worker name.

1. Drain, while the old service still runs. Put the new release in a scratch directory, so the old install stays in place, and run the drain from there with the service's own HOME and environment (see the drain paragraph in the [checklist](#pre-upgrade-checklist)):

   ```sh
   npm install --prefix "$HOME/dalan-new" @tnunamak/dalan@VERSION
   cd "$HOME/dalan-new/node_modules/@tnunamak/dalan" && env -u DALAN_HOME -u DALAN_LOOPBACK HOME=BRIDGE_HOME NODE_ENV=production DALAN_AUTH_MODE=builtin DALAN_PORT=PORT node scripts/upgrade-drain.mjs
   ```

   Replace `VERSION` with the release you want (`npm view @tnunamak/dalan versions` lists them). The command is `@tnunamak/dalan@VERSION` here and in step 3, so both steps use the same release. The script is in the package; an installed `dalan` of a release that ships `scripts/upgrade-drain.mjs` can run it from `"$(npm root -g)/@tnunamak/dalan"` the same way. `BRIDGE_HOME` and `PORT` come from [Run a command in the service's environment](#pre-upgrade-checklist).

The old package may not provide `dalan`. Until step 3 installs the new command, run new-release CLI commands as `node "$HOME/dalan-new/node_modules/@tnunamak/dalan/bin/dalan.mjs"` instead of `dalan`, with the same service-environment prefix. Use that staged CLI for every `dalan paths` call in the backup recipe; do not replace the serving package merely to obtain the backup command.

2. Stop the service. Linux: `systemctl --user stop dot-bridge-NAME.service`. macOS: `launchctl bootout user/$(id -u) ~/Library/LaunchAgents/LABEL.plist`; for an agent that an earlier release loaded, use `gui/$(id -u)` instead of `user/$(id -u)`. `LABEL` is `org.dalan.dot-bridge-NAME`. An install made by a release before 0.4.0 has a different label; find its file with `ls ~/Library/LaunchAgents | grep dot-bridge`.
3. Take the [backup](operations.md#upgrade-and-rollback), then replace the package and check which build the shell now runs:

   ```sh
   npm uninstall -g dot-bridge
   npm install -g @tnunamak/dalan@VERSION
   command -v dalan
   dalan --version
   ls "$(npm root -g)/@tnunamak/dalan/src/server.mjs"
   ```

   `dalan --version` must print `VERSION`, and the last command must find the file: that path is what step 4 writes into the service. If you installed with `--prefix DIR`, add the same `--prefix DIR` to the npm commands and run `DIR/bin/dalan`.
4. Point the service at the new code. The command changes only the code directory in the unit or plist; the port, bridge home and environment stay as they are:

   ```sh
   node "$(npm root -g)/@tnunamak/dalan/scripts/worker-bridge-setup.mjs" --repoint --worker NAME
   ```

   `--repoint` finds only the label `org.dalan.dot-bridge-NAME`. For a macOS service made by a release before 0.4.0, delete the old plist by hand after step 2, then write a new one for the same home and start it as in step 5: `node "$(npm root -g)/@tnunamak/dalan/scripts/worker-bridge-setup.mjs" --worker NAME --public-url URL --port PORT --home HOME_PATH --write-units-only` (use the URL, port and home of the old service).

   Before you start the service, run the review from [checklist](#pre-upgrade-checklist) item 2 with the new build, under the service's own HOME and environment, as in [Run a command in the service's environment](#pre-upgrade-checklist): `dalan worker migrate-repos --json` (it converts an old repository policy and needs the service stopped; check that its `database` and `workers_file` belong to this bridge), then `dalan doctor --json` and `dalan worker list --json` (each worker's repository access).
5. Start the service. Linux: `systemctl --user daemon-reload && systemctl --user start dot-bridge-NAME.service`, then `systemctl --user is-active dot-bridge-NAME.service` must print `active`. macOS: the agent is unloaded, so load it before you start it:

   ```sh
   launchctl bootstrap user/$(id -u) ~/Library/LaunchAgents/LABEL.plist
   launchctl kickstart -k user/$(id -u)/LABEL
   launchctl print user/$(id -u)/LABEL | grep -E 'state|runs'
   ```

   The last command must show `state = running`. `kickstart` on an agent that `bootout` unloaded fails with exit 113 (`Could not find service`).
6. Run `dalan resume` if you used the drain, run the schema check from [Confirm the schema](#pre-upgrade-checklist) (it must print `65`), then follow step 5 of [Upgrade a source install](#upgrade-a-source-install): check the log shows `MCP listening` and finish a [first-job smoke check](operations.md#smoke-check-an-installed-service). When the smoke check passes, remove the staging install from step 1: check that the unit directory for your system has no unit that names it (Linux: `grep -Rl dalan-new ~/.config/systemd/user`; macOS: `grep -RSl dalan-new ~/Library/LaunchAgents`). `grep` exits 1 and prints nothing when it finds none; any other exit status, or any error message, means the check failed, so do not delete anything until you fix it. Then delete `$HOME/dalan-new` (it holds no bridge home). It is also in the [uninstall list](operations.md#remove-an-installation).

## Upgrade a source install

A source install is a Git checkout that `npm link` put on your PATH. Drain while the old service is running in step 1, then stop it and take the [backup](operations.md#upgrade-and-rollback) before step 2. Keep it stopped through step 3; step 4 starts it again. Replace `CHECKOUT` with the absolute path of your checkout and `TAG` with the release you want.

1. Drain, then stop the service. With built-in auth, drain first while the old service still runs: `git -C CHECKOUT worktree add "$HOME/dalan-drain" TAG`, then `cd "$HOME/dalan-drain" && npm ci && env -u DALAN_HOME -u DALAN_LOOPBACK HOME=BRIDGE_HOME NODE_ENV=production DALAN_AUTH_MODE=builtin DALAN_PORT=PORT node scripts/upgrade-drain.mjs` (values from [Run a command in the service's environment](#pre-upgrade-checklist)). Then stop the service. Linux: `systemctl --user stop dot-bridge-NAME.service`. macOS: `launchctl bootout user/$(id -u) ~/Library/LaunchAgents/LABEL.plist`; for an agent that an earlier release loaded, use `gui/$(id -u)` instead of `user/$(id -u)`. `LABEL` is `org.dalan.dot-bridge-NAME` for a new install. An install made by a release before 0.4.0 has a different label; find its file with `ls ~/Library/LaunchAgents | grep dot-bridge`. The path is under the `HOME` that setup ran with, which is the directory that holds your `Library` folder.

Before replacing or relinking the old checkout, use `node "$HOME/dalan-drain/bin/dalan.mjs"` instead of `dalan` for the backup recipe's CLI calls, with the same service environment. This uses the new tag staged above while leaving the serving checkout unchanged.
2. Replace the code, then link it again so the commands in this document exist:

   ```sh
   cd CHECKOUT
   git fetch origin --tags
   git checkout TAG
   npm ci
   npm unlink -g dot-bridge
   npm link
   dalan paths --json
   ```

   A checkout of a release before 0.4.0 is linked under the old package name `dot-bridge`. `npm unlink -g dot-bridge` removes the old link and its commands only; it prints nothing to remove if you never linked the old code. A release before 0.4.0 installs `dot-worker`, not `dalan`; `dalan` exists after the `npm link` above. Then run `node scripts/worker-bridge-setup.mjs --repoint --worker NAME` from this checkout, whether or not it moved. It points the unit at this checkout when the path changed, and on macOS it adds the `Background` and `Aqua` session types that the `user/UID` domain needs to a plist that lacks them (it prints `already points at` when there is nothing to change). It changes nothing else in the unit. It finds only the label `org.dalan.dot-bridge-NAME`: for a macOS agent made by a release before 0.4.0, delete the old plist by hand (step 1) and write a new unit with the `--write-units-only` command in step 4 of [Upgrade an npm install](#upgrade-an-npm-install) before you start the service.
3. Run the commands in the checklist above (`dalan worker migrate-repos --json`, `dalan doctor --json`, `dalan worker list --json`) under the service's own HOME and environment, as in [Run a command in the service's environment](#pre-upgrade-checklist).
4. Start the service again, then run `dalan resume` (with the same `env` prefix) if you drained.
   - Linux: `systemctl --user daemon-reload && systemctl --user start dot-bridge-NAME.service`, then `systemctl --user is-active dot-bridge-NAME.service` must print `active`.
   - macOS: step 1 unloaded the agent, so load it first: `launchctl bootstrap user/$(id -u) ~/Library/LaunchAgents/LABEL.plist`, then `launchctl kickstart -k user/$(id -u)/LABEL`, then `launchctl print user/$(id -u)/LABEL | grep -E 'state|runs'` must show `state = running`. `kickstart` alone fails with exit 113 after `bootout`, because the service is no longer loaded. Keep the `kickstart` after the `bootstrap`: a plist generated by an older release can load with `state = not running` and never start until it is kicked.
5. Check the log shows `MCP listening`, run the schema check from [Confirm the schema](#pre-upgrade-checklist) (it must print `65`), then finish a [first-job smoke check](operations.md#smoke-check-an-installed-service).

The upgrade does not rewrite the service that an older release generated. That service keeps its unit or plist name (on macOS, the launchd label that release created), its `DOT_BRIDGE_*` environment names and its `~/.config/dot-bridge`, `~/.local/share/dot-bridge` and `~/.local/state/dot-bridge` directories. It works as it did, and each start logs one deprecation line for the old environment names. `worker-bridge-setup.mjs --remove` finds only the current label. Stop an agent of a release before 0.4.0 and delete its plist by hand before you remove the install; `--purge-home` refuses while another unit file in the user's unit directory names the home or a process holds its `bridge.db` open, and it names what it found. Do not run `worker-bridge-setup.mjs` again for the same worker to "refresh" it: it refuses to overwrite an existing unit.

## Existing homes and explicit path migration

Fresh homes use `~/.config/dalan`, `~/.local/share/dalan`, `~/.local/state/dalan`, `~/.tmp/dalan`, and `~/.dalan/prepared-node-modules`. An existing legacy root remains in use when the corresponding new root is absent. Existing legacy installations also keep their not-yet-created state roots under the old name. An empty new root, empty directory scaffolding or zero-byte placeholders never hide a populated legacy root. Partial bootstrap roots also remain inactive until they contain the listed durable components present in the legacy root: authorization keys, database ledgers, worker profiles and their audit, thread limits, alert files and the ACP secret. Signal tokens count as one group: if the legacy root holds any `signal-token` or `signal-token.NAME` file, the new root must hold at least one, because rotation can replace one form with the other. The check uses this fixed list. It is not a full comparison, so a copy that lacks a custom file can still win; move whole roots, as below, and verify `dalan paths` afterwards. A listed file you removed on purpose from the new root keeps the legacy root in use; remove it from the legacy root too, or remove the legacy root after the explicit migration. When both corresponding roots are initialized, the new root wins. Companion roots that do not exist yet follow the existing installation; after a complete config, data or state area is explicitly migrated, absent companions use the new spelling. Complete config-only or data-only migrations can therefore start with the other area still under its legacy name. A missing workers profile recorded as previously present still requires explicit recovery, regardless of the directory spelling. Files from two roots are never merged. Repository checks prefer `.dalan.json` and accept `.dot-bridge.json` when the new file is absent.

No startup command moves data. Existing OAuth issuers (an external issuer keeps being asked for the `dot-bridge.read` and `dot-bridge.work` scopes unless you set `OAUTH_SCOPE_NAMES=neutral` in `oauth.env`), resource URLs, scopes, client IDs, signing keys, storage keys, database records and path secrets retain their values. Existing service-unit filenames and internal adapter script filenames remain compatibility names. The globally installed executable names change to `dalan` and `dalan-*` as listed at the start of this guide; update scripts and timers that invoke the old package commands.

When a populated new config, data or state root is passed over, `dalan paths` warns on stderr (`--json` includes a `warnings` array) and startup logs a `root_passed_over` event naming the area, chosen legacy root, passed-over new root and missing legacy file names, never their contents; complete or empty new roots do not warn.

Ownership-lock files are not application data: exclude `as-owner.sqlite` and `bridge.db.secrets/owner.sqlite` from every backup, copy, sync and restore. Never read, unlink, rename or replace them while an owner may hold them; contenders must use the same inode. With every component stopped, let the software recreate missing locks locally after restore. Preserve the application databases and encryption keys, including `bridge.db.secrets/storage.key`. See [ownership and backup rules](operations.md#built-in-authorization-server-ownership).

To migrate paths explicitly:

1. Stop the service and every CLI, heartbeat, monitor and adapter using this HOME. Make a consistent backup of the config, data and state roots, excluding ownership-lock files and taking each SQLite database with `.backup`; use the backup and rollback procedure in [operations](operations.md#upgrade-and-rollback).
2. Inspect both names under each parent below. If both exist, resolve the conflict manually before proceeding. Do not overwrite or merge databases or authorization-server keys.
3. With the processes stopped, run this in the service HOME's shell. It refuses an existing destination and preserves permissions through a directory rename.

```sh
for parent in .config .local/share .local/state .tmp; do
  old="$HOME/$parent/dot-bridge"
  new="$HOME/$parent/dalan"
  if [ -e "$old" ]; then
    [ ! -e "$new" ] || { echo "Refusing existing destination: $new" >&2; exit 1; }
    mv "$old" "$new" || exit 1
  fi
done
if [ -e "$HOME/.dot-bridge" ]; then
  [ ! -e "$HOME/.dalan" ] || { echo 'Refusing existing .dalan cache' >&2; exit 1; }
  mv "$HOME/.dot-bridge" "$HOME/.dalan"
fi
```

4. Update any explicit paths in service environment, adapters and external scripts. Start the service, then use `dalan status --json`, `dalan doctor --json` and an authenticated worker smoke job. Verify the same jobs, connections and artifacts before removing the backup. To roll back path selection, stop all components and rename the directories back before starting the old build.

Migrating paths does not rename the repository, DNS names, OAuth scope strings, Git refs, report-format identifiers or service unit filenames.

## T3 control and notification aliases

The six `t3_thread_*` tools are off by default. Two read threads (`t3_thread_list`, `t3_thread_read`); the others wait on, create, send to and reconfigure threads. An existing installation that uses them must set `DALAN_ENABLE_T3_TOOLS=1` before upgrading and retain each worker's existing `capabilities: ["t3"]` grant. The exact legacy spelling `DOT_BRIDGE_ENABLE_T3_TOOLS=1` is also accepted when `DALAN_ENABLE_T3_TOOLS` is unset. The switch turns on all six, so a worker with the grant gets write and control access to T3 threads, not only read access. Keep the current catalog profile pin; this switch does not change its job protocol or tool schemas.

`notify_owner` is the notification tool. Its earlier alias was removed; a call to the old name now fails with `unknown tool`, so change any caller and refresh the connector. `notify_owner` keeps its `{text}` schema, work scope, capability check, audit admission and persistent deduplication ledger. It does not depend on the reverse-control switch. Notification retries keep using the `dot-bridge/idempotencyKey` metadata namespace.

Refresh a non-legacy connector for a worker with the `t3` capability to discover `notify_owner`. A worker without that capability cannot discover or call `notify_owner`. Enabling the reverse-control switch retains the six `t3_thread_*` names and input schemas. The removed notification alias is the exception described above: callers must use `notify_owner`. The explicit `legacy-v46` compatibility profile retains its exact twelve-tool catalog; it gains no notification tool. No OAuth scope rename or new authorization grant is needed for existing tools. See [T3 reverse control](t3-reverse-control.md).

## Repository policy requires an explicit list

Fresh installations deny repository inputs unless explicitly allowed. On an existing installation, the first upgrade seeds omitted policies from that worker's retained claims and jobs that are still queued and live under the service's expiry rules, as described below. The legacy profile retains its identity and can use that persisted exact list. `DALAN_LEGACY_PROFILE=1` can permit the existing profile-recovery path, but never grants repository access.

Before upgrading a worker that relied on implicit access, inspect the seeded list with the migration and doctor commands below; add any additional owner-approved repository with `dalan worker allow NAME OWNER/REPO`. Existing exact lists keep their meaning, and denied queued jobs remain queued; an already-valid grant can finish under its existing lease and epoch. See [legacy repository-policy migration](operations.md#legacy-repository-policy-migration).

## Same-machine workers over HTTP

This is a recipe for a new, separate local installation, not a conversion of an existing bridge. For an in-place upgrade, keep the existing HOME, worker profile, auth mode and public URL: do not rerun `init --worker` against an existing profile, and do not delete authorization files to make it succeed. Changing an existing public URL changes the issuer and ends every connection.

From the installed checkout, use the built-in authorization server for authenticated local clients. Choose a fixed free port and initialize a new, empty HOME with the same settings used at startup:

```sh
export DALAN_HOME="$HOME/dalan-local"   # a path that does not exist yet; not your service home or a trial home
export DALAN_LOOPBACK=1 DALAN_AUTH_MODE=builtin DALAN_PORT=8787
dalan init --worker local --public-url http://127.0.0.1:8787
HOME="$DALAN_HOME" node src/server.mjs
```

The listener binds only `127.0.0.1`, and `DALAN_BIND_HOST`, if set, must be exactly `127.0.0.1`. No test OAuth switch is needed, including with `NODE_ENV=production`. The secret MCP path alone grants no access: every MCP call requires a valid, approved bearer token, and revocation is checked on each call. Authentication-off settings cannot bypass this requirement in loopback mode.

In a second shell with the same `DALAN_HOME`, port and auth settings, allow the client's exact callback path and open a pairing window:

```sh
dalan connect allow-callback http://127.0.0.1/callback
dalan connect start --worker local
```

Use the client's actual callback path. HTTP callbacks may use `127.0.0.1`, `localhost` or `[::1]`, with any port, as described in [RFC 8252 section 7.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3). Omit the port in an owner allow-list pattern; an explicit port is refused because native client ports vary. Each hostname and path needs its own owner allow-list entry; paths cannot contain wildcards, queries or fragments. For a native callback, the teammate reads the code from the browser page on their own machine and shares it with the owner over a trusted channel. The owner compares that code and the full redirect, then passes the redirect to `dalan connect approve CODE --worker local --confirm-redirect URI`; this flag checks for a typo only, not identity. When several pairings are pending, approval selects the unique entry matching the code. If the code matches no unique entry, run `dalan connect pending` and compare codes. The registered callback port may differ from the port used for the authorization flow. Non-loopback HTTP callback URIs remain refused; remote bridges accept only explicitly allowlisted canonical native loopback URIs. The listener itself remains IPv4 loopback only.

Every HTTP route checks the exact `Host: 127.0.0.1:PORT` authority. A present Origin must be exactly `http://127.0.0.1:PORT`; absent Origin still requires MCP authentication. Null, foreign, duplicate and malformed origins, alternate hosts and forwarded authority headers are refused before routing. Browser clients hosted at another origin cannot use this mode. This is a local HTTP interoperability profile, not a general replacement for OAuth's HTTPS deployment rules. The checks cover host and origin validation and authentication against DNS rebinding.

For a non-loopback HTTP listener behind a TLS reverse proxy, explicitly set `DALAN_TRUST_PROXY=1` and configure the proxy to terminate HTTPS. The flag acknowledges that deployment requirement; it does not enable TLS or make forwarded headers trusted in loopback mode. The existing built-in HTTPS public-URL mode continues to bind loopback behind its tunnel.

Outside the local production profile, authentication-off fixtures must explicitly set `DALAN_DEV_ALLOW_UNAUTHENTICATED=1` and cannot use `NODE_ENV=production`. The historical `DALAN_ALLOW_INSECURE_PUBLIC=1` alias remains restricted to non-production fixtures, and neither flag permits authentication-off loopback mode.

## Preserve historical repositories on upgrade

On the first start against an existing database, a worker with no explicit `repos` list receives an exact list from that installation's retained jobs: the distinct well-formed `inputs[0].github_repo` values of jobs that worker claimed, plus jobs still queued and live under the service's expiry rules. Queued jobs already expired under those rules do not count, even when the service was stopped before its expiry sweep. A queued job with a blocked destination still seeds its repository because the owner submitted that work under the old policy; the destination block still prevents the job from being claimed until resolved. The migration output lists each seeded repository and the queued job IDs that caused it. A still-queued job for an unlisted repository stays queued until `dalan worker allow` adds it. Other workers' jobs cannot add repositories. The migration does not fetch repositories or infer issuer, subject or client bindings.

For an existing identity profile, startup fills only omitted lists and leaves explicit lists, including `[]`, unchanged. For the legacy worker without `workers.json`, the repos-only `workers-repos.json` journal keeps the exact list without creating an identity profile. Fresh installations remain deny-by-default. A later worker, later job or restart cannot expand the seed; removing an already-published list does not trigger another history scan.

The private journal commits each seed and one audit event together, with `before: legacy-any` and `after: exact`. Interrupted profile publication reuses that committed seed. Doctor and `worker list --json` show the resulting lists and audit events. Back up `workers-repos.json` with the rest of the private configuration. Preserve `bridge.db.secrets/storage.key` with the encrypted database too; a new data sibling missing that key cannot replace the legacy root, even when all its other data files exist.

Before upgrading a built-in-auth installation, run `node scripts/upgrade-drain.mjs` from the new release while the old service is still running, with the old HOME and environment. From a checkout, run it in a checkout of the new tag (`git worktree add`). For an npm install, run it from a scratch copy of the new package (`npm install --prefix "$HOME/dalan-new" @tnunamak/dalan@VERSION`, then `cd "$HOME/dalan-new/node_modules/@tnunamak/dalan"`): it uses the `bin/dot-worker.mjs` in the current directory. Use the same `VERSION` that you will install in the upgrade; do not substitute the latest release for the planned one. It pauses new claims but does not pause submissions, so jobs can still be queued while it waits. It prints each active job ID and lease expiry. The default timeout is five minutes; set `DALAN_UPGRADE_DRAIN_TIMEOUT_MS` for another bounded wait. If a command times out, returns an HTTP error, or prints invalid JSON, the drain prints the same recovery step: keep the old service running, let workers finish or wait for leases to expire, run `dalan resume` under the old HOME, then retry the drain. After a successful drain, stop the old service, replace only the code, start the new service with the same HOME and configuration, then run `dalan resume` to release the persisted pause. An expired lease revokes the old claim ID but does not prove its process stopped; the new service sweeps the row back to the queue, where the claimant can resume the work only with a fresh claim epoch after stopping the old run. Pre-upgrade claims have no authenticated connection binding and cannot be safely assigned one during migration.

To inspect and finish the migration before restarting the service, stop the service and run the new build with its HOME, PATH and environment:

```sh
dalan worker migrate-repos --json
dalan doctor --json
dalan worker list --json
```

This command reads the existing database without migrating its schema. It performs the same one-time migration as startup and requires no identity profile for worker. Afterwards, `dalan worker allow worker OWNER/REPO` and `dalan worker deny worker OWNER/REPO` can edit the profile-less worker's exact list; those owner edits are audited. Configured workers use the same commands with their own names. Seeded repositories remain subject to authentication, worker visibility and all execution policy.

Doctor also warns when a worker retains the `t3` capability while reverse-control tools are off. Set `DALAN_ENABLE_T3_TOOLS=1` (or, only when the new name is unset, `DOT_BRIDGE_ENABLE_T3_TOOLS=1`) to retain those tools. The opt-in catalog comparison is deliberate: it proves an explicitly configured upgrade preserves every parent tool field and adds `notify_owner`; it does not claim a no-edit upgrade keeps T3 enabled. Existing durable T3 notices retain their old command spelling because rendered notice bytes are part of delivery-ACK identity; those commands remain working aliases.

Older builds do not enforce the profile-less repos-only policy. Reverting only the executable restores their historical repository authority; rollback must account for that difference as well as restoring consistent private state.

Restoring the backed-up private state also restores the built-in OAuth server's database. A connector that refreshed its token after the backup gets `invalid_grant` and must sign in again. Copy the current state aside before you restore it, so the restore itself can be undone. A code-only rollback keeps every sign-in, except that a connection approved with the neutral `dalan.read` and `dalan.work` scopes after the upgrade must reconnect, because an older build only knows the `dot-bridge.*` names.

## Breaking security changes in 0.4.0

External-OAuth installations binding `0.0.0.0` (or another non-loopback address) now require an HTTPS reverse proxy and `DALAN_TRUST_PROXY=1`. `DALAN_ALLOW_INSECURE_PUBLIC=1` cannot waive this acknowledgment. Authentication-off `DALAN_ALLOW_INSECURE_PUBLIC` and `DALAN_DEV_ALLOW_UNAUTHENTICATED` settings are refused with `NODE_ENV=production`; use built-in or external OAuth instead.

Startup reports one `repository_policy_empty` event per worker with an empty exact list, including `queued_repo_jobs_blocked`. Review that count and the migration audit before resuming repository work. Loopback Host/Origin refusals record `mcp_inbound` with status `403` and route `loopback`, without headers, credentials or request bodies.

## Fix-loop source name

The producer source for the fix loop is now `fix-loop`. The name used before this release (formerly `dot-fix`) is still accepted by `dalan submit --source`, in `/submit` metadata, in objective keys and task kinds, and in old receipts. Stored rows keep the old value in the `assignments.source` column, so no schema migration runs and a rollback needs no data change; the bridge reads it back as `fix-loop`. New lifecycle `integrated` events use the actor `fix-loop`; earlier events keep the old actor. Stored objective keys and task kinds keep their old spelling too (`dot-fix:...`, `dot-fix`). Retries, `backfill-objectives`, rework and duplicate counts, and the per-kind queue, throughput and rejection reports read both spellings as one (`fix-loop`). Rows that earlier releases rolled into the daily throughput table are read back under `fix-loop` as well.

Deploy the CLI and the server together. A request that the new CLI sends or stores with `fix-loop` as its source, objective key or task kind is rejected by a server that has been rolled back to an earlier release, so a rollback of the server needs a rollback of the CLI, and the reverse. The database itself needs no change in either direction.

## PR-head reviewer report thread key

The `report_thread_id` key of the PR-head reviewer config was named `lead_thread_id` before this release. The old key is still read; when both are set, `report_thread_id` wins. The `delivery_via` value in the reviewer log for this fallback is now `report-thread` (it was `lead`).
