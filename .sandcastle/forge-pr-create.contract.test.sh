#!/usr/bin/env bash
# Contract test for `forge pr-create` body validation (afk-loop issue auto-close).
#
# GitHub/GitLab read the closing keyword from the PR/MR body only. `pr-create` used to
# validate --base and --title but not --body, so `gh pr create --body ""` succeeded and the
# loop could open a bodyless PR: it reviewed green (review.ts rescues the issue number from
# the branch), merged, and left the implemented issue open forever. implement.md asks for
# `Closes #N`, but a prompt is advisory — forge must enforce it. Uses a fake gh — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Fake gh: records full argv to $GH_ARGS and the exact --body value to $GH_BODY, so the
# body can be compared byte-for-byte (it contains newlines, which flatten in argv).
cat > "$TMP/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "${GH_ARGS:-/dev/null}"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --body ]]; then printf '%s' "$2" > "${GH_BODY:-/dev/null}"; shift 2; else shift; fi
done
exit 0
EOF
chmod +x "$TMP/gh"

# forge reads the branch via `git branch --show-current`, so drive it from a throwaway repo
# rather than depending on whatever branch this checkout happens to be on.
REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@t.test
git -C "$REPO" config user.name t
git -C "$REPO" commit -q --allow-empty -m init

# Run forge from $REPO on branch $1, with the fake gh on PATH; args follow.
on_branch() {
  local br="$1"; shift
  git -C "$REPO" checkout -q -B "$br"
  ( cd "$REPO" && PATH="$TMP:$PATH" FORGE_PLATFORM=github \
      GH_ARGS="${GH_ARGS:-/dev/null}" GH_BODY="${GH_BODY:-/dev/null}" "$FORGE" "$@" )
}

ARGS="$TMP/args"; BODY="$TMP/body"

# --- 1) omitted body: must die WITHOUT calling gh -----------------------------
: > "$ARGS"
if GH_ARGS="$ARGS" on_branch agent/issue-42 pr-create --base main --title "fix: x" 2>/dev/null; then
  fail "pr-create with no body should exit non-zero"
fi
[[ ! -s "$ARGS" ]] || fail "pr-create must not invoke gh when the body is missing (got: $(cat "$ARGS"))"

# --- 2) whitespace-only body: must die (boundary — [[ -n "$body" ]] would pass) -
: > "$ARGS"
if GH_ARGS="$ARGS" on_branch agent/issue-42 pr-create --base main --title "fix: x" --body "  "$'\n'"  " 2>/dev/null; then
  fail "pr-create with a whitespace-only body should exit non-zero"
fi
[[ ! -s "$ARGS" ]] || fail "pr-create must not invoke gh for a whitespace-only body"

# --- 3) no keyword + agent/issue-42 branch: prepend Closes #42 ----------------
: > "$ARGS"; : > "$BODY"
GH_ARGS="$ARGS" GH_BODY="$BODY" on_branch agent/issue-42 \
  pr-create --base main --title "fix: x" --body "## What"$'\n'"Did the thing." \
  || fail "pr-create should self-correct a missing keyword on an agent/issue-<N> branch"
grep -q 'pr create --base main --title fix: x' "$ARGS" || fail "gh was not called (got: $(cat "$ARGS"))"
[[ "$(cat "$BODY")" == "Closes #42"$'\n\n'"## What"$'\n'"Did the thing." ]] \
  || fail "expected Closes #42 prepended, got: $(cat "$BODY")"

# --- 4) keyword already present: pass through byte-identical, no double-prepend -
: > "$BODY"
orig="Closes #42"$'\n\n'"## What"
GH_BODY="$BODY" on_branch agent/issue-42 pr-create --base main --title "fix: x" --body "$orig" \
  || fail "pr-create should accept a body that already carries a closing keyword"
[[ "$(cat "$BODY")" == "$orig" ]] || fail "body must pass through unchanged, got: $(cat "$BODY")"
[[ "$(grep -ci 'closes #42' "$BODY")" == 1 ]] || fail "double-prepended the closing keyword"

# --- 5) no keyword + branch with no derivable number: die ---------------------
: > "$ARGS"
if GH_ARGS="$ARGS" on_branch fix/manual-thing pr-create --base main --title "fix: x" --body "## What" 2>/dev/null; then
  fail "pr-create should die when no keyword and the branch has no issue number"
fi
[[ ! -s "$ARGS" ]] || fail "pr-create must not invoke gh when the keyword cannot be derived"

# --- 6) --body-file produces the same argv as the equivalent --body -----------
: > "$BODY"
printf '%s' "Closes #42"$'\n\n'"## What" > "$TMP/bodyfile"
GH_BODY="$BODY" on_branch agent/issue-42 pr-create --base main --title "fix: x" --body-file "$TMP/bodyfile" \
  || fail "pr-create should accept --body-file"
[[ "$(cat "$BODY")" == "$orig" ]] || fail "--body-file body differs from --body, got: $(cat "$BODY")"

# --- 7) a missing --body-file is an error, not an empty body ------------------
: > "$ARGS"
if GH_ARGS="$ARGS" on_branch agent/issue-42 pr-create --base main --title "fix: x" --body-file "$TMP/nope" 2>/dev/null; then
  fail "pr-create should die on a nonexistent --body-file"
fi
[[ ! -s "$ARGS" ]] || fail "pr-create must not invoke gh for a nonexistent --body-file"

echo "PASS: forge pr-create requires a non-empty body and guarantees a closing keyword"
