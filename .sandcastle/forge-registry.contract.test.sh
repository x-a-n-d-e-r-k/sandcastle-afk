#!/usr/bin/env bash
# Contract test: bin/forge and .sandcastle/forge-verbs.json must not drift (#31, epic #30).
#
# bin/forge is a 29-verb integration seam bound by hand-typed strings from both the TypeScript
# orchestrator (execSync) and the agent prompts (interpolation). Nothing detects when a caller
# and the seam disagree — that is the generator behind #11 (issue-view silently dropped a JSON
# field), #21 (a caller invoked a verb forge never defined), and their kin. forge-verbs.json is
# the machine-readable contract; this test fails when it and bin/forge disagree, so the drift is
# caught here instead of in production. It reads the verb list OUT of bin/forge (never a
# hardcoded copy — a third list would just be a third thing to drift) and needs no network.
#
# Registry descriptor schema (per verb):
#   mutating     bool   — true = performs a write; a mutating verb is never retried
#   retryable    bool   — MUST equal membership in is_retryable_verb
#   output       enum   — "json" (object/array the caller parses), "text" (diff/logs/scalar), "none"
#   requiredArgs array  — positional names ("number") + "--flag" strings forge die()s without
#   jsonFields   array  — present iff output=="json": the top-level keys (array outputs: element keys)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
REG="$ROOT/.sandcastle/forge-verbs.json"
fail() { echo "FAIL: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || fail "jq is required"
[[ -f "$FORGE" ]] || fail "bin/forge not found"
[[ -f "$REG" ]] || fail "forge-verbs.json not found"
jq -e . "$REG" >/dev/null 2>&1 || fail "forge-verbs.json is not valid JSON"

# --- derive the two source-of-truth lists FROM bin/forge (not hardcoded) ------

# Dispatch verbs: the `  <verb>)` labels between `case "$verb" in` and its column-0 `esac`.
# Nested `case "$state" in ... esac` bodies are written inline (single line), so their labels
# never start a line and are not matched; only real dispatch labels are at 2-space indent.
dispatch_verbs() {
  awk '
    /^case "\$verb" in/ { inblk=1; next }
    inblk && /^esac/     { exit }
    inblk && /^  [a-z][a-z-]+\)/ { v=$0; sub(/\).*/,"",v); gsub(/ /,"",v); print v }
  ' "$FORGE" | sort -u
}

# The retryable set: the pipe-joined list on is_retryable_verb's `return 0` line.
retryable_verbs() {
  awk '
    /is_retryable_verb\(\)/ { inblk=1 }
    inblk && /return 0/ {
      line=$0
      # isolate the pipe-joined alternation up to the first closing paren
      match(line, /[a-z][a-z|-]+\)/)
      alts=substr(line, RSTART, RLENGTH-1)
      n=split(alts, a, "|")
      for (i=1;i<=n;i++) print a[i]
      exit
    }
  ' "$FORGE" | sort -u
}

VERBS_FILE="$(mktemp)"; RETRY_FILE="$(mktemp)"; REG_FILE="$(mktemp)"
trap 'rm -f "$VERBS_FILE" "$RETRY_FILE" "$REG_FILE"' EXIT
dispatch_verbs > "$VERBS_FILE"
retryable_verbs > "$RETRY_FILE"
jq -r 'keys[]' "$REG" | sort -u > "$REG_FILE"

[[ -s "$VERBS_FILE" ]] || fail "parsed zero dispatch verbs from bin/forge — the parser broke"
[[ -s "$RETRY_FILE" ]] || fail "parsed zero retryable verbs from bin/forge — the parser broke"

# --- 1) no undocumented verb: every dispatch verb is in the registry ----------
while read -r v; do
  grep -qxF "$v" "$REG_FILE" || fail "verb '$v' is in bin/forge but not in forge-verbs.json"
done < "$VERBS_FILE"

# --- 2) no dead entry: every registry verb exists in bin/forge ----------------
while read -r v; do
  grep -qxF "$v" "$VERBS_FILE" || fail "verb '$v' is in forge-verbs.json but not in bin/forge"
done < "$REG_FILE"

# --- 3) retryable matches is_retryable_verb for every verb --------------------
while read -r v; do
  reg_retry="$(jq -r --arg v "$v" '.[$v].retryable' "$REG")"
  if grep -qxF "$v" "$RETRY_FILE"; then want=true; else want=false; fi
  [[ "$reg_retry" == "$want" ]] \
    || fail "verb '$v': registry retryable=$reg_retry but is_retryable_verb membership=$want"
done < "$VERBS_FILE"

# --- 4) schema well-formedness ------------------------------------------------
# Each descriptor: mutating/retryable bool, output in the enum, requiredArgs array,
# and output=="json" IFF jsonFields is a non-empty array.
bad="$(jq -r '
  to_entries[]
  | .key as $v | .value as $d
  | [ if ($d.mutating|type)   != "boolean" then "\($v): mutating not boolean" else empty end,
      if ($d.retryable|type)  != "boolean" then "\($v): retryable not boolean" else empty end,
      if ([ "json","text","none" ] | index($d.output)) == null then "\($v): output not in enum" else empty end,
      if ($d.requiredArgs|type) != "array" then "\($v): requiredArgs not array" else empty end,
      if $d.output == "json" and (($d.jsonFields|type) != "array" or ($d.jsonFields|length) == 0)
        then "\($v): output=json requires a non-empty jsonFields" else empty end,
      if $d.output != "json" and ($d|has("jsonFields"))
        then "\($v): jsonFields present but output is not json" else empty end
    ] | .[]
' "$REG")"
[[ -z "$bad" ]] || fail "schema violations:"$'\n'"$bad"

# --- 5) a mutating verb is never retryable (a retry could double-apply) --------
badmut="$(jq -r 'to_entries[] | select(.value.mutating and .value.retryable) | .key' "$REG")"
[[ -z "$badmut" ]] || fail "mutating verbs marked retryable (would double-apply on retry): $badmut"

echo "PASS: forge-verbs.json matches bin/forge ($(wc -l < "$VERBS_FILE" | tr -d ' ') verbs), schema valid"
