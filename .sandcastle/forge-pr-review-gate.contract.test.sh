#!/usr/bin/env bash
# Contract test for `forge pr-review-gate` (#81): {head, blockingBody, blockingSha, rebuttal} — the
# LATEST changes-requested review, the commit it was made on, and a rebuttal posted AFTER it.
# GitHub: blockingSha is the review's commit. GitLab: notes carry no commit, so blockingSha is ""
# (its label flow is unchanged). Stubs on PATH — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# gh: `pr view` prints $GH_JSON. glab: `mr view` prints $MR_JSON, `mr note list` prints $NOTES_JSON.
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s" "$GH_JSON"' > "$TMP/gh"
printf '%s\n' '#!/usr/bin/env bash' \
  'if [[ "$1 $2" == "mr view" ]]; then printf "%s" "$MR_JSON"; else printf "%s" "$NOTES_JSON"; fi' > "$TMP/glab"
chmod +x "$TMP/gh" "$TMP/glab"
f() { PATH="$TMP:$PATH" "$FORGE" pr-review-gate 7; }
get() { jq -r ".$1"; }

# --- GitHub: the #2722 timeline (block, heal marker, approve — all on one commit) ---------------
export FORGE_PLATFORM=github
GH_JSON='{"headRefOid":"b4d0","reviews":[
  {"state":"CHANGES_REQUESTED","body":"first block","submittedAt":"2026-10-02T01:00:00Z","commit":{"oid":"a111"}},
  {"state":"CHANGES_REQUESTED","body":"deleted the guarding test","submittedAt":"2026-10-02T02:11:11Z","commit":{"oid":"b4d0"}},
  {"state":"APPROVED","body":"LGTM","submittedAt":"2026-10-02T02:22:15Z","commit":{"oid":"b4d0"}}],
  "comments":[{"body":"[afk:rebuttal] old, before the latest block","createdAt":"2026-10-02T01:30:00Z"},
              {"body":"[forge:heal]","createdAt":"2026-10-02T02:11:47Z"}]}'
out="$(GH_JSON="$GH_JSON" f)"
[[ "$(get head <<<"$out")" == b4d0 ]] || fail "[github] head"
[[ "$(get blockingBody <<<"$out")" == "deleted the guarding test" ]] || fail "[github] the LATEST blocking review body (got: $out)"
[[ "$(get blockingSha <<<"$out")" == b4d0 ]] || fail "[github] the blocking review's commit"
[[ "$(get rebuttal <<<"$out")" == "" ]] || fail "[github] a rebuttal from BEFORE the latest block must not count"

# a rebuttal after the block is returned
GH2="$(jq -c '.comments += [{"body":"[afk:rebuttal] it is guarded by test X","createdAt":"2026-10-02T02:15:00Z"}]' <<<"$GH_JSON")"
[[ "$(GH_JSON="$GH2" f | get rebuttal)" == "[afk:rebuttal] it is guarded by test X" ]] || fail "[github] rebuttal after the block"

# never blocked
[[ "$(GH_JSON='{"headRefOid":"c0","reviews":[],"comments":[]}' f | jq -c '[.blockingBody,.blockingSha,.rebuttal]')" == '["","",""]' ]] || fail "[github] no block → empty fields"

# --- GitLab: marker note body (marker stripped), no commit → blockingSha "" --------------------
export FORGE_PLATFORM=gitlab
MR_JSON='{"iid":7,"sha":"b4d0"}'
NOTES_JSON='[{"notes":[
  {"body":"[forge:changes-requested] deleted the guarding test","created_at":"2026-10-02T02:11:11Z"},
  {"body":"[afk:rebuttal] it is guarded by test X","created_at":"2026-10-02T02:15:00Z"}]}]'
out="$(MR_JSON="$MR_JSON" NOTES_JSON="$NOTES_JSON" f)"
[[ "$(get head <<<"$out")" == b4d0 ]] || fail "[gitlab] head"
[[ "$(get blockingBody <<<"$out")" == "deleted the guarding test" ]] || fail "[gitlab] marker stripped (got: $out)"
[[ "$(get blockingSha <<<"$out")" == "" ]] || fail "[gitlab] notes carry no commit → blockingSha empty"
[[ "$(get rebuttal <<<"$out")" == "[afk:rebuttal] it is guarded by test X" ]] || fail "[gitlab] rebuttal after the block"

echo "PASS: pr-review-gate reports the latest block, its commit (GitHub) and a later rebuttal — GitHub and GitLab"
