// Merge-path guards (#70) — fakes only at the forge boundary; no Docker, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "afk.config.json")))
  copyFileSync(join(ROOT, "afk.config.example.json"), join(ROOT, "afk.config.json"));

const mg = await import("./merge-guard.js");

// Records forge side effects; `states` is the issue state the fake forge reports.
const recorder = (states: Record<number, string>) => {
  const calls: string[] = [];
  const deps: import("./merge-guard.js").IssueCloseDeps = {
    issueState: (n) => states[n] ?? "open",
    closeIssue: (n) => { calls.push(`close ${n}`); states[n] = "closed"; },
    releaseClaim: (n) => { calls.push(`release ${n}`); },
    log: () => {},
  };
  return { calls, deps };
};

test("#70 post-merge: an issue the forge left open gets exactly one close and one claim release", () => {
  const { calls, deps } = recorder({ 427: "open" });
  assert.equal(mg.closeLinkedIssue(427, 951, deps), "closed");
  assert.deepEqual(calls, ["close 427", "release 427"]);
});

test("#70 post-merge: an issue the forge already closed gets neither", () => {
  const { calls, deps } = recorder({ 427: "closed" });
  assert.equal(mg.closeLinkedIssue(427, 951, deps), "already-closed");
  assert.deepEqual(calls, []);
});
