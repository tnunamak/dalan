#!/usr/bin/env bash
# Ship a prepared catalog change. Refresh the connector and restart the worker
# conversation only after the candidate service is active, answering on its admin socket, and the branch is advanced.
# Usage: bin/catalog-release.sh <branch>
set -euo pipefail
if [[ $# -ne 1 || -z "$1" ]]; then
  echo 'usage: catalog-release.sh <branch>' >&2
  exit 2
fi
cd "$(dirname "$0")/.."
branch=$1
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit or stash first" >&2; exit 1; }
current_ref=$(git symbolic-ref -q HEAD) || { echo "release requires a checked-out branch" >&2; exit 1; }
previous=$(git rev-parse --verify HEAD)
candidate=$(git rev-parse --verify --end-of-options "${branch}^{commit}")
git merge-base --is-ancestor "$previous" "$candidate" || { echo "candidate is not a fast-forward" >&2; exit 1; }

# This targets existing legacy deployments; new installations use their generated unit name.
unit=dot-bridge
# Active is not ready: the unit can be active while the bridge has not opened (or has lost) its admin socket.
admin_socket_listening() { node scripts/admin-socket-probe.mjs; }
wait_active() {
  local attempt
  for ((attempt=1; attempt<=20; attempt++)); do
    systemctl --user is-active --quiet "$unit" && admin_socket_listening && return 0
    if ((attempt < 20)); then sleep 1; fi
  done
  return 1
}
switched=0
restart_attempted=0
promoted=0
restore_previous() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 && switched && !promoted )); then
    if git switch --detach "$previous"; then
      if [ "$(git rev-parse --verify "$current_ref")" = "$previous" ]; then
        git symbolic-ref HEAD "$current_ref" || echo "Could not reattach the original branch." >&2
      fi
      if (( restart_attempted )); then
        systemctl --user restart "$unit" && wait_active ||
          echo "The branch was not advanced, but the prior service needs operator recovery." >&2
      fi
    else
      echo "Could not restore the original checkout; inspect it before restarting the service." >&2
    fi
  fi
  exit "$status"
}
trap restore_previous EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git switch --detach "$candidate"
switched=1
node scripts/catalog-golden-test.mjs
restart_attempted=1
systemctl --user restart "$unit"
wait_active || { echo "Candidate bridge did not become active and listening before the deadline." >&2; exit 1; }

# Compare-and-swap only the local branch after readiness. The index and service
# checkout already hold the candidate; attaching HEAD doesn't replace their files.
git update-ref "$current_ref" "$candidate" "$previous"
promoted=1
git symbolic-ref HEAD "$current_ref"
echo "Deployed. Now, in ChatGPT: press Refresh on the dot-bridge connector, then restart the worker conversation. Until then, tool calls fail."
