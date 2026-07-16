#!/usr/bin/env bash
# Guard: application code must call forge through the typed client (#40/#42), never by
# hand-typing a verb string. `forge(`pr-view ${n}`)` / `forgeJSON<T>(...)` are how #21 (a
# caller invoked a verb forge didn't define) and #11 (a caller read an undocumented field)
# shipped — the typed client makes both compile errors, but only if every caller actually uses
# it. This fails if a raw string call reappears anywhere outside the two files allowed to hold
# the primitive: config.ts (which defines forge()/forgeJSON()) and forge-client.ts (the wrapper).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.sandcastle"
fail() { echo "FAIL: $*" >&2; exit 1; }

# Raw-call patterns: `forge(` or `forgeJSON` where forge is called as a function on a string,
# NOT the `forge.` namespace client. (A namespace call is `forge.prView(...)` — `forge.`, never
# `forge(`.)  `git-setup` inside a Docker hook command string is a shell literal, not a call.
PATTERN='forge\(`|forge\("|forgeJSON'

offenders=""
for f in "$DIR"/*.ts; do
  base="$(basename "$f")"
  case "$base" in
    config.ts|forge-client.ts|gen-forge-client.ts) continue ;;  # allowed to hold the primitive
    *.test.ts) continue ;;                                        # tests may reference either form
  esac
  if grep -nE "$PATTERN" "$f" >/dev/null 2>&1; then
    offenders+="$base:"$'\n'"$(grep -nE "$PATTERN" "$f")"$'\n'
  fi
done

[[ -z "$offenders" ]] || fail "hand-typed forge string call(s) found — use the typed client (forge.<verb>):"$'\n'"$offenders"

# Non-vacuity self-check: the pattern MUST match a known raw call when one exists. Prove the
# guard can actually fire, so a broken regex can't pass this test vacuously.
probe="$(mktemp)"; printf 'const x = forgeJSON<Foo>(`issue-view 1`);\n' > "$probe"
grep -qE "$PATTERN" "$probe" || { rm -f "$probe"; fail "guard regex failed to match a known raw call — the check is vacuous"; }
rm -f "$probe"

echo "PASS: all forge callers use the typed client; no hand-typed verb strings outside config.ts/forge-client.ts"
