#!/usr/bin/env bash
# Contract test: every registry json verb emits EXACTLY its declared jsonFields (#41, epic #30).
#
# The registry (#31) *declares* each json verb's jsonFields; forge-registry.contract.test.sh proves
# the registry matches bin/forge's verb *list*. Nothing proved the registry matches each verb's
# actual *output* — the gap behind #11: issue-view silently stopped emitting `state`, the loop's
# blocker-sweep isClosed check read undefined, and nothing failed. This closes that loop: for every
# verb with output=="json", run `forge <verb>` under a fake `gh` (a canned fixture; NO network) and
# assert the emitted top-level key set (array outputs: the element key set) equals the registry's
# jsonFields. Missing a declared field OR emitting an undeclared one fails.
#
# The json-verb list is DERIVED from forge-verbs.json (never hardcoded), so a new json verb is
# auto-covered. A verb the harness can't fixture fails loudly — it is never silently skipped, and a
# covered-count is asserted equal to the registry's json-verb count as a backstop against exactly
# that vacuous-green failure mode.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
REG="$ROOT/.sandcastle/forge-verbs.json"
FIXDIR="$ROOT/.sandcastle/fixtures/forge-output"
fail() { echo "FAIL: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || fail "jq is required"
[[ -f "$FORGE" ]] || fail "bin/forge not found"
[[ -f "$REG" ]] || fail "forge-verbs.json not found"
jq -e . "$REG" >/dev/null 2>&1 || fail "forge-verbs.json is not valid JSON"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fake gh: emit the fixture for the verb under test (path in $FORGE_FIXTURE). Each json verb runs a
# single upstream `gh ... --json ...` call whose payload forge pipes through jq, so a fixed cat is a
# faithful stand-in. `:?` makes a missing fixture a hard error, never an empty (silently passing)
# payload.
cat > "$TMP/gh" <<'EOF'
#!/usr/bin/env bash
cat "${FORGE_FIXTURE:?fake gh: FORGE_FIXTURE unset (a json verb was run with no fixture)}"
EOF
chmod +x "$TMP/gh"

# --- derive the json-verb list FROM the registry (not hardcoded) --------------
JSON_VERBS_FILE="$(mktemp)"
trap 'rm -rf "$TMP" "$JSON_VERBS_FILE"' EXIT
jq -r 'to_entries[] | select(.value.output == "json") | .key' "$REG" | sort > "$JSON_VERBS_FILE"
total=$(grep -c . "$JSON_VERBS_FILE" || true)
[[ "$total" -gt 0 ]] || fail "no json verbs in registry — the parser broke"

covered=0
while read -r v; do
  [[ -n "$v" ]] || continue
  fix="$FIXDIR/$v.json"
  # A json verb the harness can't fixture MUST fail loudly, never silently skip (the vacuous-green
  # failure mode #41 exists to prevent).
  [[ -f "$fix" ]] || fail "json verb '$v' has no fixture at $fix — add one (refusing to skip)"
  jq -e . "$fix" >/dev/null 2>&1 || fail "fixture for '$v' is not valid JSON: $fix"

  # Registry-derived args: a json verb needs either nothing or a <number> positional.
  args=("$v")
  if jq -e --arg v "$v" '(.[$v].requiredArgs // []) | index("number")' "$REG" >/dev/null; then
    args+=("1")
  fi

  out="$(FORGE_FIXTURE="$fix" PATH="$TMP:$PATH" FORGE_PLATFORM=github "$FORGE" "${args[@]}")" \
    || fail "forge $v exited non-zero under the fake gh"

  # Emitted key set (array outputs: element keys of the first element). jq 'keys' is sorted.
  actual="$(jq -cS 'if type=="array" then (if length==0 then error("empty array output") else .[0] end) else . end | keys' <<<"$out")" \
    || fail "forge $v: could not parse emitted JSON / read keys (got: $out)"
  expected="$(jq -cS --arg v "$v" '.[$v].jsonFields | sort' "$REG")"

  [[ "$actual" == "$expected" ]] \
    || fail "verb '$v': emitted keys $actual != registry jsonFields $expected"
  covered=$((covered + 1))
done < "$JSON_VERBS_FILE"

# Backstop: every registry json verb was actually exercised (no silent skip).
[[ "$covered" -eq "$total" ]] \
  || fail "covered $covered json verbs but the registry declares $total"

echo "PASS: all $total json verbs emit exactly their registry jsonFields ($(tr '\n' ' ' < "$JSON_VERBS_FILE" | sed 's/ $//'))"
