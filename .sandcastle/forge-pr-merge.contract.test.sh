#!/usr/bin/env bash
# Contract test for `forge pr-merge` on GitLab (#88): EXACTLY ONE merge request per call. A self-hosted
# GitLab that merges and THEN answers 500 got the same change squash-merged six times per call, because
# `glab mr merge`'s HTTP client retried the non-idempotent PUT. forge now sends one PUT (no client
# retries), pinned to the head sha, and treats a non-2xx answer as UNKNOWN: re-read the MR — merged →
# exit 0; still open → fail (the loop's merge guard re-evaluates next cycle). Stubs on PATH, no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# glab: `mr view` → the MR, whose state is read from $TMP/state; `mr merge` must NEVER be called.
cat > "$TMP/glab" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == "mr view" ]]; then
  printf '{"iid":7,"project_id":9,"sha":"c0ffee11","state":"%s","web_url":"https://git.example.net/grp/proj/-/merge_requests/7"}' "$(cat "$STATE_FILE")"
  exit 0
fi
if [[ "$1 $2" == "mr merge" ]]; then echo "glab mr merge" >> "$CALLS"; exit 0; fi
echo "unexpected glab call: $*" >&2; exit 2
STUB
# curl: records argv (one line per call), answers $CODE; if $MERGE_EFFECT=merged the server "merged"
# before answering (the observed failure mode), flipping the MR state.
cat > "$TMP/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "$CALLS"
out=""; hdr=""
while [[ $# -gt 0 ]]; do
  case "$1" in -o) out="$2"; shift 2;; -H) hdr="$2"; shift 2;; *) shift;; esac
done
[[ "$hdr" == @* ]] && cat "${hdr#@}" > "$HDR_SEEN"
[[ "${MERGE_EFFECT:-}" == merged ]] && echo merged > "$STATE_FILE"
echo '{"message":"stub response"}' > "$out"
printf '%s' "$CODE"
STUB
printf '#!/usr/bin/env bash\necho "gh $*" >> "$CALLS"\n' > "$TMP/gh"
chmod +x "$TMP/glab" "$TMP/curl" "$TMP/gh"

export CALLS="$TMP/calls" STATE_FILE="$TMP/state" HDR_SEEN="$TMP/hdr" GITLAB_TOKEN="glpat-secret"
merge() { PATH="$TMP:$PATH" FORGE_PLATFORM="${PLAT:-gitlab}" "$FORGE" pr-merge 7 --squash --delete-branch --no-auto-merge; }
reset() { : > "$CALLS"; : > "$HDR_SEEN"; echo opened > "$STATE_FILE"; }
n_merge_calls() { grep -cE '^(curl|glab mr merge)' "$CALLS" || true; }

# --- 1) the reported failure: the server merges, then answers 500 → ONE request, exit 0 ----------
reset
CODE=500 MERGE_EFFECT=merged merge >"$TMP/out" 2>"$TMP/err" || fail "merged-then-500 must exit 0 (it DID merge) — stderr: $(cat "$TMP/err")"
[[ "$(n_merge_calls)" == 1 ]] || fail "exactly ONE merge request must be sent (got: $(cat "$CALLS"))"
grep -q "IS merged" "$TMP/out" || fail "the unknown-then-merged outcome is logged"

# --- 2) a clean 200 → one request; the request is the right one --------------------------------
reset
CODE=200 merge >/dev/null || fail "a 200 must succeed"
[[ "$(n_merge_calls)" == 1 ]] || fail "one request on success"
line="$(grep '^curl' "$CALLS")"
for want in "-X PUT" "https://git.example.net/api/v4/projects/9/merge_requests/7/merge" "sha=c0ffee11" "squash=true" "should_remove_source_branch=true"; do
  grep -qF -- "$want" <<<"$line" || fail "merge request must include '$want' (got: $line)"
done
if grep -q "merge_when_pipeline_succeeds" <<<"$line"; then fail "auto-merge must never be requested"; fi
if grep -q "glpat-secret" <<<"$line"; then fail "the token must not appear in argv"; fi
grep -q "PRIVATE-TOKEN: glpat-secret" "$HDR_SEEN" || fail "the token is sent as a header (from a file)"
if grep -q "^glab mr merge" "$CALLS"; then fail "glab mr merge (retrying client) must not be used"; fi

# --- 3) a genuine failure (nothing merged) → one request, NON-zero exit -------------------------
reset
if CODE=500 merge 2>"$TMP/err"; then fail "a 500 with the MR still open must fail (the loop retries next cycle)"; fi
[[ "$(n_merge_calls)" == 1 ]] || fail "still exactly one request on a genuine failure"
grep -q "still 'opened'" "$TMP/err" || fail "the failure says the MR is still open (got: $(cat "$TMP/err"))"

# --- 4) a network error (curl fails, no HTTP code) is unknown too ------------------------------
reset
printf '#!/usr/bin/env bash\necho "curl $*" >> "$CALLS"\nexit 28\n' > "$TMP/curl-timeout"
cp "$TMP/curl" "$TMP/curl.ok"; cp "$TMP/curl-timeout" "$TMP/curl"; chmod +x "$TMP/curl"
echo merged > "$STATE_FILE"   # e.g. it merged but the response was lost
merge >/dev/null 2>&1 || fail "a timeout where the MR did merge must succeed"
[[ "$(n_merge_calls)" == 1 ]] || fail "one request on a timeout"
cp "$TMP/curl.ok" "$TMP/curl"

# --- 4b) token sources: GITLAB_ACCESS_TOKEN as PRIVATE-TOKEN; OAUTH_TOKEN as a Bearer token ------
reset
GITLAB_TOKEN= GITLAB_ACCESS_TOKEN=glpat-access CODE=200 merge >/dev/null || fail "GITLAB_ACCESS_TOKEN works"
grep -q "PRIVATE-TOKEN: glpat-access" "$HDR_SEEN" || fail "GITLAB_ACCESS_TOKEN is sent as PRIVATE-TOKEN"
reset
GITLAB_TOKEN= OAUTH_TOKEN=oauth-xyz CODE=200 merge >/dev/null || fail "OAUTH_TOKEN works"
grep -q "Authorization: Bearer oauth-xyz" "$HDR_SEEN" || fail "OAUTH_TOKEN is sent as a Bearer token"

# --- 5) GitHub is unchanged ------------------------------------------------------------------
reset
PLAT=github merge || fail "[github] pr-merge"
grep -qx "gh pr merge 7 --squash --delete-branch" "$CALLS" || fail "[github] unchanged gh pr merge (got: $(cat "$CALLS"))"

echo "PASS: GitLab pr-merge sends exactly one merge request (no client retries); merged-then-5xx succeeds, a genuine failure fails; GitHub unchanged"
