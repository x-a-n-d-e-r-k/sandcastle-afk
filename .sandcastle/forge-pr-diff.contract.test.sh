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
# Assert the retry OCCURRED, not merely that the exit was non-zero: a non-zero exit happens
# whether forge retries or gives up instantly, so exit code alone doesn't pin the property in
# this case's name. run_with_retry only sees the transient error because the 406 fallback
# re-emits gh's captured stderr on the non-406 path (`cat "$derr" >&2`) — one load-bearing,
# easy-to-delete line. Counting the attempts pins both that retrying happens and that it is
# bounded by FORGE_MAX_RETRIES.
RETRY_ERR="$TMP/retry-err"
if FAKE_GH_DIFF_ERR="HTTP 502: Bad Gateway" FORGE_MAX_RETRIES=2 FORGE_RETRY_BASE_SECONDS=0 \
   run_forge pr-diff 894 >/dev/null 2>"$RETRY_ERR"; then
  fail "a transient 5xx must not be rescued by the 406 fallback"
fi
[[ "$(grep -c "transient error on 'pr-diff'" "$RETRY_ERR")" == 2 ]] \
  || fail "expected exactly 2 bounded retry attempts, got: $(cat "$RETRY_ERR")"

# --- 7) the fallback works in a --single-branch clone (refspec coverage) ------
# A single-branch clone's refspec covers only main, so a bare `git fetch origin <head>` leaves
# refs/remotes/origin/<head> absent and the three-dot diff dies on an unknown revision.
SB="$TMP/single-branch"
git clone -q --single-branch --branch main "$ORIGIN" "$SB"
out="$( cd "$SB" && PATH="$TMP:$PATH" FORGE_PLATFORM=github "$FORGE" pr-diff 894 )" \
  || fail "the 406 fallback must work in a --single-branch clone"
grep -q 'rename from old-name.ts' <<<"$out" || fail "single-branch: expected rename detection (got: $out)"
grep -q '^+export const a = 2;' <<<"$out" || fail "single-branch: missing the content delta (got: $out)"

# --- 8) a force-pushed head still diffs (guards the non-fast-forward '+') -----
# Without a leading '+' on the refspec, the second fetch would reject the rewritten head.
git -C "$ORIGIN" checkout -q agent/issue-894
printf 'export const a = 3;\n' > "$ORIGIN/touched.ts"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -q --amend -m rename-sweep-amended
git -C "$ORIGIN" checkout -q main
out="$( cd "$SB" && PATH="$TMP:$PATH" FORGE_PLATFORM=github "$FORGE" pr-diff 894 )" \
  || fail "the 406 fallback must survive a force-pushed head"
grep -q '^+export const a = 3;' <<<"$out" \
  || fail "expected the amended commit's delta after a force-push (got: $out)"

echo "PASS: forge pr-diff falls back to a local rename-aware diff on a 406, fails fast otherwise"
