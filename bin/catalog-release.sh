#!/usr/bin/env bash
# Ship a prepared catalog change. ChatGPT caches the tool catalog, so the order matters:
# this script deploys first; then the operator refreshes the connector and restarts the service.
# Usage: bin/catalog-release.sh <branch>
set -euo pipefail
cd "$(dirname "$0")/.."
branch=${1:?usage: catalog-release.sh <branch>}
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit or stash first" >&2; exit 1; }
git merge --ff-only "$branch"
node scripts/catalog-golden-test.mjs
# This targets existing legacy deployments; a new installation uses the unit name its setup generator created.
systemctl --user restart dot-bridge
sleep 3
systemctl --user is-active --quiet dot-bridge
echo "Deployed. Now, in ChatGPT: press Refresh on the dot-bridge connector, then restart the worker conversation. Until then, tool calls fail."
