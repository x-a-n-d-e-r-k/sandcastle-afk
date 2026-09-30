#!/usr/bin/env bash
# Contract test for the heal budget verbs (#69): pr-heal-count counts [forge:heal] markers after the
# last [forge:heal-reset]; pr-heal-mark / pr-heal-reset post those markers. GitHub and GitLab.
# Changes-requested reviews/notes must not count. Stubs on PATH — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# $NOTES: one body per line. gh emits {comments:[{body}]}; glab emits [{notes:[{body}]}]. Writes log.
cat > "$TMP/gh" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == "pr view" ]]; then jq -Rn '{comments: [inputs | select(length > 0) | {body: .}]}' <<<"$NOTES"; exit 0; fi
echo "$*" >> "$STUB_ARGS"
STUB
cat > "$TMP/glab" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2 $3" == "mr note list" ]]; then jq -Rn '[{notes: [inputs | select(length > 0) | {body: .}]}]' <<<"$NOTES"; exit 0; fi
echo "$*" >> "$STUB_ARGS"
STUB
chmod +x "$TMP/gh" "$TMP/glab"
f() { STUB_ARGS="$TMP/args" PATH="$TMP:$PATH" "$FORGE" "$@"; }

H='[forge:heal]'; R='[forge:heal-reset]'; CR='[forge:changes-requested]'
for plat in github gitlab; do
  export FORGE_PLATFORM="$plat"
  [[ "$(NOTES="" f pr-heal-count 7)" == 0 ]] || fail "[$plat] no notes → 0"
  [[ "$(NOTES="$H"$'\n'"$H"$'\n'"$R"$'\n'"$H" f pr-heal-count 7)" == 1 ]] || fail "[$plat] [heal, heal, reset, heal] → 1"
  [[ "$(NOTES="$CR"$'\n'"$CR"$'\n'"$CR"$'\n'"$CR" f pr-heal-count 7)" == 0 ]] || fail "[$plat] changes-requested reviews must not count"
  [[ "$(NOTES="$H"$'\n'"$R" f pr-heal-count 7)" == 0 ]] || fail "[$plat] a trailing reset → 0"

  : > "$TMP/args"
  f pr-heal-mark 7 || fail "[$plat] pr-heal-mark should succeed"
  f pr-heal-reset 7 || fail "[$plat] pr-heal-reset should succeed"
  if [[ "$plat" == github ]]; then
    want=$'pr comment 7 --body [forge:heal]\npr comment 7 --body [forge:heal-reset]'
  else
    want=$'mr note 7 -m [forge:heal]\nmr note 7 -m [forge:heal-reset]'
  fi
  [[ "$(cat "$TMP/args")" == "$want" ]] || fail "[$plat] mark/reset must post the markers (got: $(cat "$TMP/args"))"
done

echo "PASS: pr-heal-count counts heal attempts since the last reset (reviews don't count); pr-heal-mark/reset post the markers — GitHub and GitLab"
