#!/usr/bin/env bash
# Contract test for `forge git-setup --git-name/--git-email` (#52).
#
# Upstream copies the HOST clone's git user.name/email into every sandbox, so implement and
# heal commits on one PR came out with different authors. git-setup runs AFTER that copy and
# must pin the configured identity over it. Runs the heal path's git setup in a scratch HOME +
# repo and asserts a commit carries the configured author and no Co-Authored-By trailer.
# Uses a fake gh — no network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORGE="$ROOT/bin/forge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$TMP/bin" "$TMP/home"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
# Isolated global config: HOME for ~/.gitconfig, and no system config bleeding in.
run() { HOME="$TMP/home" GIT_CONFIG_NOSYSTEM=1 PATH="$TMP/bin:$PATH" FORGE_PLATFORM=github "$@"; }

# What upstream does first: copy a DIFFERENT host identity into the sandbox's global config.
run git config --global user.name "host-clone-owner"
run git config --global user.email "owner@host.example"

# --- 1) git-setup pins the configured identity over the host copy ----------------------------
run "$FORGE" git-setup --git-name "dev-bot" --git-email "dev@bot.example" || fail "git-setup with identity should succeed"
[[ "$(run git config --global user.name)" == "dev-bot" ]] || fail "user.name not pinned"
[[ "$(run git config --global user.email)" == "dev@bot.example" ]] || fail "user.email not pinned"
run git config --global credential.helper | grep -q 'x-access-token' || fail "credential helper must still be configured"

# --- 2) a heal-style commit carries that author and no AI co-author trailer ------------------
repo="$TMP/repo"
run git init -q "$repo"
echo x > "$repo/f"
run git -C "$repo" add f
run git -C "$repo" commit -q -m "fix(#1): address review feedback"
author="$(run git -C "$repo" log -1 --format='%an <%ae>')"
[[ "$author" == "dev-bot <dev@bot.example>" ]] || fail "commit author is '$author', want the configured identity"
if run git -C "$repo" log -1 --format='%B' | grep -qi 'co-authored-by'; then fail "commit carries a Co-Authored-By trailer"; fi

# --- 3) half an identity is a config bug: refuse, don't half-apply ---------------------------
if run "$FORGE" git-setup --git-name "only-name" 2>/dev/null; then fail "git-setup with only --git-name must fail"; fi
[[ "$(run git config --global user.name)" == "dev-bot" ]] || fail "a refused git-setup must not change user.name"

# --- 4) no identity flags → creds only (the in-sandbox artifact-publish path, ui.ts) ----------
run "$FORGE" git-setup || fail "bare git-setup (creds only) must still work"

echo "PASS: forge git-setup pins the configured commit identity; half identity refused; bare form unchanged"
