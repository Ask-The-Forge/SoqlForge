#!/usr/bin/env bash
#
# Build a release of SoqlForge locally on macOS using Tauri's native bundler.
# The macOS counterpart to scripts/release.ps1.
#
# Produces the same .app + .dmg the GitHub Actions release workflow ships —
# handy for a local test build or a manual one-off. For the signed,
# auto-update-capable release, push a `v*` tag and let
# .github/workflows/release.yml build it (see DEPLOYMENT.md).
#
# Workflow:
#   1. Reads the version from src-tauri/tauri.conf.json (single source of
#      truth — bump that file, everything else follows).
#   2. Runs `npm run tauri build` (release Rust + Vite frontend bundle).
#   3. Copies the produced .dmg and .app into a clean dist-release/<version>/.
#
# NOTE: a *local* build produces unsigned updater artifacts unless the
# TAURI_SIGNING_PRIVATE_KEY / _PASSWORD env vars are set. Unsigned builds
# install fine but won't be accepted by the auto-updater — that's what the
# CI release path is for.
#
# Usage:
#   scripts/release.sh                    # use the version in tauri.conf.json
#   scripts/release.sh --version 1.2.0    # bump tauri.conf.json, then build
#   scripts/release.sh --skip-build       # re-stage a previous build's output
#   scripts/release.sh --target aarch64-apple-darwin   # cross-compile

set -euo pipefail

VERSION=""
SKIP_BUILD=0
TARGET=""

die() {
  printf '\033[31mERROR: %s\033[0m\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)    VERSION="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --target)     TARGET="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "unknown argument: $1" ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

conf="src-tauri/tauri.conf.json"

if [ -n "$VERSION" ]; then
  current="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$conf" | head -1)"
  printf '\033[36mBumping version: %s -> %s\033[0m\n' "${current:-unknown}" "$VERSION"
  # Targeted in-place rewrite of the first "version" line, mirroring
  # release.ps1 — reserializing the JSON would reformat the whole file.
  /usr/bin/sed -i '' "1,/\"version\"/s/\(\"version\"[[:space:]]*:[[:space:]]*\"\)[^\"]*\(\"\)/\1$VERSION\2/" "$conf"
fi

ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$conf" | head -1)"
[ -n "$ver" ] || die "Could not parse version from $conf"
printf '\033[32mBuilding SoqlForge v%s\033[0m\n' "$ver"

# rustup's default install puts cargo under ~/.cargo/bin, which isn't on PATH
# in a fresh non-login shell.
if [ -d "$HOME/.cargo/bin" ] && ! command -v cargo >/dev/null 2>&1; then
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
fi
command -v cargo >/dev/null 2>&1 || die "cargo not found — install Rust from https://rustup.rs"

build_status=0
if [ "$SKIP_BUILD" -eq 0 ]; then
  printf '\033[33m-> npm run tauri build\033[0m\n'
  # `set +e` around the build: tauri.conf.json carries an updater public key,
  # so with no TAURI_SIGNING_PRIVATE_KEY in the environment Tauri bundles
  # everything successfully and *then* exits 1 at the signing step. That's the
  # normal case for a local build — judge success on the artifacts below, not
  # on this status.
  set +e
  if [ -n "$TARGET" ]; then
    npm run tauri build -- --target "$TARGET"
  else
    npm run tauri build
  fi
  build_status=$?
  set -e
fi

# A --target build nests its output under target/<triple>/release.
bundle_root="src-tauri/target/${TARGET:+$TARGET/}release/bundle"
if [ ! -d "$bundle_root/dmg" ] && [ ! -d "$bundle_root/macos" ]; then
  die "No bundles under $bundle_root (tauri build exited $build_status) — the build really did fail."
fi
if [ "$build_status" -ne 0 ]; then
  printf '\033[33mNote: tauri build exited %s but the bundles are present — almost\n' "$build_status"
  printf 'certainly the updater signing step, which needs TAURI_SIGNING_PRIVATE_KEY.\033[0m\n'
fi

stage="dist-release/$ver"
rm -rf "$stage"
mkdir -p "$stage"

# Plain `if` rather than `[ -d x ] && cp` — under `set -e` a false test is the
# exit status of the whole AND-list and would kill the script.
if [ -d "$bundle_root/dmg" ]; then cp -R "$bundle_root/dmg" "$stage/dmg"; fi
if [ -d "$bundle_root/macos" ]; then cp -R "$bundle_root/macos" "$stage/macos"; fi

printf '\n\033[32mOK — staged release in %s\033[0m\n\n' "$stage"
printf '\033[36mArtifacts:\033[0m\n'
if [ -d "$stage/dmg" ]; then printf '  Disk image:  %s/dmg/\n' "$stage"; fi
if [ -d "$stage/macos" ]; then printf '  App bundle:  %s/macos/\n' "$stage"; fi
cat <<EOF

This build is UNSIGNED unless you set an Apple signing identity, so Gatekeeper
will quarantine it on another Mac. To run it locally after copying elsewhere:

  xattr -dr com.apple.quarantine "/Applications/SoqlForge.app"

For a signed, auto-updating release, push a tag instead:
  git tag v$ver && git push origin v$ver
(see DEPLOYMENT.md).
EOF
