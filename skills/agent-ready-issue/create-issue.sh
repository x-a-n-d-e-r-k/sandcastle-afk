#!/usr/bin/env bash
# Create an agent-ready issue as the HUMAN (not a bot token). Run from repo root.
# Usage: bash create-issue.sh "<title>" <body-file> [label ...]
#   No labels → the ready label. A dependent issue takes both: <ready-label> blocked
set -euo pipefail
title="${1:?usage: create-issue.sh <title> <body-file> [label ...]}"
body="${2:?body file (markdown) required}"
cfg="${AFK_CONFIG:-afk.config.json}"
[[ -f "$cfg" ]] || { echo "afk.config.json not found — run from the repo root." >&2; exit 1; }
[[ -f "$body" ]] || { echo "body file not found: $body" >&2; exit 1; }
export FORGE_PLATFORM; FORGE_PLATFORM="$(jq -r .platform "$cfg")"
ready="$(jq -r .labels.ready "$cfg")"
shift 2
[[ $# -gt 0 ]] || set -- "$ready"
label_args=(); for l in "$@"; do label_args+=(--label "$l"); done
FORGE="${FORGE:-./bin/forge}"
"$FORGE" issue-create --title "$title" --body-file "$body" "${label_args[@]}"
