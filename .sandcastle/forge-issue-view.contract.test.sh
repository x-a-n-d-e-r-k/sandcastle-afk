#!/usr/bin/env bash
# Contract test for `forge issue-view` (#11): it MUST emit a lowercased `state`
# (open/closed) — the field the loop's blocker-sweep isClosed check reads. forge
# previously omitted it, so the sweep never unblocked. This is the only automated guard
# of the bash emission (typecheck can't see into forge). Uses fake gh/glab — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- GitHub: gh returns UPPERCASE state; forge must lowercase it -------------
cat > "$TMP/gh" <<'EOF'
#!/usr/bin/env bash
cat <<'JSON'
{"number":7,"title":"t","body":"b","labels":[{"name":"blocked"}],"state":"CLOSED"}
JSON
EOF
chmod +x "$TMP/gh"
gh_state="$(PATH="$TMP:$PATH" FORGE_PLATFORM=github "$FORGE" issue-view 7 | jq -r '.state')"
[[ "$gh_state" == "closed" ]] || fail "github: expected state=closed, got '$gh_state'"

# --- GitLab: glab returns lowercase opened/closed; forge normalizes to closed -
cat > "$TMP/glab" <<'EOF'
#!/usr/bin/env bash
cat <<'JSON'
{"iid":7,"title":"t","description":"b","labels":["blocked"],"state":"closed"}
JSON
EOF
chmod +x "$TMP/glab"
gl_state="$(PATH="$TMP:$PATH" FORGE_PLATFORM=gitlab "$FORGE" issue-view 7 | jq -r '.state')"
[[ "$gl_state" == "closed" ]] || fail "gitlab: expected state=closed, got '$gl_state'"

# --- GitLab open case maps opened -> open ------------------------------------
cat > "$TMP/glab" <<'EOF'
#!/usr/bin/env bash
cat <<'JSON'
{"iid":8,"title":"t","description":"b","labels":[],"state":"opened"}
JSON
EOF
chmod +x "$TMP/glab"
gl_open="$(PATH="$TMP:$PATH" FORGE_PLATFORM=gitlab "$FORGE" issue-view 8 | jq -r '.state')"
[[ "$gl_open" == "open" ]] || fail "gitlab: expected state=open, got '$gl_open'"

echo "PASS: forge issue-view emits lowercased state (github=closed, gitlab=closed/open)"
