// Overlay management for the installed layer (#13).
//
// An installed sandcastle-afk overlay should behave like `node_modules`: materialized on
// disk by afk:init/afk:update, but NOT tracked in the consumer repo — so a layer refresh
// never shows up as a tracked diff. The exception is CI-class files (the auto-unblock
// workflow + its scripts), which MUST stay committed because GitHub Actions only run
// committed files.
//
// This is the single source of truth for which managed paths are `ignore` (runtime
// overlay) vs `commit` (must live in the repo). init.ts and update.ts both apply it.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// `ignore`-class overlay paths (gitignored + untracked in the consumer). Dir entries end
// with "/" and cover everything beneath — `.sandcastle/` also subsumes its generated
// files and local state (.env, Dockerfile, .layer-sync.json, .managed.json). `skills/`
// and `scripts/` are intentionally per-path because each is a MIXED dir in consumers
// (repo-owned files live alongside layer ones), so they must not be blanket-ignored.
export const OVERLAY_IGNORE: string[] = [
  ".sandcastle/",
  "bin/forge",
  "skills/agent-ready-issue/",
  "scripts/init.ts",
  "scripts/update.ts",
  "scripts/resolve-rules.ts",
  "scripts/overlay.ts",
  "scripts/merge-package-json.cjs",
  // The layer ships its own *.test.ts under scripts/ (e.g. overlay.test.ts); those are
  // overlay too. (.sandcastle/ test files are already covered by the `.sandcastle/` entry.)
  "scripts/*.test.ts",
];

// `commit`-class managed paths: kept tracked. The auto-unblock workflow runs these from
// the repo, so they cannot be ignored.
export const OVERLAY_COMMIT: string[] = ["scripts/auto-unblock/"];

export type ManifestEntry = { path: string; class: "ignore" | "commit" };
export const managedManifest = (): ManifestEntry[] => [
  ...OVERLAY_IGNORE.map((path) => ({ path, class: "ignore" as const })),
  ...OVERLAY_COMMIT.map((path) => ({ path, class: "commit" as const })),
];

const BEGIN = "# >>> sandcastle-afk overlay (managed by afk:init/afk:update — do not edit) >>>";
const END = "# <<< sandcastle-afk overlay <<<";

// Insert or replace the managed block in a .gitignore's text. Idempotent: running it
// repeatedly with the same paths is a no-op; changing the paths rewrites just the block,
// leaving the consumer's own entries untouched. Pure (no I/O) so it's unit-testable.
export function upsertManagedBlock(current: string, ignorePaths: string[]): string {
  const block = [BEGIN, ...ignorePaths, END].join("\n");
  const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`);
  if (re.test(current)) return current.replace(re, block);
  const base = current.replace(/\s*$/, "");
  return (base ? `${base}\n\n` : "") + block + "\n";
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Write/refresh the managed .gitignore block in `root`.
export function writeManagedGitignore(root: string): void {
  const gi = join(root, ".gitignore");
  const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const next = upsertManagedBlock(current, OVERLAY_IGNORE);
  if (next !== current) writeFileSync(gi, next);
}

// Write the managed-file manifest as a sibling of .layer-sync.json (itself under the now-
// ignored .sandcastle/, so this is consumer-local state — regenerated every init/update).
export function writeManifest(root: string): void {
  const out = { version: 1 as const, managed: managedManifest() };
  writeFileSync(join(root, ".sandcastle", ".managed.json"), JSON.stringify(out, null, 2) + "\n");
}

// Untrack any currently-tracked `ignore`-class files (git rm --cached — leaves them on
// disk). Existing consumers that committed the overlay get cleaned up on the next update;
// fresh installs are a no-op. Never touches `commit`-class paths.
export function untrackIgnored(root: string, sh: (cmd: string) => string, log: (m: string) => void): void {
  const specs = OVERLAY_IGNORE.map((p) => JSON.stringify(p)).join(" ");
  const tracked = (() => {
    try { return sh(`git -C ${JSON.stringify(root)} ls-files -- ${specs}`).split("\n").map((l) => l.trim()).filter(Boolean); }
    catch { return []; }
  })();
  if (!tracked.length) return;
  const files = tracked.map((f) => JSON.stringify(f)).join(" ");
  try {
    sh(`git -C ${JSON.stringify(root)} rm --cached --quiet -- ${files}`);
    log(`untracked ${tracked.length} overlay file(s) (kept on disk) — commit the cleanup once`);
  } catch (e) {
    log(`could not untrack overlay files: ${(e as Error).message}`);
  }
}

// True when `root` is the sandcastle-afk layer source itself (not a consumer). Guards
// against accidentally untracking the layer's own committed source if init/update is run
// in-place during development.
export function isLayerSource(root: string): boolean {
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "sandcastle-afk"; }
  catch { return false; }
}

// Apply the full overlay-management pass: refresh the gitignore block, untrack any
// previously-tracked overlay files, and write the manifest. Used by both init and update.
export function applyOverlayManagement(root: string, sh: (cmd: string) => string, log: (m: string) => void): void {
  if (isLayerSource(root)) {
    log("overlay management skipped — this is the sandcastle-afk layer source, not a consumer.");
    return;
  }
  writeManagedGitignore(root);
  untrackIgnored(root, sh, log);
  writeManifest(root);
}
