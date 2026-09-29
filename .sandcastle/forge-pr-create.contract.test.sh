#!/usr/bin/env bash
# Contract test for `forge pr-create`: body validation (afk-loop issue auto-close) and the
# pushed-branch guard (#59).
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
# It has a real bare `origin`: pr-create refuses a branch that isn't pushed at HEAD (#59).
REPO="$TMP/repo"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git init -q --bare "$TMP/origin.git"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@t.test
git -C "$REPO" config user.name t
git -C "$REPO" remote add origin "$TMP/origin.git"
git -C "$REPO" commit -q --allow-empty -m init

# Run forge from $REPO on branch $1 (pushed, so the body cases reach the body logic), with the
# fake gh on PATH; args follow.
on_branch() {
  local br="$1"; shift
  git -C "$REPO" checkout -q -B "$br"
  git -C "$REPO" push -q -f origin "$br"
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

# --- 8) pushed-branch guard (#59), GitHub and GitLab alike ---------------------
# Stubs record every call; a refusal must leave the log empty.
printf '#!/usr/bin/env bash\necho "$*" >> "${GH_ARGS:-/dev/null}"\nexit 0\n' > "$TMP/glab"
chmod +x "$TMP/glab"
# Run pr-create on the CURRENT checkout state (no checkout/push), on platform $1.
create() {
  local plat="$1"; shift
  ( cd "$REPO" && PATH="$TMP:$PATH" FORGE_PLATFORM="$plat" GH_ARGS="$ARGS" \
      "$FORGE" pr-create --base main --title "fix: x" --body "Closes #42" "$@" ) 2>"$TMP/err"
}
refuses() {  # $1 platform, $2 expected stderr fragment, $3 case name
  : > "$ARGS"
  if create "$1"; then fail "[$1] $3: pr-create should exit non-zero"; fi
  [[ ! -s "$ARGS" ]] || fail "[$1] $3: forge must not call the forge CLI (got: $(cat "$ARGS"))"
  grep -q -- "$2" "$TMP/err" || fail "[$1] $3: stderr should mention '$2' (got: $(cat "$TMP/err"))"
}

for plat in github gitlab; do
  # (a) branch never pushed
  git -C "$REPO" checkout -q -B "agent/issue-9$plat"
  refuses "$plat" "not on origin" "never-pushed branch"

  # (b) pushed, then a local commit origin doesn't have
  git -C "$REPO" push -q origin "agent/issue-9$plat"
  git -C "$REPO" commit -q --allow-empty -m "unpushed"
  refuses "$plat" "push first" "origin behind local HEAD"

  # (c) pushed and in sync: exactly one call, as today
  git -C "$REPO" push -q origin "agent/issue-9$plat"
  : > "$ARGS"
  create "$plat" || fail "[$plat] in-sync branch: pr-create should succeed (stderr: $(cat "$TMP/err"))"
  [[ "$(wc -l < "$ARGS" | tr -d ' ')" == 1 ]] || fail "[$plat] in-sync branch: expected exactly one CLI call (got: $(cat "$ARGS"))"
  if [[ "$plat" == gitlab ]]; then
    grep -q -- "--source-branch agent/issue-9gitlab " "$ARGS" || fail "[gitlab] --source-branch must be the branch (got: $(cat "$ARGS"))"
  fi

  # (d) detached HEAD
  git -C "$REPO" checkout -q --detach
  refuses "$plat" "detached HEAD" "detached HEAD"

  # (e) ls-remote fails (origin unreachable) — fail closed
  git -C "$REPO" checkout -q "agent/issue-9$plat"
  git -C "$REPO" remote set-url origin "$TMP/does-not-exist.git"
  refuses "$plat" "ls-remote failed" "unreachable origin"
  git -C "$REPO" remote set-url origin "$TMP/origin.git"
done

echo "PASS: forge pr-create requires a non-empty body, guarantees a closing keyword, and refuses a branch not pushed at HEAD"
