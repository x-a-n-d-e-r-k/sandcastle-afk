#!/usr/bin/env bash
# Contract test for `forge issue-discussion` — an issue's HUMAN comments as readable markdown for agent
# prompts. Loops used to see only the issue body (issue-view), never the comments that refine it.
# Oldest first; author + date; the loop's own markers ([afk-…], [afk:…], [forge:…]) and GitLab system
# notes dropped; "(no comments)" when there are none; an API failure is an ERROR (never a silent
# "(no comments)"). Stubs on PATH — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# One stub serves both CLIs: prints $PAYLOAD, or fails when $STUB_FAIL is set (non-transient).
for cli in gh glab; do
  printf '%s\n' '#!/usr/bin/env bash' \
    '[[ -z "${STUB_FAIL:-}" ]] || { echo "HTTP 404: Not Found" >&2; exit 1; }' \
    'printf "%s" "$PAYLOAD"' > "$TMP/$cli"
  chmod +x "$TMP/$cli"
done
f() { PATH="$TMP:$PATH" FORGE_MAX_RETRIES=0 "$FORGE" issue-discussion 42; }

# --- GitHub ------------------------------------------------------------------------------------
export FORGE_PLATFORM=github
PAYLOAD='{"comments":[
  {"author":{"login":"bob"},"createdAt":"2026-10-02T09:00:00Z","body":"Also: the export must stay CSV, not JSON."},
  {"author":{"login":"loop-bot"},"createdAt":"2026-10-02T09:30:00Z","body":"[afk:resume] resuming from checkpoint (1/2)"},
  {"author":{"login":"alice"},"createdAt":"2026-10-01T08:00:00Z","body":"Clarifying scope: only the admin page."},
  {"author":{"login":"loop-bot"},"createdAt":"2026-10-01T10:00:00Z","body":"[afk-triage] unblocked (all blockers closed)."}]}'
out="$(PAYLOAD="$PAYLOAD" f)"
grep -q "### Comment by @alice on 2026-10-01" <<<"$out" || fail "[github] author + date heading (got: $out)"
grep -q "only the admin page" <<<"$out" || fail "[github] comment body included"
grep -q "must stay CSV" <<<"$out" || fail "[github] every human comment included"
[[ "$(grep -n 'alice' <<<"$out" | cut -d: -f1)" -lt "$(grep -n 'bob' <<<"$out" | cut -d: -f1)" ]] || fail "[github] oldest first"
if grep -q '\[afk' <<<"$out"; then fail "[github] the loop's own markers must be dropped (got: $out)"; fi

[[ "$(PAYLOAD='{"comments":[]}' f)" == "(no comments)" ]] || fail "[github] no comments → (no comments)"
[[ "$(PAYLOAD='{"comments":[{"author":{"login":"b"},"createdAt":"2026-10-01T00:00:00Z","body":"[forge:heal]"}]}' f)" == "(no comments)" ]] \
  || fail "[github] markers only → (no comments)"

set +e; out="$(STUB_FAIL=1 PAYLOAD=x f 2>/dev/null)"; rc=$?; set -e
[[ $rc -ne 0 ]] || fail "[github] an API failure must exit non-zero"
[[ "$out" != "(no comments)" ]] || fail "[github] an API failure must never read as (no comments)"

# --- GitLab: discussions → notes; system notes dropped ------------------------------------------
export FORGE_PLATFORM=gitlab
PAYLOAD='[{"notes":[{"author":{"username":"carol"},"created_at":"2026-10-01T08:00:00Z","body":"Use the v2 endpoint.","system":false}]},
          {"notes":[{"author":{"username":"gitlab"},"created_at":"2026-10-01T09:00:00Z","body":"added ~agent-ready label","system":true},
                    {"author":{"username":"bot"},"created_at":"2026-10-01T10:00:00Z","body":"[afk-triage] unblocked","system":false}]}]'
out="$(PAYLOAD="$PAYLOAD" f)"
grep -q "### Comment by @carol on 2026-10-01" <<<"$out" || fail "[gitlab] heading (got: $out)"
grep -q "Use the v2 endpoint." <<<"$out" || fail "[gitlab] body"
if grep -q "added ~agent-ready label" <<<"$out"; then fail "[gitlab] system notes must be dropped"; fi
if grep -q '\[afk' <<<"$out"; then fail "[gitlab] markers must be dropped"; fi
[[ "$(PAYLOAD='[]' f)" == "(no comments)" ]] || fail "[gitlab] no notes → (no comments)"

set +e; out="$(STUB_FAIL=1 PAYLOAD=x f 2>/dev/null)"; rc=$?; set -e
[[ $rc -ne 0 && "$out" != "(no comments)" ]] || fail "[gitlab] an API failure is an error, not (no comments)"

echo "PASS: forge issue-discussion renders human comments oldest-first (markers/system notes dropped); errors are errors — GitHub and GitLab"
