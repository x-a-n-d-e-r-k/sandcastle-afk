#!/usr/bin/env bash
# Contract test for `forge pr-pipeline` on GitHub (#101): {status, id}.
#
# The status-check rollup includes check runs, which need the Checks permission, and a fine-grained
# token can't be granted that. So: try the rollup first; on "Resource not accessible" fall back to the
# Actions workflow runs for the PR's head SHA (latest attempt per workflow; runs on other SHAs, e.g.
# merge_group, don't count) combined with the commit's legacy statuses. Stub `gh` on PATH — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
export FORGE_PLATFORM=github FORGE_RETRY_BASE_SECONDS=0 FORGE_MAX_RETRIES=0

# gh stub. Every call is logged to $TMP/calls.
#   pr view --json statusCheckRollup,...  → $ROLLUP_JSON, or fails with $ROLLUP_ERR when set
#   pr view (anything else)               → {"headRefOid": $HEAD}
#   api .../actions/runs?head_sha=…       → $RUNS_JSON (one page; a second page when $RUNS_PAGE2 is set)
#   api .../commits/<sha>/status          → $STATUS_JSON
cat > "$TMP/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
if [[ "$1 $2" == "pr view" ]]; then
  if [[ "$*" == *statusCheckRollup* ]]; then
    if [[ -n "${ROLLUP_ERR:-}" ]]; then echo "$ROLLUP_ERR" >&2; exit 1; fi
    printf '%s' "$ROLLUP_JSON"; exit 0
  fi
  jq -nc --arg s "$HEAD" '{headRefOid: $s}' | { if [[ "$*" == *"-q .headRefOid"* ]]; then jq -r .headRefOid; else cat; fi; }
  exit 0
fi
if [[ "$1" == api ]]; then
  case "$*" in
    *actions/runs*)
      [[ "$*" == *"head_sha=$HEAD"* ]] || { echo "unexpected runs query: $*" >&2; exit 1; }
      printf '%s\n' "$RUNS_JSON"; [[ -z "${RUNS_PAGE2:-}" ]] || printf '%s\n' "$RUNS_PAGE2"; exit 0 ;;
    *"commits/$HEAD/status"*) printf '%s\n' "$STATUS_JSON"; exit 0 ;;
  esac
fi
echo "unexpected gh call: $*" >&2; exit 1
STUB
chmod +x "$TMP/gh"
export CALLS="$TMP/calls" HEAD=abc123
f() { : > "$CALLS"; PATH="$TMP:$PATH" "$FORGE" pr-pipeline 7; }
status() { jq -r .status; }

DENIED='GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup.nodes.0.commit.statusCheckRollup.contexts.nodes.0)'
# run <id> <workflow_id> <attempt> <status> <conclusion|null> [head_sha] [event]
run() { jq -nc --argjson id "$1" --argjson wf "$2" --argjson a "$3" --arg st "$4" --argjson c "$5" \
  --arg sha "${6:-$HEAD}" --arg ev "${7:-pull_request}" \
  '{id:$id, workflow_id:$wf, run_attempt:$a, status:$st, conclusion:$c, head_sha:$sha, event:$ev}'; }
runs() { local IFS=,; echo "{\"total_count\":$#,\"workflow_runs\":[$*]}"; }
statuses() { local IFS=,; echo "{\"state\":\"pending\",\"statuses\":[$*]}"; }
st() { jq -nc --arg s "$1" --arg c "${2:-ci/legacy}" '{state:$s, context:$c}'; }
export RUNS_JSON STATUS_JSON ROLLUP_JSON ROLLUP_ERR RUNS_PAGE2

# --- 1. the rollup is readable (classic token / GitHub App): unchanged, no Actions API calls ---
ROLLUP_JSON='{"headRefOid":"abc123","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"},{"state":"SUCCESS"}]}'
ROLLUP_ERR=""; RUNS_JSON="$(runs)"; STATUS_JSON="$(statuses)"
out="$(f)"
[[ "$(status <<<"$out")" == success && "$(jq -r .id <<<"$out")" == abc123 ]] || fail "rollup readable → success/abc123 (got: $out)"
! grep -q '^api ' "$CALLS" || fail "rollup readable must not call the Actions API"
ROLLUP_JSON='{"headRefOid":"abc123","statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]}'
[[ "$(f | status)" == failed ]] || fail "rollup readable with a failure → failed"

# a rollup error that is NOT a permission error stays an error (no silent fallback)
ROLLUP_ERR='HTTP 404: Not Found'
set +e; out="$(f 2>/dev/null)"; rc=$?; set -e
[[ $rc -ne 0 ]] || fail "a non-permission rollup error must exit non-zero (got: $out)"
! grep -q '^api ' "$CALLS" || fail "a non-permission rollup error must not fall back"

# --- 2. the rollup is refused (fine-grained token): Actions runs + legacy statuses ---
ROLLUP_ERR="$DENIED"

RUNS_JSON="$(runs "$(run 1 11 1 completed '"success"')" "$(run 2 12 1 completed '"skipped"')")"; STATUS_JSON="$(statuses "$(st success)")"
out="$(f)" || fail "fallback must not fail when the rollup is refused"
[[ "$(status <<<"$out")" == success ]] || fail "fallback: all green → success (got: $out)"
[[ "$(jq -r .id <<<"$out")" == abc123 ]] || fail "fallback: id is the head SHA (got: $out)"
grep -q '^api .*--paginate' "$CALLS" || fail "fallback must page through the workflow runs"

RUNS_JSON="$(runs "$(run 1 11 1 completed '"success"')" "$(run 2 12 1 in_progress null)")"; STATUS_JSON="$(statuses)"
[[ "$(f | status)" == running ]] || fail "fallback: an in-progress run → running"
for s in queued waiting pending; do
  RUNS_JSON="$(runs "$(run 2 12 1 $s null)")"
  [[ "$(f | status)" == running ]] || fail "fallback: a $s run → running"
done
RUNS_JSON="$(runs "$(run 1 11 1 completed '"success"')")"; STATUS_JSON="$(statuses "$(st pending)")"
[[ "$(f | status)" == running ]] || fail "fallback: a pending legacy status → running"

for c in failure timed_out cancelled startup_failure; do
  RUNS_JSON="$(runs "$(run 1 11 1 completed '"success"')" "$(run 2 12 1 completed "\"$c\"")")"; STATUS_JSON="$(statuses)"
  [[ "$(f | status)" == failed ]] || fail "fallback: a $c run → failed"
done
RUNS_JSON="$(runs "$(run 1 11 1 completed '"success"')")"
for s in failure error; do
  STATUS_JSON="$(statuses "$(st success a)" "$(st $s b)")"
  [[ "$(f | status)" == failed ]] || fail "fallback: a legacy status in $s → failed"
done
RUNS_JSON="$(runs "$(run 1 11 1 completed '"failure"')")"; STATUS_JSON="$(statuses "$(st pending)")"
[[ "$(f | status)" == failed ]] || fail "fallback: failed outranks running"

RUNS_JSON="$(runs)"; STATUS_JSON="$(statuses)"
[[ "$(f | status)" == none ]] || fail "fallback: no runs and no statuses → none"
RUNS_JSON="$(runs)"; STATUS_JSON="$(statuses "$(st success)")"
[[ "$(f | status)" == success ]] || fail "fallback: statuses only (no Actions) → success"

# a re-run: the latest attempt of a workflow passed after an earlier failure → success
RUNS_JSON="$(runs "$(run 5 11 1 completed '"failure"')" "$(run 5 11 2 completed '"success"')")"; STATUS_JSON="$(statuses)"
[[ "$(f | status)" == success ]] || fail "fallback: re-run attempt 2 passed after attempt 1 failed → success"
RUNS_JSON="$(runs "$(run 5 11 2 completed '"success"')" "$(run 5 11 1 completed '"failure"')")"
[[ "$(f | status)" == success ]] || fail "fallback: latest attempt wins regardless of order"
RUNS_JSON="$(runs "$(run 5 11 1 completed '"failure"')" "$(run 9 11 1 completed '"success"')")"
[[ "$(f | status)" == success ]] || fail "fallback: a newer run of the same workflow supersedes the older one"
# …but the latest attempt is what counts, even if an earlier one passed
RUNS_JSON="$(runs "$(run 5 11 1 completed '"success"')" "$(run 5 11 2 completed '"failure"')")"
[[ "$(f | status)" == failed ]] || fail "fallback: latest attempt failed → failed"

# a merge_group run on another SHA is ignored
RUNS_JSON="$(runs "$(run 1 11 1 completed '"success"')" "$(run 3 11 1 completed '"failure"' def456 merge_group)")"
[[ "$(f | status)" == success ]] || fail "fallback: a failed merge_group run on another SHA must be ignored"
RUNS_JSON="$(runs "$(run 3 11 1 in_progress null def456 merge_group)")"
[[ "$(f | status)" == none ]] || fail "fallback: only other-SHA runs → none"

# every page counts
RUNS_JSON="$(runs "$(run 1 11 1 completed '"success"')")"; RUNS_PAGE2="$(runs "$(run 2 12 1 completed '"failure"')")"
[[ "$(f | status)" == failed ]] || fail "fallback: a failure on page 2 → failed"
RUNS_PAGE2=""

echo "PASS: pr-pipeline reads the rollup when it can, and falls back to Actions runs + commit statuses on a fine-grained token"
