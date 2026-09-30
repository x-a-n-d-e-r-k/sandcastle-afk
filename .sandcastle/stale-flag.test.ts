// Loop decision after a conflict outcome (#68): a stale forge flag must not end the cycle.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const { afterConflict } = await import("./loop.js");

test("a 'stale-flag' outcome continues to the next PR; every real outcome ends the cycle (no starvation)", () => {
  assert.equal(afterConflict("stale-flag"), "next-pr");
  for (const o of ["escalated", "mechanical", "agent-resolved", "agent-failed"] as const)
    assert.equal(afterConflict(o), "end-cycle", o);
});
