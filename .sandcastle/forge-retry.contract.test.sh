#!/usr/bin/env bash
# Contract test for forge's transient-error retry (afk-loop-github-502).
#
# GitHub/GitLab intermittently return transient infra errors (502/503/504 gateway,
# service-unavailable, timeouts, secondary rate limits). Before this, ANY such blip on a
# read call (e.g. `forge pr-list`) failed hard and burned a whole AFK loop cycle. forge
# now retries READ verbs on a transient error, with backoff, and still fails fast on
# non-transient errors and on MUTATING verbs (retrying a partial write could double-apply).
#
# Uses a fake `gh` on PATH — no network. FORGE_RETRY_BASE_SECONDS=0 keeps the test instant.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
COUNT="$TMP/count"

# Fake gh: fails (exit 1, stderr=$FAKE_GH_ERR) while the invocation count is <=
# $FAKE_GH_FAIL_UNTIL, then succeeds with a pr-list-shaped JSON array. Counts every call.
cat > "$TMP/gh" <<'EOF'
#!/usr/bin/env bash
c="${FAKE_GH_COUNT:?}"
n=$(( $(cat "$c" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$c"
if [[ "$n" -le "${FAKE_GH_FAIL_UNTIL:-0}" ]]; then
  echo "${FAKE_GH_ERR:-HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)}" >&2
  exit 1
fi
cat <<'JSON'
[{"number":1,"headRefName":"agent/issue-1","reviewDecision":"APPROVED","state":"OPEN","labels":[{"name":"x"}]}]
JSON
EOF
chmod +x "$TMP/gh"

run_forge() { # <verb...> ; env (FAKE_GH_*, FORGE_*) taken from the caller
  PATH="$TMP:$PATH" FORGE_PLATFORM=github FAKE_GH_COUNT="$COUNT" \
    FORGE_RETRY_BASE_SECONDS=0 "$FORGE" "$@"
}

# --- 1) READ verb recovers from a transient 502: retries once, then succeeds ---
: > "$COUNT"
out="$(FAKE_GH_FAIL_UNTIL=1 run_forge pr-list)" \
  || fail "pr-list should recover from a single transient 502"
[[ "$(jq -r '.[0].number' <<<"$out")" == "1" ]] \
  || fail "pr-list did not emit the recovered payload (got: $out)"
[[ "$(cat "$COUNT")" == "2" ]] \
  || fail "expected 2 gh calls (1 fail + 1 retry), got $(cat "$COUNT")"

# --- 2) READ verb gives up after FORGE_MAX_RETRIES on a persistent 502 ---------
: > "$COUNT"
set +e
FAKE_GH_FAIL_UNTIL=999 FORGE_MAX_RETRIES=2 run_forge pr-list >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "pr-list should fail after exhausting retries on a persistent 502"
[[ "$(cat "$COUNT")" == "3" ]] \
  || fail "expected 3 gh calls (1 + 2 retries), got $(cat "$COUNT")"

# --- 3) READ verb does NOT retry a non-transient error (e.g. 404) --------------
: > "$COUNT"
set +e
FAKE_GH_FAIL_UNTIL=999 FAKE_GH_ERR="HTTP 404: Not Found (https://api.github.com/x)" \
  run_forge pr-list >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "pr-list should fail on a 404"
[[ "$(cat "$COUNT")" == "1" ]] \
  || fail "404 must not be retried; expected 1 gh call, got $(cat "$COUNT")"

# --- 4) MUTATING verb fails fast on a transient error (no double-apply) --------
: > "$COUNT"
set +e
FAKE_GH_FAIL_UNTIL=999 run_forge pr-comment 1 --body hi >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "pr-comment should surface the transient error"
[[ "$(cat "$COUNT")" == "1" ]] \
  || fail "mutating pr-comment must not be retried; expected 1 gh call, got $(cat "$COUNT")"

echo "PASS: forge retries read verbs on transient errors; fails fast on non-transient + mutations"
