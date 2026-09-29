#!/usr/bin/env bash
# Contract test for `forge pr-head-exists` and `forge pr-close` (#61).
#
# An orphan PR/MR (source branch missing on origin) reads as "conflicting" on GitLab, so the loop
# asks pr-head-exists first. It must print true/false, and on ANY API or git error exit non-zero
# rather than print "false" (absence is not proof). pr-close must be idempotent. Stubs on PATH
# plus a temp bare origin — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# origin has agent/issue-7 only.
git init -q --bare "$TMP/origin.git"
REPO="$TMP/repo"; git init -q "$REPO"
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$REPO" remote add origin "$TMP/origin.git"
git -C "$REPO" push -q origin HEAD:refs/heads/agent/issue-7

# One stub serves both CLIs: `view` prints $STUB_JSON (or fails when $STUB_FAIL is set); every
# other call is recorded to $STUB_ARGS.
for cli in gh glab; do
  printf '%s\n' '#!/usr/bin/env bash' \
    'if [[ "$2" == view ]]; then [[ -z "${STUB_FAIL:-}" ]] || { echo "boom: 500" >&2; exit 1; }; printf "%s" "$STUB_JSON"; exit 0; fi' \
    'echo "$*" >> "${STUB_ARGS:-/dev/null}"' > "$TMP/$cli"
  chmod +x "$TMP/$cli"
done
f() { ( cd "$REPO" && PATH="$TMP:$PATH" FORGE_RETRY_BASE_SECONDS=0 FORGE_MAX_RETRIES=0 "$FORGE" "$@" ); }

# payload <platform> <branch> <sha|""> [state]
payload() {
  if [[ "$1" == github ]]; then
    jq -nc --arg b "$2" --arg s "$3" --arg st "${4:-OPEN}" '{headRefName:$b, headRefOid:$s, state:$st}'
  else
    jq -nc --arg b "$2" --arg s "$3" --arg st "${4:-opened}" '{source_branch:$b, sha:(if $s == "" then null else $s end), state:$st}'
  fi
}

for plat in github gitlab; do
  export FORGE_PLATFORM="$plat"
  [[ "$(STUB_JSON="$(payload $plat agent/issue-9 "")" f pr-head-exists 5)" == false ]] || fail "[$plat] null/empty sha → false"
  [[ "$(STUB_JSON="$(payload $plat agent/issue-7 abc123)" f pr-head-exists 5)" == true ]] || fail "[$plat] sha + branch on origin → true"
  [[ "$(STUB_JSON="$(payload $plat agent/issue-9 abc123)" f pr-head-exists 5)" == false ]] || fail "[$plat] sha but branch missing on origin → false"

  set +e; out="$(STUB_FAIL=1 STUB_JSON=x f pr-head-exists 5 2>/dev/null)"; rc=$?; set -e
  [[ $rc -ne 0 ]] || fail "[$plat] API failure must exit non-zero"
  [[ "$out" != false ]] || fail "[$plat] API failure must never print false"

  # git failure (origin unreachable) is an error too, not "false"
  git -C "$REPO" remote set-url origin "$TMP/nope.git"
  set +e; out="$(STUB_JSON="$(payload $plat agent/issue-7 abc123)" f pr-head-exists 5 2>/dev/null)"; rc=$?; set -e
  git -C "$REPO" remote set-url origin "$TMP/origin.git"
  [[ $rc -ne 0 && "$out" != false ]] || fail "[$plat] ls-remote failure must exit non-zero, not print false"

  # pr-close: closes an open PR by number; an already-closed one is a no-op exiting 0
  : > "$TMP/args"
  STUB_ARGS="$TMP/args" STUB_JSON="$(payload $plat agent/issue-7 abc123)" f pr-close 5 || fail "[$plat] pr-close should succeed"
  grep -qE '^(pr|mr) close 5$' "$TMP/args" || fail "[$plat] pr-close must close PR 5 (got: $(cat "$TMP/args"))"
  : > "$TMP/args"
  closed_state=CLOSED; [[ $plat == gitlab ]] && closed_state=closed
  STUB_ARGS="$TMP/args" STUB_JSON="$(payload $plat agent/issue-7 abc123 $closed_state)" f pr-close 5 || fail "[$plat] closing a closed PR must exit 0"
  [[ ! -s "$TMP/args" ]] || fail "[$plat] closing a closed PR must not call close again"
done

echo "PASS: pr-head-exists is true/false or an error (never a false negative); pr-close is idempotent — GitHub and GitLab"
