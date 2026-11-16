#!/usr/bin/env bash
# Contract test for the GitHub pipeline-retry verbs: pr-pipeline-retry, pr-pipeline-failed-jobs and
# pr-pipeline-failures act on the FAILED workflow runs of the PR's head SHA.
#
# The bug this pins: they used `gh run list --branch <head> -L 1`, the newest run of ANY workflow on
# the branch. CI and another workflow (e.g. "Refactor guards") start in the same second, so -L 1
# often returned the green one: the retry reran nothing ("rerun --failed" on a passing run), the
# failed-jobs list came back empty, and the heal prompt got the wrong logs. Stub `gh` — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
export FORGE_PLATFORM=github FORGE_RETRY_BASE_SECONDS=0 FORGE_MAX_RETRIES=0

# gh stub. Every call is logged to $TMP/calls.
#   pr view ... headRefOid          → $HEAD
#   api .../actions/runs?head_sha=… → $RUNS_JSON
#   run view <id> --json jobs       → $JOBS_<id>
#   run view <id> --log-failed      → "LOG <id>"
#   run rerun <id> --failed         → ok
#   run list ...                    → fails: the verbs must not use the branch-wide listing
cat > "$TMP/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
if [[ "$1 $2" == "pr view" ]]; then
  jq -nc --arg s "$HEAD" '{headRefOid: $s, headRefName: "agent/issue-1"}' \
    | { if [[ "$*" == *"-q .headRefOid"* ]]; then jq -r .headRefOid; elif [[ "$*" == *"-q .headRefName"* ]]; then jq -r .headRefName; else cat; fi; }
  exit 0
fi
if [[ "$1" == api && "$*" == *actions/runs* ]]; then
  [[ "$*" == *"head_sha=$HEAD"* ]] || { echo "unexpected runs query: $*" >&2; exit 1; }
  printf '%s\n' "$RUNS_JSON"; exit 0
fi
if [[ "$1 $2" == "run view" ]]; then
  if [[ "$*" == *"--json jobs"* ]]; then
    v="JOBS_$3"; empty='{"jobs":[]}'; printf '%s' "${!v:-$empty}"; exit 0
  fi
  if [[ "$*" == *"--log-failed"* ]]; then echo "LOG $3"; exit 0; fi
fi
if [[ "$1 $2" == "run rerun" ]]; then exit 0; fi
if [[ "$1 $2" == "run list" ]]; then echo "run list must not be used: $*" >&2; exit 1; fi
echo "unexpected gh call: $*" >&2; exit 1
STUB
chmod +x "$TMP/gh"
export CALLS="$TMP/calls" HEAD=abc123 RUNS_JSON
f() { : > "$CALLS"; PATH="$TMP:$PATH" "$FORGE" "$1" 7; }

# run <id> <workflow_id> <name> <attempt> <status> <conclusion|null> [head_sha]
run() { jq -nc --argjson id "$1" --argjson wf "$2" --arg n "$3" --argjson a "$4" --arg st "$5" \
  --argjson c "$6" --arg sha "${7:-$HEAD}" \
  '{id:$id, workflow_id:$wf, name:$n, run_attempt:$a, status:$st, conclusion:$c, head_sha:$sha}'; }
runs() { local IFS=,; echo "{\"total_count\":$#,\"workflow_runs\":[$*]}"; }

# The incident: CI failed and Refactor guards passed, started in the same second; the green one
# has the higher id, so a "newest run" pick lands on it.
RUNS_JSON="$(runs "$(run 101 1 CI 1 completed '"failure"')" "$(run 102 2 'Refactor guards' 1 completed '"success"')")"
export JOBS_101='{"jobs":[{"name":"preflight","conclusion":"failure"},{"name":"lint","conclusion":"success"}]}'
export JOBS_102='{"jobs":[{"name":"baseline-guard","conclusion":"success"}]}'

# --- pr-pipeline-retry reruns the failed run, not the newest one ---
out="$(f pr-pipeline-retry)" || fail "retry exited non-zero (got: $out)"
grep -q '^run rerun 101 --failed' "$CALLS" || fail "retry must rerun the failed CI run 101 (calls: $(cat "$CALLS"))"
! grep -q '^run rerun 102' "$CALLS" || fail "retry must not rerun the passing run 102"
[[ "$out" == *"rerun 101"* ]] || fail "retry reports what it reran (got: $out)"

# --- pr-pipeline-failed-jobs names the failed run's failed jobs ---
out="$(f pr-pipeline-failed-jobs)"
[[ "$out" == "preflight" ]] || fail "failed-jobs must be 'preflight' (got: '$out')"

# --- pr-pipeline-failures gives the failed run's logs ---
out="$(f pr-pipeline-failures)"
[[ "$out" == *"LOG 101"* && "$out" != *"LOG 102"* ]] || fail "failures must show run 101's log only (got: $out)"

# --- a re-run's newer attempt supersedes: attempt 2 passed, so nothing is failing ---
RUNS_JSON="$(runs "$(run 101 1 CI 2 completed '"success"')" "$(run 102 2 'Refactor guards' 1 completed '"success"')")"
out="$(f pr-pipeline-retry)"
[[ "$out" == *"no run to retry"* ]] || fail "all green → no run to retry (got: $out)"
! grep -q '^run rerun' "$CALLS" || fail "all green must rerun nothing"
[[ -z "$(f pr-pipeline-failed-jobs)" ]] || fail "all green → no failed jobs"

# --- a newer run of the same workflow supersedes an older failed one ---
RUNS_JSON="$(runs "$(run 101 1 CI 1 completed '"failure"')" "$(run 103 1 CI 1 completed '"success"')")"
[[ -z "$(f pr-pipeline-failed-jobs)" ]] || fail "a newer passing run of the same workflow supersedes the failed one"

# --- runs on another SHA (e.g. merge_group) don't count ---
RUNS_JSON="$(runs "$(run 104 1 CI 1 completed '"failure"' other999)")"
out="$(f pr-pipeline-retry)"
[[ "$out" == *"no run to retry"* ]] || fail "a failed run on another SHA must not be retried (got: $out)"

# --- cancelled and timed_out count as failed; two failed workflows are both retried ---
RUNS_JSON="$(runs "$(run 105 1 CI 1 completed '"timed_out"')" "$(run 106 2 'Refactor guards' 1 completed '"cancelled"')")"
f pr-pipeline-retry >/dev/null
grep -q '^run rerun 105 --failed' "$CALLS" && grep -q '^run rerun 106 --failed' "$CALLS" \
  || fail "timed_out and cancelled runs are both retried (calls: $(cat "$CALLS"))"

echo "PASS forge-pipeline-failed-runs"
