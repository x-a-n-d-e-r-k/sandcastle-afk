#!/usr/bin/env bash
# Contract test for the conflict-resolve budget (#54): `pr-conflict-retry-count` counts
# CONSECUTIVE failures — [forge:conflict-retry] markers after the last [forge:conflict-resolved]
# — and `pr-conflict-retry-clear` posts that reset marker. A lifetime count parked healthy PRs
# the Nth time main moved under them. Uses a fake gh — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Fake gh: `pr view --json comments` emits $COMMENTS (one body per line); `pr comment` logs.
cat > "$TMP/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "${GH_ARGS:-/dev/null}"
if [[ "${1:-}" == pr && "${2:-}" == view ]]; then
  jq -Rn '{comments: [inputs | {body: .}]}' <<<"$COMMENTS"; exit 0
fi
exit 0
EOF
chmod +x "$TMP/gh"
count() { COMMENTS="$1" PATH="$TMP:$PATH" FORGE_PLATFORM=github "$FORGE" pr-conflict-retry-count 7; }

R='[forge:conflict-retry]'; OK='[forge:conflict-resolved]'
[[ "$(count "hello")" == 0 ]] || fail "no markers → 0"
[[ "$(count "$R"$'\n'"$R"$'\n'"$R")" == 3 ]] || fail "three unreset attempts → 3"
[[ "$(count "$R"$'\n'"$OK"$'\n'"$R"$'\n'"$OK"$'\n'"$R"$'\n'"$OK")" == 0 ]] || fail "each attempt resolved → 0 (was a lifetime 3)"
[[ "$(count "$R"$'\n'"$R"$'\n'"$OK"$'\n'"noise"$'\n'"$R")" == 1 ]] || fail "only attempts after the last reset count"

GH_ARGS="$TMP/args" PATH="$TMP:$PATH" FORGE_PLATFORM=github "$FORGE" pr-conflict-retry-clear 7 || fail "pr-conflict-retry-clear should be a known verb"
grep -qF "pr comment 7 --body [forge:conflict-resolved]" "$TMP/args" || fail "clear must post the reset marker (got: $(cat "$TMP/args"))"

echo "PASS: pr-conflict-retry-count counts consecutive failures since the last reset; pr-conflict-retry-clear resets"
