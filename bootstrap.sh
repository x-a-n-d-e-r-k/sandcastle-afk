#!/usr/bin/env bash
# Bootstrap sandcastle-afk into the CURRENT repo (the project you want the agent
# to work on). Adds the tooling and merges package.json — no config, no secrets.
#
#   From the root of your repo:
#     curl -fsSL https://raw.githubusercontent.com/x-a-n-d-e-r-k/sandcastle-afk/main/bootstrap.sh | bash
#   or, from a clone of sandcastle-afk:
#     bash bootstrap.sh
#
# Env overrides: AFK_REPO (url or local path), AFK_REF (branch/tag).
set -euo pipefail

REPO="${AFK_REPO:-https://github.com/x-a-n-d-e-r-k/sandcastle-afk}"
REF="${AFK_REF:-main}"

[[ -d .git ]] || { echo "Run this from the root of a git repo (your project)." >&2; exit 1; }
for t in git node; do command -v "$t" >/dev/null || { echo "$t is required" >&2; exit 1; }; done

echo "Fetching sandcastle-afk ($REF) from $REPO ..."
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git clone --depth 1 --branch "$REF" "$REPO" "$TMP/afk" >/dev/null 2>&1 \
  || { echo "clone failed: $REPO@$REF" >&2; exit 1; }

copy_dir() {
  local d="$1"
  [[ -e "$d" ]] && echo "  ! $d exists — merging into it (same-named files overwritten)"
  mkdir -p "$d"
  cp -R "$TMP/afk/$d/." "$d/"
}
echo "Copying tooling..."
copy_dir bin
copy_dir .sandcastle
copy_dir skills
copy_dir scripts
cp "$TMP/afk/afk.config.example.json" .
cp "$TMP/afk/playbook.md" .
chmod +x bin/forge skills/agent-ready-issue/*.sh 2>/dev/null || true

echo "Merging package.json..."
node "$TMP/afk/scripts/merge-package-json.cjs" "$TMP/afk/package.json"

echo "Updating .gitignore..."
for line in "node_modules/" ".pnpm-store/" ".sandcastle/.env" ".sandcastle/.env.review" \
            ".sandcastle/logs/" ".sandcastle/worktrees/" ".sandcastle/e2e-worktree/" \
            ".sandcastle/Dockerfile" ".sandcastle/preflight.sh" "afk.config.json" ".claude/"; do
  grep -qxF "$line" .gitignore 2>/dev/null || echo "$line" >> .gitignore
done

cat <<'DONE'

Tooling installed. Next steps (none of which this script does, on purpose):
  1. Install deps:        npm install        (or pnpm / yarn)
  2. Scaffold config:     npm run afk:init    -> REVIEW afk.config.json (especially `preflight`)
  3. Secrets:             cp .sandcastle/.env.example .sandcastle/.env  &&  fill in tokens
  4. Identities, approval rules, the preflight spike:  see playbook.md
DONE
