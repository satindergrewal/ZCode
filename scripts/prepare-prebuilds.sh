#!/bin/bash
set -euo pipefail

# The shell variant of prepare-prebuilds drifted from the mjs implementation repeatedly:
# a remote-asset boundary fix on one side left stale dirs and comments on the other.
# Consolidate on the single implementation to avoid "script runs but dir duties disagree" forks.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT_DIR/scripts/prepare-prebuilds.mjs" "$@"
