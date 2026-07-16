#!/usr/bin/env bash
# Contract test for `forge pr-diff`'s 406 fallback (afk-loop review of large PRs).
#
# GitHub's PR-diff API hard-fails with HTTP 406 above 300 changed files. review.md and
# heal.md embed `forge pr-diff <N>`, so such a PR could never be reviewed: the loop
# error-slept and retried the same doomed call forever ("cycle error ... Sleeping 60s").
# The limit counts a rename as 2 files, so a mechanical sweep trips it while the true
# reviewable delta is small — hence the local fallback diffs with rename detection.
# Uses a fake gh + throwaway git repos — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Fake gh: `pr diff` fails with the error in $FAKE_GH_DIFF_ERR; `pr view` reports the refs.
cat > "$TMP/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == pr && "${2:-}" == diff ]]; then
  echo "${FAKE_GH_DIFF_ERR:-HTTP 406: Not Acceptable}" >&2; exit 1
fi
if [[ "${1:-}" == pr && "${2:-}" == view ]]; then
  echo '{"baseRefName":"main","headRefName":"agent/issue-894"}'; exit 0
fi
exit 0
EOF
chmod +x "$TMP/gh"

# An origin whose head branch mirrors the reported shape: a pure rename (which the API
# counts as 2 files) plus a small real content change.
ORIGIN="$TMP/origin"
mkdir -p "$ORIGIN"
git -C "$ORIGIN" init -q -b main
git -C "$ORIGIN" config user.email t@t.test
git -C "$ORIGIN" config user.name t
printf 'unchanged content\n' > "$ORIGIN/old-name.ts"
printf 'export const a = 1;\n' > "$ORIGIN/touched.ts"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -q -m base
git -C "$ORIGIN" checkout -q -b agent/issue-894
git -C "$ORIGIN" mv old-name.ts new-name.ts
printf 'export const a = 2;\n' > "$ORIGIN/touched.ts"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -q -m rename-sweep
git -C "$ORIGIN" checkout -q main

WORK="$TMP/work"
git clone -q "$ORIGIN" "$WORK"
run_forge() { ( cd "$WORK" && PATH="$TMP:$PATH" FORGE_PLATFORM=github "$FORGE" "$@" ); }

# --- 1) a 406 falls back to a local diff instead of failing the review -------
out="$(run_forge pr-diff 894)" || fail "pr-diff should fall back to a local diff on a 406"

# --- 2) the rename is detected as a rename, not as delete+add ----------------
grep -q 'rename from old-name.ts' <<<"$out" || fail "expected rename detection (got: $out)"
grep -q 'rename to new-name.ts' <<<"$out" || fail "expected rename detection (got: $out)"
grep -q 'unchanged content' <<<"$out" && fail "a pure rename must not emit content hunks"

# --- 3) the real content delta still shows up --------------------------------
grep -q '^-export const a = 1;' <<<"$out" || fail "missing the real content delta (got: $out)"
grep -q '^+export const a = 2;' <<<"$out" || fail "missing the real content delta (got: $out)"

# --- 4) the fallback announces itself, so a reviewer knows the source --------
grep -qi '406' <<<"$out" || fail "the fallback should say why it engaged"

# --- 5) a non-406 failure still fails fast (no silent fallback) --------------
if FAKE_GH_DIFF_ERR="HTTP 404: Not Found" run_forge pr-diff 894 >/dev/null 2>&1; then
  fail "a non-406 pr-diff failure must not be rescued by the fallback"
fi

# --- 6) a transient 5xx keeps retrying (pr-diff stays a retryable read) ------
if FAKE_GH_DIFF_ERR="HTTP 502: Bad Gateway" FORGE_MAX_RETRIES=1 FORGE_RETRY_BASE_SECONDS=0 \
   run_forge pr-diff 894 >/dev/null 2>&1; then
  fail "a transient 5xx must not be rescued by the 406 fallback"
fi

echo "PASS: forge pr-diff falls back to a local rename-aware diff on a 406, fails fast otherwise"
