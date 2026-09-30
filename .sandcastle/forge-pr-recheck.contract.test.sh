#!/usr/bin/env bash
# Contract test for `forge pr-recheck-mergeability` (#68). A stale "conflicting" flag on a degraded
# GitLab only clears when GitLab recomputes mergeability; a (no-op) rebase request forces that.
# GitHub recomputes lazily, so the verb makes no call there. Stubs on PATH — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

for cli in gh glab; do
  printf '%s\n' '#!/usr/bin/env bash' \
    'echo "$*" >> "$STUB_ARGS"' \
    'if [[ "$1 $2" == "mr view" ]]; then echo "{\"iid\":5,\"project_id\":9}"; fi' \
    'exit 0' > "$TMP/$cli"
  chmod +x "$TMP/$cli"
done
run() { STUB_ARGS="$TMP/args" PATH="$TMP:$PATH" FORGE_PLATFORM="$1" "$FORGE" pr-recheck-mergeability 5; }

: > "$TMP/args"
run gitlab || fail "[gitlab] should exit 0"
grep -qx 'api -X PUT projects/9/merge_requests/5/rebase' "$TMP/args" || fail "[gitlab] must PUT .../merge_requests/5/rebase (got: $(cat "$TMP/args"))"

: > "$TMP/args"
run github || fail "[github] should exit 0"
[[ ! -s "$TMP/args" ]] || fail "[github] must be a no-op (got: $(cat "$TMP/args"))"

echo "PASS: pr-recheck-mergeability PUTs a rebase on GitLab (forces a mergeability recompute); no-op on GitHub"
