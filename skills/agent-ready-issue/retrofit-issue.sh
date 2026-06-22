#!/usr/bin/env bash
# Retrofit an EXISTING issue into agent-ready form (edit in place). Run from repo root.
# Usage: bash retrofit-issue.sh <number> <body-file> [label] [new-title]
set -euo pipefail
num="${1:?usage: retrofit-issue.sh <number> <body-file> [label] [new-title]}"
body="${2:?body file required}"
cfg="${AFK_CONFIG:-afk.config.json}"
[[ -f "$cfg" ]] || { echo "afk.config.json not found — run from the repo root." >&2; exit 1; }
[[ -f "$body" ]] || { echo "body file not found: $body" >&2; exit 1; }
export FORGE_PLATFORM; FORGE_PLATFORM="$(jq -r .platform "$cfg")"
ready="$(jq -r .labels.ready "$cfg")"
nf="$(jq -r .labels.needsFeedback "$cfg")"
label="${3:-$ready}"
new_title="${4:-}"
FORGE="${FORGE:-./bin/forge}"
args=(issue-edit "$num" --body-file "$body" --add-label "$label")
[[ "$label" == "$ready" ]] && args+=(--remove-label "$nf")
[[ -n "$new_title" ]] && args+=(--new-title "$new_title")
"$FORGE" "${args[@]}"
echo "Retrofitted #$num with label '$label'."
