#!/usr/bin/env bash
# Create an agent-ready issue as the HUMAN (not a bot token). Run from repo root.
# Usage: bash create-issue.sh "<title>" <body-file> [label]
set -euo pipefail
title="${1:?usage: create-issue.sh <title> <body-file> [label]}"
body="${2:?body file (markdown) required}"
cfg="${AFK_CONFIG:-afk.config.json}"
[[ -f "$cfg" ]] || { echo "afk.config.json not found — run from the repo root." >&2; exit 1; }
[[ -f "$body" ]] || { echo "body file not found: $body" >&2; exit 1; }
export FORGE_PLATFORM; FORGE_PLATFORM="$(jq -r .platform "$cfg")"
ready="$(jq -r .labels.ready "$cfg")"
label="${3:-$ready}"
FORGE="${FORGE:-./bin/forge}"
"$FORGE" issue-create --title "$title" --body-file "$body" --label "$label"
