# Contributing

The tooling is copied **into other people's repos** (often via `bootstrap.sh`), so it must run in hosts very different from this one. Keep these host-portability rules:

## Host module type (CJS-default repos)

Many host repos have **no `"type": "module"`** (CommonJS default). `tsx` resolves a file's module type from the nearest `package.json`:

- **`.sandcastle/*.ts` runners** are ESM-scoped by `.sandcastle/package.json` `{"type":"module"}` — top-level `await` is fine there.
- **`scripts/*.ts`** are NOT under that manifest, and we deliberately do **not** add `scripts/package.json` (it could force ESM onto the host's own `scripts/` dir). So any `scripts/*.ts` that needs `await` at the top level **must wrap it in an async IIFE** (`void (async () => { ... })()`), or be a `.mts` file. Plain top-level `await` will crash in CJS hosts with *"Top-level await is currently not supported with the cjs output format."*

## Shell scripts

- `bin/forge` must run under **macOS's default bash 3.2**. Guard empty-array expansions with `${arr[@]+"${arr[@]}"}`; don't rely on bash 4+ features.
- The GitLab (`glab`) paths are best-effort and carry `# VERIFY` notes — validate against a live instance before marking them ✅ in the README matrix.

## Required config keys

A new **required** `afk.config.json` key (no default) needs three things:
- its validator in `CONFIG_CONTRACT` in `.sandcastle/config-contract.ts`;
- an example value in `afk.config.example.json`;
- a placeholder in `scripts/init.ts`.

The loop enforces that list at startup, and `afk:update` checks a consumer's config against it before installing (#77), so a new key is announced at update time instead of crashing `afk:loop`. Prefer an optional key with a default where one is safe (e.g. `labels.orphan`).

## After changes

`npm run typecheck` (the `.sandcastle` + `scripts` TS) and `bash -n bin/forge`.
