#!/usr/bin/env bash

set -euo pipefail

APP_PATH="${1:-${ZCODE_MACOS_RELEASE_APP_PATH:-/Applications/ZCode.app}}"
# Installer identity and backend environment are orthogonal axes: ZCODE_PREVIEW_IDENTITY=1 keeps
# a production-backend build branded as ZCode Preview.
# Only "1" counts, matching the exact comparison in the CI workflow / release gate
# (any other spelling counts as off).
is_preview_identity_requested() {
  [[ "${ZCODE_PREVIEW_IDENTITY:-}" = "1" ]]
}
APP_BUNDLE_NAME="$(basename "$APP_PATH")"
APP_DISPLAY_NAME="${APP_BUNDLE_NAME%.app}"
APP_EXECUTABLE_NAME="${ZCODE_APP_EXECUTABLE_NAME:-$APP_DISPLAY_NAME}"

if [ "${APP_PATH:-}" = "--help" ] || [ "${APP_PATH:-}" = "-h" ]; then
  cat <<'USAGE'
Usage:
  bash scripts/doctor-macos-release-app.sh /Applications/ZCode.app
  ZCODE_MACOS_RELEASE_APP_PATH=/Applications/ZCode.app pnpm run doctor:macos-release

Always validates the installed macOS release app with:
  codesign --verify --deep --strict <app>
  spctl -a -vv -t exec <app>
USAGE
  exit 0
fi

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[macos-release-doctor] missing required command: $command_name" >&2
    exit 1
  fi
}

assert_bundle_dir() {
  local label="$1"
  local bundle_path="$2"
  if [ -z "$bundle_path" ]; then
    echo "[macos-release-doctor] ${label} missing: <no app path provided>" >&2
    exit 1
  fi
  if [ ! -d "$bundle_path" ]; then
    echo "[macos-release-doctor] ${label} missing: $bundle_path" >&2
    exit 1
  fi
}

assert_executable() {
  local label="$1"
  local executable_path="$2"
  if [ ! -x "$executable_path" ]; then
    echo "[macos-release-doctor] ${label} executable missing or not executable: $executable_path" >&2
    exit 1
  fi
}

assert_macho_executable() {
  local label="$1"
  local executable_path="$2"
  local magic
  magic="$(od -An -N4 -tx1 -v "$executable_path" | tr -d ' \n')"
  case "$magic" in
    feedface|feedfacf|cafebabe|cafebabf|cffaedfe|cefaedfe|bebafeca|bfbafeca) ;;
    *)
      echo "[macos-release-doctor] ${label} is not a Mach-O executable: $executable_path" >&2
      exit 1
      ;;
  esac
}

run_quiet_validation() {
  local label="$1"
  shift
  local output_file
  output_file="$(mktemp "${TMPDIR:-/tmp}/zcode-macos-release-doctor.XXXXXX")"
  if "$@" >"$output_file" 2>&1; then
    rm -f "$output_file"
    return 0
  fi

  echo "[macos-release-doctor] ${label} failed" >&2
  cat "$output_file" >&2
  rm -f "$output_file"
  return 1
}

validate_release_bundle() {
  local label="$1"
  local bundle_path="$2"
  local require_notarization_staple="${3:-0}"

  echo "[macos-release-doctor] validating ${label}: $bundle_path"
  run_quiet_validation "${label} codesign verify" codesign --verify --deep --strict "$bundle_path"
  run_quiet_validation "${label} Gatekeeper exec assessment" spctl -a -vv -t exec "$bundle_path"
  if [ "$require_notarization_staple" = "1" ]; then
    # xcrun is only needed for the macOS staple check; require it only after the target bundle
    # exists and basic signature validation passed, so a missing-xcrun error cannot mask a
    # missing bundle or broken signature.
    require_command xcrun
    # spctl alone may rely on online ticket fetch or caches; the target bundle's local staple
    # must still be verified.
    run_quiet_validation "${label} notarization staple" xcrun stapler validate "$bundle_path"
  fi
}

require_command codesign
require_command spctl

# A passing release/notarization only proves the DMG passed the gate; it does not prove the
# installed main app is admitted by Gatekeeper as type exec. Check bundle structure and the main
# executable fail-closed first, then run codesign/spctl, so an incomplete install or broken
# signature cannot be misreported as a successful release.
assert_bundle_dir "$APP_BUNDLE_NAME" "$APP_PATH"
assert_executable "$APP_BUNDLE_NAME" "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE_NAME"
validate_release_bundle "$APP_BUNDLE_NAME" "$APP_PATH"


echo "[macos-release-doctor] done"
