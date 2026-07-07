#!/usr/bin/env bash
# Contract test for `forge issue-comment` / `issue-comments` (afk-loop triage sweep).
#
# The idle triage sweep (loop.ts runTriageSweep) reads an issue's comments to check for
# the [afk-triage] marker (`forge issue-comments N`) and posts that marker when it promotes
# an unblocked issue (`forge issue-comment N --body ...`). forge previously defined neither
# verb, so every sweep that promoted a blocked issue crashed with "unknown verb", burning
# the cycle. These verbs must exist; `issue-comments` (a read) must also retry on transient
# errors like the other read verbs. Uses a fake gh — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Fake gh: records every argv line to $GH_ARGS; optional transient-fail via
# $FAKE_GH_COUNT/$FAKE_GH_FAIL_UNTIL. `issue view` emits a comments payload carrying the
# marker; `issue comment` just succeeds.
cat > "$TMP/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "${GH_ARGS:-/dev/null}"
c="${FAKE_GH_COUNT:-/dev/null}"
if [[ "$c" != /dev/null ]]; then
  n=$(( $(cat "$c" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$c"
  if [[ "$n" -le "${FAKE_GH_FAIL_UNTIL:-0}" ]]; then echo "HTTP 502: 502 Bad Gateway" >&2; exit 1; fi
fi
if [[ "${1:-}" == issue && "${2:-}" == comment ]]; then exit 0; fi
if [[ "${1:-}" == issue && "${2:-}" == view ]]; then
  echo '{"comments":[{"body":"hi [afk-triage] promoted"},{"body":"noise"}]}'; exit 0
fi
exit 0
EOF
chmod +x "$TMP/gh"
gh_forge() { PATH="$TMP:$PATH" FORGE_PLATFORM=github "$FORGE" "$@"; }

# --- 1) issue-comments emits the comment bodies (so a marker check can match) --
out="$(gh_forge issue-comments 7)" || fail "issue-comments should be a known verb"
grep -q '\[afk-triage\]' <<<"$out" || fail "issue-comments must surface comment bodies (got: $out)"

# --- 2) issue-comment posts via `gh issue comment N --body <body>` -------------
ARGS="$TMP/args"; : > "$ARGS"
GH_ARGS="$ARGS" gh_forge issue-comment 7 --body "[afk-triage] promoted" \
  || fail "issue-comment should be a known verb"
grep -q 'issue comment 7 --body \[afk-triage\] promoted' "$ARGS" \
  || fail "issue-comment did not call gh with the body (got: $(cat "$ARGS"))"

# --- 3) issue-comments (a read) retries on a transient 502 --------------------
CNT="$TMP/cnt"; : > "$CNT"
out="$(FAKE_GH_COUNT="$CNT" FAKE_GH_FAIL_UNTIL=1 FORGE_RETRY_BASE_SECONDS=0 gh_forge issue-comments 7)" \
  || fail "issue-comments should retry past a single transient 502"
grep -q '\[afk-triage\]' <<<"$out" || fail "issue-comments retry did not surface the payload"
[[ "$(cat "$CNT")" == "2" ]] || fail "issue-comments should have retried once (2 gh calls), got $(cat "$CNT")"

echo "PASS: forge issue-comment posts, issue-comments reads + retries on transient errors"
