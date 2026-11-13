#!/usr/bin/env bash
# Verify and publish @tnunamak/dalan from a fresh clone.
# Usage: publish-dalan.sh VERSION [--dry-run] [--ref REF] [--tarball FILE]
# A ref or supplied gate tarball is allowed only for a dry run. Real uploads
# require vVERSION on origin/main. The same packed bytes are installed and published.
set -euo pipefail
version="${1:?usage: publish-dalan.sh VERSION [--dry-run] [--ref REF] [--tarball FILE]}"
shift
dry=false
ref="v$version"
custom_ref=false
gate_tarball=""
while (($#)); do
  case "$1" in
    --dry-run) dry=true; shift ;;
    --ref) ref="${2:?missing ref}"; custom_ref=true; shift 2 ;;
    --tarball) gate_tarball="${2:?missing tarball}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if ! $dry && { $custom_ref || [[ -n "$gate_tarball" ]]; }; then
  echo '--ref and --tarball require --dry-run' >&2; exit 2
fi
pkg='@tnunamak/dalan'
repo='https://github.com/tnunamak/dalan.git'
mkdir -p "$HOME/.tmp"
work="$(mktemp -d "$HOME/.tmp/dalan-publish.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
if [[ -n "$gate_tarball" ]]; then gate_tarball="$(realpath "$gate_tarball")"; fi
git clone --quiet "$repo" "$work/src"
cd "$work/src"
git fetch --quiet --tags origin
if $custom_ref; then
  git fetch --quiet origin "$ref"
  sha="$(git rev-parse 'FETCH_HEAD^{commit}')"
else
  sha="$(git rev-parse "refs/tags/$ref^{commit}")"
  git merge-base --is-ancestor "$sha" origin/main
fi
git checkout --quiet --detach "$sha"
[[ -z "$(git status --porcelain)" ]] || { echo 'checkout is not clean' >&2; exit 1; }
node --input-type=module -e 'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json")); if(p.name!==process.argv[1]||p.version!==process.argv[2])process.exit(1)' "$pkg" "$version"
echo "ref $ref -> $sha"
if ! $dry && npm view "$pkg@$version" version >/dev/null 2>&1; then
  echo "$pkg@$version is already on npm" >&2; exit 1
fi
# Dalan ships JavaScript sources; no generated build is required.
tarball="$(npm pack --silent --pack-destination "$work")"
tarball="$work/$tarball"
if [[ -n "$gate_tarball" ]]; then
  cmp "$tarball" "$gate_tarball" || { echo 'gate tarball differs from the fresh clone pack' >&2; exit 1; }
  tarball="$gate_tarball"
fi
sha256sum "$tarball"
mkdir "$work/smoke" "$work/home"
cd "$work/smoke"
npm init -y >/dev/null
npm install --silent --omit=optional --no-audit --no-fund "$tarball"
actual="$(HOME="$work/home" DALAN_HOME="$work/home" DALAN_NO_FOLLOW=1 ./node_modules/.bin/dalan --version)"
[[ "$actual" == "$version" ]] || { echo "wrong version: $actual" >&2; exit 1; }
HOME="$work/home" DALAN_HOME="$work/home" DALAN_NO_FOLLOW=1 ./node_modules/.bin/dalan --help > "$work/help.txt"
grep -q 'dalan' "$work/help.txt"
echo "PASS dalan --version ($actual) and dalan --help from empty project"
if $dry; then
  npm publish --dry-run "$tarball"
  echo 'PASS dry run: nothing uploaded'
else
  npm publish "$tarball"
  npm view "$pkg@$version" version dist.tarball
fi
