#!/usr/bin/env bash
# List open issues that are candidates for retrofitting (not yet triaged). Run from repo root.
# Usage: bash list-candidates.sh
set -euo pipefail
cfg="${AFK_CONFIG:-afk.config.json}"
[[ -f "$cfg" ]] || { echo "afk.config.json not found — run from the repo root." >&2; exit 1; }
export FORGE_PLATFORM; FORGE_PLATFORM="$(jq -r .platform "$cfg")"
FORGE="${FORGE:-./bin/forge}"
ex="$(jq -c '[.labels | .ready,.needsFeedback,.epic,.idea,.needsHuman]' "$cfg")"
"$FORGE" issue-list --state open | jq -r --argjson ex "$ex" '
  .[]
  | select((.labels // []) as $l | ($ex | any(. as $e | $l | index($e))) | not)
  | "#\(.number)\t\(.title)"'
