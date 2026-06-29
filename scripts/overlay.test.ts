// Tests for overlay-management logic (#13): the pure gitignore-block upsert and the
// managed-file manifest classification. No filesystem/git I/O — those are thin wrappers.
// Run: pnpm test.
import test from "node:test";
import assert from "node:assert/strict";
import { upsertManagedBlock, managedManifest, OVERLAY_IGNORE, OVERLAY_COMMIT } from "./overlay.js";

const BEGIN = "# >>> sandcastle-afk overlay";
const END = "# <<< sandcastle-afk overlay <<<";
const countBlocks = (s: string) => (s.match(/# >>> sandcastle-afk overlay/g) ?? []).length;

test("upsertManagedBlock appends a block (with markers + all ignore paths) to empty input", () => {
  const out = upsertManagedBlock("", OVERLAY_IGNORE);
  assert.ok(out.includes(BEGIN) && out.includes(END));
  for (const p of OVERLAY_IGNORE) assert.ok(out.includes(p), `missing ${p}`);
  assert.equal(countBlocks(out), 1);
});

test("upsertManagedBlock preserves the consumer's existing entries", () => {
  const existing = "node_modules\ndist\n";
  const out = upsertManagedBlock(existing, OVERLAY_IGNORE);
  assert.ok(out.startsWith("node_modules\ndist"));
  assert.ok(out.includes(".sandcastle/"));
});

test("upsertManagedBlock is idempotent — applying twice equals applying once", () => {
  const once = upsertManagedBlock("node_modules\n", OVERLAY_IGNORE);
  const twice = upsertManagedBlock(once, OVERLAY_IGNORE);
  assert.equal(twice, once);
  assert.equal(countBlocks(twice), 1);
});

test("upsertManagedBlock replaces a stale block in place (no duplication)", () => {
  const stale = "node_modules\n\n# >>> sandcastle-afk overlay (managed by afk:init/afk:update — do not edit) >>>\nold/path\n# <<< sandcastle-afk overlay <<<\n";
  const out = upsertManagedBlock(stale, OVERLAY_IGNORE);
  assert.equal(countBlocks(out), 1);
  assert.ok(!out.includes("old/path"));
  assert.ok(out.includes("bin/forge"));
});

test("managedManifest classifies overlay as ignore and CI files as commit", () => {
  const manifest = managedManifest();
  const byPath = Object.fromEntries(manifest.map((m) => [m.path, m.class]));
  assert.equal(byPath[".sandcastle/"], "ignore");
  assert.equal(byPath["bin/forge"], "ignore");
  // auto-unblock must stay committed — the GitHub Action runs it from the repo.
  for (const p of OVERLAY_COMMIT) assert.equal(byPath[p], "commit", `${p} should be commit-class`);
  assert.ok(!OVERLAY_IGNORE.some((p) => p.startsWith("scripts/auto-unblock")), "auto-unblock must not be ignore-class");
});
