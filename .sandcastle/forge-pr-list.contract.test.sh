#!/usr/bin/env bash
# Contract test for `forge pr-list --state closed` (#70): it must include MERGED PRs/MRs on both
# platforms. GitLab keeps merged MRs in a separate state, so `glab mr list --closed` alone hid them
# and pickNextIssue re-dispatched work that had already shipped. Stubs on PATH — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# glab: `mr list --closed` → MR 1 (closed); `mr list --merged` → MR 2 (merged); approvals → {}.
cat > "$TMP/glab" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == "mr list" ]]; then
  # Page size must match gh's --limit 100 (glab defaults to 30 per page).
  [[ " $* " == *" --per-page 100 "* ]] || { echo "glab mr list called without --per-page 100: $*" >&2; exit 3; }
  case " $* " in
    *" --closed "*) echo '[{"iid":1,"project_id":9,"source_branch":"agent/issue-1","state":"closed","labels":[]}]' ;;
    *" --merged "*) echo '[{"iid":2,"project_id":9,"source_branch":"agent/issue-2","state":"merged","labels":[]}]' ;;
    *" --all "*)    echo '[]' ;;
    *)              echo '[{"iid":3,"project_id":9,"source_branch":"agent/issue-3","state":"opened","labels":[]}]' ;;
  esac
  exit 0
fi
if [[ "$1" == api ]]; then echo '{}'; exit 0; fi
exit 0
STUB
# gh: `pr list --state closed` natively includes merged PRs.
cat > "$TMP/gh" <<'STUB'
#!/usr/bin/env bash
echo '[{"number":1,"headRefName":"agent/issue-1","reviewDecision":"","labels":[],"state":"CLOSED"},
       {"number":2,"headRefName":"agent/issue-2","reviewDecision":"","labels":[],"state":"MERGED"}]'
STUB
chmod +x "$TMP/glab" "$TMP/gh"
list() { PATH="$TMP:$PATH" FORGE_PLATFORM="$1" "$FORGE" pr-list --state "$2"; }
shape() { jq -c 'map({number, merged}) | sort_by(.number)'; }

want='[{"number":1,"merged":false},{"number":2,"merged":true}]'
for plat in gitlab github; do
  got="$(list "$plat" closed | shape)"
  [[ "$got" == "$want" ]] || fail "[$plat] pr-list --state closed must return closed AND merged (got: $got)"
done

# GitLab: --state merged / open are unchanged (single list each).
[[ "$(list gitlab merged | shape)" == '[{"number":2,"merged":true}]' ]] || fail "[gitlab] --state merged changed"
[[ "$(list gitlab open | shape)" == '[{"number":3,"merged":false}]' ]] || fail "[gitlab] --state open changed"

echo "PASS: pr-list --state closed includes merged PRs/MRs (merged:true) and closed-unmerged ones (merged:false) on GitHub and GitLab"
